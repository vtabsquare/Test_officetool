import { getSidebarHTML, getHeaderHTML } from './components/layout.js';
import { router } from './router.js';
import { loadTimerState, updateTimerButton, handleTimerClick } from './features/timer.js';
import { initAttendanceSocket, registerForAttendanceUpdates } from './features/attendanceSocket.js';
import { closeModal } from './components/modal.js';
import { showAddEmployeeModal, handleAddEmployee, renderEmployeesPage, showBulkUploadModal, showBulkDeleteModal, handleBulkUpload, showEditEmployeeModal, handleUpdateEmployee, handleDeleteEmployee, handleBulkDeleteConfirm, handleRestoreConfirm } from './pages/employees.js';
import { handleAddIntern } from './pages/interns.js';
import { showApplyLeaveModal, handleApplyLeave, renderLeaveTrackerPage } from './pages/leaveTracker.js';
import { handleEditLeave } from './pages/leaveSettings.js';
import {
  showRequestCompOffModal,
  handleRequestCompOff,
  showEditCompOffBalanceModal,
  handleUpdateCompOffBalance,
} from "./pages/comp_off.js";
import { handleAttendanceNav, renderMyAttendancePage, renderTeamAttendancePage } from './pages/attendance.js';
import { state } from './state.js';
import { listEmployees, listAllEmployees } from './features/employeeApi.js';
import { showAssetModal, handleSaveAsset, showDeleteConfirmModal, handleDeleteAsset, handleDeleteAsset as handleAssetDelete } from "./pages/assets.js";
import { renderAssetsPage, fetchAssets } from './pages/assets.js'; // adjust path
import { handleInboxRejectLeave, handleAttendanceRejectReport, handleCompOffReject, handleTimesheetReject } from './pages/shared.js';
import { updateNotificationBadge, handleNotificationBellClick, startNotificationPolling } from './features/notificationApi.js';
import { connectSocket } from './src/socket.js';
import { initAiAssistant } from './components/AiAssistant.js';
import { deriveRoleInfo } from './utils/accessHelpers.js';

const API_BASE_URL =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE_URL)
    ? import.meta.env.VITE_API_BASE_URL
    : 'http://localhost:5000';

const normalizeApiBase = () => String(API_BASE_URL || 'http://localhost:5000').replace(/\/$/, '');

const THEME_STORAGE_KEY = 'theme';
const THEME_OVERRIDE_KEY = 'theme_override';
let themeAutoTimer = null;

const applyAppTheme = (theme) => {
  const body = document.body;
  body.classList.toggle('dark-theme', theme === 'dark');
  body.classList.toggle('sunset-theme', theme === 'sunset');

  body.setAttribute('data-theme', theme);
  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    const icon = toggle.querySelector('i');
    if (icon) {
      icon.classList.remove('fa-sun', 'fa-moon');
      icon.classList.add(theme === 'dark' ? 'fa-moon' : 'fa-sun');
    }
  }
};

const getTimeBasedTheme = () => {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'light';     // Morning
  if (hour >= 17 && hour < 20) return 'sunset';   // Evening (warm)
  if (hour >= 20 || hour < 5) return 'dark';      // Night
  return 'light';                                 // Afternoon default
};

const startAutoThemeScheduler = (overrideEnabled) => {
  if (themeAutoTimer) {
    clearInterval(themeAutoTimer);
    themeAutoTimer = null;
  }
  if (overrideEnabled) return;
  // Check every minute; switch immediately when crossing threshold
  themeAutoTimer = setInterval(() => {
    const next = getTimeBasedTheme();
    const current = document.body.getAttribute('data-theme') || 'light';
    if (next !== current) {
      applyAppTheme(next);
    }
  }, 60 * 1000);
};

const initTheme = () => {
  // If user manually toggled, honor stored theme; else auto by time
  let theme = 'light';
  let overrideEnabled = false;
  try {
    const storedOverride = localStorage.getItem(THEME_OVERRIDE_KEY);
    overrideEnabled = storedOverride === '1';
    const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    if (overrideEnabled && (storedTheme === 'dark' || storedTheme === 'light' || storedTheme === 'sunset')) {
      theme = storedTheme;
    } else {
      theme = getTimeBasedTheme();
      overrideEnabled = false;
    }
  } catch {}
  applyAppTheme(theme);
  startAutoThemeScheduler(overrideEnabled);

  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const current = document.body.getAttribute('data-theme') || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      applyAppTheme(next);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
        localStorage.setItem(THEME_OVERRIDE_KEY, '1');
      } catch {}
      startAutoThemeScheduler(true);
    });
  }
};

