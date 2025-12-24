// loginSettings.js - Login Settings page for admin to manage login accounts

import { state } from '../state.js';
import { getPageContentHTML } from '../utils.js';
import { renderModal, closeModal } from '../components/modal.js';
import { listLoginAccounts, createLoginAccount, updateLoginAccount, deleteLoginAccount, fetchLoginEvents, updateLoginActivity } from '../features/loginSettingsApi.js';
import { listAllEmployees } from '../features/employeeApi.js';
import { isAdminUser } from '../utils/accessControl.js';

let currentLoginSettingsView = 'accounts';
let cachedLoginAccounts = [];
let cachedLoginActivitySummary = [];
let loginAccountNameIndex = {};
let cachedEmployeeDirectory = [];

const attachLoginActivityHandlers = (dailySummary = []) => {
    const editButtons = document.querySelectorAll('.la-edit-btn');
    editButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const emp = btn.getAttribute('data-employee-id');
            const dt = btn.getAttribute('data-date');
            const row = dailySummary.find((r) => String(r.employee_id) === String(emp) && String(r.date) === String(dt));
            openEditLoginActivityModal(row);
        });
    });
};

const formatLastLogin = (value) => {
    if (!value) return 'N/A';
    try {
        // If value already looks like ISO, let Date try to parse it
        const d = new Date(value);
        if (!isNaN(d.getTime())) {
            return d.toLocaleString('en-IN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
            });
        }
        return String(value);
    } catch {
        return String(value);
    }
};

const formatTime = (isoString) => {
    if (!isoString) return '-';
    try {
        const d = new Date(isoString);
        if (!isNaN(d.getTime())) {
            return d.toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            });
        }
        return String(isoString);
    } catch {
        return String(isoString);
    }
};

const formatLocation = (loc) => {
    if (!loc) return '<span class="text-muted">Not shared</span>';

    // If backend sent city string directly (legacy)
    if (typeof loc === 'string') {
        return loc ? `📍 ${loc}` : '<span class="text-muted">Not shared</span>';
    }

    // If backend sent detailed object
    const city = loc.city;
    const lat = loc.lat;
    const lng = loc.lng;
    const accuracy = typeof loc.accuracy_m === 'number' ? loc.accuracy_m : null;

    // If accuracy is extremely low (radius > 100km), do not pretend we know exact city
    if (accuracy && accuracy > 100000) {
        return '<span class="text-muted">~ Approximate location (not precise)</span>';
    }

    if (city) {
        return `📍 ${city}`;
    }

    if (lat && lng) {
        const latStr = Number(lat).toFixed(4);
        const lngStr = Number(lng).toFixed(4);
        const accText = accuracy ? ` (±${Math.round(accuracy)}m)` : '';
        return `🌐 ${latStr}, ${lngStr}${accText}`;
    }

    return '<span class="text-muted">Not shared</span>';
};

const normalizeTimeInputToISO = (dateStr, timeStr) => {
    const d = String(dateStr || '').trim();
    const t = String(timeStr || '').trim();
    if (!d || !t) return null;

    // If user pasted an ISO string, accept as-is
    if (t.includes('T') && t.includes('Z')) return t;

    // Accept HH:mm or HH:mm:ss (as local time). Store as UTC ISO for Dataverse.
    const full = t.length === 5 ? `${t}:00` : t;
    const dt = new Date(`${d}T${full}`);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toISOString();
};

const formatISOToTimeInput = (isoString) => {
    if (!isoString) return '';
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
};

