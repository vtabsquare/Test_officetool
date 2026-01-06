// attendanceRenderer.js - Stateless Frontend Attendance Rendering
// ZERO localStorage, ZERO setInterval for business logic, ZERO timer state ownership
// Frontend ONLY renders what backend tells it - backend is THE source of truth

import { state } from '../state.js';
import { API_BASE_URL } from '../config.js';

const BASE_URL = (API_BASE_URL || 'http://localhost:5000').replace(/\/$/, '');

// ================== CONFIGURATION ==================
const STATUS_REFRESH_INTERVAL_MS = 60000; // Refresh status every 60 seconds
const DISPLAY_UPDATE_INTERVAL_MS = 1000;  // Update display every 1 second (visual only)

// Module state (NOT persisted, reset on page load)
let statusRefreshIntervalId = null;
let displayUpdateIntervalId = null;
let lastStatusResponse = null;
let isInitialized = false;

// ================== CORE PRINCIPLE ==================
// elapsed_display = server_now_utc - last_session_start_utc + total_seconds_today
// This is calculated from backend data, NOT from local timers

// ================== API CALLS ==================

/**
 * Fetch current attendance status from backend.
 * This is THE source of truth for all timer displays.
 */
export async function fetchAttendanceStatus(employeeId) {
    if (!employeeId) return null;
    
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        const url = `${BASE_URL}/api/v2/attendance/status/${employeeId}?timezone=${encodeURIComponent(tz)}`;
        
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });
        
        if (!response.ok) {
            throw new Error(`Status fetch failed: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.success) {
            lastStatusResponse = {
                ...data,
                fetchedAt: Date.now(),
                serverNowAtFetch: new Date(data.server_now_utc).getTime()
            };
            return lastStatusResponse;
        }
        
        return null;
    } catch (error) {
        console.error('[ATTENDANCE-RENDERER] Status fetch error:', error);
        return null;
    }
}

/**
 * Send check-in request to backend.
 * Frontend does NOT start timer - waits for backend confirmation.
 */
export async function performCheckIn(employeeId, location = null) {
    if (!employeeId) {
        throw new Error('Employee ID required');
    }
    
    const payload = {
        employee_id: employeeId,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    };
    
    if (location) {
        payload.location = location;
    }
    
    const response = await fetch(`${BASE_URL}/api/v2/attendance/checkin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    
    const data = await response.json();
    
    if (!response.ok || !data.success) {
        throw new Error(data.message || data.error || 'Check-in failed');
    }
    
    // Update local cache with new status
    lastStatusResponse = {
        success: true,
        server_now_utc: data.server_now_utc,
        has_record: true,
        is_active_session: true,
        timing: {
            checkin_utc: data.checkin_utc,
            last_session_start_utc: data.checkin_utc,
            elapsed_seconds: 0,
            total_seconds_today: data.total_seconds_today || 0
        },
        status: {
            code: data.status_code,
            label: data.status_code === 'P' ? 'Present' : data.status_code === 'HL' ? 'Half Day' : 'Working'
        },
        fetchedAt: Date.now(),
        serverNowAtFetch: new Date(data.server_now_utc).getTime()
    };
    
    // Trigger immediate UI update
    updateTimerDisplay();
    
    return data;
}

/**
 * Send check-out request to backend.
 * Frontend does NOT stop timer - waits for backend confirmation.
 */
export async function performCheckOut(employeeId, location = null) {
    if (!employeeId) {
        throw new Error('Employee ID required');
    }
    
    const payload = {
        employee_id: employeeId,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    };
    
    if (location) {
        payload.location = location;
    }
    
    const response = await fetch(`${BASE_URL}/api/v2/attendance/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    
    const data = await response.json();
    
    if (!response.ok || !data.success) {
        throw new Error(data.message || data.error || 'Check-out failed');
    }
    
    // Update local cache with new status
    lastStatusResponse = {
        success: true,
        server_now_utc: data.server_now_utc,
        has_record: true,
        is_active_session: false,
        timing: {
            checkout_utc: data.checkout_utc,
            total_seconds_today: data.total_seconds_today
        },
        status: {
            code: data.status_code,
            label: data.display?.status_label || data.status_code
        },
        fetchedAt: Date.now(),
        serverNowAtFetch: new Date(data.server_now_utc).getTime()
    };
    
    // Trigger immediate UI update
    updateTimerDisplay();
    
    return data;
}

// ================== DISPLAY CALCULATION ==================

/**
 * Calculate current elapsed seconds based on backend data.
 * This uses local time ONLY for visual interpolation between status refreshes.
 * The base values (server_now, checkin_utc, total_seconds) are from backend.
 */
function calculateCurrentElapsed() {
    if (!lastStatusResponse) {
        return { totalSeconds: 0, isActive: false };
    }
    
    const { is_active_session, timing, fetchedAt, serverNowAtFetch } = lastStatusResponse;
    
    if (!is_active_session) {
        // Not active - return stored total
        return {
            totalSeconds: timing?.total_seconds_today || 0,
            isActive: false
        };
    }
    
    // Active session - calculate elapsed
    const baseSeconds = timing?.total_seconds_today || 0;
    const elapsedAtFetch = timing?.elapsed_seconds || 0;
    
    // Time passed since we fetched status (for visual interpolation only)
    const localNow = Date.now();
    const msSinceFetch = localNow - fetchedAt;
    const secondsSinceFetch = Math.floor(msSinceFetch / 1000);
    
    // Total = base + elapsed at fetch time + seconds since fetch
    const totalSeconds = baseSeconds + elapsedAtFetch + secondsSinceFetch;
    
    return {
        totalSeconds: Math.max(0, totalSeconds),
        isActive: true
    };
}

/**
 * Format seconds to HH:MM:SS display string
 */
function formatTime(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Format seconds to human readable string
 */
function formatDuration(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
}

// ================== UI UPDATES ==================

/**
 * Update the timer display element.
 * Called every second for visual updates, but values derived from backend data.
 */
export function updateTimerDisplay() {
    const timerDisplay = document.getElementById('timer-display');
    const timerBtn = document.getElementById('timer-btn');
    
    if (!timerDisplay && !timerBtn) return;
    
    const { totalSeconds, isActive } = calculateCurrentElapsed();
    const timeString = formatTime(totalSeconds);
    
    if (timerDisplay) {
        timerDisplay.textContent = timeString;
    }
    
    if (timerBtn) {
        if (isActive) {
            timerBtn.classList.remove('check-in');
            timerBtn.classList.add('check-out');
            timerBtn.innerHTML = `<span id="timer-display">${timeString}</span> CHECK OUT`;
        } else {
            timerBtn.classList.remove('check-out');
            timerBtn.classList.add('check-in');
            const displayTime = totalSeconds > 0 ? timeString : '00:00:00';
            timerBtn.innerHTML = `<span id="timer-display">${displayTime}</span> CHECK IN`;
        }
    }
    
    // Update state for other components (but NOT for persistence!)
    if (state.timer) {
        state.timer.displaySeconds = totalSeconds;
        state.timer.isActive = isActive;
    }
}

/**
 * Update the timer button state based on backend status
 */
export function updateTimerButton() {
    updateTimerDisplay();
}

// ================== INITIALIZATION ==================

/**
 * Initialize the attendance renderer.
 * Called on page load - fetches status from backend and starts display updates.
 */
export async function initializeAttendance(employeeId) {
    if (!employeeId) {
        console.warn('[ATTENDANCE-RENDERER] No employee ID provided');
        return;
    }
    
    console.log('[ATTENDANCE-RENDERER] Initializing for employee:', employeeId);
    
    // Clean up any existing intervals
    cleanup();
    
    // Fetch initial status from backend
    const status = await fetchAttendanceStatus(employeeId);
    
    if (status) {
        console.log('[ATTENDANCE-RENDERER] Initial status:', {
            isActive: status.is_active_session,
            totalSeconds: status.timing?.total_seconds_today,
            statusCode: status.status?.code
        });
    }
    
    // Initial display update
    updateTimerDisplay();
    
    // Start display update interval (visual interpolation only)
    displayUpdateIntervalId = setInterval(() => {
        if (lastStatusResponse?.is_active_session) {
            updateTimerDisplay();
        }
    }, DISPLAY_UPDATE_INTERVAL_MS);
    
    // Start status refresh interval (sync with backend)
    statusRefreshIntervalId = setInterval(async () => {
        await fetchAttendanceStatus(employeeId);
        updateTimerDisplay();
    }, STATUS_REFRESH_INTERVAL_MS);
    
    // Listen for visibility changes (tab focus)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            // Tab became visible - refresh from backend
            fetchAttendanceStatus(employeeId).then(() => {
                updateTimerDisplay();
            });
        }
    });
    
    isInitialized = true;
    console.log('[ATTENDANCE-RENDERER] Initialization complete');
}

/**
 * Handle timer button click.
 * Determines whether to check-in or check-out based on backend state.
 */
export async function handleTimerClick() {
    const employeeId = state.user?.id;
    
    if (!employeeId) {
        alert('User not logged in');
        return;
    }
    
    const timerBtn = document.getElementById('timer-btn');
    if (timerBtn) {
        timerBtn.disabled = true;
        timerBtn.style.opacity = '0.7';
    }
    
    try {
        // Get current location (optional, non-blocking)
        let location = null;
        try {
            location = await getGeolocation();
        } catch {
            // Location capture failed - continue without it
        }
        
        // Determine action based on current status
        const isCurrentlyActive = lastStatusResponse?.is_active_session || false;
        
        if (isCurrentlyActive) {
            // Check out
            await performCheckOut(employeeId, location);
            console.log('[ATTENDANCE-RENDERER] Check-out successful');
        } else {
            // Check in
            await performCheckIn(employeeId, location);
            console.log('[ATTENDANCE-RENDERER] Check-in successful');
        }
        
        // Refresh status to ensure sync
        await fetchAttendanceStatus(employeeId);
        updateTimerDisplay();
        
    } catch (error) {
        console.error('[ATTENDANCE-RENDERER] Timer action failed:', error);
        alert(error.message || 'Operation failed. Please try again.');
        
        // Refresh status to show actual state
        await fetchAttendanceStatus(employeeId);
        updateTimerDisplay();
    } finally {
        if (timerBtn) {
            timerBtn.disabled = false;
            timerBtn.style.opacity = '1';
        }
    }
}

/**
 * Get current geolocation (with timeout)
 */
function getGeolocation() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error('Geolocation not supported'));
            return;
        }
        
        const timeout = setTimeout(() => {
            reject(new Error('Geolocation timeout'));
        }, 10000);
        
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                clearTimeout(timeout);
                resolve({
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    accuracy_m: pos.coords.accuracy
                });
            },
            (err) => {
                clearTimeout(timeout);
                reject(err);
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    });
}

/**
 * Clean up intervals and listeners
 */
export function cleanup() {
    if (statusRefreshIntervalId) {
        clearInterval(statusRefreshIntervalId);
        statusRefreshIntervalId = null;
    }
    if (displayUpdateIntervalId) {
        clearInterval(displayUpdateIntervalId);
        displayUpdateIntervalId = null;
    }
    lastStatusResponse = null;
    isInitialized = false;
}

// ================== SOCKET EVENT HANDLER ==================

/**
 * Handle attendance change event from socket.
 * Socket only tells us something changed - we fetch fresh data from backend.
 */
export async function handleAttendanceChanged(data) {
    const employeeId = state.user?.id;
    
    if (!employeeId) return;
    
    // Only refresh if the event is for this employee
    if (data.employee_id && data.employee_id.toUpperCase() !== employeeId.toUpperCase()) {
        return;
    }
    
    console.log('[ATTENDANCE-RENDERER] Attendance changed event, refreshing status');
    
    // Fetch fresh status from backend
    await fetchAttendanceStatus(employeeId);
    updateTimerDisplay();
}

// ================== EXPORTS FOR BACKWARD COMPATIBILITY ==================

// These functions maintain API compatibility with the old timer.js
export const loadTimerState = initializeAttendance;
// updateTimerButton is already exported above

// Get current state for other components
export function getAttendanceState() {
    if (!lastStatusResponse) {
        return {
            isActive: false,
            totalSeconds: 0,
            statusCode: null
        };
    }
    
    const { totalSeconds, isActive } = calculateCurrentElapsed();
    
    return {
        isActive,
        totalSeconds,
        statusCode: lastStatusResponse.status?.code,
        statusLabel: lastStatusResponse.status?.label,
        checkinUtc: lastStatusResponse.timing?.checkin_utc,
        checkoutUtc: lastStatusResponse.timing?.checkout_utc
    };
}

// Check if currently checked in
export function isCheckedIn() {
    return lastStatusResponse?.is_active_session || false;
}

// Get total seconds worked today
export function getTotalSecondsToday() {
    const { totalSeconds } = calculateCurrentElapsed();
    return totalSeconds;
}