const syncAccessLevelFromServer = async () => {
  const username = String(state.user?.email || state.user?.username || '').trim();
  if (!username) return;
  try {
    const res = await fetch(
      `${normalizeApiBase()}/api/login-accounts/by-username?username=${encodeURIComponent(username)}`
    );
    if (!res.ok) return;
    const data = await res.json();
    const accessLevel = data?.item?.accessLevel;
    if (!data?.success || !accessLevel) return;
    const { role, isAdmin, isManager } = deriveRoleInfo({
      ...state.user,
      access_level: accessLevel,
      role: accessLevel,
    });
    const nextUser = {
      ...state.user,
      role,
      access_level: role,
      is_admin: isAdmin,
      is_manager: isManager,
    };
    const changed =
      state.user.role !== nextUser.role ||
      state.user.is_admin !== nextUser.is_admin ||
      state.user.is_manager !== nextUser.is_manager;
    state.user = nextUser;
    if (changed) {
      try {
        localStorage.setItem('auth', JSON.stringify({ authenticated: true, user: state.user }));
      } catch {}
      try {
        localStorage.setItem('role', role);
      } catch {}
    }
  } catch (err) {
    console.warn('Failed to sync access level with server', err);
  }
};

if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      let urlString = null;
      let isStringInput = false;
      let isRequestInput = false;
      let isURLInput = false;

      if (typeof input === 'string') {
        urlString = input;
        isStringInput = true;
      } else if (input && typeof input === 'object') {
        if (typeof input.url === 'string') {
          urlString = input.url;
          isRequestInput = true;
        } else if (typeof input.href === 'string') {
          urlString = input.href;
          isURLInput = true;
        }
      }

      if (urlString && (urlString.startsWith('http://localhost:5000') || urlString.startsWith('http://127.0.0.1:5000'))) {
        const normalizedBase = String(API_BASE_URL || 'http://localhost:5000').replace(/\/$/, '');
        const path = urlString.replace(/^https?:\/\/(localhost|127\.0\.0\.1):5000/, '');
        const resolved = normalizedBase + path;

        if (isStringInput) {
          input = resolved;
        } else if (isURLInput) {
          input.href = resolved;
        } else if (isRequestInput && typeof Request !== 'undefined') {
          input = new Request(resolved, input);
        }
      }
    } catch (e) {
      // ignore rewrite errors and fall back to original fetch
    }
    return originalFetch(input, init);
  };

  try {
    window.API_BASE_URL = API_BASE_URL;
  } catch {
    // ignore if window is not writable
  }
}

// --- EVENT HANDLERS ---

const handleNavClick = (e) => {
  const target = e.target;
  const navLink = target.closest('.nav-link');

  if (navLink) {
    if (navLink.classList.contains('nav-toggle')) {
      e.preventDefault();
      const navGroup = navLink.closest('.nav-group');
      const isCurrentlyOpen = navGroup?.classList.contains('open');
      document.querySelectorAll('.nav-group.open').forEach(group => {
        if (group && group !== navGroup) {
          group.classList.remove('open');
        }
      });
      if (navGroup) {
        navGroup.classList.toggle('open', !isCurrentlyOpen);
      }
    } else {
      // Close any open menus
      document.querySelectorAll('.nav-group.open').forEach(g => g.classList.remove('open'));
      // Set hash for router
      window.location.hash = navLink.getAttribute('href') || '#/'
    }
  }
};

const closeProfilePanel = () => {
  const overlay = document.getElementById('profile-overlay');
  if (!overlay) return;
  const panel = overlay.querySelector('.profile-panel');

  overlay.classList.remove('open');
  panel?.classList.remove('open');
  overlay.classList.add('closing');
  panel?.classList.add('closing');

  const cleanup = () => {
    overlay.removeEventListener('transitionend', cleanup);
    overlay.remove();
  };

  overlay.addEventListener('transitionend', cleanup);
  // Fallback in case transitionend doesn't fire
  setTimeout(() => {
    if (document.getElementById('profile-overlay')) {
      overlay.removeEventListener('transitionend', cleanup);
      overlay.remove();
    }
  }, 400);
};

const profileIcon = (icon, label, value) => {
  if (!value) return '';
  return `
    <div class="profile-detail-item">
      <div class="detail-icon">${icon}</div>
      <div class="detail-copy">
        <span class="detail-label">${label}</span>
        <strong class="detail-value">${value}</strong>
      </div>
    </div>
  `;
};

