"""
app.py – Router-Based Attendance System
Flask web application entry point.
"""

from flask import Flask, render_template, request, redirect, url_for, flash, jsonify
from database import get_db, init_db, seed_demo_data
from scanner import scan_network
from datetime import datetime

app = Flask(__name__)
import os
app.secret_key = os.environ.get('SECRET_KEY', 'rbas-secret-key-change-in-production')


# ---------------------------------------------------------------------------
# Initialise DB on first run
# ---------------------------------------------------------------------------

with app.app_context():
    init_db()
    seed_demo_data()


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

@app.route('/')
def index():
    db = get_db()
    total_students = db.execute('SELECT COUNT(*) FROM students').fetchone()[0]
    open_sessions  = db.execute("SELECT COUNT(*) FROM sessions WHERE status='open'").fetchone()[0]
    today = datetime.now().strftime('%Y-%m-%d')
    today_attendance = db.execute(
        "SELECT COUNT(*) FROM attendance a JOIN sessions s ON a.session_id=s.id WHERE s.date=?",
        (today,)
    ).fetchone()[0]
    recent_sessions = db.execute(
        "SELECT * FROM sessions ORDER BY created_at DESC LIMIT 5"
    ).fetchall()
    db.close()
    return render_template(
        'index.html',
        total_students=total_students,
        open_sessions=open_sessions,
        today_attendance=today_attendance,
        recent_sessions=recent_sessions,
    )


# ---------------------------------------------------------------------------
# Students
# ---------------------------------------------------------------------------

@app.route('/students')
def students():
    db = get_db()
    rows = db.execute('SELECT * FROM students ORDER BY name').fetchall()
    db.close()
    return render_template('students.html', students=rows)


@app.route('/students/add', methods=['GET', 'POST'])
def add_student():
    if request.method == 'POST':
        student_id  = request.form['student_id'].strip()
        name        = request.form['name'].strip()
        course      = request.form['course'].strip()
        mac_address = request.form.get('mac_address', '').strip().upper() or None
        db = get_db()
        try:
            db.execute(
                'INSERT INTO students (student_id, name, course, mac_address) VALUES (?,?,?,?)',
                (student_id, name, course, mac_address),
            )
            db.commit()
            flash('Student added successfully.', 'success')
        except Exception as e:
            flash(f'Error: {e}', 'danger')
        finally:
            db.close()
        return redirect(url_for('students'))
    return render_template('add_student.html')


@app.route('/students/edit/<int:sid>', methods=['GET', 'POST'])
def edit_student(sid):
    db = get_db()
    student = db.execute('SELECT * FROM students WHERE id=?', (sid,)).fetchone()
    if not student:
        flash('Student not found.', 'danger')
        db.close()
        return redirect(url_for('students'))
    if request.method == 'POST':
        name        = request.form['name'].strip()
        course      = request.form['course'].strip()
        mac_address = request.form.get('mac_address', '').strip().upper() or None
        try:
            db.execute(
                'UPDATE students SET name=?, course=?, mac_address=? WHERE id=?',
                (name, course, mac_address, sid),
            )
            db.commit()
            flash('Student updated.', 'success')
        except Exception as e:
            flash(f'Error: {e}', 'danger')
        finally:
            db.close()
        return redirect(url_for('students'))
    db.close()
    return render_template('edit_student.html', student=student)


@app.route('/students/delete/<int:sid>', methods=['POST'])
def delete_student(sid):
    db = get_db()
    db.execute('DELETE FROM students WHERE id=?', (sid,))
    db.commit()
    db.close()
    flash('Student deleted.', 'info')
    return redirect(url_for('students'))


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

@app.route('/sessions')
def sessions():
    db = get_db()
    rows = db.execute('SELECT * FROM sessions ORDER BY date DESC, start_time DESC').fetchall()
    db.close()
    return render_template('sessions.html', sessions=rows)


@app.route('/sessions/add', methods=['GET', 'POST'])
def add_session():
    if request.method == 'POST':
        subject    = request.form['subject'].strip()
        section    = request.form['section'].strip()
        date       = request.form['date']
        start_time = request.form['start_time']
        db = get_db()
        try:
            db.execute(
                'INSERT INTO sessions (subject, section, date, start_time) VALUES (?,?,?,?)',
                (subject, section, date, start_time),
            )
            db.commit()
            flash('Session created.', 'success')
        except Exception as e:
            flash(f'Error: {e}', 'danger')
        finally:
            db.close()
        return redirect(url_for('sessions'))
    today = datetime.now().strftime('%Y-%m-%d')
    now   = datetime.now().strftime('%H:%M')
    return render_template('add_session.html', today=today, now=now)


@app.route('/sessions/<int:sess_id>/close', methods=['POST'])
def close_session(sess_id):
    db = get_db()
    end_time = datetime.now().strftime('%H:%M')
    db.execute(
        "UPDATE sessions SET status='closed', end_time=? WHERE id=?",
        (end_time, sess_id),
    )
    db.commit()
    db.close()
    flash('Session closed.', 'info')
    return redirect(url_for('sessions'))


# ---------------------------------------------------------------------------
# Attendance
# ---------------------------------------------------------------------------

@app.route('/attendance')
def attendance():
    db = get_db()
    sessions_list = db.execute(
        "SELECT * FROM sessions ORDER BY date DESC, start_time DESC"
    ).fetchall()
    selected_id   = request.args.get('session_id', type=int)
    records = []
    selected_session = None
    if selected_id:
        selected_session = db.execute('SELECT * FROM sessions WHERE id=?', (selected_id,)).fetchone()
        records = db.execute(
            '''SELECT a.*, s.name, s.student_id as sid, s.course
               FROM attendance a
               JOIN students s ON a.student_id = s.id
               WHERE a.session_id=?
               ORDER BY a.time_in''',
            (selected_id,),
        ).fetchall()
    db.close()
    return render_template(
        'attendance.html',
        sessions=sessions_list,
        selected_id=selected_id,
        selected_session=selected_session,
        records=records,
    )


