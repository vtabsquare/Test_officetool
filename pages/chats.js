// pages/chat.js
import { renderModal, closeModal } from "../components/modal.js";
import { state } from "../state.js";
import {
  searchEmployees,
  startDirectChat,
  createGroupChat,
  fetchConversations, // from features/chatApi.js
  fetchMessagesForConversation,
  sendMediaMessageApi,
  fetchAllEmployees,
  addMembersToGroup,
  removeMembersFromGroup,
  renameGroup,
  deleteGroup,
  leaveDirectChat,
  sendWithProgress,
} from "../features/chatApi.js";

import {
  initSocket,
  getSocket,
  emit,
  on,
  off,
} from "../socket-server/socketManager.js";
/**
 * Converts any button into a loading-safe button.
 * Prevents double click and shows a spinner automatically.
 *
 * Usage:
 *    await runButtonWithLoading(btn, async () => {
 *        ... your API call ...
 *    });
 */
// tempId => xhr, used for cancel
// ✅ FRONTEND SPEED CACHE (SINGLE SOURCE FOR UI)
window.chatCache = {}; // { conversationId: [messages] }
window.conversationCache = []; // full left sidebar convo list
window.groupMemberCache = {}; // { conversationId: [members] }
window.currentConversationId = null;
let typingTimer = null;
let isTyping = false;
// ✅ Upload queues
window.pendingUploads = {}; // { tempId: { file, payload } }  — waiting to be sent (preview)
window.activeUploads = {}; // { tempId: xhr }                — uploading with XHR abort

const activeUploads = {};

export async function runButtonWithLoading(btn, fn) {
  if (!btn) return;

  // Prevent second click
  if (btn.dataset.loading === "true") return;

  btn.dataset.loading = "true";

  const originalHTML = btn.innerHTML;

  // Show loading UI
  btn.innerHTML = `<span class="spinner" style="
      border: 2px solid rgba(255,255,255,0.3);
      border-top: 2px solid white;
      border-radius: 50%;
      width: 14px; height: 14px;
      display: inline-block;
      animation: spin 0.8s linear infinite;
  "></span>`;
  btn.disabled = true;

  try {
    await fn(); // your API logic
  } finally {
    // Restore button state
    btn.innerHTML = originalHTML;
    btn.disabled = false;
    btn.dataset.loading = "false";
  }
}

// small notification sound (data URI placeholder)
const NOTIFY_SOUND =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEA..."; // replace with real if you want
let selectedMessageId = null;

