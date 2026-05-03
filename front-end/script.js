// Bootstraps the login page: input styling, auth POST, session list, student lookup debounce, manual attendance POST.
document.addEventListener('DOMContentLoaded', () => {
    // Autofill / focus: keep .has-value on .input-group for optional label styling.
    document.querySelectorAll('.input-group input, .input-group select').forEach(input => {
        if (input.value !== '') {
            input.parentElement.classList.add('has-value');
        }

        input.addEventListener('focus', () => {
            input.parentElement.classList.add('has-value');
        });

        input.addEventListener('blur', () => {
            if (input.value === '') {
                input.parentElement.classList.remove('has-value');
            }
        });

        input.addEventListener('input', () => {
            if (input.value !== '') {
                input.parentElement.classList.add('has-value');
            } else {
                input.parentElement.classList.remove('has-value');
            }
        });
    });

    const API = {
        login: '/api/auth/login',
        sessions: '/api/sessions',
        studentByStudentId: (sid) => `/api/students/by_student_id/${encodeURIComponent(sid)}`,
        manualAttendance: '/api/attendance/manual',
    };

    // fetch() with cookies; parses JSON; throws Error with server message or HTTP status on failure.
    async function apiFetch(url, options = {}) {
        const res = await fetch(url, {
            credentials: 'include',
            ...options,
            headers: {
                ...(options.headers || {}),
            },
        });
        let data = null;
        try { data = await res.json(); } catch { /* ignore */ }
        if (!res.ok) {
            const msg = data?.error || `Request failed (${res.status})`;
            throw new Error(msg);
        }
        return data;
    }

    // POST /api/auth/login then redirect to admin on success.
    document.getElementById('form-login').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('login-student-id').value.trim();
        const password = document.getElementById('login-password').value;

        try {
            await apiFetch(API.login, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
            window.location.href = 'admin.html';
        } catch (err) {
            alert(`Login failed: ${err.message}`);
        }
    });

    // Loads open sessions into #att-event; sessionKind maps Time in/out to API session_kind filter.
    async function loadSessionOptions(sessionKind) {
        const sel = document.getElementById('att-event');
        if (!sel) return;
        sel.innerHTML = `<option value="" disabled selected class="bg-zinc-900 text-zinc-500">Loading sessions…</option>`;
        try {
            const qs = new URLSearchParams();
            qs.set('status', 'open');
            if (sessionKind) qs.set('session_kind', sessionKind);
            const data = await apiFetch(`${API.sessions}?${qs.toString()}`);
            const sessions = data.sessions || [];
            if (!sessions.length) {
                sel.innerHTML = `<option value="" disabled selected class="bg-zinc-900 text-zinc-500">No open sessions</option>`;
                return;
            }
            sel.innerHTML = `<option value="" disabled selected class="bg-zinc-900 text-zinc-500">Select session</option>`;
            for (const s of sessions) {
                const labelParts = [];
                if (s.event_name) labelParts.push(s.event_name);
                labelParts.push(s.subject);
                labelParts.push(s.section);
                labelParts.push(s.date);
                sel.innerHTML += `<option value="${s.id}" class="bg-zinc-900 text-zinc-200">${labelParts.join(' · ')}</option>`;
            }
        } catch (err) {
            sel.innerHTML = `<option value="" disabled selected class="bg-zinc-900 text-zinc-500">Unable to load sessions (sign in required)</option>`;
            console.error(err);
        }
    }

    const attStudentIdInput = document.getElementById('att-studentid');
    const attLoading = document.getElementById('att-loading');
    const attStudentInfo = document.getElementById('att-student-info');
    const btnSubmitAtt = document.getElementById('submit-attendance');
    const attTypeInputs = document.querySelectorAll('input[name="att-type"]');

    if (document.getElementById('att-event')) {
        loadSessionOptions('check_in');
        attTypeInputs.forEach(r => {
            r.addEventListener('change', () => {
                const type = document.querySelector('input[name="att-type"]:checked')?.value;
                loadSessionOptions(type === 'out' ? 'time_out' : 'check_in');
            });
        });
    }

    // After 400ms quiet typing, resolves student by ID; shows panel + enables submit if found.
    if (attStudentIdInput) {
        let timeout = null;
        attStudentIdInput.addEventListener('input', (e) => {
            const val = e.target.value.trim();
            attStudentInfo.classList.add('hidden');
            btnSubmitAtt.disabled = true;

            if (val.length >= 5) {
                attLoading.classList.remove('hidden');
                clearTimeout(timeout);

                timeout = setTimeout(async () => {
                    try {
                        const data = await apiFetch(API.studentByStudentId(val));
                        const student = data.student;
                        attLoading.classList.add('hidden');
                        if (!student) return;

                        document.getElementById('att-display-name').innerText = student.name || '--';
                        document.getElementById('att-display-college').innerText = student.college || '--';
                        document.getElementById('att-display-course').innerText = student.course || '--';
                        document.getElementById('att-display-year').innerText = student.year_level ? `${student.year_level} Year` : '--';
                        document.getElementById('att-display-section').innerText = student.section ? `Section ${student.section}` : '--';

                        const now = new Date();
                        const timeString = now.toLocaleTimeString('en-PH', {
                            timeZone: 'Asia/Manila',
                            hour: 'numeric',
                            minute: '2-digit',
                            second: '2-digit',
                            hour12: true,
                        });
                        document.getElementById('att-display-time').innerText = `${timeString} PHT`;

                        attStudentInfo.classList.remove('hidden');
                        btnSubmitAtt.disabled = false;
                    } catch (err) {
                        attLoading.classList.add('hidden');
                        console.error(err);
                    }
                }, 400);
            }
        });
    }

    const formAttendance = document.getElementById('form-attendance');
    if (formAttendance) {
        // POST /api/attendance/manual with session_id + student_id; clears student field on success.
        formAttendance.addEventListener('submit', async (e) => {
            e.preventDefault();
            const sessionId = document.getElementById('att-event').value;
            const studentId = document.getElementById('att-studentid').value;
            const name = document.getElementById('att-display-name').innerText;

            try {
                await apiFetch(API.manualAttendance, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: parseInt(sessionId, 10), student_id: studentId }),
                });
                alert(`Successfully recorded attendance for ${name}.`);
            } catch (err) {
                alert(`Failed: ${err.message}`);
                return;
            }

            attStudentIdInput.value = '';
            attStudentIdInput.parentElement.classList.remove('has-value');
            attStudentInfo.classList.add('hidden');
            btnSubmitAtt.disabled = true;
        });
    }

});

// Toggles visible form and tab styles; called from login.html tab buttons (global for onclick).
function switchForm(formType) {
    const loginForm = document.getElementById('form-login');
    const attForm = document.getElementById('form-attendance');
    const loginBtn = document.getElementById('btn-login');
    const attBtn = document.getElementById('btn-attendance');

    if (formType === 'login') {
        loginForm?.classList.remove('hidden');
        attForm?.classList.add('hidden', 'opacity-0', 'translate-y-2');
        loginBtn?.classList.add('tab-active');
        loginBtn?.classList.remove('tab-inactive');
        attBtn?.classList.remove('tab-active');
        attBtn?.classList.add('tab-inactive');
    } else if (formType === 'attendance') {
        attForm?.classList.remove('hidden', 'opacity-0', 'translate-y-2');
        loginForm?.classList.add('hidden');
        attBtn?.classList.add('tab-active');
        attBtn?.classList.remove('tab-inactive');
        loginBtn?.classList.remove('tab-active');
        loginBtn?.classList.add('tab-inactive');
    }
}
