import { getPageContentHTML } from '../utils.js';
import { checkForNewLeaveNotifications } from '../features/notificationApi.js';
import { fetchEmployeeLeaves, fetchPendingLeaves, fetchOnLeaveToday } from '../features/leaveApi.js';
import { listEmployees, listAllEmployees } from '../features/employeeApi.js';
import { getHolidays } from '../features/holidaysApi.js';
import { fetchMonthlyAttendance } from '../features/attendanceApi.js';
import { state } from '../state.js';
import { cachedFetch, TTL, getPageState, cachePageState, clearCacheByPrefix } from '../features/cache.js';
import { isAdminUser } from '../utils/accessControl.js';
import { apiBase } from '../config.js';

const formatDate = (dateStr) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return dateStr;
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

const buildListMarkup = (items, renderItem, emptyText) => {
    if (!items || items.length === 0) {
        return `<p class="placeholder-text">${emptyText}</p>`;
    }
    return `<ul class="mini-list">${items.map(renderItem).join('')}</ul>`;
};

const getUpcomingHolidays = (holidays = []) => {
    const today = new Date();
    return holidays
        .map(h => ({
            name: h.crc6f_holidayname || h.name || h.title || 'Holiday',
            date: h.crc6f_date || h.date || h.holiday_date || h.start_date
        }))
        .filter(h => h.date && new Date(h.date) >= today)
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .slice(0, 3);
};

const getNewJoiners = (employees = []) => {
    return [...employees]
        .filter(emp => emp.doj)
        .sort((a, b) => new Date(b.doj) - new Date(a.doj))
        .slice(0, 3)
        .map(emp => ({
            name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || emp.employee_id,
            designation: emp.designation || '—',
            doj: emp.doj
        }));
};

const getDepartmentSnapshot = (employees = []) => {
    const counts = employees.reduce((acc, emp) => {
        const dept = emp.department || 'Unassigned';
        acc[dept] = (acc[dept] || 0) + 1;
        return acc;
    }, {});
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([dept, total]) => ({ dept, total }));
};

const findDobField = (emp = {}) => Object.keys(emp).find(k => k.toLowerCase().includes('birth'));

const getUpcomingBirthdays = (employees = []) => {
    const today = new Date();
    const upcomingWindow = new Date();
    upcomingWindow.setDate(today.getDate() + 7);
    return employees
        .map(emp => {
            const dobKey = findDobField(emp);
            return {
                name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || emp.employee_id,
                department: emp.department || 'General',
                dob: dobKey ? emp[dobKey] : null
            };
        })
        .filter(emp => {
            if (!emp.dob) return false;
            const dobDate = new Date(emp.dob);
            if (Number.isNaN(dobDate.getTime())) return false;
            const thisYear = new Date(today.getFullYear(), dobDate.getMonth(), dobDate.getDate());
            const nextYear = new Date(today.getFullYear() + 1, dobDate.getMonth(), dobDate.getDate());
            const comparisonDate = thisYear >= today ? thisYear : nextYear;
            return comparisonDate >= today && comparisonDate <= upcomingWindow;
        })
        .slice(0, 3);
};

const normalizeEmployeeId = (value = '') => {
    const raw = String(value || '').trim().toUpperCase();
    if (!raw) return '';
    if (/^EMP\d{3,}$/.test(raw)) return raw;
    if (/^\d+$/.test(raw)) return `EMP${raw.padStart(3, '0')}`;
    return raw;
};

const parseDateSafe = (input) => {
    if (!input) return null;
    if (input instanceof Date && !Number.isNaN(input.getTime())) {
        return input;
    }
    if (typeof input === 'number') {
        const fromNumber = new Date(input);
        return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
    }
    const str = String(input).trim();
    if (!str) return null;

    const parsed = Date.parse(str);
    if (!Number.isNaN(parsed)) {
        return new Date(parsed);
    }

    const matchDMY = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (matchDMY) {
        let [_, dayPart, monthPart, yearPart] = matchDMY;
        let day = parseInt(dayPart, 10);
        let month = parseInt(monthPart, 10);
        let year = parseInt(yearPart, 10);
        if (year < 100) year += 2000;
        if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
            return new Date(year, month - 1, day);
        }
    }

    const matchMDY = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
    if (matchMDY) {
        let [_, monthPart, dayPart, yearPart] = matchMDY;
        let day = parseInt(dayPart, 10);
        let month = parseInt(monthPart, 10);
        let year = parseInt(yearPart, 10);
        if (year < 100) year += 2000;
        if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
            return new Date(year, month - 1, day);
        }
    }

    return null;
};

const extractEmployeeDoj = (employee = {}, fallback = {}) => {
    const candidateFields = [
        'doj',
        'date_of_joining',
        'dateOfJoining',
        'crc6f_doj',
        'crc6f_date_of_joining',
        'crc6f_dateofjoining',
        'crc6f_joiningdate',
        'crc6f_startdate',
        'crc6f_hiredate',
        'crc6f_employmentstartdate',
    ];
    for (const field of candidateFields) {
        const value = employee?.[field];
        if (value) return value;
    }
    for (const field of candidateFields) {
        const value = fallback?.[field];
        if (value) return value;
    }
    if (fallback?.doj || fallback?.date_of_joining || fallback?.dateOfJoining) {
        return fallback.doj || fallback.date_of_joining || fallback.dateOfJoining;
    }
    return null;
};

