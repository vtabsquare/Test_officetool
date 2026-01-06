const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const attachChatModule = require('./chat_module');
const attachAttendanceModule = require('./attendance_module');

const PORT = process.env.PORT || 4000;
const allowedOrigins = (process.env.SOCKET_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const app = express();
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : '*',
  methods: ['GET', 'POST'],
  credentials: true,
}));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Attach chat module so this server handles BOTH meet and chat
attachChatModule(io);

// Attach attendance module for real-time timer sync across devices
attachAttendanceModule(io);

const activeCalls = {};
const userSockets = {};

function addSocketToUser(userId, socketId) {
  if (!userSockets[userId]) {
    userSockets[userId] = new Set();
  }
  userSockets[userId].add(socketId);
}

function removeSocketFromUser(userId, socketId) {
  const set = userSockets[userId];
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) {
    delete userSockets[userId];
  }
}

function createCall(payload) {
  let { call_id, admin_id, title, meet_url, participants } = payload;
  if (!call_id) {
    call_id = uuidv4();
  }
  const normalizedParticipants = (participants || []).map((p) => ({
    employee_id: p.employee_id || null,
    email: p.email,
    status: p.status || 'ringing'
  }));
  const call = {
    call_id,
    admin_id,
    title: title || 'Meeting',
    meet_url,
    participants: normalizedParticipants
  };
  activeCalls[call_id] = call;
  return call;
}

function updateParticipantStatus(call_id, employee_id, email, status) {
  const call = activeCalls[call_id];
  if (!call) return null;
  let participant =
    call.participants.find((p) => p.employee_id && p.employee_id === employee_id) ||
    call.participants.find((p) => email && p.email === email);
  if (!participant) {
    const newParticipant = {
      employee_id: employee_id || null,
      email: email || null,
      status
    };
    call.participants.push(newParticipant);
    participant = newParticipant;
  } else {
    participant.status = status;
  }
  return call;
}

function broadcastParticipantUpdate(call) {
  if (!call || !call.admin_id) return;
  
  // Normalize admin_id to uppercase for consistent room matching
  const adminRoom = String(call.admin_id).trim().toUpperCase();
  const roomSockets = io.sockets.adapter.rooms.get(adminRoom);
  const socketsInRoom = roomSockets ? roomSockets.size : 0;
  
  console.log('[SOCKET-SERVER] broadcastParticipantUpdate to admin room:', adminRoom, 'socketsInRoom:', socketsInRoom, 'participants:', call.participants.map(p => ({ id: p.employee_id, status: p.status })));
  
  io.to(adminRoom).emit('call:participant-update', {
    call_id: call.call_id,
    participants: call.participants
  });
}

function broadcastCallCancelled(call, reason = 'cancelled') {
  if (!call) return;

  try {
    const adminRoom = String(call.admin_id || '').trim().toUpperCase();
    if (adminRoom) {
      io.to(adminRoom).emit('call:cancelled', {
        call_id: call.call_id,
        admin_id: call.admin_id,
        reason
      });
    }
  } catch (e) {
    console.error('[SOCKET-SERVER] broadcastCallCancelled admin emit error:', e);
  }

  try {
    (call.participants || []).forEach((p) => {
      const rawRoom = p.employee_id || p.email;
      if (!rawRoom) return;
      const room = String(rawRoom).trim().toUpperCase();
      io.to(room).emit('call:cancelled', {
        call_id: call.call_id,
        admin_id: call.admin_id,
        reason
      });
    });
  } catch (e) {
    console.error('[SOCKET-SERVER] broadcastCallCancelled participant emit error:', e);
  }
}

