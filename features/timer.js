import { state } from '../state.js';
import { checkIn, checkOut } from './attendanceApi.js';
import { API_BASE_URL } from '../config.js';
import { renderMyAttendancePage } from '../pages/attendance.js';

/**
 * Get current geolocation from browser.
 * Returns { lat, lng, accuracy_m } or null if unavailable/denied.
 */
const getGeolocation = () => {
    return new Promise((resolve) => {
        if (!navigator.geolocation) {
            console.log('[TIMER] Geolocation not supported');
            resolve(null);
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const location = {
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    accuracy_m: pos.coords.accuracy,
                    source: 'browser',
                };
                console.log('[TIMER] Geolocation captured:', location);
                resolve(location);
            },
            (err) => {
                console.warn('[TIMER] Geolocation error:', err.message);
                resolve(null);
            },
            { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
        );
    });
};

export const updateTimerDisplay = () => {
    const timerDisplay = document.getElementById('timer-display');
    if (!timerDisplay) return;

    let totalSeconds = 0;
    if (state.timer.isRunning && state.timer.startTime) {
        const elapsed = Math.floor((Date.now() - state.timer.startTime) / 1000);
        const base = typeof state.timer.lastDuration === 'number' ? state.timer.lastDuration : 0;
        totalSeconds = Math.max(0, base + elapsed);
    } else if (typeof state.timer.lastDuration === 'number' && state.timer.lastDuration > 0) {
        totalSeconds = Math.floor(state.timer.lastDuration);
    }

    const seconds = String(totalSeconds % 60).padStart(2, '0');
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    timerDisplay.textContent = `${hours}:${minutes}:${seconds}`;
};

const startTimer = async () => {
    // Capture location before check-in
    const location = await getGeolocation();
    
    // Call backend check-in with location
    try {
        const { record_id, checkin_time, total_seconds_today } = await checkIn(state.user.id, location);
        // Update local timer state only after successful backend check-in
        state.timer.isRunning = true;

        const backendSeconds = Number(total_seconds_today || 0);
        const previousSeconds =
            typeof state.timer.lastDuration === 'number'
                ? state.timer.lastDuration
                : 0;
        // Never shrink the timer: prefer the larger of local paused value and backend total
        const baseSeconds = Math.max(previousSeconds, backendSeconds);

        state.timer.lastDuration = baseSeconds;
        state.timer.startTime = Date.now();
        state.timer.intervalId = setInterval(updateTimerDisplay, 1000);
        try {
            const uid = String(state.user.id || '').toUpperCase();
            const today = new Date();
            const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            const payload = {
                isRunning: true,
                startTime: state.timer.startTime,
                date: dateStr,
                mode: 'running',
                durationSeconds: baseSeconds,
            };
            if (uid) {
                localStorage.setItem(`timerState_${uid}`, JSON.stringify(payload));
            } else {
                localStorage.setItem('timerState', JSON.stringify(payload));
            }
        } catch {}
        updateTimerButton();

        // Update attendance state for today
        const today = new Date();
        const day = today.getDate();
        const uid = state.user.id;
        state.attendanceData[uid] = state.attendanceData[uid] || {};
        state.attendanceData[uid][day] = {
            ...(state.attendanceData[uid][day] || {}),
            day,
            status: 'P',
            checkIn: checkin_time,
            isLate: false,
            isManual: false,
            isPending: false,
        };
        // Only refresh attendance display if user is already on the attendance page
        if (window.location.hash === '#/attendance-my') {
            const { renderMyAttendancePage } = await import('../pages/attendance.js');
            renderMyAttendancePage();
        }
    } catch (e) {
        console.error('Check-in failed:', e);
        alert(`Check-in failed: ${e.message || e}`);
    }
};

const stopTimer = async () => {
    // Capture location before check-out
    const location = await getGeolocation();
    
    // Capture the exact time when the user clicked CHECK OUT
    const clickTime = Date.now();
    const baseBefore =
        typeof state.timer.lastDuration === 'number'
            ? state.timer.lastDuration
            : 0;
    let localElapsed = 0;
    if (state.timer.startTime) {
        localElapsed = Math.max(
            0,
            Math.floor((clickTime - Number(state.timer.startTime)) / 1000)
        );
    }
    const localTotal = baseBefore + localElapsed;

    try {
        const { checkout_time, duration, total_hours, total_seconds_today } = await checkOut(state.user.id, location);
        let backendTotal = 0;

        if (typeof total_seconds_today === 'number' && total_seconds_today > 0) {
            backendTotal = Math.floor(total_seconds_today);
        } else {
            // Fallback: derive an approximate backend total from duration/total_hours if needed
            let candidate = 0;
            if (typeof duration === 'string') {
                const m = duration.match(/(\d+)\s+hour\(s\)\s+(\d+)\s+minute\(s\)/i);
                if (m) {
                    const h = parseInt(m[1], 10) || 0;
                    const mins = parseInt(m[2], 10) || 0;
                    candidate = (h * 3600) + (mins * 60);
                }
            }
            if (typeof total_hours === 'number' && total_hours > 0 && candidate === 0) {
                candidate = Math.floor(total_hours * 3600);
            }
            backendTotal = candidate;
        }

        // Use the larger of local and backend totals so the timer never jumps backwards
        const lastSeconds = Math.max(localTotal, backendTotal || 0);
        if (state.timer.intervalId) clearInterval(state.timer.intervalId);
        state.timer.isRunning = false;
        state.timer.intervalId = null;
        state.timer.startTime = null;
        state.timer.lastDuration = lastSeconds;
        try {
            const uid = String(state.user.id || '').toUpperCase();
            const today = new Date();
            const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            const payload = {
                isRunning: false,
                startTime: null,
                date: dateStr,
                mode: 'stopped',
                durationSeconds: lastSeconds,
            };
            if (uid) {
                localStorage.setItem(`timerState_${uid}`, JSON.stringify(payload));
            } else {
                localStorage.setItem('timerState', JSON.stringify(payload));
            }
        } catch {}
        updateTimerDisplay();
        updateTimerButton();

        // Update attendance state for today
        const today = new Date();
        const day = today.getDate();
        const uid = state.user.id;
        state.attendanceData[uid] = state.attendanceData[uid] || {};
        state.attendanceData[uid][day] = {
            ...(state.attendanceData[uid][day] || {}),
            day,
            status: 'P',
            checkOut: checkout_time,
            totalHours: total_hours,
        };
        // Only refresh attendance display if user is already on the attendance page
        if (window.location.hash === '#/attendance-my') {
            const { renderMyAttendancePage } = await import('../pages/attendance.js');
            await renderMyAttendancePage();
        }
    } catch (e) {
        console.error('Check-out failed:', e);
        alert(`Check-out failed: ${e.message || e}`);
    }
};

