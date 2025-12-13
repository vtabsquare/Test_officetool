// server.js — Unified Socket Server for Meet + Chat

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

// Create HTTP + Socket server
const app = express();
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json({ limit: "25mb" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// Attach modules
require("./chat_module")(io);
require("./meet_module")(io);

// HTTP bridge used by Python backend (emit_socket_event)
// Expects body: { event: string, data: any }
app.post("/emit", (req, res) => {
  try {
    const { event, data } = req.body || {};

    if (!event) {
      return res.status(400).json({ success: false, error: "event_required" });
    }

    console.log("[UNIFIED-SOCKET] /emit", { event, data });

    // Helper: emit to conversation room if id present, else broadcast
    const emitToConversation = (evt, payload) => {
      if (payload && payload.conversation_id) {
        const room = String(payload.conversation_id);
        io.to(room).emit(evt, payload);
      } else {
        io.emit(evt, payload);
      }
    };

    switch (event) {
      case "new_message": {
        emitToConversation("new_message", data);
        break;
      }

      case "conversation_created": {
        // Notify only involved members if provided, else broadcast
        const members = Array.isArray(data && data.members) ? data.members : [];
        if (members.length) {
          members.forEach((uid) => {
            if (!uid) return;
            io.to(String(uid)).emit("conversation_created", data);
          });
        } else {
          io.emit("conversation_created", data);
        }
        break;
      }

      case "group_add_members": {
        // Unified event name expected by frontend
        emitToConversation("group_members_added", data);
        break;
      }

      case "group_members_removed":
      case "group_remove_members": {
        emitToConversation("group_members_removed", data);
        break;
      }

      case "group_renamed": {
        emitToConversation("group_renamed", data);
        break;
      }

      case "group_deleted": {
        // Frontend listens to conversation_deleted
        emitToConversation("conversation_deleted", data);
        break;
      }

      case "direct_left": {
        // Map to same shape as leave_conversation → user_left_conversation
        emitToConversation("user_left_conversation", data);
        break;
      }

      case "message_edited": {
        io.emit("message_edited", data);
        break;
      }

      case "message_deleted": {
        io.emit("message_deleted", data);
        break;
      }

      default: {
        // Fallback: broadcast raw event name for any future extensions
        io.emit(event, data);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("[UNIFIED-SOCKET] /emit error", err);
    return res.status(500).json({ success: false, error: "internal_error" });
  }
});

// Start Server
const PORT = process.env.SOCKET_PORT || 4001;
server.listen(PORT, () => {
  console.log(`🚀 Unified Socket Server running on http://localhost:${PORT}`);
});

module.exports = io;
