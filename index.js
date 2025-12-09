import { getSidebarHTML, getHeaderHTML } from './components/layout.js';
import { router } from './router.js';
import { loadTimerState, updateTimerButton, handleTimerClick } from './features/timer.js';
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
import { listEmployees } from './features/employeeApi.js';
import { showAssetModal, handleSaveAsset, showDeleteConfirmModal, handleDeleteAsset, handleDeleteAsset as handleAssetDelete } from "./pages/assets.js";
import { renderAssetsPage, fetchAssets } from './pages/assets.js'; // adjust path
import { handleInboxRejectLeave, handleAttendanceRejectReport, handleCompOffReject, handleTimesheetReject } from './pages/shared.js';
import { updateNotificationBadge, handleNotificationBellClick, startNotificationPolling } from './features/notificationApi.js';
import { connectSocket } from './src/socket.js';

const API_BASE_URL =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE_URL)
    ? import.meta.env.VITE_API_BASE_URL
    : 'http://localhost:5000';

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
  } catch (err) {
    console.error('Failed to set up realtime client', err);
  }
};

const THEME_STORAGE_KEY = 'theme';

// Time-based theme selection: light (day), sunset (evening), dark (night)
const getTimeBasedTheme = () => {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'light';      // Morning
  if (hour >= 17 && hour < 20) return 'sunset';    // Evening (warm)
  if (hour >= 20 || hour < 5) return 'dark';       // Night
  return 'light';                                  // Afternoon default
};

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
      // Dark theme → moon icon; Light/sunset → sun icon
      icon.classList.add(theme === 'dark' ? 'fa-moon' : 'fa-sun');
    }
  }
};

const initTheme = () => {
  // Always pick theme from current time when app loads
  const theme = getTimeBasedTheme();
  applyAppTheme(theme);

  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const current = document.body.getAttribute('data-theme') || 'light';
      const nextTheme = current === 'dark' ? 'light' : 'dark';
      applyAppTheme(nextTheme);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
      } catch {
        // ignore storage errors
      }
    });
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
        state.user = parsed.user;
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
                try { localStorage.setItem('auth', JSON.stringify({ authenticated: true, user: state.user })); } catch { }
              }
            }
          } catch { }
        }
      }
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

  const userProfileEl = document.getElementById('user-profile');
  const userMenuEl = document.getElementById('user-menu');
  if (userProfileEl && userMenuEl) {
    userProfileEl.addEventListener('mouseenter', () => {
      userMenuEl.style.display = 'block';
    });
    userProfileEl.addEventListener('mouseleave', () => {
      userMenuEl.style.display = 'none';
    });
  }

  initTheme();

  setupRealtimeCallClient();

  // Set up router and render initial page
  window.addEventListener('hashchange', router);

  // Set default hash if not present and render immediately
  if (!window.location.hash) {
    window.location.hash = '#/';
  }
  router();

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
    // Toggle user dropdown on profile click (handle after logout check)
    if (target.closest("#user-profile")) {
      const menu = document.getElementById("user-menu");
      if (menu) {
        const isOpen = menu.style.display !== "none";
        menu.style.display = isOpen ? "none" : "block";
      }
      return;
    }
    if (target.id === "add-employee-btn") showAddEmployeeModal();
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

  document.body.addEventListener('input', (e) => {
    const target = e.target;
    if (target.id === 'employee-search-input') {
      // Reset to page 1 when filtering
      renderEmployeesPage(target.value, 1);
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