const renderProfileOverlay = (profile) => {
  const existing = document.getElementById('profile-overlay');
  if (existing) existing.remove();

  const avatarUrl = profile.avatarUrl || profile.photo || '';
  const initials = profile.initials || (profile.name ? profile.name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase() : '');

  const overlay = document.createElement('div');
  overlay.id = 'profile-overlay';
  overlay.className = 'profile-overlay';
  overlay.innerHTML = `
    <div class="profile-panel">
      <div class="profile-panel-header">
        <div class="profile-panel-meta">
          <span class="profile-panel-eyebrow">Profile</span>
          <h2>${profile.name || 'User'}</h2>
          ${profile.designation ? `<p>${profile.designation}</p>` : ''}
        </div>
        <button class="profile-close-btn" aria-label="Close profile panel">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>

      <div class="profile-hero">
        <div class="hero-wave"></div>
        <div class="profile-avatar ${avatarUrl ? 'has-photo' : ''}" ${avatarUrl ? `style="background-image:url('${avatarUrl}')"` : ''}>
          ${avatarUrl ? '' : initials}
        </div>
      </div>

      <div class="profile-panel-body">
        <div class="profile-detail-card">
          <div class="detail-grid">
            ${profileIcon('<i class="fa-solid fa-id-badge"></i>', 'Employee ID', profile.id || profile.employee_id)}
            ${profileIcon('<i class="fa-solid fa-phone"></i>', 'Contact No', profile.contact_number || profile.phone)}
            ${profileIcon('<i class="fa-solid fa-envelope"></i>', 'Email', profile.email)}
            ${profileIcon('<i class="fa-solid fa-location-dot"></i>', 'Address', profile.address || profile.location)}
            ${profileIcon('<i class="fa-solid fa-building"></i>', 'Department', profile.department)}
            ${profileIcon('<i class="fa-solid fa-briefcase"></i>', 'Designation', profile.designation)}
            ${profileIcon('<i class="fa-solid fa-calendar-check"></i>', 'Date of Joining', profile.doj ? new Date(profile.doj).toLocaleDateString() : '')}
          </div>
        </div>
      </div>

      <div class="profile-footer">
        <button id="profile-close-btn" class="btn btn-secondary">Close</button>
      </div>
    </div>
  `;

  overlay.addEventListener('click', (e) => {
    if (e.target.id === 'profile-overlay') {
      closeProfilePanel();
    }
  });
  overlay.querySelector('.profile-close-btn')?.addEventListener('click', closeProfilePanel);
  overlay.querySelector('#profile-close-btn')?.addEventListener('click', closeProfilePanel);

  document.body.appendChild(overlay);

  requestAnimationFrame(() => {
    overlay.classList.add('open');
    overlay.querySelector('.profile-panel')?.classList.add('open');
  });
};

const updateHeaderAvatar = () => {
  const avatarUrl = state?.user?.avatarUrl;
  const headerAvatar = document.querySelector('.user-profile .user-avatar');
  if (!headerAvatar) return;
  if (avatarUrl) {
    headerAvatar.classList.add('has-photo');
    // Force background-image so gradients don't override
    headerAvatar.style.setProperty('background-image', `url('${avatarUrl}')`, 'important');
    headerAvatar.textContent = '';
  } else {
    headerAvatar.classList.remove('has-photo');
    headerAvatar.style.removeProperty('background-image');
    headerAvatar.textContent = (state?.user?.initials || '').trim() || 'U';
  }
};

const openProfilePanel = async () => {
  // Show lightweight loader
  const loaderId = 'profile-loader-toast';
  if (!document.getElementById(loaderId)) {
    const toast = document.createElement('div');
    toast.id = loaderId;
    toast.style.position = 'fixed';
    toast.style.top = '16px';
    toast.style.right = '16px';
    toast.style.padding = '10px 12px';
    toast.style.borderRadius = '6px';
    toast.style.background = 'var(--surface-color)';
    toast.style.color = 'var(--text-primary)';
    toast.style.boxShadow = '0 8px 16px rgba(0,0,0,0.15)';
    toast.textContent = 'Loading profile...';
    document.body.appendChild(toast);
  }

  try {
    const currentId = String(state?.user?.id || '').toUpperCase();
    let profile = { ...(state?.user || {}) };

    // Attempt to hydrate from master employee directory (crc6f_table12s)
    if (currentId) {
      try {
        const employees = await listAllEmployees();
        const match = (employees || []).find(e => String(e.employee_id || e.id || '').toUpperCase() === currentId);
        if (match) {
          const fullName = match.name ||
            [match.first_name, match.last_name].filter(Boolean).join(' ').trim();
          const resolvedPhoto = match.photo || match.avatarUrl || profile.avatarUrl;
          profile = {
            ...profile,
            id: match.employee_id || match.id || profile.id,
            name: fullName || profile.name,
            designation: match.designation || profile.designation,
            email: match.email || profile.email,
            contact_number: match.contact_number || match.contact || profile.contact_number || profile.phone,
            address: match.address || profile.address || match.location,
            department: match.department || profile.department,
            doj: match.doj || profile.doj,
            avatarUrl: resolvedPhoto,
            initials: profile.initials || (fullName ? fullName.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase() : profile.initials),
          };
          // Persist photo to user state for header/avatar reuse
          state.user = { ...(state.user || {}), avatarUrl: resolvedPhoto, name: profile.name, email: profile.email };
          try {
            const authRaw = localStorage.getItem('auth');
            if (authRaw) {
              const parsed = JSON.parse(authRaw);
              if (parsed && parsed.user) {
                parsed.user.avatarUrl = resolvedPhoto;
                localStorage.setItem('auth', JSON.stringify(parsed));
              }
            }
          } catch {}
        }
      } catch (err) {
        console.warn('Failed to load employee profile from master table', err);
      }
    }

    renderProfileOverlay(profile);
  } finally {
    const toast = document.getElementById(loaderId);
    if (toast) toast.remove();
  }

  // Ensure header avatar reflects current state (e.g., newly uploaded photo)
  updateHeaderAvatar();
};

