-- ============================================================
--  Banking Database Schema  (SQLite; portable to MySQL/Postgres)
--  All money is stored as INTEGER paise (1 INR = 100 paise)
--  to avoid floating-point rounding errors.
-- ============================================================
PRAGMA foreign_keys = ON;

DROP VIEW    IF EXISTS v_customer_directory;
DROP TABLE   IF EXISTS audit_log;
DROP TABLE   IF EXISTS transactions;
DROP TABLE   IF EXISTS accounts;
DROP TABLE   IF EXISTS users;

-- Users: customers AND bank staff share one table, separated by role
CREATE TABLE users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    full_name       TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    phone           TEXT,
    role            TEXT NOT NULL CHECK (role IN ('customer','teller','manager')),
    is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    account_number TEXT NOT NULL UNIQUE,
    user_id        INTEGER NOT NULL REFERENCES users(id),
    account_type   TEXT NOT NULL CHECK (account_type IN ('savings','current')),
    balance_paise  INTEGER NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),  -- no overdraft
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
    opened_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_accounts_user ON accounts(user_id);

-- Ledger: one row per money movement on one account (a transfer = 2 rows)
CREATE TABLE transactions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    reference           TEXT NOT NULL,              -- groups both legs of a transfer
    account_id          INTEGER NOT NULL REFERENCES accounts(id),
    txn_type            TEXT NOT NULL CHECK (txn_type IN ('deposit','withdrawal','transfer_in','transfer_out')),
    amount_paise        INTEGER NOT NULL CHECK (amount_paise > 0),
    balance_after_paise INTEGER NOT NULL CHECK (balance_after_paise >= 0),
    counterparty_acct   TEXT,                       -- other account number for transfers
    description         TEXT,
    performed_by        INTEGER NOT NULL REFERENCES users(id),
    created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_txn_account ON transactions(account_id, id DESC);

-- Audit trail of security-relevant actions (logins, freezes, staff creation...)
CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id),
    action     TEXT NOT NULL,
    details    TEXT,
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Integrity triggers (enforced by the DB itself) ----------
CREATE TRIGGER trg_txn_no_update BEFORE UPDATE ON transactions
BEGIN SELECT RAISE(ABORT, 'Ledger entries are immutable'); END;
CREATE TRIGGER trg_txn_no_delete BEFORE DELETE ON transactions
BEGIN SELECT RAISE(ABORT, 'Ledger entries cannot be deleted'); END;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'Audit log is immutable'); END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'Audit log cannot be deleted'); END;

-- Balance may only change on an ACTIVE account
CREATE TRIGGER trg_block_inactive_balance_change
BEFORE UPDATE OF balance_paise ON accounts
WHEN NEW.balance_paise <> OLD.balance_paise AND OLD.status <> 'active'
BEGIN SELECT RAISE(ABORT, 'Account is not active'); END;

-- ---------- Staff-safe view: NO password hashes, NO login data ----------
CREATE VIEW v_customer_directory AS
SELECT u.id AS user_id, u.username, u.full_name, u.email, u.phone, u.created_at,
       COUNT(a.id)                          AS account_count,
       COALESCE(SUM(a.balance_paise), 0)    AS total_balance_paise
FROM users u
LEFT JOIN accounts a ON a.user_id = u.id
WHERE u.role = 'customer'
GROUP BY u.id;
