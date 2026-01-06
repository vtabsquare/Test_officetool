import { isAdminUser, isManagerOrAdmin, isL3User } from './utils/accessControl.js';

// Access denied page for non-admin users
const renderAccessDenied = (redirectPath = '#/') => {
  document.getElementById('app-content').innerHTML = `
    <div class="card" style="padding: 40px; text-align: center;">
      <i class="fa-solid fa-lock" style="font-size: 48px; color: #e74c3c; margin-bottom: 16px;"></i>
      <h2>Access Denied</h2>
      <p>You don't have permission to access this page.</p>
      <p>Only administrators (EMP001) can view team data.</p>
      <button class="btn btn-primary" onclick="window.location.hash='${redirectPath}'" style="margin-top: 16px;">
        <i class="fa-solid fa-arrow-left"></i> Go Back
      </button>
    </div>
  `;
};

const loaders = {
  "/": async () => (await import('./pages/home.js')).renderHomePage,
  "/employees": async () => (await import('./pages/employees.js')).renderEmployeesPage,
  "/interns": async () => (await import('./pages/interns.js')).renderInternsPage,
  "/employees/bulk-upload": async () => (await import('./pages/employees.js')).renderBulkUploadPage,
  "/employees/bulk-delete": async () => (await import('./pages/employees.js')).renderBulkDeletePage,
  "/team-management": async () => (await import('./pages/teamManagement.js')).renderTeamManagementPage,
  "/inbox": async () => (await import('./pages/shared.js')).renderInboxPage,
  "/meet": async () => (await import('./pages/meet_redesign.js')).renderMeetPage,
  "/chat": async () => (await import('./pages/chats.js')).renderChatPage,
  "/time-tracker": async () => (await import('./pages/shared.js')).renderTimeTrackerPage,
  "/time-my-tasks": async () => (await import('./pages/shared.js')).renderMyTasksPage,
  "/time-my-timesheet": async () => (await import('./pages/shared.js')).renderMyTimesheetPage,
  "/time-team-timesheet": async () => (await import('./pages/shared.js')).renderTeamTimesheetPage,
  "/time-clients": async () => (await import('./pages/shared.js')).renderTTClientsPage,
  "/time-projects": async () => (await import('./pages/projects.js')).renderProjectsRoute,
  "/leave-tracker": async () => (await import('./pages/leaveTracker.js')).renderLeaveTrackerPage,
  "/leave-my": async () => (await import('./pages/leaveTracker.js')).renderLeaveTrackerPage,
  "/leave-team": async () => (await import('./pages/leaveTracker.js')).renderLeaveTrackerPage,
  "/leave-settings": async () => (await import('./pages/leaveSettings.js')).renderLeaveSettingsPage,
  "/login-settings": async () => (await import('./pages/loginSettings.js')).renderLoginSettingsPage,
  "/compoff": async () => (await import('./pages/comp_off.js')).renderCompOffPage,
  "/attendance-my": async () => (await import('./pages/attendance.js')).renderMyAttendancePage,
  "/attendance-team": async () => (await import('./pages/attendance.js')).renderTeamAttendancePage,
  "/assets": async () => (await import('./pages/assets.js')).renderAssetsPage,
  "/attendance-holidays": async () => (await import('./pages/holidays.js')).renderHolidaysPage,
  "/onboarding": async () => (await import('./pages/onboarding.js')).renderOnboardingPage,
  "/interns/detail": async () => (await import('./pages/internDetail.js')).renderInternDetailPage,
};

export const router = async () => {
  const full = window.location.hash.slice(1) || '/';
  const path = full.split('?')[0] || '/';

  // If we navigate away from Meet, ensure meet UI artifacts are cleaned up
  if (path !== '/meet') {
    // Call the cleanup function if it exists
    if (typeof window.__cleanupMeetUI === 'function') {
      try { window.__cleanupMeetUI(); } catch (e) { console.warn('cleanupMeetUI error', e); }
    }
    // Also forcefully remove any meet-call-modal from the DOM
    try {
      const modal = document.getElementById('meet-call-modal');
      if (modal) {
        modal.remove();
      }
    } catch (e) {}
  }

  // Special-case intern detail
  if (path.startsWith('/interns/')) {
    const internId = decodeURIComponent(path.substring('/interns/'.length));
    const renderInternDetailPage = await loaders['/interns/detail']();
    await renderInternDetailPage(internId);
    updateActiveNav('/interns');
    return;
  }

  const loadFn = loaders[path] || loaders['/'];
  const renderer = await loadFn();

  // Access checks
  if (path.startsWith('/employees') || path === '/interns' || path === '/team-management') {
    if (!isManagerOrAdmin()) {
      renderAccessDenied("#/");
      return;
    }
  }
  if (path === '/time-team-timesheet' || path === '/time-clients') {
    if (!isManagerOrAdmin()) {
      renderAccessDenied("#/time-my-timesheet");
      return;
    }
  }
  if (path === '/leave-team') {
    if (!isAdminUser()) {
      renderAccessDenied("#/leave-my");
      return;
    }
    window.__leaveViewMode = "team";
  } else if (path === '/leave-my') {
    window.__leaveViewMode = "my";
  }
  if (path === '/login-settings') {
    if (!isAdminUser()) {
      renderAccessDenied("#/");
      return;
    }
  }
  if (path === '/attendance-team') {
    if (!isAdminUser()) {
      renderAccessDenied("#/attendance-my");
      return;
    }
  }
  if (path === '/onboarding') {
    if (!isL3User()) {
      renderAccessDenied("#/");
      return;
    }
  }

  await renderer();
  updateActiveNav(path);
};

const updateActiveNav = (path) => {
  const page = (path === '/') ? 'home' : path.slice(1);

  document.querySelectorAll('.nav-group').forEach((group) => {
    group.classList.remove('open');
    group.querySelector('.nav-toggle')?.classList.remove('active');
  });

  document.querySelectorAll('.nav-link').forEach((linkEl) => {
    const link = linkEl;
    const linkPage = link.dataset.page;
    const isActive = linkPage === page;
    link.classList.toggle('active', isActive);

    if (isActive) {
      const parentGroup = link.closest('.nav-group');
      if (parentGroup) {
        parentGroup.classList.add('open');
        parentGroup.querySelector('.nav-toggle')?.classList.add('active');
      }
    }
  });
};

export const initRouter = () => {
  window.addEventListener('hashchange', router);
  window.addEventListener('load', () => {
    if (!window.location.hash) {
      window.location.hash = '#/';
    }
    router();
  });
};