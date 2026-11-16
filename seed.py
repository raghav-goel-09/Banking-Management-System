"""Create a fresh database with demo users:  python seed.py"""
import os
from werkzeug.security import generate_password_hash
import db as database
import services

BASE = os.path.dirname(os.path.abspath(__file__))
PATH = os.environ.get("BANK_DB", os.path.join(BASE, "bank.db"))

database.init_db(PATH, os.path.join(BASE, "schema.sql"))
conn = database.connect(PATH)


def add_user(username, pw, name, email, phone, role):
    cur = conn.execute(
        "INSERT INTO users(username,password_hash,full_name,email,phone,role) VALUES(?,?,?,?,?,?)",
        (username, generate_password_hash(pw), name, email, phone, role))
    return cur.lastrowid


manager = add_user("admin", "Admin@123", "Meera Manager", "admin@bank.test", "9000000001", "manager")
add_user("teller1", "Teller@123", "Tarun Teller", "teller1@bank.test", "9000000002", "teller")
alice = add_user("alice", "Alice@123", "Alice Sharma", "alice@mail.test", "9111111111", "customer")
bob = add_user("bob", "Bobby@123", "Bob Kumar", "bob@mail.test", "9222222222", "customer")

for uid, amt in ((alice, 50000), (bob, 20000)):
    num = services.open_account(conn, uid, "savings")
    acc_id = conn.execute("SELECT id FROM accounts WHERE account_number=?", (num,)).fetchone()["id"]
    services.deposit(conn, acc_id, amt * 100, manager, "Opening deposit")
    print(f"Created account {num} with Rs {amt}")

print("\nDemo logins:\n  manager  admin    / Admin@123\n  teller   teller1  / Teller@123"
      "\n  customer alice    / Alice@123\n  customer bob      / Bobby@123")
