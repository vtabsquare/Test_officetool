import { state } from '../state.js';
import { checkIn, checkOut } from './attendanceApi.js';
import { API_BASE_URL } from '../config.js';
import { renderMyAttendancePage } from '../pages/attendance.js';

const HALF_DAY_SECONDS = 4 * 3600;
const FULL_DAY_SECONDS = 9 * 3600;

const deriveAttendanceStatusFromSeconds = (seconds = 0) => {
    if (seconds >= FULL_DAY_SECONDS) return 'P';
    if (seconds >= HALF_DAY_SECONDS) return 'HL';
    return 'A';
};

const ensureTodayAttendanceRecord = () => {
    const uid = String(state.user.id || '').toUpperCase();
    if (!uid) return null;
    const today = new Date();
    const day = today.getDate();
    state.attendanceData[uid] = state.attendanceData[uid] || {};
    state.attendanceData[uid][day] = state.attendanceData[uid][day] || { day };
    return {
        uid,
        today,
        day,
        record: state.attendanceData[uid][day],
    };
};

const maybeUpdateLiveAttendanceStatus = (totalSeconds = 0, { force = false } = {}) => {
    if (!force && !state.timer.isRunning) return;
    const info = ensureTodayAttendanceRecord();
    if (!info) return;

    const nextStatus = deriveAttendanceStatusFromSeconds(totalSeconds);
    if (state.timer.lastAutoStatus === nextStatus) return;

    const { record, day, uid } = info;

    state.timer.lastAutoStatus = nextStatus;
    record.day = day;
    record.status = nextStatus;
    record.totalHours = Number((totalSeconds / 3600).toFixed(2));
    record.durationSeconds = totalSeconds;

    // Preserve existing metadata (check-in/out timestamps) if present
    state.attendanceData[uid][day] = record;

    if (window.location.hash === '#/attendance-my') {
        try {
            renderMyAttendancePage();
        } catch (err) {
            console.warn('Failed to refresh attendance view during live status update', err);
        }
    }
};

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

        let resolved = false;

        // Try high accuracy first with longer timeout
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                if (resolved) return;
                resolved = true;
                const location = {
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    accuracy_m: pos.coords.accuracy,
                    source: 'browser',
                };
                console.log('[TIMER] Geolocation captured (high accuracy):', location);
                resolve(location);
            },
            (err) => {
                console.warn('[TIMER] High accuracy geolocation error:', err.message);
                // Fallback: try with low accuracy (faster, uses network/WiFi)
                if (!resolved) {
                    navigator.geolocation.getCurrentPosition(
                        (pos) => {
                            if (resolved) return;
                            resolved = true;
                            const location = {
                                lat: pos.coords.latitude,
                                lng: pos.coords.longitude,
                                accuracy_m: pos.coords.accuracy,
                                source: 'browser-lowaccuracy',
                            };
                            console.log('[TIMER] Geolocation captured (low accuracy):', location);
                            resolve(location);
                        },
                        (err2) => {
                            if (resolved) return;
                            resolved = true;
                            console.warn('[TIMER] Low accuracy geolocation also failed:', err2.message);
                            resolve(null);
                        },
                        { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 }
                    );
                }
            },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
    });
};

export const updateTimerDisplay = () => {
    const timerDisplay = document.getElementById('timer-display');
    if (!timerDisplay) return;

    let totalSeconds = 0;

    if (state.timer.isRunning && state.timer.startTime) {
        const serverNow = Date.now() + (state.timer.serverOffsetMs || 0);
        const elapsed = Math.floor((serverNow - state.timer.startTime) / 1000);
        const base = typeof state.timer.lastDuration === 'number' ? state.timer.lastDuration : 0;
        totalSeconds = Math.max(0, base + elapsed);
    } else if (typeof state.timer.lastDuration === 'number' && state.timer.lastDuration > 0) {
        totalSeconds = Math.floor(state.timer.lastDuration);
    }

    const seconds = String(totalSeconds % 60).padStart(2, '0');
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    timerDisplay.textContent = `${hours}:${minutes}:${seconds}`;

    maybeUpdateLiveAttendanceStatus(totalSeconds);
};