const openEditLoginActivityModal = (row) => {
    if (!row) return;
    const formHTML = `
        <div class="modal-form modern-form team-modal">
            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">LOGIN SETTINGS</p>
                        <h3>Edit login activity</h3>
                    </div>
                </div>
                <input type="hidden" id="la-employee-id" value="${row.employee_id || ''}" />
                <input type="hidden" id="la-date" value="${row.date || ''}" />
                <div class="form-grid two-col">
                    <div class="form-field">
                        <label class="form-label">Employee ID</label>
                        <input class="input-control" type="text" value="${row.employee_id || ''}" disabled />
                    </div>
                    <div class="form-field">
                        <label class="form-label">Date</label>
                        <input class="input-control" type="text" value="${row.date || ''}" disabled />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="la-checkin-time">Check-in Time (HH:mm:ss)</label>
                        <input id="la-checkin-time" class="input-control" type="text" placeholder="09:30:00" value="${formatISOToTimeInput(row.check_in_time)}" />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="la-checkin-location">Check-in Location</label>
                        <input id="la-checkin-location" class="input-control" type="text" placeholder="Chennai" value="${row.check_in_location || ''}" />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="la-checkout-time">Check-out Time (HH:mm:ss)</label>
                        <input id="la-checkout-time" class="input-control" type="text" placeholder="18:10:00" value="${formatISOToTimeInput(row.check_out_time)}" />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="la-checkout-location">Check-out Location</label>
                        <input id="la-checkout-location" class="input-control" type="text" placeholder="Chennai" value="${row.check_out_location || ''}" />
                    </div>
                </div>
                <p class="helper-text">Only check-in/out time and location are editable. Employee ID and Date are read-only.</p>
            </div>
        </div>
    `;

    renderModal('Edit Login Activity', formHTML, 'update-login-activity-btn');

    const form = document.getElementById('modal-form');
    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            await handleUpdateLoginActivity();
        };
    }
};

const handleUpdateLoginActivity = async () => {
    try {
        const employee_id = document.getElementById('la-employee-id')?.value?.trim()?.toUpperCase();
        const dateStr = document.getElementById('la-date')?.value?.trim();
        if (!employee_id || !dateStr) return;

        const checkInTimeRaw = document.getElementById('la-checkin-time')?.value;
        const checkOutTimeRaw = document.getElementById('la-checkout-time')?.value;
        const checkInLocation = document.getElementById('la-checkin-location')?.value?.trim() || null;
        const checkOutLocation = document.getElementById('la-checkout-location')?.value?.trim() || null;

        const checkInTimeISO = normalizeTimeInputToISO(dateStr, checkInTimeRaw);
        const checkOutTimeISO = normalizeTimeInputToISO(dateStr, checkOutTimeRaw);

        await updateLoginActivity({
            employee_id,
            date: dateStr,
            check_in_time: checkInTimeISO,
            check_in_location: checkInLocation,
            check_out_time: checkOutTimeISO,
            check_out_location: checkOutLocation,
        });

        closeModal();
        await renderLoginSettingsPage();
    } catch (err) {
        console.error('Error updating login activity:', err);
        alert(err.message || 'Failed to update login activity');
    }
};

const buildLoginAccountNameIndex = (accounts = [], employees = []) => {
    loginAccountNameIndex = {};
    const addToIndex = (id, displayName) => {
        const key = String(id || '').trim().toUpperCase();
        if (!key || loginAccountNameIndex[key]) return;
        const value = String(displayName || '').trim();
        loginAccountNameIndex[key] = value || key;
    };

    (accounts || []).forEach((acc) => {
        const id = acc.employeeId || acc.employee_id || acc.employeeID || acc.employeeid;
        const displayName =
            acc.employeeName ||
            acc.employee_name ||
            acc.employeeFullName ||
            `${acc.firstName || ''} ${acc.lastName || ''}`.trim() ||
            acc.username;
        addToIndex(id, displayName);
    });

    (employees || []).forEach((emp) => {
        const id = emp.employee_id || emp.employeeId || emp.id;
        const displayName =
            emp.full_name ||
            emp.name ||
            `${emp.first_name || ''} ${emp.last_name || ''}`.trim();
        addToIndex(id, displayName);
    });
};