export const renderChatPage = async () => {
  // 1) inject CSS if not present (keeps your design)
  if (!document.getElementById("chatStyles")) {
    const style = document.createElement("style");
    style.id = "chatStyles";
    style.innerHTML = `:root{
      --bg: #f6f8fb; /* page background */
      --surface: #ffffff; /* right panel background */
      --panel: #f5f7fb; /* left panel */
      --muted: #6b7280;
      --text: #0f1724;
      --primary: #6c63ff;
      --accent: #6b46ff;
      --border: rgba(15,23,36,0.06);
      --hover: rgba(15,23,36,0.03);
      --input-bg: rgba(15,23,36,0.03);
      --card: #ffffff;
    }

    /* -------------------------
       DARK MODE (exact variables you provided)
       To enable dark mode, add: document.body.classList.add('dark-mode')
       ------------------------- */
    .dark-mode{
      --bg:#0f1724; /* page background */
      --surface:#0b1220; /* right panel background */
      --panel:#0e1824; /* left panel */
      --muted:#88a0b3;
      --text:#e6eef6;
      --primary:#5b3df5;
      --accent:#6b46ff;
      --border: rgba(255,255,255,0.04);
      --hover: rgba(255,255,255,0.02);
      --input-bg: rgba(255,255,255,0.02);
      --card: #0b1220;
    }
      :root {
        /* Light mode */
        --bg: #f5f6fa;
        --surface: #ffffff;
        --panel: #ffffff;
        --card: #ffffff;
        --input-bg: #f0f2f5;

        --text: #1f2937;
        --muted: #6b7280;
        --primary: #5b3df5;
        --accent: #6b46ff;
        --border: rgba(0,0,0,0.12);
        --hover: rgba(0,0,0,0.04);
        }

        /* Dark mode override */
        [data-theme='dark'] {
        --bg:#0f1724;
        --surface:#0b1220;
        --panel:#0e1824;
        --card:#0b1220;
        --input-bg:rgba(255,255,255,0.05);

        --text:#e6eef6;
        --muted:#94a3b8;
        --border:rgba(255,255,255,0.08);
        --hover:rgba(255,255,255,0.06);
        }


    /* container */
    .chat-wrapper{
      display:flex;
      gap:16px;
      height: calc(100vh - 80px);
      padding: 18px;
      box-sizing: border-box;
      align-items:stretch;
      background: var(--bg);
    }

    /* left column */
    .chat-left{
      width: 300px;
      min-width: 260px;
      max-width: 340px;
      background: var(--panel);
      border-radius: 12px;
      border: 1px solid var(--border);
      overflow: hidden;
      display:flex;
      flex-direction:column;
      box-shadow: 0 6px 20px rgba(2,6,23,0.06);
    }

    .chat-left-header{
      display:flex;
      align-items:center;
      justify-content:space-between;
      padding:16px;
      font-weight:600;
      font-size:18px;
      color:var(--text);
      border-bottom:1px solid var(--border);
      background: linear-gradient(180deg, rgba(0,0,0,0.02), transparent);
    }

    #createNewChat{
      background: linear-gradient(180deg,var(--primary),var(--accent));
      border:none;
      color:white;
      width:44px;
      height:44px;
      border-radius:8px;
      display:flex;
      align-items:center;
      justify-content:center;
      box-shadow: 0 6px 18px rgba(91,61,245,0.08);
      cursor:pointer;
      font-size:16px;
    }

    .chat-search{
      padding: 14px;
      border-bottom:1px solid var(--border);
    }

    .chat-search input{
      width:100%;
      padding:12px 14px;
      border-radius:10px;
      background:var(--input-bg);
      border:1px solid rgba(0,0,0,0.04);
      color:var(--text);
      outline:none;
      font-size:14px;
      box-sizing:border-box;
    }

    .chat-list{
      flex:1;
      overflow:auto;
      padding:8px 6px;
    }

    .chat-item{
      display:flex;
      gap:12px;
      padding:10px 12px;
      align-items:center;
      border-radius:8px;
      cursor:pointer;
      transition: background .12s ease, transform .06s ease;
      color:var(--text);
    }

    .chat-item:hover{
      background: var(--hover);
      transform: translateY(-1px);
    }

    .chat-item.active{
      background: linear-gradient(90deg, rgba(91,61,245,0.12), rgba(107,70,255,0.05));
      box-shadow: inset 0 0 0 1px rgba(91,61,245,0.06);
    }

    .chat-avatar-sm{
      width:44px;
      height:44px;
      border-radius:10px;
      background:var(--primary);
      color:white;
      display:flex;
      align-items:center;
      justify-content:center;
      font-weight:700;
      font-size:16px;
      flex-shrink:0;
    }

    .chat-item .chat-meta{
      display:flex;
      flex-direction:column;
      gap:4px;
      width:100%;
    }

    .chat-item .chat-item-name{
      font-weight:600;
      font-size:14px;
      color:var(--text);
      display:flex;
      justify-content:space-between;
      align-items:center;
    }

    .chat-item .chat-item-last{
      font-size:12px;
      color:var(--muted);
      margin-top:2px;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      max-width:170px;
    }

    .notification-badge{
      background:#ef4444;
      color:white;
      padding:3px 8px;
      border-radius:12px;
      font-size:11px;
      margin-left:8px;
    }

    /* right column */
    .chat-right{
      flex:1;
      display:flex;
      flex-direction:column;
      background: var(--surface);
      border-radius:12px;
      border:1px solid var(--border);
      
      min-width:0;
      box-shadow: 0 6px 24px rgba(2,6,23,0.06);
    }

    /* header layout EXACT like requested */
    .chat-right-header{
      display:flex;
      align-items:center;
      gap:12px;
      position: relative;
      z-index: 5;
      padding:18px;
      border-bottom:1px solid var(--border);
      background: linear-gradient(180deg, rgba(0,0,0,0.02), transparent);
    }

    .chat-avatar-lg{
      width:56px;
      height:56px;
      border-radius:50%;
      background:var(--primary);
      display:flex;
      align-items:center;
      justify-content:center;
      color:white;
      font-weight:700;
      font-size:20px;
      flex-shrink:0;
    }

    .chat-header-main{
      display:flex;
      flex-direction:column;
      gap:4px;
      min-width:0;
      overflow:hidden;
    }

    .chat-right-name{
      font-weight:700;
      color:var(--text);
      font-size:18px;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }

    .chat-right-status{
      font-size:13px;
      color:var(--muted);
    }

    .chat-header-actions{
      margin-left:auto;
      display:flex;
      gap:10px;
      align-items:center;
    }

    .header-icon{
      width:40px;
      height:40px;
      border-radius:8px;
      display:flex;
      align-items:center;
      justify-content:center;
      background:var(--panel);
      border:1px solid var(--border);
      color:var(--muted);
      cursor:pointer;
    }

    .header-info-btn{
      width:44px;
      height:44px;
      border-radius:50%;
      background: transparent;
      border:1px solid var(--border);
      display:flex;
      align-items:center;
      justify-content:center;
      color:var(--muted);
      cursor:pointer;
    }

    /* typing / presence small text on header-right */
    .typing-indicator{
      font-size:13px;
      color:var(--muted);
    }

    /* messages */
    .chat-messages{
      flex:1;
      overflow:auto;
      padding:22px;
      background: linear-gradient(180deg, transparent, rgba(0,0,0,0.02));
    }

    .chat-placeholder{
      text-align:center;
      margin-top:90px;
      color:var(--muted);
    }

    .chat-msg{
      display:inline-block;
      padding:10px 14px;
      border-radius:14px;
      margin-bottom:12px;
      word-wrap:break-word;
      max-width:68%;
      font-size:14px;
      line-height:1.35;
    }

    .msg-sent{
      margin-left:auto;
      background: linear-gradient(180deg,var(--primary),var(--accent));
      color:white;
      border-bottom-right-radius:6px;
    }

    .msg-received{
      background: var(--card);
      color:var(--text);
      border-bottom-left-radius:6px;
      border:1px solid var(--border);
    }

    .msg-content{ display:block; }

    .msg-ticks{
      font-size:12px;
      margin-left:8px;
      color: var(--muted);
    }

    /* header search + input area */
    .messages-search-bar{
      padding:12px 18px;
      border-top:1px solid var(--border);
      display:flex;
      gap:12px;
      align-items:center;
      justify-content:flex-end;
    }

    .messages-search-bar .chat-header-search-box{
      display:flex;
      align-items:center;
      gap:8px;
      padding:8px 10px;
      border-radius:12px;
      border:1px solid var(--border);
      background:var(--input-bg);
      color:var(--text);
    }

    .messages-search-bar input{
      padding:8px;
      border:none;
      outline:none;
      background:transparent;
      color:var(--text);
      width:260px;
    }

    .clear-btn{
      background:transparent;
      border:1px solid rgba(0,0,0,0.04);
      color:var(--muted);
      padding:8px 14px;
      border-radius:20px;
      cursor:pointer;
    }

    .chat-input{
      padding:14px 18px;
      display:flex;
      gap:10px;
      align-items:center;
      border-top:1px solid var(--border);
      background: linear-gradient(0deg, rgba(0,0,0,0.02), transparent);
    }

    .icon-btn{
      width:46px;
      height:46px;
      border-radius:10px;
      background:var(--panel);
      border:1px solid var(--border);
      display:flex;
      align-items:center;
      justify-content:center;
      cursor:pointer;
      color:var(--muted);
    }

    .chat-input input[type="text"]{
      flex:1;
      padding:14px 16px;
      border-radius:12px;
      border:1px solid rgba(0,0,0,0.04);
      background:var(--input-bg);
      color:var(--text);
      outline:none;
      font-size:15px;
    }

    .send-btn{
      width:54px;
      height:54px;
      border-radius:12px;
      background: linear-gradient(180deg,var(--primary),var(--accent));
      border:none;
      color:white;
      display:flex;
      align-items:center;
      justify-content:center;
      cursor:pointer;
      box-shadow: 0 8px 24px rgba(91,61,245,0.08);
      font-size:18px;
    }

    /* media menu (anchored near header) */
    #mediaMenu {
      position: fixed !important;
      display: none;
      flex-direction: column;
      gap: 8px;

      width: 160px;
      padding: 10px;
      border-radius: 10px;

      background: var(--panel);
      border: 1px solid var(--border);
      z-index: 5000 !important;   /* stays above UI */
    }



    .media-option:hover{
      background: linear-gradient(90deg, rgba(91,61,245,0.08), rgba(107,70,255,0.04));
    }

    /* file preview / video sizing inside messages */
    .chat-msg img, .chat-msg video{
      max-width:420px;
      border-radius:10px;
      display:block;
    }

    /* responsive tweaks */
    @media (max-width: 980px){
      .chat-left{ width:260px; }
      .media-menu{ right: 60px; top: 66px; }
    }

    @media (max-width: 720px){
      .chat-wrapper{ padding:12px; gap:6px; }
      .chat-left{ display:none; }
      .chat-right{ border-radius:10px; }
    }
    /* ------------------------------ */
    /* MESSAGE BUBBLES (final fixed)  */
    /* ------------------------------ */

    .chat-msg {
      position: relative;
      padding: 12px 16px;
      margin: 6px 0;
      max-width: 70%;
      font-size: 15px;
      line-height: 1.4;
      border-radius: 16px;
      display: inline-block;
      word-break: break-word;
    }

    /*** MY MESSAGE (RIGHT SIDE) ***/
    .msg-sent {
      background: linear-gradient(180deg, var(--primary), var(--accent));
      color: white;
      margin-left: auto;                /* push to right */
      border-bottom-right-radius: 6px;  /* WhatsApp style */
    }

    /*** OTHER USER MESSAGE (LEFT SIDE) ***/
    .msg-received {
      background: var(--card);
      color: var(--text);
      margin-right: auto;                /* push to left */
      border: 1px solid var(--border);
      border-bottom-left-radius: 6px;    /* WhatsApp style */
    }

    /*** MESSAGE SPACING FIX ***/
    .chat-messages .chat-msg {
      display: flex;
      flex-direction: column;
    }

    /*** FILE / IMAGE / VIDEO inside bubble ***/
    .chat-msg img,
    .chat-msg video {
      max-width: 260px;
      border-radius: 12px;
    }
    /* -------------------------------------------------- */
    /*   WhatsApp-style message bubble (auto width)       */
    /* -------------------------------------------------- */

    .chat-msg {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 10px 14px;
      margin: 6px 0;
      border-radius: 16px;
      max-width: 75%;              /* bubble auto grows */
      width: fit-content;          /* bubble auto shrinks */
      word-break: break-word;      /* wrap long lines */
      line-height: 1.35;
    }

    /* SENT (RIGHT) */
    .msg-sent {
      background: linear-gradient(180deg, var(--primary), var(--accent));
      color: white;
      margin-left: auto;
      border-bottom-right-radius: 6px;
    }

    /* RECEIVED (LEFT) */
    .msg-received {
      background: var(--card);
      color: var(--text);
      margin-right: auto;
      border: 1px solid var(--border);
      border-bottom-left-radius: 6px;
    }

    /* Message text */
    .msg-text {
      display: inline-block;
      white-space: pre-wrap;
    }

    /* Tick style */
    .msg-tick {
      font-size: 14px;
      opacity: 0.8;
      margin-left: 6px;
      display: inline-block;
      align-self: flex-end;
    }
    /* Left-side chat list - clean 3 dot button */
.chat-item-more {
    background: transparent;
    border: none;
    padding: 4px;
    margin-left: 8px;
    cursor: pointer;
    opacity: 0.6;
    color: #bbb;
    border-radius: 6px;
}

.chat-item-more:hover {
    opacity: 1;
    background: rgba(255,255,255,0.08);
}
.floating-chat-item-menu {
    position: absolute;
    background: #1f1f2e;
    color: #fff;
    padding: 6px 0;
    border-radius: 8px;
    box-shadow: 0px 4px 14px rgba(0,0,0,0.35);
    min-width: 150px;
    font-size: 14px;
    z-index: 9999;
}

.floating-chat-item-menu button {
    width: 100%;
    padding: 10px 16px;
    background: transparent;
    border: none;
    color: #fff;
    text-align: left;
    cursor: pointer;
    font-size: 14px;
}

.floating-chat-item-menu button:hover {
    background: rgba(255,255,255,0.08);
}
    .msg-actions-menu {
  position: absolute;
  background: #1f1f2e; 
  color: white;
  border-radius: 8px;
  min-width: 140px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.35);
  z-index: 9999;
  padding: 6px 0;
}

.msg-actions-menu button {
  width: 100%;
  padding: 10px 14px;
  background: transparent;
  border: none;
  text-align: left;
  cursor: pointer;
  color: white;
  font-size: 14px;
}

.msg-actions-menu button:hover {
  background: rgba(255,255,255,0.08);
}

.msg-content.deleted {
  font-style: italic;
  color: #888 !important;
}
.group-info-container {
  padding: 20px;
  color: var(--text);
}

.divider {
  border: 0;
  border-top: 1px solid rgba(255,255,255,0.1);
  margin: 10px 0 20px;
}

.section-title {
  margin-bottom: 10px;
  font-size: 18px;
  font-weight: bold;
}

.member-list {
  max-height: 260px;
  overflow-y: auto;
  margin-bottom: 20px;
}

.group-member-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  font-size: 15px;
}

.actions-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.temp-msg-actions {
  background-color: var(--card-bg);
  color: var(--text);
  border: 1px solid var(--border);
  padding: 8px 10px;
  border-radius: 8px;
}
.temp-msg-actions div:hover {
  background: var(--hover);
}
/* =======================================
   MODERN MESSAGE BUBBLES (WhatsApp Style)
======================================= */

/* Base bubble container */
.chat-msg {
    max-width: 75%;
    padding: 8px 12px;
    border-radius: 14px;
    margin: 8px 0;
    position: relative;
    display: inline-block;
    line-height: 1.4;
}

/* Outgoing message (mine) */
.msg-sent {
    background: #d1f8ff; /* WhatsApp-teal-like blue tone */
    color: #063146;
    border-bottom-right-radius: 4px;
    align-self: flex-end;
    margin-left: auto;
    box-shadow: 0 1px 3px rgba(0,0,0,0.12);
}

/* Incoming message */
.msg-received {
    background: #ffffff;
    color: #111;
    border-bottom-left-radius: 4px;
    align-self: flex-start;
    margin-right: auto;
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
}

/* Dark mode colors */
body.dark .msg-sent {
    background: #075e54;
    color: #e8fdf9;
}

body.dark .msg-received {
    background: #2a2f32;
    color: #dbdbdb;
}

/* Sender name (group only) */
.msg-sender-name {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 4px;
    color: var(--primary);
}

body.dark .msg-sender-name {
    color: #9ad1ff;
}

/* Message text */
.msg-content {
    font-size: 14px;
    white-space: pre-wrap;
    word-break: break-word;
}

/* Timestamp (inside bubble bottom-right) */
.msg-time {
    font-size: 11px;
    color: var(--muted);
    opacity: 0.8;
    margin-top: 4px;
    text-align: right;
}

body.dark .msg-time {
    color: #cfcfcf;
    opacity: 0.6;
}
.chat-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px;
  border-bottom: 1px solid rgba(255,255,255,0.05);
  position: relative;
}

.chat-meta {
  flex: 1;
}

.chat-item-name-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.chat-time {
  font-size: 12px;
  opacity: 0.6;
}

.chat-item-preview {
  font-size: 13px;
  color: var(--muted);
  margin-top: 2px;
  max-width: 200px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.chat-item-more {
  background: transparent;
  border: none;
  color: var(--muted);
  cursor: pointer;
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
}


/* message bubble metadata (time + tick) */
.msg-meta-row {
  display: flex;
  align-items: center;
  justify-content: flex-end; /* align to right edge of bubble */
  gap: 8px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--muted);
}

/* time label */
.msg-time {
  padding-right: 4px;
  color: var(--muted);
  font-size: 12px;
}

/* the tick icon (single) */
.msg-tick {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  font-size: 12px;
  opacity: 0.85;
}

/* small adjustment to ensure bubble content doesn't wrap weirdly */
.chat-msg .msg-content {
  white-space: pre-wrap;
  word-break: break-word;
}

/* date separator between messages */
.chat-date-sep {
  width: 100%;
  display: flex;
  justify-content: center;
  margin: 12px 0;
  font-size: 12px;
  color: var(--muted);
}
.chat-date-sep .pill {
  background: rgba(255,255,255,0.03);
  padding: 6px 12px;
  border-radius: 20px;
  color: var(--muted);
  font-weight: 500;
  font-size: 12px;
}
/* ================================
   ✅ MODAL OVERLAY
================================ */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

/* ================================
   ✅ MODAL CONTAINER
================================ */
.modal {
  width: 420px;
  max-width: 92vw;
  background: linear-gradient(180deg, #0f172a, #020617);
  border-radius: 18px;
  overflow: hidden;
  box-shadow: 0 25px 80px rgba(0, 0, 0, 0.75);
  animation: modalFade 0.25s ease;
}

@keyframes modalFade {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* ================================
   ✅ MODAL HEADER
================================ */
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  font-size: 18px;
  font-weight: 700;
  color: #fff;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.modal-header button {
  background: transparent;
  border: none;
  color: rgba(255,255,255,0.6);
  font-size: 22px;
  cursor: pointer;
}

.modal-header button:hover {
  color: #fff;
}

/* ================================
   ✅ MODAL BODY
================================ */




/* ================================
   ✅ SEARCH INPUT
================================ */
#empSearchInput {
  width: 100%;
  padding: 11px 12px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.15);
  background: rgba(15, 23, 42, 0.9);
  color: #fff;
  outline: none;
  grid-column: 1 / 2;
}

/* ================================
   ✅ EMPLOYEE LIST
================================ */
#empListBox {
  max-height: 240px;
  overflow-y: auto;
  border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(2, 6, 23, 0.95);
  padding: 6px;
  grid-column: 2 / 3;
}

/* Scrollbar */
#empListBox::-webkit-scrollbar {
  width: 6px;
}
#empListBox::-webkit-scrollbar-thumb {
  background: rgba(139,92,246,0.6);
  border-radius: 8px;
}

/* ================================
   ✅ EMPLOYEE ROW
================================ */
#empListBox div {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: 0.2s;
}

#empListBox div:hover {
  background: rgba(139,92,246,0.12);
}

/* ================================
   ✅ ACTION BUTTON ROW
================================ */
.modal-body > div:last-child {
  display: flex;
  gap: 14px;
  margin-top: 16px;
}

/* ================================
   ✅ DIRECT / GROUP BUTTONS
================================ */
#directChatBtn,
#groupChatBtn {
  flex: 1;
  height: 44px;
  border-radius: 12px;
  font-size: 14.5px;
  font-weight: 600;
  cursor: pointer;
  transition: 0.25s;
  border: none;
}

/* Direct = outline */
#directChatBtn {
  background: transparent;
  border: 2px solid #8b5cf6;
  color: #8b5cf6;
}

/* Group = gradient */
#groupChatBtn {
  background: linear-gradient(135deg, #6c63ff, #8b5cf6);
  color: white;
  box-shadow: 0 8px 22px rgba(108, 99, 255, 0.45);
}

/* Hover */
#directChatBtn:hover:not(:disabled),
#groupChatBtn:hover:not(:disabled) {
  transform: translateY(-1px);
}

/* Disabled */
#directChatBtn:disabled,
#groupChatBtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  box-shadow: none;
  transform: none;
}

/* ================================
   ✅ KILL CANCEL & SAVE FOREVER
================================ */
.modal-footer,
.modal-footer * {
  display: none !important;
}

.modal-body > div:last-child {
  
  display: flex;
  justify-content: center;
  gap: 14px;
  margin-top: 18px;
}
  /* ✅ PLUS BUTTON LOADING STATE */
.loading-btn {
  position: relative;
  pointer-events: none;
  opacity: 0.7;
}

/* ✅ SPINNER CIRCLE */
.loading-btn::after {
  content: "";
  position: absolute;
  width: 18px;
  height: 18px;
  border: 2.5px solid rgba(255, 255, 255, 0.4);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

@keyframes spin {
  to {
    transform: rotate(360deg) translate(-50%, -50%);
  }
}
/* ================================
   ✅ LIGHT THEME SUPPORT (FIXED)
   Works with: data-theme="dark"
================================ */

/* DEFAULT LIGHT MODE (no data-theme attribute) */
.modal {
  background: linear-gradient(180deg, #ffffff, #f1f5f9);
  color: #0f172a;
  box-shadow: 0 20px 60px rgba(0,0,0,0.15);
}

.modal-header {
  color: #0f172a;
  border-bottom: 1px solid rgba(0,0,0,0.1);
}

.modal-header button {
  color: rgba(0,0,0,0.6);
}

/* Search input */
#empSearchInput {
  background: #f8fafc;
  color: #0f172a;
  border: 1px solid rgba(0,0,0,0.2);
}

/* Employee list */
#empListBox {
  background: #ffffff;
  border: 1px solid rgba(0,0,0,0.15);
}

/* Employee rows */
#empListBox div {
  color: #0f172a;
}

#empListBox div:hover {
  background: rgba(99,102,241,0.12);
}

/* Buttons */
#directChatBtn {
  color: #4f46e5;
  border: 2px solid #4f46e5;
}

#groupChatBtn {
  background: linear-gradient(135deg, #4f46e5, #6366f1);
  color: white;
}

/* Disabled buttons */
#directChatBtn:disabled,
#groupChatBtn:disabled {
  opacity: 0.5;
}


/* ================================
   ✅ DARK MODE OVERRIDE ONLY
================================ */
[data-theme='dark'] .modal {
  background: linear-gradient(180deg, #0f172a, #020617);
  color: #ffffff;
  box-shadow: 0 25px 80px rgba(0, 0, 0, 0.75);
}

[data-theme='dark'] .modal-header {
  color: #ffffff;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

[data-theme='dark'] #empSearchInput {
  background: rgba(15, 23, 42, 0.9);
  color: #ffffff;
  border: 1px solid rgba(255,255,255,0.15);
}

[data-theme='dark'] #empListBox {
  background: rgba(2, 6, 23, 0.95);
  border: 1px solid rgba(255,255,255,0.12);
}

[data-theme='dark'] #empListBox div {
  color: #ffffff;
}

[data-theme='dark'] #directChatBtn {
  color: #8b5cf6;
  border-color: #8b5cf6;
}

[data-theme='dark'] #groupChatBtn {
  background: linear-gradient(135deg, #6c63ff, #8b5cf6);
}

.msg-sender-name {
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 4px;
}
/* ✅ GROUP MEMBERS SINGLE LINE + HOVER EXPAND */
#chatHeaderSub {
  max-width: 260px;          /* control width */
  white-space: nowrap;      /* prevent line break */
  overflow: hidden;         /* hide overflow */
  text-overflow: ellipsis;  /* show ... */
  display: block;
  cursor: pointer;
}

/* ✅ Show full members on hover */
#chatHeaderSub:hover {
  white-space: normal;
  overflow: visible;
  background: var(--panel);
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  box-shadow: 0 6px 18px rgba(0,0,0,0.25);
  position: absolute;
  z-index: 1000;
  max-width: 420px;
}
/* ✅ ONLY APPLY GRID TO CREATE CHAT MODAL */
.modal.create-chat .modal-body {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 16px;
}

.modal.create-chat .modal-body > div:last-child {
  grid-column: 1 / 3;
}
/* ✅ ONLY apply grid to Create Chat modal */
.modal.create-chat .modal-body {
  padding: 16px 20px;
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 16px;
  align-items: start;
}

/* ✅ RESET Group Info & Add Members layout (NO GRID, NO GAP) */
.modal:not(.create-chat) .modal-body {
  display: block !important;
  padding: 12px 20px !important;
}

.group-info-container {
  margin-top: 0 !important;
  padding-top: 0 !important;
}

/* ✅ Remove top gap above Add Members search */
#searchAddMember {
  margin-top: 0 !important;
}
/* ✅ GROUP SYSTEM MESSAGE STYLE */
.chat-msg.system-msg {
  background: transparent;
  color: var(--muted);
  text-align: center;
  font-size: 13px;
  margin: 14px auto;
  padding: 6px 12px;
  border-radius: 10px;
  border: 1px dashed var(--border);
  max-width: 70%;
}
.chat-system-msg {
  width: 100%;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
  margin: 12px 0;
  font-style: italic;
}
/* =========================================
   ✅ FINAL HARD RESET — REMOVE ALL TOP SPACE
========================================= */

/* Kill all inherited modal body spacing */
.modal:not(.create-chat) .modal-body {
  padding-top: 0 !important;
  margin-top: 0 !important;
  display: block !important;
}

/* Kill Group Info container gap */
.group-info-container {
  padding-top: 0 !important;
  margin-top: 0 !important;
}

/* Kill Add Members container gap */
.add-members-container {
  padding-top: 0 !important;
  margin-top: 0 !important;
}

/* Kill search box top margin */
#searchAddMember,
#empSearchInput {
  margin-top: 0 !important;
}

/* Kill first child auto-margin inside modal */
.modal-body > *:first-child {
  margin-top: 0 !important;
  padding-top: 0 !important;
}
/* =========================================
   ✅ FINAL FIX — GROUP INFO ALIGNMENT CUT
========================================= */

/* FORCE Group Info to use simple vertical layout */
.modal:not(.create-chat) .modal-body {
  display: block !important;
  padding: 20px !important;
}

/* Ensure Group Info content is fully visible */
.group-info-container {
  width: 100% !important;
  max-width: 100% !important;
  display: block !important;
  margin: 0 auto !important;
}

/* Fix Members + Buttons row alignment */
.group-info-container .actions-row {
  display: flex !important;
  justify-content: center !important;
  gap: 16px !important;
  margin-top: 20px !important;
}

/* Prevent content being pushed left off-screen */
.group-info-container * {
  box-sizing: border-box;
  max-width: 100%;
}

/* =========================================
   ✅ FIX: REMOVE UNWANTED MODAL SCROLL
   (Keeps scroll ONLY inside list)
========================================= */

/* Prevent modal itself from scrolling */
.modal {
  overflow: hidden !important;
}

/* Allow scroll ONLY for employee list */
#empListBox {
  max-height: 320px !important;
  overflow-y: auto !important;
}

/* Prevent Add Members container from forcing scroll */
.modal:not(.create-chat) .modal-body {
  max-height: none !important;
  overflow: hidden !important;
}
.modal.add-members .modal-body {
  display: grid;
  grid-template-columns: 1fr 2fr;
}
.modal.add-members .member-list {
  max-height: 340px;
  overflow-y: auto;
  padding-right: 6px;
}
.system-message {
  text-align: center;
  color: #9aa4b2;
  font-size: 12px;
  margin: 10px 0;
  font-style: italic;
}
.upload-bar {
  width: 100%;
  height: 4px;
  background: #e5e7eb;
  border-radius: 5px;
  margin-top: 5px;
  overflow: hidden;
}

.upload-progress {
  height: 100%;
  background: linear-gradient(to right, #22c55e, #3b82f6);
  width: 0%;
  transition: width 0.3s ease;
}

.upload-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.chat-msg.uploading {
  opacity: 0.8;
}

.chat-msg.failed {
  border: 1px solid red;
  opacity: 1;
}
.upload-bar {
  width: 100%;
  height: 4px;
  background: rgba(255,255,255,0.2);
  border-radius: 3px;
  overflow: hidden;
  margin-top: 5px;
}

.upload-progress-inner {
  width: 0%;
  height: 100%;
  background: #4ade80;
  transition: width 0.2s linear;
}
/* WhatsApp-like circular progress ring */
.progress-ring__circle {
  transform: rotate(-90deg);
  transform-origin: 50% 50%;
  stroke: #60a5fa; /* default accent */
  stroke-linecap: round;
  transition: stroke-dashoffset 0.15s linear, stroke 0.15s;
}
.wh-preview-modal .wh-preview-box { color: var(--text); }
.wh-preview-modal .btn-primary { background: #5b21b6; color: #fff; border: none; }
.wh-preview-modal .btn-secondary { background: transparent; border: 1px solid rgba(255,255,255,0.06); color: var(--muted); }
.upload-circle { display:inline-flex; align-items:center; justify-content:center; width:44px; height:44px; }
.wa-download {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: rgba(0,0,0,0.15);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  margin-top: 6px;
}

.wa-downloaded {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #1dd75f;
  margin-top: 6px;
}

.wa-download i,
.wa-downloaded i {
  font-size: 18px;
  pointer-events: none;
}


    `;
    document.head.appendChild(style);
  }

  // 2) Render main HTML (keeps your original markup)
  document.getElementById("app-content").innerHTML = `
  <div class="chat-wrapper">

    <!-- LEFT SIDEBAR -->
    <div class="chat-left">
      <div class="chat-left-header"  style="padding:12px 16px; height:70px;">
        <div>Chats</div>
        <button id="createNewChat" title="New chat">
          <i class="fa-solid fa-plus"></i>
        </button>
      </div>

      <div class="chat-search"  style="padding:12px 16px; height:70px;">
        <input type="text" id="chatSearchInput" placeholder="Search chats..." />
      </div>

      <div class="chat-list" id="chatList"></div>
    </div>

    <!-- RIGHT SIDE -->
    <div class="chat-right">

      <!-- HEADER -->
      <div class="chat-right-header" style="padding:12px 16px; height:70px;">
        
        <div class="chat-avatar-lg" id="chatHeaderAvatar" style="width:48px;height:48px;font-size:18px;">?</div>
        <button id="chatOptionsBtn" class="icon-btn">
            <i class="fa-solid fa-ellipsis-vertical"></i>
        </button>


        <!-- REPLACE the duplicated header-sub elements with this single element -->
        <div class="chat-header-main">
          <div class="chat-right-name" id="chatUserName" style="font-size:16px;">Select a chat</div>
          <!-- SINGLE members / status element (clickable if group) -->
          <div class="chat-header-sub" id="chatHeaderSub" style="font-size:12px;color:var(--muted); margin-top:2px; cursor:default;">
            ---
          </div>
        </div>



        <div class="chat-header-actions">
          <div class="messages-search-bar" id="headerSearchWrap" style="display:flex;align-items:center;gap:8px;">
            <div class="chat-header-search-box" id="headerSearchBox" 
                 style="display:flex;align-items:center;padding:6px 10px;border-radius:8px;">
              <i class="fa-solid fa-magnifying-glass" style="color:var(--muted);font-size:13px;"></i>
              <input id="searchMessagesHeader" placeholder="Search messages..."
                     style="background:transparent;border:none;outline:none;padding:4px 6px;font-size:13px;width:160px;" />
            </div>
            <button id="clearSearchMessages" class="clear-btn" 
                    style="padding:6px 12px;font-size:12px;">Clear</button>
          </div>

          <div id="typingIndicator" class="typing-indicator" style="display:none;font-size:12px;margin-left:10px;">typing...</div>
          <div id="presenceIndicator" style="font-size:12px;color:var(--muted);margin-left:6px;"></div>

        </div>
      </div>

      <!-- MESSAGES AREA -->
      <div class="chat-messages" id="chatMessages">
        <div class="chat-placeholder">
          <i class="fa-solid fa-comments" style="font-size:38px;margin-bottom:10px;color:var(--muted)"></i>
          <p style="color:var(--muted);font-size:14px;">Select a chat to start messaging</p>
        </div>
      </div>

      <!-- BOTTOM INPUT BAR -->
      <!-- BOTTOM INPUT BAR -->
<div class="chat-input" id="bottomInputBar">

  <!-- TYPE input first -->
  <input id="chatMessageInput" type="text" placeholder="Type a message..." />

  <!-- MEDIA button second -->
  <div style="position:relative;">
    <button id="mediaMenuBtn" class="icon-btn" title="Attach">
      <i class="fa-solid fa-paperclip"></i>
    </button>

    <!-- ATTACHMENT DROPDOWN -->
        <div id="mediaMenu" class="media-menu" style="display:none; position:fixed;">
          <button class="media-option" id="uploadImageBtn"><i class="fa-solid fa-image"></i> Image</button>
          <button class="media-option" id="uploadVideoBtn"><i class="fa-solid fa-video"></i> Video</button>
          <button class="media-option" id="uploadFileBtn"><i class="fa-solid fa-file"></i> File</button>
          <button class="media-option" id="recordVoiceBtn"><i class="fa-solid fa-microphone"></i> Voice</button>
        </div>
      </div>
      <input type="file" id="hiddenImageInput" accept="image/*" style="display:none;" />
      <input type="file" id="hiddenVideoInput" accept="video/*" style="display:none;" />
      <input type="file" id="hiddenFileInput" style="display:none;" />


      <!-- SEND button last -->
      <button id="sendMessageBtn" class="send-btn" title="Send">
        <i class="fa-solid fa-paper-plane"></i>
      </button>
      <!-- MESSAGE CONTEXT MENU -->
      <div id="messageMenu" class="message-menu" style="display:none; position:absolute; background:white; border:1px solid #ccc; border-radius:6px; z-index:9999;">
          <button id="editMessageBtn">Edit</button>
          <button id="deleteMessageBtn">Delete</button>
      </div>

      <!-- CHAT OPTIONS MENU (header three-dot menu) -->
      <div id="chatOptionsMenu" class="chat-options-menu" style="display:none; position:absolute; background:white; border:1px solid #ccc; border-radius:6px; z-index:9999;">
          <button id="renameGroupBtn">Rename Group</button>
          <button id="deleteChatBtn">Delete Chat</button>
      </div>


    </div>

  </div>
`;
  // hide header 3-dots (if present)
  const headerBtn = document.getElementById("chatOptionsBtn");
  if (headerBtn) headerBtn.style.display = "none";

  // // for safety
  // // for safety
  // // Put this helper near initChatDOMListeners (same file, above or below)
  // function openFilePreviewModal(file) {
  //   if (!file) return;

  //   const isImage = file.type.startsWith("image/");
  //   const isVideo = file.type.startsWith("video/");
  //   const isAudio = file.type.startsWith("audio/");

  //   // create preview HTML
  //   let previewHtml = `<div style="text-align:center;margin-bottom:10px;">`;
  //   if (isImage) {
  //     const url = URL.createObjectURL(file);
  //     previewHtml += `<img src="${url}" style="max-width:640px;max-height:360px;border-radius:8px;display:block;margin:0 auto;"/>`;
  //   } else if (isVideo) {
  //     const url = URL.createObjectURL(file);
  //     previewHtml += `<video controls style="max-width:640px;max-height:360px;display:block;margin:0 auto;"><source src="${url}"></video>`;
  //   } else if (isAudio) {
  //     const url = URL.createObjectURL(file);
  //     previewHtml += `<audio controls src="${url}" style="display:block;margin:0 auto;"></audio>`;
  //   } else {
  //     previewHtml += `<div style="padding:18px;border-radius:8px;background:var(--muted-bg);">${escapeHtml(
  //       file.name
  //     )}</div>`;
  //   }
  //   previewHtml += `</div>`;

  //   // render modal
  //   renderModal(
  //     "Preview",
  //     `<div>${previewHtml}</div>`,
  //     [
  //       { id: "cancelPreview", text: "Cancel", className: "btn-secondary" },
  //       { id: "sendPreview", text: "Send", className: "btn-primary" },
  //     ],
  //     "medium"
  //   );

  //   // attach handlers
  //   document.getElementById("cancelPreview").onclick = () => {
  //     closeModal();
  //     // release blob object URLs if any (browser will free on page unload)
  //   };

  //   document.getElementById("sendPreview").onclick = async () => {
  //     closeModal();
  //     // call existing handleUpload(file) which will show optimistic bubble and upload
  //     await handleUpload(file);
  //   };
  // }

  function initChatDOMListeners() {
    const imgInput = document.getElementById("hiddenImageInput");
    const videoInput = document.getElementById("hiddenVideoInput");
    const fileInput = document.getElementById("hiddenFileInput");

    if (imgInput) {
      imgInput.onchange = (e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        if (!window.currentConversationId) {
          alert("Open a conversation first.");
          return;
        }
        openFilePreviewModal(file); // show preview — DON'T upload yet
      };
    }

    if (videoInput) {
      videoInput.onchange = (e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        if (!window.currentConversationId) {
          alert("Open a conversation first.");
          return;
        }
        openFilePreviewModal(file);
      };
    }

    if (fileInput) {
      fileInput.onchange = (e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        if (!window.currentConversationId) {
          alert("Open a conversation first.");
          return;
        }
        openFilePreviewModal(file);
      };
    }

    // optional: hide old header menu
    const headerBtn = document.getElementById("chatOptionsBtn");
    if (headerBtn) headerBtn.style.display = "none";
  }

  // call after chat HTML is rendered
  initChatDOMListeners();

  // init socket + local state
  initSocket();
  const socket = getSocket();
  // ---------- Direct socket usage (keeps TS happy + gives faster response) ----------
  if (socket) {
    // 1) Make TypeScript happy by using `socket` explicitly
    socket.on("connect", () => {
      console.log("socket connected:", socket.id);
      // ensure server knows who this socket belongs to — faster than wrapper in some cases
      if (state.user?.id)
        socket.emit("chat_register", { user_id: state.user.id });
    });

    // 2) Mirror critical events directly on socket for minimal latency
    // (these duplicate your `on('...')` wrappers but use socket directly;
    // keep wrapper-based `on(...)` code too — this is additive)
    socket.on("new_message", (msg) => {
      const convId = msg.conversation_id;

      // 1️⃣ Update chat cache
      if (!window.chatCache[convId]) window.chatCache[convId] = [];
      window.chatCache[convId].push(msg);

      // 2️⃣ Update left-sidebar conversation preview
      const convo = window.conversationCache.find(
        (c) => c.conversation_id === convId
      );

      if (convo) {
        convo.last_message = msg.message_text || msg.file_name || "";
        convo.last_sender = msg.sender_id;
        convo.last_message_time = msg.created_on;
      }

      // 3️⃣ Refresh left list – cheap
      renderConversationList();

      // 4️⃣ Only render if active conversation is open
      if (convId === window.currentConversationId) {
        addMessageToUI(msg, msg.sender_id === state.user.id, msg.message_id, {
          is_group: window.currentConversation?.is_group || false,
        });
      }
    });

    // ✅ GROUP SYSTEM MESSAGE (Auto show add/remove activity)
    on("group_system_message", async (msg) => {
      if (msg.conversation_id !== window.currentConversationId) return;

      // ✅ Always refresh conversation list FIRST
      if (typeof window.refreshConversationList === "function") {
        await window.refreshConversationList();
      }

      // ✅ Resolve actor name
      const actorName = getMemberNameById(msg.actor);

      let finalText = msg.text;

      // ✅ Convert added IDs → names
      if (Array.isArray(msg.added)) {
        const names = msg.added.map((id) => getMemberNameById(id)).join(", ");
        finalText = `${actorName} added ${names}`;
      }

      // ✅ Convert removed IDs → names
      if (Array.isArray(msg.removed)) {
        const names = msg.removed.map((id) => getMemberNameById(id)).join(", ");
        finalText = `${actorName} removed ${names}`;
      }

      addMessageToUI(
        {
          message_type: "text",
          message_text: finalText,
          created_on: new Date().toISOString(),
          sender_id: "system",
        },
        false,
        "sys_" + Date.now(),
        { is_group: true }
      );

      // ✅ Instantly refresh group info panel
      openGroupInfoPanel(msg.conversation_id);
    });

    // 🔵 GROUP MEMBERS ADDED (Real-time)
    on("group_members_added", async (data) => {
      delete window.groupMemberCache[data.conversation_id];
      await refreshConversationList();

      const updated = window.conversationList.find(
        (c) => String(c.conversation_id) === String(data.conversation_id)
      );

      if (updated) {
        state.activeConversation = updated;
        window.currentConversation = updated;
      }

      // ✅ ✅ ✅ SHOW SYSTEM MESSAGE IN CHAT
      if (data.text && window.currentConversationId === data.conversation_id) {
        addSystemMessageToChat(data.text);
      }

      // ✅ ✅ ✅ INSTANTLY REFRESH GROUP INFO PANEL
      if (window.currentConversationId === data.conversation_id) {
        openGroupInfoPanel(data.conversation_id);
      }
    });

    // 🔴 GROUP MEMBERS REMOVED (Real-time)
    on("group_members_removed", async (data) => {
      delete window.groupMemberCache[data.conversation_id];

      await refreshConversationList();

      const updated = window.conversationList.find(
        (c) => String(c.conversation_id) === String(data.conversation_id)
      );

      if (updated) {
        state.activeConversation = updated;
        window.currentConversation = updated;
      }

      // ✅ ✅ ✅ SHOW SYSTEM MESSAGE IN CHAT
      if (data.text && window.currentConversationId === data.conversation_id) {
        addSystemMessageToChat(data.text);
      }

      // ✅ ✅ ✅ INSTANTLY REFRESH GROUP INFO PANEL
      if (window.currentConversationId === data.conversation_id) {
        openGroupInfoPanel(data.conversation_id);
      }
    });

    on("group_renamed", (data) => {
      const convo = window.conversationList.find(
        (c) => c.conversation_id === data.conversation_id
      );
      if (!convo) return;

      convo.name = data.new_name;
      convo.display_name = data.new_name;

      renderConversationList();
      if (window.currentConversationId === data.conversation_id) {
        document.getElementById("chatUserName").innerText = data.new_name;
      }
    });
    on("conversation_deleted", (data) => {
      window.conversationList = window.conversationList.filter(
        (c) => c.conversation_id !== data.conversation_id
      );

      renderConversationList();

      if (window.currentConversationId === data.conversation_id) {
        document.getElementById(
          "chatMessages"
        ).innerHTML = `<div class="chat-placeholder">This group was deleted</div>`;
      }
    });
    on("user_left_conversation", (data) => {
      if (data.user_id !== state.user.id) return;

      window.conversationList = window.conversationList.filter(
        (c) => c.conversation_id !== data.conversation_id
      );

      renderConversationList();

      if (window.currentConversationId === data.conversation_id) {
        document.getElementById(
          "chatMessages"
        ).innerHTML = `<div class="chat-placeholder">Chat removed</div>`;
      }
    });
    on("group_updated", async ({ conversation_id }) => {
      if (conversation_id === window.currentConversationId) {
        await window.refreshConversationList();
        openGroupInfoPanel(conversation_id); // ✅ refresh group info live
      }
    });
    on("conversation_created", (convo) => {
      // 1️⃣ Remove temp conversation if exists
      const tempIndex = window.conversationCache.findIndex((c) =>
        String(c.conversation_id).startsWith("temp_")
      );

      if (tempIndex !== -1) {
        window.conversationCache.splice(tempIndex, 1);
      }

      // 2️⃣ Insert new conversation at top
      window.conversationCache.unshift(convo);

      // 3️⃣ Update left sidebar immediately
      renderConversationList(window.conversationCache);

      // 4️⃣ Mirror to old conversationList if used anywhere
      window.conversationList = [...window.conversationCache];

      // 5️⃣ Auto-open chat if user is waiting in temp convo
      if (
        window.currentConversationId &&
        String(window.currentConversationId).startsWith("temp_")
      ) {
        openConversationFromList(convo.conversation_id);
      }
    });

    // 3) Use socket for join/leave where possible (faster; reduces wrapper indirection)
    // If you currently use emit("join_room", ...), also call socket.emit to make the path direct
    // (we'll keep your existing emit(...) calls, this is an additive direct path)
    // Example shown below where you already call emit("join_room", ...)
  }

  // window.currentConversationId = null;
  // window.chatCache = {};
  // window.conversationList = [];
  // let typingTimer = null;
  // let isTyping = false;

  // UI wiring
  // document.getElementById("createNewChat").onclick = () =>
  //   openChatOptionsModal();

  document
    .getElementById("searchMessagesHeader")
    .addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      highlightSearchInMessages(q);
    });

  document.getElementById("clearSearchMessages").onclick = () => {
    const input = document.getElementById("searchMessagesHeader");
    input.value = "";
    input.dispatchEvent(new Event("input"));
  };

  document.getElementById("chatSearchInput").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    renderConversationList(q);
  });

  // media menu
  // --- WhatsApp Style Toggle Media Menu ---
  const mediaBtn = document.getElementById("mediaMenuBtn");
  const mediaMenu = document.getElementById("mediaMenu");

  mediaBtn.addEventListener("click", (e) => {
    e.stopPropagation();

    if (mediaMenu.style.display === "flex") {
      mediaMenu.style.display = "none";
      return;
    }

    const btnRect = mediaBtn.getBoundingClientRect();

    mediaMenu.style.display = "flex";

    mediaMenu.style.left = btnRect.left + "px";
    mediaMenu.style.top = btnRect.top - mediaMenu.offsetHeight - 10 + "px";
  });

  // Close when clicking outside
  document.addEventListener("click", (e) => {
    if (!mediaMenu.contains(e.target) && e.target !== mediaBtn) {
      mediaMenu.style.display = "none";
    }
  });

  // Close menu when selecting any option
  [
    "uploadImageBtn",
    "uploadVideoBtn",
    "uploadFileBtn",
    "recordVoiceBtn",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el)
      el.addEventListener("click", () => {
        mediaMenu.style.display = "none";
      });
  });

  document.getElementById("uploadImageBtn").onclick = () =>
    document.getElementById("hiddenImageInput").click();
  document.getElementById("uploadVideoBtn").onclick = () =>
    document.getElementById("hiddenVideoInput").click();
  document.getElementById("uploadFileBtn").onclick = () =>
    document.getElementById("hiddenFileInput").click();

  // send message: optimistic — emits to socket-server which persists via Python
  document.getElementById("sendMessageBtn").onclick = () => {
    const input = document.getElementById("chatMessageInput");
    const text = input.value.trim();
    if (!text || !window.currentConversationId) {
      input.value = "";
      return;
    }

    const payload = {
      message_id: "msg_" + Date.now(),
      conversation_id: window.currentConversationId,
      sender_id: state.user?.id || "UNKNOWN",
      message_text: text,
      message_type: "text",
      media_url: null,
      file_name: null,
      mime_type: "text/plain",
      created_on: new Date().toISOString(),
      temp_id: "tmp_" + Date.now(),
      sender_name: state.user?.name,
    };

    // 1️⃣ Optimistic local UI
    addMessageToUI(payload, true, payload.message_id, {
      is_group: window.currentConversation?.is_group || false,
    });

    // 2️⃣ Insert into local cache immediately
    if (!window.chatCache[window.currentConversationId]) {
      window.chatCache[window.currentConversationId] = [];
    }
    window.chatCache[window.currentConversationId].push(payload);

    emit("send_message", payload, (err, res) => {
      if (err) {
        console.error("send_message ack err", err);
        markMessageAsFailed(payload.temp_id);
        return;
      }
      updateMessageStatusLocal(
        payload.temp_id,
        res?.status || "sent",
        res?.message_id
      );
    });

    input.value = "";
    emitTypingStop();
  };

  // typing
  const inputEl = document.getElementById("chatMessageInput");
  inputEl.addEventListener("input", () => {
    if (!window.currentConversationId) return;
    if (!isTyping) {
      isTyping = true;
      emit("typing", {
        conversation_id: window.currentConversationId,
        sender_id: state.user.id,
      });
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => emitTypingStop(), 1400);
  });

  function emitTypingStop() {
    if (!isTyping) return;
    isTyping = false;
    emit("stop_typing", {
      conversation_id: window.currentConversationId,
      sender_id: state.user.id,
    });
  }

  // // BACKWARD COMPAT: replace old handleUpload to show preview first
  // async function handleUpload(file) {
  //   if (!file || !window.currentConversationId) return;

  //   let messageType = "file";
  //   let tempPreviewUrl = null;

  //   if (file.type.startsWith("image/")) {
  //     messageType = "image";
  //     tempPreviewUrl = URL.createObjectURL(file); // local preview
  //   } else if (file.type.startsWith("video/")) {
  //     messageType = "video";
  //   } else if (file.type.startsWith("audio/")) {
  //     messageType = "audio";
  //   }

  //   const tempId = "tmp_upload_" + Date.now();

  //   // optimistic bubble with progress + X
  //   const tempPayload = {
  //     temp_id: tempId,
  //     message_id: null,
  //     conversation_id: window.currentConversationId,
  //     sender_id: state.user.id,
  //     message_type: messageType,
  //     message_text: null,
  //     media_url: tempPreviewUrl, // blob: url for image preview
  //     file_name: file.name,
  //     mime_type: file.type,
  //     created_on: new Date().toISOString(),
  //     _is_temp_upload: true, // <---- flag for progress UI
  //     upload_progress: 0,
  //   };

  //   // show optimistic bubble
  //   addMessageToUI(tempPayload, true, tempId, {
  //     is_group: window.currentConversation?.is_group || false,
  //   });

  //   // Insert into local cache immediately
  //   if (!window.chatCache[window.currentConversationId]) {
  //     window.chatCache[window.currentConversationId] = [];
  //   }
  //   window.chatCache[window.currentConversationId].push(tempPayload);

  //   // build form
  //   const form = new FormData();
  //   form.append("conversation_id", window.currentConversationId);
  //   form.append("sender_id", state.user.id);
  //   form.append("file", file);

  //   // upload with progress
  //   const { xhr, promise } = sendWithProgress(form, (percent) => {
  //     updateUploadProgress(tempId, percent);
  //   });

  //   // store so cancel can abort
  //   activeUploads[tempId] = { xhr, file };

  //   try {
  //     const res = await promise; // { ok, message_id, media_url, file_name, mime_type }

  //     // delete local reference
  //     delete activeUploads[tempId];

  //     // finalize UI with server response
  //     finalizeUploadBubble(tempId, res);
  //   } catch (err) {
  //     console.error("Upload failed:", err);
  //     delete activeUploads[tempId];
  //     markUploadFailed(tempId);
  //   }
  // }

  // // --------- UPLOAD / PREVIEW / PROGRESS (copy this whole block into chats.js) ----------

  // // Ensure global buckets (put near top of file once)
  // window.pendingUploads = window.pendingUploads || {};
  // window.activeUploads = window.activeUploads || {};
  // window.chatCache = window.chatCache || {};

  // // XHR upload wrapper that returns { xhr, promise }
  // // onProgress(percent) gets called with 0..100
  /* =========================
   UPLOAD / PREVIEW IMPROVED
   Drop-in replacements for:
     - openFilePreviewModal
     - createUploadPreview
     - sendPreviewedFile
     - uploadStart (new)
     - updateUploadProgress (new circular)
     - finalizeUploadBubble (robust)
   Also a helper: downloadFileRobust for sender-side fallback
   ========================= */

  /* ---------- small helpers ---------- */
  function makeTempId() {
    return "tmp_upload_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
  }

  /**
   * Robust client download helper:
   * - Tries to use the link href directly
   * - If server returns HTML or incorrect headers, fetch as blob and force-download
   */
  async function downloadFileRobust(url, filename, mime) {
    try {
      // Try simple anchor download first (fastest)
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || "";
      a.target = "_blank";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      // fallback to fetch-as-blob
      try {
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) throw new Error("Download fetch failed: " + resp.status);
        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename || "file";
        document.body.appendChild(a);
        a.click();
        a.remove();
        // free object url
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      } catch (e) {
        console.error("downloadFileRobust failed", e);
        alert(
          "Download failed. Please ask server admin to ensure file endpoint returns raw file bytes with correct Content-Type and Content-Disposition headers."
        );
      }
    }
  }

  /* ---------- 1) preview modal (WhatsApp-like) ---------- */
  function openFilePreviewModal(file) {
    if (!file) return;

    const isImage = file.type.startsWith("image/");
    const isVideo = file.type.startsWith("video/");
    const isAudio = file.type.startsWith("audio/");

    let previewHtml = `<div style="text-align:center;margin-bottom:10px;">`;
    if (isImage) {
      const url = URL.createObjectURL(file);
      previewHtml += `<img src="${url}" style="max-width:640px;max-height:360px;border-radius:8px;display:block;margin:0 auto;"/>`;
    } else if (isVideo) {
      const url = URL.createObjectURL(file);
      previewHtml += `<video controls style="max-width:640px;max-height:360px;display:block;margin:0 auto;"><source src="${url}"></video>`;
    } else if (isAudio) {
      const url = URL.createObjectURL(file);
      previewHtml += `<audio controls src="${url}" style="display:block;margin:0 auto;"></audio>`;
    } else {
      previewHtml += `<div style="padding:18px;border-radius:8px;background:var(--muted-bg);font-weight:600;">${escapeHtml(
        file.name
      )}</div>`;
    }
    previewHtml += `</div>`;

    // Create modal markup (simple, re-usable). Use your existing renderModal if you prefer.
    const modal = document.createElement("div");
    modal.className = "wh-preview-modal";
    modal.innerHTML = `
    <div class="wh-preview-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:99999;">
      <div class="wh-preview-box" style="background:var(--bg-panel);padding:18px;border-radius:14px;max-width:720px;width:90%;box-shadow:0 8px 30px rgba(0,0,0,0.6);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="margin:0;">Preview</h3>
          <button class="wh-preview-close" title="Close" style="background:transparent;border:none;color:var(--muted);font-size:18px;">×</button>
        </div>
        <div class="wh-preview-body">${previewHtml}</div>
        <div style="text-align:center;margin-top:12px;">
          <button class="wh-preview-cancel btn-secondary" style="margin-right:10px;padding:8px 12px;border-radius:8px;">Cancel</button>
          <button class="wh-preview-send btn-primary" style="padding:8px 12px;border-radius:8px;">Send</button>
        </div>
      </div>
    </div>
  `;

    modal.file = file;
    document.body.appendChild(modal);

    modal.querySelector(".wh-preview-close").onclick = () => modal.remove();
    modal.querySelector(".wh-preview-cancel").onclick = () => modal.remove();
    modal.querySelector(".wh-preview-send").onclick = async () => {
      modal.remove();
      // Call the upload path — use uploadStart so we keep the same optimistic bubble + progress UI
      await sendFileAfterPreview(file);
    };
  }

  async function sendFileAfterPreview(file) {
    if (!file || !window.currentConversationId) return;

    const tempId = makeTempId();

    // Create ONE temporary bubble
    addMessageToUI(
      {
        temp_id: tempId,
        message_id: null,
        conversation_id: window.currentConversationId,
        sender_id: state.user?.id,
        message_type: file.type.startsWith("image/")
          ? "image"
          : file.type.startsWith("video/")
          ? "video"
          : file.type.startsWith("audio/")
          ? "audio"
          : "file",
        media_url: file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : null,
        file_name: file.name,
        mime_type: file.type,
        created_on: new Date().toISOString(),
        _is_temp_upload: true,
      },
      true,
      tempId,
      { is_group: window.currentConversation?.is_group }
    );

    // Insert circular progress
    insertProgressUI(tempId);

    // Build form for backend
    const formData = new FormData();
    formData.append("conversation_id", window.currentConversationId);
    formData.append("sender_id", state.user?.id);
    formData.append("file", file);

    const { xhr, promise } = sendWithProgress(formData, (percent) => {
      updateUploadProgress(tempId, percent);
    });

    window.activeUploads = window.activeUploads || {};
    window.activeUploads[tempId] = { xhr, file };

    try {
      const res = await promise;

      finalizeUploadBubble(tempId, {
        message_id: res.message_id,
        file_name: res.file_name || file.name,
        mime_type: res.mime_type || file.type,
        media_url: res.media_url,
      });
    } catch (err) {
      console.error("Upload failed:", err);
      markUploadFailed(tempId);
    }
  }
  function insertProgressUI(tempId) {
    const bubble = document.querySelector(
      `.chat-msg[data-msgid="${tempId}"], .chat-msg[data-tempid="${tempId}"]`
    );
    if (!bubble) return;

    bubble.insertAdjacentHTML(
      "beforeend",
      `<div class="upload-actions" data-upload="${tempId}">
        <div class="upload-circle" data-upload-circle="${tempId}">
          <svg class="progress-ring" width="44" height="44">
            <circle class="progress-ring__circle" 
                    stroke="currentColor" 
                    stroke-width="3" fill="transparent" 
                    r="18" cx="22" cy="22"></circle>
          </svg>
        </div>
        <button class="upload-cancel" data-cancel="${tempId}">✖</button>
    </div>`
    );

    const cancelBtn = bubble.querySelector(`button[data-cancel="${tempId}"]`);
    if (cancelBtn) cancelBtn.onclick = () => cancelUpload(tempId);
  }

  /* ---------- 5) Circular progress update ----------
   We change the width-based bar update to rotate SVG stroke-dashoffset
   but keep a fallback for your existing .upload-progress-inner if any code uses it.
*/
  function updateUploadProgress(tempId, percent) {
    // update SVG circular ring if present
    const circleWrap = document.querySelector(
      `.upload-circle[data-upload-circle="${tempId}"]`
    );
    if (circleWrap) {
      const circle = circleWrap.querySelector(".progress-ring__circle");
      if (circle) {
        const radius = circle.r.baseVal.value;
        const circumference = 2 * Math.PI * radius;
        circle.style.strokeDasharray = `${circumference} ${circumference}`;
        const offset = circumference - (percent / 100) * circumference;
        circle.style.strokeDashoffset = offset;
        // small color transition on completion
        if (percent >= 100) {
          circle.style.transition = "stroke-dashoffset 0.3s ease, stroke 0.3s";
          circle.style.stroke = "#10b981"; // green-ish
        } else {
          circle.style.transition = "stroke-dashoffset 0.15s linear";
        }
      }
    }

    // fallback: update old bar if present
    const wrap = document.querySelector(
      `.upload-progress-wrap[data-upload="${tempId}"]`
    );
    if (wrap) {
      const inner = wrap.querySelector(".upload-progress-inner");
      if (inner) inner.style.width = percent + "%";
    }
  }

  /* ---------- 6) finalizeUploadBubble (robust) ----------
   Replaces optimistic bubble with final content; ensures download link uses /chat/file/<id>
   and ensures sender-friendly download using downloadFileRobust if necessary.
*/
  // ---------- Safe addMessageToUI (drop-in replacement) ----------
  function addMessageToUI(
    messageObj,
    isMine = false,
    canonicalMessageId = null,
    opts = {}
  ) {
    const container = document.getElementById("chatMessages");
    const placeholder = container.querySelector(".chat-placeholder");
    if (placeholder) placeholder.remove();

    // TIMESTAMP
    let createdOn = messageObj.created_on || messageObj.createdOn;
    if (!createdOn) createdOn = new Date().toISOString();
    const iso = new Date(createdOn).toISOString();

    if (typeof insertDateSeparator === "function") {
      insertDateSeparator(container, iso);
    }

    // BASIC BUBBLE ID + CLASS
    const msgId =
      canonicalMessageId ||
      messageObj.message_id ||
      messageObj.temp_id ||
      "tmp_" + Date.now();

    const bubbleClass =
      messageObj.sender_id === "system"
        ? "system-msg"
        : isMine
        ? "msg-sent"
        : "msg-received";

    const isTempUpload = !!messageObj._is_temp_upload;

    // GROUP: SENDER NAME (safe lookup)
    let senderHeaderHtml = "";
    if (opts.is_group && messageObj.sender_id !== "system") {
      let senderName = messageObj.sender_name || messageObj.sender;

      if (
        !senderName &&
        window.conversationList &&
        window.currentConversationId
      ) {
        const convo = window.conversationList.find(
          (c) =>
            String(c.conversation_id) === String(window.currentConversationId)
        );

        if (convo && Array.isArray(convo.members)) {
          const senderUser = convo.members.find(
            (m) => String(m.id) === String(messageObj.sender_id)
          );
          if (senderUser && senderUser.name) {
            senderName = senderUser.name;
          }
        }
      }

      if (senderName) {
        const colors = [
          "#f87171",
          "#fb923c",
          "#facc15",
          "#4ade80",
          "#22d3ee",
          "#60a5fa",
          "#a78bfa",
          "#f472b6",
        ];
        let hash = 0;
        for (let i = 0; i < senderName.length; i++) {
          hash = senderName.charCodeAt(i) + ((hash << 5) - hash);
        }
        const color = colors[Math.abs(hash) % colors.length];

        senderHeaderHtml = `
      <div class="msg-sender-name" style="color:${color}">
        ${escapeHtml(senderName)}
      </div>`;
      }
    }

    // TIME + TICK
    const timeText =
      typeof formatChatTimestamp === "function"
        ? formatChatTimestamp(iso)
        : new Date(iso).toLocaleTimeString();

    const tickHtml = isMine ? `<span class="msg-tick msg-ticks"></span>` : "";

    // SAFE MIME list (keeps previews safe)
    const SAFE_MIME = [
      "image/png",
      "image/jpeg",
      "image/webp",
      "video/mp4",
      "audio/mpeg",
      "audio/wav",
      "application/pdf",
      "application/zip",
    ];

    // Resolve media id → file URL (handles blob/data/http and server GUIDs)
    const rawMediaId =
      messageObj.media_url ||
      messageObj.crc6f_media_url ||
      messageObj.mediaId ||
      "";

    let FILE_URL = null;
    if (rawMediaId) {
      const mu = String(rawMediaId);
      if (
        mu.startsWith("blob:") ||
        mu.startsWith("data:") ||
        mu.startsWith("http")
      ) {
        FILE_URL = mu;
      } else {
        FILE_URL = `/chat/file/${mu}`;
      }
    }

    // CONTENT by type (keeps "uploading…" state when no FILE_URL yet)
    let contentHtml = "";
    const mType = messageObj.message_type || "text";

    // IMAGE
    if (mType === "image" && SAFE_MIME.includes(messageObj.mime_type)) {
      contentHtml = `
      <div class="msg-file-wrap image-wrap">
        ${FILE_URL ? `<img src="${FILE_URL}" class="msg-image" />` : ""}
        <div class="msg-file-name">${escapeHtml(
          messageObj.file_name || ""
        )}</div>
    `;

      // WhatsApp-style download icon for receiver (frontend-only once-per-file)
      if (!isMine && rawMediaId && !hasDownloadedOnce(rawMediaId)) {
        contentHtml += waDownloadIcon(rawMediaId);
      } else if (!isMine) {
        contentHtml += waDownloadedIcon();
      }

      contentHtml += `</div>`;
    }

    // VIDEO
    else if (mType === "video" && SAFE_MIME.includes(messageObj.mime_type)) {
      contentHtml = `
      <div class="msg-file-wrap video-wrap">
        ${
          FILE_URL
            ? `<video controls class="msg-video"><source src="${FILE_URL}"></video>`
            : ""
        }
        <div class="msg-file-name">${escapeHtml(
          messageObj.file_name || ""
        )}</div>
    `;

      if (!isMine && rawMediaId && !hasDownloadedOnce(rawMediaId)) {
        contentHtml += waDownloadIcon(rawMediaId);
      } else if (!isMine) {
        contentHtml += waDownloadedIcon();
      }

      contentHtml += `</div>`;
    }

    // AUDIO
    else if (mType === "audio" && SAFE_MIME.includes(messageObj.mime_type)) {
      contentHtml = `
      <div class="msg-file-wrap audio-wrap">
        ${FILE_URL ? `<audio controls src="${FILE_URL}"></audio>` : ""}
        <div class="msg-file-name">${escapeHtml(
          messageObj.file_name || ""
        )}</div>
    `;

      if (!isMine && rawMediaId && !hasDownloadedOnce(rawMediaId)) {
        contentHtml += waDownloadIcon(rawMediaId);
      } else if (!isMine) {
        contentHtml += waDownloadedIcon();
      }

      contentHtml += `</div>`;
    }

    // GENERIC FILE (pdf/docx/pptx/zip etc.)
    else if (mType !== "text") {
      const fname = escapeHtml(messageObj.file_name || "download");

      contentHtml = `
      <div class="msg-file-wrap">
        <i class="fa-solid fa-file"></i>
        <a href="${
          FILE_URL || "#"
        }" download="${fname}" target="_blank" rel="noopener">${fname}</a>
    `;

      if (!isMine && rawMediaId && !hasDownloadedOnce(rawMediaId)) {
        contentHtml += waDownloadIcon(rawMediaId);
      } else if (!isMine) {
        contentHtml += waDownloadedIcon();
      }

      contentHtml += `</div>`;
    }

    // TEXT
    else {
      const text = escapeHtml(messageObj.message_text || "");
      contentHtml = `<div class="msg-content">${text}</div>`;
    }

    // FINAL HTML (keeps data attributes used by other code)
    const html = `
    <div class="chat-msg ${bubbleClass}" 
      data-msgid="${msgId}" 
      data-tempid="${messageObj.temp_id || ""}"
      data-date="${iso}">
      ${senderHeaderHtml}
      ${contentHtml}
      <div class="msg-meta-row">
        <span class="msg-time">${escapeHtml(timeText)}</span>
        ${tickHtml}
      </div>
    </div>
  `;

    container.insertAdjacentHTML("beforeend", html);
    container.scrollTop = container.scrollHeight;

    // attach WA icon click handler (best-effort, non-blocking)
    setTimeout(() => {
      const el = container.querySelector(`[data-msgid="${msgId}"]`);
      if (!el) return;

      const waIcon = el.querySelector(`[data-wa="${rawMediaId}"]`);
      if (waIcon && FILE_URL) {
        waIcon.onclick = async () => {
          try {
            await downloadFileRobust(
              FILE_URL,
              messageObj.file_name,
              messageObj.mime_type
            );
            markDownloaded(rawMediaId);
            waIcon.outerHTML = waDownloadedIcon();
          } catch (err) {
            console.error("WA icon download failed", err);
          }
        };
      }

      // Attach contextmenu (right-click) if needed so openMessageActionsMenu is usable from bubble
      // (this keeps existing behaviour of your right-click menu)
      if (el && typeof openMessageActionsMenu === "function") {
        el.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          // pass x/y coords and message id
          openMessageActionsMenu(
            messageObj.message_id || msgId,
            ev.clientX,
            ev.clientY
          );
        });
      }
    }, 30);
  }

  // ---------- Safe finalizeUploadBubble (drop-in replacement) ----------
  function finalizeUploadBubble(tempId, server) {
    const el = document.querySelector(
      `.chat-msg[data-msgid="${tempId}"], .chat-msg[data-tempid="${tempId}"]`
    );
    if (!el) return;

    // Remove all upload UI (safe guards)
    const actions = el.querySelector(".upload-actions");
    if (actions) actions.remove();
    const cancelOld = el.querySelector(".upload-cancel");
    if (cancelOld) cancelOld.remove();
    const circle = el.querySelector(".upload-circle");
    if (circle) circle.remove();
    const wrap = el.querySelector(".upload-progress-wrap");
    if (wrap) wrap.remove();

    const realId = server.message_id || server.messageId || "msg_" + Date.now();
    el.setAttribute("data-msgid", realId);
    if (el.hasAttribute("data-tempid")) el.removeAttribute("data-tempid");

    // Build final URL (server.media_url should be id or full path)
    const mediaId = server.media_url || server.mediaId || "";
    const url = mediaId ? `/chat/file/${mediaId}` : "";
    const mime = (server.mime_type || server.mime || "").toLowerCase();

    // find content container inside bubble
    let content =
      el.querySelector(".msg-file-wrap") || el.querySelector(".msg-content");

    // IMAGE
    if (mime.startsWith("image/")) {
      if (content) {
        content.innerHTML = `
        <img src="${url || server.dataURL || ""}" class="msg-image" />
        <div class="msg-file-name">${escapeHtml(server.file_name || "")}</div>
      `;
      }
    }
    // VIDEO
    else if (mime.startsWith("video/")) {
      if (content) {
        content.innerHTML = `
        <video controls class="msg-video"><source src="${url}"></video>
        <div class="msg-file-name">${escapeHtml(server.file_name || "")}</div>
      `;
      }
    }
    // AUDIO
    else if (mime.startsWith("audio/")) {
      if (content) {
        content.innerHTML = `
        <audio controls src="${url}"></audio>
        <div class="msg-file-name">${escapeHtml(server.file_name || "")}</div>
      `;
      }
    }
    // GENERIC FILE
    else {
      const fname = escapeHtml(server.file_name || "Download");
      if (content) {
        content.innerHTML = `
        <div style="display:flex;gap:10px;align-items:center;">
          <i class="fa-solid fa-file" style="font-size:20px;"></i>
          <div>
            <div style="font-weight:600;">${fname}</div>
            <div style="font-size:12px;color:var(--muted);">${
              mime || "file"
            }</div>
          </div>
        </div>
      `;
        // add download anchor/button only for sender by default (keeps receiver UX restricted)
        if (state?.user && String(state.user.id) === String(server.sender_id)) {
          // sender sees a direct link (fallback)
          const anchor = document.createElement("a");
          anchor.href = url || "#";
          anchor.download = fname;
          anchor.textContent = "Download";
          anchor.className = "file-download-btn";
          anchor.style = "margin-left:12px;padding:6px 8px;border-radius:8px;";
          anchor.onclick = (ev) => {
            if (!url) {
              ev.preventDefault();
              alert("Download URL not available");
              return;
            }
          };
          content.insertAdjacentElement("beforeend", anchor);
        }
      }
    }

    // WHATSAPP-STYLE ONE-TIME DOWNLOAD (receiver only)
    const amISender = state.user?.id == server.sender_id;

    if (!amISender && mediaId) {
      if (content) {
        if (!hasDownloadedOnce(mediaId)) {
          content.innerHTML += waDownloadIcon(mediaId);

          // attach click handler
          const dlIcon = content.querySelector(`[data-wa="${mediaId}"]`);
          if (dlIcon) {
            dlIcon.onclick = async () => {
              try {
                await downloadFileRobust(url, server.file_name, mime);
                markDownloaded(mediaId);
                dlIcon.outerHTML = waDownloadedIcon();
              } catch (err) {
                console.error("one-time download failed", err);
              }
            };
          }
        } else {
          content.innerHTML += waDownloadedIcon();
        }
      }
    }

    // Update local cache if available (keeps your original cache semantics)
    try {
      const convId = window.currentConversationId;
      if (convId && Array.isArray(window.chatCache[convId])) {
        const idx = window.chatCache[convId].findIndex(
          (m) => m.temp_id === tempId || m.message_id === tempId
        );
        const finalMsg = {
          message_id: realId,
          temp_id: null,
          conversation_id: convId,
          sender_id: server.sender_id || state.user?.id,
          message_type: mime.startsWith("image/")
            ? "image"
            : mime.startsWith("video/")
            ? "video"
            : mime.startsWith("audio/")
            ? "audio"
            : "file",
          file_name: server.file_name || "",
          mime_type: server.mime_type || server.mime,
          media_url: mediaId,
          created_on: new Date().toISOString(),
        };
        if (idx >= 0) window.chatCache[convId][idx] = finalMsg;
        else window.chatCache[convId].push(finalMsg);
      }
    } catch (err) {
      console.warn("cache update failed", err);
    }
  }

  /* ===========================================================
   DOWNLOAD STATE HELPERS (safe, frontend-only)
=========================================================== */
  function hasDownloadedOnce(fileId) {
    return localStorage.getItem("downloaded_" + fileId) === "1";
  }

  function markDownloaded(fileId) {
    localStorage.setItem("downloaded_" + fileId, "1");
  }

  /* ===========================================================
   WhatsApp-style download icons
=========================================================== */
  function waDownloadIcon(fileId) {
    return `
    <div class="wa-download" data-wa="${fileId}">
      <i class="fa-solid fa-arrow-down"></i>
    </div>
  `;
  }

  function waDownloadedIcon() {
    return `
    <div class="wa-downloaded">
      <i class="fa-solid fa-check-circle"></i>
    </div>
  `;
  }

  // utility to escape HTML used in finalizeUploadBubble and anywhere you need it
  // function escapeHtml(s) {
  //   if (!s) return "";
  //   return ("" + s).replace(
  //     /[&<>"']/g,
  //     (m) =>
  //       ({
  //         "&": "&amp;",
  //         "<": "&lt;",
  //         ">": "&gt;",
  //         '"': "&quot;",
  //         "'": "&#39;",
  //       }[m])
  //   );
  // }

  // file previews & optimistic UI
  // document.getElementById("hiddenImageInput").onchange = (e) => {
  //   const file = e.target.files[0];
  //   e.target.value = "";
  //   handleUpload("image", file);
  // };

  // document.getElementById("hiddenVideoInput").onchange = (e) => {
  //   const file = e.target.files[0];
  //   e.target.value = "";
  //   handleUpload("video", file);
  // };
  // document.getElementById("hiddenFileInput").onchange = (e) => {
  //   const file = e.target.files[0];
  //   e.target.value = "";
  //   handleUpload("file", file);
  // };

  // Socket event handlers
  // on("new_message", (msg) => {
  //   // msg should be the saved message object returned by Python API
  //   addMessageToUI(msg, msg.sender_id === state.user?.id, msg.message_id, {
  //     is_group: window.currentConversation?.is_group || false,
  //   });

  //   handleNotificationForIncoming(msg);
  // });

  on("message_status_update", (data) => {
    updateMessageStatusUI(data.message_id, data.status);
  });

  on("typing", (data) => {
    if (data.conversation_id !== window.currentConversationId) return;
    showTypingIndicator(data.sender_id);
  });

  on("stop_typing", (data) => {
    if (data.conversation_id !== window.currentConversationId) return;
    hideTypingIndicator();
  });

  on("message_edited", (payload) => {
    const container = document.getElementById("chatMessages");
    const msgEl = container.querySelector(
      `[data-msgid="${payload.message_id}"]`
    );
    if (!msgEl) return;

    const contentEl = msgEl.querySelector(".msg-content");
    if (contentEl) {
      contentEl.textContent = payload.new_text || payload.message_text || "";
    }

    // add [edited] label in metadata
    const meta = msgEl.querySelector(".msg-meta-row");
    if (meta && !meta.querySelector(".msg-edited-label")) {
      const span = document.createElement("span");
      span.className = "msg-edited-label";
      span.style.marginLeft = "6px";
      span.style.fontSize = "11px";
      span.style.opacity = "0.7";
      span.textContent = "[edited]";
      meta.insertBefore(span, meta.firstChild);
    }
  });

  on("message_deleted", (data) => {
    markMessageDeleted(data.message_id);
  });

  on("user_presence", (data) => {
    updateUserPresence(data);
  });

  // Helpers & UI functions
  function getTargetDisplayName(convo) {
    const myId = String(state.user?.id || "");

    // GROUP → return group name as is
    if (convo.is_group) {
      return convo.display_name || convo.name || "Group";
    }

    // DIRECT CHAT → find the OTHER person's name
    const other = (convo.members || []).find((m) => String(m.id) !== myId);

    if (other && other.name) {
      return other.name;
    }

    // fallback — use original stored name
    return convo.display_name || convo.name || "Direct Chat";
  }

  function makeMediaPayload(type, name, mime, previewUrl) {
    return {
      conversation_id: window.currentConversationId,
      sender_id: state.user?.id,
      message_type: type,
      message_text: null,
      media_url: previewUrl || null,
      file_name: name || null,
      mime_type: mime || null,
      temp_id: "tmp_" + Date.now(),
    };
  }

  function formatChatTimestamp(isoString) {
    const d = new Date(isoString);
    if (isNaN(d)) return "";

    // Always return TIME only for bubbles (06:25 PM)
    let hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;

    return `${hours}:${minutes} ${ampm}`;
  }

  // helper: friendly day label (Today / Yesterday / Mon / 02 Jan)
  function formatChatDayLabel(iso) {
    if (!iso) return "";
    const dt = new Date(iso);
    const now = new Date();

    const isToday =
      dt.getDate() === now.getDate() &&
      dt.getMonth() === now.getMonth() &&
      dt.getFullYear() === now.getFullYear();

    const yesterday = new Date();
    yesterday.setDate(now.getDate() - 1);

    const isYesterday =
      dt.getDate() === yesterday.getDate() &&
      dt.getMonth() === yesterday.getMonth() &&
      dt.getFullYear() === yesterday.getFullYear();

    if (isToday) return "Today";
    if (isYesterday) return "Yesterday";

    // If within this week, return weekday
    const diffDays = Math.floor((now - dt) / (1000 * 60 * 60 * 24));
    if (diffDays < 7) {
      return dt.toLocaleDateString([], { weekday: "long" }); // e.g., "Friday"
    }

    // fallback date format
    return dt.toLocaleDateString([], { day: "2-digit", month: "short" }); // "05 Dec"
  }

  // insert a date separator if last rendered message date differs
  function insertDateSeparator(container, iso) {
    if (!iso) return;
    const lastSep = container.querySelector(".chat-date-sep:last-of-type");
    // find last message element's data-date (we'll set data-date on bubbles)
    const lastMsg = container.querySelector(".chat-msg:last-of-type");
    const lastDate = lastMsg ? new Date(lastMsg.dataset.date || "") : null;
    const newDate = new Date(iso);

    const sameDay =
      lastDate &&
      lastDate.getFullYear() === newDate.getFullYear() &&
      lastDate.getMonth() === newDate.getMonth() &&
      lastDate.getDate() === newDate.getDate();

    if (!sameDay) {
      const label = formatChatDayLabel(iso);
      const sep = document.createElement("div");
      sep.className = "chat-date-sep";
      sep.innerHTML = `<div class="pill">${escapeHtml(label)}</div>`;
      container.appendChild(sep);
    }
  }

  /*
  Updated addMessageToUI:
  - inserts date separator
  - adds sender name for group chat (above message bubble)
  - creates meta row with time + tick aligned horizontally
*/
  // function addMessageToUI(
  //   messageObj,
  //   isMine = false,
  //   canonicalMessageId = null,
  //   opts = {}
  // ) {
  //   const container = document.getElementById("chatMessages");
  //   const placeholder = container.querySelector(".chat-placeholder");
  //   if (placeholder) placeholder.remove();

  //   let createdOn = messageObj.created_on || messageObj.createdOn;
  //   if (!createdOn) createdOn = new Date().toISOString();
  //   const iso = new Date(createdOn).toISOString();

  //   if (typeof insertDateSeparator === "function") {
  //     insertDateSeparator(container, iso);
  //   }

  //   const msgId =
  //     canonicalMessageId ||
  //     messageObj.message_id ||
  //     messageObj.temp_id ||
  //     "tmp_" + Date.now();

  //   const bubbleClass =
  //     messageObj.sender_id === "system"
  //       ? "system-msg"
  //       : isMine
  //       ? "msg-sent"
  //       : "msg-received";

  //   const isTempUpload = !!messageObj._is_temp_upload;

  //   // ------------------------ Group Sender Names (SAFE) ------------------------
  //   let senderHeaderHtml = "";
  //   if (opts.is_group && messageObj.sender_id !== "system") {
  //     let senderName = messageObj.sender_name || messageObj.sender;

  //     if (
  //       !senderName &&
  //       window.conversationList &&
  //       window.currentConversationId
  //     ) {
  //       const convo = window.conversationList.find(
  //         (c) =>
  //           String(c.conversation_id) === String(window.currentConversationId)
  //       );

  //       if (convo && Array.isArray(convo.members)) {
  //         const senderUser = convo.members.find(
  //           (m) => String(m.id) === String(messageObj.sender_id)
  //         );
  //         if (senderUser && senderUser.name) {
  //           senderName = senderUser.name;
  //         }
  //       }
  //     }

  //     if (senderName) {
  //       const colors = [
  //         "#f87171",
  //         "#fb923c",
  //         "#facc15",
  //         "#4ade80",
  //         "#22d3ee",
  //         "#60a5fa",
  //         "#a78bfa",
  //         "#f472b6",
  //       ];
  //       let hash = 0;
  //       for (let i = 0; i < senderName.length; i++) {
  //         hash = senderName.charCodeAt(i) + ((hash << 5) - hash);
  //       }
  //       const color = colors[Math.abs(hash) % colors.length];

  //       senderHeaderHtml = `
  //     <div class="msg-sender-name" style="color:${color}">
  //       ${escapeHtml(senderName)}
  //     </div>`;
  //     }
  //   }

  //   const timeText =
  //     typeof formatChatTimestamp === "function"
  //       ? formatChatTimestamp(iso)
  //       : new Date(iso).toLocaleTimeString();

  //   const tickHtml = isMine ? `<span class="msg-tick msg-ticks"></span>` : "";

  //   const SAFE_MIME = [
  //     "image/png",
  //     "image/jpeg",
  //     "image/webp",
  //     "video/mp4",
  //     "audio/mpeg",
  //     "audio/wav",
  //     "application/pdf",
  //     "application/zip",
  //   ];

  //   const rawMediaId =
  //     messageObj.media_url ||
  //     messageObj.crc6f_media_url ||
  //     messageObj.mediaId ||
  //     "";

  //   let FILE_URL = null;
  //   if (rawMediaId) {
  //     const mu = String(rawMediaId);
  //     if (
  //       mu.startsWith("blob:") ||
  //       mu.startsWith("data:") ||
  //       mu.startsWith("http")
  //     ) {
  //       FILE_URL = mu;
  //     } else {
  //       FILE_URL = `/chat/file/${mu}`;
  //     }
  //   }

  //   let contentHtml = "";
  //   const mType = messageObj.message_type || "text";

  //   // ------------------------ IMAGE ------------------------
  //   if (mType === "image" && SAFE_MIME.includes(messageObj.mime_type)) {
  //     contentHtml = `
  //     <div class="msg-file-wrap image-wrap">
  //       <img src="${FILE_URL}" class="msg-image" />
  //       <div class="msg-file-name">${escapeHtml(
  //         messageObj.file_name || ""
  //       )}</div>
  //   `;

  //     // WA download icon for receiver
  //     if (!isMine && !hasDownloadedOnce(rawMediaId)) {
  //       contentHtml += waDownloadIcon(rawMediaId);
  //     } else if (!isMine) {
  //       contentHtml += waDownloadedIcon();
  //     }

  //     contentHtml += `</div>`;
  //   }

  //   // ------------------------ VIDEO ------------------------
  //   else if (mType === "video" && SAFE_MIME.includes(messageObj.mime_type)) {
  //     contentHtml = `
  //     <div class="msg-file-wrap video-wrap">
  //       <video controls class="msg-video"><source src="${FILE_URL}"></video>
  //       <div class="msg-file-name">${escapeHtml(
  //         messageObj.file_name || ""
  //       )}</div>
  //   `;

  //     if (!isMine && !hasDownloadedOnce(rawMediaId)) {
  //       contentHtml += waDownloadIcon(rawMediaId);
  //     } else if (!isMine) {
  //       contentHtml += waDownloadedIcon();
  //     }

  //     contentHtml += `</div>`;
  //   }

  //   // ------------------------ AUDIO ------------------------
  //   else if (mType === "audio" && SAFE_MIME.includes(messageObj.mime_type)) {
  //     contentHtml = `
  //     <div class="msg-file-wrap audio-wrap">
  //       <audio controls src="${FILE_URL}"></audio>
  //       <div class="msg-file-name">${escapeHtml(
  //         messageObj.file_name || ""
  //       )}</div>
  //   `;

  //     if (!isMine && !hasDownloadedOnce(rawMediaId)) {
  //       contentHtml += waDownloadIcon(rawMediaId);
  //     } else if (!isMine) {
  //       contentHtml += waDownloadedIcon();
  //     }

  //     contentHtml += `</div>`;
  //   }

  //   // ------------------------ GENERIC FILE ------------------------
  //   else if (mType !== "text") {
  //     const fname = escapeHtml(messageObj.file_name || "download");

  //     contentHtml = `
  //     <div class="msg-file-wrap">
  //       <i class="fa-solid fa-file"></i>
  //       <a href="${FILE_URL}" download="${fname}" target="_blank" rel="noopener">${fname}</a>
  //   `;

  //     if (!isMine && !hasDownloadedOnce(rawMediaId)) {
  //       contentHtml += waDownloadIcon(rawMediaId);
  //     } else if (!isMine) {
  //       contentHtml += waDownloadedIcon();
  //     }

  //     contentHtml += `</div>`;
  //   }

  //   // ------------------------ TEXT ------------------------
  //   else {
  //     const text = escapeHtml(messageObj.message_text || "");
  //     contentHtml = `<div class="msg-content">${text}</div>`;
  //   }

  //   const html = `
  // <div class="chat-msg ${bubbleClass}"
  //   data-msgid="${msgId}"
  //   data-tempid="${messageObj.temp_id || ""}"
  //   data-date="${iso}">
  //   ${senderHeaderHtml}
  //   ${contentHtml}
  //   <div class="msg-meta-row">
  //     <span class="msg-time">${escapeHtml(timeText)}</span>
  //     ${tickHtml}
  //   </div>
  // </div>
  // `;

  //   container.insertAdjacentHTML("beforeend", html);
  //   container.scrollTop = container.scrollHeight;

  //   // attach WA icon click handler
  //   setTimeout(() => {
  //     const el = container.querySelector(`[data-msgid="${msgId}"]`);
  //     if (!el) return;

  //     const waIcon = el.querySelector(`[data-wa="${rawMediaId}"]`);
  //     if (waIcon && FILE_URL) {
  //       waIcon.onclick = async () => {
  //         await downloadFileRobust(
  //           FILE_URL,
  //           messageObj.file_name,
  //           messageObj.mime_type
  //         );
  //         markDownloaded(rawMediaId);
  //         waIcon.outerHTML = waDownloadedIcon();
  //       };
  //     }
  //   }, 30);
  // }

  // function updateUploadProgress(tempId, percent) {
  //   const wrap = document.querySelector(
  //     `.upload-progress-wrap[data-upload="${tempId}"]`
  //   );
  //   if (!wrap) return;
  //   const inner = wrap.querySelector(".upload-progress-inner");
  //   if (inner) inner.style.width = percent + "%";
  // }

  // function markUploadFailed(tempId) {
  //   const wrap = document.querySelector(
  //     `.upload-progress-wrap[data-upload="${tempId}"]`
  //   );
  //   if (!wrap) return;
  //   wrap.classList.add("upload-failed");
  // }

  // function finalizeUploadBubble(tempId, server) {
  //   // server: { ok, message_id, file_name, mime_type, media_url }
  //   const el = document.querySelector(
  //     `.chat-msg[data-msgid="${tempId}"], .chat-msg[data-tempid="${tempId}"]`
  //   );
  //   if (!el) return;

  //   // set real id
  //   const realId = server.message_id || server.messageId || server.message_id;
  //   el.setAttribute("data-msgid", realId);
  //   el.removeAttribute("data-tempid");

  //   // remove progress UI + X
  //   const wrap = el.querySelector(".upload-progress-wrap");
  //   if (wrap) wrap.remove();

  //   // set final URL — your backend exposes /chat/file/<annotation_id>
  //   const url = `/chat/file/${server.media_url}`;
  //   const mime = server.mime_type || server.mime || "";

  //   // update elements according to mime
  //   if (mime.startsWith("image/")) {
  //     const img = el.querySelector("img.msg-image");
  //     if (img) img.src = url;
  //   } else if (mime.startsWith("video/")) {
  //     const video = el.querySelector("video.msg-video");
  //     if (video) {
  //       const source = video.querySelector("source");
  //       if (source) source.src = url;
  //       video.load();
  //     }
  //   } else if (mime.startsWith("audio/")) {
  //     const audio = el.querySelector("audio");
  //     if (audio) {
  //       audio.src = url;
  //       audio.load();
  //     }
  //   } else {
  //     // generic file: ensure <a download> exists
  //     const a = el.querySelector(".msg-file-wrap a");
  //     if (a) {
  //       a.href = url;
  //       a.textContent = server.file_name || a.textContent;
  //       a.setAttribute("download", server.file_name || "file");
  //       a.setAttribute("target", "_blank");
  //       a.setAttribute("rel", "noopener");
  //     } else {
  //       // fallback: create download link
  //       const metaRow = el.querySelector(".msg-meta-row");
  //       const node = document.createElement("div");
  //       node.className = "msg-file-wrap";
  //       node.innerHTML = `<i class="fa-solid fa-file"></i>
  //       <a href="${url}" download="${server.file_name || "file"}">${
  //         server.file_name || "Download"
  //       }</a>`;
  //       if (metaRow) metaRow.insertAdjacentElement("beforebegin", node);
  //     }
  //   }

  //   // Update local cache: replace temp message in chatCache with server message
  //   try {
  //     const convId =
  //       el.getAttribute("data-conversation") ||
  //       el.dataset.conversation ||
  //       window.currentConversationId;
  //     const cache = window.chatCache[convId] || [];
  //     const idx = cache.findIndex(
  //       (m) => m.temp_id === tempId || m.message_id === tempId
  //     );
  //     if (idx !== -1) {
  //       cache[idx] = {
  //         ...cache[idx],
  //         message_id: realId,
  //         message_id: server.message_id,
  //         media_url: server.media_url,
  //         file_name: server.file_name,
  //         mime_type: server.mime_type,
  //         created_on: server.created_on || cache[idx].created_on,
  //       };
  //       window.chatCache[convId] = cache;
  //     }
  //   } catch (e) {
  //     // non-fatal
  //     console.warn("cache update failed", e);
  //   }
  // }

  function escapeHtml(s) {
    if (!s) return "";
    return ("" + s).replace(
      /[&<>"']/g,
      (m) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[m])
    );
  }

  window.escapeHtml = escapeHtml;

  function renderStatusTickHTML(msg, isMine) {
    if (!isMine) return "";

    const status = msg.status || "sent";
    let html = `<span class="msg-ticks">`;

    if (status === "sent") html += "✓";
    else if (status === "delivered") html += "✓✓";
    else if (status === "seen")
      html += `<span style="color:#3b82f6;">✓✓</span>`;

    html += `</span>`;
    return html;
  }

  function markMessageAsFailed(tempId) {
    const el = document.querySelector(`[data-tempid="${tempId}"]`);
    if (el) {
      el.querySelector(".msg-content")?.insertAdjacentHTML(
        "afterend",
        `<div style="color:#e74c3c;font-size:12px">Failed to send</div>`
      );
    }
  }

  function updateMessageStatusLocal(tempId, status, canonicalId) {
    const el = document.querySelector(`[data-tempid="${tempId}"]`);
    if (!el) return;

    if (canonicalId) el.setAttribute("data-msgid", canonicalId);

    const fakeMsg = { status };
    const isMine = true;
    const tickHtml = renderStatusTickHTML(fakeMsg, isMine);

    let existing = el.querySelector(".msg-ticks");
    if (existing) existing.outerHTML = tickHtml;
    else el.insertAdjacentHTML("beforeend", tickHtml);
  }
  function updateMessageStatusUI(messageId, status) {
    const el = document.querySelector(`[data-msgid="${messageId}"]`);
    if (!el) return;

    const isMine = el.classList.contains("msg-sent");
    const fakeMsg = { status };
    const tickHtml = renderStatusTickHTML(fakeMsg, isMine);

    const existing = el.querySelector(".msg-ticks");
    if (existing) existing.outerHTML = tickHtml;
    else el.insertAdjacentHTML("beforeend", tickHtml);
  }

  function formatMessageTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  function getMemberNameById(id) {
    const convo =
      window.conversationList?.find(
        (c) =>
          String(c.conversation_id) === String(window.currentConversationId)
      ) || state.activeConversation;

    if (!convo || !Array.isArray(convo.members)) return id;

    const m = convo.members.find(
      (x) => String(x.id) === String(id) || String(x.emp_code) === String(id)
    );

    return m?.name || id;
  }

  // function formatChatTimestamp(iso) {
  //   if (!iso) return "";

  //   const dt = new Date(iso);
  //   const now = new Date();

  //   const isToday =
  //     dt.getDate() === now.getDate() &&
  //     dt.getMonth() === now.getMonth() &&
  //     dt.getFullYear() === now.getFullYear();

  //   const yesterday = new Date();
  //   yesterday.setDate(now.getDate() - 1);

  //   const isYesterday =
  //     dt.getDate() === yesterday.getDate() &&
  //     dt.getMonth() === yesterday.getMonth() &&
  //     dt.getFullYear() === yesterday.getFullYear();

  //   if (isToday) {
  //     return dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  //   } else if (isYesterday) {
  //     return "Yesterday";
  //   } else {
  //     return dt.toLocaleDateString([], { day: "2-digit", month: "short" });
  //   }
  // }

  // -----------------------------
  // Edit message — uses PATCH /chat/messages/<id>
  // Body: { new_text: "..."}  (backend expects this)
  // -----------------------------
  async function openEditMessageModal(msgId) {
    try {
      const msgEl = document.querySelector(`[data-msgid="${msgId}"]`);
      const oldText = msgEl?.querySelector(".msg-content")?.innerText || "";
      const newText = prompt("Edit message:", oldText);
      if (newText === null) return;

      const res = await fetch(
        `http://localhost:5000/chat/messages/${encodeURIComponent(msgId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ new_text: newText }),
        }
      );

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(t || "Edit failed");
      }

      // // update UI
      // const contentEl = msgEl.querySelector(".msg-content");
      // if (contentEl) {
      //   contentEl.innerHTML =
      //     escapeHtml(newText) +
      //     `<span style="font-size:11px;color:var(--muted)"> (edited)</span>`;
      //   contentEl.classList.remove("deleted");
      // }
      replaceMessageText(msgId, newText, true); // ✅ adds (edited)
    } catch (err) {
      console.error("Edit failed:", err);
      alert("Edit failed: " + (err.message || err));
    }
  }

  // -----------------------------
  // Delete message — uses DELETE /chat/messages/<id>
  // -----------------------------
  async function deleteMessage(msgId) {
    if (!msgId) return;
    if (!confirm("Delete this message?")) return;

    // safety: if temp upload id — cancel locally instead of calling server
    if (
      String(msgId).startsWith("tmp_upload_") ||
      String(msgId).startsWith("tmp_")
    ) {
      if (typeof cancelUpload === "function") {
        cancelUpload(msgId);
      } else {
        const el = document.querySelector(`[data-msgid="${msgId}"]`);
        if (el) el.remove();
        if (
          window.chatCache &&
          window.chatCache[window.currentConversationId]
        ) {
          window.chatCache[window.currentConversationId] = window.chatCache[
            window.currentConversationId
          ].filter((m) => (m.temp_id || m.message_id) !== msgId);
        }
      }
      return;
    }

    try {
      const res = await fetch(
        `http://localhost:5000/chat/messages/${encodeURIComponent(msgId)}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
        }
      );

      // parse body
      const text = await res.text().catch(() => "");
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        data = text;
      }

      if (!res.ok) {
        // show helpful error
        throw new Error(typeof data === "string" ? data : JSON.stringify(data));
      }

      // success → update UI
      const msgEl = document.querySelector(`[data-msgid="${msgId}"]`);
      if (msgEl) {
        // keep structure but mark deleted
        const contentEl = msgEl.querySelector(".msg-content");
        if (contentEl) {
          contentEl.innerText = "[deleted]";
          contentEl.classList.add("deleted");
        } else {
          // fallback: replace innerHTML
          msgEl.innerHTML = `<div class="msg-deleted">[deleted]</div>`;
        }
      }

      // remove from chatCache
      const convId = window.currentConversationId;
      if (
        convId &&
        window.chatCache &&
        Array.isArray(window.chatCache[convId])
      ) {
        window.chatCache[convId] = window.chatCache[convId].map((m) =>
          m.message_id === msgId ? { ...m, message_text: "[deleted]" } : m
        );
      }
    } catch (err) {
      console.error("Delete failed:", err);
      alert("Delete failed: " + (err.message || JSON.stringify(err)));
    }
  }

  function replaceMessageText(messageId, newText, markEdited = false) {
    const el = document.querySelector(`[data-msgid="${messageId}"]`);
    if (!el) return;
    const content = el.querySelector(".msg-content");
    if (content) {
      content.innerHTML =
        escapeHtml(newText) +
        (markEdited
          ? `<span style="font-size:11px;color:var(--muted)"> (edited)</span>`
          : "");
    }
  }

  function markMessageDeleted(messageId) {
    const el = document.querySelector(`[data-msgid="${messageId}"]`);
    if (!el) return;
    el.innerHTML = `<div style="font-style:italic;color:var(--muted)">This message was deleted</div>`;
  }

  function showTypingIndicator(userId) {
    const el = document.getElementById("typingIndicator");
    el.style.display = "block";
    el.innerText = `${getDisplayName(userId)} is typing...`;
  }

  function hideTypingIndicator() {
    const el = document.getElementById("typingIndicator");
    el.style.display = "none";
    el.innerText = "";
  }

  function getDisplayName(userId) {
    if (!window.conversationList) return "User";
    const convo = window.conversationList.find(
      (c) => c.conversation_id === window.currentConversationId
    );
    if (!convo) return userId;
    const m = (convo.members || []).find((x) => x.id === userId);
    return m?.name || userId;
  }

  // conversation list handling
  async function refreshConversationList() {
    try {
      const conversations = await fetchConversations();
      window.conversationCache = conversations; // ✅ cache
      renderConversationList();

      subscribePresenceForList();
    } catch (e) {
      console.warn("refreshConversationList failed", e);
    }
  }

  function renderConversationList(filter = "") {
    const container = document.getElementById("chatList");
    container.innerHTML = "";

    const myId = state.user?.id;

    const list = (window.conversationCache || []).filter((c) => {
      const name = getTargetDisplayName(c) || c.display_name || c.name || "";
      const last = c.last_message || "";

      if (!filter) return true;

      return (
        name.toLowerCase().includes(filter) ||
        last.toLowerCase().includes(filter)
      );
    });

    for (const convo of list) {
      let displayName = "";

      // DIRECT CHAT → show other user name
      if (!convo.is_group) {
        const other = (convo.members || []).find(
          (m) => String(m.id) !== String(myId)
        );
        displayName = other?.name || "Direct Chat";
      } else {
        displayName = convo.display_name || convo.name || "Group";
      }

      const el = document.createElement("div");
      el.className = "chat-item";
      el.dataset.convo = convo.conversation_id;

      const avatarLetter = getInitials(displayName);

      // TIME formatting
      const timeText = formatChatTimestamp(convo.last_message_time);

      // -------------------------------------
      // PREVIEW: WhatsApp Style
      // -------------------------------------
      let preview = "";

      if (convo.last_message) {
        const senderName =
          convo.last_sender_name && String(convo.last_sender) !== String(myId)
            ? convo.last_sender_name
            : "You";

        if (convo.is_group) {
          preview = `<b>${escapeHtml(senderName)}:</b> ${escapeHtml(
            convo.last_message
          )}`;
        } else {
          preview = escapeHtml(convo.last_message);
        }
      }

      el.innerHTML = `
        <div class="chat-avatar-sm">${avatarLetter}</div>

        <div class="chat-meta">

            <div class="chat-item-name-row">
                <span class="chat-name">${escapeHtml(displayName)}</span>
                <span class="chat-time">${timeText}</span>
            </div>

            <div class="chat-item-preview">${preview}</div>
        </div>

        <button class="chat-item-more" title="Options" data-convo="${
          convo.conversation_id
        }">
            <i class="fa-solid fa-ellipsis-vertical"></i>
        </button>
      `;

      el.onclick = () => {
        openConversationFromList(convo.conversation_id);
      };

      container.appendChild(el);

      const moreBtn = el.querySelector(".chat-item-more");
      if (moreBtn) {
        moreBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openChatItemMenu(convo.conversation_id, ev);
        });
      }
    }
  }

  async function openConversationFromList(conversation_id) {
    if (window.currentConversationId) {
      if (socket && socket.connected) {
        socket.emit("leave_room", {
          conversation_id: window.currentConversationId,
        });
      }
      emit("leave_room", { conversation_id: window.currentConversationId });
    }

    window.currentConversationId = conversation_id;

    if (socket && socket.connected) {
      socket.emit("join_room", { conversation_id });
    }
    emit("join_room", { conversation_id });

    const convo =
      (window.conversationCache || []).find(
        (c) => c.conversation_id === conversation_id
      ) || {};

    const displayName = getTargetDisplayName(convo);
    document.getElementById("chatUserName").innerText =
      displayName || "Conversation";

    // -----------------------------------
    // HEADER SUB (group members / Online)
    // -----------------------------------
    let headerSub = document.getElementById("chatHeaderSub");

    if (convo.is_group) {
      const me = String(state.user.id);
      const names = (convo.members || [])
        .filter((m) => String(m.id) !== me)
        .map((m) => m.name)
        .join(", ");

      headerSub.innerText = names || "No members";
      headerSub.style.cursor = "pointer";
    } else {
      headerSub.innerText = "Online";
      headerSub.style.cursor = "default";
    }

    // -----------------------------------
    // FIX CLICK HANDLER SAFELY
    // -----------------------------------
    // Clone the node to remove any old listeners
    const newHeaderSub = headerSub.cloneNode(true);
    headerSub.replaceWith(newHeaderSub);

    // Add click only for group
    if (convo.is_group) {
      newHeaderSub.addEventListener("click", () =>
        openGroupInfoPanel(conversation_id)
      );
    }

    // After replacing element, update headerSub reference
    headerSub = newHeaderSub;

    // -----------------------
    // Avatar
    // -----------------------
    document.getElementById("chatHeaderAvatar").innerText =
      getInitials(displayName);

    // -----------------------
    // Load messages
    // -----------------------
    // -----------------------
    // FAST MESSAGE LOADING
    // -----------------------
    const chatBox = document.getElementById("chatMessages");

    // 1️⃣ If cache exists → show instantly
    if (window.chatCache[conversation_id]) {
      renderMessages(window.chatCache[conversation_id], convo); // instant UI
    } else {
      chatBox.innerHTML = `<p style="text-align:center;color:var(--muted)">Loading...</p>`;
    }

    // 2️⃣ Always fetch latest in background (non-blocking)
    fetchMessagesForConversation(conversation_id)
      .then((messages) => {
        window.chatCache[conversation_id] = messages;
        if (window.currentConversationId === conversation_id) {
          renderMessages(messages, convo);
        }
      })
      .catch((err) => console.error("message load fail", err));

    emit("mark_read", { conversation_id, user_id: state.user.id });
  }

  // =======================
  // OPEN MESSAGE MENU
  // =======================
  window.openMessageMenu = function (messageId, senderId, event) {
    selectedMessageId = messageId;

    const menu = document.getElementById("messageMenu");
    menu.style.display = "block";

    // position menu near click/tap
    menu.style.left = event.pageX + "px";
    menu.style.top = event.pageY + "px";

    // Allow edit/delete only for sender
    if (senderId !== state.user.id) {
      document.getElementById("editMessageBtn").style.display = "none";
      document.getElementById("deleteMessageBtn").style.display = "none";
    } else {
      document.getElementById("editMessageBtn").style.display = "block";
      document.getElementById("deleteMessageBtn").style.display = "block";
    }
  };
  function openChatItemMenu(conversationId, ev) {
    // simple floating menu with actions (delete/edit/rename)
    // build menu or reuse existing chatOptionsMenu DOM if you have one
    closeAllFloatingMenus(); // implement small helper to hide existing menus
    const menu = document.createElement("div");
    menu.className = "floating-chat-item-menu";
    menu.style.position = "absolute";
    menu.style.left = ev.pageX + "px";
    menu.style.top = ev.pageY + "px";
    menu.style.zIndex = 9999;
    menu.innerHTML = `
    <button class="menu-edit" data-convo="${conversationId}">Edit name</button>
    <button class="menu-delete" data-convo="${conversationId}">Delete chat</button>
  `;
    document.body.appendChild(menu);

    // handlers
    menu.querySelector(".menu-edit").addEventListener("click", async () => {
      const convo = (window.conversationList || []).find(
        (c) => c.conversation_id === conversationId
      );
      if (!convo) return;

      if (!convo.is_group) {
        alert("Only group chats can be renamed");
        return;
      }

      const newName = prompt("Rename group to:", convo.name || "");
      if (!newName) return;

      try {
        await renameGroup(conversationId, newName);
        await refreshConversationList();
      } catch (err) {
        console.error(err);
        alert("Rename failed");
      }

      closeAllFloatingMenus();
    });

    menu.querySelector(".menu-delete").addEventListener("click", async () => {
      const convo = (window.conversationList || []).find(
        (c) => c.conversation_id === conversationId
      );
      if (!convo) return;

      // ---- DELETE GROUP ----
      if (convo.is_group) {
        if (!confirm("Delete this group?")) return;

        try {
          await deleteGroup(conversationId);
          await refreshConversationList();
        } catch (err) {
          console.error(err);
          alert("Group delete failed");
        }

        closeAllFloatingMenus();
        return;
      }

      // ---- DELETE DIRECT CHAT ----
      if (!confirm("Remove this direct chat?")) return;

      try {
        await leaveDirectChat(conversationId, state.user.id);
        await refreshConversationList();
      } catch (err) {
        console.error(err);
        alert("Direct chat delete failed");
      }

      closeAllFloatingMenus();
    });

    // close when clicking outside
    const off = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener("click", off);
      }
    };
    setTimeout(() => document.addEventListener("click", off), 10);
  }

  function closeAllFloatingMenus() {
    document
      .querySelectorAll(".floating-chat-item-menu")
      .forEach((n) => n.remove());
  }

  // Close when clicking anywhere else
  document.addEventListener("click", () => {
    document.getElementById("messageMenu").style.display = "none";
  });

  document.getElementById("chatOptionsBtn").onclick = (e) => {
    const menu = document.getElementById("chatOptionsMenu");
    menu.style.display = "block";
    menu.style.left = e.pageX + "px";
    menu.style.top = e.pageY + "px";
  };

  // Hide menu on click outside
  document.addEventListener("click", () => {
    document.getElementById("chatOptionsMenu").style.display = "none";
  });
  document.getElementById("renameGroupBtn").onclick = () => {
    const convo = window.conversationList.find(
      (c) => c.conversation_id === window.currentConversationId
    );
    if (!convo.is_group) return alert("This is not a group.");

    const newName = prompt("Enter new group name:", convo.name);
    if (!newName) return;

    convo.name = newName;
    document.getElementById("chatUserName").innerText = newName;
    renderConversationList(window.conversationList);
  };
  document.getElementById("deleteChatBtn").onclick = () => {
    const id = window.currentConversationId;
    const convo = window.conversationList.find((c) => c.conversation_id === id);

    if (convo.is_group) {
      alert("Cannot delete group chat.");
      return;
    }

    window.conversationList = window.conversationList.filter(
      (c) => c.conversation_id !== id
    );

    renderConversationList(window.conversationList);

    document.getElementById(
      "chatMessages"
    ).innerHTML = `<div class="chat-placeholder">Chat deleted</div>`;
  };

  function beautifySystemMessage(text) {
    if (!text) return text;

    if (!Array.isArray(window.allEmployees)) return text;

    return text.replace(/EMP\d+/g, (empId) => {
      const u = window.allEmployees.find((e) => String(e.id) === String(empId));
      return u ? u.name : empId;
    });
  }

  function renderMessages(messages, convo = {}) {
    const container = document.getElementById("chatMessages");
    container.innerHTML = "";

    if (!messages || messages.length === 0) {
      container.innerHTML = `
        <div class="chat-placeholder">
          <p style="color:var(--muted)">No messages yet</p>
        </div>`;
      return;
    }

    const myId = String(state.user?.id || "");

    for (const m of messages) {
      const senderId = String(m.sender_id || m.sender || "");
      const isMine = senderId === myId;

      // ✅ ✅ FIX 1: Beautify SYSTEM messages (EMP → Name)
      let finalText = m.message_text;

      if (senderId === "system") {
        finalText = beautifySystemMessage(m.message_text);
      }

      // ✅ ✅ FIX 2: Append [edited] if needed
      if (m.is_edited === true || m.edited_at) {
        finalText = `${finalText} <span class="msg-edited">[edited]</span>`;
      }

      const safeMessage = {
        ...m,
        message_text: finalText, // ✅ override safely
      };

      const opts = { is_group: !!convo.is_group };
      addMessageToUI(safeMessage, isMine, m.message_id, opts);
    }
  }

  function openMessageActionsMenu(messageId, x, y) {
    const existing = document.getElementById("msgActionMenu");
    if (existing) existing.remove();

    // -------------------------------
    // Find message safely
    // -------------------------------
    let message = null;

    try {
      const conv = window.chatCache?.[window.currentConversationId];
      if (Array.isArray(conv)) {
        message = conv.find(
          (m) => m.message_id === messageId || m.temp_id === messageId
        );
      }
    } catch (e) {}

    if (!message) return;

    const isMine = String(message.sender_id) === String(state.user?.id);
    const msgType = message.message_type || "text";

    // Create menu container
    const menu = document.createElement("div");
    menu.id = "msgActionMenu";

    menu.style.position = "fixed";
    menu.style.zIndex = "999999";
    menu.style.minWidth = "140px";
    menu.style.borderRadius = "10px";
    menu.style.padding = "6px 0";
    menu.style.boxShadow = "0 6px 18px rgba(0,0,0,0.25)";
    menu.style.backdropFilter = "blur(10px)";
    menu.style.border = "1px solid rgba(255,255,255,0.12)";

    const isDark = document.body.classList.contains("dark");
    menu.style.background = isDark ? "rgba(25,25,25,0.95)" : "#ffffff";
    menu.style.color = isDark ? "#f0f0f0" : "#222";

    // -------------------------------
    // BUILD MENU BASED ON PERMISSION
    // -------------------------------
    let html = "";

    if (isMine) {
      // Sender can edit only text
      if (msgType === "text") {
        html += `<div class="msg-menu-item" data-action="edit">Edit</div>`;
      }

      // Sender can delete
      html += `<div class="msg-menu-item" data-action="delete">Delete</div>`;
    } else {
      // Receiver → no actions
      html += `<div class="msg-menu-item disabled" style="opacity:0.6;cursor:not-allowed;">No actions</div>`;
    }

    menu.innerHTML = html;
    document.body.appendChild(menu);

    // Position menu safely
    const left = Math.min(window.innerWidth - 160, Math.max(8, x));
    const top = Math.min(window.innerHeight - 40, Math.max(8, y));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    // -------------------------------
    // ACTION HANDLERS (ONLY IF MINE)
    // -------------------------------
    if (isMine) {
      // Edit
      const editBtn = menu.querySelector('[data-action="edit"]');
      if (editBtn) {
        editBtn.onclick = () => {
          menu.remove();
          openEditMessageModal(messageId);
        };
      }

      // Delete
      const delBtn = menu.querySelector('[data-action="delete"]');
      if (delBtn) {
        delBtn.onclick = () => {
          menu.remove();

          // temp upload → local delete
          if (
            String(messageId).startsWith("tmp_upload_") ||
            String(messageId).startsWith("tmp_")
          ) {
            if (typeof cancelUpload === "function") {
              cancelUpload(messageId);
            } else {
              const el = document.querySelector(`[data-msgid="${messageId}"]`);
              if (el) el.remove();

              if (window.chatCache?.[window.currentConversationId]) {
                window.chatCache[window.currentConversationId] =
                  window.chatCache[window.currentConversationId].filter(
                    (m) => (m.temp_id || m.message_id) !== messageId
                  );
              }
            }
            return;
          }

          // server delete
          if (typeof deleteMessage === "function") {
            deleteMessage(messageId);
          } else {
            alert("Delete function not available");
          }
        };
      }
    }

    // -------------------------------
    // AUTO CLOSE ON CLICK OUTSIDE
    // -------------------------------
    setTimeout(() => {
      document.addEventListener(
        "click",
        function close(ev) {
          if (!menu.contains(ev.target)) {
            try {
              menu.remove();
            } catch (e) {}
            document.removeEventListener("click", close);
          }
        },
        { once: true }
      );
    }, 50);
  }

  function highlightSearchInMessages(q) {
    const container = document.getElementById("chatMessages");
    const msgs = container.querySelectorAll(".chat-msg");
    msgs.forEach((m) => {
      const text = (
        m.querySelector(".msg-content")?.innerText || ""
      ).toLowerCase();
      if (!q) {
        m.style.outline = "none";
      } else {
        if (text.includes(q))
          m.style.outline = "2px solid rgba(59,130,246,0.25)";
        else m.style.outline = "none";
      }
    });
  }

  function subscribePresenceForList() {
    const users = [];
    window.conversationList.forEach((c) => {
      (c.members || []).forEach((u) => {
        if (!users.includes(u.id)) users.push(u.id);
      });
    });
    if (users.length && getSocket()) {
      emit("subscribe_presence", { user_ids: users });
    }
  }

  function handleNotificationForIncoming(msg) {
    if (msg.sender_id === state.user.id) return;
    if (msg.conversation_id !== window.currentConversationId) {
      const convo = window.conversationList.find(
        (c) => c.conversation_id === msg.conversation_id
      );
      if (convo) {
        convo.unread_count = (convo.unread_count || 0) + 1;
        renderConversationList(
          document.getElementById("chatSearchInput").value.trim().toLowerCase()
        );
      } else {
        refreshConversationList();
      }
      playNotificationSound();
    } else {
      emit("mark_read", {
        conversation_id: msg.conversation_id,
        user_id: state.user.id,
      });
    }
  }

  function playNotificationSound() {
    try {
      const audio = new Audio(NOTIFY_SOUND);
      audio.play().catch(() => {});
    } catch (e) {}
  }

  async function updateUserPresence(data) {
    if (!window.currentConversationId) return;
    const convo = window.conversationList.find(
      (c) => c.conversation_id === window.currentConversationId
    );
    if (!convo) return;
    const member = (convo.members || []).find((m) => m.id === data.user_id);
    if (!member) return;
    const el = document.getElementById("chatUserStatus");
    if (data.online) el.innerText = "Online";
    else
      el.innerText = data.last_seen
        ? `Last seen ${new Date(data.last_seen).toLocaleString()}`
        : "Offline";
  }

  document.getElementById("createNewChat").onclick = () => {
    const btn = document.getElementById("createNewChat");

    runButtonWithLoading(btn, async () => {
      // ✅ your existing modal logic stays SAME
      openNewChatUI();
    });
  };

  async function openNewChatUI() {
    const employees = await fetchAllEmployees();

    renderModal(
      "New Conversation",
      `
  <!-- LEFT COLUMN -->
  <input id="empSearchInput" placeholder="Search employee..." />

  <!-- RIGHT COLUMN -->
  <div id="empListBox"></div>

  <!-- BUTTON ROW (FULL WIDTH) -->
  <div>
    <button id="directChatBtn">Direct Chat</button>
    <button id="groupChatBtn">Group Chat</button>
  </div>
  `,
      null
    );
    const modal = document.querySelector(".modal");
    if (modal) modal.classList.add("create-chat");

    const listBox = document.getElementById("empListBox");
    const searchBox = document.getElementById("empSearchInput");
    const directBtn = document.getElementById("directChatBtn");
    const groupBtn = document.getElementById("groupChatBtn");

    let selected = new Set();

    function renderEmpList(filter = "") {
      listBox.innerHTML = "";

      employees
        .filter((e) => e.name.toLowerCase().includes(filter))
        .forEach((e) => {
          const row = document.createElement("div");
          row.style = `
                    padding:6px 4px;
                    display:flex;
                    align-items:center;
                    gap:10px;
                    cursor:pointer;
                `;

          row.innerHTML = `
                    <input type="checkbox" data-id="${e.id}">
                    <span>${e.name}</span>
                `;

          const checkbox = row.querySelector("input");

          checkbox.addEventListener("change", () => {
            if (checkbox.checked) selected.add(e.id);
            else selected.delete(e.id);
            updateButtons();
          });

          row.addEventListener("click", (ev) => {
            if (ev.target.tagName !== "INPUT") {
              checkbox.checked = !checkbox.checked;
              checkbox.dispatchEvent(new Event("change"));
            }
          });

          listBox.appendChild(row);
        });

      updateButtons();
    }

    function updateButtons() {
      // ✅ Direct only if 1 selected
      if (selected.size === 1) {
        directBtn.disabled = false;
        directBtn.classList.remove("btn-disabled");
      } else {
        directBtn.disabled = true;
        directBtn.classList.add("btn-disabled");
      }

      // ✅ Group only if 2 or more selected
      if (selected.size >= 2) {
        groupBtn.disabled = false;
        groupBtn.classList.remove("btn-disabled");
      } else {
        groupBtn.disabled = true;
        groupBtn.classList.add("btn-disabled");
      }
    }

    searchBox.addEventListener("input", () => {
      renderEmpList(searchBox.value.trim().toLowerCase());
    });

    renderEmpList();
    // ✅ MUTUAL BUTTON DISABLE ON CLICK
    directBtn.addEventListener("click", () => {
      groupBtn.disabled = true;
      groupBtn.classList.add("btn-disabled");
    });

    groupBtn.addEventListener("click", () => {
      directBtn.disabled = true;
      directBtn.classList.add("btn-disabled");
    });

    // 📌 DIRECT CHAT ACTION
    directBtn.onclick = async () => {
      if (selected.size !== 1) return;

      const targetId = [...selected][0];

      await runButtonWithLoading(directBtn, async () => {
        await startDirectChat(targetId);
        closeModal();
        refreshConversationList();
      });
    };

    // 📌 GROUP CHAT ACTION
    groupBtn.onclick = async () => {
      if (selected.size < 1) {
        alert("Select at least one member.");
        return;
      }

      const groupName = prompt("Enter group name:");
      if (!groupName || !groupName.trim()) {
        alert("Group name is required.");
        return;
      }

      await runButtonWithLoading(groupBtn, async () => {
        await createGroupChat(groupName.trim(), [...selected]);
        closeModal();
        refreshConversationList();
      });
    };
  }

  // modal flows (search/start group)
  // function openChatOptionsModal() {
  //   renderModal(
  //     "New Chat",
  //     `
  //     <button id="startDirectChatBtn" class="btn btn-primary" style="width:100%;margin-bottom:10px;">Start Direct Chat</button>
  //     <button id="startGroupChatBtn" class="btn btn-primary" style="width:100%;">Create Group</button>
  //   `,
  //     []
  //   );
  //   document.getElementById("startDirectChatBtn").onclick = () => {
  //     closeModal();
  //     openUserSearchModal(false);
  //   };
  //   document.getElementById("startGroupChatBtn").onclick = () => {
  //     closeModal();
  //     openGroupCreateModal([]);
  //   };
  // }

  function openUserSearchModal(
    isGroup,
    selectedMembers = [],
    savedGroupName = ""
  ) {
    renderModal(
      "Search Employee",
      `
      <input id="seUser" placeholder="Search employee..." style="width:100%; padding:8px; margin:10px 0;" />
      <div id="seResults" style="max-height:320px; overflow:auto"></div>
    `,
      []
    );

    function renderSearchResults(list) {
      const container = document.getElementById("seResults");
      container.innerHTML = list
        .map(
          (emp) => `
      <div class="chat-item se-item" data-id="${
        emp.id
      }" style="padding:8px;cursor:pointer;">
        <div class="chat-avatar-sm">${
          emp.avatar || (emp.name || "U").slice(0, 1)
        }</div>
        <div style="margin-left:8px;">
          <div class="chat-item-name">${emp.name}</div>
          <div class="chat-item-last" style="font-size:12px;color:var(--muted)">${
            emp.email || ""
          }</div>
        </div>
      </div>`
        )
        .join("");

      document.querySelectorAll(".se-item").forEach((item) => {
        item.addEventListener("click", async () => {
          const id = item.dataset.id;
          if (!isGroup) {
            await directChatStart(id);
          } else {
            selectedMembers.push(id);
            openGroupCreateModal(selectedMembers, savedGroupName);
          }
        });
      });
    }

    const searchBox = document.getElementById("seUser");

    // Focus -> show ALL employees (uses /chat/employees/all)
    searchBox.addEventListener("focus", async () => {
      try {
        const all = await fetchAllEmployees();
        renderSearchResults(all || []);
      } catch (e) {
        console.warn("fetchAllEmployees failed", e);
      }
    });

    // Input search
    searchBox.addEventListener("input", async (e) => {
      const query = e.target.value.trim();
      if (query.length < 1) {
        const all = await fetchAllEmployees();
        return renderSearchResults(all || []);
      }
      try {
        const results = await searchEmployees(query);
        renderSearchResults(results || []);
      } catch (err) {
        console.warn("employee search failed", err);
        renderSearchResults([]);
      }
    });

    // Preload the list quickly
    (async () => {
      try {
        const all = await fetchAllEmployees();
        renderSearchResults(all || []);
      } catch (e) {}
    })();
  }

  async function directChatStart(empId) {
    closeModal();

    const myId = state.user.id;
    const convoTempId = "temp_" + Date.now();

    // 1️⃣ Create temporary conversation object (instant UI)
    const tempConvo = {
      conversation_id: convoTempId,
      is_group: false,
      members: [
        { id: myId, name: state.user.name },
        { id: empId, name: "Loading..." },
      ],
      last_message: "",
      last_message_time: new Date().toISOString(),
    };

    // Insert into CACHE immediately
    window.conversationCache.unshift(tempConvo);

    // Render sidebar immediately
    renderConversationList(window.conversationCache);

    // Open temporary chat instantly
    openConversationFromList(convoTempId);

    // 2️⃣ Now call backend in background
    try {
      const data = await startDirectChat(empId);

      // Update cache: replace temp convo with real convo
      const idx = window.conversationCache.findIndex(
        (c) => c.conversation_id === convoTempId
      );

      if (idx !== -1) {
        window.conversationCache[idx] = data; // real server convo
      }

      // Update list UI instantly
      renderConversationList(window.conversationCache);

      // If user is still inside temp convo → switch to real convo
      if (window.currentConversationId === convoTempId) {
        openConversationFromList(data.conversation_id);
      }
    } catch (err) {
      console.error("directChatStart failed", err);
      alert("Failed to create chat");

      // remove temp convo
      window.conversationCache = window.conversationCache.filter(
        (c) => c.conversation_id !== convoTempId
      );

      renderConversationList(window.conversationCache);
    }
  }

  function openConversationById(conversation_id) {
    const el = document.querySelector(`[data-convo="${conversation_id}"]`);
    if (el) el.click();
    else {
      refreshConversationList().then(() => {
        const el2 = document.querySelector(`[data-convo="${conversation_id}"]`);
        if (el2) el2.click();
      });
    }
  }

  function openGroupCreateModal(selectedMembers = [], savedGroupName = "") {
    renderModal(
      "Create Group",
      `
      <input id="groupName" placeholder="Group name..." 
             value="${savedGroupName}" 
             style="width:100%; padding:8px; margin-bottom:10px;" />

      <button id="addMemberBtn" class="btn btn-primary" style="margin-bottom:10px;">
          Add Members
      </button>

      <div id="selectedMembersList" style="margin-top:10px;">
        ${
          selectedMembers.length
            ? selectedMembers
                .map(
                  (id) => `<div class="member-chip" data-id="${id}">
                ${id} <span class="remove-x" style="cursor:pointer;margin-left:6px;color:red;">×</span>
              </div>`
                )
                .join("")
            : "<p style='color:var(--muted)'>No members added</p>"
        }
      </div>
    `,
      [
        { id: "cancelGroup", text: "Cancel", className: "btn-secondary" },
        {
          id: "confirmCreateGroup",
          text: "Create Group",
          className: "btn-primary",
        },
      ]
    );

    // ------------------------------------------
    // MEMBER REMOVE
    // ------------------------------------------
    document.querySelectorAll(".remove-x").forEach((x) => {
      x.onclick = () => {
        const id = x.parentElement.dataset.id;
        const idx = selectedMembers.indexOf(id);
        if (idx !== -1) selectedMembers.splice(idx, 1);

        // preserve name when rerender
        const gname = document.getElementById("groupName").value;
        openGroupCreateModal(selectedMembers, gname);
      };
    });

    // ------------------------------------------
    // ADD MEMBERS
    // ------------------------------------------
    document.getElementById("addMemberBtn").onclick = () => {
      const gname = document.getElementById("groupName").value;
      openUserSearchModal(true, selectedMembers, gname);
    };

    // ------------------------------------------
    // CREATE FINAL GROUP
    // ------------------------------------------
    document.getElementById("confirmCreateGroup").onclick = async () => {
      const name = document.getElementById("groupName").value.trim();
      if (!name) return alert("Enter group name");
      if (selectedMembers.length === 0) return alert("Add at least one member");

      closeModal();

      const myId = state.user.id;
      const tempGroupId = "temp_grp_" + Date.now();

      // 1️⃣ TEMP GROUP OBJECT (Instant UI)
      const tempGroup = {
        conversation_id: tempGroupId,
        is_group: true,
        name,
        display_name: name,
        members: [
          { id: myId, name: state.user.name },
          ...selectedMembers.map((id) => ({ id, name: "Loading…" })),
        ],
        last_message: "",
        last_message_time: new Date().toISOString(),
      };

      // Add to cache instantly
      window.conversationCache.unshift(tempGroup);
      renderConversationList(window.conversationCache);

      // Open temp group immediately
      openConversationFromList(tempGroupId);

      // 2️⃣ BACKEND SAVE IN BACKGROUND
      try {
        const real = await createGroupChat(name, selectedMembers);

        // Replace temp -> real
        const i = window.conversationCache.findIndex(
          (c) => c.conversation_id === tempGroupId
        );

        if (i !== -1) window.conversationCache[i] = real;

        renderConversationList(window.conversationCache);

        // If user still inside temporary group, switch to real one
        if (window.currentConversationId === tempGroupId) {
          openConversationFromList(real.conversation_id);
        }
      } catch (err) {
        alert("Failed to create group");

        // Remove temp UI entry
        window.conversationCache = window.conversationCache.filter(
          (c) => c.conversation_id !== tempGroupId
        );
        renderConversationList(window.conversationCache);
      }
    };

    document.getElementById("cancelGroup").onclick = closeModal;
  }

  // initial load: register socket and refresh list
  if (getSocket()) {
    // register socket with user id so server tracks presence
    emit("chat_register", { user_id: state.user.id });
  }

  // small safety: if socket connects later, register on connect
  if (getSocket() && getSocket().on) {
    getSocket().on("connect", () => {
      emit("chat_register", { user_id: state.user.id });
      // subscribe presence to conversation users if any
      subscribePresenceForList();
    });
  }

  await refreshConversationList();
}; // end renderChatPage