const startTimer = async () => {
    // ⚡ OPTIMISTIC UI UPDATE - Start timer INSTANTLY on click
    const clickTime = Date.now();
    const previousSeconds = typeof state.timer.lastDuration === 'number' ? state.timer.lastDuration : 0;

    // Immediately update UI state
    state.timer.isRunning = true;
    state.timer.startTime = clickTime;
    state.timer.lastDuration = previousSeconds;
    if (state.timer.intervalId) clearInterval(state.timer.intervalId);
    state.timer.intervalId = setInterval(updateTimerDisplay, 1000);
    updateTimerButton();
    updateTimerDisplay();

    // Save optimistic state to localStorage
    const uid = String(state.user.id || '').toUpperCase();
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    try {
        const payload = {
            isRunning: true,
            startTime: clickTime,
            date: dateStr,
            mode: 'running',
            durationSeconds: previousSeconds,
        };
        localStorage.setItem(uid ? `timerState_${uid}` : 'timerState', JSON.stringify(payload));
    } catch {}

    // 🌐 Background: Capture location and call API (non-blocking)
    (async () => {
        try {
            // Get location in background (don't block UI)
            const location = await getGeolocation();

            // Call backend check-in
            const { record_id, checkin_time, total_seconds_today, checkin_timestamp } = await checkIn(state.user.id, location);

            // If backend provides authoritative check-in timestamp, prefer it.
            if (typeof checkin_timestamp === 'number' && checkin_timestamp > 0) {
                state.timer.startTime = checkin_timestamp;
                try {
                    const payload = {
                        isRunning: true,
                        startTime: checkin_timestamp,
                        date: dateStr,
                        mode: 'running',
                        durationSeconds: typeof state.timer.lastDuration === 'number' ? state.timer.lastDuration : 0,
                    };
                    localStorage.setItem(uid ? `timerState_${uid}` : 'timerState', JSON.stringify(payload));
                } catch {}
            }

            // Sync with backend data if needed
            const backendSeconds = Number(total_seconds_today || 0);
            if (backendSeconds > previousSeconds) {
                state.timer.lastDuration = backendSeconds;
                // Update localStorage with corrected duration
                try {
                    const payload = {
                        isRunning: true,
                        startTime: state.timer.startTime,
                        date: dateStr,
                        mode: 'running',
                        durationSeconds: backendSeconds,
                    };
                    localStorage.setItem(uid ? `timerState_${uid}` : 'timerState', JSON.stringify(payload));
                } catch {}
                maybeUpdateLiveAttendanceStatus(state.timer.lastDuration, { force: true });
            }

            console.log('✅ Check-in confirmed by backend:', checkin_time);

            // Update attendance state for today
            const day = today.getDate();
            state.attendanceData[uid] = state.attendanceData[uid] || {};
            state.attendanceData[uid][day] = {
                ...(state.attendanceData[uid][day] || {}),
                day,
                status: deriveAttendanceStatusFromSeconds(typeof state.timer.lastDuration === 'number' ? state.timer.lastDuration : backendSeconds),
                checkIn: checkin_time,
                isLate: false,
                isManual: false,
                isPending: false,
            };
            state.timer.lastAutoStatus = state.attendanceData[uid][day].status;
            maybeUpdateLiveAttendanceStatus(state.timer.lastDuration || 0, { force: true });

            // Refresh attendance page if user is on it
            if (window.location.hash === '#/attendance-my') {
                renderMyAttendancePage();
            }
        } catch (e) {
            console.error('Check-in API failed:', e);
            // Rollback optimistic update on failure
            if (state.timer.intervalId) clearInterval(state.timer.intervalId);
            state.timer.isRunning = false;
            state.timer.startTime = null;
            state.timer.intervalId = null;
            state.timer.lastAutoStatus = null;
            try {
                localStorage.removeItem(uid ? `timerState_${uid}` : 'timerState');
            } catch {}

            updateTimerButton();
            updateTimerDisplay();
            alert(`Check-in failed: ${e.message || e}`);
        }
    })();
};

