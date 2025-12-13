// chatapi.js
import { state } from "../state.js";

// ----------------------------
// API BASE (FLASK BLUEPRINT)
// ----------------------------
const CHAT_API_BASE = "http://localhost:5000/chat";

// ----------------------------
// INTERNAL FETCH WRAPPER
// ----------------------------
async function apiFetch(path, options = {}) {
  const token = state.user?.token || "";
  const headers = { ...(options.headers || {}) };

  if (!(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${CHAT_API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (res.status === 204) return null;

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

// --------------------------------------------------
// 1) SEARCH EMPLOYEES
// GET /chat/employees/search?q=...
// --------------------------------------------------
export async function searchEmployees(query) {
  if (!query) return [];

  try {
    const url = `${CHAT_API_BASE}/employees/search?q=${encodeURIComponent(
      query
    )}`;
    const res = await fetch(url);

    if (!res.ok) return [];

    const arr = await res.json();
    return arr.map((emp) => ({
      id: emp.id,
      name: emp.name,
      email: emp.email,
      avatar: emp.avatar || emp.name?.slice(0, 1)?.toUpperCase() || "U",
    }));
  } catch {
    return [];
  }
}

// --------------------------------------------------
// 1.1 FETCH ALL EMPLOYEES (Used for Add Members)
// --------------------------------------------------
export async function fetchAllEmployees() {
  try {
    const res = await fetch(`${CHAT_API_BASE}/employees/all`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

// --------------------------------------------------
// 2) START DIRECT CHAT
// POST /chat/direct
// --------------------------------------------------
export async function startDirectChat(targetUserId) {
  const user_id = state.user?.id;
  if (!user_id) throw new Error("User not found in state");

  return apiFetch(`/direct`, {
    method: "POST",
    body: JSON.stringify({ user_id, target_id: targetUserId }),
  });
}

// --------------------------------------------------
// 3) CREATE GROUP
// POST /chat/group
// --------------------------------------------------
export async function createGroupChat(name, members) {
  return apiFetch(`/group`, {
    method: "POST",
    body: JSON.stringify({
      name,
      members,
      creator_id: state.user.id,
    }),
  });
}

// --------------------------------------------------
// 4) FETCH USER'S CONVERSATIONS
// GET /chat/conversations/<user_id>
// --------------------------------------------------
export function fetchConversations() {
  const id = state.user?.id;
  if (!id) return [];
  return apiFetch(`/conversations/${id}`);
}

// --------------------------------------------------
// 5) FETCH ALL MESSAGES OF A CONVERSATION
// GET /chat/messages/<conversation_id>
// --------------------------------------------------
export function fetchMessagesForConversation(conversationId) {
  return apiFetch(`/messages/${conversationId}`);
}

// --------------------------------------------------
// 6) SEND TEXT MESSAGE
// POST /chat/send-text
// --------------------------------------------------
export function sendTextMessage(payload) {
  return apiFetch(`/send-text`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// --------------------------------------------------
// 7) SEND MEDIA FILE
// POST /chat/send-file
// --------------------------------------------------
export async function sendMediaMessageApi({
  conversation_id,
  sender_id,
  file,
  onProgress,
  onCancelRef,
}) {
  const form = new FormData();
  form.append("conversation_id", conversation_id);
  form.append("sender_id", sender_id);
  form.append("file", file);

  return sendWithProgress(form, { onProgress, onCancelRef });
}

// Upload with progress + cancel support
// Upload with progress + cancel support (WhatsApp-Style)
// Upload with progress + cancel support
export function sendWithProgress(formData, onProgress) {
  const xhr = new XMLHttpRequest();

  const promise = new Promise((resolve, reject) => {
    xhr.open("POST", `${CHAT_API_BASE}/send-file`, true);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        const percent = Math.round((e.loaded * 100) / e.total);
        onProgress(percent);
      }
    };

    xhr.onload = () => {
      if (xhr.status === 200) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (err) {
          reject(err);
        }
      } else {
        reject(xhr.responseText || "Upload failed");
      }
    };

    xhr.onerror = () => reject("Upload failed");
    // allow cross-site cookies if needed (optional, remove if not used)
    // xhr.withCredentials = true;
    xhr.send(formData);
  });

  // return both so caller can access xhr.abort() and await promise
  return { xhr, promise };
}

// --------------------------------------------------
// 8) EDIT MESSAGE
// PATCH /chat/messages/<message_id>
// --------------------------------------------------
export function editMessageApi(messageId, newText) {
  return apiFetch(`/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({ new_text: newText }),
  });
}

// --------------------------------------------------
// 9) DELETE MESSAGE (SOFT DELETE)
// DELETE /chat/messages/<message_id>
// --------------------------------------------------
export function deleteMessageApi(messageId) {
  return apiFetch(`/messages/${messageId}`, {
    method: "DELETE",
  });
}

// --------------------------------------------------
// 10) GROUP MEMBERS — FETCH
// GET /chat/group/<conversation_id>/members
// --------------------------------------------------
export function getGroupMembers(conversationId) {
  return apiFetch(`/group/${conversationId}/members`);
}

// --------------------------------------------------
// 11) ADD MEMBERS TO GROUP (ONE OR MANY)
// POST /chat/group/<conversation_id>/members/add
// --------------------------------------------------
export function addMembersToGroup(conversationId, memberIds) {
  return apiFetch(`/group/${conversationId}/members/add`, {
    method: "POST",
    body: JSON.stringify({ members: memberIds }),
  });
}

// --------------------------------------------------
// 12) REMOVE MULTIPLE MEMBERS
// POST /chat/group/<conversation_id>/members/remove
// --------------------------------------------------
export function removeMembersFromGroup(conversationId, memberIds) {
  return apiFetch(`/group/${conversationId}/members/remove`, {
    method: "POST", // IMPORTANT: MUST BE POST (DELETE BODY UNSUPPORTED)
    body: JSON.stringify({ members: memberIds }),
  });
}

// --------------------------------------------------
// 13) REMOVE SINGLE MEMBER
// DELETE /chat/group/<conversation_id>/members/<user_id>
// --------------------------------------------------
export function removeSingleMember(conversationId, userId) {
  return apiFetch(`/group/${conversationId}/members/${userId}`, {
    method: "DELETE",
  });
}

export function renameGroup(conversationId, newName) {
  return apiFetch(`/group/${conversationId}/rename`, {
    method: "PATCH",
    body: JSON.stringify({ name: newName }),
  });
}

export function deleteGroup(conversationId) {
  return apiFetch(`/group/${conversationId}`, {
    method: "DELETE",
  });
}

export function leaveDirectChat(conversationId, userId) {
  return apiFetch(`/direct/${conversationId}/${userId}`, {
    method: "DELETE",
  });
}
