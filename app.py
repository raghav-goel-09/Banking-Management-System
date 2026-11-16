"""Banking System - Flask application (routes)."""
import os
import re
import sqlite3
from decimal import Decimal

from flask import (Flask, abort, flash, redirect, render_template, request,
                   session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

import db as database
import services
from auth import current_user, init_security, login_required, role_required

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MAX_FAILED_LOGINS = 5

app = Flask(__name__)
app.config.update(
    SECRET_KEY=os.environ.get("SECRET_KEY", "dev-only-change-me"),
    DATABASE=os.environ.get("BANK_DB", os.path.join(BASE_DIR, "bank.db")),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
)
app.teardown_appcontext(database.close_db)
init_security(app)

if not os.path.exists(app.config["DATABASE"]):
    database.init_db(app.config["DATABASE"], os.path.join(BASE_DIR, "schema.sql"))
    print("Empty database created. Run `python seed.py` to add demo users.")


@app.template_filter("inr")
def inr(paise):
    return "₹{:,.2f}".format(Decimal(paise) / 100)


# ----------------------------------------------------------------- helpers
def db():
    return database.get_db()


def audit(action, details="", user_id=None):
    if user_id is None and current_user():
        user_id = current_user()["id"]
    db().execute("INSERT INTO audit_log(user_id,action,details,ip_address) VALUES(?,?,?,?)",
                 (user_id, action, details, request.remote_addr))


def validate_new_user(form):
    username = form.get("username", "").strip()
    full_name = form.get("full_name", "").strip()
    email = form.get("email", "").strip().lower()
    phone = form.get("phone", "").strip()
    pw = form.get("password", "")
    if not re.fullmatch(r"[A-Za-z0-9_]{4,20}", username):
        raise services.BankError("Username: 4-20 letters, digits or underscore.")
    if len(full_name) < 2:
        raise services.BankError("Please enter your full name.")
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise services.BankError("Enter a valid email address.")
    if phone and not re.fullmatch(r"\+?\d{7,15}", phone):
        raise services.BankError("Phone must be 7-15 digits.")
    if len(pw) < 8 or not re.search(r"[A-Za-z]", pw) or not re.search(r"\d", pw):
        raise services.BankError("Password needs 8+ characters with letters and digits.")
    return username, full_name, email, phone, generate_password_hash(pw)


def home_for(role):
    return url_for("dashboard") if role == "customer" else url_for("staff_customers")


# ------------------------------------------------------------ auth routes
@app.route("/")
def index():
    u = current_user()
    return redirect(home_for(u["role"]) if u else url_for("login"))
    

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        u = db().execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        if u and not u["is_active"]:
            flash("This account is locked or disabled. Contact the bank.", "error")
        elif u and check_password_hash(u["password_hash"], password):
            db().execute("UPDATE users SET failed_attempts=0 WHERE id=?", (u["id"],))
            session.clear()
            session["user_id"] = u["id"]
            audit("LOGIN", f"role={u['role']}", user_id=u["id"])
            return redirect(home_for(u["role"]))
        else:
            if u:
                attempts = u["failed_attempts"] + 1
                locked = 0 if attempts >= MAX_FAILED_LOGINS else 1
                db().execute("UPDATE users SET failed_attempts=?, is_active=? WHERE id=?",
                             (attempts, locked, u["id"]))
                audit("LOGIN_FAILED", f"attempt {attempts}", user_id=u["id"])
                if not locked:
                    audit("ACCOUNT_LOCKED", "too many failed logins", user_id=u["id"])
            flash("Invalid username or password.", "error")
    return render_template("login.html")


@app.route("/logout", methods=["POST"])
@login_required
def logout():
    audit("LOGOUT")
    session.clear()
    return redirect(url_for("login"))


@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "POST":
        try:
            username, full_name, email, phone, pw_hash = validate_new_user(request.form)
            conn = db()
            with database.atomic(conn):
                cur = conn.execute(
                    "INSERT INTO users(username,password_hash,full_name,email,phone,role) "
                    "VALUES(?,?,?,?,?,'customer')", (username, pw_hash, full_name, email, phone))
                number = services.open_account(conn, cur.lastrowid, "savings")
            audit("REGISTER", f"account {number}", user_id=cur.lastrowid)
            flash(f"Registration successful! Your savings account is {number}. Please log in.", "ok")
            return redirect(url_for("login"))
        except services.BankError as e:
            flash(str(e), "error")
        except sqlite3.IntegrityError:
            flash("That username or email is already registered.", "error")
    return render_template("register.html")


# -------------------------------------------------------- customer routes
@app.route("/dashboard")
@role_required("customer")
def dashboard():
    accounts = db().execute("SELECT * FROM accounts WHERE user_id=? ORDER BY id",
                            (current_user()["id"],)).fetchall()
    total = sum(a["balance_paise"] for a in accounts if a["status"] != "closed")
    return render_template("dashboard.html", accounts=accounts, total=total)


@app.route("/account/<int:account_id>")
@login_required
def account_view(account_id):
    acc = db().execute(
        "SELECT a.*, u.full_name, u.username FROM accounts a JOIN users u ON u.id=a.user_id "
        "WHERE a.id=?", (account_id,)).fetchone()
    if acc is None:
        abort(404)
    u = current_user()
    if u["role"] == "customer" and acc["user_id"] != u["id"]:
        audit("ACCESS_DENIED", f"customer tried to open account {acc['account_number']}")
        abort(403)
    txns = db().execute(
        "SELECT t.*, p.username AS by_user FROM transactions t JOIN users p ON p.id=t.performed_by "
        "WHERE t.account_id=? ORDER BY t.id DESC LIMIT 100", (account_id,)).fetchall()
    if u["role"] != "customer":
        audit("STAFF_VIEW_ACCOUNT", acc["account_number"])
    return render_template("account.html", acc=acc, txns=txns)


@app.route("/transfer", methods=["GET", "POST"])
@role_required("customer")
def transfer():
    u = current_user()
    mine = db().execute("SELECT * FROM accounts WHERE user_id=? AND status='active'", (u["id"],)).fetchall()
    if request.method == "POST":
        try:
            amount = services.to_paise(request.form.get("amount"))
            new_bal = services.transfer(
                db(), int(request.form.get("from_account", 0)), request.form.get("to_number", ""),
                amount, by=u["id"], desc=request.form.get("description", "").strip()[:100] or "Transfer",
                owner_id=u["id"])
            audit("TRANSFER", f"{amount} paise to {request.form.get('to_number')}")
            flash(f"Transfer successful. New balance: {inr(new_bal)}", "ok")
            return redirect(url_for("dashboard"))
        except (services.BankError, ValueError) as e:
            flash(str(e) if isinstance(e, services.BankError) else "Invalid input.", "error")
    return render_template("transact.html", mode="transfer", accounts=mine)


@app.route("/withdraw", methods=["GET", "POST"])
@role_required("customer")
def withdraw():
    u = current_user()
    mine = db().execute("SELECT * FROM accounts WHERE user_id=? AND status='active'", (u["id"],)).fetchall()
    if request.method == "POST":
        try:
            amount = services.to_paise(request.form.get("amount"))
            new_bal = services.withdraw(db(), int(request.form.get("from_account", 0)), amount,
                                        by=u["id"], desc="ATM / self withdrawal", owner_id=u["id"])
            audit("WITHDRAW", f"{amount} paise")
            flash(f"Withdrawal successful. New balance: {inr(new_bal)}", "ok")
            return redirect(url_for("dashboard"))
        except (services.BankError, ValueError) as e:
            flash(str(e) if isinstance(e, services.BankError) else "Invalid input.", "error")
    return render_template("transact.html", mode="withdraw", accounts=mine)


# ------------------------------------------------- staff (teller+manager)
@app.route("/staff")
@role_required("teller", "manager")
def staff_customers():
    q = request.args.get("q", "").strip()
    like = f"%{q}%"
    # Staff read from the safe VIEW - never the raw users table (no password hashes).
    rows = db().execute(
        "SELECT * FROM v_customer_directory WHERE full_name LIKE ? OR username LIKE ? OR email LIKE ? "
        "OR user_id IN (SELECT user_id FROM accounts WHERE account_number LIKE ?) ORDER BY full_name",
        (like, like, like, like)).fetchall()
    return render_template("staff_customers.html", rows=rows, q=q)


@app.route("/staff/customer/<int:uid>")
@role_required("teller", "manager")
def staff_customer(uid):
    c = db().execute("SELECT * FROM v_customer_directory WHERE user_id=?", (uid,)).fetchone()
    if c is None:
        abort(404)
    accounts = db().execute("SELECT * FROM accounts WHERE user_id=? ORDER BY id", (uid,)).fetchall()
    audit("STAFF_VIEW_CUSTOMER", c["username"])
    return render_template("staff_customer.html", c=c, accounts=accounts)


@app.route("/staff/customer/<int:uid>/open-account", methods=["POST"])
@role_required("teller", "manager")
def staff_open_account(uid):
    if not db().execute("SELECT 1 FROM users WHERE id=? AND role='customer'", (uid,)).fetchone():
        abort(404)
    try:
        num = services.open_account(db(), uid, request.form.get("account_type", ""))
        audit("OPEN_ACCOUNT", f"{num} for user {uid}")
        flash(f"Opened new account {num}.", "ok")
    except services.BankError as e:
        flash(str(e), "error")
    return redirect(url_for("staff_customer", uid=uid))


@app.route("/staff/counter", methods=["GET", "POST"])
@role_required("teller", "manager")
def counter():
    if request.method == "POST":
        try:
            number = request.form.get("account_number", "").strip().upper()
            acc = db().execute("SELECT id FROM accounts WHERE account_number=?", (number,)).fetchone()
            if acc is None:
                raise services.BankError("Account not found.")
            amount = services.to_paise(request.form.get("amount"))
            action = request.form.get("action")
            by = current_user()["id"]
            if action == "deposit":
                bal = services.deposit(db(), acc["id"], amount, by, "Counter deposit")
            elif action == "withdraw":
                bal = services.withdraw(db(), acc["id"], amount, by, "Counter withdrawal")
            else:
                raise services.BankError("Choose deposit or withdraw.")
            audit(f"COUNTER_{action.upper()}", f"{number}: {amount} paise")
            flash(f"{action.title()} done on {number}. New balance: {inr(bal)}", "ok")
        except services.BankError as e:
            flash(str(e), "error")
    return render_template("transact.html", mode="counter")


@app.route("/api/account-lookup")
@role_required("customer")
def account_lookup():
    """JSON for the transfer form: confirms the beneficiary (name is masked)."""
    num = request.args.get("number", "").strip().upper()
    row = db().execute("SELECT a.status, u.full_name FROM accounts a JOIN users u ON u.id=a.user_id "
                       "WHERE a.account_number=?", (num,)).fetchone()
    if not row or row["status"] != "active":
        return {"found": False}
    parts = row["full_name"].split()
    return {"found": True, "name": parts[0] + (" " + parts[-1][0] + "." if len(parts) > 1 else "")}


# ---------------------------------------------------------- manager only
@app.route("/manager/account/<int:account_id>/status", methods=["POST"])
@role_required("manager")
def set_account_status(account_id):
    new = request.form.get("status")
    acc = db().execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
    if acc is None or new not in ("active", "frozen", "closed"):
        abort(400)
    if acc["status"] == "closed":
        flash("A closed account cannot be changed.", "error")
    elif new == "closed" and acc["balance_paise"] != 0:
        flash("Balance must be zero before closing an account.", "error")
    else:
        db().execute("UPDATE accounts SET status=? WHERE id=?", (new, account_id))
        audit("ACCOUNT_STATUS", f"{acc['account_number']}: {acc['status']} -> {new}")
        flash(f"Account is now {new}.", "ok")
    return redirect(url_for("account_view", account_id=account_id))


@app.route("/manager/users", methods=["GET", "POST"])
@role_required("manager")
def manager_users():
    if request.method == "POST":
        try:
            username, full_name, email, phone, pw_hash = validate_new_user(request.form)
            role = request.form.get("role")
            if role not in ("teller", "manager"):
                raise services.BankError("Invalid staff role.")
            db().execute("INSERT INTO users(username,password_hash,full_name,email,phone,role) "
                         "VALUES(?,?,?,?,?,?)", (username, pw_hash, full_name, email, phone, role))
            audit("CREATE_STAFF", f"{username} ({role})")
            flash(f"Staff user {username} created.", "ok")
        except services.BankError as e:
            flash(str(e), "error")
        except sqlite3.IntegrityError:
            flash("That username or email already exists.", "error")
    users = db().execute("SELECT id,username,full_name,role,is_active,failed_attempts,created_at "
                         "FROM users ORDER BY role, username").fetchall()
    return render_template("manager_users.html", users=users)

@app.route('/how-it-works')
def how_it_works():
    return render_template('how-it-works.html')

# @app.template_filter("inr0")
# def inr0(paise):
#     return "₹{:,.0f}".format(Decimal(paise) / 100)

@app.route("/manager/users/<int:uid>/toggle", methods=["POST"])
@role_required("manager")
def toggle_user(uid):
    if uid == current_user()["id"]:
        flash("You cannot disable yourself.", "error")
    else:
        u = db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if u is None:
            abort(404)
        new = 0 if u["is_active"] else 1
        db().execute("UPDATE users SET is_active=?, failed_attempts=0 WHERE id=?", (new, uid))
        audit("USER_ENABLED" if new else "USER_DISABLED", u["username"])
        flash(f"{u['username']} is now {'active' if new else 'disabled'}.", "ok")
    return redirect(url_for("manager_users"))


@app.route("/manager/audit")
@role_required("manager")
def audit_view():
    rows = db().execute("SELECT l.*, u.username FROM audit_log l LEFT JOIN users u ON u.id=l.user_id "
                        "ORDER BY l.id DESC LIMIT 200").fetchall()
    return render_template("audit.html", rows=rows)


@app.route("/manager/report")
@role_required("manager")
def report():
    d = db()
    stats = {
        "customers": d.execute("SELECT COUNT(*) FROM users WHERE role='customer'").fetchone()[0],
        "accounts": d.execute("SELECT COUNT(*) FROM accounts WHERE status<>'closed'").fetchone()[0],
        "frozen": d.execute("SELECT COUNT(*) FROM accounts WHERE status='frozen'").fetchone()[0],
        "holdings": d.execute("SELECT COALESCE(SUM(balance_paise),0) FROM accounts").fetchone()[0],
        "txns": d.execute("SELECT COUNT(*) FROM transactions").fetchone()[0],
    }
    by_type = d.execute("SELECT txn_type, COUNT(*) n, SUM(amount_paise) total FROM transactions "
                        "GROUP BY txn_type").fetchall()
    # Integrity check: ledger must reconcile with stored balances
    mismatches = d.execute(
        "SELECT a.account_number FROM accounts a WHERE a.balance_paise <> COALESCE((SELECT SUM(CASE "
        "WHEN txn_type IN ('deposit','transfer_in') THEN amount_paise ELSE -amount_paise END) "
        "FROM transactions WHERE account_id=a.id),0)").fetchall()
    return render_template("report.html", s=stats, by_type=by_type, mismatches=mismatches)


# ------------------------------------------------------------ error pages
@app.errorhandler(400)
@app.errorhandler(403)
@app.errorhandler(404)
def error(e):
    return render_template("error.html", e=e), e.code


if __name__ == "__main__":
    app.run(debug=False)
