// chat.module.js — Chat System (WhatsApp-style)

const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

const PYTHON_API = process.env.PY_API_BASE || "http://localhost:5000/chat";

module.exports = (io) => {
  console.log("📨 Chat Module Loaded");

  // presence maps
  const userSockets = {};
  const onlineUsers = {};

  // delivery + sender tracking
  const messageAckMap = {};
  const messageSenderMap = {};
  const conversationMembers = {};

  // Helper: get conv members
  async function getMembers(conversation_id) {
    const cid = String(conversation_id);
    if (conversationMembers[cid]) return conversationMembers[cid];

    try {
      const res = await axios.get(`${PYTHON_API}/conversation-members/${cid}`);
      conversationMembers[cid] = res.data.members || [];
      return conversationMembers[cid];
    } catch {
      return [];
    }
  }

  io.on("connection", (socket) => {
    console.log("CHAT CONNECTED:", socket.id);

    // ----------------------------------------
    // REGISTER (renamed from register → chat_register)
    // ----------------------------------------
    socket.on("chat_register", ({ user_id }) => {
      if (!user_id) return;
      const uid = String(user_id);

      socket.data.user_id = uid;
      socket.join(uid);

      userSockets[uid] = userSockets[uid] || new Set();
      userSockets[uid].add(socket.id);

      onlineUsers[uid] = true;

      const payload = { user_id: uid, online: true };
      io.emit("chat_presence", payload);
      io.emit("user_presence", payload);
      console.log("CHAT REGISTERED:", uid);
    });

    // ----------------------------------------
    // JOIN ROOM
    // ----------------------------------------
    socket.on("join_room", ({ conversation_id }) => {
      socket.join(String(conversation_id));
      socket.emit("joined_room", { ok: true, conversation_id });
    });

    // ----------------------------------------
    // LEAVE ROOM
    // ----------------------------------------
    socket.on("leave_room", ({ conversation_id }) => {
      socket.leave(String(conversation_id));
      socket.emit("left_room", { ok: true, conversation_id });
    });

    // ----------------------------------------
    // SEND MESSAGE
    // ----------------------------------------
    socket.on("send_message", async (payload, ack) => {
      try {
        const res = await axios.post(`${PYTHON_API}/send-text`, payload);
        const msg = res.data;

        messageSenderMap[msg.message_id] = msg.sender_id;

        if (ack) ack({ status: "sent", message_id: msg.message_id });

        io.to(String(msg.conversation_id)).emit("new_message", msg);
      } catch (e) {
        if (ack) ack({ error: "failed" });
      }
    });

    // ----------------------------------------
    // FILE MESSAGE (socket upload metadata)
    // ----------------------------------------
    socket.on("send_file", async (data, ack) => {
      try {
        const res = await axios.post(`${PYTHON_API}/send-file`, data);
        const msg = res.data;

        messageSenderMap[msg.message_id] = msg.sender_id;

        if (ack) ack({ status: "sent", message_id: msg.message_id });

        io.to(String(msg.conversation_id)).emit("new_message", msg);
      } catch {
        if (ack) ack({ error: "failed" });
      }
    });

    // ----------------------------------------
    // RECEIVED ACK → DELIVERED (✓✓)
    // ----------------------------------------
    socket.on(
      "message_received",
      async ({ message_id, conversation_id, user_id }) => {
        const mid = String(message_id);
        const uid = String(user_id);
        const cid = String(conversation_id);

        messageAckMap[mid] = messageAckMap[mid] || new Set();
        messageAckMap[mid].add(uid);

        const members = await getMembers(cid);
        const sender = messageSenderMap[mid];
        const recipients = members.filter((m) => String(m.id) !== sender);

        const allDelivered = recipients.every((m) =>
          messageAckMap[mid].has(String(m.id))
        );

        if (allDelivered) {
          io.to(cid).emit("message_status_update", {
            message_id: mid,
            status: "delivered",
          });
        }
      }
    );

    // ----------------------------------------
    // MARK READ (✓✓ blue)
    // ----------------------------------------
    socket.on("mark_read", ({ conversation_id, user_id, message_ids }) => {
      const cid = String(conversation_id);
      (message_ids || []).forEach((mid) => {
        io.to(cid).emit("message_status_update", {
          message_id: mid,
          status: "seen",
        });
      });

      axios
        .post(`${PYTHON_API}/mark-read`, {
          conversation_id: cid,
          user_id,
          message_ids,
        })
        .catch(() => {});
    });

    // ----------------------------------------
    // EDIT MESSAGE
    // ----------------------------------------
    socket.on("edit_message", async (payload, ack) => {
      try {
        await axios.post(`${PYTHON_API}/edit-message`, payload);
        io.to(String(payload.conversation_id)).emit("message_edited", payload);
        if (ack) ack({ ok: true });
      } catch {
        if (ack) ack({ ok: false });
      }
    });

    // ----------------------------------------
    // DELETE MESSAGE
    // ----------------------------------------
    socket.on("delete_message", async (payload, ack) => {
      try {
        await axios.post(`${PYTHON_API}/delete-message`, payload);
        io.to(String(payload.conversation_id)).emit("message_deleted", payload);
        if (ack) ack({ ok: true });
      } catch {
        if (ack) ack({ ok: false });
      }
    });

    // ----------------------------------------
    // GROUP EVENTS
    // ----------------------------------------
    socket.on("group_add_members", (data) => {
      conversationMembers[data.conversation_id] = null;
      io.to(String(data.conversation_id)).emit("group_members_added", data);
    });

    socket.on("group_remove_members", (data) => {
      conversationMembers[data.conversation_id] = null;
      io.to(String(data.conversation_id)).emit("group_members_removed", data);
    });

    socket.on("rename_group", (data) => {
      io.to(String(data.conversation_id)).emit("group_renamed", data);
    });

    socket.on("leave_conversation", (data) => {
      io.to(String(data.conversation_id)).emit("user_left_conversation", data);
    });

    socket.on("typing", ({ conversation_id, sender_id }) => {
      const cid = String(conversation_id || "");
      if (!cid) return;
      io.to(cid).emit("typing", { conversation_id: cid, sender_id });
    });

    socket.on("stop_typing", ({ conversation_id, sender_id }) => {
      const cid = String(conversation_id || "");
      if (!cid) return;
      io.to(cid).emit("stop_typing", { conversation_id: cid, sender_id });
    });

    socket.on("subscribe_presence", ({ user_ids }) => {
      if (!Array.isArray(user_ids)) return;
      user_ids.forEach((uid) => {
        if (!uid) return;
        const id = String(uid);
        const online = !!onlineUsers[id];
        socket.emit("user_presence", {
          user_id: id,
          online,
          last_seen: new Date().toISOString(),
        });
      });
    });

    // ----------------------------------------
    // DISCONNECT
    // ----------------------------------------
    socket.on("disconnect", () => {
      const uid = socket.data.user_id;
      if (uid && userSockets[uid]) {
        userSockets[uid].delete(socket.id);
        if (userSockets[uid].size === 0) {
          onlineUsers[uid] = false;
          const payload = {
            user_id: uid,
            online: false,
            last_seen: new Date().toISOString(),
          };
          io.emit("chat_presence", payload);
          io.emit("user_presence", payload);
        }
      }
    });
  });
};
