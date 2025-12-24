export const deriveRoleInfo = (payload = {}) => {
  const normalize = (val = '') => String(val || '').trim().toUpperCase();
  const allowed = new Set(['L1', 'L2', 'L3']);

  let role = normalize(payload.access_level || payload.role);
  if (!allowed.has(role)) {
    if (payload.is_admin) {
      role = 'L3';
    } else if (payload.is_manager) {
      role = 'L2';
    } else {
      const designation = String(payload.designation || '').toLowerCase();
      if (designation.includes('admin') || designation.includes('hr')) {
        role = 'L3';
      } else if (designation.includes('manager')) {
        role = 'L2';
      } else {
        role = 'L1';
      }
    }
  }

  const isAdmin = Boolean(payload.is_admin || role === 'L3');
  const isManager = Boolean(payload.is_manager || role === 'L2' || role === 'L3');

  return { role, isAdmin, isManager };
};
