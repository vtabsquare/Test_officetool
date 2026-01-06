// attendance_module.js — Real-time Attendance Timer Sync
// Handles multi-device check-in/check-out synchronization and auto-status updates

const HALF_DAY_SECONDS = 4 * 3600; // 4 hours
const FULL_DAY_SECONDS = 9 * 3600; // 9 hours

// In-memory store of active check-ins (synced from backend)
const activeTimers = {};

// Status thresholds check interval (runs every minute)
let statusCheckInterval = null;

function deriveStatus(totalSeconds) {
  if (totalSeconds >= FULL_DAY_SECONDS) return 'P';
  if (totalSeconds >= HALF_DAY_SECONDS) return 'HL';
  return 'A';
}

module.exports = (io) => {
  console.log('⏱️ Attendance Module Loaded');

  // Start periodic status checker
  if (statusCheckInterval) clearInterval(statusCheckInterval);
  statusCheckInterval = setInterval(() => {
    checkAndBroadcastStatusUpdates(io);
  }, 60 * 1000); // Check every minute

  io.on('connection', (socket) => {
    // ----------------------------------------
    // ATTENDANCE REGISTER - Join user's attendance room
    // ----------------------------------------
    socket.on('attendance:register', ({ employee_id }) => {
      if (!employee_id) return;
      const uid = String(employee_id).trim().toUpperCase();
      socket.data.attendance_user_id = uid;
      const room = `attendance:${uid}`;
      socket.join(room);
      console.log(`[ATTENDANCE] ${uid} registered for attendance updates, room: ${room}`);

      // Send current timer state if active
      const timer = activeTimers[uid];
      // If we don't have any in-memory state (e.g., socket server just restarted),
      // avoid pushing a "stopped" state that would wrongly pause a running timer on clients.
      // Let the frontend rely on backend /api/status + local cache instead.
      if (!timer) return;

      if (timer && timer.isRunning) {
        const now = Date.now();
        const elapsedMs = now - timer.checkinTimestamp;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);
        
        // Guard against negative elapsed time (timezone/timestamp issues)
        // If elapsed is negative or unreasonably large, don't send sync - let frontend use backend
        if (elapsedSeconds < 0 || elapsedSeconds > 24 * 3600) {
          console.log(`[ATTENDANCE] Skipping sync for ${uid}: invalid elapsed=${elapsedSeconds}s (timestamp issue)`);
          return;
        }
        
        const totalSeconds = (timer.baseSeconds || 0) + elapsedSeconds;
        const status = deriveStatus(totalSeconds);

        socket.emit('attendance:sync', {
          employee_id: uid,
          isRunning: true,
          checkinTimestamp: timer.checkinTimestamp,
          baseSeconds: timer.baseSeconds || 0,
          totalSeconds,
          status,
          checkinTime: timer.checkinTime,
          serverNow: now,
        });
        console.log(`[ATTENDANCE] Sent sync to ${uid}: running, totalSeconds=${totalSeconds}`);
      } else if (timer && timer.isRunning === false) {
        socket.emit('attendance:sync', {
          employee_id: uid,
          isRunning: false,
          totalSeconds: typeof timer.totalSeconds === 'number' ? timer.totalSeconds : 0,
          status: timer.status || deriveStatus(typeof timer.totalSeconds === 'number' ? timer.totalSeconds : 0),
          serverNow: Date.now(),
        });
      } 
    });

    // ----------------------------------------
    // ATTENDANCE CHECK-IN - Broadcast to all devices
    // ----------------------------------------
    socket.on('attendance:checkin', (payload) => {
      const { employee_id, checkinTime, checkinTimestamp, baseSeconds = 0 } = payload || {};
      if (!employee_id) return;

      const uid = String(employee_id).trim().toUpperCase();
      const room = `attendance:${uid}`;

      // Store in memory
      activeTimers[uid] = {
        isRunning: true,
        checkinTime,
        checkinTimestamp: checkinTimestamp || Date.now(),
        baseSeconds: baseSeconds || 0,
        lastStatus: 'A',
      };

      // Broadcast to all devices of this user
      io.to(room).emit('attendance:started', {
        employee_id: uid,
        checkinTime,
        checkinTimestamp: activeTimers[uid].checkinTimestamp,
        baseSeconds,
        serverNow: Date.now(),
      });

      console.log(`[ATTENDANCE] Check-in broadcast for ${uid} at ${checkinTime}`);
    });

    // ----------------------------------------
    // ATTENDANCE CHECK-OUT - Broadcast to all devices
    // ----------------------------------------
    socket.on('attendance:checkout', (payload) => {
      const { employee_id, checkoutTime, totalSeconds, status } = payload || {};
      if (!employee_id) return;

      const uid = String(employee_id).trim().toUpperCase();
      const room = `attendance:${uid}`;

      // Preserve last stopped state in memory so new devices/reconnects don't reset to 0
      // This is essential for pause/resume semantics across devices.
      activeTimers[uid] = {
        isRunning: false,
        checkoutTime,
        totalSeconds: typeof totalSeconds === 'number' ? totalSeconds : 0,
        status: status || deriveStatus(typeof totalSeconds === 'number' ? totalSeconds : 0),
      };

      // Broadcast to all devices of this user
      io.to(room).emit('attendance:stopped', {
        employee_id: uid,
        checkoutTime,
        totalSeconds,
        status,
        serverNow: Date.now(),
      });

      console.log(`[ATTENDANCE] Check-out broadcast for ${uid}, totalSeconds=${totalSeconds}, status=${status}`);
    });

    // ----------------------------------------
    // REQUEST SYNC - Client requests current state
    // ----------------------------------------
    socket.on('attendance:request-sync', ({ employee_id }) => {
      if (!employee_id) return;
      const uid = String(employee_id).trim().toUpperCase();

      const timer = activeTimers[uid];
      // If we don't have state (server restart), let frontend rely on backend /api/status + cache.
      if (!timer) return;

      if (timer && timer.isRunning) {
        const now = Date.now();
        const elapsedMs = now - timer.checkinTimestamp;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);
        
        // Guard against negative elapsed time (timezone/timestamp issues)
        if (elapsedSeconds < 0 || elapsedSeconds > 24 * 3600) {
          console.log(`[ATTENDANCE] Skipping request-sync for ${uid}: invalid elapsed=${elapsedSeconds}s`);
          return;
        }
        
        const totalSeconds = (timer.baseSeconds || 0) + elapsedSeconds;
        const status = deriveStatus(totalSeconds);

        socket.emit('attendance:sync', {
          employee_id: uid,
          isRunning: true,
          checkinTimestamp: timer.checkinTimestamp,
          baseSeconds: timer.baseSeconds || 0,
          totalSeconds,
          status,
          checkinTime: timer.checkinTime,
          serverNow: now,
        });
      } else if (timer && timer.isRunning === false) {
        socket.emit('attendance:sync', {
          employee_id: uid,
          isRunning: false,
          totalSeconds: typeof timer.totalSeconds === 'number' ? timer.totalSeconds : 0,
          status: timer.status || deriveStatus(typeof timer.totalSeconds === 'number' ? timer.totalSeconds : 0),
          serverNow: Date.now(),
        });
      }
    });

    socket.on('disconnect', () => {
      const uid = socket.data.attendance_user_id;
      if (uid) {
        console.log(`[ATTENDANCE] ${uid} disconnected`);
      }
    });
  });

  // Function to check status thresholds and broadcast updates
  function checkAndBroadcastStatusUpdates(io) {
    const now = Date.now();

    for (const [uid, timer] of Object.entries(activeTimers)) {
      if (!timer.isRunning) continue;

      const elapsedMs = now - timer.checkinTimestamp;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      
      // Skip if elapsed time is invalid (negative or > 24 hours)
      if (elapsedSeconds < 0 || elapsedSeconds > 24 * 3600) {
        continue;
      }
      
      const totalSeconds = (timer.baseSeconds || 0) + elapsedSeconds;
      const newStatus = deriveStatus(totalSeconds);

      // Only broadcast if status changed
      if (timer.lastStatus !== newStatus) {
        timer.lastStatus = newStatus;
        const room = `attendance:${uid}`;

        io.to(room).emit('attendance:status-update', {
          employee_id: uid,
          totalSeconds,
          status: newStatus,
          autoUpdated: true,
          serverNow: now,
        });

        console.log(`[ATTENDANCE] Auto status update for ${uid}: ${newStatus} (${totalSeconds}s)`);

        // Persist status to backend (fire-and-forget)
        persistStatusToBackend(uid, totalSeconds, newStatus);
      }
    }
  }

  // Persist auto-updated status to backend Dataverse
  async function persistStatusToBackend(employeeId, totalSeconds, status) {
    try {
      const backendUrl = process.env.BACKEND_URL || 'http://localhost:5000';
      const response = await fetch(`${backendUrl}/api/attendance/auto-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employee_id: employeeId,
          total_seconds: totalSeconds,
          status: status,
        }),
      });
      if (response.ok) {
        console.log(`[ATTENDANCE] Persisted auto-status ${status} for ${employeeId} to backend`);
      } else {
        console.warn(`[ATTENDANCE] Failed to persist auto-status for ${employeeId}: ${response.status}`);
      }
    } catch (err) {
      console.warn(`[ATTENDANCE] Error persisting auto-status for ${employeeId}:`, err.message);
    }
  }
};

// Export for external use (e.g., HTTP bridge from Flask)
module.exports.activeTimers = activeTimers;
module.exports.deriveStatus = deriveStatus;
