// features/attendanceSocket.js — Real-time Attendance Timer Sync
// Handles multi-device check-in/check-out synchronization via socket.io

import { io } from 'socket.io-client';
import { state } from '../state.js';
import { updateTimerDisplay, updateTimerButton } from './timer.js';
import { renderMyAttendancePage } from '../pages/attendance.js';

let socket = null;
let isConnected = false;
let syncIntervalId = null;

let serverOffsetMs = 0;

const HALF_DAY_SECONDS = 4 * 3600;
const FULL_DAY_SECONDS = 8 * 3600;

function resolveSocketUrl() {
    // Try environment variables first
    if (typeof import.meta !== 'undefined' && import.meta.env) {
        const envUrl = import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_CHAT_SOCKET_URL;
        if (envUrl) return envUrl;
    }

    // Try window global
    if (typeof window !== 'undefined' && window.SOCKET_BASE_URL) {
        return String(window.SOCKET_BASE_URL);
    }

    // Default to localhost:4000
    return 'https://office-tool-socket.onrender.com';
}

const SOCKET_URL = resolveSocketUrl();

function deriveStatus(totalSeconds) {
    if (totalSeconds >= FULL_DAY_SECONDS) return 'P';
    if (totalSeconds >= HALF_DAY_SECONDS) return 'HL';
    return 'A';
}

/**
 * Initialize the attendance socket connection
 */
export function initAttendanceSocket() {
    if (socket) return socket;

    console.log('[ATTENDANCE-SOCKET] Connecting to:', SOCKET_URL);

    socket = io(SOCKET_URL, {
        transports: ['websocket', 'polling'],
        withCredentials: false,
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
    });

    socket.on('connect', () => {
        isConnected = true;
        console.log('[ATTENDANCE-SOCKET] Connected:', socket.id);

        // Register for attendance updates
        const uid = String(state.user?.id || '').toUpperCase();
        if (uid) {
            socket.emit('attendance:register', { employee_id: uid });
            socket.emit('attendance:request-sync', { employee_id: uid });
        }
    });

    socket.on('connect_error', (err) => {
        console.error('[ATTENDANCE-SOCKET] Connection error:', err?.message || err);
    });

    socket.on('disconnect', (reason) => {
        isConnected = false;
        console.warn('[ATTENDANCE-SOCKET] Disconnected:', reason);
    });

    // Handle timer sync from server (on register or request)
    socket.on('attendance:sync', (data) => {
        console.log('[ATTENDANCE-SOCKET] Received sync:', data);
        handleTimerSync(data);
    });

    // Handle check-in from another device
    socket.on('attendance:started', (data) => {
        console.log('[ATTENDANCE-SOCKET] Received check-in event:', data);
        handleRemoteCheckin(data);
    });

    // Handle check-out from another device
    socket.on('attendance:stopped', (data) => {
        console.log('[ATTENDANCE-SOCKET] Received check-out event:', data);
        handleRemoteCheckout(data);
    });

    // Handle automatic status updates (A -> HL -> P)
    socket.on('attendance:status-update', (data) => {
        console.log('[ATTENDANCE-SOCKET] Received status update:', data);
        handleStatusUpdate(data);
    });

    if (typeof window !== 'undefined') {
        window.attendanceSocket = socket;
        // Periodic sync to keep drift low
        if (syncIntervalId) clearInterval(syncIntervalId);
        syncIntervalId = setInterval(() => {
            requestTimerSync();
        }, 90 * 1000);
        // Sync when tab regains focus
        window.addEventListener('focus', () => {
            requestTimerSync();
        });
    }

    return socket;
}

function updateServerOffset(payload) {
    const serverNow = payload && typeof payload.serverNow === 'number' ? payload.serverNow : null;
    if (serverNow === null) return;

    const localNow = Date.now();
    const measured = serverNow - localNow;

    // Smooth the offset to avoid jitter from network latency.
    // Keep it responsive enough to correct big drift quickly.
    if (Math.abs(serverOffsetMs - measured) > 2000) {
        serverOffsetMs = measured;
    } else {
        serverOffsetMs = Math.round(serverOffsetMs * 0.8 + measured * 0.2);
    }

    state.timer.serverOffsetMs = serverOffsetMs;
}