const setupRealtimeCallClient = () => {
  try {
    const user = (state && state.user) || (window.state && window.state.user) || {};
    const rawId = String(user.id || '').trim().toUpperCase();
    const email = String((user.email || user.mail || '') || '').trim().toLowerCase();
    const isAdmin = rawId === 'EMP001' || email === 'bala.t@vtab.com' || !!user.is_admin;
    const roomId = rawId || email || '';
    if (!roomId) return;

    console.log('[MEET-RT] setupRealtimeCallClient user=', user, 'rawId=', rawId, 'email=', email, 'isAdmin=', isAdmin, 'roomId=', roomId);

    const socket = connectSocket(roomId, isAdmin ? 'admin' : 'employee');

    // Expose for Meet page so it can cancel the call via socket.
    try {
      window.__emitMeetCallCancel = (payload) => {
        try {
          socket.emit('call:cancel', payload);
        } catch (e) {
          console.error('[MEET-RT] failed to emit call:cancel', e);
        }
      };
    } catch {}
    let incomingPayload = null;
    let overlay = null;
    let titleEl = null;
    let textEl = null;
    let joinBtn = null;
    let declineBtn = null;
    let audio = null;
    let audioPrimed = false;

    const stopAudio = () => {
      if (audio) {
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch {}
      }
    };

    const primeAudio = () => {
      if (audioPrimed) return;
      audioPrimed = true;
      try {
        const srcBase = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) ? import.meta.env.BASE_URL : '/';
        const src = srcBase.replace(/\/$/, '') + '/ringtone.mp3';
        console.log('[MEET-RT] primeAudio using src', src);
        const a = new Audio(src);
        a.volume = 0;
        a.play().then(() => {
          console.log('[MEET-RT] primeAudio play() succeeded');
          try {
            a.pause();
            a.currentTime = 0;
          } catch {}
        }).catch((err) => {
          console.warn('[MEET-RT] primeAudio play() failed', err);
        });

        try {
          fetch(src)
            .then((res) => {
              console.log('[MEET-RT] ringtone fetch status', res.status);
            })
            .catch((err) => {
              console.warn('[MEET-RT] ringtone fetch failed', err);
            });
        } catch {}
      } catch {}
    };

    try {
      document.body.addEventListener('click', primeAudio, { once: true });
    } catch {}

    const hideOverlay = () => {
      if (overlay) {
        overlay.style.display = 'none';
      }
      incomingPayload = null;
      stopAudio();
    };

    const ensureOverlay = () => {
      if (overlay) return;
      overlay = document.createElement('div');
      overlay.id = 'global-incoming-call';
      overlay.className = 'incoming-call-overlay';
      overlay.style.display = 'none';

      const card = document.createElement('div');
      card.className = 'incoming-call-modal';

      const header = document.createElement('div');
      header.className = 'incoming-call-header';

      const iconWrap = document.createElement('div');
      iconWrap.className = 'incoming-call-icon-wrap';

      const iconSpan = document.createElement('span');
      iconSpan.textContent = '\ud83d\udcde';
      iconWrap.appendChild(iconSpan);

      const textWrap = document.createElement('div');

      titleEl = document.createElement('h2');
      titleEl.className = 'incoming-call-title';
      titleEl.textContent = 'Incoming call';

      textEl = document.createElement('p');
      textEl.className = 'incoming-call-body';
      textEl.textContent = 'You are being invited to join a meeting.';

      textWrap.appendChild(titleEl);
      textWrap.appendChild(textEl);

      header.appendChild(iconWrap);
      header.appendChild(textWrap);

      const btnRow = document.createElement('div');
      btnRow.className = 'incoming-call-actions';

      declineBtn = document.createElement('button');
      declineBtn.type = 'button';
      declineBtn.textContent = 'Decline';
      declineBtn.className = 'incoming-call-btn incoming-call-btn-decline';

      joinBtn = document.createElement('button');
      joinBtn.type = 'button';
      joinBtn.textContent = 'Join';
      joinBtn.className = 'incoming-call-btn incoming-call-btn-join';

      btnRow.appendChild(declineBtn);
      btnRow.appendChild(joinBtn);
      card.appendChild(header);
      card.appendChild(btnRow);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      if (declineBtn) {
        declineBtn.addEventListener('click', () => {
          if (!incomingPayload) {
            hideOverlay();
            return;
          }
          try {
            socket.emit('call:declined', {
              call_id: incomingPayload.call_id,
              employee_id: rawId || null,
              email,
            });
          } catch {}
          hideOverlay();
        });
      }

      if (joinBtn) {
        joinBtn.addEventListener('click', () => {
          if (!incomingPayload) {
            hideOverlay();
            return;
          }
          const link = incomingPayload.meet_url || incomingPayload.html_link;
          try {
            socket.emit('call:accepted', {
              call_id: incomingPayload.call_id,
              employee_id: rawId || null,
              email,
            });
          } catch {}
          hideOverlay();
          if (link) {
            window.open(link, '_blank', 'noopener,noreferrer');
          }
        });
      }
    };

    socket.on('call:ring', (payload) => {
      console.log('[MEET-RT] call:ring received in room', roomId, 'payload=', payload);

      // Do not show the incoming-call popup if this user is the one who initiated the call
      // (i.e., they are on the Meet page AND they are the admin_id of this call)
      try {
        const hash = window.location.hash || '#/';
        const callAdminId = String(payload?.admin_id || '').trim().toUpperCase();
        const currentUserId = roomId.toUpperCase();
        
        // Skip if user is on Meet page AND is the caller (admin who initiated)
        if (hash.startsWith('#/meet') && callAdminId === currentUserId) {
          console.log('[MEET-RT] Skipping call:ring - user is the caller on Meet page');
          return;
        }
      } catch {}
      incomingPayload = payload;
      ensureOverlay();
      if (titleEl) {
        titleEl.textContent = (payload && payload.title) || 'Incoming call';
      }
      if (textEl) {
        textEl.textContent = 'You are being invited to join a Google Meet.';
      }
      if (overlay) {
        overlay.style.display = 'flex';
      }
      try {
        if (!audio) {
          const srcBase = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) ? import.meta.env.BASE_URL : '/';
          const src = srcBase.replace(/\/$/, '') + '/ringtone.mp3';
          console.log('[MEET-RT] creating ringtone audio with src', src);
          audio = new Audio(src);
          audio.loop = true;
        }
        audio.currentTime = 0;
        audio.play()
          .then(() => {
            console.log('[MEET-RT] audio.play() started successfully');
          })
          .catch((err) => {
            console.error('[MEET-RT] audio.play() failed', err);
          });
      } catch (err) {
        console.error('[MEET-RT] unexpected error while playing ringtone', err);
      }
    });

    socket.on('call:participant-update', (payload) => {
      try {
        const hash = window.location.hash || '#/';
        // Only the Meet page uses __onParticipantUpdate to drive the
        // "Call participants" modal. Ignore updates on other pages.
        if (!hash.startsWith('#/meet')) {
          return;
        }
      } catch {}

      const handler = window.__onParticipantUpdate;
      if (typeof handler === 'function') {
        try {
          handler(payload);
        } catch (err) {
          console.error('Participant update handler error', err);
        }
      }
    });

    socket.on('call:cancelled', (payload) => {
      try {
        const cancelledId = payload?.call_id;
        if (incomingPayload && cancelledId && incomingPayload.call_id && String(incomingPayload.call_id) !== String(cancelledId)) {
          return;
        }
      } catch {}
      hideOverlay();
    });
  } catch (err) {
    console.error('Failed to set up realtime client', err);
  }
};

