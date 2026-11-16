"""Automated checks:  python test_bank.py"""
import os, re, subprocess, sys, tempfile, threading

tmp = os.path.join(tempfile.mkdtemp(), "t.db")
os.environ["BANK_DB"] = tmp
subprocess.run([sys.executable, "seed.py"], check=True, capture_output=True)
import app as bank
import db as database
import services

bank.app.config["TESTING"] = True


def client():
    return bank.app.test_client()


def tok(c, path="/login"):
    return re.search(r'name="csrf_token" value="(\w+)"', c.get(path).get_data(as_text=True)).group(1)


def login(u, p):
    c = client(); r = c.post("/login", data={"username": u, "password": p, "csrf_token": tok(c)})
    return c, r


def post(c, path, **data):
    c.get("/")  # ensure session
    t = re.search(r'name="csrf_token" value="(\w+)"', c.get("/staff" if "staff" in path or "manager" in path or "counter" in path else "/dashboard").get_data(as_text=True))
    return c.post(path, data={**data, "csrf_token": t.group(1) if t else ""}, follow_redirects=True)


def acc(num):
    conn = database.connect(tmp)
    r = conn.execute("SELECT * FROM accounts WHERE account_number=?", (num,)).fetchone(); conn.close(); return r

conn = database.connect(tmp)
A = conn.execute("SELECT a.* FROM accounts a JOIN users u ON u.id=a.user_id WHERE u.username='alice'").fetchone()
B = conn.execute("SELECT a.* FROM accounts a JOIN users u ON u.id=a.user_id WHERE u.username='bob'").fetchone()
conn.close()
ok = lambda cond, msg: (print(("PASS " if cond else "FAIL ") + msg), cond or sys.exit(1))

# CSRF
c = client(); ok(c.post("/login", data={"username": "alice", "password": "x"}).status_code == 400, "POST without CSRF rejected")

# customer flows
ca, r = login("alice", "Alice@123"); ok(r.status_code == 302, "alice logs in")
ok("₹50,000.00" in ca.get("/dashboard").get_data(as_text=True), "alice sees her balance")
ok(ca.get(f"/account/{B['id']}").status_code == 403, "alice CANNOT view bob's account")
ok(ca.get("/staff").status_code == 403 and ca.get("/manager/audit").status_code == 403, "customer blocked from staff/manager pages")
r = post(ca, "/transfer", from_account=A["id"], to_number=B["account_number"], amount="1250.75", description="rent")
ok("Transfer successful" in r.get_data(as_text=True), "transfer works")
ok(acc(A["account_number"])["balance_paise"] == 4874925 and acc(B["account_number"])["balance_paise"] == 2125075, "both balances correct")
r = post(ca, "/transfer", from_account=A["id"], to_number=B["account_number"], amount="999999")
ok("Insufficient funds" in r.get_data(as_text=True), "overdraft refused")
r = post(ca, "/transfer", from_account=B["id"], to_number=A["account_number"], amount="10")
ok("do not have access" in r.get_data(as_text=True), "cannot transfer FROM someone else's account")
for bad in ("-5", "0", "abc", "1.234", "nan"):
    r = post(ca, "/withdraw", from_account=A["id"], amount=bad)
    ok("Withdrawal successful" not in r.get_data(as_text=True), f"bad amount '{bad}' refused")
r = post(ca, "/withdraw", from_account=A["id"], amount="100"); ok("Withdrawal successful" in r.get_data(as_text=True), "withdraw works")

# teller
ct, _ = login("teller1", "Teller@123")
h = ct.get("/staff").get_data(as_text=True); ok("Alice Sharma" in h and "Bob Kumar" in h, "teller lists customers")
ok("pbkdf2" not in h and "scrypt" not in h, "no password hashes exposed to staff")
ok(ct.get(f"/account/{A['id']}").status_code == 200, "teller can view any account")
r = post(ct, "/staff/counter", account_number=A["account_number"], action="deposit", amount="500")
ok("Deposit done" in r.get_data(as_text=True), "teller counter deposit")
ok(ct.get("/manager/users").status_code == 403 and ct.get("/manager/report").status_code == 403, "teller blocked from manager pages")
r = post(ct, f"/manager/account/{A['id']}/status", status="frozen"); ok(r.status_code == 403, "teller cannot freeze")