/**
 * Get the attendance socket instance
 */
export function getAttendanceSocket() {
    return socket;
}

/**
 * Register for attendance updates (call after login)
 */
export function registerForAttendanceUpdates(employeeId) {
    if (!socket || !isConnected) {
        initAttendanceSocket();
    }

    const uid = String(employeeId || state.user?.id || '').toUpperCase();
    if (uid && socket) {
        socket.emit('attendance:register', { employee_id: uid });
        console.log('[ATTENDANCE-SOCKET] Registered for updates:', uid);
    }
}

/**
 * Request current timer state from server
 */
export function requestTimerSync() {
    const uid = String(state.user?.id || '').toUpperCase();
    if (uid && socket && isConnected) {
        socket.emit('attendance:request-sync', { employee_id: uid });
    }
}

/**
 * Emit check-in event to sync across devices
 */
export function emitCheckin(checkinTime, checkinTimestamp, baseSeconds = 0) {
    const uid = String(state.user?.id || '').toUpperCase();
    if (uid && socket && isConnected) {
        socket.emit('attendance:checkin', {
            employee_id: uid,
            checkinTime,
            checkinTimestamp,
            baseSeconds,
        });
    }
}

/**
 * Emit check-out event to sync across devices
 */
export function emitCheckout(checkoutTime, totalSeconds, status) {
    const uid = String(state.user?.id || '').toUpperCase();
    if (uid && socket && isConnected) {
        socket.emit('attendance:checkout', {
            employee_id: uid,
            checkoutTime,
            totalSeconds,
            status,
        });
    }
}

/**
 * Handle timer sync from server
 */
function handleTimerSync(data) {
    updateServerOffset(data);
    const uid = String(state.user?.id || '').toUpperCase();
    if (data.employee_id !== uid) return;

    if (data.isRunning) {
        // Timer is running - sync state
        const serverTimestamp = data.checkinTimestamp;
        const baseSecondsIncoming = typeof data.baseSeconds === 'number' ? data.baseSeconds : 0;
        const existingBase = typeof state.timer.lastDuration === 'number' ? state.timer.lastDuration : 0;
        const baseSeconds = Math.max(0, baseSecondsIncoming, existingBase);

        // Calculate current elapsed based on server timestamp
        const now = Date.now() + (state.timer.serverOffsetMs || 0);
        const elapsedMs = now - serverTimestamp;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);
        const totalSeconds = baseSeconds + elapsedSeconds;

        // Update state
        state.timer.isRunning = true;
        state.timer.startTime = serverTimestamp;
        state.timer.lastDuration = baseSeconds;

        // Start interval if not already running
        if (!state.timer.intervalId) {
            state.timer.intervalId = setInterval(updateTimerDisplay, 1000);
        }

        // Save to localStorage
        const today = new Date();
        const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        try {
            localStorage.setItem(`timerState_${uid}`, JSON.stringify({
                isRunning: true,
                startTime: serverTimestamp,
                date: dateStr,
                mode: 'running',
                durationSeconds: baseSeconds,
            }));
        } catch {}

        updateTimerButton();
        updateTimerDisplay();

        console.log(`[ATTENDANCE-SOCKET] Timer synced: running, totalSeconds=${totalSeconds}`);
    } else {
        // Timer is not running
        if (state.timer.intervalId) {
            clearInterval(state.timer.intervalId);
            state.timer.intervalId = null;
        }
        state.timer.isRunning = false;
        state.timer.startTime = null;
        const incomingTotal = typeof data.totalSeconds === 'number' ? data.totalSeconds : null;
        const existingTotal = typeof state.timer.lastDuration === 'number' ? state.timer.lastDuration : 0;
        // Never downgrade due to late/empty sync payloads.
        state.timer.lastDuration = incomingTotal === null ? existingTotal : Math.max(existingTotal, incomingTotal);

        updateTimerButton();
        updateTimerDisplay();

        console.log('[ATTENDANCE-SOCKET] Timer synced: stopped');
    }
}

/**
 * Handle check-in from another device
 */