const findCurrentEmployeeRecord = (employees = [], user = {}, normalizedId = '') => {
    if (normalizedId) {
        const byId = employees.find((emp) => normalizeEmployeeId(emp.employee_id || emp.id) === normalizedId);
        if (byId) return byId;
    }
    const nameKey = String(user.name || '').trim().toLowerCase();
    if (nameKey) {
        const byName = employees.find((emp) => {
            const fullName = `${emp.first_name || ''} ${emp.last_name || ''}`.trim().toLowerCase();
            return fullName && fullName === nameKey;
        });
        if (byName) return byName;
    }
    const emailKey = String(user.email || '').trim().toLowerCase();
    if (emailKey) {
        const byEmail = employees.find(
            (emp) => String(emp.email || '').trim().toLowerCase() === emailKey,
        );
        if (byEmail) return byEmail;
    }
    return null;
};

const buildAttendanceSummary = (records = []) => {
    return records.reduce((acc, rec) => {
        const status = String(rec.status || '').toUpperCase();
        if (status === 'P') acc.present += 1;
        else if (status === 'HL') acc.half += 1;
        else if (status) acc.absent += 1;
        return acc;
    }, { present: 0, half: 0, absent: 0 });
};

const minutesBetween = (checkIn, checkOut) => {
    if (!checkIn || !checkOut) return 0;
    const [h1, m1] = checkIn.split(':').map(Number);
    const [h2, m2] = checkOut.split(':').map(Number);
    if ([h1, m1, h2, m2].some(Number.isNaN)) return 0;
    return (h2 * 60 + m2) - (h1 * 60 + m1);
};

const getWeekStart = (date = new Date()) => {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday
    return new Date(d.setDate(diff));
};

const getWeekEnd = (date = new Date()) => {
    const weekStart = getWeekStart(date);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    return weekEnd;
};

const buildWorkProgressSeries = (records = [], referenceDate = new Date()) => {
    const weekStart = getWeekStart(referenceDate);
    const days = [];
    
    // Get current week (Monday to Sunday)
    for (let i = 0; i <= 6; i++) {
        const day = new Date(weekStart);
        day.setDate(weekStart.getDate() + i);
        days.push(day);
    }
    
    return days.map(day => {
        const match = records.find(rec => Number(rec.day) === day.getDate());
        const minutes = match ? Math.max(0, minutesBetween(match.checkIn, match.checkOut)) : 0;
        const isToday = day.toDateString() === referenceDate.toDateString();
        return {
            label: day.toLocaleDateString(undefined, { weekday: 'short' }),
            value: Number((minutes / 60).toFixed(1)),
            isToday: isToday,
            date: day.getDate()
        };
    });
};

const buildDonutChart = (summary) => {
    const total = Math.max(summary.present + summary.half + summary.absent, 1);
    const presentPct = (summary.present / total) * 100;
    const halfPct = (summary.half / total) * 100;
    const style = `background: conic-gradient(var(--primary-color) 0% ${presentPct}%, #f59e0b ${presentPct}% ${presentPct + halfPct}%, #f87171 ${presentPct + halfPct}% 100%);`;
    return `<div class="donut-chart" style="${style}"><span>${summary.present}</span></div>`;
};

const buildLineChart = (points = []) => {
    if (!points.length || points.every(pt => !pt.value)) {
        return '<p class="placeholder-text">No work logs for the current week.</p>';
    }
    const maxValue = Math.max(...points.map(pt => pt.value), 1);
    const svgPoints = points.map((pt, idx) => {
        const x = points.length === 1 ? 0 : (idx / (points.length - 1)) * 100;
        const y = 100 - ((pt.value / maxValue) * 100);
        return `${x},${y}`;
    }).join(' ');
    const labels = points.map(pt => {
        const isToday = pt.isToday || false;
        const todayClass = isToday ? ' today' : '';
        const todayLabel = isToday ? ' (Today)' : '';
        return `<div class="chart-label${todayClass}"><span>${pt.label}${todayLabel}</span><strong>${pt.value}h</strong></div>`;
    }).join('');
    
    // Add dots for each point, highlight today
    const dots = points.map((pt, idx) => {
        const x = points.length === 1 ? 0 : (idx / (points.length - 1)) * 100;
        const y = 100 - ((pt.value / maxValue) * 100);
        const isToday = pt.isToday || false;
        const dotClass = isToday ? 'dot-today' : 'dot';
        const dotColor = isToday ? 'var(--primary-color)' : '#ffffff';
        return `<circle cx="${x}" cy="${y}" r="3" fill="${dotColor}" stroke="var(--primary-color)" stroke-width="2" class="${dotClass}"/>`;
    }).join('');
    
    return `
        <div class="line-chart">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                <polyline points="${svgPoints}" fill="none" stroke="var(--primary-color)" stroke-width="2" stroke-linecap="round" />
                ${dots}
            </svg>
            <div class="chart-labels">${labels}</div>
        </div>
    `;
};

