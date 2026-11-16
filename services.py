"""Core banking logic: deposits, withdrawals, transfers. No Flask dependency."""
import secrets
import sqlite3
import uuid
from decimal import Decimal, InvalidOperation

from db import atomic

MAX_AMOUNT_PAISE = 1_00_00_000 * 100   # 1 crore per transaction


class BankError(Exception):
    """A user-facing business-rule failure."""


def to_paise(text):
    try:
        d = Decimal(str(text).strip())
    except InvalidOperation:
        raise BankError("Enter a valid amount.")
    if not d.is_finite() or d <= 0:
        raise BankError("Amount must be greater than zero.")
    if d.as_tuple().exponent < -2:
        raise BankError("Amount can have at most 2 decimal places.")
    paise = int(d * 100)
    if paise > MAX_AMOUNT_PAISE:
        raise BankError("Amount exceeds the per-transaction limit of 1 crore.")
    return paise


def new_account_number(conn):
    while True:
        num = "BNK" + "".join(str(secrets.randbelow(10)) for _ in range(10))
        if not conn.execute("SELECT 1 FROM accounts WHERE account_number=?", (num,)).fetchone():
            return num


def open_account(conn, user_id, account_type="savings"):
    if account_type not in ("savings", "current"):
        raise BankError("Invalid account type.")
    num = new_account_number(conn)
    conn.execute("INSERT INTO accounts(account_number,user_id,account_type) VALUES(?,?,?)",
                 (num, user_id, account_type))
    return num


def _load_active(conn, *, account_id=None, number=None, owner_id=None):
    if account_id is not None:
        acc = conn.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
    else:
        acc = conn.execute("SELECT * FROM accounts WHERE account_number=?", (number,)).fetchone()
    if acc is None:
        raise BankError("Account not found.")
    if owner_id is not None and acc["user_id"] != owner_id:
        raise BankError("You do not have access to that account.")
    if acc["status"] != "active":
        raise BankError(f"Account {acc['account_number']} is {acc['status']}.")
    return acc


def _ledger(conn, ref, acc_id, typ, amt, bal_after, counter, desc, by):
    conn.execute(
        """INSERT INTO transactions(reference,account_id,txn_type,amount_paise,
           balance_after_paise,counterparty_acct,description,performed_by)
           VALUES(?,?,?,?,?,?,?,?)""",
        (ref, acc_id, typ, amt, bal_after, counter, desc, by))


def deposit(conn, account_id, amount_paise, by, desc="Cash deposit", owner_id=None):
    with atomic(conn):
        acc = _load_active(conn, account_id=account_id, owner_id=owner_id)
        new_bal = acc["balance_paise"] + amount_paise
        conn.execute("UPDATE accounts SET balance_paise=? WHERE id=?", (new_bal, acc["id"]))
        _ledger(conn, uuid.uuid4().hex, acc["id"], "deposit", amount_paise, new_bal, None, desc, by)
    return new_bal


def withdraw(conn, account_id, amount_paise, by, desc="Cash withdrawal", owner_id=None):
    with atomic(conn):
        acc = _load_active(conn, account_id=account_id, owner_id=owner_id)
        if acc["balance_paise"] < amount_paise:
            raise BankError("Insufficient funds.")
        new_bal = acc["balance_paise"] - amount_paise
        conn.execute("UPDATE accounts SET balance_paise=? WHERE id=?", (new_bal, acc["id"]))
        _ledger(conn, uuid.uuid4().hex, acc["id"], "withdrawal", amount_paise, new_bal, None, desc, by)
    return new_bal


def transfer(conn, from_id, to_number, amount_paise, by, desc="Transfer", owner_id=None):
    """Debit one account and credit another in a single atomic transaction."""
    with atomic(conn):
        src = _load_active(conn, account_id=from_id, owner_id=owner_id)
        dst = _load_active(conn, number=to_number.strip().upper())
        if src["id"] == dst["id"]:
            raise BankError("Cannot transfer to the same account.")
        if src["balance_paise"] < amount_paise:
            raise BankError("Insufficient funds.")
        src_bal = src["balance_paise"] - amount_paise
        dst_bal = dst["balance_paise"] + amount_paise
        conn.execute("UPDATE accounts SET balance_paise=? WHERE id=?", (src_bal, src["id"]))
        conn.execute("UPDATE accounts SET balance_paise=? WHERE id=?", (dst_bal, dst["id"]))
        ref = uuid.uuid4().hex
        _ledger(conn, ref, src["id"], "transfer_out", amount_paise, src_bal, dst["account_number"], desc, by)
        _ledger(conn, ref, dst["id"], "transfer_in", amount_paise, dst_bal, src["account_number"], desc, by)
    return src_bal
