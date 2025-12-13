// socketManager.js — Browser-side Socket.IO wrapper for Chat
// Used by pages/chats.js

import { io } from "socket.io-client";

let socket = null;

// Prefer dedicated chat socket URL, fall back to generic or localhost:4000 (same as meet)
const CHAT_SOCKET_URL =
  (typeof import.meta !== "undefined" &&
    import.meta.env &&
    (import.meta.env.VITE_CHAT_SOCKET_URL ||
      import.meta.env.VITE_SOCKET_URL)) ||
  "http://localhost:4000";

export function initSocket() {
  if (socket) return socket;

  console.log("[CHAT-SOCKET] Connecting to:", CHAT_SOCKET_URL);

  socket = io(CHAT_SOCKET_URL, {
    transports: ["websocket", "polling"],
    withCredentials: false,
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
  });

  socket.on("connect", () => {
    console.log("[CHAT-SOCKET] connected", socket.id);
  });

  socket.on("connect_error", (err) => {
    console.error("[CHAT-SOCKET] connect_error:", err?.message || err);
  });

  socket.on("disconnect", (reason) => {
    console.warn("[CHAT-SOCKET] disconnected:", reason);
  });

  if (typeof window !== "undefined") {
    window.chatSocket = socket;
  }

  return socket;
}

export function getSocket() {
  return socket;
}

// Thin wrapper over socket.emit with optional (err, res) style callback
export function emit(event, payload, callback) {
  const s = socket || initSocket();
  if (!s) return;

  if (typeof callback === "function") {
    s.emit(event, payload, (ack) => {
      if (ack && ack.error) {
        callback(ack, null);
      } else {
        callback(null, ack);
      }
    });
  } else {
    s.emit(event, payload);
  }
}

export function on(event, handler) {
  const s = socket || initSocket();
  if (!s || typeof s.on !== "function" || typeof handler !== "function") return;
  s.on(event, handler);
}

export function off(event, handler) {
  const s = socket;
  if (!s || typeof s.off !== "function") return;

  if (handler) {
    s.off(event, handler);
  } else {
    s.off(event);
  }
}
