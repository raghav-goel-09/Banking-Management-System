"""Database helpers (SQLite, autocommit mode so we control transactions explicitly)."""
import sqlite3
from contextlib import contextmanager
from flask import g, current_app


def connect(path):
    conn = sqlite3.connect(path, isolation_level=None, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def get_db():
    if "db" not in g:
        g.db = connect(current_app.config["DATABASE"])
    return g.db


def close_db(exc=None):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db(path, schema_path):
    conn = connect(path)
    with open(schema_path, encoding="utf-8") as f:
        conn.executescript(f.read())
    conn.close()


@contextmanager
def atomic(conn):
    """All-or-nothing block. BEGIN IMMEDIATE takes the write lock up-front,
    so two simultaneous withdrawals can never both read the same old balance."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