const stopTimer = async () => {
    // ⚡ OPTIMISTIC UI UPDATE - Stop timer INSTANTLY on click
    const clickTime = Date.now() + (state.timer.serverOffsetMs || 0);
    const baseBefore = typeof state.timer.lastDuration === 'number' ? state.timer.lastDuration : 0;
    let localElapsed = 0;
    if (state.timer.startTime) {
        localElapsed = Math.max(0, Math.floor((clickTime - Number(state.timer.startTime)) / 1000));
    }

    const localTotal = baseBefore + localElapsed;

    // Immediately update UI state
    if (state.timer.intervalId) clearInterval(state.timer.intervalId);
    state.timer.isRunning = false;
    state.timer.intervalId = null;
    state.timer.startTime = null;
    state.timer.lastDuration = localTotal;
    maybeUpdateLiveAttendanceStatus(localTotal, { force: true });
    updateTimerButton();
    updateTimerDisplay();

    // Save optimistic state to localStorage
    const uid = String(state.user.id || '').toUpperCase();
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    try {
        const payload = {
            isRunning: false,
            startTime: null,
            date: dateStr,
            mode: 'stopped',
            durationSeconds: localTotal,
        };
        localStorage.setItem(uid ? `timerState_${uid}` : 'timerState', JSON.stringify(payload));
    } catch {}

    // 🌐 Background: Capture location and call API (non-blocking)
    (async () => {
        try {
            // Get location in background (don't block UI)
            const location = await getGeolocation();

            // Call backend check-out
            const { checkout_time, duration, total_hours, total_seconds_today } = await checkOut(state.user.id, location);

            let backendTotal = 0;
            if (typeof total_seconds_today === 'number' && total_seconds_today > 0) {
                backendTotal = Math.floor(total_seconds_today);
            } else {
                // Fallback: derive from duration/total_hours
                let candidate = 0;
                if (typeof duration === 'string') {
                    const m = duration.match(/(\d+)\s+hour\(s\)\s+(\d+)\s+minute\(s\)/i);
                    if (m) {
                        candidate = (parseInt(m[1], 10) || 0) * 3600 + (parseInt(m[2], 10) || 0) * 60;
                    }
                }
                if (typeof total_hours === 'number' && total_hours > 0 && candidate === 0) {
                    candidate = Math.floor(total_hours * 3600);
                }
                backendTotal = candidate;
            }

            // Sync with backend if it has a larger total
            const lastSeconds = Math.max(localTotal, backendTotal || 0);
            if (lastSeconds > localTotal) {
                state.timer.lastDuration = lastSeconds;
                try {
                    const payload = {
                        isRunning: false,
                        startTime: null,
                        date: dateStr,
                        mode: 'stopped',
                        durationSeconds: lastSeconds,
                    };
                    localStorage.setItem(uid ? `timerState_${uid}` : 'timerState', JSON.stringify(payload));
                } catch {}
                updateTimerDisplay();
            }
            const finalStatus = deriveAttendanceStatusFromSeconds(Math.max(state.timer.lastDuration || 0, lastSeconds || 0));
            state.timer.lastAutoStatus = finalStatus;
            maybeUpdateLiveAttendanceStatus(state.timer.lastDuration || 0, { force: true });

            console.log('✅ Check-out confirmed by backend:', checkout_time);

            // Update attendance state for today
            const day = today.getDate();
            state.attendanceData[uid] = state.attendanceData[uid] || {};
            state.attendanceData[uid][day] = {
                ...(state.attendanceData[uid][day] || {}),
                day,
                status: finalStatus,
                checkOut: checkout_time,
                totalHours: total_hours,
            };

            // Refresh attendance page if user is on it
            if (window.location.hash === '#/attendance-my') {
                renderMyAttendancePage();
            }
        } catch (e) {
            console.error('Check-out API failed:', e);
            // Don't rollback - timer is already stopped, just log the error
            // The backend session recovery will handle this on next check-in
            console.warn('Check-out not saved to backend. Will sync on next check-in.');
        }
    })();
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
    // Always prefer authoritative backend state if available
    const uid = String(state.user.id || '').toUpperCase();
    const storageKey = uid ? `timerState_${uid}` : 'timerState';
    const baseUrl = (API_BASE_URL || 'http://localhost:5000').replace(/\/$/, '');

    // 1) Backend-first: if backend says we're checked in, restore and return
    if (uid) {
        try {
            const response = await fetch(`${baseUrl}/api/status/${uid}`);
            const statusData = await response.json();
            if (statusData.checked_in) {
                const backendElapsed = typeof statusData.elapsed_seconds === 'number' ? statusData.elapsed_seconds : 0;
                const backendTotal = typeof statusData.total_seconds_today === 'number' ? statusData.total_seconds_today : 0;
                const baseFromBackend = Math.max(0, backendTotal - backendElapsed);
                const syncedStartTime = Date.now() - (backendElapsed * 1000);

                state.timer.isRunning = true;
                state.timer.startTime = syncedStartTime;
                state.timer.lastDuration = baseFromBackend;

                const today = new Date();
                const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
                try {
                    localStorage.setItem(storageKey, JSON.stringify({
                        isRunning: true,
                        startTime: syncedStartTime,
                        date: todayStr,
                        mode: 'running',
                        durationSeconds: baseFromBackend,
                    }));
                } catch {}
                if (state.timer.intervalId) clearInterval(state.timer.intervalId);
                state.timer.intervalId = setInterval(updateTimerDisplay, 1000);
                updateTimerDisplay();
                console.log(`✅ Timer restored from backend (elapsed: ${backendElapsed}s, base: ${baseFromBackend}s)`);
                return;
            } else {
                // Backend says no active session; clear any stale local cache silently
                try { localStorage.removeItem(storageKey); } catch {}
            }
        } catch (err) {
            console.warn('Failed to fetch backend status during loadTimerState:', err);
        }
    }

    // 2) Fallback to local cache if backend unreachable
    let raw = null;
    try {
        raw = localStorage.getItem(storageKey);
    } catch {
        raw = null;
    }

    if (!raw) return;

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        try { localStorage.removeItem(storageKey); } catch {}
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
        try { localStorage.removeItem(storageKey); } catch {}
        return;
    }

    if (mode === 'running' && startTime) {
        // With backend unreachable, fall back to local running state
        state.timer.isRunning = true;
        state.timer.startTime = startTime;
        state.timer.lastDuration = durationSeconds || 0;
        if (state.timer.intervalId) clearInterval(state.timer.intervalId);
        state.timer.intervalId = setInterval(updateTimerDisplay, 1000);
        updateTimerDisplay();
        console.log('ℹ️ Timer restored from local cache (offline fallback)');
    } else if (mode === 'stopped' && durationSeconds > 0) {
        state.timer.isRunning = false;
        state.timer.startTime = null;
        state.timer.lastDuration = durationSeconds;
        updateTimerDisplay();
    }
};