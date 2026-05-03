// RBAMS admin: one page, many sections; JSON APIs with session cookie; ensureAuth at boot.
document.addEventListener('DOMContentLoaded', () => {
    const API = {
        me: '/api/auth/me',
        logout: '/api/auth/logout',
        events: '/api/events',
        sessions: '/api/sessions',
        students: '/api/students',
        scan: '/api/scan',
        autoMark: '/api/auto_mark',
    };

    // fetch with credentials; JSON body on success; throws Error with server message or status.
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

    // GET /api/auth/me; send user to login if not an authenticated admin.
    async function ensureAuth() {
        try {
            const me = await apiFetch(API.me);
            if (!me.authenticated) {
                window.location.href = 'login.html';
                return false;
            }
            return true;
        } catch {
            window.location.href = 'login.html';
            return false;
        }
    }

    // POST logout, stop live scan loop, redirect to public login.
    async function performLogout() {
        try {
            await fetch(API.logout, { method: 'POST', credentials: 'include' });
        } catch {
            /* still redirect */
        }
        stopMonitorNetworkScan();
        window.location.href = 'login.html';
    }

    // --- STATE ---
    const state = {
        presentCount: 0,
        activeSessionId: null,
        events: [],
        sessions: [],
        sessionsAll: [],
        students: [],
        liveAttendance: {
            session: null,
            records: [],
        },
        // Populated by loadReportForEvent; used by CSV/PDF export buttons.
        reportExport: null,
    };

    // Polling period for attendance-monitoring: scan → auto_mark → refresh.
    const MONITOR_SCAN_INTERVAL_MS = 4000;
    let monitorNetworkScanTimerId = null;

    // Chart.js doughnut in dashboard; always destroy() before replacing canvas.
    let dashAttendanceChart = null;

    // Safe teardown so redraw does not leak Chart instances.
    function destroyDashAttendanceChart() {
        if (!dashAttendanceChart) return;
        try {
            dashAttendanceChart.destroy();
        } catch {
            /* canvas replaced or already torn down */
        }
        dashAttendanceChart = null;
    }

    const logs = [];

    // Escape text before inserting into innerHTML.
    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // Parse API/SQLite timestamps as UTC so Manila formatting is consistent.
    function parseDbTimestamp(v) {
        if (v == null || v === '') return null;
        if (v instanceof Date) return v;
        const s = String(v).trim();
        if (!s) return null;
        if (s.includes('T')) {
            if (s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
            return new Date(`${s}Z`);
        }
        return new Date(`${s.replace(' ', 'T')}Z`);
    }

    // Time only, Asia/Manila, 12h with seconds (live tables, exports).
    function formatTimePHT(isoOrDate) {
        const d = isoOrDate instanceof Date ? isoOrDate : parseDbTimestamp(isoOrDate);
        if (!d || Number.isNaN(d.getTime())) return '—';
        return d.toLocaleTimeString('en-PH', {
            timeZone: 'Asia/Manila',
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
        });
    }

    // Date + time stamp for PDF/CSV headers (Philippines).
    function formatDateTimePHT(isoOrDate) {
        const d = isoOrDate instanceof Date ? isoOrDate : parseDbTimestamp(isoOrDate);
        if (!d || Number.isNaN(d.getTime())) return '—';
        return d.toLocaleString('en-PH', {
            timeZone: 'Asia/Manila',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
        });
    }

    // "college · course" for report/org column; plain join for PDF row builder.
    function reportOrgCell(r) {
        const parts = [r.college, r.course].filter(Boolean);
        return parts.length ? parts.join(' · ') : '—';
    }

    // CSV cell quoting when value has comma, quote, or newline.
    function csvEscapeField(val) {
        const s = String(val ?? '');
        if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
    }

    // Resolve jsPDF class from UMD global (jspdf bundle).
    function getJsPDFConstructor() {
        if (window.jspdf && window.jspdf.jsPDF) return window.jspdf.jsPDF;
        if (typeof window.jsPDF === 'function') return window.jsPDF;
        return null;
    }

    // Build UTF-8 BOM CSV from state.reportExport and trigger download.
    function downloadReportCsv() {
        if (!state.reportExport) {
            alert('Select an event and wait for the report to load before exporting.');
            return;
        }
        const x = state.reportExport;
        const lines = [];
        lines.push(csvEscapeField('RBAMS Attendance Report'));
        lines.push(csvEscapeField(x.eventLabel));
        lines.push(csvEscapeField(`Session: ${x.sessionMeta}`));
        lines.push(csvEscapeField(`Totals — Total: ${x.total}, Present: ${x.present}, Absent: ${x.absent}`));
        lines.push(csvEscapeField(`Exported (Philippines): ${formatDateTimePHT(new Date())}`));
        lines.push('');
        lines.push(['User name', 'Organization', 'Time in (PHT)', 'Status'].map(csvEscapeField).join(','));
        for (const r of x.records) {
            const row = [
                r.name || '—',
                reportOrgCell(r),
                r.time_in ? `${formatTimePHT(r.time_in)} PHT` : '—',
                (r.status || 'present').toString(),
            ];
            lines.push(row.map(csvEscapeField).join(','));
        }
        const blob = new Blob([`\ufeff${lines.join('\n')}`], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safe = String(x.eventId).replace(/[^\w-]+/g, '_');
        a.download = `rbams-attendance-${safe}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    // Build A4 PDF table from state.reportExport via jsPDF + autotable.
    function downloadReportPdf() {
        if (!state.reportExport) {
            alert('Select an event and wait for the report to load before exporting.');
            return;
        }
        const JsPDF = getJsPDFConstructor();
        if (!JsPDF) {
            alert('PDF library did not load. Check your network connection and reload the page.');
            return;
        }
        const x = state.reportExport;
        const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        let y = 14;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(15);
        doc.text('RBAMS — Attendance report', 14, y);
        y += 8;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        const evLines = doc.splitTextToSize(String(x.eventLabel), 182);
        doc.text(evLines, 14, y);
        y += evLines.length * 5 + 2;
        const sessLines = doc.splitTextToSize(`Session: ${String(x.sessionMeta)}`, 182);
        doc.text(sessLines, 14, y);
        y += sessLines.length * 5 + 2;
        doc.text(`Totals: ${x.total} total · ${x.present} present · ${x.absent} absent`, 14, y);
        y += 6;
        doc.setFontSize(9);
        doc.setTextColor(70, 70, 70);
        doc.text(`Generated (Philippines): ${formatDateTimePHT(new Date())}`, 14, y);
        doc.setTextColor(0, 0, 0);
        y += 9;

        if (!x.records.length) {
            doc.setFontSize(11);
            doc.text('No attendance records for this session.', 14, y);
        } else {
            const body = x.records.map((r) => [
                r.name || '—',
                reportOrgCell(r),
                r.time_in ? `${formatTimePHT(r.time_in)} PHT` : '—',
                (r.status || 'present').toString(),
            ]);
            if (typeof doc.autoTable !== 'function') {
                alert('PDF table plugin did not load. Try reloading the page.');
                return;
            }
            doc.autoTable({
                startY: y,
                head: [['User name', 'Organization', 'Time in (PHT)', 'Status']],
                body,
                styles: { fontSize: 9, cellPadding: 2 },
                headStyles: { fillColor: [39, 39, 42], textColor: 255 },
                alternateRowStyles: { fillColor: [250, 250, 250] },
                margin: { left: 14, right: 14 },
            });
        }
        const safe = String(x.eventId).replace(/[^\w-]+/g, '_');
        doc.save(`rbams-attendance-${safe}.pdf`);
    }

    // Placeholder skeletons on dashboard cards while initial API bundle loads.
    function showDashboardSkeleton() {
        destroyDashAttendanceChart();
        const skNum = '<span class="skeleton inline-block rounded-md skeleton-line-lg"></span>';
        const skEvent = '<span class="skeleton block rounded-md w-full mt-1 max-w-full" style="height:2.75rem"></span>';
        ['dash-total-events', 'dash-total-participants', 'dash-present-participants'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = skNum;
        });
        const activeEl = document.getElementById('dash-active-event-name');
        if (activeEl) {
            activeEl.removeAttribute('title');
            activeEl.innerHTML = skEvent;
        }
        const rate = document.getElementById('dash-attendance-rate-body');
        if (rate) {
            rate.innerHTML = `
                <div class="flex flex-col sm:flex-row items-center justify-center gap-6 p-5 min-h-[220px]">
                    <div class="skeleton h-44 w-44 sm:h-48 sm:w-48 rounded-full shrink-0"></div>
                    <div class="flex flex-col gap-3 w-full max-w-[200px]">
                        <div class="skeleton h-10 w-24 rounded-md mx-auto sm:mx-0"></div>
                        <div class="skeleton h-3 w-full rounded-md"></div>
                        <div class="skeleton h-3 w-3/4 rounded-md"></div>
                    </div>
                </div>`;
        }
        const recent = document.getElementById('dash-recent-events-body');
        if (recent) {
            recent.innerHTML = `<div class="space-y-3">${[1, 2, 3, 4].map(() => '<div class="skeleton h-11 w-full rounded-lg"></div>').join('')}</div>`;
        }
    }

    // Replace dashboard widgets with error copy when boot fetch fails.
    function renderDashboardLoadError(message) {
        destroyDashAttendanceChart();
        document.getElementById('dash-total-events')?.replaceChildren(document.createTextNode('—'));
        document.getElementById('dash-total-participants')?.replaceChildren(document.createTextNode('—'));
        document.getElementById('dash-present-participants')?.replaceChildren(document.createTextNode('—'));
        setDashActiveEventDisplay(null);
        const rate = document.getElementById('dash-attendance-rate-body');
        if (rate) {
            rate.innerHTML = `<div class="flex items-center justify-center h-full px-4 text-center text-sm text-rose-400">${escapeHtml(message)}</div>`;
        }
        const recent = document.getElementById('dash-recent-events-body');
        if (recent) recent.innerHTML = '<p class="text-zinc-500 text-sm">Could not load events.</p>';
    }

    // Top stat cards: total events + registered users count.
    function syncDashboardSummaryNumbers() {
        document.getElementById('dash-total-events')?.replaceChildren(document.createTextNode(String((state.events || []).length)));
        document.getElementById('dash-total-participants')?.replaceChildren(document.createTextNode(String((state.students || []).length)));
    }

    // "Active Event" title under dashboard stats from current open session’s event name.
    function setDashActiveEventDisplay(name) {
        const el = document.getElementById('dash-active-event-name');
        if (!el) return;
        const text = name && String(name).trim() ? String(name).trim() : '—';
        el.replaceChildren(document.createTextNode(text));
        if (text === '—') el.removeAttribute('title');
        else el.setAttribute('title', text);
    }

    // Recent events list (right column), sorted by date desc.
    function renderDashRecentEvents() {
        const el = document.getElementById('dash-recent-events-body');
        if (!el) return;
        const list = [...(state.events || [])].sort((a, b) => {
            const da = a.event_date || '';
            const db = b.event_date || '';
            if (da !== db) return db.localeCompare(da);
            return (b.id || 0) - (a.id || 0);
        }).slice(0, 6);
        if (!list.length) {
            el.innerHTML = '<p class="text-zinc-500 text-sm">No events yet.</p>';
            return;
        }
        el.innerHTML = `<ul class="space-y-3">${list.map(e => `
            <li class="flex justify-between gap-3 border-b border-zinc-800/60 pb-2 last:border-0 last:pb-0">
                <span class="font-medium text-zinc-100 min-w-0 break-words">${escapeHtml(e.name || '—')}</span>
                <span class="text-zinc-500 shrink-0 tabular-nums">${escapeHtml(e.event_date || '—')}</span>
            </li>
        `).join('')}</ul>`;
    }

    // Donut (Chart.js) or bar fallback: present vs registered for state.activeSessionId.
    function renderDashAttendanceRate() {
        const el = document.getElementById('dash-attendance-rate-body');
        if (!el) return;
        destroyDashAttendanceChart();

        const total = (state.students || []).length;
        const present = Number(state.presentCount) || 0;
        const hasSession = !!state.activeSessionId;
        if (!hasSession) {
            el.innerHTML = '<div class="flex flex-col items-center justify-center min-h-[200px] gap-2 px-4 text-center"><p class="text-zinc-500 text-sm">Open a check-in session to track live attendance here.</p></div>';
            return;
        }
        if (!total) {
            el.innerHTML = '<div class="flex flex-col items-center justify-center min-h-[200px] gap-2 px-4 text-center"><p class="text-zinc-500 text-sm">Register users to see attendance rate for this session.</p></div>';
            return;
        }

        const absent = Math.max(0, total - present);
        const pct = Math.min(100, Math.round((100 * present) / total));

        const statsBlock = `
                <div class="flex flex-col justify-center gap-3 text-center sm:text-left min-w-0 flex-1 max-w-md">
                    <p class="text-4xl sm:text-5xl font-bold text-zinc-50 tabular-nums leading-none">${pct}<span class="text-2xl sm:text-3xl text-zinc-500 font-semibold">%</span></p>
                    <p class="text-sm text-zinc-500">Checked in for the active session</p>
                    <div class="flex flex-wrap justify-center sm:justify-start gap-x-6 gap-y-2 text-sm border-t border-zinc-800/80 pt-3">
                        <span class="text-zinc-500">Present <span class="text-emerald-400 font-semibold tabular-nums">${present}</span></span>
                        <span class="text-zinc-500">Not yet <span class="text-zinc-300 font-semibold tabular-nums">${absent}</span></span>
                        <span class="text-zinc-500 w-full sm:w-auto sm:ml-0">Registered <span class="text-zinc-200 font-semibold tabular-nums">${total}</span></span>
                    </div>
                </div>`;

        if (typeof window.Chart === 'undefined') {
            el.innerHTML = `
            <div class="flex flex-col sm:flex-row items-center justify-center gap-8 px-4 py-5 min-h-[220px] min-w-0">
                <div class="w-full sm:flex-1 sm:max-w-xs space-y-3">
                    <div class="h-3 rounded-full bg-zinc-800 overflow-hidden">
                        <div class="h-full bg-emerald-500/85 rounded-full transition-all duration-300" style="width:${pct}%"></div>
                    </div>
                    <p class="text-xs text-zinc-500 text-center sm:text-left tabular-nums">Progress · ${present} of ${total}</p>
                </div>
                ${statsBlock}
            </div>`;
            return;
        }

        el.innerHTML = `
            <div class="flex flex-col sm:flex-row items-center justify-center gap-6 sm:gap-8 px-4 py-5 min-h-[220px] min-w-0">
                <div class="relative h-[180px] w-[180px] sm:h-[200px] sm:w-[200px] shrink-0">
                    <canvas id="dash-attendance-chart" role="img" aria-label="Attendance: ${present} present of ${total} registered"></canvas>
                </div>
                ${statsBlock}
            </div>`;

        const canvas = document.getElementById('dash-attendance-chart');
        if (!canvas) return;

        const Chart = window.Chart;
        const p = present;
        const t = total;
        dashAttendanceChart = new Chart(canvas, {
            type: 'doughnut',
            data: {
                labels: ['Present', 'Not checked in'],
                datasets: [{
                    data: [p, absent],
                    backgroundColor: [
                        'rgba(52, 211, 153, 0.88)',
                        'rgba(57, 57, 64, 0.92)',
                    ],
                    borderColor: [
                        'rgba(16, 185, 129, 0.35)',
                        'rgba(63, 63, 70, 0.9)',
                    ],
                    borderWidth: 1,
                    hoverOffset: 6,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '68%',
                animation: {
                    animateRotate: true,
                    duration: 450,
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(24, 24, 27, 0.96)',
                        titleColor: '#fafafa',
                        bodyColor: '#d4d4d8',
                        borderColor: 'rgba(63, 63, 70, 0.85)',
                        borderWidth: 1,
                        padding: 10,
                        displayColors: true,
                        callbacks: {
                            label(ctx) {
                                const n = ctx.raw || 0;
                                const share = t > 0 ? Math.round((100 * n) / t) : 0;
                                return ` ${ctx.label}: ${n} (${share}%)`;
                            },
                        },
                    },
                },
            },
        });
    }

    // Enable Start only when session exists; show Stop while interval runs; lock selector while scanning.
    function updateMonitorScanUi() {
        const scanning = monitorNetworkScanTimerId !== null;
        const start = document.getElementById('btn-start-monitor-scan');
        const stop = document.getElementById('btn-stop-monitor-scan');
        const sel = document.getElementById('active-session-selector');
        const hasSession = !!state.activeSessionId;
        if (start) {
            start.disabled = !hasSession || scanning;
        }
        if (stop) {
            stop.classList.toggle('hidden', !scanning);
        }
        if (sel) {
            sel.disabled = scanning;
        }
    }

    // Green “network scan running” strip + optional ring on present-count card.
    function setMonitorActiveScanPanel(visible) {
        document.getElementById('monitor-active-scan-panel')?.classList.toggle('hidden', !visible);
        const card = document.getElementById('monitor-present-card');
        if (card) {
            card.classList.toggle('ring-1', !!visible);
            card.classList.toggle('ring-emerald-500/30', !!visible);
        }
    }

    // Clear scan interval, hide running panel, clear last-probe line.
    function stopMonitorNetworkScan() {
        if (monitorNetworkScanTimerId !== null) {
            clearInterval(monitorNetworkScanTimerId);
            monitorNetworkScanTimerId = null;
        }
        setMonitorActiveScanPanel(false);
        const probeEl = document.getElementById('monitor-last-probe-pht');
        if (probeEl) probeEl.textContent = '';
        updateMonitorScanUi();
    }

    // One loop: POST /scan, /auto_mark for active session, refresh live table; no-op if user left monitoring page.
    async function runMonitorScanCycle() {
        const sec = document.getElementById('attendance-monitoring');
        if (!sec?.classList.contains('active') || !state.activeSessionId) {
            stopMonitorNetworkScan();
            return;
        }
        const sid = state.activeSessionId;
        try {
            await apiFetch(API.scan, { method: 'POST', cache: 'no-store' });
            await apiFetch(API.autoMark, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: sid }),
            });
            await refreshLiveAttendance();
            const probeEl = document.getElementById('monitor-last-probe-pht');
            if (probeEl) {
                probeEl.textContent = `Last probe: ${formatTimePHT(new Date())} PHT`;
            }
        } catch (e) {
            console.warn('Monitor scan cycle', e);
        }
    }

    // First cycle immediately, then setInterval at MONITOR_SCAN_INTERVAL_MS.
    function startMonitorNetworkScan() {
        if (!state.activeSessionId) {
            alert('No open sessions. Create one under Sessions first.');
            return;
        }
        stopMonitorNetworkScan();
        setMonitorActiveScanPanel(true);
        const probeClear = document.getElementById('monitor-last-probe-pht');
        if (probeClear) probeClear.textContent = '';
        void runMonitorScanCycle();
        monitorNetworkScanTimerId = setInterval(() => {
            void runMonitorScanCycle();
        }, MONITOR_SCAN_INTERVAL_MS);
        updateMonitorScanUi();
    }

    // --- Navigation: show one .page-section, update title, refresh or stop scan ---
    const navItems = document.querySelectorAll('.nav-item');
    const sections = document.querySelectorAll('.page-section');
    const pageTitle = document.getElementById('page-title');
    const sidebar = document.getElementById('sidebar');
    const mobileToggle = document.getElementById('sidebar-toggle');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            navItems.forEach(nav => nav.classList.remove('active'));
            sections.forEach(sec => sec.classList.remove('active'));
            item.classList.add('active');
            const targetId = item.getAttribute('data-target');
            document.getElementById(targetId).classList.add('active');
            pageTitle.innerText = item.querySelector('span').innerText;
            if (targetId === 'attendance-monitoring') {
                refreshLiveAttendance().catch(() => {});
            } else {
                stopMonitorNetworkScan();
            }
            if (window.innerWidth <= 768) {
                sidebar.classList.remove('open');
            }
        });
    });

    mobileToggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
    });

    document.getElementById('btn-logout')?.addEventListener('click', () => {
        void performLogout();
    });

    // --- Data refresh helpers (events, students, sessions, live attendance) ---

    // GET /api/events; repaints event table, session/create + report dropdowns, dashboard bits.
    async function refreshEventsFromApi() {
        const res = await apiFetch(API.events);
        state.events = res.events || [];
        renderEventTable();
        populateSessionCreateEventSelector();
        populateReportEvents();
        syncDashboardSummaryNumbers();
        renderDashRecentEvents();
    }

    // Clear create-event modal fields and button label for “create” mode.
    function resetEventModalForCreate() {
        const titleEl = document.getElementById('modal-event-title');
        const saveBtn = document.getElementById('btn-save-event');
        document.getElementById('evt-editing-id').value = '';
        document.getElementById('evt-name').value = '';
        document.getElementById('evt-date').value = '';
        document.getElementById('evt-time').value = '';
        document.getElementById('evt-venue').value = '';
        if (titleEl) titleEl.textContent = 'Create New Event';
        if (saveBtn) saveBtn.textContent = 'Create Event';
    }

    // Load one event from state into modal for PUT.
    function openEventModalForEdit(eventId) {
        const ev = state.events.find(e => Number(e.id) === Number(eventId));
        if (!ev) return;
        const titleEl = document.getElementById('modal-event-title');
        const saveBtn = document.getElementById('btn-save-event');
        document.getElementById('evt-editing-id').value = String(ev.id);
        document.getElementById('evt-name').value = ev.name || '';
        document.getElementById('evt-date').value = ev.event_date || '';
        document.getElementById('evt-time').value = ev.event_time || '';
        document.getElementById('evt-venue').value = ev.description || '';
        if (titleEl) titleEl.textContent = 'Edit Event';
        if (saveBtn) saveBtn.textContent = 'Save Changes';
        document.getElementById('modal-create-event')?.classList.add('active');
    }

    // Event table time cell: stored event_time or em dash.
    function formatEventTableTime(t) {
        const s = t != null ? String(t).trim() : '';
        return s ? escapeHtml(s) : '—';
    }

    // Venue column uses events.description in API.
    function eventTableVenue(ev) {
        const v = (ev.description || '').trim();
        return v ? escapeHtml(v) : '—';
    }

    // Pill label + class: open session → Active; else compare event_date to Manila “today”.
    function eventTableStatus(ev) {
        const open = Number(ev.open_session_count || 0) > 0;
        if (open) return { label: 'Active', cls: 'status-active' };
        const d = (ev.event_date || '').trim();
        if (!d) return { label: 'Scheduled', cls: 'status-upcoming' };
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
        if (d < today) return { label: 'Past', cls: 'status-closed' };
        if (d > today) return { label: 'Upcoming', cls: 'status-upcoming' };
        return { label: 'Today', cls: 'status-upcoming' };
    }

    // Fill #event-table from state.events.
    function renderEventTable() {
        const tbody = document.querySelector('#event-table tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (!state.events.length) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-zinc-500">No events yet.</td></tr>`;
            return;
        }
        state.events.forEach(event => {
            const name = escapeHtml(event.name || '—');
            const date = escapeHtml(event.event_date || '—');
            const timeCell = formatEventTableTime(event.event_time);
            const venueCell = eventTableVenue(event);
            const st = eventTableStatus(event);
            const eid = Number(event.id);
            tbody.innerHTML += `
                <tr>
                    <td class="max-w-[200px] sm:max-w-none"><strong class="break-words">${name}</strong></td>
                    <td>${date}</td>
                    <td class="tabular-nums whitespace-nowrap">${timeCell}</td>
                    <td class="min-w-0 max-w-[160px] sm:max-w-xs align-top"><span class="break-words text-zinc-200">${venueCell}</span></td>
                    <td><span class="event-status ${st.cls}">${st.label}</span></td>
                    <td>
                        <button type="button" class="action-btn edit action-edit-event" data-event-id="${eid}" title="Edit Event"><i class="fa-solid fa-pen-to-square"></i></button>
                        <button type="button" class="action-btn delete action-delete-event" data-event-id="${eid}" title="Delete Event"><i class="fa-solid fa-trash-can"></i></button>
                    </td>
                </tr>
            `;
        });
    }

    // Live monitoring table from state.liveAttendance.records (selected session).
    function renderAttendanceTable() {
        const tbody = document.querySelector('#attendance-table tbody');
        if (!tbody) return;

        const records = state.liveAttendance?.records || [];
        if (!records.length) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-zinc-500">No attendance records yet. Press <strong>Start scanning</strong> while users are on Wi‑Fi so the system can probe the network and match MAC addresses to this session.</td></tr>`;
            return;
        }

        tbody.innerHTML = records.map((r) => {
            const timeIn = r.time_in ? `${formatTimePHT(r.time_in)} <span class="text-zinc-600 text-[0.7rem]">PHT</span>` : '—';
            const device = 'Wi‑Fi / MAC';
            const status = escapeHtml((r.status || 'present').toString());
            const name = escapeHtml(r.name || '—');
            const orgParts = [r.college, r.course].filter(Boolean);
            const org = escapeHtml(orgParts.length ? orgParts.join(' · ') : '—');
            return `
                <tr>
                    <td class="min-w-0 max-w-[200px]"><strong class="break-words">${name}</strong></td>
                    <td class="min-w-0 text-zinc-300"><span class="break-words">${org}</span></td>
                    <td><span class="badge-status badge-present">${device}</span></td>
                    <td class="tabular-nums">${timeIn}</td>
                    <td><span class="badge-status badge-present">${status}</span></td>
                </tr>
            `;
        }).join('');
    }

    // GET /api/students; updates device table + dashboard denominators.
    async function refreshStudentsFromApi() {
        const res = await apiFetch(API.students);
        state.students = res.students || [];
        renderDeviceTable();
        syncDashboardSummaryNumbers();
        renderDashAttendanceRate();
    }

    // User & device table with optional search filter.
    function renderDeviceTable() {
        const tbody = document.querySelector('#device-table tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        const q = (document.getElementById('device-search-input')?.value || '').trim().toLowerCase();
        let rows = state.students || [];
        if (q) {
            rows = rows.filter((st) => {
                const hay = [st.name, st.student_id, st.mac_address, st.course, st.college]
                    .map((x) => (x || '').toString().toLowerCase())
                    .join(' ');
                return hay.includes(q);
            });
        }
        if (!rows.length) {
            const emptyMsg = (state.students || []).length
                ? 'No matches for your search.'
                : 'No registered users yet.';
            tbody.innerHTML = `<tr><td colspan="4" class="text-zinc-500">${emptyMsg}</td></tr>`;
            return;
        }
        rows.forEach((st) => {
            const mac = st.mac_address ? escapeHtml(st.mac_address) : '—';
            const name = escapeHtml(st.name || '—');
            const pk = Number(st.id);
            if (!Number.isFinite(pk)) return;
            tbody.innerHTML += `
                <tr>
                    <td class="min-w-0 max-w-[220px] sm:max-w-md"><strong class="break-words">${name}</strong></td>
                    <td class="min-w-0 font-mono text-sm break-all">${mac}</td>
                    <td><span class="badge-status ${st.mac_address ? 'badge-present' : 'badge-late'}">${st.mac_address ? 'Registered' : 'No MAC'}</span></td>
                    <td>
                        <button type="button" class="action-btn edit action-clear-device" data-student-id="${pk}" title="Clear MAC (reset device)"><i class="fa-solid fa-rotate-right"></i></button>
                        <button type="button" class="action-btn delete action-delete-user" data-student-id="${pk}" title="Delete user"><i class="fa-solid fa-trash-can"></i></button>
                    </td>
                </tr>
            `;
        });
    }

    // System log sidebar list from in-memory `logs` array.
    function renderLogs() {
        const ul = document.getElementById('activity-log-list');
        if (!ul) return;
        ul.innerHTML = '';
        if (!logs.length) {
            ul.innerHTML = `<li class="text-zinc-500 text-sm">No activity yet.</li>`;
            return;
        }
        logs.forEach(log => {
            ul.innerHTML += `
                <li>
                    <span class="time">${log.time}</span>
                    <span class="action">${log.action}</span>
                </li>
            `;
        });
    }

    // API session_kind enum → human label for selects and tables.
    function sessionKindLabel(kind) {
        if (kind === 'time_out') return 'Time out';
        if (kind === 'check_in') return 'Time in';
        if (kind === 'other') return 'Other';
        return kind || '—';
    }

    // Sessions list from state.sessions (respects filter); wires Close buttons.
    function renderSessionTable() {
        const tbody = document.querySelector('#session-table tbody');
        const summary = document.getElementById('session-summary');
        if (!tbody) return;

        const rows = state.sessions || [];
        tbody.innerHTML = '';
        if (summary) summary.textContent = `${rows.length} session(s)`;

        if (!rows.length) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-zinc-500">No sessions.</td></tr>`;
            return;
        }

        for (const s of rows) {
            const statusClass = s.status === 'open' ? 'status-active' : 'status-closed';
            const closeBtn = s.status === 'open'
                ? `<button class="btn btn-outline btn-sm action-close-session" data-id="${s.id}">Close</button>`
                : `<span class="text-zinc-500 text-xs">—</span>`;

            tbody.innerHTML += `
                <tr>
                    <td><strong>${s.event_name || '—'}</strong></td>
                    <td>${sessionKindLabel(s.session_kind)}</td>
                    <td>${s.subject || '—'}</td>
                    <td>${s.section || '—'}</td>
                    <td>${s.date || '—'}</td>
                    <td>${s.start_time || '—'}</td>
                    <td><span class="event-status ${statusClass}">${s.status || '—'}</span></td>
                    <td>${closeBtn}</td>
                </tr>
            `;
        }

        tbody.querySelectorAll('.action-close-session').forEach(btn => {
            btn.addEventListener('click', async function () {
                const id = parseInt(this.getAttribute('data-id'), 10);
                if (!id) return;
                try {
                    await apiFetch(`${API.sessions}/${id}/close`, { method: 'POST' });
                    logs.unshift({ time: 'Just now', action: `Closed session #${id}.` });
                    await refreshSessions();
                    await refreshLiveAttendance();
                    renderLogs();
                } catch (err) {
                    alert(`Failed to close session: ${err.message}`);
                }
            });
        });
    }

    // Open sessions only → #active-session-selector; sets state.activeSessionId and dashboard active event line.
    function populateActiveSessionSelector() {
        const sel = document.getElementById('active-session-selector');
        if (!sel) return;
        const open = (state.sessionsAll || []).filter(s => s.status === 'open');

        sel.innerHTML = '';
        if (!open.length) {
            sel.innerHTML = `<option value="" selected disabled>No open sessions</option>`;
            sel.title = '';
            state.activeSessionId = null;
            document.getElementById('monitor-active-event')?.replaceChildren(document.createTextNode('Active: —'));
            setDashActiveEventDisplay(null);
            stopMonitorNetworkScan();
            return;
        }

        for (const s of open) {
            const label = [
                s.event_name || 'Event',
                sessionKindLabel(s.session_kind),
                s.subject || '',
                s.section ? `Sec ${s.section}` : '',
                s.date || '',
            ].filter(Boolean).join(' · ');
            const opt = document.createElement('option');
            opt.value = String(s.id);
            opt.textContent = label;
            sel.appendChild(opt);
        }

        const candidate = state.activeSessionId && open.some(s => s.id === state.activeSessionId)
            ? state.activeSessionId
            : open[0].id;
        state.activeSessionId = candidate;
        sel.value = String(candidate);
        sel.title = sel.options[sel.selectedIndex]?.textContent?.trim() || '';
        const active = open.find(s => s.id === candidate);
        document.getElementById('monitor-active-event')?.replaceChildren(
            document.createTextNode(active?.event_name ? `Active: ${active.event_name}` : 'Active: —')
        );
        setDashActiveEventDisplay(active?.event_name);
        updateMonitorScanUi();
    }

    // Events dropdown for “create session” modal.
    function populateSessionCreateEventSelector() {
        const sel = document.getElementById('sess-event');
        if (!sel) return;
        sel.innerHTML = '';
        if (!state.events.length) {
            sel.innerHTML = `<option value="" disabled selected>No events yet</option>`;
            return;
        }
        sel.innerHTML = `<option value="" disabled selected>Select event</option>`;
        for (const e of state.events) {
            const opt = document.createElement('option');
            opt.value = String(e.id);
            opt.textContent = e.event_date ? `${e.name} · ${e.event_date}` : e.name;
            sel.appendChild(opt);
        }
    }

    // Loads filtered sessions + full list; redraws table and monitoring session picker.
    async function refreshSessions() {
        const filter = document.getElementById('session-filter')?.value || 'all';
        let url = `${API.sessions}?status=open`;
        if (filter === 'closed') url = `${API.sessions}?status=closed`;
        if (filter === 'all') url = `${API.sessions}`;

        const list = await apiFetch(url);
        state.sessions = list.sessions || [];

        const all = await apiFetch(`${API.sessions}`);
        state.sessionsAll = all.sessions || [];

        renderSessionTable();
        populateActiveSessionSelector();
    }

    // GET attendance for state.activeSessionId; updates counts, monitoring table, donut.
    async function refreshLiveAttendance() {
        const displayPresent = document.getElementById('live-present-count');
        const dashPresent = document.getElementById('dash-present-participants');

        if (!state.activeSessionId) {
            state.presentCount = 0;
            state.liveAttendance = { session: null, records: [] };
            if (displayPresent) displayPresent.innerText = '0';
            if (dashPresent) dashPresent.innerText = '0';
            renderAttendanceTable();
            renderDashAttendanceRate();
            return;
        }

        const data = await apiFetch(`/api/attendance/session/${state.activeSessionId}`);
        state.liveAttendance = {
            session: data.session || null,
            records: data.records || [],
        };
        state.presentCount = Number.isFinite(data.attendance_count) ? data.attendance_count : (state.liveAttendance.records.length || 0);
        if (displayPresent) displayPresent.innerText = String(state.presentCount);
        if (dashPresent) dashPresent.innerText = String(state.presentCount);
        renderAttendanceTable();
        renderDashAttendanceRate();
    }

    // Events dropdown on Attendance Reports section.
    function populateReportEvents() {
        const sel = document.getElementById('report-event-selector');
        if (!sel) return;
        sel.innerHTML = '';
        if (!state.events.length) {
            sel.innerHTML = `<option value="" selected disabled>No events yet</option>`;
            return;
        }
        sel.innerHTML = `<option value="" selected disabled>Select event</option>`;
        for (const e of state.events) {
            const opt = document.createElement('option');
            opt.value = String(e.id);
            opt.textContent = e.event_date ? `${e.name} · ${e.event_date}` : e.name;
            sel.appendChild(opt);
        }
    }

    // Clears report totals/table and state.reportExport when nothing to show.
    function renderReportEmpty(msg) {
        state.reportExport = null;
        document.getElementById('report-total')?.replaceChildren(document.createTextNode('0'));
        document.getElementById('report-present')?.replaceChildren(document.createTextNode('0'));
        document.getElementById('report-absent')?.replaceChildren(document.createTextNode('0'));
        const reportBody = document.querySelector('#report-table tbody');
        if (reportBody) {
            reportBody.innerHTML = `<tr><td colspan="4" class="text-zinc-500">${msg}</td></tr>`;
        }
    }

    // Resolve best session for event, fill report table, snapshot state.reportExport for exports.
    async function loadReportForEvent(eventId) {
        state.reportExport = null;
        const sessRes = await apiFetch(`${API.sessions}?event_id=${eventId}`);
        const all = sessRes.sessions || [];
        if (!all.length) {
            renderReportEmpty('No sessions for this event.');
            return;
        }
        const open = all.filter(s => s.status === 'open');
        const openCheckIn = open.filter(s => s.session_kind === 'check_in');
        const chosen = (openCheckIn[0] || open[0] || all[0]);

        const att = await apiFetch(`/api/attendance/session/${chosen.id}`);
        const total = att.total_students ?? state.students.length ?? 0;
        const present = att.attendance_count ?? (att.records?.length || 0);
        const absent = Math.max(0, total - present);

        document.getElementById('report-total')?.replaceChildren(document.createTextNode(String(total)));
        document.getElementById('report-present')?.replaceChildren(document.createTextNode(String(present)));
        document.getElementById('report-absent')?.replaceChildren(document.createTextNode(String(absent)));

        const reportBody = document.querySelector('#report-table tbody');
        if (!reportBody) return;

        const records = att.records || [];
        const ev = state.events.find((e) => Number(e.id) === Number(eventId));
        const eventLabel = ev ? (ev.event_date ? `${ev.name} · ${ev.event_date}` : ev.name) : `Event #${eventId}`;
        const sess = att.session || {};
        const sessionMeta = [
            sess.event_name,
            sess.date,
            sess.start_time,
            sess.session_kind ? String(sess.session_kind).replace('_', ' ') : '',
        ].filter(Boolean).join(' · ') || `Session #${chosen.id}`;

        state.reportExport = {
            eventId,
            eventLabel,
            sessionId: chosen.id,
            sessionMeta,
            total,
            present,
            absent,
            records: [...records],
        };

        if (!records.length) {
            reportBody.innerHTML = `<tr><td colspan="4" class="text-zinc-500">No attendance recorded for the selected event yet.</td></tr>`;
            return;
        }

        reportBody.innerHTML = records.map(r => {
            const t = r.time_in ? `${formatTimePHT(r.time_in)} PHT` : '—';
            const nm = escapeHtml(r.name || '—');
            const crs = escapeHtml(reportOrgCell(r));
            return `
                <tr>
                    <td><strong>${nm}</strong></td>
                    <td>${crs}</td>
                    <td>${t}</td>
                    <td><span class="badge-status badge-present">${escapeHtml((r.status || 'present').toString())}</span></td>
                </tr>
            `;
        }).join('');
    }

    // Initial empty tables/log before boot fetch fills state.
    renderEventTable();
    renderAttendanceTable();
    renderDeviceTable();
    renderLogs();

    // Boot: skeleton → auth → parallel load events, open sessions, students → refresh sessions + live attendance.
    (async () => {
        showDashboardSkeleton();
        const ok = await ensureAuth();
        if (!ok) return;
        try {
            const [events, sessions, students] = await Promise.all([
                apiFetch(API.events),
                apiFetch(`${API.sessions}?status=open`),
                apiFetch(API.students),
            ]);
            state.events = events.events || [];
            state.sessions = sessions.sessions || [];
            state.students = students.students || [];
            state.activeSessionId = state.sessions[0]?.id ?? null;

            syncDashboardSummaryNumbers();
            document.getElementById('live-present-count')?.replaceChildren(document.createTextNode('0'));

            renderEventTable();
            renderDeviceTable();
            renderLogs();
            populateSessionCreateEventSelector();
            populateReportEvents();
            await refreshSessions();
            await refreshLiveAttendance();
            renderDashRecentEvents();
            updateMonitorScanUi();
        } catch (err) {
            console.error(err);
            renderDashboardLoadError(err.message || 'Failed to load.');
            alert(`Failed to load admin data: ${err.message}`);
        }
    })();

    // --- Modals: open/close and delegated table actions (edit/delete event, etc.) ---
    const btnCreateEvent = document.getElementById('btn-create-event');
    const modalCreateEvent = document.getElementById('modal-create-event');
    const btnCreateSession = document.getElementById('btn-create-session');
    const modalCreateSession = document.getElementById('modal-create-session');
    const btnRegisterDevice = document.getElementById('btn-register-device');
    const modalRegisterDevice = document.getElementById('modal-register-device');
    const closeBtns = document.querySelectorAll('.btn-close, .btn-close-modal');

    if (btnCreateEvent) {
        btnCreateEvent.addEventListener('click', () => {
            resetEventModalForCreate();
            modalCreateEvent.classList.add('active');
        });
    }

    document.getElementById('event-table')?.addEventListener('click', (e) => {
        const editBtn = e.target.closest('.action-edit-event');
        const delBtn = e.target.closest('.action-delete-event');
        if (editBtn) {
            const id = parseInt(editBtn.getAttribute('data-event-id'), 10);
            if (Number.isFinite(id)) openEventModalForEdit(id);
            return;
        }
        if (delBtn) {
            const id = parseInt(delBtn.getAttribute('data-event-id'), 10);
            if (!Number.isFinite(id)) return;
            const ev = state.events.find(x => Number(x.id) === id);
            const label = ev?.name || 'this event';
            if (!window.confirm(`Are you sure you want to delete "${label}"?`)) return;
            if (!window.confirm('This will permanently remove all sessions and attendance records tied to this event. This cannot be undone.\n\nDo you want to continue?')) return;
            (async () => {
                try {
                    await apiFetch(`${API.events}/${id}`, { method: 'DELETE' });
                    await refreshEventsFromApi();
                    await refreshSessions();
                    await refreshLiveAttendance();
                    logs.unshift({ time: 'Just now', action: `Deleted event: ${label}.` });
                    renderLogs();
                } catch (err) {
                    alert(`Failed to delete event: ${err.message}`);
                }
            })();
        }
    });

    let deviceSearchDebounceTimer;
    document.getElementById('device-search-input')?.addEventListener('input', () => {
        clearTimeout(deviceSearchDebounceTimer);
        deviceSearchDebounceTimer = setTimeout(() => renderDeviceTable(), 200);
    });

    document.getElementById('device-table')?.addEventListener('click', (e) => {
        const clearBtn = e.target.closest('.action-clear-device');
        const delBtn = e.target.closest('.action-delete-user');
        if (clearBtn) {
            const id = parseInt(clearBtn.getAttribute('data-student-id'), 10);
            if (!Number.isFinite(id)) return;
            const st = state.students.find((x) => Number(x.id) === id);
            const label = st?.name || 'this user';
            if (!st?.mac_address) {
                alert('This user has no MAC address to clear.');
                return;
            }
            if (!window.confirm(`Clear the registered MAC for "${label}"? They will not be auto-marked until a new MAC is saved.`)) return;
            (async () => {
                try {
                    await apiFetch(`/api/students/${id}/clear_mac`, { method: 'POST' });
                    await refreshStudentsFromApi();
                    await refreshLiveAttendance();
                    logs.unshift({ time: 'Just now', action: `Cleared MAC for user: ${label}.` });
                    renderLogs();
                } catch (err) {
                    alert(`Failed to clear MAC: ${err.message}`);
                }
            })();
            return;
        }
        if (delBtn) {
            const id = parseInt(delBtn.getAttribute('data-student-id'), 10);
            if (!Number.isFinite(id)) return;
            const st = state.students.find((x) => Number(x.id) === id);
            const label = st?.name || 'this user';
            if (!window.confirm(`Are you sure you want to delete user "${label}"?`)) return;
            if (!window.confirm('This permanently removes their account and all attendance rows for them. This cannot be undone.\n\nDo you want to continue?')) return;
            (async () => {
                try {
                    await apiFetch(`/api/students/${id}`, { method: 'DELETE' });
                    await refreshStudentsFromApi();
                    await refreshLiveAttendance();
                    logs.unshift({ time: 'Just now', action: `Deleted user: ${label}.` });
                    renderLogs();
                } catch (err) {
                    alert(`Failed to delete user: ${err.message}`);
                }
            })();
        }
    });

    if (btnCreateSession) {
        btnCreateSession.addEventListener('click', () => {
            populateSessionCreateEventSelector();
            const d = new Date();
            const iso = d.toISOString().slice(0, 10);
            const dateEl = document.getElementById('sess-date');
            if (dateEl && !dateEl.value) dateEl.value = iso;
            modalCreateSession?.classList.add('active');
        });
    }

    if (btnRegisterDevice) {
        btnRegisterDevice.addEventListener('click', () => {
            modalRegisterDevice.classList.add('active');
        });
    }

    closeBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const modal = e.target.closest('.modal-overlay');
            if (modal) {
                modal.classList.remove('active');
            }
        });
    });

    document.getElementById('btn-save-event')?.addEventListener('click', async () => {
        const name = document.getElementById('evt-name')?.value?.trim();
        const date = document.getElementById('evt-date')?.value?.trim();
        const venue = document.getElementById('evt-venue')?.value?.trim();
        const eventTime = document.getElementById('evt-time')?.value?.trim();
        const editingRaw = document.getElementById('evt-editing-id')?.value?.trim();
        const editingId = editingRaw ? parseInt(editingRaw, 10) : NaN;
        if (!name) {
            alert('Event name is required.');
            return;
        }
        try {
            const payload = {
                name,
                event_date: date || null,
                event_time: eventTime || null,
                description: venue || null,
            };
            if (Number.isFinite(editingId)) {
                await apiFetch(`${API.events}/${editingId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                logs.unshift({ time: 'Just now', action: `Updated event: ${name}.` });
            } else {
                await apiFetch(API.events, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                logs.unshift({ time: 'Just now', action: `Created event: ${name}.` });
            }
            await refreshEventsFromApi();
            renderLogs();
            modalCreateEvent.classList.remove('active');
            resetEventModalForCreate();
        } catch (err) {
            alert(`Failed to save event: ${err.message}`);
        }
    });

    document.getElementById('btn-save-session')?.addEventListener('click', async () => {
        const eventId = parseInt(document.getElementById('sess-event')?.value || '', 10);
        const kind = document.getElementById('sess-kind')?.value || 'check_in';
        const label = (document.getElementById('sess-label')?.value || '').trim();
        const date = (document.getElementById('sess-date')?.value || '').trim();
        const start = (document.getElementById('sess-start')?.value || '').trim();

        if (!eventId || !date || !start) {
            alert('Event, date, and start time are required.');
            return;
        }
        try {
            await apiFetch(API.sessions, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    event_id: eventId,
                    date,
                    start_time: start,
                    session_kind: kind,
                    session_label: label || null,
                }),
            });
            logs.unshift({ time: 'Just now', action: `Created session (${sessionKindLabel(kind)}).` });
            modalCreateSession?.classList.remove('active');
            await refreshSessions();
            await refreshLiveAttendance();
            renderLogs();
        } catch (err) {
            alert(`Failed to create session: ${err.message}`);
        }
    });

    document.getElementById('btn-save-device')?.addEventListener('click', () => {
        const name = document.getElementById('admin-reg-name').value;
        const studentId = document.getElementById('admin-reg-studentid').value;
        const college = document.getElementById('admin-reg-college').value;
        const course = document.getElementById('admin-reg-course').value;
        const year = document.getElementById('admin-reg-year').value;
        const section = document.getElementById('admin-reg-section').value;
        const mac = document.getElementById('admin-reg-mac').value;

        (async () => {
            try {
                const created = await apiFetch(API.students, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        student_id: studentId,
                        name,
                        course,
                        college,
                        year_level: year,
                        section,
                        mac_address: mac,
                    }),
                });
                if (modalRegisterDevice) modalRegisterDevice.classList.remove('active');
                await refreshStudentsFromApi();
                logs.unshift({ time: 'Just now', action: `Registered user: ${created.student?.name || 'User'}.` });
                renderLogs();
                alert(`Successfully registered ${created.student?.name || 'User'}.`);
            } catch (err) {
                alert(`Registration failed: ${err.message}`);
            }
        })();
    });

    // --- SPECIFIC BUTTON INTERACTIONS ---

    const displayPresent = document.getElementById('live-present-count');

    document.getElementById('btn-start-monitor-scan')?.addEventListener('click', () => {
        startMonitorNetworkScan();
        displayPresent?.classList.add('pulse-animation');
        setTimeout(() => displayPresent?.classList.remove('pulse-animation'), 650);
    });

    document.getElementById('btn-stop-monitor-scan')?.addEventListener('click', () => {
        stopMonitorNetworkScan();
    });

    document.getElementById('active-session-selector')?.addEventListener('change', (e) => {
        const v = parseInt(e.target.value, 10);
        if (!Number.isFinite(v)) return;
        stopMonitorNetworkScan();
        state.activeSessionId = v;
        const open = (state.sessionsAll || []).filter(s => s.status === 'open');
        const active = open.find(s => s.id === v);
        document.getElementById('monitor-active-event')?.replaceChildren(
            document.createTextNode(active?.event_name ? `Active: ${active.event_name}` : 'Active: —')
        );
        setDashActiveEventDisplay(active?.event_name);
        const selEl = e.target;
        selEl.title = selEl.options[selEl.selectedIndex]?.textContent?.trim() || '';
        refreshLiveAttendance().catch(() => {});
    });

    document.getElementById('session-filter')?.addEventListener('change', async () => {
        try {
            await refreshSessions();
        } catch (err) {
            alert(`Failed to load sessions: ${err.message}`);
        }
    });

    document.getElementById('report-event-selector')?.addEventListener('change', async (e) => {
        const id = parseInt(e.target.value, 10);
        if (!Number.isFinite(id)) return;
        try {
            await loadReportForEvent(id);
        } catch (err) {
            renderReportEmpty(`Failed to load report: ${err.message}`);
        }
    });

    document.getElementById('btn-export-pdf')?.addEventListener('click', () => {
        downloadReportPdf();
    });

    document.getElementById('btn-export-csv')?.addEventListener('click', () => {
        downloadReportCsv();
    });
});