const resolveEmployeeName = (employeeId) => {
    const key = String(employeeId || '').trim().toUpperCase();
    if (!key) return '';
    return loginAccountNameIndex[key] || key;
};

const buildLoginActivityHTML = (dailySummary = []) => {
    if (!dailySummary.length) {
        return `
            <div class="card" style="margin-top: 24px;">
                <h3><i class="fa-solid fa-clock-rotate-left"></i> Login Activity</h3>
                <p class="allocation-description">Track employee check-in/out times and locations.</p>
                <p class="placeholder-text">No login activity recorded yet.</p>
            </div>
        `;
    }

    const rows = dailySummary.map((item) => {
        const employeeName = resolveEmployeeName(item.employee_id);
        return `
        <tr>
            <td>
                <div style="display:flex; flex-direction:column; line-height:1.35;">
                    <span style="font-weight:600; color:#0f172a; font-size:15px;">
                        ${employeeName || item.employee_id || ''}
                    </span>
                    <span style="font-size:12px; color:#6b7280; letter-spacing:0.3px;">
                        ${item.employee_id || ''}
                    </span>
                </div>
            </td>
            <td>${item.date || ''}</td>
            <td>${formatTime(item.check_in_time)}</td>
            <td>${formatLocation(item.check_in_location)}</td>
            <td>${formatTime(item.check_out_time)}</td>
            <td>${formatLocation(item.check_out_location)}</td>
            <td>
                <button class="icon-btn la-edit-btn" title="Edit" data-employee-id="${item.employee_id || ''}" data-date="${item.date || ''}">
                    <i class="fa-solid fa-pen-to-square"></i>
                </button>
            </td>
        </tr>
    `}).join('');

    return `
        <div class="card" style="margin-top: 24px;">
            <h3><i class="fa-solid fa-clock-rotate-left"></i> Login Activity</h3>
            <p class="allocation-description">Track employee check-in/out times and locations.</p>
            <div class="table-container">
                <table class="table">
                    <thead>
                        <tr>
                            <th>Employee ID</th>
                            <th>Date</th>
                            <th>Check-in Time</th>
                            <th>Check-in Location</th>
                            <th>Check-out Time</th>
                            <th>Check-out Location</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                </table>
            </div>
        </div>
    `;
};

