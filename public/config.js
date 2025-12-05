// Global API configuration for frontend
// Uses Vite env (VITE_API_BASE_URL) in production and falls back to localhost in dev.

export const API_BASE_URL =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE_URL)
    ? import.meta.env.VITE_API_BASE_URL
    : 'http://localhost:5000';

export const apiBase = API_BASE_URL.replace(/\/$/, '');

export const apiUrl = (path = '/') => {
  const p = String(path || '/');
  return apiBase + (p.startsWith('/') ? p : `/${p}`);
};