const fetchPeopleOnLeave = async (employees = []) => {
    const isAdmin = isAdminUser();
    const currentEmpId = String(state.user?.id || '').toUpperCase();
    let sourceEmployees = employees;
    if (!isAdmin) {
        const me = employees.find(emp => String(emp.employee_id || emp.id).toUpperCase() === currentEmpId);
        const myDept = (me?.department || '').trim().toLowerCase();
        sourceEmployees = employees.filter(emp => (emp.department || '').trim().toLowerCase() === myDept);
    }
    const limited = sourceEmployees.slice(0, 50);
    const ids = limited
        .map(emp => String(emp.employee_id || emp.id || '').toUpperCase())
        .filter(id => id && id !== currentEmpId);

    // Prefer aggregated endpoint; fallback to per-employee fetch if it fails
    try {
        const leaves = await fetchOnLeaveToday(ids);
        return leaves.slice(0, 4).map(l => {
            const emp = limited.find(e => String(e.employee_id || e.id || '').toUpperCase() === l.employee_id);
            return {
                name: `${emp?.first_name || ''} ${emp?.last_name || ''}`.trim() || l.employee_id,
                leaveType: l.leave_type || 'Leave',
                range: `${formatDate(l.start_date)} - ${formatDate(l.end_date || l.start_date)}`
            };
        });
    } catch (err) {
        console.warn('⚠️ Falling back to per-employee leave fetch (on-leave-today failed):', err);
    }

    const today = new Date().toISOString().slice(0, 10);
    const results = [];
    for (const emp of limited) {
        const empId = String(emp.employee_id || emp.id || '').toUpperCase();
        if (!empId || empId === currentEmpId) continue;
        try {
            const leaves = await fetchEmployeeLeaves(empId);
            const activeLeave = leaves.find(leave => {
                const status = String(leave.status || '').toLowerCase();
                if (status !== 'approved') return false;
                const start = leave.start_date || leave.crc6f_startdate;
                const end = leave.end_date || leave.crc6f_enddate || start;
                return start && end && start <= today && end >= today;
            });
            if (activeLeave) {
                results.push({
                    name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || emp.employee_id,
                    leaveType: activeLeave.leave_type || 'Leave',
                    range: `${formatDate(activeLeave.start_date)} - ${formatDate(activeLeave.end_date || activeLeave.start_date)}`
                });
            }
        } catch (err) {
            console.warn('⚠️ Failed to fetch leaves for dashboard:', empId, err);
        }
        if (results.length >= 4) break;
    }
    return results;
};

