# Router-Based Attendance System

A web-based attendance tracking system that leverages network router data (ARP table / connected-device detection) to automatically mark student attendance.  
Built with **Python / Flask** + **SQLite** + **Bootstrap 5** as a Final Project for Elective 2.

---

## Features

| Feature | Description |
|---------|-------------|
| **Student Management** | Register students with Student ID, course, and optional MAC address |
| **Session Management** | Create class sessions (subject, section, date, time) |
| **Manual Attendance** | Select students per session with a checkbox list |
| **Network Scanner** | Reads the local ARP table to discover connected devices |
| **Auto-Mark** | Matches detected MAC addresses to students and marks them present automatically |
| **Reports** | Per-session summary and per-student attendance rate with colour-coded indicators |

---

## Tech Stack

- **Backend**: Python 3.9+, Flask 3
- **Database**: SQLite (file `attendance.db`, auto-created on first run)
- **Frontend**: Bootstrap 5, Bootstrap Icons, vanilla JS

---

## Project Structure

```
Router-Based-Attendance-System/
├── app.py              # Flask application & routes
├── database.py         # DB initialisation, schema, seed data
├── scanner.py          # Network scanner (ARP table + demo devices)
├── requirements.txt    # Python dependencies
├── static/
│   ├── css/style.css
│   └── js/main.js
└── templates/
    ├── base.html
    ├── index.html          # Dashboard
    ├── students.html
    ├── add_student.html
    ├── edit_student.html
    ├── sessions.html
    ├── add_session.html
    ├── attendance.html
    ├── mark_attendance.html
    ├── scanner.html
    ├── reports.html
    └── student_report.html
```

---

## Setup & Run

### Prerequisites

- Python 3.9 or higher
- `pip`

### Install dependencies

```bash
pip install -r requirements.txt
```

### Run the application

```bash
python app.py
```

Open your browser at **http://localhost:5000**

> The SQLite database `attendance.db` is created automatically on first run and
> seeded with seven demo students so you can explore the system immediately.

---

## How the Router Scanner Works

1. On the **Scanner** page, click **Scan Now**.
2. The server runs `arp -a` to read the OS ARP cache (populated automatically when
   the machine communicates with other devices on the same subnet).
3. The discovered MAC addresses are stored in the `router_devices` table and
   compared against registered students.
4. Select an open session and click **Auto-Mark** to mark every recognised
   student as *present* in one click.

> **Note**: The scanner always includes a set of demo devices (matching the
> seeded students) so the feature is demonstrable in any environment, including
> machines that are not on a shared network.

---

## Usage Walkthrough

1. **Add students** – go to *Students → Add Student* and fill in the form.  
   Enter the student's device MAC address to enable auto-marking.
2. **Create a session** – go to *Sessions → New Session*.
3. **Scan & auto-mark** – go to *Scanner*, click **Scan Now**, choose the open
   session, then click **Auto-Mark**.
4. **View / edit attendance** – go to *Attendance*, pick a session.
5. **Check reports** – go to *Reports* for per-session summaries or click a
   student's report icon for their individual attendance rate.

---

## License

This project is submitted as a final project for **Elective 2** (Network Administration / IoT).