app.post('/emit', (req, res) => {
  try {
    const body = req.body || {};

    // -----------------------------------------
    // MODE 1: Chat bridge  (backend/chats.py)
    // expects: { event, data }
    // -----------------------------------------
    if (body.event) {
      const { event, data } = body;
      if (!event) {
        return res.status(400).json({ success: false, error: 'event_required' });
      }

      console.log('[SOCKET-SERVER] /emit (chat)', { event, data });

      const emitToConversation = (evt, payload) => {
        if (payload && payload.conversation_id) {
          const room = String(payload.conversation_id);
          io.to(room).emit(evt, payload);
        } else {
          io.emit(evt, payload);
        }
      };

      switch (event) {
        case 'new_message': {
          emitToConversation('new_message', data);
          break;
        }

        case 'conversation_created': {
          const members = Array.isArray(data && data.members) ? data.members : [];
          if (members.length) {
            members.forEach((uid) => {
              if (!uid) return;
              io.to(String(uid)).emit('conversation_created', data);
            });
          } else {
            io.emit('conversation_created', data);
          }
          break;
        }

        case 'group_add_members': {
          emitToConversation('group_members_added', data);
          break;
        }

        case 'group_members_removed':
        case 'group_remove_members': {
          emitToConversation('group_members_removed', data);
          break;
        }

        case 'group_renamed': {
          emitToConversation('group_renamed', data);
          break;
        }

        case 'group_deleted': {
          emitToConversation('conversation_deleted', data);
          break;
        }

        case 'direct_left': {
          emitToConversation('user_left_conversation', data);
          break;
        }

        case 'message_edited': {
          io.emit('message_edited', data);
          break;
        }

        case 'message_deleted': {
          io.emit('message_deleted', data);
          break;
        }

        // -----------------------------------------
        // ATTENDANCE EVENTS (from Flask backend)
        // -----------------------------------------
        case 'attendance:checkin': {
          const { employee_id, checkinTime, checkinTimestamp, baseSeconds } = data || {};
          if (employee_id) {
            const uid = String(employee_id).trim().toUpperCase();
            const room = `attendance:${uid}`;
            
            // Update in-memory store
            const attendanceModule = require('./attendance_module');
            attendanceModule.activeTimers[uid] = {
              isRunning: true,
              checkinTime,
              checkinTimestamp: checkinTimestamp || Date.now(),
              baseSeconds: baseSeconds || 0,
              lastStatus: 'A',
            };
            
            io.to(room).emit('attendance:started', {
              employee_id: uid,
              checkinTime,
              checkinTimestamp: attendanceModule.activeTimers[uid].checkinTimestamp,
              baseSeconds: baseSeconds || 0,
            });
            console.log(`[SOCKET-SERVER] Attendance check-in broadcast for ${uid}`);
          }
          break;
        }

        case 'attendance:checkout': {
          const { employee_id, checkoutTime, totalSeconds, status } = data || {};
          if (employee_id) {
            const uid = String(employee_id).trim().toUpperCase();
            const room = `attendance:${uid}`;
            
            // Preserve last stopped state so new devices/reconnects don't reset to 0
            const attendanceModule = require('./attendance_module');
            attendanceModule.activeTimers[uid] = {
              isRunning: false,
              checkoutTime,
              totalSeconds: typeof totalSeconds === 'number' ? totalSeconds : 0,
              status: status || attendanceModule.deriveStatus(typeof totalSeconds === 'number' ? totalSeconds : 0),
            };
            
            io.to(room).emit('attendance:stopped', {
              employee_id: uid,
              checkoutTime,
              totalSeconds,
              status,
            });
            console.log(`[SOCKET-SERVER] Attendance check-out broadcast for ${uid}`);
          }
          break;
        }

        case 'attendance:status-update': {
          const { employee_id, totalSeconds, status } = data || {};
          if (employee_id) {
            const uid = String(employee_id).trim().toUpperCase();
            const room = `attendance:${uid}`;
            io.to(room).emit('attendance:status-update', {
              employee_id: uid,
              totalSeconds,
              status,
              autoUpdated: true,
            });
            console.log(`[SOCKET-SERVER] Attendance status update broadcast for ${uid}: ${status}`);
          }
          break;
        }

        default: {
          // Fallback: broadcast raw event name
          io.emit(event, data);
        }
      }

      return res.json({ success: true });
    }

    // -----------------------------------------
    // MODE 2: Meet bridge (existing behaviour)
    // expects: { admin_id, title, meet_url, participants[] }
    // -----------------------------------------
    const { admin_id, title, meet_url, participants } = body;
    console.log('[SOCKET-SERVER] /emit (meet) called with:', {
      admin_id,
      title,
      meet_url,
      participantsCount: Array.isArray(participants) ? participants.length : 'n/a',
    });
    if (!admin_id || !meet_url || !Array.isArray(participants)) {
      return res.status(400).json({
        success: false,
        error: 'admin_id, meet_url, and participants[] are required'
      });
    }
    const call = createCall({ admin_id, title, meet_url, participants });
    console.log('[SOCKET-SERVER] created call:', {
      call_id: call.call_id,
      admin_id: call.admin_id,
      participants: call.participants,
    });
    call.participants.forEach((p) => {
      // Normalize room to uppercase for consistent matching with registered users
      const rawRoom = p.employee_id || p.email;
      if (!rawRoom) return;
      const room = String(rawRoom).trim().toUpperCase();
      
      // Check if anyone is in this room
      const roomSockets = io.sockets.adapter.rooms.get(room);
      const socketsInRoom = roomSockets ? roomSockets.size : 0;
      
      console.log('[SOCKET-SERVER] emitting call:ring to room', room, 'socketsInRoom:', socketsInRoom, 'for participant', {
        employee_id: p.employee_id,
        email: p.email,
        status: p.status,
      });
      
      io.to(room).emit('call:ring', {
        call_id: call.call_id,
        admin_id: call.admin_id,
        title: call.title,
        meet_url: call.meet_url,
        participants: call.participants,
        target: {
          employee_id: p.employee_id,
          email: p.email
        }
      });
    });
    return res.json({
      success: true,
      call_id: call.call_id,
      participants: call.participants
    });
  } catch (e) {
    console.error('[SOCKET-SERVER] /emit error:', e);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

io.on('connection', (socket) => {
  console.log('[SOCKET-SERVER] client connected:', socket.id, 'from:', socket.handshake.headers.origin || 'unknown');

  socket.on('register', (payload) => {
    try {
      const { user_id, role } = payload || {};
      if (!user_id) {
        console.warn('[SOCKET-SERVER] register called without user_id');
        return;
      }
      // Normalize user_id to uppercase for consistent room matching
      const normalizedUserId = String(user_id).trim().toUpperCase();
      socket.data.user_id = normalizedUserId;
      socket.data.role = role || 'employee';
      socket.join(normalizedUserId);
      addSocketToUser(normalizedUserId, socket.id);
      console.log('[SOCKET-SERVER] register:', normalizedUserId, 'role:', socket.data.role, 'rooms:', Array.from(socket.rooms));
    } catch (e) {
      console.error('[SOCKET-SERVER] register error:', e);
    }
  });

  socket.on('call:accepted', (payload) => {
    try {
      const { call_id, employee_id, email } = payload || {};
      console.log('[SOCKET-SERVER] call:accepted received:', { call_id, employee_id, email });
      if (!call_id) {
        console.warn('[SOCKET-SERVER] call:accepted missing call_id');
        return;
      }
      const call = updateParticipantStatus(call_id, employee_id, email, 'accepted');
      if (!call) {
        console.warn('[SOCKET-SERVER] call:accepted - call not found for call_id:', call_id);
        return;
      }
      broadcastParticipantUpdate(call);
    } catch (e) {
      console.error('[SOCKET-SERVER] call:accepted error:', e);
    }
  });

  socket.on('call:declined', (payload) => {
    try {
      const { call_id, employee_id, email } = payload || {};
      console.log('[SOCKET-SERVER] call:declined received:', { call_id, employee_id, email });
      if (!call_id) {
        console.warn('[SOCKET-SERVER] call:declined missing call_id');
        return;
      }
      const call = updateParticipantStatus(call_id, employee_id, email, 'declined');
      if (!call) {
        console.warn('[SOCKET-SERVER] call:declined - call not found for call_id:', call_id);
        return;
      }
      broadcastParticipantUpdate(call);
    } catch (e) {
      console.error('[SOCKET-SERVER] call:declined error:', e);
    }
  });

  socket.on('call:cancel', (payload) => {
    try {
      const { call_id, admin_id } = payload || {};
      console.log('[SOCKET-SERVER] call:cancel received:', { call_id, admin_id });
      if (!call_id) {
        console.warn('[SOCKET-SERVER] call:cancel missing call_id');
        return;
      }

      const call = activeCalls[call_id];
      if (!call) {
        console.warn('[SOCKET-SERVER] call:cancel - call not found for call_id:', call_id);
        return;
      }

      // Optional guard: only the call admin can cancel
      if (admin_id && String(call.admin_id || '').trim().toUpperCase() !== String(admin_id).trim().toUpperCase()) {
        console.warn('[SOCKET-SERVER] call:cancel rejected - admin_id mismatch', { expected: call.admin_id, got: admin_id });
        return;
      }

      // Mark all still-ringing participants as cancelled for admin UI
      call.participants = (call.participants || []).map((p) => {
        const status = String(p.status || 'ringing').toLowerCase();
        if (status === 'accepted' || status === 'declined') return p;
        return { ...p, status: 'cancelled' };
      });

      broadcastParticipantUpdate(call);
      broadcastCallCancelled(call, 'cancelled');

      // Cleanup active call after cancellation
      delete activeCalls[call_id];
    } catch (e) {
      console.error('[SOCKET-SERVER] call:cancel error:', e);
    }
  });

  socket.on('disconnect', () => {
    const userId = socket.data.user_id;
    if (userId) {
      removeSocketFromUser(userId, socket.id);
    }
    console.log('[SOCKET-SERVER] client disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  const originLog = allowedOrigins.length ? allowedOrigins.join(', ') : '*';
  console.log(`[SOCKET-SERVER] listening on port ${PORT} (CORS origins: ${originLog})`);
});

module.exports = { activeCalls };