const buildDashboardLayout = (data) => {
    const today = new Date();
    const fallbackWeekStart = getWeekStart(today);
    const fallbackWeekEnd = getWeekEnd(today);
    const weekRange = data.weekRange || `${fallbackWeekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - ${fallbackWeekEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    const greetingName = (data.user?.name || data.user?.first_name || 'there').split(' ')[0];
    const heroStats = [
        { label: 'On leave today', value: data.peopleOnLeave.length },
        { label: 'Pending approvals', value: data.pendingLeaves.length },
        { label: 'Active employees', value: data.totalEmployees }
    ].map(stat => `
        <div class="hero-stat">
            <strong>${stat.value}</strong>
            <span>${stat.label}</span>
        </div>
    `).join('');

    const holidaysMarkup = buildListMarkup(
        data.upcomingHolidays,
        holiday => `
            <li>
                <div>
                    <h4>${holiday.name}</h4>
                    <p>${formatDate(holiday.date)}</p>
                </div>
                <span class="badge">${new Date(holiday.date).toLocaleDateString(undefined, { weekday: 'short' })}</span>
            </li>
        `,
        'No upcoming holidays'
    );

    const joinersMarkup = buildListMarkup(
        data.newJoiners,
        joiner => `
            <li>
                <div>
                    <h4>${joiner.name}</h4>
                    <p>${joiner.designation}</p>
                </div>
                <span>${formatDate(joiner.doj)}</span>
            </li>
        `,
        'No recent joiners'
    );

    const departmentMarkup = buildListMarkup(
        data.departmentSnapshot,
        dept => `
            <li>
                <div>
                    <h4>${dept.dept}</h4>
                    <p>Team members</p>
                </div>
                <span class="badge">${dept.total}</span>
            </li>
        `,
        'No department data available'
    );

    const peopleOnLeaveMarkup = buildListMarkup(
        data.peopleOnLeave,
        person => `
            <li>
                <div>
                    <h4>${person.name}</h4>
                    <p>${person.leaveType}</p>
                </div>
                <span>${person.range}</span>
            </li>
        `,
        'No team members are on leave today'
    );

    const birthdaysMarkup = buildListMarkup(
        data.birthdays,
        bd => `
            <li>
                <div>
                    <h4>${bd.name}</h4>
                    <p>${bd.department}</p>
                </div>
                <span>${formatDate(bd.dob)}</span>
            </li>
        `,
        'No birthdays this week'
    );

    const pendingMarkup = isAdminUser()
        ? buildListMarkup(
            data.pendingLeaves.slice(0, 3),
            leave => `
                <li>
                    <div>
                        <h4>${leave.employee_id}</h4>
                        <p>${leave.leave_type || 'Leave'} • ${formatDate(leave.start_date)} - ${formatDate(leave.end_date)}</p>
                    </div>
                    <span class="status-pill warning">Pending</span>
                </li>
            `,
            'No pending approvals'
        )
        : '<p class="placeholder-text">Approvals are visible to admins only.</p>';

    const attendanceLegend = `
        <div class="attendance-legend">
            <span><i class="dot dot-present"></i> Present (${data.attendanceSummary.present})</span>
            <span><i class="dot dot-half"></i> Half-day (${data.attendanceSummary.half})</span>
            <span><i class="dot dot-absent"></i> Other (${data.attendanceSummary.absent})</span>
        </div>
    `;

    const workProgressMarkup = buildLineChart(data.workProgress);

    return `
        <section class="home-dashboard">
            <div class="dashboard-hero card">
                <div class="dashboard-hero-main">
                    <div>
                        <p class="eyebrow">Workspace overview</p>
                        <h1>Welcome, ${greetingName}!</h1>
                        <p class="muted">Here’s what’s happening across the organization today.</p>
                        <div class="hero-stats">${heroStats}</div>
                        <div class="hero-announcement" id="hero-announcement">
                            <span class="hero-announcement-label">Announcement</span>
                            <span class="hero-announcement-text">No announcements yet.</span>
                        </div>
                    </div>
                </div>
                <aside class="user-scoreboard-card" id="user-scoreboard-card" aria-label="Your workspace stats">
                    <header class="user-scoreboard-header">
                        <div>
                            <p class="scoreboard-eyebrow">Your stats</p>
                            <h3 class="scoreboard-title">Workspace snapshot</h3>
                        </div>
                        <span class="scoreboard-pill">Live</span>
                    </header>
                    <div class="user-scoreboard-body scoreboard-loading">
                        <div class="scoreboard-row">
                            <span class="scoreboard-label">Projects completed</span>
                            <span class="scoreboard-value" data-score-id="projects-completed">--</span>
                        </div>
                        <div class="scoreboard-row">
                            <span class="scoreboard-label">Projects contributed</span>
                            <span class="scoreboard-value" data-score-id="projects-contributed">--</span>
                        </div>
                        <div class="scoreboard-row">
                            <span class="scoreboard-label">Total hours logged</span>
                            <span class="scoreboard-value" data-score-id="hours-logged">--</span>
                        </div>
                        <div class="scoreboard-row">
                            <span class="scoreboard-label">Days employed</span>
                            <span class="scoreboard-value" data-score-id="days-employed">--</span>
                        </div>
                        <div class="scoreboard-active">
                            <div class="scoreboard-active-header">
                                <span class="scoreboard-label">Active project</span>
                                <span class="scoreboard-active-status">
                                    <span class="scoreboard-active-dot"></span>
                                    <span data-score-id="active-status-text">Loading…</span>
                                </span>
                            </div>
                            <div class="scoreboard-active-name" data-score-id="active-project">Detecting activity…</div>
                            <div class="scoreboard-progress-track">
                                <div class="scoreboard-progress-fill" data-score-id="active-progress"></div>
                            </div>
                        </div>
                    </div>
                </aside>
            </div>

            <div class="dashboard-grid">
                <section class="card card-grid-span-2">
                    <header class="card-heading">
                        <div>
                            <p class="eyebrow">Holidays</p>
                            <h3>Upcoming</h3>
                        </div>
                        <button class="ghost-link" onclick="window.location.hash='#/attendance-holidays'">View all</button>
                    </header>
                    ${holidaysMarkup}
                </section>

                <section class="card">
                    <header class="card-heading">
                        <p class="eyebrow">People</p>
                        <h3>New Joiners</h3>
                    </header>
                    ${joinersMarkup}
                </section>

                <section class="card">
                    <header class="card-heading">
                        <p class="eyebrow">Celebrations</p>
                        <h3>Birthdays</h3>
                    </header>
                    ${birthdaysMarkup}
                </section>

                <section class="card">
                    <header class="card-heading">
                        <p class="eyebrow">Teams</p>
                        <h3>Department Snapshot</h3>
                    </header>
                    ${departmentMarkup}
                </section>

                <section class="card">
                    <header class="card-heading">
                        <p class="eyebrow">Attendance</p>
                        <h3>People On Leave</h3>
                    </header>
                    ${peopleOnLeaveMarkup}
                </section>

                <section class="card">
                    <header class="card-heading">
                        <p class="eyebrow">Approvals</p>
                        <h3>Pending Requests</h3>
                    </header>
                    ${pendingMarkup}
                    <button class="ghost-link" onclick="window.location.hash='#/inbox'">Go to Inbox</button>
                </section>

                <section class="card" id="announcements-card">
                    <header class="card-heading">
                        <div>
                            <p class="eyebrow">Workspace</p>
                            <h3>Announcements</h3>
                        </div>
                        <button class="ghost-link" id="announcement-manage-btn" type="button">Manage</button>
                    </header>
                    <div class="announcement-body" id="announcement-body">
                        <p class="placeholder-text">No announcements yet.</p>
                    </div>
                </section>

                <section class="card chart-card">
                    <header class="card-heading">
                        <p class="eyebrow">Attendance</p>
                        <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                            <h3>Overview</h3>
                            <button id="refresh-attendance-btn" class="btn btn-sm btn-outline" style="padding: 0.25rem 0.75rem; font-size: 0.875rem;">
                                <i class="fa-solid fa-refresh"></i> Refresh
                            </button>
                        </div>
                    </header>
                    <div class="chart-row">
                        ${buildDonutChart(data.attendanceSummary)}
                        <div class="chart-meta">
                            <h4>This month</h4>
                            <p class="muted">Snapshot for your attendance</p>
                            ${attendanceLegend}
                        </div>
                    </div>
                </section>

                <section class="card card-grid-span-2 chart-card">
                    <header class="card-heading">
                        <p class="eyebrow">Productivity</p>
                        <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                            <h3>Work Progress</h3>
                            <span style="font-size: 0.875rem; color: var(--text-secondary);">${weekRange}</span>
                        </div>
                    </header>
                    ${workProgressMarkup}
                </section>

                <section class="card card-grid-span-2" id="recent-notifications-card">
                    <header class="card-heading">
                        <p class="eyebrow">Leaves</p>
                        <h3>Recent updates</h3>
                    </header>
                    <div id="recent-notifications-content">
                        <p class="placeholder-text">Loading recent updates...</p>
                    </div>
                </section>
            </div>
        </section>
    `;
};

const hydrateUserScoreboard = async (data) => {
    try {
        const card = document.getElementById('user-scoreboard-card');
        if (!card) return;
        const bodyEl = card.querySelector('.user-scoreboard-body');
        const getEl = (id) => card.querySelector(`[data-score-id="${id}"]`);

        // Mark card as pending while stats are being hydrated
        card.classList.add('scoreboard-pending');
        if (bodyEl) {
            bodyEl.classList.add('scoreboard-loading');
        }

        const user = data.user || state.user || {};
        const empId = normalizeEmployeeId(data.resolvedEmployeeId || user.id || user.employee_id);
        const empName = String(user.name || '').trim();
        const email = String(user.email || '').trim();

        const doj = extractEmployeeDoj(data.currentEmployee || {}, user);

        const API = apiBase + '/api';
        const today = new Date();
        const endDate = today.toISOString().slice(0, 10);
        const startDate = `${today.getFullYear()}-01-01`;

        const [tasks, logs, projects] = await Promise.all([
            (async () => {
                if (!empId) return [];
                try {
                    const params = new URLSearchParams();
                    params.set('user_id', empId);
                    if (empName) params.set('user_name', empName);
                    if (email) params.set('user_email', email);
                    const res = await fetch(`${API}/my-tasks?${params.toString()}`);
                    const json = await res.json().catch(() => ({}));
                    return res.ok && json.success && Array.isArray(json.tasks) ? json.tasks : [];
                } catch {
                    return [];
                }
            })(),
            (async () => {
                if (!empId) return [];
                try {
                    const url = `${API}/time-tracker/logs?employee_id=${encodeURIComponent(empId)}&start_date=${startDate}&end_date=${endDate}`;
                    const res = await fetch(url);
                    const json = await res.json().catch(() => ({}));
                    return res.ok && json.success && Array.isArray(json.logs) ? json.logs : [];
                } catch {
                    return [];
                }
            })(),
            (async () => {
                if (!empId) return [];
                try {
                    const url = `${API}/employees/${encodeURIComponent(empId)}/projects`;
                    const res = await fetch(url);
                    const json = await res.json().catch(() => ({}));
                    return res.ok && json.success && Array.isArray(json.projects) ? json.projects : [];
                } catch {
                    return [];
                }
            })(),
        ]);

        const totalSeconds = (logs || []).reduce((sum, log) => sum + Number(log.seconds || 0), 0);
        const totalHours = totalSeconds / 3600;

        let daysEmployed = 0;
        if (doj) {
            const dojDate = parseDateSafe(doj);
            if (!Number.isNaN(dojDate.getTime())) {
                const diffMs = today.getTime() - dojDate.getTime();
                if (diffMs > 0) {
                    daysEmployed = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                }
            }
        }

        const allTasks = tasks || [];
        const completedTasks = allTasks.filter(
            (t) => String(t.task_status || '').toLowerCase() === 'completed'
        );
        const projectRows = Array.isArray(projects) ? projects : [];

        const projectsContributed = projectRows.length || new Set(
            (tasks || [])
                .map((t) => t.project_id || t.project || t.project_name || '')
                .filter(Boolean)
        ).size;

        const projectsCompleted = projectRows.filter(
            (p) => String(p.project_status || '').toLowerCase() === 'completed'
        ).length;

        // Prefer project status for active; fallback to tasks in progress
        const activeProject =
            projectRows.find(
                (p) => String(p.project_status || '').toLowerCase() === 'in progress'
            ) || null;

        const activeTask =
            allTasks.find(
                (t) => String(t.task_status || '').toLowerCase() === 'in progress'
            ) || null;

        const activeProjectName =
            (activeProject && (activeProject.project_name || activeProject.project_id)) ||
            (activeTask &&
                (activeTask.project_name || activeTask.project_id || activeTask.task_name)) ||
            'No active project';

        const activePercent = activeProject || activeTask ? 60 : 0;

        const animateNumber = (el, target, opts = {}) => {
            if (!el) return;
            const { duration = 900, decimals = 0, suffix = '' } = opts;
            const from = 0;
            const start = performance.now();

            // Add a subtle pulse while the number animates
            el.classList.add('scoreboard-value-animating');

            const step = (now) => {
                const progress = Math.min(1, (now - start) / duration);
                const value = from + (target - from) * progress;
                const formatted = decimals
                    ? value.toFixed(decimals)
                    : Math.round(value).toString();
                el.textContent = `${formatted}${suffix}`;
                if (progress < 1) {
                    requestAnimationFrame(step);
                } else {
                    // Remove pulse class at the end of the animation
                    el.classList.remove('scoreboard-value-animating');
                }
            };

            requestAnimationFrame(step);
        };

        animateNumber(getEl('projects-completed'), projectsCompleted || 0, {
            duration: 900,
        });
        animateNumber(getEl('projects-contributed'), projectsContributed || 0, {
            duration: 950,
        });
        animateNumber(getEl('hours-logged'), totalHours || 0, {
            duration: 1100,
            decimals: 1,
            suffix: ' h',
        });
        animateNumber(getEl('days-employed'), daysEmployed || 0, {
            duration: 1200,
        });

        const activeNameEl = getEl('active-project');
        const activeStatusTextEl = getEl('active-status-text');
        const activeProgressEl = getEl('active-progress');

        if (activeNameEl) activeNameEl.textContent = activeProjectName;
        if (activeStatusTextEl) {
            if (activeTask) {
                activeStatusTextEl.textContent = 'In progress';
                card.classList.add('scoreboard-has-active');
            } else {
                activeStatusTextEl.textContent = 'Idle';
                card.classList.remove('scoreboard-has-active');
            }
        }
        if (activeProgressEl) {
            const pct = Math.max(0, Math.min(100, activePercent));
            activeProgressEl.style.width = `${pct}%`;
        }

        if (bodyEl) {
            bodyEl.classList.remove('scoreboard-loading');
        }
        card.classList.remove('scoreboard-pending');
    } catch (err) {
        console.warn('User scoreboard hydration failed:', err);
    }
};

const loadDashboardData = async () => {
    const user = state.user || {};
    const employeeIdRaw = String(user.id || user.employee_id || '').trim();
    let resolvedEmployeeId = normalizeEmployeeId(employeeIdRaw);
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth() + 1;
    const weekStart = getWeekStart(today);
    const weekEnd = getWeekEnd(today);
    const weekRange = `${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - ${weekEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;

    // Fetch employees (paged) and full directory in PARALLEL (cached)
    const [employeesResponse, allEmployees] = await Promise.all([
        cachedFetch('employees_list', async () => {
            try {
                return await listEmployees(1, 500);
            } catch (err) {
                console.warn('⚠️ Failed to fetch employees:', err);
                return { items: [] };
            }
        }, TTL.LONG),
        cachedFetch('employees_all', async () => {
            try {
                return await listAllEmployees();
            } catch (err) {
                console.warn('⚠️ Failed to fetch full employee directory:', err);
                return [];
            }
        }, TTL.LONG)
    ]);

    let employees = employeesResponse?.items || [];
    // Merge full list if available
    if (Array.isArray(allEmployees) && allEmployees.length) {
        employees = allEmployees;
    }

    let currentEmployee = findCurrentEmployeeRecord(employees, user, resolvedEmployeeId);
    if ((!resolvedEmployeeId || resolvedEmployeeId === 'EMP000') && currentEmployee?.employee_id) {
        resolvedEmployeeId = normalizeEmployeeId(currentEmployee.employee_id);
    }
    if (resolvedEmployeeId && state?.user) {
        const prevId = normalizeEmployeeId(state.user.id || state.user.employee_id || '');
        if (resolvedEmployeeId !== prevId) {
            state.user = { ...state.user, id: resolvedEmployeeId };
            try {
                localStorage.setItem('auth', JSON.stringify({ authenticated: state.authenticated, user: state.user }));
            } catch { /* ignore */ }
        }
    }

    const [holidays, attendanceRecords, pendingLeaves, peopleOnLeaveData] = await Promise.all([
        cachedFetch('holidays', async () => {
            try {
                return await getHolidays();
            } catch (err) {
                console.warn('⚠️ Failed to fetch holidays:', err);
                return [];
            }
        }, TTL.VERY_LONG),
        resolvedEmployeeId
            ? cachedFetch(`attendance_${resolvedEmployeeId}_${currentYear}_${currentMonth}`, async () => {
                try {
                    return await fetchMonthlyAttendance(resolvedEmployeeId, currentYear, currentMonth, true); // Force refresh for current month
                } catch (err) {
                    console.warn('⚠️ Failed to fetch attendance:', err);
                    return [];
                }
            }, TTL.SHORT) // Use shorter cache for current month (30 seconds)
            : Promise.resolve([]),
        isAdminUser()
            ? cachedFetch('pending_leaves', async () => {
                try {
                    return await fetchPendingLeaves();
                } catch (err) {
                    console.warn('⚠️ Failed to fetch pending leaves:', err);
                    return [];
                }
            }, TTL.SHORT)
            : Promise.resolve([]),
        cachedFetch('people_on_leave', async () => {
            try {
                const empResp = await cachedFetch('employees_list', () => listEmployees(1, 200), TTL.LONG);
                return await fetchPeopleOnLeave(empResp?.items || []);
            } catch (err) {
                console.warn('⚠️ Failed to fetch people on leave:', err);
                return [];
            }
        }, TTL.MEDIUM),
    ]);

    const upcomingHolidays = getUpcomingHolidays(holidays);
    const newJoiners = getNewJoiners(employees);
    const departmentSnapshot = getDepartmentSnapshot(employees);
    const attendanceSummary = buildAttendanceSummary(attendanceRecords);
    const workProgress = buildWorkProgressSeries(attendanceRecords, today);
    const birthdays = getUpcomingBirthdays(employees);

    return {
        user,
        resolvedEmployeeId,
        upcomingHolidays,
        newJoiners,
        departmentSnapshot,
        attendanceSummary,
        workProgress,
        peopleOnLeave: peopleOnLeaveData,
        birthdays,
        pendingLeaves,
        totalEmployees: employees.length,
        currentEmployee,
        weekRange,
    };
};

const hydrateAnnouncementsCard = () => {
    const card = document.getElementById('announcements-card');
    if (!card) return;
    const body = card.querySelector('#announcement-body');
    const manageBtn = card.querySelector('#announcement-manage-btn');

    const isAdmin = isAdminUser();
    if (!isAdmin && manageBtn) {
        manageBtn.style.display = 'none';
    }

    const storageKey = 'vtab_dashboard_announcement_v1';
    let announcements = [];
    try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                announcements = parsed;
            } else if (parsed && typeof parsed === 'object' && parsed.message) {
                announcements = [parsed];
            }
        }
    } catch {
        announcements = [];
    }

    const render = () => {
        const heroSlot = document.getElementById('hero-announcement');
        const heroTextEl = heroSlot?.querySelector('.hero-announcement-text');
        const latest = announcements[0] || null;

        if (!latest || !latest.message) {
            if (body) {
                body.innerHTML = '<p class="placeholder-text">No announcements yet.</p>';
            }
            if (heroSlot && heroTextEl) {
                heroSlot.classList.add('hero-announcement-empty');
                heroSlot.classList.remove('hero-announcement-animating');
                heroTextEl.textContent = 'No announcements yet.';
            }
            return;
        }

        if (body) {
            const items = announcements.slice(0, 5).map((ann) => {
                const ts = ann.updatedAt ? new Date(ann.updatedAt) : null;
                const meta = ts
                    ? ts.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                    : '';
                return `
                    <li class="announcement-item">
                        <p class="announcement-message">${ann.message}</p>
                        <div class="announcement-meta">
                            <span class="announcement-author">${ann.author || 'Admin'}</span>
                            ${meta ? `<span class="announcement-time">${meta}</span>` : ''}
                        </div>
                    </li>
                `;
            }).join('');

            body.innerHTML = `<ul class="announcement-list">${items}</ul>`;
        }

        if (heroSlot && heroTextEl) {
            heroSlot.classList.remove('hero-announcement-empty');
            heroSlot.classList.remove('hero-announcement-animating');
            heroSlot.getBoundingClientRect();
            heroSlot.classList.add('hero-announcement-animating');
            heroTextEl.textContent = latest.message;
        }
    };

    render();

    if (isAdmin && manageBtn) {
        manageBtn.addEventListener('click', () => {
            const latest = announcements[0] || null;
            const existing = (latest && latest.message) || '';
            const next = window.prompt('Post a new announcement for everyone:', existing);
            if (next == null) return;
            const trimmed = next.trim();
            if (!trimmed) {
                announcements = [];
                try {
                    localStorage.removeItem(storageKey);
                } catch {}
                render();
                return;
            }

            const entry = {
                message: trimmed,
                updatedAt: new Date().toISOString(),
                author: state?.user?.name || 'Admin',
            };

            announcements.unshift(entry);
            announcements = announcements.slice(0, 10);
            try {
                localStorage.setItem(storageKey, JSON.stringify(announcements));
            } catch {}
            render();
        });
    }
};