// --- INITIALIZATION ---
const init = async () => {
  // Auth: try restore from localStorage or redirect to standalone login
  try {
    const saved = localStorage.getItem('auth');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.authenticated && parsed.user) {
        state.authenticated = true;
        const { role, isAdmin, isManager } = deriveRoleInfo({
          ...parsed.user,
          designation: parsed.user?.designation,
        });
        state.user = {
          ...parsed.user,
          role,
          access_level: role,
          is_admin: isAdmin,
          is_manager: isManager,
        };
        try {
          localStorage.setItem('role', role);
        } catch {}
        // If saved id looks like an email or not canonical, try to resolve employee_id once
        const idStr = String(state.user.id || '');
        const looksEmail = idStr.includes('@');
        const notEmp = !idStr.toUpperCase().startsWith('EMP');
        if (looksEmail || notEmp) {
          try {
            const all = await listEmployees(1, 5000);
            const emailToMatch = (state.user.email || (looksEmail ? idStr : '')).toLowerCase();
            if (emailToMatch) {
              const match = (all.items || []).find(e => (e.email || '').toLowerCase() === emailToMatch);
              if (match && match.employee_id) {
                state.user.id = match.employee_id;
                // hydrate avatar from employee directory (crc6f_profilepicture)
                if (match.photo) state.user.avatarUrl = match.photo;
                try { localStorage.setItem('auth', JSON.stringify({ authenticated: true, user: state.user })); } catch { }
                // reflect in header immediately
                updateHeaderAvatar();
              }
            }
          } catch { }
        }
      }
    }
    if (state.authenticated) {
      await syncAccessLevelFromServer();
    }
  } catch { }
  if (!state.authenticated) {
    window.location.href = '/login.html';
    return;
  }

  // Expose state globally for compatibility
  window.state = state;

  // Render initial layout
  document.getElementById('sidebar').innerHTML = getSidebarHTML();
  document.getElementById('header').innerHTML = getHeaderHTML(state.user, state.timer);

  const userMenuEl = document.getElementById('user-menu');

  // Apply header avatar (handles stored photo)
  updateHeaderAvatar();

  initTheme();

  // Initialize AI Assistant (global chatbot)
  initAiAssistant();

  setupRealtimeCallClient();

  // Set up router and render initial page
  window.addEventListener('hashchange', router);

  // Set default hash if not present and render immediately
  if (!window.location.hash) {
    window.location.hash = '#/dashboard';
  }
  router();

  // Initialize attendance socket for real-time multi-device sync
  initAttendanceSocket();
  registerForAttendanceUpdates(state.user?.id);

  // Load timer state and update display
  loadTimerState().then(() => {
    updateTimerButton();
  }).catch(err => {
    console.warn('Failed to load timer state:', err);
    updateTimerButton();
  });

  // Start notification polling for real-time updates
  startNotificationPolling();

  // Global event listeners (delegation)
  document.body.addEventListener('click', (e) => {
    const target = e.target;
    if (target.closest("#timer-btn")) handleTimerClick();
    // Explicit logout option
    if (target.closest("#logout-btn")) {
      try {
        localStorage.removeItem("auth");
      } catch { }
      state.authenticated = false;
      state.user = { name: "Guest", initials: "GU", id: "" };
      window.location.href = "/login.html";
      return;
    }
    // Open profile panel (handle before toggling dropdown to avoid early return)
    if (target.closest("#profile-btn")) {
      openProfilePanel();
      const menu = document.getElementById("user-menu");
      if (menu) menu.style.display = "none";
      return;
    }
    // Toggle user dropdown on profile click (handle after logout check)
    if (target.closest("#user-profile")) {
      const menu = document.getElementById("user-menu");
      if (menu) {
        const isOpen = menu.style.display !== "none";
        menu.style.display = isOpen ? "none" : "block";
      }
      return;
    }
    if (target.closest("#add-employee-btn")) showAddEmployeeModal();
    if (target.id === "apply-leave-btn") showApplyLeaveModal();
    if (target.id === "request-compoff-btn") showRequestCompOffModal();
    // Edit Comp Off Balance
    const editCompOffBalanceBtn = target.closest(".edit-compoff-balance-btn");
    if (editCompOffBalanceBtn) {
      const employeeId =
        editCompOffBalanceBtn.getAttribute("data-employee-id");
      if (employeeId) {
        showEditCompOffBalanceModal(employeeId);
      }
    }
    if (target.closest('.nav-link[data-page="assets"]')) {
      e.preventDefault();
      renderAssetsPage(); // show asset table
    }

    // Asset Actions
    // Add Asset
    if (target.id === "add-asset-btn") {
      showAssetModal(); // No ID needed for new asset
    }

    // Edit Asset
    const editAssetBtn = target.closest(".edit-asset-btn");
    if (editAssetBtn) {
      const assetId = editAssetBtn.dataset.id;
      if (assetId) showAssetModal(assetId);
    }

    // Delete Asset
    const deleteAssetBtn = target.closest(".delete-asset-btn");
    if (deleteAssetBtn) {
      const assetId = deleteAssetBtn.dataset.id;
      if (assetId) showDeleteConfirmModal(assetId);
    }

    // Save Asset
    //   if (target.id === "save-asset-btn") {
    //     const assetId = document.getElementById("assetName")?.dataset?.id;
    //     handleSaveAsset(assetId);
    //   }

    // Confirm Delete Asset
    if (target.id === "confirm-delete-btn") {
      const assetId = target.dataset.id;
      if (assetId) handleDeleteAsset(assetId);
    }
    if (target.closest(".modal-close-btn")) closeModal();
    // Employee actions
    const editBtn = target.closest(".emp-edit-btn");
    if (editBtn) {
      const empId = editBtn.getAttribute("data-id");
      if (empId) showEditEmployeeModal(empId);
    }
    const delBtn = target.closest(".emp-delete-btn");
    if (delBtn) {
      const empId = delBtn.getAttribute("data-id");
      if (empId) handleDeleteEmployee(empId);
    }

    // Bulk actions dropdown toggle
    if (
      target.id === "bulk-actions-btn" ||
      target.closest("#bulk-actions-btn")
    ) {
      e.stopPropagation();
      const menu = document.getElementById("bulk-actions-menu");
      if (menu) {
        menu.style.display = menu.style.display === "none" ? "block" : "none";
      }
    }

    // Bulk upload (navigate to full-page view)
    if (
      target.id === "bulk-upload-btn" ||
      target.closest("#bulk-upload-btn")
    ) {
      const menu = document.getElementById("bulk-actions-menu");
      if (menu) menu.style.display = "none";
      window.location.hash = "#/employees/bulk-upload";
    }

    // Bulk delete (navigate to full-page view)
    if (
      target.id === "bulk-delete-btn" ||
      target.closest("#bulk-delete-btn")
    ) {
      const menu = document.getElementById("bulk-actions-menu");
      if (menu) menu.style.display = "none";
      window.location.hash = "#/employees/bulk-delete";
    }

    // Employees pagination
    const prevBtn = target.closest("#emp-prev");
    const nextBtn = target.closest("#emp-next");
    if (prevBtn || nextBtn) {
      const pageStr = (prevBtn || nextBtn).getAttribute("data-target-page");
      const pageNum = pageStr ? parseInt(pageStr, 10) : 1;
      const searchInput = document.getElementById("employee-search-input");
      const filter = searchInput ? searchInput.value : "";
      renderEmployeesPage(filter, pageNum);
    }

    // Leave Tracker pagination
    const leavePrev = target.closest("#leave-prev");
    const leaveNext = target.closest("#leave-next");
    if (leavePrev || leaveNext) {
      const pageStr = (leavePrev || leaveNext).getAttribute(
        "data-target-page"
      );
      const pageNum = pageStr ? parseInt(pageStr, 10) : 1;
      renderLeaveTrackerPage(pageNum, false); // Don't force refresh on pagination
    }

    // Attendance month navigation
    const navBtn = target.closest(".month-nav-btn");
    if (navBtn) {
      const direction = navBtn.getAttribute("data-direction");
      handleAttendanceNav(direction);
      router(); // Re-render the page after updating the date
    }

    // My Attendance day selection
    const dayCell = target.closest(".calendar-day");
    if (dayCell) {
      const day = dayCell.getAttribute("data-day");
      if (day) {
        state.selectedAttendanceDay = parseInt(day, 10);
        renderMyAttendancePage(); // Re-render only the attendance page
      }
    }

    // Team Attendance refresh button
    if (
      target.id === "refresh-team-attendance-btn" ||
      target.closest("#refresh-team-attendance-btn")
    ) {
      e.preventDefault();
      renderTeamAttendancePage();
    }
  });

  document.body.addEventListener('submit', (e) => {
    if (e.target.id === 'modal-form') {
      const form = e.target;
      // Check for buttons WITHIN this form, not in the entire document
      if (form.querySelector("#save-employee-btn")) {
        handleAddEmployee(e);
      } else if (form.querySelector("#save-intern-btn")) {
        handleAddIntern(e);
      } else if (form.querySelector("#update-employee-btn")) {
        handleUpdateEmployee(e);
      } else if (form.querySelector("#submit-leave-btn")) {
        handleApplyLeave(e);
      } else if (form.querySelector("#update-leave-btn")) {
        handleEditLeave(e);
      } else if (form.querySelector("#inbox-submit-reject-btn")) {
        handleInboxRejectLeave(e);
      } else if (form.querySelector("#attendance-submit-reject-btn")) {
        handleAttendanceRejectReport(e);
      } else if (form.querySelector("#compoff-submit-reject-btn")) {
        handleCompOffReject(e);
      } else if (form.querySelector("#timesheet-submit-reject-btn")) {
        handleTimesheetReject(e);
      } else if (form.querySelector("#upload-csv-btn")) {
        handleBulkUpload(e);
      } else if (form.querySelector("#restore-confirm-btn")) {
        // Check restore BEFORE bulk-delete to give it priority
        handleRestoreConfirm(e);
      } else if (form.querySelector("#bulk-delete-confirm-btn")) {
        handleBulkDeleteConfirm(e);
      } else if (form.querySelector("#save-asset-btn")) {
        // Asset Save
        e.preventDefault();
        const assetId =
          document.getElementById("assetName")?.dataset?.id || null;
        handleSaveAsset(assetId);
      } else if (document.getElementById("submit-compoff-btn")) {
        handleRequestCompOff(e);
      } else if (document.getElementById("update-compoff-balance-btn")) {
        handleUpdateCompOffBalance(e);
      }
    }
    // Full-page bulk upload form
    if (e.target.id === 'bulk-upload-form') {
      handleBulkUpload(e);
    }
    // Full-page bulk delete form
    if (e.target.id === 'bulk-delete-form') {
      handleBulkDeleteConfirm(e);
    }
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('bulk-actions-menu');
    const btn = document.getElementById('bulk-actions-btn');
    if (menu && btn && !btn.contains(e.target) && !menu.contains(e.target)) {
      menu.style.display = 'none';
    }
    const userMenu = document.getElementById('user-menu');
    const userProfile = document.getElementById('user-profile');
    if (userMenu && userProfile && !userProfile.contains(e.target) && !userMenu.contains(e.target)) {
      userMenu.style.display = 'none';
    }
  });

  document.getElementById('sidebar').addEventListener('click', handleNavClick);

  // Notification bell click handler
  const notificationBell = document.getElementById('notification-bell');
  if (notificationBell) {
    notificationBell.addEventListener('click', handleNotificationBellClick);
  }

  // Initialize notification badge
  updateNotificationBadge().catch(err => {
    console.warn('⚠️ Failed to initialize notification badge:', err);
  });

  // Auto-hide header on scroll (actions only) and manage sidebar visibility
  let lastScrollTop = 0;
  const pageShell = document.querySelector('.page-shell');
  const headerActions = document.querySelector('.header-actions');
  const headerGreeting = document.querySelector('.header-greeting');
  const appContainer = document.getElementById('app-container');
  const sidebarEl = document.getElementById('sidebar');
  let sidebarHidden = false;

  const isDesktopViewport = () => window.innerWidth >= 1024;

  const setSidebarHidden = (hidden) => {
    if (!appContainer || !sidebarEl) return;
    if (hidden) {
      appContainer.classList.add('sidebar-hidden');
      sidebarHidden = true;
    } else {
      appContainer.classList.remove('sidebar-hidden');
      sidebarHidden = false;
    }
  };

  if (pageShell && (headerActions || headerGreeting)) {

    // On desktop, start with the sidebar hidden and reveal only via left-edge hover.
    // On smaller screens, keep the sidebar visible.
    if (isDesktopViewport()) {
      setSidebarHidden(true);
    } else {
      setSidebarHidden(false);
    }

    pageShell.addEventListener('scroll', () => {
      const scrollTop = pageShell.scrollTop;

      // Hide header greeting and actions on scroll down
      if (scrollTop > lastScrollTop) {
        if (headerActions) {
          headerActions.classList.remove('header-visible');
          headerActions.classList.add('header-hidden');
        }
        if (headerGreeting) {
          headerGreeting.classList.remove('header-visible');
          headerGreeting.classList.add('header-hidden');
        }
      }

      // Show header greeting and actions again when user scrolls back to top
      if (scrollTop === 0) {
        if (headerActions) {
          headerActions.classList.remove('header-hidden');
          headerActions.classList.add('header-visible');
        }
        if (headerGreeting) {
          headerGreeting.classList.remove('header-hidden');
          headerGreeting.classList.add('header-visible');
        }
      }

      lastScrollTop = scrollTop;
    });
  }

  if (sidebarEl && appContainer) {
    // Reveal sidebar when hovering over the collapsed icon rail,
    // and collapse again when moving sufficiently away.
    document.addEventListener('mousemove', (event) => {
      if (!isDesktopViewport()) return;

      const sidebarWidth = sidebarEl.offsetWidth || 280;

      if (sidebarHidden) {
        // When collapsed, expand if cursor is within the visible rail area
        const expandThreshold = sidebarWidth + 8;
        if (event.clientX <= expandThreshold) {
          setSidebarHidden(false);
          return;
        }
      } else {
        // When expanded, collapse once cursor moves far enough away from sidebar
        const hideThreshold = sidebarWidth + 24;
        if (event.clientX > hideThreshold) {
          setSidebarHidden(true);
        }
      }
    });

    // Ensure correct sidebar state when resizing
    window.addEventListener('resize', () => {
      if (!isDesktopViewport()) {
        // On smaller screens, keep sidebar visible and static
        setSidebarHidden(false);
      } else if (sidebarHidden === false) {
        // When entering desktop breakpoint, default to hidden
        setSidebarHidden(true);
      }
    });
  }
};

// Start the application
init();