import { API_BASE_URL } from '../config.js';

const BASE_URL = API_BASE_URL.replace(/\/$/, '');

export async function getHolidays() {
  const res = await fetch(`${BASE_URL}/api/holidays`);
  const data = await res.json();
  console.log("📦 API raw data:", data);

  // Handle both cases — with or without 'value'
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.value)) return data.value;
  return [];
}
export async function createHoliday(payload) {
  const res = await fetch(`${BASE_URL}/api/holidays`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || errorData.message || `Failed to create holiday: ${res.status}`);
  }
  return await res.json().catch(() => ({}));
}
export async function updateHoliday(id, payload) {
  const res = await fetch(`${BASE_URL}/api/holidays/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || errorData.message || `Failed to update holiday: ${res.status}`);
  }
  return await res.json().catch(() => ({}));
}
export async function deleteHoliday(id) {
  const res = await fetch(`${BASE_URL}/api/holidays/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("❌ Delete failed:", err);
  } else {
    console.log("🗑️ Holiday deleted:", id);
  }
}