const scheduleNotificationRefresh = () => {
    setTimeout(async () => {
        try {
            await checkForNewLeaveNotifications();
            await loadRecentLeaveNotifications();
        } catch (err) {
            console.warn('⚠️ Failed to check notifications:', err);
        }
    }, 600);
};

const setupRefreshButton = () => {
    const refreshBtn = document.getElementById('refresh-attendance-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            refreshBtn.disabled = true;
            refreshBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Refreshing...';
            
            // Clear attendance cache
            const user = state.user || {};
            const employeeId = String(user.id || user.employee_id || '').trim();
            const resolvedEmployeeId = normalizeEmployeeId(employeeId);
            const today = new Date();
            const currentYear = today.getFullYear();
            const currentMonth = today.getMonth() + 1;
            
            if (resolvedEmployeeId) {
                clearCacheByPrefix(`attendance_${resolvedEmployeeId}_${currentYear}_${currentMonth}`);
            }
            
            // Reload dashboard data
            await loadDashboardData();
            await renderHomePage();
            
            refreshBtn.disabled = false;
            refreshBtn.innerHTML = '<i class="fa-solid fa-refresh"></i> Refresh';
        });
    }
};

let _dashboardAutoRefreshId = null;
const setupAutoRefresh = () => {
    // Clear any existing interval to prevent leaks
    if (_dashboardAutoRefreshId) {
        clearInterval(_dashboardAutoRefreshId);
        _dashboardAutoRefreshId = null;
    }
    // Auto-refresh every 5 minutes
    _dashboardAutoRefreshId = setInterval(async () => {
        if (window.location.hash !== '#/' && window.location.hash !== '') return;
        try {
            await loadDashboardData();
            await renderHomePage();
        } catch { }
    }, 5 * 60 * 1000);
};

