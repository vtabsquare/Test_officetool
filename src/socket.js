import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:4000';

let socket = null;

export function connectSocket(userId, role = 'employee') {
  if (!socket) {
    console.log('[SOCKET] Connecting to:', SOCKET_URL);
    socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      withCredentials: false,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socket.on('connect', () => {
      console.log('[SOCKET] Connected successfully, socket.id=', socket.id);
      // Re-register on reconnect
      if (socket._userId) {
        console.log('[SOCKET] Re-registering user:', socket._userId);
        socket.emit('register', { user_id: socket._userId, role: socket._role || 'employee' });
      }
    });

    socket.on('connect_error', (err) => {
      console.error('[SOCKET] Connection error:', err.message);
    });

    socket.on('disconnect', (reason) => {
      console.warn('[SOCKET] Disconnected:', reason);
    });

    socket.on('reconnect', (attemptNumber) => {
      console.log('[SOCKET] Reconnected after', attemptNumber, 'attempts');
    });

    socket.on('reconnect_error', (err) => {
      console.error('[SOCKET] Reconnection error:', err.message);
    });
  }

  if (userId) {
    // Store for re-registration on reconnect
    socket._userId = userId;
    socket._role = role;
    console.log('[SOCKET] Registering user:', userId, 'role:', role);
    socket.emit('register', { user_id: userId, role });
  }
  return socket;
}

export function getSocket() {
  return socket;
}