export const handleTimerClick = () => {
    if (state.timer.isRunning) {
        stopTimer();
    } else {
        startTimer();
    }
};

export const updateTimerButton = () => {
    const timerBtn = document.getElementById('timer-btn');
    if (timerBtn) {
        if (state.timer.isRunning) {
            timerBtn.classList.remove('check-in');
            timerBtn.classList.add('check-out');
            timerBtn.innerHTML = `<span id="timer-display"></span> CHECK OUT`;
        } else {
            timerBtn.classList.remove('check-out');
            timerBtn.classList.add('check-in');
            timerBtn.innerHTML = `<span id="timer-display">00:00:00</span> CHECK IN`;
        }
        updateTimerDisplay();
    }
};

export const loadTimerState = async () => {
    let uid = String(state.user.id || '').toUpperCase();
    let storageKey = null;
    let raw = null;
    try {
        if (uid) {
            storageKey = `timerState_${uid}`;
            raw = localStorage.getItem(storageKey);
        }
        if (!raw) {
            storageKey = 'timerState';
            raw = localStorage.getItem('timerState');
        }
    } catch {
        raw = null;
    }
    if (!raw) return;

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        try { if (storageKey) localStorage.removeItem(storageKey); } catch {}
        return;
    }

    const mode = parsed.mode || (parsed.isRunning ? 'running' : 'stopped');
    const startTime = parsed.startTime;
    const savedDate = parsed.date;
    const durationSeconds = typeof parsed.durationSeconds === 'number' ? parsed.durationSeconds : 0;

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    if (savedDate && savedDate !== todayStr) {
        state.timer.isRunning = false;
        state.timer.startTime = null;
        state.timer.lastDuration = 0;
        try { if (storageKey) localStorage.removeItem(storageKey); } catch {}
        return;
    }

    if (mode === 'running' && startTime) {
        if (!uid) return;
        try {
            console.log(`🔍 Verifying check-in status for: ${uid}`);
            const base = (API_BASE_URL || 'http://localhost:5000').replace(/\/$/, '');
            const response = await fetch(`${base}/api/status/${uid}`);
            const statusData = await response.json();

            if (statusData.checked_in) {
                const backendTotal =
                    typeof statusData.total_seconds_today === 'number'
                        ? statusData.total_seconds_today
                        : null;
                const backendElapsed =
                    typeof statusData.elapsed_seconds === 'number'
                        ? statusData.elapsed_seconds
                        : null;

                // Derive base (past) seconds from backend by removing active elapsed
                let baseFromBackend = null;
                if (backendTotal !== null && backendElapsed !== null) {
                    baseFromBackend = Math.max(0, backendTotal - backendElapsed);
                }

                state.timer.isRunning = true;
                state.timer.startTime = startTime;
                // Prefer backend-derived base seconds; fall back to local cached duration
                state.timer.lastDuration =
                    baseFromBackend !== null ? baseFromBackend : (durationSeconds || 0);
                state.timer.intervalId = setInterval(updateTimerDisplay, 1000);
                console.log('✅ Timer state restored - user is checked in');
            } else {
                state.timer.isRunning = false;
                state.timer.startTime = null;
                state.timer.lastDuration = 0;
                try { if (storageKey) localStorage.removeItem(storageKey); } catch {}
                console.log('⚠️ Timer state cleared - user is not checked in');
                alert('Your previous check-in session has expired. Please check in again.');
            }
        } catch (err) {
            console.warn('Failed to verify check-in status:', err);
            state.timer.isRunning = false;
            state.timer.startTime = null;
            state.timer.lastDuration = 0;
            try { if (storageKey) localStorage.removeItem(storageKey); } catch {}
            console.log('⚠️ Timer state cleared due to verification failure');
        }
    } else if (mode === 'stopped' && durationSeconds > 0) {
        state.timer.isRunning = false;
        state.timer.startTime = null;
        state.timer.lastDuration = durationSeconds;
        updateTimerDisplay();
    }
};