export const renderHomePage = async () => {
    const appContent = document.getElementById('app-content');
    if (!appContent) return;

    // Check for cached page state for instant re-navigation
    const cachedPage = getPageState('/');
    if (cachedPage) {
        console.log('⚡ Instant load from page cache');
        appContent.innerHTML = cachedPage.html;
        // Re-hydrate interactive elements
        hydrateUserScoreboard(cachedPage.data || {});
        hydrateAnnouncementsCard();
        scheduleNotificationRefresh();
        setupRefreshButton();
        setupAutoRefresh();
        // Refresh data in background (stale-while-revalidate pattern)
        loadDashboardData().then(data => {
            const freshHtml = getPageContentHTML('', buildDashboardLayout(data));
            cachePageState('/', freshHtml, data);
            // Re-apply hydration with fresh data
            hydrateUserScoreboard(data);
            hydrateAnnouncementsCard();
            setupRefreshButton();
            setupAutoRefresh();
        }).catch(() => {});
        return;
    }

    appContent.innerHTML = getPageContentHTML('', `
        <section class="home-dashboard dashboard-skeleton">
            <div class="dashboard-hero card">
                <div class="dashboard-hero-main">
                    <div>
                        <div class="skeleton skeleton-heading-lg"></div>
                        <div class="skeleton skeleton-text" style="margin-top: 0.75rem; width: 60%;"></div>
                    </div>
                    <div class="hero-stats">
                        <div class="hero-stat">
                            <div class="skeleton skeleton-stat-value"></div>
                            <div class="skeleton skeleton-stat-label"></div>
                        </div>
                        <div class="hero-stat">
                            <div class="skeleton skeleton-stat-value"></div>
                            <div class="skeleton skeleton-stat-label"></div>
                        </div>
                        <div class="hero-stat">
                            <div class="skeleton skeleton-stat-value"></div>
                            <div class="skeleton skeleton-stat-label"></div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="dashboard-grid">
                <section class="card">
                    <header class="card-heading">
                        <div>
                            <div class="skeleton skeleton-heading-md"></div>
                            <div class="skeleton skeleton-text" style="margin-top: 0.4rem; width: 70%;"></div>
                        </div>
                        <div class="skeleton skeleton-pill"></div>
                    </header>
                    <div>
                        <div class="skeleton skeleton-list-line-lg"></div>
                        <div class="skeleton skeleton-list-line-sm"></div>
                        <div class="skeleton skeleton-list-line-lg" style="margin-top: 0.75rem;"></div>
                        <div class="skeleton skeleton-list-line-sm"></div>
                    </div>
                </section>

                <section class="card">
                    <header class="card-heading">
                        <div>
                            <div class="skeleton skeleton-heading-md"></div>
                            <div class="skeleton skeleton-text" style="margin-top: 0.4rem; width: 60%;"></div>
                        </div>
                    </header>
                    <div>
                        <div class="skeleton skeleton-list-line-lg"></div>
                        <div class="skeleton skeleton-list-line-sm"></div>
                    </div>
                </section>

                <section class="card">
                    <header class="card-heading">
                        <div>
                            <div class="skeleton skeleton-heading-md"></div>
                            <div class="skeleton skeleton-text" style="margin-top: 0.4rem; width: 60%;"></div>
                        </div>
                    </header>
                    <div>
                        <div class="skeleton skeleton-list-line-lg"></div>
                        <div class="skeleton skeleton-list-line-sm"></div>
                    </div>
                </section>

                <section class="card">
                    <header class="card-heading">
                        <div>
                            <div class="skeleton skeleton-heading-md"></div>
                            <div class="skeleton skeleton-text" style="margin-top: 0.4rem; width: 55%;"></div>
                        </div>
                    </header>
                    <div>
                        <div class="skeleton skeleton-list-line-lg"></div>
                        <div class="skeleton skeleton-list-line-sm"></div>
                    </div>
                </section>
            </div>
        </section>
    `);

    try {
        const dashboardData = await loadDashboardData();
        const renderedHtml = getPageContentHTML('', buildDashboardLayout(dashboardData));
        appContent.innerHTML = renderedHtml;
        // Cache the rendered page for instant re-navigation
        cachePageState('/', renderedHtml, dashboardData);
        hydrateUserScoreboard(dashboardData);
        hydrateAnnouncementsCard();
        scheduleNotificationRefresh();
        setupRefreshButton();
        setupAutoRefresh();
    } catch (error) {
        console.error('❌ Failed to render dashboard:', error);
        appContent.innerHTML = getPageContentHTML('Dashboard', `
            <div class="card error-card">
                <h3>Unable to load dashboard</h3>
                <p class="placeholder-text">Please refresh or try again later.</p>
            </div>
        `);
    }
};