// exports for other modules if needed (ES module)
function getInitials(name = "") {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase(); // One word → first 2 letters
  return (parts[0][0] + parts[1][0]).toUpperCase(); // Two words → first letters
}

async function fetchGroupMembers(conversationId) {
  try {
    // Adapt to your backend conversation members endpoint if you have one
    // fallback fetch from existing conversation list:
    const convo = (window.conversationList || []).find(
      (c) => c.conversation_id === conversationId
    );
    if (convo && convo.members) return convo.members;
    // else, call backend if you have an endpoint; example:
    // const res = await fetch(`http://localhost:5000/chat/conversations/${conversationId}/members`);
    // return await res.json();
    return [];
  } catch (err) {
    console.warn("fetchGroupMembers failed:", err);
    return [];
  }
}

function openGroupInfoPanel(conversation_id) {
  const convo = (window.conversationCache || []).find(
    (c) => c.conversation_id === conversation_id
  );

  if (!convo) return;

  let members;

  // ✅ Cache reuse
  if (window.groupMemberCache[conversation_id]) {
    members = window.groupMemberCache[conversation_id];
  } else {
    members = convo.members || [];
    window.groupMemberCache[conversation_id] = members;
  }

  const me = String(state.user.id);

  // const members = convo.members || [];

  // Build member list display + selection
  const memberListHTML = members
    .map((m) => {
      const isMe = String(m.id) === me;
      return `
        <div class="group-member-item">
            ${
              !isMe
                ? `<input type="checkbox" class="removeMemberChk" value="${m.id}">`
                : ""
            }
            <span>${m.name}${isMe ? " (You)" : ""}</span>
        </div>`;
    })
    .join("");

  // ACTUAL MODAL
  const html = `
    <div class="group-info-container">

      <h2 class="modal-title">Group Info</h2>
      <hr class="divider"/>

      <h3 class="section-title">Members (${members.length})</h3>

      <div class="member-list">
        ${memberListHTML}
      </div>

      <div class="actions-row">
        <button id="addMembersBtn" class="btn btn-primary">+ Add Members</button>
        <button id="deleteMembersBtn" class="btn btn-danger">Delete Selected</button>
      </div>

    </div>
  `;

  renderModal("Group Info", html, [], "large");

  // Attach actions
  document.getElementById("addMembersBtn").onclick = () => {
    closeModal(); // 🔥 IMPORTANT — prevents double modal/form stacking
    setTimeout(() => {
      openAddMembersPanel(conversation_id);
    }, 10);
  };

  document.getElementById("deleteMembersBtn").onclick = () =>
    performRemoveMembers(conversation_id);
}

