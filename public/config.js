// Global API configuration for frontend
// Production: set VITE_API_BASE_URL env var during build
const _host = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
const _isProd = _host === 'officeportal.vtabsquare.com' || _host === '139.59.32.39';
export const API_BASE_URL = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE_URL) || (_isProd ? `${window.location.origin}` : 'http://localhost:5000');
export const apiBase = API_BASE_URL.replace(/\/$/, '');
export const apiUrl = (path = '/') => {
  const p = String(path || '/');
  return apiBase + (p.startsWith('/') ? p : `/${p}`);
};