@app.route('/attendance/mark/<int:sess_id>', methods=['GET', 'POST'])
def mark_attendance(sess_id):
    db = get_db()
    session = db.execute('SELECT * FROM sessions WHERE id=?', (sess_id,)).fetchone()
    if not session:
        flash('Session not found.', 'danger')
        db.close()
        return redirect(url_for('sessions'))

    if request.method == 'POST':
        student_ids = request.form.getlist('student_ids')
        for stud_id in student_ids:
            try:
                db.execute(
                    'INSERT OR IGNORE INTO attendance (session_id, student_id) VALUES (?,?)',
                    (sess_id, int(stud_id)),
                )
            except Exception:
                pass
        db.commit()
        flash(f'{len(student_ids)} attendance record(s) saved.', 'success')
        db.close()
        return redirect(url_for('attendance', session_id=sess_id))

    # Already-marked student IDs
    marked_ids = {
        r['student_id']
        for r in db.execute(
            'SELECT student_id FROM attendance WHERE session_id=?', (sess_id,)
        ).fetchall()
    }
    all_students = db.execute('SELECT * FROM students ORDER BY name').fetchall()
    db.close()
    return render_template(
        'mark_attendance.html',
        session=session,
        students=all_students,
        marked_ids=marked_ids,
    )


# ---------------------------------------------------------------------------
# Router Scanner
# ---------------------------------------------------------------------------

@app.route('/scanner')
def scanner():
    db = get_db()
    sessions_list = db.execute(
        "SELECT * FROM sessions WHERE status='open' ORDER BY date DESC"
    ).fetchall()
    db.close()
    return render_template('scanner.html', sessions=sessions_list)


@app.route('/api/scan', methods=['POST'])
def api_scan():
    """Scan the network and update the router_devices table. Return found devices."""
    devices = scan_network()
    db = get_db()
    for d in devices:
        db.execute(
            '''INSERT INTO router_devices (mac_address, ip_address, hostname, last_seen)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(mac_address) DO UPDATE SET
                   ip_address=excluded.ip_address,
                   hostname=excluded.hostname,
                   last_seen=excluded.last_seen''',
            (d['mac_address'], d['ip_address'], d['hostname'], d['last_seen']),
        )
    db.commit()

    # Enrich with student info
    result = []
    for d in devices:
        student = db.execute(
            'SELECT * FROM students WHERE mac_address=?', (d['mac_address'],)
        ).fetchone()
        result.append({
            'mac_address': d['mac_address'],
            'ip_address':  d['ip_address'],
            'hostname':    d['hostname'],
            'last_seen':   d['last_seen'],
            'student':     dict(student) if student else None,
        })

    db.close()
    return jsonify({'devices': result, 'count': len(result)})


@app.route('/api/auto_mark', methods=['POST'])
def api_auto_mark():
    """Auto-mark attendance for a session based on devices found in router_devices."""
    data       = request.get_json(force=True)
    session_id = data.get('session_id')
    if not session_id:
        return jsonify({'error': 'session_id required'}), 400

    db = get_db()
    session = db.execute('SELECT * FROM sessions WHERE id=?', (session_id,)).fetchone()
    if not session:
        db.close()
        return jsonify({'error': 'Session not found'}), 404

    devices = db.execute('SELECT * FROM router_devices').fetchall()
    marked = 0
    for dev in devices:
        student = db.execute(
            'SELECT * FROM students WHERE mac_address=?', (dev['mac_address'],)
        ).fetchone()
        if student:
            try:
                db.execute(
                    'INSERT OR IGNORE INTO attendance (session_id, student_id) VALUES (?,?)',
                    (session_id, student['id']),
                )
                if db.execute('SELECT changes()').fetchone()[0]:
                    marked += 1
            except Exception:
                pass

    db.commit()
    db.close()
    return jsonify({'marked': marked, 'session_id': session_id})


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------

@app.route('/reports')
def reports():
    db = get_db()
    sessions_list = db.execute(
        "SELECT s.*, COUNT(a.id) as attendance_count "
        "FROM sessions s LEFT JOIN attendance a ON s.id=a.session_id "
        "GROUP BY s.id ORDER BY s.date DESC"
    ).fetchall()
    students_list = db.execute('SELECT * FROM students ORDER BY name').fetchall()
    db.close()
    return render_template('reports.html', sessions=sessions_list, students=students_list)


@app.route('/reports/student/<int:sid>')
def student_report(sid):
    db = get_db()
    student   = db.execute('SELECT * FROM students WHERE id=?', (sid,)).fetchone()
    if not student:
        flash('Student not found.', 'danger')
        db.close()
        return redirect(url_for('reports'))

    records = db.execute(
        '''SELECT s.subject, s.section, s.date, s.start_time,
                  a.status, a.time_in
           FROM attendance a
           JOIN sessions s ON a.session_id=s.id
           WHERE a.student_id=?
           ORDER BY s.date DESC''',
        (sid,),
    ).fetchall()

    total_sessions = db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0]
    db.close()
    attendance_rate = round(len(records) / total_sessions * 100, 1) if total_sessions else 0
    return render_template(
        'student_report.html',
        student=student,
        records=records,
        attendance_rate=attendance_rate,
        total_sessions=total_sessions,
    )


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    debug = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
    app.run(debug=debug, host='0.0.0.0', port=5000)