# manager
cm, _ = login("admin", "Admin@123")
post(cm, f"/manager/account/{A['id']}/status", status="frozen")
ok(acc(A["account_number"])["status"] == "frozen", "manager freezes account")
r = post(ca, "/withdraw", from_account=A["id"], amount="1"); ok("frozen" in r.get_data(as_text=True) or "do not" in r.get_data(as_text=True) or acc(A["account_number"])["balance_paise"] == 4874925 - 10000 + 50000, "frozen account blocks withdraw")
bal = acc(A["account_number"])["balance_paise"]
post(ca, "/withdraw", from_account=A["id"], amount="1"); ok(acc(A["account_number"])["balance_paise"] == bal, "balance unchanged on frozen account")
post(cm, f"/manager/account/{A['id']}/status", status="active")
r = post(cm, "/manager/users", full_name="Nina Teller", username="nina_t", email="n@b.test", phone="", password="Nina1234", role="teller")
ok("created" in r.get_data(as_text=True), "manager creates staff")
h = cm.get("/manager/report").get_data(as_text=True); ok("Every account balance matches" in h, "ledger reconciles")
ok("COUNTER_DEPOSIT" in cm.get("/manager/audit").get_data(as_text=True), "audit log records teller actions")

# DB-level guards
conn = database.connect(tmp)
for sql in ("UPDATE transactions SET amount_paise=1", "DELETE FROM audit_log", "UPDATE accounts SET balance_paise=-1"):
    try: conn.execute(sql); ok(False, sql)
    except Exception: ok(True, f"DB rejects: {sql}")
conn.close()

# lockout
for _ in range(5): login("bob", "wrong")
_, r = login("bob", "Bobby@123"); ok(True, "lockout path exercised")
conn = database.connect(tmp); ok(conn.execute("SELECT is_active FROM users WHERE username='bob'").fetchone()[0] == 0, "account locks after 5 failed logins"); conn.close()

# concurrency: 20 parallel withdrawals of 100 from a 1000 balance must leave exactly 0
conn = database.connect(tmp); cm_id = conn.execute("SELECT id FROM users WHERE username='admin'").fetchone()[0]
n = services.open_account(conn, 3, "current"); cid = conn.execute("SELECT id FROM accounts WHERE account_number=?", (n,)).fetchone()[0]
services.deposit(conn, cid, 100000, cm_id); conn.close()
res = []
def w():
    c2 = database.connect(tmp)
    try: services.withdraw(c2, cid, 10000, cm_id); res.append(1)
    except services.BankError: res.append(0)
    c2.close()
ts = [threading.Thread(target=w) for _ in range(20)]; [t.start() for t in ts]; [t.join() for t in ts]
ok(sum(res) == 10 and acc(n)["balance_paise"] == 0, f"concurrency safe: {sum(res)}/20 succeeded, balance 0")
print("\nALL TESTS PASSED")

# ---- UI wiring checks ----
ca2, _ = login("alice", "Alice@123")
ok(ca2.get("/static/style.css").status_code == 200 and ca2.get("/static/app.js").status_code == 200, "static CSS/JS served")
j = ca2.get(f"/api/account-lookup?number={B['account_number']}").get_json(); ok(j["found"] and j["name"] == "Bob K.", "lookup API returns masked name")
ok(ca2.get("/api/account-lookup?number=NOPE").get_json()["found"] is False, "lookup API handles unknown account")
ok(client().get("/api/account-lookup?number=x").status_code in (302, 403), "lookup API requires login")
ok('data-copy' in ca2.get("/dashboard").get_data(as_text=True), "dashboard renders new tiles")
print("UI CHECKS PASSED")

ok(client().get("/static/particles.js").status_code == 200, "particles.js served")
ok('id="bg"' in client().get("/login").get_data(as_text=True), "background canvas present on pages")
print("BACKGROUND CHECKS PASSED")
