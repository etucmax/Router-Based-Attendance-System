import sqlite3
import os

DATABASE = os.path.join(os.path.dirname(__file__), 'attendance.db')


def get_db():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    cursor = conn.cursor()

    cursor.executescript('''
        CREATE TABLE IF NOT EXISTS students (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT UNIQUE NOT NULL,
            name      TEXT NOT NULL,
            course    TEXT NOT NULL,
            mac_address TEXT UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            subject    TEXT NOT NULL,
            section    TEXT NOT NULL,
            date       TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time   TEXT,
            status     TEXT DEFAULT 'open',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    ''')

    conn.commit()
    conn.close()


def seed_demo_data():
    """Insert demo students if the table is empty."""
    conn = get_db()
    cursor = conn.cursor()

    count = cursor.execute('SELECT COUNT(*) FROM students').fetchone()[0]
    if count == 0:
        demo_students = [
            ('2021-00001', 'Juan dela Cruz',    'BSIT',  'AA:BB:CC:DD:EE:01'),
            ('2021-00002', 'Maria Santos',      'BSIT',  'AA:BB:CC:DD:EE:02'),
            ('2021-00003', 'Pedro Reyes',       'BSCS',  'AA:BB:CC:DD:EE:03'),
            ('2021-00004', 'Ana Garcia',        'BSCS',  'AA:BB:CC:DD:EE:04'),
            ('2021-00005', 'Carlos Mendoza',    'BSIT',  'AA:BB:CC:DD:EE:05'),
            ('2021-00006', 'Liza Aquino',       'BSIT',  None),
            ('2021-00007', 'Ramon Villanueva',  'BSCS',  None),
        ]
        cursor.executemany(
            'INSERT INTO students (student_id, name, course, mac_address) VALUES (?, ?, ?, ?)',
            demo_students,
        )

    conn.commit()
    conn.close()