const buildTableHTML = (accounts = []) => {
    const rows = accounts.map((acc) => `
        <tr>
            <td>${acc.username || ''}</td>
            <td>${acc.employeeName || ''}</td>
            <td>${acc.accessLevel || ''}</td>
            <td>${formatLastLogin(acc.lastLogin)}</td>
            <td>${typeof acc.loginAttempts === 'number' ? acc.loginAttempts : ''}</td>
            <td>
                <span class="status-badge ${String(acc.userStatus || '').toLowerCase()}">${acc.userStatus || ''}</span>
            </td>
            <td>
                <div class="table-actions">
                    <button class="icon-btn login-edit-btn" title="Edit" data-id="${acc.id}">
                        <i class="fa-solid fa-pen-to-square"></i>
                    </button>
                    <button class="icon-btn login-delete-btn" title="Delete" data-id="${acc.id}">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');

    return `
        <div class="card">
            <h3><i class="fa-solid fa-user-shield"></i> Login Accounts</h3>
            <p class="allocation-description">Manage login access level, status, and attempts for users.</p>
            <div class="table-container">
                <table class="table">
                    <thead>
                        <tr>
                            <th>Username</th>
                            <th>Employee Name</th>
                            <th>Access Level</th>
                            <th>Last Login</th>
                            <th>Login Attempts</th>
                            <th>User Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows || '<tr><td colspan="7" class="placeholder-text">No login accounts found.</td></tr>'}
                    </tbody>
                </table>
            </div>
        </div>
    `;
};

const getLoginSettingsContentHTML = (view, accounts = [], dailySummary = []) => {
    if (view === 'activity') {
        return buildLoginActivityHTML(dailySummary);
    }
    return buildTableHTML(accounts);
};

const buildLoginSettingsLayout = (accounts = [], dailySummary = []) => {
    const sidebarOption = (view, label, icon) => {
        const isActive = currentLoginSettingsView === view;
        return `
            <div class="inbox-category login-settings-view ${isActive ? 'active' : ''}" data-view="${view}">
                <i class="fa-solid ${icon}" style="margin-right:8px;"></i>
                <span>${label}</span>
                <span style="margin-left:auto; font-size:12px; color:#cbd5f5;">
                    ${view === 'accounts' ? accounts.length : dailySummary.length}
                </span>
            </div>
        `;
    };

    return `
        <div class="inbox-container login-settings-layout">
            <div class="inbox-sidebar login-settings-sidebar">
                ${sidebarOption('accounts', 'Login Accounts', 'fa-user-shield')}
                ${sidebarOption('activity', 'Login Activity', 'fa-clock-rotate-left')}
            </div>
            <div class="inbox-content login-settings-content">
                <div class="login-settings-content-body"></div>
            </div>
        </div>
    `;
};

const refreshLoginSettingsContent = () => {
    const container = document.querySelector('.login-settings-content-body');
    if (!container) return;
    container.innerHTML = getLoginSettingsContentHTML(
        currentLoginSettingsView,
        cachedLoginAccounts,
        cachedLoginActivitySummary
    );

    if (currentLoginSettingsView === 'accounts') {
        attachRowHandlers(cachedLoginAccounts);
    } else {
        attachLoginActivityHandlers(cachedLoginActivitySummary);
    }

    const addBtn = document.getElementById('add-login-account-btn');
    if (addBtn) {
        addBtn.style.display = currentLoginSettingsView === 'accounts' ? 'inline-flex' : 'none';
    }
};

const attachLoginSettingsViewHandlers = () => {
    const viewButtons = document.querySelectorAll('.login-settings-view');
    viewButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const targetView = btn.getAttribute('data-view');
            if (!targetView || targetView === currentLoginSettingsView) return;
            currentLoginSettingsView = targetView;
            document
                .querySelectorAll('.login-settings-view')
                .forEach((el) => el.classList.toggle('active', el.getAttribute('data-view') === currentLoginSettingsView));
            refreshLoginSettingsContent();
        });
    });
};

const openAddLoginModal = () => {
    const formHTML = `
        <div class="modal-form modern-form team-modal">
            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">LOGIN SETTINGS</p>
                        <h3>Add login account</h3>
                    </div>
                </div>
                <div class="form-grid two-col">
                    <div class="form-field">
                        <label class="form-label" for="login-username">Username (email)</label>
                        <input id="login-username" class="input-control" type="email" required placeholder="user@company.com" />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="login-employee-name">Employee Name</label>
                        <input id="login-employee-name" class="input-control" type="text" placeholder="Employee Name" />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="login-access-level">Access Level</label>
                        <select id="login-access-level" class="input-control">
                            <option value="L1">L1 - User</option>
                            <option value="L2">L2 - Manager</option>
                            <option value="L3">L3 - Admin</option>
                        </select>
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="login-user-status">User Status</label>
                        <select id="login-user-status" class="input-control">
                            <option value="Active" selected>Active</option>
                            <option value="Locked">Locked</option>
                            <option value="Inactive">Inactive</option>
                        </select>
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="login-attempts">Login Attempts</label>
                        <input id="login-attempts" class="input-control" type="number" min="0" step="1" value="0" />
                    </div>
                </div>
                <p class="helper-text">A default password will be set for new accounts. Users should change it on first login.</p>
            </div>
        </div>
    `;

    renderModal('Add Login Account', formHTML, 'save-login-account-btn');

    const form = document.getElementById('modal-form');
    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            await handleAddLoginAccount();
        };
    }
};

const openEditLoginModal = (account) => {
    if (!account) return;
    const attempts = typeof account.loginAttempts === 'number' ? account.loginAttempts : 0;

    const formHTML = `
        <div class="modal-form modern-form team-modal">
            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">LOGIN SETTINGS</p>
                        <h3>Edit login account</h3>
                    </div>
                </div>
                <input type="hidden" id="login-edit-id" value="${account.id}" />
                <div class="form-grid two-col">
                    <div class="form-field">
                        <label class="form-label">Username</label>
                        <input class="input-control" type="text" value="${account.username || ''}" disabled />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="login-edit-employee-name">Employee Name</label>
                        <input id="login-edit-employee-name" class="input-control" type="text" value="${account.employeeName || ''}" />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="login-edit-access-level">Access Level</label>
                        <select id="login-edit-access-level" class="input-control">
                            <option value="L1" ${account.accessLevel === 'L1' ? 'selected' : ''}>L1 - User</option>
                            <option value="L2" ${account.accessLevel === 'L2' ? 'selected' : ''}>L2 - Manager</option>
                            <option value="L3" ${account.accessLevel === 'L3' ? 'selected' : ''}>L3 - Admin</option>
                        </select>
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="login-edit-user-status">User Status</label>
                        <select id="login-edit-user-status" class="input-control">
                            <option value="Active" ${account.userStatus === 'Active' ? 'selected' : ''}>Active</option>
                            <option value="Locked" ${account.userStatus === 'Locked' ? 'selected' : ''}>Locked</option>
                            <option value="Inactive" ${account.userStatus === 'Inactive' ? 'selected' : ''}>Inactive</option>
                        </select>
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="login-edit-attempts">Login Attempts</label>
                        <input id="login-edit-attempts" class="input-control" type="number" min="0" step="1" value="${attempts}" />
                    </div>
                    <div class="form-field">
                        <label class="form-label">Last Login</label>
                        <input class="input-control" type="text" value="${formatLastLogin(account.lastLogin)}" disabled />
                    </div>
                </div>
            </div>
        </div>
    `;

    renderModal('Edit Login Account', formHTML, 'update-login-account-btn');

    const form = document.getElementById('modal-form');
    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            await handleUpdateLoginAccount();
        };
    }
};

const handleAddLoginAccount = async () => {
    try {
        const username = document.getElementById('login-username')?.value.trim();
        const employeeName = document.getElementById('login-employee-name')?.value.trim();
        const accessLevel = document.getElementById('login-access-level')?.value || 'L1';
        const userStatus = document.getElementById('login-user-status')?.value || 'Active';
        const attemptsRaw = document.getElementById('login-attempts')?.value || '0';
        const loginAttempts = Number.isNaN(Number(attemptsRaw)) ? 0 : Number(attemptsRaw);

        if (!username) {
            alert('Username is required');
            return;
        }

        await createLoginAccount({
            username,
            employee_name: employeeName,
            access_level: accessLevel,
            user_status: userStatus,
            login_attempts: loginAttempts,
        });

        closeModal();
        await renderLoginSettingsPage();
    } catch (err) {
        console.error('Error creating login account:', err);
        alert(err.message || 'Failed to create login account');
    }
};

const handleUpdateLoginAccount = async () => {
    try {
        const id = document.getElementById('login-edit-id')?.value;
        if (!id) return;
        const employeeName = document.getElementById('login-edit-employee-name')?.value.trim();
        const accessLevel = document.getElementById('login-edit-access-level')?.value || 'L1';
        const userStatus = document.getElementById('login-edit-user-status')?.value || 'Active';
        const attemptsRaw = document.getElementById('login-edit-attempts')?.value || '0';
        const loginAttempts = Number.isNaN(Number(attemptsRaw)) ? 0 : Number(attemptsRaw);

        await updateLoginAccount(id, {
            employee_name: employeeName,
            access_level: accessLevel,
            user_status: userStatus,
            login_attempts: loginAttempts,
        });

        closeModal();
        await renderLoginSettingsPage();
    } catch (err) {
        console.error('Error updating login account:', err);
        alert(err.message || 'Failed to update login account');
    }
};

const attachRowHandlers = (accounts) => {
    const editButtons = document.querySelectorAll('.login-edit-btn');
    editButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-id');
            const acc = accounts.find((a) => String(a.id) === String(id));
            openEditLoginModal(acc);
        });
    });

    const deleteButtons = document.querySelectorAll('.login-delete-btn');
    deleteButtons.forEach((btn) => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const acc = accounts.find((a) => String(a.id) === String(id));
            if (!id) return;
            const name = acc?.username || acc?.employeeName || id;
            if (!confirm(`Are you sure you want to delete login for ${name}?`)) return;
            try {
                await deleteLoginAccount(id);
                await renderLoginSettingsPage();
            } catch (err) {
                console.error('Error deleting login account:', err);
                alert(err.message || 'Failed to delete login account');
            }
        });
    });
};

export const renderLoginSettingsPage = async () => {
    console.log('⚙️ Rendering Login Settings Page...');

    if (!isAdminUser()) {
        const content = `
            <div class="card">
                <div class="access-denied-content">
                    <i class="fa-solid fa-lock fa-3x error-icon"></i>
                    <h3 class="error-heading">Access Denied</h3>
                    <p>Login Settings is only accessible to administrators.</p>
                    <p class="access-denied-note">Please contact your administrator if you need access.</p>
                </div>
            </div>
        `;
        document.getElementById('app-content').innerHTML = getPageContentHTML('Login Settings', content);
        return;
    }

    const controls = `
        <div class="employee-controls">
            <div class="employee-control-actions">
                <button id="add-login-account-btn" class="btn btn-primary">
                    <i class="fa-solid fa-plus"></i> ADD LOGIN ACCOUNT
                </button>
            </div>
        </div>
    `;

    const loadingContent = `
        <div class="card">
            <h3><i class="fa-solid fa-user-shield"></i> Login Accounts</h3>
            <p class="placeholder-text">⏳ Loading login accounts...</p>
        </div>
    `;

    document.getElementById('app-content').innerHTML = getPageContentHTML('Login Settings', loadingContent, controls);

    try {
        // Fetch login accounts and login events in parallel
        const [accounts, loginEventsData, employeeDirectory] = await Promise.all([
            listLoginAccounts(),
            fetchLoginEvents().catch(() => ({ daily_summary: [] })),
            listAllEmployees().catch(() => [])
        ]);
        
        cachedLoginAccounts = accounts;
        cachedLoginActivitySummary = loginEventsData.daily_summary || [];
        cachedEmployeeDirectory = employeeDirectory;
        buildLoginAccountNameIndex(cachedLoginAccounts, cachedEmployeeDirectory);

        const layoutHTML = buildLoginSettingsLayout(cachedLoginAccounts, cachedLoginActivitySummary);
        document.getElementById('app-content').innerHTML = getPageContentHTML('Login Settings', layoutHTML, controls);

        const addBtn = document.getElementById('add-login-account-btn');
        if (addBtn) {
            addBtn.onclick = () => {
                openAddLoginModal();
            };
            addBtn.style.display = currentLoginSettingsView === 'accounts' ? 'inline-flex' : 'none';
        }

        attachLoginSettingsViewHandlers();
        refreshLoginSettingsContent();
    } catch (err) {
        console.error('❌ Error loading login settings:', err);
        const errorContent = `
            <div class="card">
                <h3><i class="fa-solid fa-user-shield"></i> Login Accounts</h3>
                <p class="placeholder-text error-message">Error loading login accounts.</p>
            </div>
        `;
        document.getElementById('app-content').innerHTML = getPageContentHTML('Login Settings', errorContent, controls);
    }
};
