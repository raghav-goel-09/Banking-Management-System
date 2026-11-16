# SecureBank – Banking Database Project (Flask + SQLite)

**Framework:** Flask (Python) · **Database:** SQLite (`schema.sql`, portable to MySQL/PostgreSQL)

## Run
```
pip install -r requirements.txt
python seed.py          # creates bank.db with demo users (re-run to reset)
python app.py           # open http://127.0.0.1:5000
python test_bank.py     # optional: 30+ automated checks
```
Demo logins: `admin/Admin@123` (manager), `teller1/Teller@123`, `alice/Alice@123`, `bob/Bobby@123`

## Who can do what
| Capability                              | Customer | Teller | Manager |
|-----------------------------------------|:--:|:--:|:--:|
| See own accounts & statements           | ✔ | – | – |
| Transfer / withdraw from OWN accounts   | ✔ | – | – |
| Search customers, view ANY account      | – | ✔ | ✔ |
| Counter deposit / withdrawal, open acct | – | ✔ | ✔ |
| Freeze / unfreeze / close accounts      | – | – | ✔ |
| Create staff, enable/disable users      | – | – | ✔ |
| Audit log, reports, ledger reconciliation | – | – | ✔ |

Staff read customers through the SQL view `v_customer_directory`, which never exposes password hashes.

## Files
- `schema.sql` – tables, constraints, triggers, staff view
- `db.py` – connection + atomic-transaction helper
- `services.py` – deposit / withdraw / transfer business logic
- `auth.py` – login check, role-based access decorators, CSRF
- `app.py` – all routes · `seed.py` – demo data · `test_bank.py` – tests
- `templates/` – HTML pages

## Safety features
Money in integer paise (no float errors) · atomic transfers with `BEGIN IMMEDIATE` (race-safe) ·
`CHECK balance >= 0` · immutable ledger & audit log (DB triggers) · frozen accounts blocked at DB level ·
hashed passwords · CSRF tokens · parameterised SQL · lock after 5 failed logins · audit trail.

## Production notes
Set `SECRET_KEY` env var, serve via gunicorn behind HTTPS. To use MySQL/PostgreSQL, swap `db.py`
and adjust `AUTOINCREMENT`/`CURRENT_TIMESTAMP`/trigger syntax in `schema.sql`.
