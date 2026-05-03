from __future__ import annotations

# RBAMS API (Route-Based Attendance Monitoring System): Flask session auth, JSON API, SQLite, scanner; serves /fe/.

import functools
import os
import pathlib

from datetime import datetime
from flask import (
    Flask,
    jsonify,
    make_response,
    redirect,
    request,
    send_from_directory,
    session,
)

from database import get_db, init_db
from scanner import scan_network

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "rbas-secret-key-change-in-production")

_ROOT_DIR = pathlib.Path(__file__).resolve().parent.parent
_FRONTEND_DIR = _ROOT_DIR / "front-end"

_ADMIN_USER = os.environ.get("RBAS_ADMIN_USER", "admin")
_ADMIN_PASSWORD = os.environ.get("RBAS_ADMIN_PASSWORD", "admin")


with app.app_context():
    init_db()


# sqlite3.Row or mapping → plain dict for jsonify.
def _row_to_dict(row):
    if row is None:
        return None
    if hasattr(row, "keys"):
        return {k: row[k] for k in row.keys()}
    return dict(row)


# Decorator: require Flask session is_admin or return 401 JSON.
def _require_admin(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        if session.get("is_admin") is True:
            return fn(*args, **kwargs)
        return jsonify({"error": "unauthorized"}), 401

    return wrapper


# ---------------------------------------------------------------------------
# Front-end (served by Flask to avoid CORS)
# ---------------------------------------------------------------------------

# Browser root → public login page.
@app.route("/")
def root():
    return redirect("/fe/login.html")


# Static files for /fe/... from ../front-end.
@app.route("/fe/<path:filename>")
def fe_static(filename: str):
    return send_from_directory(_FRONTEND_DIR, filename)


# ---------------------------------------------------------------------------
# Auth (simple session auth)
# ---------------------------------------------------------------------------

# Compare body to env credentials; set session is_admin.
@app.route("/api/auth/login", methods=["POST"])
def api_auth_login():
    data = request.get_json(force=True, silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", "")).strip()
    if username == _ADMIN_USER and password == _ADMIN_PASSWORD:
        session["is_admin"] = True
        session["username"] = username
        return jsonify({"ok": True, "username": username})
    return jsonify({"ok": False, "error": "invalid_credentials"}), 401


# Clear server session.
@app.route("/api/auth/logout", methods=["POST"])
def api_auth_logout():
    session.clear()
    return jsonify({"ok": True})


# For front-end to check if admin session is active.
@app.route("/api/auth/me")
def api_auth_me():
    if session.get("is_admin") is True:
        return jsonify({"authenticated": True, "username": session.get("username")})
    return jsonify({"authenticated": False})


# ---------------------------------------------------------------------------
# Students
# ---------------------------------------------------------------------------

# List students; optional ?search= substring on name, student_id, mac.
@app.route("/api/students", methods=["GET"])
@_require_admin
def api_students_list():
    q = (request.args.get("search") or "").strip()
    db = get_db()
    try:
        if q:
            like = f"%{q}%"
            rows = db.execute(
                """
                SELECT * FROM students
                WHERE name LIKE ? OR student_id LIKE ? OR mac_address LIKE ?
                ORDER BY name
                LIMIT 200
                """,
                (like, like, like),
            ).fetchall()
        else:
            rows = db.execute("SELECT * FROM students ORDER BY name LIMIT 200").fetchall()
        return jsonify({"students": [_row_to_dict(r) for r in rows]})
    finally:
        db.close()


# Register participant (student_id unique).
@app.route("/api/students", methods=["POST"])
@_require_admin
def api_students_create():
    data = request.get_json(force=True) or {}
    student_id = str(data.get("student_id", "")).strip()
    name = str(data.get("name", "")).strip()
    course = str(data.get("course", "")).strip()
    mac_address = str(data.get("mac_address", "")).strip().upper() or None
    college = (str(data.get("college", "")).strip() or None)
    year_level = (str(data.get("year_level", "")).strip() or None)
    section = (str(data.get("section", "")).strip() or None)

    if not student_id or not name or not course:
        return jsonify({"error": "student_id,name,course required"}), 400

    db = get_db()
    try:
        db.execute(
            """
            INSERT INTO students (student_id, name, course, college, year_level, section, mac_address)
            VALUES (?,?,?,?,?,?,?)
            """,
            (student_id, name, course, college, year_level, section, mac_address),
        )
        db.commit()
        row = db.execute("SELECT * FROM students WHERE student_id=?", (student_id,)).fetchone()
        return jsonify({"student": _row_to_dict(row)})
    except Exception as e:
        return jsonify({"error": str(e)}), 400
    finally:
        db.close()


# Lookup by school student number (manual attendance form).
@app.route("/api/students/by_student_id/<student_id>")
@_require_admin
def api_student_by_student_id(student_id: str):
    sid = (student_id or "").strip()
    db = get_db()
    try:
        row = db.execute("SELECT * FROM students WHERE student_id=?", (sid,)).fetchone()
        if not row:
            return jsonify({"student": None}), 404
        return jsonify({"student": _row_to_dict(row)})
    finally:
        db.close()


# Reset Wi‑Fi device binding (MAC) for re-registration.
@app.route("/api/students/<int:student_pk>/clear_mac", methods=["POST"])
@_require_admin
def api_students_clear_mac(student_pk: int):
    db = get_db()
    try:
        existing = db.execute("SELECT id FROM students WHERE id=?", (int(student_pk),)).fetchone()
        if not existing:
            return jsonify({"error": "student not found"}), 404
        db.execute("UPDATE students SET mac_address=NULL WHERE id=?", (int(student_pk),))
        db.commit()
        row = db.execute("SELECT * FROM students WHERE id=?", (int(student_pk),)).fetchone()
        return jsonify({"student": _row_to_dict(row)})
    finally:
        db.close()


# Remove user and their attendance rows.
@app.route("/api/students/<int:student_pk>", methods=["DELETE"])
@_require_admin
def api_students_delete(student_pk: int):
    sid = int(student_pk)
    db = get_db()
    try:
        existing = db.execute("SELECT id FROM students WHERE id=?", (sid,)).fetchone()
        if not existing:
            return jsonify({"error": "student not found"}), 404
        db.execute("DELETE FROM attendance WHERE student_id=?", (sid,))
        db.execute("DELETE FROM students WHERE id=?", (sid,))
        db.commit()
        return jsonify({"ok": True})
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------

# Includes session_count and open_session_count for UI status.
@app.route("/api/events", methods=["GET"])
@_require_admin
def api_events_list():
    db = get_db()
    try:
        rows = db.execute(
            """
            SELECT e.*,
                   (SELECT COUNT(*) FROM sessions WHERE event_id = e.id) AS session_count,
                   (SELECT COUNT(*) FROM sessions WHERE event_id = e.id AND status = 'open') AS open_session_count
            FROM events e
            ORDER BY e.event_date DESC, e.created_at DESC
            """
        ).fetchall()
        return jsonify({"events": [_row_to_dict(r) for r in rows]})
    finally:
        db.close()


# Body: name, description (venue), event_date, event_time.
@app.route("/api/events", methods=["POST"])
@_require_admin
def api_events_create():
    data = request.get_json(force=True) or {}
    name = str(data.get("name", "")).strip()
    description = str(data.get("description", "")).strip() or None
    event_date = str(data.get("event_date", "")).strip() or None
    event_time = str(data.get("event_time", "")).strip() or None
    if not name:
        return jsonify({"error": "name required"}), 400
    db = get_db()
    try:
        db.execute(
            "INSERT INTO events (name, description, event_date, event_time) VALUES (?,?,?,?)",
            (name, description, event_date, event_time),
        )
        db.commit()
        row = db.execute("SELECT * FROM events WHERE id=last_insert_rowid()").fetchone()
        return jsonify({"event": _row_to_dict(row)})
    finally:
        db.close()


# PUT/PATCH update fields; DELETE removes event, its sessions, and related attendance.
@app.route("/api/events/<int:event_id>", methods=["PUT", "PATCH", "DELETE"])
@_require_admin
def api_events_detail(event_id: int):
    eid = int(event_id)
    if request.method == "DELETE":
        db = get_db()
        try:
            existing = db.execute("SELECT id FROM events WHERE id=?", (eid,)).fetchone()
            if not existing:
                return jsonify({"error": "event not found"}), 404
            db.execute(
                "DELETE FROM attendance WHERE session_id IN (SELECT id FROM sessions WHERE event_id=?)",
                (eid,),
            )
            db.execute("DELETE FROM sessions WHERE event_id=?", (eid,))
            db.execute("DELETE FROM events WHERE id=?", (eid,))
            db.commit()
            return jsonify({"ok": True})
        finally:
            db.close()

    # PUT / PATCH
    data = request.get_json(force=True) or {}
    name = str(data.get("name", "")).strip()
    description = str(data.get("description", "")).strip() or None
    event_date = str(data.get("event_date", "")).strip() or None
    event_time = str(data.get("event_time", "")).strip() or None
    if not name:
        return jsonify({"error": "name required"}), 400
    db = get_db()
    try:
        existing = db.execute("SELECT id FROM events WHERE id=?", (eid,)).fetchone()
        if not existing:
            return jsonify({"error": "event not found"}), 404
        db.execute(
            "UPDATE events SET name=?, description=?, event_date=?, event_time=? WHERE id=?",
            (name, description, event_date, event_time, eid),
        )
        db.commit()
        row = db.execute(
            """
            SELECT e.*,
                   (SELECT COUNT(*) FROM sessions WHERE event_id = e.id) AS session_count,
                   (SELECT COUNT(*) FROM sessions WHERE event_id = e.id AND status = 'open') AS open_session_count
            FROM events e
            WHERE e.id=?
            """,
            (eid,),
        ).fetchone()
        return jsonify({"event": _row_to_dict(row)})
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

# Query params: status, session_kind, event_id (optional filters).
@app.route("/api/sessions", methods=["GET"])
@_require_admin
def api_sessions_list():
    status = (request.args.get("status") or "").strip().lower()
    kind = (request.args.get("session_kind") or "").strip().lower()
    event_id = request.args.get("event_id", type=int)
    params = []
    where = []
    if status in ("open", "closed"):
        where.append("s.status=?")
        params.append(status)
    if kind in ("check_in", "time_out", "other"):
        where.append("s.session_kind=?")
        params.append(kind)
    if event_id:
        where.append("s.event_id=?")
        params.append(int(event_id))
    wsql = ("WHERE " + " AND ".join(where)) if where else ""
    db = get_db()
    try:
        rows = db.execute(
            f"""
            SELECT s.*, e.name AS event_name
            FROM sessions s
            LEFT JOIN events e ON s.event_id = e.id
            {wsql}
            ORDER BY s.date DESC, s.start_time DESC
            """,
            tuple(params),
        ).fetchall()
        return jsonify({"sessions": [_row_to_dict(r) for r in rows]})
    finally:
        db.close()


# Create session row linked to event_id (check_in / time_out / other).
@app.route("/api/sessions", methods=["POST"])
@_require_admin
def api_sessions_create():
    data = request.get_json(force=True) or {}
    event_id = data.get("event_id")
    subject = str(data.get("subject", "")).strip()
    section = str(data.get("section", "")).strip()
    date = str(data.get("date", "")).strip()
    start_time = str(data.get("start_time", "")).strip()
    session_kind = str(data.get("session_kind", "check_in")).strip() or "check_in"
    session_label = str(data.get("session_label", "")).strip() or None
    if session_kind not in ("check_in", "time_out", "other"):
        session_kind = "check_in"

    # Subject/section are optional for the UI; store safe defaults.
    if not subject:
        subject = "Attendance"
    if not section:
        section = "-"

    if not event_id or not date or not start_time:
        return jsonify({"error": "event_id,date,start_time required"}), 400

    db = get_db()
    try:
        ev = db.execute("SELECT id FROM events WHERE id=?", (int(event_id),)).fetchone()
        if not ev:
            return jsonify({"error": "invalid event_id"}), 400
        db.execute(
            """
            INSERT INTO sessions (event_id, subject, section, date, start_time, session_kind, session_label)
            VALUES (?,?,?,?,?,?,?)
            """,
            (int(event_id), subject, section, date, start_time, session_kind, session_label),
        )
        db.commit()
        row = db.execute("SELECT * FROM sessions WHERE id=last_insert_rowid()").fetchone()
        return jsonify({"session": _row_to_dict(row)})
    finally:
        db.close()


# Set status closed and capture end_time (HH:MM).
@app.route("/api/sessions/<int:sess_id>/close", methods=["POST"])
@_require_admin
def api_sessions_close(sess_id: int):
    db = get_db()
    try:
        end_time = datetime.now().strftime("%H:%M")
        db.execute(
            "UPDATE sessions SET status='closed', end_time=? WHERE id=?",
            (end_time, sess_id),
        )
        db.commit()
        return jsonify({"ok": True, "session_id": sess_id})
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Attendance
# ---------------------------------------------------------------------------

# Officer marks present by session_id + student_id string (INSERT OR IGNORE).
@app.route("/api/attendance/manual", methods=["POST"])
@_require_admin
def api_attendance_manual():
    data = request.get_json(force=True) or {}
    session_id = data.get("session_id")
    student_id = str(data.get("student_id", "")).strip()
    if not session_id or not student_id:
        return jsonify({"error": "session_id and student_id required"}), 400

    db = get_db()
    try:
        sess = db.execute("SELECT id FROM sessions WHERE id=?", (int(session_id),)).fetchone()
        if not sess:
            return jsonify({"error": "Session not found"}), 404
        stud = db.execute("SELECT * FROM students WHERE student_id=?", (student_id,)).fetchone()
        if not stud:
            return jsonify({"error": "Student not found"}), 404

        db.execute(
            "INSERT OR IGNORE INTO attendance (session_id, student_id) VALUES (?,?)",
            (int(session_id), int(stud["id"])),
        )
        db.commit()
        inserted = db.execute("SELECT changes()").fetchone()[0]
        return jsonify({"ok": True, "inserted": bool(inserted), "student": _row_to_dict(stud)})
    finally:
        db.close()


# Live/reports: rows joined to students + counts for dashboard denominator.
@app.route("/api/attendance/session/<int:session_id>")
@_require_admin
def api_attendance_for_session(session_id: int):
    db = get_db()
    try:
        sess = db.execute(
            """
            SELECT s.*, e.name AS event_name
            FROM sessions s
            LEFT JOIN events e ON s.event_id = e.id
            WHERE s.id=?
            """,
            (session_id,),
        ).fetchone()
        if not sess:
            return jsonify({"error": "Session not found"}), 404

        records = db.execute(
            """
            SELECT a.*, st.name, st.student_id AS student_number, st.course, st.college, st.section AS student_section
            FROM attendance a
            JOIN students st ON a.student_id = st.id
            WHERE a.session_id=?
            ORDER BY a.time_in ASC
            """,
            (session_id,),
        ).fetchall()

        attendance_count = db.execute(
            "SELECT COUNT(*) FROM attendance WHERE session_id=?",
            (session_id,),
        ).fetchone()[0]

        total_students = db.execute("SELECT COUNT(*) FROM students").fetchone()[0]

        return jsonify(
            {
                "session": _row_to_dict(sess),
                "records": [_row_to_dict(r) for r in records],
                "attendance_count": int(attendance_count),
                "total_students": int(total_students),
            }
        )
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Scanner + Auto-mark
# ---------------------------------------------------------------------------

# Run ARP scan, refresh router_devices, return devices + optional MAC→student match (no admin gate: same origin UI).
@app.route("/api/scan", methods=["POST"])
def api_scan():
    devices, hotspot_filter_note = scan_network()
    db = get_db()
    db.execute("DELETE FROM router_devices")
    for d in devices:
        db.execute(
            """
            INSERT INTO router_devices (mac_address, ip_address, hostname, last_seen)
            VALUES (?, ?, ?, ?)
            """,
            (d["mac_address"], d["ip_address"], d.get("hostname") or "", d["last_seen"]),
        )
    db.commit()

    result = []
    for d in devices:
        student = db.execute(
            "SELECT * FROM students WHERE mac_address=?", (d["mac_address"],)
        ).fetchone()
        result.append(
            {
                "mac_address": d["mac_address"],
                "ip_address": d["ip_address"],
                "hostname": d.get("hostname") or "",
                "last_seen": d["last_seen"],
                "student": _row_to_dict(student) if student else None,
            }
        )

    db.close()
    payload = {
        "devices": result,
        "count": len(result),
        "hotspot_filter_note": hotspot_filter_note,
        "scanner_build": "arp-v5-final-scrub-ipv4",
    }
    response = make_response(jsonify(payload))
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return response


# For session_id: insert attendance for each router_devices MAC that matches a student.
@app.route("/api/auto_mark", methods=["POST"])
def api_auto_mark():
    data = request.get_json(force=True)
    session_id = data.get("session_id")
    if not session_id:
        return jsonify({"error": "session_id required"}), 400

    db = get_db()
    session_row = db.execute("SELECT * FROM sessions WHERE id=?", (int(session_id),)).fetchone()
    if not session_row:
        db.close()
        return jsonify({"error": "Session not found"}), 404

    devices = db.execute("SELECT * FROM router_devices").fetchall()
    marked = 0
    for dev in devices:
        student = db.execute(
            "SELECT * FROM students WHERE mac_address=?", (dev["mac_address"],)
        ).fetchone()
        if not student:
            continue
        db.execute(
            "INSERT OR IGNORE INTO attendance (session_id, student_id) VALUES (?,?)",
            (int(session_id), int(student["id"])),
        )
        if db.execute("SELECT changes()").fetchone()[0]:
            marked += 1
    db.commit()
    db.close()

    return jsonify({"marked": marked, "session_id": int(session_id)})


# `python app.py` entry (optional; prefer flask run).
if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    app.run(debug=debug, host="0.0.0.0", port=5000)

