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
        persistTimerState(uid, {
            isRunning: true,
            startTime: clickTime,
            date: dateStr,
            mode: 'running',
            durationSeconds: previousSeconds,
        });
    } catch {}
    
    // 🌐 Background: Capture location and call API (non-blocking)
    (async () => {
        try {
            // Get location in background (don't block UI)
            const location = await getGeolocation();
            
            // Call backend check-in
            const { record_id, checkin_time, total_seconds_today } = await checkIn(state.user.id, location);
            
            // Sync with backend data if needed
            const backendSeconds = Number(total_seconds_today || 0);
            if (backendSeconds > previousSeconds) {
                state.timer.lastDuration = backendSeconds;
                // Update localStorage with corrected duration
                persistTimerState(uid, {
                    isRunning: true,
                    startTime: clickTime,
                    date: dateStr,
                    mode: 'running',
                    durationSeconds: backendSeconds,
                });
            }
            
            console.log('✅ Check-in confirmed by backend:', checkin_time);
            
            // Update attendance state for today
            const day = today.getDate();
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
            try { localStorage.removeItem(uid ? `timerState_${uid}` : 'timerState'); } catch {}
            updateTimerButton();
            updateTimerDisplay();
            alert(`Check-in failed: ${e.message || e}`);
        }
    })();
};

const stopTimer = async () => {
    // ⚡ OPTIMISTIC UI UPDATE - Stop timer INSTANTLY on click
    const clickTime = Date.now();
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
    updateTimerButton();
    updateTimerDisplay();
    
    // Save optimistic state to localStorage
    const uid = String(state.user.id || '').toUpperCase();
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    try {
        persistTimerState(uid, {
            isRunning: false,
            startTime: null,
            date: dateStr,
            mode: 'stopped',
            durationSeconds: localTotal,
        });
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
                persistTimerState(uid, {
                    isRunning: false,
                    startTime: null,
                    date: dateStr,
                    mode: 'stopped',
                    durationSeconds: lastSeconds,
                });
                updateTimerDisplay();
            }
            
            console.log('✅ Check-out confirmed by backend:', checkout_time);
            
            // Update attendance state for today
            const day = today.getDate();
            state.attendanceData[uid] = state.attendanceData[uid] || {};
            state.attendanceData[uid][day] = {
                ...(state.attendanceData[uid][day] || {}),
                day,
                status: 'P',
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
    try {
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

            if (showExpiryAlert) {
                alert('Your previous check-in session has expired. Please check in again.');
                showExpiryAlert = false;
            }
        }
        updateTimerDisplay();
    } catch (err) {
        console.warn('Failed to update timer button:', err);
    }
};

let showExpiryAlert = false;
let timerStatusInterval = null;
const TIMER_STATUS_INTERVAL_MS = 30000;

const persistTimerState = (uid, payload) => {
    if (!uid) return;
    try {
        localStorage.setItem(`timerState_${uid}`, JSON.stringify(payload));
    } catch {}
};

const restoreTimerFromBackend = async (uid, storageKeyToClear = null, requestExpiryAlert = false) => {

    if (!uid) return false;
    try {
        const base = (API_BASE_URL || 'http://localhost:5000').replace(/\/$/, '');
        const response = await fetch(`${base}/api/status/${uid}`);
        if (!response.ok) throw new Error(`Status fetch failed: ${response.status}`);
        const statusData = await response.json();

        if (statusData.checked_in) {
            const elapsedSeconds = Math.max(0, Number(statusData.elapsed_seconds || 0));
            const totalSeconds = Math.max(0, Number(statusData.total_seconds_today || 0));
            const baselineSeconds = Math.max(0, totalSeconds - elapsedSeconds);
            const derivedStart = Date.now() - elapsedSeconds * 1000;

            if (state.timer.intervalId) clearInterval(state.timer.intervalId);
            state.timer.isRunning = true;
            state.timer.startTime = derivedStart;
            state.timer.lastDuration = baselineSeconds;
            state.timer.intervalId = setInterval(updateTimerDisplay, 1000);

            const today = new Date();
            const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            persistTimerState(uid, {
                isRunning: true,
                startTime: derivedStart,
                date: dateStr,
                mode: 'running',
                durationSeconds: baselineSeconds,
            });
            showExpiryAlert = false;
            updateTimerButton();
            return true;
        }

        if (requestExpiryAlert) {
            showExpiryAlert = true;
        }
    } catch (err) {
        console.warn('Failed to restore timer from backend:', err);
    }

    if (storageKeyToClear) {
        try { localStorage.removeItem(storageKeyToClear); } catch {}
    }
    if (state.timer.intervalId) {
        clearInterval(state.timer.intervalId);
        state.timer.intervalId = null;
    }
    state.timer.isRunning = false;
    state.timer.startTime = null;
    state.timer.lastDuration = 0;
    updateTimerButton();
    return false;
};

const ensureTimerStatusPolling = () => {
    if (timerStatusInterval) return;
    const uid = String(state.user.id || '').toUpperCase();
    if (!uid) return;
    const poll = async () => {
        await restoreTimerFromBackend(uid, null, false);
    };
    timerStatusInterval = setInterval(() => {
        poll().catch((err) => console.warn('Timer status poll failed:', err));
    }, TIMER_STATUS_INTERVAL_MS);
};

export const loadTimerState = async () => {
    let uid = String(state.user.id || '').toUpperCase();
    if (uid) {
        ensureTimerStatusPolling();
    }

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

    if (!raw) {
        await restoreTimerFromBackend(uid, null, false);
        return;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        await restoreTimerFromBackend(uid, storageKey, true);
        return;
    }

    const mode = parsed.mode || (parsed.isRunning ? 'running' : 'stopped');
    const startTime = parsed.startTime;
    const savedDate = parsed.date;
    const durationSeconds = typeof parsed.durationSeconds === 'number' ? parsed.durationSeconds : 0;

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    if (savedDate && savedDate !== todayStr) {
        await restoreTimerFromBackend(uid, storageKey, true);
        return;
    }

    if (mode === 'running' && startTime) {
        if (!uid) return;
        try {
            console.log(` Verifying check-in status for: ${uid}`);
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
                state.timer.startTime =
                    backendElapsed !== null
                        ? Date.now() - backendElapsed * 1000
                        : startTime;
                // Prefer backend-derived base seconds; fall back to local cached duration
                state.timer.lastDuration =
                    baseFromBackend !== null ? baseFromBackend : (durationSeconds || 0);
                if (state.timer.intervalId) clearInterval(state.timer.intervalId);
                state.timer.intervalId = setInterval(updateTimerDisplay, 1000);
                updateTimerButton();
                console.log(' Timer state restored - user is checked in');
            } else {
                showExpiryAlert = true;
                await restoreTimerFromBackend(uid, storageKey, true);
                return;
            }
        } catch (err) {
            console.warn('Failed to verify check-in status:', err);
            await restoreTimerFromBackend(uid, storageKey, true);
        }
    } else if (mode === 'running' && !startTime) {
        await restoreTimerFromBackend(uid, storageKey, true);
        return;
    } else if (mode === 'stopped' && durationSeconds > 0) {
        state.timer.isRunning = false;
        state.timer.startTime = null;
        state.timer.lastDuration = durationSeconds;
        updateTimerDisplay();
    } else {
        await restoreTimerFromBackend(uid, storageKey, false);
    }
};