function handleRemoteCheckin(data) {
    updateServerOffset(data);
    const uid = String(state.user?.id || '').toUpperCase();
    if (data.employee_id !== uid) return;

    // If we're already running, ignore (we initiated this)
    if (state.timer.isRunning && state.timer.startTime) {
        console.log('[ATTENDANCE-SOCKET] Ignoring remote check-in (already running locally)');
        return;
    }

    const checkinTimestamp = data.checkinTimestamp || Date.now();
    const baseSecondsIncoming = typeof data.baseSeconds === 'number' ? data.baseSeconds : 0;
    const existingBase = typeof state.timer.lastDuration === 'number' ? state.timer.lastDuration : 0;
    const baseSeconds = Math.max(0, baseSecondsIncoming, existingBase);

    // Update state
    state.timer.isRunning = true;
    state.timer.startTime = checkinTimestamp;
    state.timer.lastDuration = baseSeconds;

    // Start interval
    if (state.timer.intervalId) clearInterval(state.timer.intervalId);
    state.timer.intervalId = setInterval(updateTimerDisplay, 1000);

    // Save to localStorage
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    try {
        localStorage.setItem(`timerState_${uid}`, JSON.stringify({
            isRunning: true,
            startTime: checkinTimestamp,
            date: dateStr,
            mode: 'running',
            durationSeconds: baseSeconds,
        }));
    } catch {}

    updateTimerButton();
    updateTimerDisplay();

    console.log('[ATTENDANCE-SOCKET] Remote check-in applied');
}

/**
 * Handle check-out from another device
 */
function handleRemoteCheckout(data) {
    updateServerOffset(data);
    const uid = String(state.user?.id || '').toUpperCase();
    if (data.employee_id !== uid) return;

    // If we're not running, ignore
    if (!state.timer.isRunning) {
        console.log('[ATTENDANCE-SOCKET] Ignoring remote check-out (not running locally)');
        return;
    }

    // Stop timer
    if (state.timer.intervalId) {
        clearInterval(state.timer.intervalId);
        state.timer.intervalId = null;
    }

    state.timer.isRunning = false;
    state.timer.startTime = null;
    const incomingTotal = typeof data.totalSeconds === 'number' ? data.totalSeconds : null;
    const existingTotal = typeof state.timer.lastDuration === 'number' ? state.timer.lastDuration : 0;
    // Never downgrade due to late/empty stopped payloads.
    state.timer.lastDuration = incomingTotal === null ? existingTotal : Math.max(existingTotal, incomingTotal);

    // Update localStorage
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    try {
        localStorage.setItem(`timerState_${uid}`, JSON.stringify({
            isRunning: false,
            startTime: null,
            date: dateStr,
            mode: 'stopped',
            durationSeconds: typeof state.timer.lastDuration === 'number' ? state.timer.lastDuration : 0,
        }));
    } catch {}

    updateTimerButton();
    updateTimerDisplay();

    // Refresh attendance page if visible
    if (window.location.hash === '#/attendance-my') {
        try {
            renderMyAttendancePage();
        } catch {}
    }

    console.log('[ATTENDANCE-SOCKET] Remote check-out applied');
}

/**
 * Handle automatic status updates (A -> HL -> P)
 */
function handleStatusUpdate(data) {
    updateServerOffset(data);
    const uid = String(state.user?.id || '').toUpperCase();
    if (data.employee_id !== uid) return;

    const { totalSeconds, status } = data;

    // Update local attendance state
    const today = new Date();
    const day = today.getDate();
    state.attendanceData[uid] = state.attendanceData[uid] || {};
    state.attendanceData[uid][day] = {
        ...(state.attendanceData[uid][day] || {}),
        day,
        status,
        totalHours: Number((totalSeconds / 3600).toFixed(2)),
        durationSeconds: totalSeconds,
    };

    state.timer.lastAutoStatus = status;

    // Refresh attendance page if visible
    if (window.location.hash === '#/attendance-my') {
        try {
            renderMyAttendancePage();
        } catch {}
    }

    console.log(`[ATTENDANCE-SOCKET] Status auto-updated to ${status} (${totalSeconds}s)`);
}

/**
 * Disconnect the socket
 */
export function disconnectAttendanceSocket() {
    if (socket) {
        socket.disconnect();
        socket = null;
        isConnected = false;
    }
}
