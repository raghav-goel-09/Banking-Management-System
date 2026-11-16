"""Authentication, role-based access control and CSRF protection."""
import secrets
from functools import wraps
from flask import abort, flash, g, redirect, request, session, url_for
import db as database


def current_user():
    if "user" not in g:
        g.user = None
        uid = session.get("user_id")
        if uid:
            u = database.get_db().execute(
                "SELECT id,username,full_name,role,is_active FROM users WHERE id=?", (uid,)).fetchone()
            if u and u["is_active"]:
                g.user = u
            else:
                session.clear()
    return g.user


def login_required(view):
    @wraps(view)
    def wrapped(*a, **kw):
        if current_user() is None:
            flash("Please log in first.", "error")
            return redirect(url_for("login"))
        return view(*a, **kw)
    return wrapped


def role_required(*roles):
    """Restrict a route to given roles, e.g. @role_required('teller','manager')."""
    def deco(view):
        @wraps(view)
        @login_required
        def wrapped(*a, **kw):
            if current_user()["role"] not in roles:
                abort(403)
            return view(*a, **kw)
        return wrapped
    return deco


def init_security(app):
    @app.before_request
    def csrf_protect():
        if request.method == "POST":
            sent = request.form.get("csrf_token", "")
            if not sent or not secrets.compare_digest(sent, session.get("csrf", "")):
                abort(400, "Invalid or missing CSRF token.")

    @app.context_processor
    def inject():
        if "csrf" not in session:
            session["csrf"] = secrets.token_hex(16)
        return {"csrf_token": session["csrf"], "me": current_user()}
