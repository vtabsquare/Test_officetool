import { state } from '../state.js';

const ADMIN_EMP_IDS = ['EMP001'];
const ADMIN_EMAILS = ['bala.t@vtab.com'];

const normalizeRole = (value) => {
  const val = String(value || '').trim().toUpperCase();
  if (val === 'L1' || val === 'L2' || val === 'L3') {
    return val;
  }
  return '';
};

export const getUserAccessContext = () => {
  const role = normalizeRole(state.user?.access_level || state.user?.role);
  const empId = String(state.user?.id || '').trim().toUpperCase();
  const email = String(state.user?.email || '').trim().toLowerCase();

  const isAdminFromFallback = ADMIN_EMP_IDS.includes(empId) || ADMIN_EMAILS.includes(email);
  const isAdminByRole = role === 'L3';
  const isManagerByRole = role === 'L2' || role === 'L3';

  const isAdmin = Boolean(state.user?.is_admin || isAdminByRole || isAdminFromFallback);
  const isManager = Boolean(state.user?.is_manager || isManagerByRole);

  return {
    role: role || (isAdmin ? 'L3' : isManager ? 'L2' : 'L1'),
    empId,
    email,
    isAdmin,
    isManager,
  };
};

export const isAdminUser = () => getUserAccessContext().isAdmin;

export const isManagerOrAdmin = () => {
  const { isAdmin, isManager } = getUserAccessContext();
  return isAdmin || isManager;
};

export const isL3User = () => {
  const { role, isAdmin } = getUserAccessContext();
  if (isAdmin || role === 'L3') return true;
  const designation = String(state.user?.designation || '').trim().toLowerCase();
  if (!designation) return false;
  return designation.includes('hr') || designation.includes('manager');
};
