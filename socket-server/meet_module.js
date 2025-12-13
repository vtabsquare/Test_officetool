// meet.module.js
// ----------------------------------------
// All Meet Socket Logic (Merged Chat + Meet Server)
// ----------------------------------------

const { v4: uuidv4 } = require("uuid"); // ✅ REQUIRED

module.exports = function attachMeetModule(io) {
  console.log("📞 Meet Module Loaded");

  // Store active calls globally in meet module
  const activeCalls = {};

  // ------------------------
  // HELPERS
  // ------------------------
  function createCall(payload) {
    let { call_id, admin_id, title, meet_url, participants } = payload;
    if (!call_id) call_id = uuidv4();

    const normalizedParticipants = (participants || []).map((p) => ({
      employee_id: p.employee_id || null,
      email: p.email,
      status: p.status || "ringing",
    }));

    const call = {
      call_id,
      admin_id,
      title: title || "Meeting",
      meet_url,
      participants: normalizedParticipants,
    };

    activeCalls[call_id] = call;
    return call;
  }

  function updateParticipantStatus(call_id, employee_id, email, status) {
    const call = activeCalls[call_id];
    if (!call) return null;

    let participant =
      call.participants.find((p) => p.employee_id === employee_id) ||
      call.participants.find((p) => p.email === email);

    if (!participant) {
      participant = {
        employee_id: employee_id || null,
        email: email || null,
        status,
      };
      call.participants.push(participant);
    } else {
      participant.status = status;
    }

    return call;
  }

  function broadcastParticipantUpdate(call) {
    const adminRoom = String(call.admin_id).toUpperCase();
    io.to(adminRoom).emit("call:participant-update", {
      call_id: call.call_id,
      participants: call.participants,
    });
  }

  // ------------------------
  // SOCKET EVENTS
  // ------------------------
  io.on("connection", (socket) => {
    console.log("MEET CONNECTED:", socket.id);

    socket.on("register", (payload) => {
      const userId = String(payload?.user_id).toUpperCase();
      socket.data.meet_user_id = userId;
      socket.join(userId);
      console.log("MEET USER REGISTERED:", userId, "socket:", socket.id);
    });

    // --- OPTIONAL if you use API /emit ---
    socket.on("call:ring", (payload) => {
      const { participants } = payload;
      if (!participants) return;
      participants.forEach((p) => {
        const room = String(p.employee_id || p.email).toUpperCase();
        io.to(room).emit("call:ring", payload);
      });
    });

    socket.on("call:accepted", (payload) => {
      const { call_id, employee_id, email } = payload;
      const call = updateParticipantStatus(
        call_id,
        employee_id,
        email,
        "accepted"
      );
      if (call) broadcastParticipantUpdate(call);
    });

    socket.on("call:declined", (payload) => {
      const { call_id, employee_id, email } = payload;
      const call = updateParticipantStatus(
        call_id,
        employee_id,
        email,
        "declined"
      );
      if (call) broadcastParticipantUpdate(call);
    });

    socket.on("disconnect", () => {
      console.log("MEET DISCONNECTED:", socket.id);
    });
  });

  return { activeCalls }; // optional
};