async function openAddMembersPanel(conversation_id) {
  const employees = await fetchAllEmployees();
  const convo =
    window.conversationList.find(
      (c) => c.conversation_id === conversation_id
    ) || {};

  const existingIds = new Set((convo.members || []).map((m) => String(m.id)));

  const listHTML = employees
    .filter((e) => !existingIds.has(String(e.id)))
    .map(
      (e) => `
        <div class="group-member-item">
          <input type="checkbox" class="addMemberChk" value="${e.id}">
          <span>${e.name}</span>
        </div>
      `
    )
    .join("");

  // ✅ ✅ GRID LAYOUT — SAME AS CREATE CHAT
  const html = `
    <div class="modal-body">

      <!-- LEFT SIDE (SEARCH) -->
      <div>
        <input 
          type="text" 
          id="searchAddMember" 
          placeholder="Search..." 
          class="search-box"
        />

      </div>

      <!-- RIGHT SIDE (EMP LIST) -->
      <div id="addMemberList" class="member-list">
        ${listHTML}
      </div>

      <!-- ✅ ACTION ROW (BOTTOM CENTER) -->
      <div style="grid-column:1 / 3;text-align:center;margin-top:14px;">
        <button 
          id="confirmAddMembers" 
          type="button" 
          class="btn btn-primary"
        >
          Add Selected
        </button>
      </div>

    </div>
  `;

  renderModal("Add Members", html, [], "large add-members", "Save", () => {
    const addBtn = document.getElementById("confirmAddMembers");

    addBtn.addEventListener("click", async () => {
      await runButtonWithLoading(addBtn, async () => {
        await performAddMembers(conversation_id);

        // ✅ AUTO REFRESH GROUP INFO AFTER ADD
        closeModal();
        setTimeout(() => {
          openGroupInfoPanel(conversation_id);
        }, 150);
      });
    });

    // ✅ LIVE SEARCH FILTER
    document.getElementById("searchAddMember").oninput = (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll(".group-member-item").forEach((row) => {
        row.style.display = row.innerText.toLowerCase().includes(q)
          ? ""
          : "none";
      });
    };
  });
}