// Load recent leave notifications for dashboard
const loadRecentLeaveNotifications = async () => {
    const notificationsContent = document.getElementById('recent-notifications-content');
    if (!notificationsContent) return;

    try {
        const employeeId = state.user?.id || state.user?.employee_id;
        const email = state.user?.email || '';
        
        if (!employeeId) {
            notificationsContent.innerHTML = '<p class="placeholder-text">Please log in to see notifications</p>';
            return;
        }

        // Skip for admin users - they don't need to see their own leave notifications
        const isAdmin = employeeId.toUpperCase() === 'EMP001' || email.toLowerCase() === 'bala.t@vtab.com';
        if (isAdmin) {
            notificationsContent.innerHTML = '<p class="placeholder-text">Admin dashboard - no personal leave notifications</p>';
            return;
        }

        // Get recent completed leaves (last 7 days)
        const allLeaves = await fetchEmployeeLeaves(employeeId);
        const recentLeaves = allLeaves.filter(leave => {
            const isCompleted = leave.status?.toLowerCase() === 'approved' || leave.status?.toLowerCase() === 'rejected';
            if (!isCompleted) return false;
            
            // Check if leave was updated recently (approximate)
            const leaveDate = new Date(leave.start_date || '1900-01-01');
            const daysSinceLeave = Math.floor((Date.now() - leaveDate.getTime()) / (1000 * 60 * 60 * 24));
            return daysSinceLeave <= 30; // Show leaves from last 30 days
        }).slice(0, 3); // Show only last 3

        if (recentLeaves.length === 0) {
            notificationsContent.innerHTML = '<p class="placeholder-text">No recent leave updates</p>';
            return;
        }

        const notificationItems = recentLeaves.map(leave => {
            const statusIcon = leave.status?.toLowerCase() === 'approved' ? 
                '<i class="fa-solid fa-check-circle success-icon"></i>' : 
                '<i class="fa-solid fa-times-circle danger-icon"></i>';
            
            const statusText = leave.status?.toLowerCase() === 'approved' ? 'Approved' : 'Rejected';
            const statusColor = leave.status?.toLowerCase() === 'approved' ? '#10b981' : '#ef4444';
            
            return `
                <div class="notification-item">
                    ${statusIcon}
                    <div style="flex: 1;">
                        <div class="leave-type">${leave.leave_type}</div>
                        <div class="leave-dates">
                            ${leave.start_date} - ${leave.end_date} • 
                            <span class="leave-status ${leave.status?.toLowerCase() === 'approved' ? 'approved' : 'rejected'}">${statusText}</span>
                        </div>
                        ${leave.rejection_reason ? `
                            <div class="rejection-reason">
                                Reason: ${leave.rejection_reason}
                            </div>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');

        notificationsContent.innerHTML = notificationItems;

    } catch (error) {
        console.error('❌ Error loading recent notifications:', error);
        notificationsContent.innerHTML = '<p class="placeholder-text">Failed to load notifications</p>';
    }
};
