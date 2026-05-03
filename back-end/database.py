# SQLite schema + migrations for RBAMS (students, events, sessions, attendance, router_devices).
import os
import sqlite3
from datetime import datetime

DATABASE = os.path.join(os.path.dirname(__file__), "attendance.db")


# New connection; Row factory for column access by name.
def get_db():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn


# Used by migrate_schema to ALTER only when a column is missing.
def _column_exists(conn, table: str, name: str) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r[1] == name for r in rows)


# Add columns to old DB files; ensure tables exist; fix orphan session.event_id.
def migrate_schema():
    conn = get_db()
    cur = conn.cursor()

    # Extend participant fields used by the Tailwind front-end.
    if not _column_exists(conn, "students", "college"):
        cur.execute("ALTER TABLE students ADD COLUMN college TEXT")
    if not _column_exists(conn, "students", "year_level"):
        cur.execute("ALTER TABLE students ADD COLUMN year_level TEXT")
    if not _column_exists(conn, "students", "section"):
        cur.execute("ALTER TABLE students ADD COLUMN section TEXT")

    if not _column_exists(conn, "events", "event_time"):
        cur.execute("ALTER TABLE events ADD COLUMN event_time TEXT")

    # Events + session fields (in case DB existed without them).
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            description TEXT,
            event_date  TEXT,
            event_time  TEXT,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    if not _column_exists(conn, "sessions", "event_id"):
        cur.execute("ALTER TABLE sessions ADD COLUMN event_id INTEGER REFERENCES events(id)")
    if not _column_exists(conn, "sessions", "session_kind"):
        cur.execute("ALTER TABLE sessions ADD COLUMN session_kind TEXT DEFAULT 'check_in'")
    if not _column_exists(conn, "sessions", "session_label"):
        cur.execute("ALTER TABLE sessions ADD COLUMN session_label TEXT")

    # Backfill event for orphan sessions if needed.
    event_count = cur.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    sess_orphans = cur.execute("SELECT COUNT(*) FROM sessions WHERE event_id IS NULL").fetchone()[0]
    if event_count == 0 and sess_orphans > 0:
        cur.execute(
            """
            INSERT INTO events (name, description, event_date)
            VALUES (?, ?, ?)
            """,
            ("Imported sessions", "Auto-created for existing data", datetime.now().strftime("%Y-%m-%d")),
        )
        eid = cur.lastrowid
        cur.execute("UPDATE sessions SET event_id=? WHERE event_id IS NULL", (eid,))
    elif event_count > 0 and sess_orphans > 0:
        first_eid = cur.execute("SELECT id FROM events ORDER BY id LIMIT 1").fetchone()[0]
        cur.execute("UPDATE sessions SET event_id=? WHERE event_id IS NULL", (first_eid,))

    cur.execute(
        "UPDATE sessions SET session_kind='check_in' WHERE session_kind IS NULL OR session_kind=''"
    )

    conn.commit()
    conn.close()


# CREATE TABLE IF NOT EXISTS for all entities; then migrate_schema().
def init_db():
    conn = get_db()
    cur = conn.cursor()

    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS students (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id  TEXT UNIQUE NOT NULL,
            name        TEXT NOT NULL,
            course      TEXT NOT NULL,
            college     TEXT,
            year_level  TEXT,
            section     TEXT,
            mac_address TEXT UNIQUE,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            description TEXT,
            event_date  TEXT,
            event_time  TEXT,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id     INTEGER REFERENCES events(id),
            subject      TEXT NOT NULL,
            section      TEXT NOT NULL,
            date         TEXT NOT NULL,
            start_time   TEXT NOT NULL,
            end_time     TEXT,
            status       TEXT DEFAULT 'open',
            session_kind  TEXT DEFAULT 'check_in',
            session_label TEXT,
            created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS attendance (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            student_id INTEGER NOT NULL,
            status     TEXT DEFAULT 'present',
            time_in    DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (session_id) REFERENCES sessions(id),
            FOREIGN KEY (student_id) REFERENCES students(id),
            UNIQUE(session_id, student_id)
        );

        CREATE TABLE IF NOT EXISTS router_devices (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            mac_address TEXT UNIQUE NOT NULL,
            ip_address  TEXT,
            hostname    TEXT,
            last_seen   DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        """
    )

    conn.commit()
    conn.close()

    migrate_schema()