// -----------------------------
// FIX: performAddMembers
// Replace your current function with this (fixes stray dot syntax error)
// -----------------------------
async function performAddMembers(conversation_id) {
  const checked = [...document.querySelectorAll(".addMemberChk:checked")].map(
    (x) => x.value
  );

  if (!checked.length) return alert("Select at least one member");

  try {
    await addMembersToGroup(conversation_id, checked);

    // Just tell socket who was added – NO local system text here
    emit("group_add_members", {
      conversation_id,
      members: checked,
      actor: state.user.id,
    });

    closeModal();

    // Keep your refresh + re-open logic
    setTimeout(() => {
      openGroupInfoPanel(conversation_id);
    }, 150);

    if (typeof window.refreshConversationList === "function") {
      await window.refreshConversationList();
      window.currentConversation = window.conversationList.find(
        (c) => String(c.conversation_id) === String(conversation_id)
      );
    }

    alert("Members added successfully!");
  } catch (err) {
    console.error("Add members failed:", err);
    alert("Failed to add: " + (err.message || err));
  }
}

// -----------------------------
// FIX: performRemoveMembers
// Replace your current function with this (fixes stray dot etc)
// -----------------------------
async function performRemoveMembers(conversation_id) {
  const checked = Array.from(
    document.querySelectorAll(".removeMemberChk:checked")
  ).map((n) => n.value);

  if (!checked.length) {
    return alert("Select at least one member");
  }

  try {
    const btn = document.getElementById("confirmRemoveMembers");

    if (btn) {
      await runButtonWithLoading(btn, async () => {
        await removeMembersFromGroup(conversation_id, checked);

        emit("group_remove_members", {
          conversation_id,
          members: checked,
          actor: state.user.id,
        });

        // ⚠️ NOTE: no addSystemMessageToChat() here
      });
    } else {
      await removeMembersFromGroup(conversation_id, checked);

      emit("group_remove_members", {
        conversation_id,
        members: checked,
        actor: state.user.id,
      });

      // ⚠️ NOTE: no addSystemMessageToChat() here
    }

    closeModal();
    setTimeout(() => {
      openGroupInfoPanel(conversation_id);
    }, 150);

    if (typeof window.refreshConversationList === "function") {
      await window.refreshConversationList();
      window.currentConversation = window.conversationList.find(
        (c) => String(c.conversation_id) === String(conversation_id)
      );
    }
  } catch (err) {
    console.error("performRemoveMembers failed:", err);
    alert("Failed to remove members: " + (err.message || err));
  }
}

function addSystemMessageToChat(text) {
  const container = document.getElementById("chatMessages");

  const div = document.createElement("div");
  div.className = "system-message";
  div.innerText = text;

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function cancelUpload(tempId) {
  try {
    console.log("Cancelling upload:", tempId);

    // Remove pending upload entry (if exists)
    if (window.pendingUploads && window.pendingUploads[tempId]) {
      delete window.pendingUploads[tempId];
    }

    // Find bubble element
    const container = document.getElementById("chatMessages");
    const bubble = container.querySelector(
      `.chat-msg[data-tempid="${tempId}"]`
    );

    // Remove the optimistic bubble from UI
    if (bubble) {
      bubble.remove();
    }
  } catch (err) {
    console.error("cancelUpload failed:", err);
  }
}

function getMessageById(messageId) {
  const conv = window.chatCache?.[window.currentConversationId];
  if (!Array.isArray(conv)) return null;
  return conv.find(
    (m) => m.message_id === messageId || m.temp_id === messageId
  );
}
