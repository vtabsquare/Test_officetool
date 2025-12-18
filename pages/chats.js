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
  getGroupMembers,
  muteGroup,
  leaveGroup,
  makeGroupAdmin,
  updateGroupDescription,
  updateGroupIcon,
  leaveDirectChat,
  editMessageApi,
  deleteMessageApi,
  sendWithProgress,
  sendMultipleFilesApi,
  markMessagesRead,
  sendTextMessageWithReply,
} from "../features/chatapi.js";

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

function getChatSearchFilter() {
  return (document.getElementById("chatSearchInput")?.value || "")
    .trim()
    .toLowerCase();
}

function setGroupComposerDisabled(disabled, reasonText = "") {
  const input = document.getElementById("chatMessageInput");
  const sendBtn = document.getElementById("sendMessageBtn");
  const mediaBtn = document.getElementById("mediaMenuBtn");

  if (input) {
    input.disabled = !!disabled;
    input.placeholder = disabled
      ? (reasonText || "You're no longer a participant")
      : "Type a message";
  }
  if (sendBtn) sendBtn.disabled = !!disabled;
  if (mediaBtn) {
    mediaBtn.style.pointerEvents = disabled ? "none" : "auto";
    mediaBtn.style.opacity = disabled ? "0.55" : "1";
  }
}

function updateGroupHeaderSubFromConvo(conversation_id) {
  const convo = (window.conversationCache || []).find(
    (c) => String(c.conversation_id) === String(conversation_id)
  );
  if (!convo?.is_group) return;
  const headerSub = document.getElementById("chatHeaderSub");
  if (!headerSub) return;

  const me = String(state.user?.id || "");
  const names = (convo.members || [])
    .filter((m) => String(m.id) !== me)
    .map((m) => m.name)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .join(", ");
  headerSub.innerText = names || "No members";
}

// Reply-to state
window.replyToMessage = null; // { message_id, sender_name, message_text }
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
      /* WhatsApp-inspired Light Mode */
      --bg: #efeae2; /* WhatsApp chat background */
      --surface: #ffffff;
      --panel: #ffffff;
      --muted: #667781;
      --text: #111b21;
      --primary: #00a884; /* WhatsApp green */
      --accent: #25d366; /* WhatsApp light green */
      --border: #e9edef;
      --hover: rgba(0,0,0,0.05);
      --input-bg: #f0f2f5;
      --card: #ffffff;
      --chip: #e9edef;
      --shadow: 0 1px 3px rgba(11,20,26,0.08);
      --shadow-soft: 0 1px 2px rgba(11,20,26,0.04);
      --bubble-out: #d9fdd3; /* WhatsApp sent message */
      --bubble-in: #ffffff; /* WhatsApp received message */
      --header-bg: #f0f2f5;
      --chat-bg: url("data:image/svg+xml,%3Csvg width='100' height='100' xmlns='http://www.w3.org/2000/svg'%3E%3Cdefs%3E%3Cpattern id='p' width='20' height='20' patternUnits='userSpaceOnUse'%3E%3Ccircle cx='2' cy='2' r='1' fill='%23d1d7db' opacity='0.3'/%3E%3C/pattern%3E%3C/defs%3E%3Crect fill='url(%23p)' width='100' height='100'/%3E%3C/svg%3E");
    }

    /* WhatsApp-inspired Dark Mode */
    .dark-mode, [data-theme='dark'] {
      --bg: #0b141a; /* WhatsApp dark background */
      --surface: #111b21;
      --panel: #111b21;
      --muted: #8696a0;
      --text: #e9edef;
      --primary: #00a884;
      --accent: #25d366;
      --border: #222d34;
      --hover: rgba(255,255,255,0.06);
      --input-bg: #2a3942;
      --card: #1f2c33;
      --chip: #2a3942;
      --bubble-out: #005c4b; /* WhatsApp dark sent */
      --bubble-in: #1f2c33; /* WhatsApp dark received */
      --header-bg: #202c33;
    }


    /* container */
    .chat-wrapper{
      display:flex;
      gap:18px;
      height: calc(100vh - 80px);
      padding: 18px;
      box-sizing: border-box;
      align-items:stretch;
      background: var(--bg);
    }

    /* left column */
    .chat-left{
      width: 320px;
      min-width: 280px;
      max-width: 360px;
      background: var(--surface);
      border-radius: 16px;
      border: 1px solid var(--border);
      overflow: hidden;
      display:flex;
      flex-direction:column;
      box-shadow: var(--shadow-soft);
    }

    .chat-left-header{
      display:flex;
      align-items:center;
      justify-content:space-between;
      padding:16px 16px 10px;
      font-weight:700;
      font-size:18px;
      color:var(--text);
      border-bottom:1px solid var(--border);
      background: var(--surface);
    }

    .chat-left-header .chat-left-title{
      display:flex;
      align-items:center;
      gap:10px;
      min-width:0;
    }

    .chat-left-header .chat-left-title span{
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }

    .chat-left-tabs{
      display:flex;
      gap:8px;
      padding: 10px 16px 12px;
    }

    .chat-tab{
      flex:1;
      border:none;
      background: var(--chip);
      color: var(--muted);
      border-radius: 999px;
      padding: 10px 12px;
      font-weight: 600;
      font-size: 13px;
      cursor:pointer;
      transition: background .12s ease, color .12s ease, transform .06s ease;
    }

    .chat-tab:hover{
      transform: translateY(-1px);
    }

    .chat-tab.active{
      background: rgba(0,168,132,0.15);
      color: var(--primary);
      font-weight: 600;
    }

    #createNewChat{
      background: var(--primary);
      border:none;
      color:white;
      width:40px;
      height:40px;
      border-radius: 50%;
      display:flex;
      align-items:center;
      justify-content:center;
      cursor:pointer;
      font-size:16px;
      transition: background 0.15s ease;
    }

    #createNewChat:hover{
      background: var(--accent);
    }

    .chat-search{
      padding: 0 16px 14px;
      border-bottom:1px solid var(--border);
    }

    .chat-search .chat-search-box{
      display:flex;
      align-items:center;
      gap:10px;
      padding: 10px 12px;
      border-radius: 999px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.06);
      transition: border-color 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
    }

    .chat-search .chat-search-box:focus-within{
      background: rgba(255,255,255,0.05);
      border-color: rgba(0,168,132,0.35);
      box-shadow: 0 0 0 3px rgba(0,168,132,0.12);
    }

    .chat-search .chat-search-box i{
      color: var(--muted);
      font-size: 13px;
    }

    .chat-search input{
      width:100%;
      border:none;
      background:transparent;
      color:var(--text);
      outline:none;
      font-size:13px;
      box-sizing:border-box;
    }

    .chat-search input::placeholder{
      color: var(--muted);
      opacity: 0.9;
    }

    .chat-list{
      flex:1;
      overflow:auto;
      padding: 10px 10px;
    }

    .chat-item{
      display:flex;
      gap:12px;
      padding: 12px 12px;
      align-items:center;
      border-radius: 14px;
      cursor:pointer;
      transition: background .12s ease, transform .06s ease;
      color:var(--text);
    }

    .chat-item:hover{
      background: var(--hover);
      transform: translateY(-1px);
    }

    .chat-item.active{
      background: rgba(91,61,245,0.10);
      box-shadow: inset 0 0 0 1px rgba(91,61,245,0.10);
    }

    .chat-avatar-sm{
      width:44px;
      height:44px;
      border-radius: 50%;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); /* Soft purple-blue gradient */
      color:white;
      display:flex;
      align-items:center;
      justify-content:center;
      font-weight:700;
      font-size:14px;
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
      gap: 8px;
    }

    .chat-item .chat-item-time {
      font-size: 11px;
      color: var(--muted);
      font-weight: 400;
      white-space: nowrap;
    }

    .chat-item .chat-item-options {
      opacity: 0;
      transition: opacity 0.15s ease;
      margin-left: 4px;
    }

    .chat-item:hover .chat-item-options {
      opacity: 1;
    }

    .chat-item .chat-item-options button {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
    }

    .chat-item .chat-item-options button:hover {
      background: var(--hover);
      color: var(--text);
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

    /* Chat item name row with time */
    .chat-item .chat-item-name-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }

    .chat-item .chat-name {
      font-weight: 600;
      font-size: 14px;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .chat-item .chat-time {
      font-size: 11px;
      color: var(--muted);
      white-space: nowrap;
      flex-shrink: 0;
    }

    .chat-item .chat-item-preview {
      font-size: 13px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 200px;
    }

    .chat-item .chat-item-more {
      position: absolute;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      padding: 6px;
      border-radius: 50%;
      opacity: 0;
      transition: opacity 0.15s ease, background 0.15s ease;
    }

    .chat-item:hover .chat-item-more {
      opacity: 1;
    }

    .chat-item .chat-item-more:hover {
      background: var(--hover);
      color: var(--text);
    }

    .chat-item {
      position: relative;
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
      border-radius: 16px;
      border: 1px solid var(--border);
      min-width:0;
      box-shadow: var(--shadow);
    }

    /* header layout EXACT like requested */
    .chat-right-header{
      display:flex;
      align-items:center;
      gap:12px;
      position: relative;
      z-index: 5;
      padding: 14px 16px;
      border-bottom:1px solid var(--border);
      background: var(--surface);
    }

    .chat-avatar-lg{
      width:46px;
      height:46px;
      border-radius:50%;
      background: linear-gradient(180deg, var(--primary), var(--accent));
      display:flex;
      align-items:center;
      justify-content:center;
      color:white;
      font-weight:800;
      font-size:16px;
      flex-shrink:0;
      box-shadow: 0 10px 24px rgba(91,61,245,0.18);
    }

    .chat-header-main{
      display:flex;
      flex-direction:column;
      gap:4px;
      min-width:0;
      overflow:hidden;
    }

    .chat-right-name{
      font-weight:800;
      color:var(--text);
      font-size:16px;
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
      padding: 18px;
      background: var(--bg);
      display: flex;
      flex-direction: column;
    }

    .chat-placeholder{
      text-align:center;
      margin-top:90px;
      color:var(--muted);
    }

    .chat-msg{
      display: flex;
      flex-direction: column;
      padding: 10px 14px;
      border-radius: 8px;
      margin: 4px 0;
      word-wrap:break-word;
      max-width: 65%;
      width: fit-content;
      font-size:14px;
      line-height:1.4;
      position: relative;
    }

    .msg-sent{
      margin-left: auto;
      background: #dcf8c6; /* WhatsApp light green */
      color: #111b21;
      border-top-right-radius: 0;
      box-shadow: 0 1px 0.5px rgba(11,20,26,0.13);
    }

    .msg-received{
      margin-right: auto;
      background: #ffffff;
      color: #111b21;
      border-top-left-radius: 0;
      box-shadow: 0 1px 0.5px rgba(11,20,26,0.13);
    }

    /* Dark mode bubbles */
    .dark-mode .msg-sent, [data-theme='dark'] .msg-sent {
      background: #005c4b;
      color: #e9edef;
    }

    .dark-mode .msg-received, [data-theme='dark'] .msg-received {
      background: #202c33;
      color: #e9edef;
    }

    .msg-content{ display:block; }

    .msg-ticks{
      font-size:11px;
      margin-left:6px;
      color: var(--muted);
      display: inline-flex;
      align-items: center;
    }

    /* Message meta row - time and ticks */
    .msg-meta-row {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 4px;
      margin-top: 4px;
    }

    .msg-time {
      font-size: 11px;
      color: var(--muted);
    }

    /* 3-dot options button in message bubble */
    .msg-options-btn {
      position: absolute;
      top: 6px;
      right: 6px;
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      padding: 4px 6px;
      border-radius: 4px;
      opacity: 0.75;
      transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
      font-size: 12px;
      z-index: 2;
    }

    .chat-msg {
      padding-top: 18px;
    }

    .chat-msg:hover .msg-options-btn {
      opacity: 1;
      color: var(--text);
    }

    .msg-options-btn:hover {
      background: rgba(0,0,0,0.1);
    }

    .dark-mode .msg-options-btn:hover,
    [data-theme='dark'] .msg-options-btn:hover {
      background: rgba(255,255,255,0.1);
    }

    .msg-ticks i{
      font-size: 12px;
      line-height: 1;
    }

    /* Forward modal layout fix */
    .modal.forward-modal .modal-body{
      padding-top: 16px !important;
      overflow: hidden !important;
    }

    .modal.forward-modal .forward-list{
      padding-top: 8px;
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
      padding: 7px 12px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.06);
      color:var(--text);
    }

    .messages-search-bar input{
      padding: 6px 6px;
      border:none;
      outline:none;
      background:transparent;
      color:var(--text);
      width:180px;
      font-size: 13px;
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
      padding: 12px 14px;
      display:flex;
      gap:10px;
      align-items:center;
      border-top:1px solid var(--border);
      background: var(--surface);
    }

    .icon-btn{
      width:44px;
      height:44px;
      border-radius: 14px;
      background: var(--input-bg);
      border: 1px solid rgba(0,0,0,0.04);
      display:flex;
      align-items:center;
      justify-content:center;
      cursor:pointer;
      color:var(--muted);
      transition: transform .06s ease, background .12s ease;
    }

    .icon-btn:hover{
      background: rgba(0,168,132,0.1);
      color: var(--primary);
    }

    .chat-input input[type="text"]{
      flex:1;
      padding: 14px 16px;
      border-radius: 16px;
      border: 1px solid rgba(0,0,0,0.04);
      background: var(--input-bg);
      color:var(--text);
      outline:none;
      font-size: 14px;
    }

    .send-btn{
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: var(--primary);
      border:none;
      color:white;
      display:flex;
      align-items:center;
      justify-content:center;
      cursor:pointer;
      font-size:18px;
      transition: background 0.15s ease;
    }

    .send-btn:hover{
      background: var(--accent);
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

    /* Floating chat item menu */
    .floating-chat-item-menu {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.15);
      overflow: hidden;
      min-width: 160px;
    }

    .floating-chat-item-menu button {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 12px 16px;
      background: transparent;
      border: none;
      color: var(--text);
      font-size: 14px;
      cursor: pointer;
      text-align: left;
      transition: background 0.12s ease;
    }

    .floating-chat-item-menu button:hover {
      background: var(--hover);
    }

    .floating-chat-item-menu button i {
      width: 16px;
      color: var(--muted);
    }

    .floating-chat-item-menu .menu-delete {
      color: #ef4444;
    }

    .floating-chat-item-menu .menu-delete i {
      color: #ef4444;
    }

    /* floating menus (message actions / chat options) */
    #messageMenu,
    #chatOptionsMenu {
      background: var(--surface) !important;
      border: 1px solid var(--border) !important;
      border-radius: 12px !important;
      box-shadow: var(--shadow-soft) !important;
      overflow: hidden;
    }

    #messageMenu button,
    #chatOptionsMenu button {
      width: 100%;
      padding: 10px 12px;
      background: transparent;
      border: none;
      text-align: left;
      cursor: pointer;
      color: var(--text);
      font-size: 13px;
    }

    #messageMenu button:hover,
    #chatOptionsMenu button:hover {
      background: var(--hover);
    }

    /* ========================================
       NEW CONVERSATION MODAL - MODERN UI
    ======================================== */
    .new-chat-modal {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 8px 0;
      height: 450px;
    }

    .new-chat-search {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      border-radius: 12px;
      background: var(--input-bg);
      border: 1px solid var(--border);
    }

    .new-chat-search i {
      color: var(--muted);
      font-size: 14px;
    }

    .new-chat-search input {
      flex: 1;
      border: none;
      background: transparent;
      color: var(--text);
      font-size: 14px;
      outline: none;
    }

    .new-chat-list {
      max-height: 280px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 16px;
    }

    /* Forward Modal - WhatsApp Style */
    .forward-search {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      border-radius: 12px;
      background: var(--input-bg);
      border: 1px solid var(--border);
      margin-bottom: 16px;
    }

    .forward-search i {
      color: var(--muted);
      font-size: 14px;
    }

    .forward-search input {
      flex: 1;
      border: none;
      background: transparent;
      color: var(--text);
      font-size: 14px;
      outline: none;
    }

    .forward-list {
      max-height: 350px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .forward-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 10px;
      cursor: pointer;
      transition: background 0.12s ease;
    }

    .forward-item:hover {
      background: var(--hover);
    }

    .forward-avatar {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 14px;
      flex-shrink: 0;
    }

    .forward-info {
      flex: 1;
      min-width: 0;
    }

    .forward-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .forward-type {
      font-size: 12px;
      color: var(--muted);
    }

    .forward-check {
      color: var(--muted);
      font-size: 18px;
    }

    .forward-item:hover .forward-check {
      color: var(--primary);
    }

    .new-chat-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 10px;
      cursor: pointer;
      transition: background 0.12s ease;
    }

    .new-chat-row:hover {
      background: var(--hover);
    }

    .new-chat-row.selected {
      background: rgba(91, 61, 245, 0.10);
    }

    .new-chat-row input[type="checkbox"] {
      width: 18px;
      height: 18px;
      accent-color: var(--primary);
      cursor: pointer;
    }

    .new-chat-name {
      font-size: 14px;
      font-weight: 500;
      color: var(--text);
    }

    .new-chat-actions {
      display: flex;
      gap: 12px;
      padding: 16px 0 8px;
      border-top: 1px solid var(--border);
      margin-top: auto;
    }

    .btn-chat-action {
      flex: 1;
      padding: 12px 16px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.12s ease;
    }

    .btn-chat-action.btn-outline {
      background: transparent;
      border: 2px solid var(--primary);
      color: var(--primary);
    }

    .btn-chat-action.btn-outline:hover {
      background: rgba(91, 61, 245, 0.08);
    }

    .btn-chat-action.btn-primary {
      background: var(--primary);
      border: none;
      color: white;
    }

    .btn-chat-action.btn-primary:hover {
      background: var(--accent);
    }

    .btn-chat-action:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* ========================================
       MEDIA MENU - MODERN ICONS
    ======================================== */
    .media-option {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      border: none;
      background: transparent;
      color: var(--text);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border-radius: 8px;
      transition: background 0.12s ease;
    }

    .media-option i {
      width: 20px;
      text-align: center;
      color: var(--primary);
    }

    /* ========================================
       MESSAGE OPTIONS (3-DOT MENU)
    ======================================== */
    .msg-options-btn {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: rgba(0,0,0,0.1);
      border: none;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s ease;
      color: var(--muted);
      font-size: 12px;
    }

    .chat-msg:hover .msg-options-btn {
      opacity: 1;
    }

    .msg-sent .msg-options-btn {
      background: rgba(255,255,255,0.2);
      color: white;
    }

    .msg-options-menu {
      position: fixed;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.15);
      min-width: 160px;
      z-index: 10000;
      overflow: hidden;
    }

    .msg-options-menu button {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 10px 14px;
      background: transparent;
      border: none;
      text-align: left;
      cursor: pointer;
      color: var(--text);
      font-size: 13px;
    }

    .msg-options-menu button:hover {
      background: var(--hover);
    }

    .msg-options-menu button i {
      width: 16px;
      color: var(--muted);
    }

    .msg-options-menu button.delete-option {
      color: #ef4444;
    }

    .msg-options-menu button.delete-option i {
      color: #ef4444;
    }

    /* ========================================
       FILE ATTACHMENT UI - MODERN WHATSAPP STYLE
    ======================================== */
    .msg-file-wrap {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .msg-file-wrap.file-wrap {
      flex-direction: row;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      background: rgba(0,0,0,0.05);
      border-radius: 10px;
      min-width: 200px;
    }

    .msg-sent .msg-file-wrap.file-wrap {
      background: rgba(255,255,255,0.15);
    }

    .msg-file-wrap .file-icon {
      width: 40px;
      height: 40px;
      border-radius: 8px;
      background: var(--primary);
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 18px;
    }

    .msg-file-wrap .file-info {
      flex: 1;
      min-width: 0;
    }

    .msg-file-wrap .file-name {
      font-weight: 600;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .msg-file-wrap .file-size {
      font-size: 11px;
      color: var(--muted);
    }

    .msg-sent .msg-file-wrap .file-size {
      color: rgba(255,255,255,0.7);
    }

    .msg-file-wrap .file-download-btn {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: rgba(0,0,0,0.1);
      border: none;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: var(--text);
      transition: background 0.12s ease;
    }

    .msg-sent .msg-file-wrap .file-download-btn {
      background: rgba(255,255,255,0.2);
      color: white;
    }

    .msg-file-wrap .file-download-btn:hover {
      background: rgba(0,0,0,0.15);
    }

    .msg-file-wrap .file-download-btn.downloaded {
      color: #22c55e;
    }

    /* file preview / video sizing inside messages */
    .chat-msg img, .chat-msg video{
      max-width:420px;
      border-radius:10px;
      display:block;
    }

    /* responsive tweaks */
    @media (max-width: 980px){
      .chat-left{ width:280px; }
      .media-menu{ right: 60px; top: 66px; }
    }

    @media (max-width: 720px){
      .chat-wrapper{ padding:12px; gap:10px; }
      .chat-left{ display:none; }
      .chat-right{ border-radius: 14px; }
    }
    /* ------------------------------ */
    /* MESSAGE BUBBLES (final fixed)  */
    /* ------------------------------ */

    .chat-msg-legacy {
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
    .msg-sent-legacy {
      background: linear-gradient(180deg, var(--primary), var(--accent));
      color: white;
      margin-left: auto;                /* push to right */
      border-bottom-right-radius: 6px;  /* WhatsApp style */
    }

    /*** OTHER USER MESSAGE (LEFT SIDE) ***/
    .msg-received-legacy {
      background: var(--card);
      color: var(--text);
      margin-right: auto;                /* push to left */
      border: 1px solid var(--border);
      border-bottom-left-radius: 6px;    /* WhatsApp style */
    }

    /*** MESSAGE SPACING FIX ***/
    .chat-messages .chat-msg-legacy {
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

    .chat-msg-legacy {
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
    .msg-sent-legacy {
      background: linear-gradient(180deg, var(--primary), var(--accent));
      color: white;
      margin-left: auto;
      border-bottom-right-radius: 6px;
    }

    /* RECEIVED (LEFT) */
    .msg-received-legacy {
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
.wa-img-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 10px;
  max-height: 420px;
  overflow-y: auto;
}

.wa-img-wrap {
  position: relative;
}

.wa-img-wrap img {
  width: 100%;
  height: 120px;
  object-fit: cover;
  border-radius: 10px;
}

.wa-remove {
  position: absolute;
  top: 6px;
  right: 6px;
  background: rgba(0,0,0,.6);
  color: #fff;
  border: none;
  border-radius: 50%;
  width: 22px;
  height: 22px;
  cursor: pointer;
}


    `;
    document.head.appendChild(style);
  }

  // 2) Render main HTML (keeps your original markup)
  document.getElementById("app-content").innerHTML = `
  <div class="chat-wrapper">

    <!-- LEFT SIDEBAR -->
    <div class="chat-left">
      <div class="chat-left-header" style="padding:12px 16px;">
        <div class="chat-left-title"><span>Messages</span></div>
        <button id="createNewChat" title="New chat">
          <i class="fa-solid fa-plus"></i>
        </button>
      </div>

      <div class="chat-left-tabs">
        <button class="chat-tab active" type="button" data-tab="general">General</button>
        <button class="chat-tab" type="button" data-tab="archive">Archive</button>
      </div>

      <div class="chat-search" style="padding:0 16px 14px;">
        <div class="chat-search-box">
          <i class="fa-solid fa-magnifying-glass"></i>
          <input type="text" id="chatSearchInput" placeholder="Search..." />
        </div>
      </div>

      <div class="chat-list" id="chatList"></div>
    </div>

    <!-- RIGHT SIDE -->
    <div class="chat-right">

      <!-- HEADER -->
      <div class="chat-right-header">
        
        <div class="chat-avatar-lg" id="chatHeaderAvatar">?</div>


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
                     style="background:transparent;border:none;outline:none;padding:4px 6px;font-size:13px;width:180px;" />
            </div>
            <button id="clearSearchMessages" class="clear-btn" 
                    style="padding:6px 12px;font-size:12px;">Clear</button>
          </div>

          <button id="chatOptionsBtn" class="icon-btn" title="Options">
            <i class="fa-solid fa-ellipsis"></i>
          </button>

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
          <button class="media-option" id="uploadImageBtn"><i class="fa-regular fa-image"></i> Photo</button>
          <button class="media-option" id="uploadVideoBtn"><i class="fa-solid fa-clapperboard"></i> Video</button>
          <button class="media-option" id="uploadFileBtn"><i class="fa-regular fa-file-lines"></i> Document</button>
          <button class="media-option" id="recordVoiceBtn"><i class="fa-solid fa-microphone-lines"></i> Audio</button>
        </div>
      </div>
      <input type="file" id="hiddenImageInput" accept="image/*" multiple style="display:none;" />
      <input type="file" id="hiddenVideoInput" accept="video/*" multiple style="display:none;" />
      <input type="file" id="hiddenAudioInput" accept="audio/*" multiple style="display:none;" />
      <input type="file" id="hiddenFileInput" multiple style="display:none;" />




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
    const audioInput = document.getElementById("hiddenAudioInput");

    if (imgInput) {
      imgInput.onchange = (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        if (!files.length) return;

        if (!window.currentConversationId) {
          alert("Open a conversation first.");
          return;
        }

        if (files.length === 1) {
          openFilePreviewModal(files[0]);
        } else {
          openFilePreviewModal(files); // reuse same modal
        }
      };
    }
    if (videoInput) {
      videoInput.onchange = (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        if (!files.length) return;

        if (!window.currentConversationId) {
          alert("Open a conversation first.");
          return;
        }

        if (files.length === 1) {
          openFilePreviewModal(files[0]);
        } else {
          openFilePreviewModal(files); // reuse same modal
        }
      };
    }

    if (audioInput) {
      audioInput.onchange = (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        if (!files.length) return;
        if (!window.currentConversationId) {
          alert("Open a conversation first.");
          return;
        }

        if (files.length === 1) {
          openFilePreviewModal(files[0]);
        } else {
          openFilePreviewModal(files); // reuse same modal
        }
      };
    }

    if (fileInput) {
      fileInput.onchange = (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        if (!files.length) return;
        if (!window.currentConversationId) {
          alert("Open a conversation first.");
          return;
        }

        if (files.length === 1) {
          openFilePreviewModal(files[0]);
        } else {
          openFilePreviewModal(files); // pass array
        }
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
      // Deduplication: check if message already exists in cache
      const existsInCache = window.chatCache[convId].some(
        (m) => m.message_id === msg.message_id || (msg.temp_id && m.temp_id === msg.temp_id)
      );
      if (!existsInCache) {
        window.chatCache[convId].push(msg);
      }

      // 2️⃣ Update left-sidebar conversation preview
      const convo = window.conversationCache.find(
        (c) => c.conversation_id === convId
      );

      if (convo) {
        convo.last_message = msg.message_text || msg.file_name || "";
        convo.last_sender = msg.sender_id;
        convo.last_message_time = msg.created_on;
        
        // Increment unread count if not current conversation and not my message
        if (convId !== window.currentConversationId && String(msg.sender_id) !== String(state.user?.id)) {
          convo.unread_count = (convo.unread_count || 0) + 1;
        }
      }

      // 3️⃣ Refresh left list – cheap
      const currentFilter = (document.getElementById("chatSearchInput")?.value || "")
        .trim()
        .toLowerCase();
      renderConversationList(currentFilter);

      // 4️⃣ Only render if active conversation is open AND not already shown
      if (convId === window.currentConversationId) {
        const isMine = String(msg.sender_id) === String(state.user?.id);
        
        // Skip if this is my own message (already shown optimistically)
        // Check by temp_id or message_id to avoid duplicates
        const existingEl = document.querySelector(
          `[data-msgid="${msg.message_id}"], [data-tempid="${msg.temp_id}"]`
        );
        if (existingEl) {
          // Update the existing element's data-msgid if needed
          if (msg.message_id && existingEl.dataset.tempid) {
            existingEl.setAttribute("data-msgid", msg.message_id);
            existingEl.removeAttribute("data-tempid");
            // Update status tick to delivered
            updateMessageStatusUI(msg.message_id, msg.status || "delivered");
          }
          return; // Don't add duplicate
        }
        
        addMessageToUI(msg, isMine, msg.message_id, {
          is_group: window.currentConversation?.is_group || false,
        });
        
        // If incoming message from others, mark as read immediately
        if (!isMine && msg.sender_id !== "system") {
          markMessagesRead(convId, [msg.message_id]).catch(() => {});
        }
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

      const updated = (window.conversationCache || []).find(
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
        updateGroupHeaderSubFromConvo(data.conversation_id);
      }
    });

    // 🔴 GROUP MEMBERS REMOVED (Real-time)
    on("group_members_removed", async (data) => {
      delete window.groupMemberCache[data.conversation_id];

      await refreshConversationList();

      const updated = (window.conversationCache || []).find(
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

      // ✅ ✅ ✅ INSTANTLY REFRESH GROUP INFO PANEL + HEADER SUBTITLE
      if (window.currentConversationId === data.conversation_id) {
        openGroupInfoPanel(data.conversation_id);
        updateGroupHeaderSubFromConvo(data.conversation_id);
      }

      // If I got removed, disable composer
      const removedList = data.removed || data.members || [];
      if (
        String(window.currentConversationId) === String(data.conversation_id) &&
        removedList.map(String).includes(String(state.user?.id))
      ) {
        setGroupComposerDisabled(true, "You're no longer a participant");
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

  // Tab switching (General / Archive)
  document.querySelectorAll(".chat-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".chat-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      renderConversationList();
    });
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
  document.getElementById("recordVoiceBtn").onclick = () =>
    document.getElementById("hiddenAudioInput").click();

  document.getElementById("uploadFileBtn").onclick = () =>
    document.getElementById("hiddenFileInput").click();

  // send message: optimistic — emits to socket-server which persists via Python
  document.getElementById("sendMessageBtn").onclick = () => {
    const input = document.getElementById("chatMessageInput");
    if (input?.disabled) return;
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
      status: "sent",
    };

    // Include reply_to if replying to a message
    if (window.replyToMessage) {
      payload.reply_to = window.replyToMessage.message_id;
      payload.reply_to_text = window.replyToMessage.message_text;
      payload.reply_to_sender = window.replyToMessage.sender_name;
    }

    // 1️⃣ Optimistic local UI
    addMessageToUI(payload, true, payload.message_id, {
      is_group: window.currentConversation?.is_group || false,
    });

    // Clear reply state
    clearReplyPreview();

    // 2️⃣ Insert into local cache immediately
    if (!window.chatCache[window.currentConversationId]) {
      window.chatCache[window.currentConversationId] = [];
    }
    window.chatCache[window.currentConversationId].push(payload);

    // 3️⃣ Update conversation's last_message_time to move it to top
    const convo = (window.conversationCache || []).find(
      c => c.conversation_id === window.currentConversationId
    );
    if (convo) {
      convo.last_message_time = payload.created_on;
      convo.last_message = payload.message_text || payload.file_name || "";
      convo.last_sender = payload.sender_id;
      const currentFilter = (document.getElementById("chatSearchInput")?.value || "")
        .trim()
        .toLowerCase();
      renderConversationList(currentFilter); // Re-render to move chat to top
    }

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

  // typing indicator with 3-second auto-stop (WhatsApp behavior)
  const TYPING_TIMEOUT_MS = 3000;
  let typingAutoStopTimer = null;
  
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
    // Reset the auto-stop timer on each keystroke
    clearTimeout(typingTimer);
    clearTimeout(typingAutoStopTimer);
    typingTimer = setTimeout(() => emitTypingStop(), TYPING_TIMEOUT_MS);
  });

  function emitTypingStop() {
    if (!isTyping) return;
    isTyping = false;
    clearTimeout(typingTimer);
    clearTimeout(typingAutoStopTimer);
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
    // Ensure URL has proper base
    let downloadUrl = url;
    if (url && !url.startsWith('http') && !url.startsWith('blob:') && !url.startsWith('data:')) {
      const apiBase = window.API_BASE_URL || '';
      downloadUrl = url.startsWith('/') ? `${apiBase}${url}` : `${apiBase}/${url}`;
    }

    try {
      // Use fetch with auth headers for authenticated download
      const token = state.user?.token || '';
      const headers = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const resp = await fetch(downloadUrl, { 
        credentials: 'include',
        headers 
      });
      
      if (!resp.ok) {
        throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
      }

      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename || 'download';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      
      // Clean up blob URL after download
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch (err) {
      console.error('downloadFileRobust failed:', err);
      
      // Fallback: try direct anchor download
      try {
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = filename || '';
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (e) {
        console.error('Fallback download also failed:', e);
        showToast('Download failed. Please try again.');
      }
    }
  }

  /* ---------- 1) preview modal (WhatsApp-like) ---------- */
  function openFilePreviewModal(input) {
    const files = Array.isArray(input) ? input : [input];
    if (!files.length) return;

    let previewHtml = `<div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-bottom:10px;">`;

    files.forEach((file) => {
      const url = URL.createObjectURL(file);

      if (file.type.startsWith("image/")) {
        previewHtml += `
        <img src="${url}"
             style="width:120px;height:120px;object-fit:cover;border-radius:8px;" />`;
      } else if (file.type.startsWith("video/")) {
        previewHtml += `
        <video src="${url}" controls
               style="width:160px;border-radius:8px;"></video>`;
      } else if (file.type.startsWith("audio/")) {
        previewHtml += `
        <audio src="${url}" controls style="width:220px;"></audio>`;
      } else {
        previewHtml += `
        <div style="padding:12px 16px;border-radius:8px;
                    background:var(--muted-bg);font-weight:600;">
          <i class="fa fa-file"></i> ${escapeHtml(file.name)}
        </div>`;
      }
    });

    previewHtml += `</div>`;

    const modal = document.createElement("div");
    modal.className = "wh-preview-modal";
    modal.innerHTML = `
    <div class="wh-preview-backdrop"
         style="position:fixed;inset:0;background:rgba(0,0,0,0.6);
                display:flex;align-items:center;justify-content:center;z-index:99999;">
      <div class="wh-preview-box"
           style="background:var(--bg-panel);padding:18px;border-radius:14px;
                  max-width:720px;width:90%;box-shadow:0 8px 30px rgba(0,0,0,0.6);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="margin:0;">Preview</h3>
          <button class="wh-preview-close"
                  style="background:transparent;border:none;font-size:18px;">×</button>
        </div>

        <div class="wh-preview-body">${previewHtml}</div>

        <div style="text-align:center;margin-top:12px;">
          <button class="wh-preview-cancel btn-secondary"
                  style="margin-right:10px;">Cancel</button>
          <button class="wh-preview-send btn-primary">Send</button>
        </div>
      </div>
    </div>
  `;

    modal._files = files; // ✅ IMPORTANT
    document.body.appendChild(modal);

    modal.querySelector(".wh-preview-close").onclick = modal.querySelector(
      ".wh-preview-cancel"
    ).onclick = () => modal.remove();

    modal.querySelector(".wh-preview-send").onclick = async () => {
      modal.remove();

      // ✅ SINGLE vs MULTIPLE (NO BREAKING)
      if (files.length === 1) {
        await sendFileAfterPreview(files[0]);
      } else {
        await sendMultipleFilesAfterPreview(files);
      }
    };
  }

  function openMultiImagePreviewModal(files) {
    let selectedFiles = [...files];

    const renderGrid = () => {
      return selectedFiles
        .map((file, idx) => {
          const url = URL.createObjectURL(file);
          return `
          <div class="wa-img-wrap">
            <img src="${url}" />
            <button class="wa-remove" data-idx="${idx}">×</button>
          </div>
        `;
        })
        .join("");
    };

    const modal = document.createElement("div");
    modal.className = "wh-preview-modal";
    modal.innerHTML = `
  <div class="wh-preview-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:99999;">
    <div style="background:var(--bg-panel);padding:16px;border-radius:14px;max-width:760px;width:90%;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <h3>Send ${selectedFiles.length} images</h3>
        <button class="wa-close">×</button>
      </div>

      <div class="wa-img-grid">
        ${renderGrid()}
      </div>

      <div style="text-align:center;margin-top:14px;">
        <button class="btn-secondary wa-cancel">Cancel</button>
        <button class="btn-primary wa-send">Send</button>
      </div>
    </div>
  </div>
  `;

    document.body.appendChild(modal);

    // remove image
    modal.onclick = (e) => {
      if (e.target.classList.contains("wa-remove")) {
        const idx = Number(e.target.dataset.idx);
        selectedFiles.splice(idx, 1);
        if (!selectedFiles.length) modal.remove();
        else modal.querySelector(".wa-img-grid").innerHTML = renderGrid();
      }
    };

    modal.querySelector(".wa-close").onclick = modal.querySelector(
      ".wa-cancel"
    ).onclick = () => modal.remove();

    modal.querySelector(".wa-send").onclick = async () => {
      modal.remove();
      await sendMultipleFilesDirect(selectedFiles);
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
    // formData.append("file", file);
    formData.append("files", file);
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
  async function sendMultipleFilesAfterPreview(files) {
    for (const file of files) {
      await sendFileAfterPreview(file);
    }
  }

  async function sendMultipleFilesDirect(files) {
    if (!files.length || !window.currentConversationId) return;

    const tempId = makeTempId();

    // optimistic bubble (same as before)
    addMessageToUI(
      {
        temp_id: tempId,
        conversation_id: window.currentConversationId,
        sender_id: state.user?.id,
        message_type: "file",
        file_name: `${files.length} files`,
        mime_type: "application/octet-stream",
        created_on: new Date().toISOString(),
        _is_temp_upload: true,
      },
      true,
      tempId,
      { is_group: window.currentConversation?.is_group }
    );

    insertProgressUI(tempId);

    try {
      const res = await sendMultipleFilesApi({
        conversation_id: window.currentConversationId,
        sender_id: state.user?.id,
        files,
        onProgress: (percent) => {
          updateUploadProgress(tempId, percent);
        },
      });

      finalizeUploadBubble(tempId, res);
    } catch (err) {
      console.error("Multi-file upload failed", err);
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

    const tickHtml = renderStatusTickHTML(messageObj, isMine);

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
        // Use the correct file download endpoint
        const apiBase = window.API_BASE_URL || '';
        FILE_URL = `${apiBase}/chat/file-download/${mu}`;
      }
    }

    // CONTENT by type (keeps "uploading…" state when no FILE_URL yet)
    let contentHtml = "";
    const mType = messageObj.message_type || "text";

    // Helper to get file icon based on extension
    function getFileIcon(filename) {
      const ext = (filename || "").split(".").pop().toLowerCase();
      const icons = {
        pdf: "fa-file-pdf",
        doc: "fa-file-word", docx: "fa-file-word",
        xls: "fa-file-excel", xlsx: "fa-file-excel",
        ppt: "fa-file-powerpoint", pptx: "fa-file-powerpoint",
        zip: "fa-file-zipper", rar: "fa-file-zipper",
        txt: "fa-file-lines",
        jpg: "fa-file-image", jpeg: "fa-file-image", png: "fa-file-image", gif: "fa-file-image",
        mp3: "fa-file-audio", wav: "fa-file-audio",
        mp4: "fa-file-video", avi: "fa-file-video", mov: "fa-file-video",
      };
      return icons[ext] || "fa-file";
    }

    // IMAGE
    if (mType === "image" && SAFE_MIME.includes(messageObj.mime_type)) {
      contentHtml = `
      <div class="msg-file-wrap image-wrap">
        ${FILE_URL ? `<img src="${FILE_URL}" class="msg-image" />` : ""}
        <div class="msg-file-name">${escapeHtml(messageObj.file_name || "")}</div>
        ${rawMediaId ? `<button class="file-download-btn" data-download="${rawMediaId}"><i class="fa-solid fa-arrow-down"></i></button>` : ""}
      </div>`;
    }

    // VIDEO
    else if (mType === "video" && SAFE_MIME.includes(messageObj.mime_type)) {
      contentHtml = `
      <div class="msg-file-wrap video-wrap">
        ${FILE_URL ? `<video controls class="msg-video"><source src="${FILE_URL}"></video>` : ""}
        <div class="msg-file-name">${escapeHtml(messageObj.file_name || "")}</div>
        ${rawMediaId ? `<button class="file-download-btn" data-download="${rawMediaId}"><i class="fa-solid fa-arrow-down"></i></button>` : ""}
      </div>`;
    }

    // AUDIO
    else if (mType === "audio" && SAFE_MIME.includes(messageObj.mime_type)) {
      contentHtml = `
      <div class="msg-file-wrap audio-wrap">
        ${FILE_URL ? `<audio controls src="${FILE_URL}"></audio>` : ""}
        <div class="msg-file-name">${escapeHtml(messageObj.file_name || "")}</div>
        ${rawMediaId ? `<button class="file-download-btn" data-download="${rawMediaId}"><i class="fa-solid fa-arrow-down"></i></button>` : ""}
      </div>`;
    }

    // GENERIC FILE (pdf/docx/pptx/zip etc.) - MODERN UI
    else if (mType !== "text") {
      const fname = escapeHtml(messageObj.file_name || "download");
      const fileIcon = getFileIcon(messageObj.file_name);

      contentHtml = `
      <div class="msg-file-wrap file-wrap" data-file="${rawMediaId}">
        <div class="file-icon"><i class="fa-solid ${fileIcon}"></i></div>
        <div class="file-info">
          <div class="file-name">${fname}</div>
          <div class="file-size">${messageObj.mime_type || "File"}</div>
        </div>
        ${rawMediaId ? `<button class="file-download-btn" data-download="${rawMediaId}"><i class="fa-solid fa-arrow-down"></i></button>` : ""}
      </div>`;
    }

    // TEXT
    else {
      const text = escapeHtml(messageObj.message_text || "");
      contentHtml = `<div class="msg-content">${text}</div>`;
    }

    // Reply preview bubble (if this message is a reply to another)
    let replyBubbleHtml = "";
    if (messageObj.reply_to || messageObj.reply_to_text) {
      const replyText = messageObj.reply_to_text || "[Original message]";
      const replySender = messageObj.reply_to_sender || "User";
      const truncatedReply = replyText.length > 50 ? replyText.substring(0, 50) + "..." : replyText;
      
      replyBubbleHtml = `
        <div class="reply-bubble" data-reply-to="${messageObj.reply_to || ""}" style="
          background: rgba(0, 168, 132, 0.1);
          border-left: 3px solid #00a884;
          padding: 6px 10px;
          margin-bottom: 6px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
        ">
          <div style="color:#00a884;font-weight:500;">${escapeHtml(replySender)}</div>
          <div style="color:var(--text-secondary, #8696a0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(truncatedReply)}</div>
        </div>
      `;
    }

    // 3-dot options button for every message
    const optionsBtnHtml = messageObj.sender_id !== "system" ? `
      <button class="msg-options-btn" data-msg-options="${msgId}">
        <i class="fa-solid fa-ellipsis-vertical"></i>
      </button>` : "";

    // FINAL HTML (keeps data attributes used by other code)
    const html = `
    <div class="chat-msg ${bubbleClass}" 
      data-msgid="${msgId}" 
      data-tempid="${messageObj.temp_id || ""}"
      data-senderid="${messageObj.sender_id || ""}"
      data-filename="${escapeHtml(messageObj.file_name || "")}"
      data-fileurl="${FILE_URL || ""}"
      data-date="${iso}">
      ${optionsBtnHtml}
      ${senderHeaderHtml}
      ${replyBubbleHtml}
      ${contentHtml}
      <div class="msg-meta-row">
        <span class="msg-time">${escapeHtml(timeText)}</span>
        ${tickHtml}
      </div>
    </div>
  `;

    container.insertAdjacentHTML("beforeend", html);
    container.scrollTop = container.scrollHeight;

    // Attach handlers after DOM insert
    setTimeout(() => {
      const el = container.querySelector(`[data-msgid="${msgId}"]`);
      if (!el) return;

      // Download button handler (for both sender AND receiver)
      const downloadBtn = el.querySelector(`[data-download="${rawMediaId}"]`);
      if (downloadBtn && FILE_URL) {
        downloadBtn.onclick = async (e) => {
          e.stopPropagation();
          try {
            await downloadFileRobust(
              FILE_URL,
              messageObj.file_name,
              messageObj.mime_type
            );
            downloadBtn.classList.add("downloaded");
            downloadBtn.innerHTML = `<i class="fa-solid fa-check"></i>`;
          } catch (err) {
            console.error("Download failed", err);
          }
        };
      }

      // 3-dot options button handler
      const optionsBtn = el.querySelector(`[data-msg-options="${msgId}"]`);
      if (optionsBtn) {
        optionsBtn.onclick = (e) => {
          e.stopPropagation();
          openMsgOptionsMenu(msgId, messageObj, FILE_URL, e);
        };
      }

      // Right-click context menu
      el.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        openMsgOptionsMenu(msgId, messageObj, FILE_URL, ev);
      });

      // Reply bubble click handler - scroll to original message
      const replyBubble = el.querySelector(".reply-bubble");
      if (replyBubble) {
        replyBubble.onclick = (e) => {
          e.stopPropagation();
          const replyToId = replyBubble.dataset.replyTo;
          if (replyToId) {
            scrollToMessage(replyToId);
          }
        };
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
    const apiBase = window.API_BASE_URL || '';
    const url = mediaId ? `${apiBase}/chat/file-download/${mediaId}` : "";
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
          sender_name: server.sender_name || state.user?.name, // ✅ ADD THIS
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
   MESSAGE OPTIONS MENU (3-dot menu)
=========================================================== */
  function openMsgOptionsMenu(msgId, messageObj, fileUrl, event) {
    // Close any existing menu
    closeAllFloatingMenus();

    const isMine = String(messageObj.sender_id) === String(state.user?.id);
    const hasFile = !!fileUrl && fileUrl !== "null";
    const messageText = messageObj.message_text || "";

    const menu = document.createElement("div");
    menu.className = "msg-options-menu";
    menu.style.left = event.pageX + "px";
    menu.style.top = event.pageY + "px";

    let menuHtml = "";

    // Copy option (for text messages)
    if (messageText) {
      menuHtml += `<button data-action="copy"><i class="fa-regular fa-copy"></i> Copy</button>`;
    }

    // Download option (for files)
    if (hasFile) {
      menuHtml += `<button data-action="download"><i class="fa-solid fa-download"></i> Download</button>`;
    }

    // Forward option
    menuHtml += `<button data-action="forward"><i class="fa-solid fa-share"></i> Forward</button>`;

    // Share option (if Web Share API available)
    if (navigator.share) {
      menuHtml += `<button data-action="share"><i class="fa-solid fa-arrow-up-from-bracket"></i> Share</button>`;
    }

    // Delete option (only for sender)
    if (isMine) {
      menuHtml += `<button data-action="delete" class="delete-option"><i class="fa-solid fa-trash"></i> Delete</button>`;
    }

    menu.innerHTML = menuHtml;
    document.body.appendChild(menu);

    // Ensure menu stays within viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = (window.innerWidth - rect.width - 10) + "px";
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = (window.innerHeight - rect.height - 10) + "px";
    }

    // Handle menu actions
    menu.querySelectorAll("button").forEach(btn => {
      btn.onclick = async () => {
        const action = btn.dataset.action;

        switch (action) {
          case "copy":
            try {
              await navigator.clipboard.writeText(messageText);
              showToast("Copied to clipboard");
            } catch (err) {
              console.error("Copy failed", err);
            }
            break;

          case "download":
            if (fileUrl) {
              try {
                await downloadFileRobust(fileUrl, messageObj.file_name, messageObj.mime_type);
              } catch (err) {
                console.error("Download failed", err);
              }
            }
            break;

          case "forward":
            openForwardModal(messageObj);
            break;

          case "share":
            try {
              const shareData = { text: messageText || messageObj.file_name || "Shared message" };
              if (fileUrl && !fileUrl.startsWith("blob:")) {
                shareData.url = window.location.origin + fileUrl;
              }
              await navigator.share(shareData);
            } catch (err) {
              console.error("Share failed", err);
            }
            break;

          case "delete":
            if (typeof deleteMessage === "function") {
              deleteMessage(msgId);
            } else {
              alert("Delete function not available");
            }
            break;
        }

        menu.remove();
      };
    });

    // Close menu on outside click
    setTimeout(() => {
      document.addEventListener("click", function closeMenu(e) {
        if (!menu.contains(e.target)) {
          menu.remove();
          document.removeEventListener("click", closeMenu);
        }
      });
    }, 10);
  }

  // Simple toast notification
  function showToast(message) {
    const toast = document.createElement("div");
    toast.style.cssText = `
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--text);
      color: var(--bg);
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 13px;
      z-index: 99999;
      animation: fadeInUp 0.2s ease;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }

  // Forward message modal - WhatsApp style
  function openForwardModal(messageObj) {
    const conversations = window.conversationCache || [];
    if (!conversations.length) {
      alert("No conversations to forward to");
      return;
    }

    const myId = state.user?.id;
    let listHtml = conversations.map(c => {
      const name = getTargetDisplayName(c) || c.display_name || c.name || "Chat";
      const initials = getInitials(name);
      const isGroup = c.is_group;
      return `<div class="forward-item" data-convo="${c.conversation_id}">
        <div class="forward-avatar">${initials}</div>
        <div class="forward-info">
          <div class="forward-name">${escapeHtml(name)}</div>
          <div class="forward-type">${isGroup ? 'Group' : 'Direct'}</div>
        </div>
        <div class="forward-check"><i class="fa-regular fa-circle"></i></div>
      </div>`;
    }).join("");

    renderModal("Forward to", `
      <div class="forward-search">
        <i class="fa-solid fa-magnifying-glass"></i>
        <input type="text" id="forwardSearchInput" placeholder="Search conversations..." />
      </div>
      <div class="forward-list">
        ${listHtml}
      </div>
    `, null);

    const modal = document.querySelector(".modal");
    if (modal) modal.classList.add("forward-modal");

    // Search filter
    const searchInput = document.getElementById("forwardSearchInput");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        const q = e.target.value.toLowerCase();
        document.querySelectorAll(".forward-item").forEach(item => {
          const name = item.querySelector(".forward-name")?.textContent?.toLowerCase() || "";
          item.style.display = name.includes(q) ? "flex" : "none";
        });
      });
    }

    document.querySelectorAll(".forward-item").forEach(item => {
      item.onclick = async () => {
        const targetConvoId = item.dataset.convo;
        // Forward the message
        emit("send_message", {
          conversation_id: targetConvoId,
          sender_id: state.user.id,
          message_text: messageObj.message_text || `[Forwarded: ${messageObj.file_name || "file"}]`,
          message_type: "text"
        });
        closeModal();
        showToast("Message forwarded");
      };
    });
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
  function markUploadFailed(tempId) {
    const el = document.querySelector(
      `.chat-msg[data-msgid="${tempId}"], .chat-msg[data-tempid="${tempId}"]`
    );
    if (!el) return;

    el.classList.add("upload-failed");

    // Remove progress UI
    const uploadActions = el.querySelector(".upload-actions");
    if (uploadActions) uploadActions.remove();

    // Add failed indicator with retry button
    const meta = el.querySelector(".msg-meta-row");
    if (meta) {
      meta.innerHTML = `
        <span class="upload-failed-text" style="color:#f15c6d;font-size:12px;">
          <i class="fa-solid fa-exclamation-circle" style="margin-right:4px;"></i>Failed
        </span>
        <button class="retry-upload-btn" data-retry="${tempId}" style="
          background:none;
          border:none;
          color:#00a884;
          font-size:12px;
          cursor:pointer;
          margin-left:8px;
        ">
          <i class="fa-solid fa-rotate-right" style="margin-right:4px;"></i>Retry
        </button>
      `;

      // Attach retry handler
      const retryBtn = meta.querySelector(`[data-retry="${tempId}"]`);
      if (retryBtn) {
        retryBtn.onclick = () => {
          // Get the file from activeUploads cache
          const uploadData = window.activeUploads?.[tempId];
          if (uploadData?.file) {
            // Remove failed bubble
            el.remove();
            // Retry upload
            sendFileAfterPreview(uploadData.file);
          } else {
            alert("Cannot retry - file data not available. Please select the file again.");
          }
        };
      }
    }
  }
  function openMultiFilePreviewModal(files) {
    // 🔹 reuse the SAME modal used by openFilePreviewModal
    const modal = document.getElementById("mediaPreviewModal");
    if (!modal) {
      console.error("mediaPreviewModal not found");
      return;
    }

    const body = modal.querySelector(".media-preview-body");
    if (!body) {
      console.error("media-preview-body not found");
      return;
    }

    body.innerHTML = ""; // clear old preview

    files.forEach((file) => {
      const type = file.type || "";
      const url = URL.createObjectURL(file);

      let el;

      // IMAGE
      if (type.startsWith("image/")) {
        el = document.createElement("img");
        el.src = url;
        el.className = "preview-image";
      }

      // VIDEO
      else if (type.startsWith("video/")) {
        el = document.createElement("video");
        el.src = url;
        el.controls = true;
        el.className = "preview-video";
      }

      // AUDIO
      else if (type.startsWith("audio/")) {
        el = document.createElement("audio");
        el.src = url;
        el.controls = true;
      }

      // DOCUMENTS (pdf, pptx, excel, pbix, zip…)
      else {
        el = document.createElement("div");
        el.className = "preview-file";
        el.innerHTML = `
        <i class="fa-solid fa-file"></i>
        <span>${file.name}</span>
      `;
      }

      body.appendChild(el);
    });

    // 🔹 SEND button → upload happens here
    const sendBtn = modal.querySelector(".preview-send-btn");
    sendBtn.onclick = () => {
      closeMediaPreviewModal();
      sendMultipleFilesDirect(files);
    };

    openMediaPreviewModal();
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

  // Handle messages_read event - update ticks to blue for read messages
  on("messages_read", (data) => {
    if (data.conversation_id !== window.currentConversationId) return;
    // Don't update if it's my own read receipt
    if (String(data.user_id) === String(state.user?.id)) return;
    
    // Update all my messages in this conversation to "read" status
    const container = document.getElementById("chatMessages");
    const myMessages = container.querySelectorAll(".msg-sent");
    myMessages.forEach((el) => {
      const msgId = el.getAttribute("data-msgid");
      // If message_ids provided, only update those; otherwise update all
      if (data.message_ids && data.message_ids.length > 0) {
        if (data.message_ids.includes(msgId)) {
          updateMessageStatusUI(msgId, "read");
        }
      } else {
        updateMessageStatusUI(msgId, "read");
      }
    });
    
    // Update cache
    if (window.chatCache[data.conversation_id]) {
      window.chatCache[data.conversation_id].forEach((m) => {
        if (String(m.sender_id) === String(state.user?.id)) {
          m.status = "read";
        }
      });
    }
  });

  on("typing", (data) => {
    if (data.conversation_id !== window.currentConversationId) return;
    // Don't show typing for self
    if (String(data.sender_id) === String(state.user?.id)) return;
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
    // Prefer explicit conversation_id so we can update cache even if chat isn't open
    const cid = data?.conversation_id || window.currentConversationId;
    if (cid && window.chatCache && Array.isArray(window.chatCache[cid])) {
      window.chatCache[cid] = window.chatCache[cid].map((m) =>
        m.message_id === data.message_id ? { ...m, message_text: "[deleted]" } : m
      );
    }

    // Update UI only if the message is currently rendered
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

    if (status === "sent") {
      // Single grey tick - message sent
      html += `<i class="fa-solid fa-check" style="color:#8696a0;"></i>`;
    } else if (status === "delivered") {
      // Double grey ticks - message delivered
      html += `<span style="color:#8696a0;"><i class="fa-solid fa-check-double"></i></span>`;
    } else if (status === "seen" || status === "read") {
      // Double blue ticks - message seen
      html += `<span style="color:#53bdeb;"><i class="fa-solid fa-check-double"></i></span>`;
    }

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

      await editMessageApi(msgId, newText);

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
      await deleteMessageApi(msgId);
      // socket will update for everyone; fallback update immediately
      markMessageDeleted(msgId);
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
    const contentEl = el.querySelector(".msg-content");
    if (contentEl) {
      contentEl.textContent = "[deleted]";
      contentEl.classList.add("deleted");
    } else {
      el.innerHTML = `<div class="msg-deleted">[deleted]</div>`;
    }

    const convId = window.currentConversationId;
    if (convId && window.chatCache && Array.isArray(window.chatCache[convId])) {
      window.chatCache[convId] = window.chatCache[convId].map((m) =>
        m.message_id === messageId ? { ...m, message_text: "[deleted]" } : m
      );
    }
  }

  // Typing indicator with auto-hide after 4 seconds (safety net)
  let typingIndicatorTimeout = null;
  
  function showTypingIndicator(userId) {
    const el = document.getElementById("typingIndicator");
    if (!el) return;
    
    // Clear any existing auto-hide timer
    clearTimeout(typingIndicatorTimeout);
    
    el.style.display = "block";
    el.innerText = `${getDisplayName(userId)} is typing...`;
    
    // Auto-hide after 4 seconds as safety net (in case stop_typing event is missed)
    typingIndicatorTimeout = setTimeout(() => {
      hideTypingIndicator();
    }, 4000);
  }

  function hideTypingIndicator() {
    const el = document.getElementById("typingIndicator");
    if (!el) return;
    
    clearTimeout(typingIndicatorTimeout);
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

  // ========================================
  // REPLY-TO-MESSAGE FUNCTIONS
  // ========================================
  function setReplyToMessage(message) {
    window.replyToMessage = {
      message_id: message.message_id,
      sender_name: message.sender_name || message.sender_id,
      message_text: message.message_text || message.file_name || "[Media]",
    };
    showReplyPreview();
    document.getElementById("chatMessageInput")?.focus();
  }

  function clearReplyPreview() {
    window.replyToMessage = null;
    const preview = document.getElementById("replyPreviewBar");
    if (preview) {
      preview.remove();
    }
  }

  function showReplyPreview() {
    if (!window.replyToMessage) return;

    // Remove existing preview if any
    const existing = document.getElementById("replyPreviewBar");
    if (existing) existing.remove();

    const inputBar = document.getElementById("bottomInputBar");
    if (!inputBar) return;

    const preview = document.createElement("div");
    preview.id = "replyPreviewBar";
    preview.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: var(--surface-alt, #202c33);
      border-left: 3px solid #00a884;
      margin-bottom: 4px;
      border-radius: 4px;
    `;

    const truncatedText = window.replyToMessage.message_text.length > 60
      ? window.replyToMessage.message_text.substring(0, 60) + "..."
      : window.replyToMessage.message_text;

    preview.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;color:#00a884;font-weight:500;">
          Replying to ${escapeHtml(window.replyToMessage.sender_name)}
        </div>
        <div style="font-size:13px;color:var(--text-secondary, #8696a0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${escapeHtml(truncatedText)}
        </div>
      </div>
      <button id="cancelReplyBtn" style="background:none;border:none;color:var(--text-secondary, #8696a0);cursor:pointer;padding:4px 8px;font-size:16px;">
        <i class="fa-solid fa-xmark"></i>
      </button>
    `;

    inputBar.insertBefore(preview, inputBar.firstChild);

    document.getElementById("cancelReplyBtn").onclick = () => clearReplyPreview();
  }

  function scrollToMessage(messageId) {
    const el = document.querySelector(`[data-msgid="${messageId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.style.transition = "background 0.3s";
      el.style.background = "rgba(0, 168, 132, 0.2)";
      setTimeout(() => {
        el.style.background = "";
      }, 1500);
    }
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

    // Per-user hidden chats ("Delete group" for removed users)
    const hiddenChats = JSON.parse(localStorage.getItem("hiddenChats") || "[]");
    
    // Get archived chats from localStorage
    const archivedChats = JSON.parse(localStorage.getItem("archivedChats") || "[]");
    
    // Check which tab is active (General or Archive)
    const archiveTab = document.querySelector('.chat-tab[data-tab="archive"]');
    const showArchived = archiveTab?.classList.contains('active') || false;

    // Filter conversations
    let list = (window.conversationCache || []).filter((c) => {
      if (hiddenChats.includes(c.conversation_id)) return false;
      const name = getTargetDisplayName(c) || c.display_name || c.name || "";
      const last = c.last_message || "";
      const isArchived = archivedChats.includes(c.conversation_id);
      
      // Filter by archive status
      if (showArchived && !isArchived) return false;
      if (!showArchived && isArchived) return false;

      if (!filter) return true;

      return (
        name.toLowerCase().includes(filter) ||
        last.toLowerCase().includes(filter)
      );
    });

    // Get pinned chats from localStorage
    const pinnedChats = JSON.parse(localStorage.getItem("pinnedChats") || "[]");

    // ✅ SORT: Pinned first, then by latest message time (newest first)
    list = list.sort((a, b) => {
      const aPinned = pinnedChats.includes(a.conversation_id) ? 1 : 0;
      const bPinned = pinnedChats.includes(b.conversation_id) ? 1 : 0;
      
      // Pinned chats come first
      if (aPinned !== bPinned) return bPinned - aPinned;
      
      // Then sort by time
      const timeA = a.last_message_time ? new Date(a.last_message_time).getTime() : 0;
      const timeB = b.last_message_time ? new Date(b.last_message_time).getTime() : 0;
      return timeB - timeA;
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

      // Unread count badge
      const unreadCount = convo.unread_count || 0;
      const unreadBadgeHtml = unreadCount > 0 && String(convo.conversation_id) !== String(window.currentConversationId)
        ? `<span class="unread-badge" style="
            background:#00a884;
            color:#fff;
            font-size:11px;
            font-weight:600;
            padding:2px 6px;
            border-radius:10px;
            min-width:18px;
            text-align:center;
          ">${unreadCount > 99 ? "99+" : unreadCount}</span>`
        : "";

      // Mute icon (check if user has muted this conversation)
      const isMuted = convo.is_muted || false;
      const muteIconHtml = isMuted 
        ? `<i class="fa-solid fa-bell-slash" style="color:var(--muted);font-size:12px;margin-left:4px;" title="Muted"></i>`
        : "";

      // Pin icon (check localStorage for pinned chats)
      const pinnedChats = JSON.parse(localStorage.getItem("pinnedChats") || "[]");
      const isPinned = pinnedChats.includes(convo.conversation_id);
      const pinIconHtml = isPinned 
        ? `<i class="fa-solid fa-thumbtack" style="color:var(--muted);font-size:11px;margin-right:4px;" title="Pinned"></i>`
        : "";

      el.innerHTML = `
        <div class="chat-avatar-sm">${avatarLetter}</div>

        <div class="chat-meta">

            <div class="chat-item-name-row">
                <span class="chat-name">${pinIconHtml}${escapeHtml(displayName)}${muteIconHtml}</span>
                <span class="chat-time">${timeText}</span>
            </div>

            <div class="chat-item-preview-row" style="display:flex;align-items:center;justify-content:space-between;">
              <div class="chat-item-preview" style="flex:1;min-width:0;">${preview}</div>
              ${unreadBadgeHtml}
            </div>
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

    // Disable composer if I am not a member of this group anymore
    if (convo.is_group) {
      const me = String(state.user?.id || "");
      const isMember = (convo.members || []).some((m) => String(m.id) === me);
      setGroupComposerDisabled(!isMember, !isMember ? "You're no longer a participant" : "");
    } else {
      setGroupComposerDisabled(false);
    }

    // Clear unread count when opening conversation
    if (convo.unread_count > 0) {
      convo.unread_count = 0;
      const currentFilter = (document.getElementById("chatSearchInput")?.value || "")
        .trim()
        .toLowerCase();
      renderConversationList(currentFilter);
    }

    const displayName = getTargetDisplayName(convo);
    document.getElementById("chatUserName").innerText =
      displayName || "Conversation";

    let headerName = document.getElementById("chatUserName");
    const newHeaderName = headerName.cloneNode(true);
    headerName.replaceWith(newHeaderName);
    headerName = newHeaderName;
    if (convo.is_group) {
      headerName.style.cursor = "pointer";
      headerName.addEventListener("click", () => openGroupInfoPanel(conversation_id));
    } else {
      headerName.style.cursor = "default";
    }

    // -----------------------------------
    // HEADER SUB (group members / Online)
    // -----------------------------------
    let headerSub = document.getElementById("chatHeaderSub");

    if (convo.is_group) {
      const me = String(state.user.id);
      const names = (convo.members || [])
        .filter((m) => String(m.id) !== me)
        .map((m) => m.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
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
          
          // Mark messages as read - collect message IDs from other senders
          const otherMessageIds = messages
            .filter((m) => String(m.sender_id) !== String(state.user?.id) && m.sender_id !== "system")
            .map((m) => m.message_id)
            .filter(Boolean);
          
          if (otherMessageIds.length > 0) {
            markMessagesRead(conversation_id, otherMessageIds).catch(() => {});
          }
        }
      })
      .catch((err) => console.error("message load fail", err));

    // Also emit via socket for immediate notification
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
    // simple floating menu with actions (delete/edit/rename/archive)
    closeAllFloatingMenus();
    const menu = document.createElement("div");
    menu.className = "floating-chat-item-menu";
    menu.style.position = "absolute";
    menu.style.left = ev.pageX + "px";
    menu.style.top = ev.pageY + "px";
    menu.style.zIndex = 9999;
    menu.innerHTML = `
    <button class="menu-archive" data-convo="${conversationId}"><i class="fa-solid fa-box-archive"></i> Archive</button>
    <button class="menu-delete" data-convo="${conversationId}"><i class="fa-solid fa-trash"></i> Delete chat</button>
  `;
    document.body.appendChild(menu);

    // Archive handler
    menu.querySelector(".menu-archive").addEventListener("click", async () => {
      const convo = (window.conversationCache || []).find(
        (c) => c.conversation_id === conversationId
      );
      if (!convo) return;

      // Mark as archived (store in localStorage for now)
      const archivedChats = JSON.parse(localStorage.getItem("archivedChats") || "[]");
      if (!archivedChats.includes(conversationId)) {
        archivedChats.push(conversationId);
        localStorage.setItem("archivedChats", JSON.stringify(archivedChats));
      }
      
      await refreshConversationList();
      closeAllFloatingMenus();
      showToast("Chat archived");
    });

    // handlers
    menu.querySelector(".menu-delete").addEventListener("click", async () => {
      const convo = (window.conversationCache || []).find(
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
      .querySelectorAll(".floating-chat-item-menu, .msg-options-menu")
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

    // Reply option available for all messages (not system)
    if (message.sender_id !== "system") {
      html += `<div class="msg-menu-item" data-action="reply"><i class="fa-solid fa-reply" style="margin-right:8px;"></i>Reply</div>`;
    }

    if (isMine) {
      // Sender can edit only text
      if (msgType === "text") {
        html += `<div class="msg-menu-item" data-action="edit"><i class="fa-solid fa-pen" style="margin-right:8px;"></i>Edit</div>`;
      }

      // Sender can delete
      html += `<div class="msg-menu-item" data-action="delete" style="color:#f15c6d;"><i class="fa-solid fa-trash" style="margin-right:8px;"></i>Delete</div>`;
    }

    menu.innerHTML = html;
    document.body.appendChild(menu);

    // Position menu safely
    const left = Math.min(window.innerWidth - 160, Math.max(8, x));
    const top = Math.min(window.innerHeight - 40, Math.max(8, y));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    // -------------------------------
    // ACTION HANDLERS
    // -------------------------------
    
    // Reply handler (available for all non-system messages)
    const replyBtn = menu.querySelector('[data-action="reply"]');
    if (replyBtn) {
      replyBtn.onclick = () => {
        menu.remove();
        setReplyToMessage(message);
      };
    }
    
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

    const list = window.conversationCache;
    if (!Array.isArray(list)) return;

    list.forEach((c) => {
      (c.members || []).forEach((u) => {
        if (u?.id && !users.includes(u.id)) {
          users.push(u.id);
        }
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
  <div class="new-chat-modal">
    <div class="new-chat-search">
      <i class="fa-solid fa-magnifying-glass"></i>
      <input id="empSearchInput" placeholder="Search..." />
    </div>
    <div id="empListBox" class="new-chat-list"></div>
    <div class="new-chat-actions">
      <button id="directChatBtn" class="btn-chat-action btn-outline">Direct Chat</button>
      <button id="groupChatBtn" class="btn-chat-action btn-primary">Group Chat</button>
    </div>
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
          row.className = "new-chat-row" + (selected.has(e.id) ? " selected" : "");

          row.innerHTML = `
            <input type="checkbox" data-id="${e.id}" ${selected.has(e.id) ? "checked" : ""}>
            <span class="new-chat-name">${escapeHtml(e.name)}</span>
          `;

          const checkbox = row.querySelector("input");

          checkbox.addEventListener("change", () => {
            if (checkbox.checked) selected.add(e.id);
            else selected.delete(e.id);
            row.classList.toggle("selected", checkbox.checked);
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
      console.log("[Socket] Connected - re-registering user");
      emit("chat_register", { user_id: state.user.id });
      // Re-join current conversation room if any
      if (window.currentConversationId) {
        emit("join_room", { conversation_id: window.currentConversationId });
      }
      // subscribe presence to conversation users if any
      subscribePresenceForList();
    });

    // Handle disconnect gracefully
    getSocket().on("disconnect", (reason) => {
      console.log("[Socket] Disconnected:", reason);
      // Show reconnecting indicator in header
      const headerSub = document.getElementById("chatHeaderSub");
      if (headerSub) {
        headerSub.innerHTML = `<span style="color:#f59e0b;">Reconnecting...</span>`;
      }
    });

    // Handle reconnect
    getSocket().on("reconnect", (attemptNumber) => {
      console.log("[Socket] Reconnected after", attemptNumber, "attempts");
      // Refresh conversation list to sync any missed messages
      refreshConversationList();
      // Re-fetch messages for current conversation
      if (window.currentConversationId) {
        fetchMessagesForConversation(window.currentConversationId)
          .then((messages) => {
            window.chatCache[window.currentConversationId] = messages;
            const convo = window.conversationCache.find(
              (c) => c.conversation_id === window.currentConversationId
            );
            if (convo) renderMessages(messages, convo);
          })
          .catch((err) => console.error("Failed to refresh messages after reconnect:", err));
      }
    });

    // Handle user removed from group while viewing
    getSocket().on("user_removed_from_group", (data) => {
      if (String(data.user_id) !== String(state.user?.id)) return;
      if (data.conversation_id === window.currentConversationId) {
        // Close group info panel if open
        const panel = document.getElementById("groupInfoPanel");
        if (panel) panel.remove();
        const overlay = document.getElementById("groupInfoOverlay");
        if (overlay) overlay.remove();
        
        // Show removed message
        document.getElementById("chatMessages").innerHTML = `
          <div class="chat-placeholder" style="text-align:center;padding:40px;">
            <i class="fa-solid fa-user-slash" style="font-size:48px;color:var(--muted);margin-bottom:16px;"></i>
            <p style="color:var(--muted);">You were removed from this group</p>
          </div>
        `;
        
        // Refresh conversation list to remove this group
        refreshConversationList();
      }
    });

    // Handle group deleted while viewing
    getSocket().on("group_deleted", (data) => {
      if (data.conversation_id === window.currentConversationId) {
        // Close group info panel if open
        const panel = document.getElementById("groupInfoPanel");
        if (panel) panel.remove();
        const overlay = document.getElementById("groupInfoOverlay");
        if (overlay) overlay.remove();
        
        document.getElementById("chatMessages").innerHTML = `
          <div class="chat-placeholder" style="text-align:center;padding:40px;">
            <i class="fa-solid fa-trash" style="font-size:48px;color:var(--muted);margin-bottom:16px;"></i>
            <p style="color:var(--muted);">This group was deleted</p>
          </div>
        `;
        
        window.currentConversationId = null;
        refreshConversationList();
      }
    });

    // Handle admin demoted while panel open
    getSocket().on("admin_demoted", (data) => {
      if (String(data.user_id) === String(state.user?.id) && 
          data.conversation_id === window.currentConversationId) {
        // Refresh group info panel to update admin controls
        const panel = document.getElementById("groupInfoPanel");
        if (panel) {
          const closePanel = () => {
            panel.classList.remove("open");
            const overlay = document.getElementById("groupInfoOverlay");
            if (overlay) overlay.classList.remove("open");
            setTimeout(() => {
              panel.remove();
              if (overlay) overlay.remove();
            }, 300);
          };
          closePanel();
          setTimeout(() => openGroupInfoPanel(data.conversation_id), 350);
        }
      }
    });
  }

  // Use cached conversation list if available for instant render, then refresh in background
  if (window.conversationCache && window.conversationCache.length > 0) {
    console.log('⚡ Chat: Using cached conversation list');
    renderConversationList();
    // Refresh in background (stale-while-revalidate)
    refreshConversationList().catch(() => {});
  } else {
    await refreshConversationList();
  }
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

async function openGroupInfoPanel(conversation_id) {
  const convo = (window.conversationCache || []).find(
    (c) => c.conversation_id === conversation_id
  );

  if (!convo) return;

  const me = String(state.user.id);
  let members;

  // Always fetch fresh from backend for panel
  try {
    members = await getGroupMembers(conversation_id);
  } catch {
    members = convo.members || [];
  }
  window.groupMemberCache[conversation_id] = members;

  const myRow = (members || []).find((m) => String(m.id) === me) || {};
  const isMeAdmin = Boolean(myRow.is_admin);
  const isMuted = Boolean(myRow.is_muted);
  const isMeMember = (members || []).some((m) => String(m.id) === me);

  const groupName = convo.display_name || convo.name || "Group";
  const groupInitial = (groupName[0] || "G").toUpperCase();
  const groupIcon = convo.icon_url || null;

  // Build member list HTML (WhatsApp style)
  const memberListHTML = (members || [])
    .map((m) => {
      const isMe = String(m.id) === me;
      const isAdmin = Boolean(m.is_admin);
      const initial = (m.name || "U")[0].toUpperCase();

      return `
        <div class="group-info-member-item" data-user-id="${m.id}">
          <div class="group-info-member-avatar">${initial}</div>
          <div class="group-info-member-info">
            <div class="group-info-member-name">${m.name}${isMe ? " (You)" : ""}</div>
          </div>
          ${isAdmin ? `<span class="group-info-member-badge">Group admin</span>` : ""}
        </div>`;
    })
    .join("");

  // Remove existing panel if any
  const existingPanel = document.getElementById("groupInfoPanel");
  if (existingPanel) existingPanel.remove();
  const existingOverlay = document.getElementById("groupInfoOverlay");
  if (existingOverlay) existingOverlay.remove();

  // Create overlay
  const overlay = document.createElement("div");
  overlay.id = "groupInfoOverlay";
  overlay.className = "group-info-overlay";
  document.body.appendChild(overlay);

  // Create panel
  const panel = document.createElement("div");
  panel.id = "groupInfoPanel";
  panel.className = "group-info-panel";
  panel.innerHTML = `
    <div class="group-info-panel-header">
      <button class="close-btn" id="closeGroupInfoBtn"><i class="fa-solid fa-xmark"></i></button>
      <h2>Group info</h2>
    </div>
    <div class="group-info-panel-body">
      <!-- Icon section -->
      <div class="group-info-icon-section">
        <div class="group-info-avatar" id="groupInfoAvatar">
          ${groupIcon ? `<img src="${groupIcon}" alt="Group icon">` : groupInitial}
        </div>
        <div class="group-info-name-row">
          <span class="group-info-name" id="groupInfoName">${groupName}</span>
          ${isMeAdmin ? `<button class="edit-btn" id="editGroupNameBtn"><i class="fa-solid fa-pencil"></i></button>` : ""}
        </div>
        <div class="group-info-subtitle">Group · ${members.length} members</div>
      </div>

      <!-- Description section -->
      <div class="group-info-section">
        <div class="group-info-description">
          <span class="group-info-description-text" id="groupDescText">${convo.description || "Add group description"}</span>
          ${isMeAdmin ? `<button class="edit-btn" id="editGroupDescBtn"><i class="fa-solid fa-pencil"></i></button>` : ""}
        </div>
      </div>

      <!-- Created info -->
      <div class="group-info-created">
        Group created by ${convo.created_by_name || "unknown"}, ${convo.created_on ? new Date(convo.created_on).toLocaleDateString() : ""}
      </div>

      <!-- Mute notifications -->
      <div class="group-info-action-row" id="muteGroupRow">
        <i class="fa-solid fa-bell${isMuted ? "-slash" : ""}"></i>
        <span>${isMuted ? "Unmute" : "Mute"} notifications</span>
      </div>

      <!-- Members section -->
      <div class="group-info-members-header">
        <span>${members.length} members</span>
        <button class="search-btn" id="searchMembersBtn"><i class="fa-solid fa-magnifying-glass"></i></button>
      </div>

      <!-- Member search input (hidden by default) -->
      <div id="memberSearchContainer" style="display:none;padding:8px 16px;">
        <input type="text" id="memberSearchInput" placeholder="Search members..." style="
          width:100%;
          padding:8px 12px;
          border:none;
          border-radius:999px;
          background:rgba(255,255,255,0.06);
          border:1px solid rgba(255,255,255,0.08);
          color:var(--text);
          font-size:13px;
          outline:none;
        ">
      </div>

      <!-- Add member (admin only) -->
      ${isMeAdmin ? `
      <div class="group-info-action-row green" id="addMemberRow">
        <i class="fa-solid fa-user-plus"></i>
        <span>Add member</span>
      </div>
      ` : ""}

      <!-- Member list -->
      <div id="groupInfoMemberList">
        ${memberListHTML}
      </div>

      <!-- Add to favorites -->
      <div class="group-info-action-row" id="addFavoritesRow" style="border-top: 8px solid var(--surface-alt, #202c33);margin-top:8px;">
        <i class="fa-regular fa-heart"></i>
        <span>Add to favorites</span>
      </div>

      <!-- Exit group -->
      ${isMeMember ? `
      <div class="group-info-action-row red" id="exitGroupRow">
        <i class="fa-solid fa-arrow-right-from-bracket"></i>
        <span>Exit group</span>
      </div>
      ` : `
      <div class="group-info-action-row red" id="deleteGroupRow">
        <i class="fa-solid fa-trash"></i>
        <span>Delete group</span>
      </div>
      `}
    </div>
  `;
  document.body.appendChild(panel);

  // Animate open
  requestAnimationFrame(() => {
    panel.classList.add("open");
    overlay.classList.add("open");
  });

  // Close handlers
  const closePanel = () => {
    panel.classList.remove("open");
    overlay.classList.remove("open");
    setTimeout(() => {
      panel.remove();
      overlay.remove();
    }, 300);
  };

  document.getElementById("closeGroupInfoBtn").onclick = closePanel;
  overlay.onclick = closePanel;

  // Group icon change (admin only)
  const avatarEl = document.getElementById("groupInfoAvatar");
  if (avatarEl && isMeAdmin) {
    avatarEl.style.cursor = "pointer";
    avatarEl.title = "Change icon";
    avatarEl.onclick = async () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          await updateGroupIcon(conversation_id, file);

          // Refresh conversation list (so icon appears in future panel opens and list)
          if (typeof window.refreshConversationList === "function") {
            await window.refreshConversationList();
          }

          // Re-open panel to show new icon
          closePanel();
          setTimeout(() => openGroupInfoPanel(conversation_id), 350);
        } catch (err) {
          console.error("updateGroupIcon failed:", err);
          alert("Failed to update group icon");
        }
      };
      input.click();
    };
  }

  // Mute toggle
  document.getElementById("muteGroupRow").onclick = async () => {
    try {
      await muteGroup(conversation_id, !isMuted);
      delete window.groupMemberCache[conversation_id];
      closePanel();
      setTimeout(() => openGroupInfoPanel(conversation_id), 350);
    } catch (err) {
      console.error("muteGroup failed:", err);
      alert("Failed to update mute");
    }
  };

  // Exit group
  const exitEl = document.getElementById("exitGroupRow");
  if (exitEl) {
    exitEl.onclick = async () => {
      if (!confirm("Exit this group?")) return;
      try {
        await leaveGroup(conversation_id);
        closePanel();
        if (typeof window.refreshConversationList === "function") {
          await window.refreshConversationList();
        }
      } catch (err) {
        console.error("leaveGroup failed:", err);
        alert("Failed to leave group");
      }
    };
  }

  // Delete group (removed users only) - hides from this user's feed
  const delEl = document.getElementById("deleteGroupRow");
  if (delEl) {
    delEl.onclick = async () => {
      if (!confirm("Remove this group from your chat list?")) return;
      const hiddenChats = JSON.parse(localStorage.getItem("hiddenChats") || "[]");
      if (!hiddenChats.includes(conversation_id)) {
        hiddenChats.push(conversation_id);
        localStorage.setItem("hiddenChats", JSON.stringify(hiddenChats));
      }
      closePanel();
      if (typeof window.refreshConversationList === "function") {
        await window.refreshConversationList();
      } else {
        renderConversationList(getChatSearchFilter());
      }
      if (String(window.currentConversationId) === String(conversation_id)) {
        setGroupComposerDisabled(true, "You're no longer a participant");
        const chatBox = document.getElementById("chatMessages");
        if (chatBox) {
          chatBox.innerHTML = `<div class="chat-placeholder">You're no longer a participant</div>`;
        }
      }
    };
  }

  // Add member (admin only)
  const addMemberRow = document.getElementById("addMemberRow");
  if (addMemberRow) {
    addMemberRow.onclick = () => {
      closePanel();
      setTimeout(() => openAddMembersPanel(conversation_id), 350);
    };
  }

  // Member search functionality
  const searchMembersBtn = document.getElementById("searchMembersBtn");
  const memberSearchContainer = document.getElementById("memberSearchContainer");
  const memberSearchInput = document.getElementById("memberSearchInput");
  const memberListContainer = document.getElementById("groupInfoMemberList");

  if (searchMembersBtn && memberSearchContainer && memberSearchInput) {
    searchMembersBtn.onclick = () => {
      const isVisible = memberSearchContainer.style.display !== "none";
      memberSearchContainer.style.display = isVisible ? "none" : "block";
      if (!isVisible) {
        memberSearchInput.focus();
      } else {
        memberSearchInput.value = "";
        // Reset member list visibility
        memberListContainer.querySelectorAll(".group-info-member-item").forEach((item) => {
          item.style.display = "";
        });
      }
    };

    memberSearchInput.oninput = () => {
      const query = memberSearchInput.value.toLowerCase().trim();
      memberListContainer.querySelectorAll(".group-info-member-item").forEach((item) => {
        const name = item.querySelector(".group-info-member-name")?.textContent?.toLowerCase() || "";
        item.style.display = name.includes(query) ? "" : "none";
      });
    };
  }

  // Edit group name (admin only)
  const editNameBtn = document.getElementById("editGroupNameBtn");
  if (editNameBtn) {
    editNameBtn.onclick = async () => {
      const newName = prompt("Enter new group name:", groupName);
      if (!newName || newName.trim() === groupName) return;
      try {
        await renameGroup(conversation_id, newName.trim());
        delete window.groupMemberCache[conversation_id];
        if (typeof window.refreshConversationList === "function") {
          await window.refreshConversationList();
        }
        closePanel();
        setTimeout(() => openGroupInfoPanel(conversation_id), 350);
      } catch (err) {
        console.error("rename failed:", err);
        alert("Failed to rename group");
      }
    };
  }

  // Edit group description (admin only)
  const editDescBtn = document.getElementById("editGroupDescBtn");
  if (editDescBtn) {
    editDescBtn.onclick = async () => {
      const currentDesc = convo.description || "";
      const newDesc = prompt("Enter group description:", currentDesc);
      if (newDesc === null || newDesc === currentDesc) return;
      try {
        await updateGroupDescription(conversation_id, newDesc.trim());
        if (typeof window.refreshConversationList === "function") {
          await window.refreshConversationList();
        }
        closePanel();
        setTimeout(() => openGroupInfoPanel(conversation_id), 350);
      } catch (err) {
        console.error("update description failed:", err);
        alert("Failed to update description");
      }
    };
  }

  // Member click (admin can remove/make admin) - WhatsApp-style action menu
  if (isMeAdmin) {
    document.querySelectorAll(".group-info-member-item").forEach((item) => {
      item.onclick = (e) => {
        const uid = item.dataset.userId;
        if (!uid || uid === me) return;

        const member = members.find((m) => String(m.id) === uid);
        if (!member) return;

        const isAdmin = Boolean(member.is_admin);
        
        // Remove any existing action menu
        const existingMenu = document.getElementById("memberActionMenu");
        if (existingMenu) existingMenu.remove();

        // Create action menu
        const menu = document.createElement("div");
        menu.id = "memberActionMenu";
        menu.style.cssText = `
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          background: var(--surface, #fff);
          border-radius: 16px 16px 0 0;
          box-shadow: 0 -4px 20px rgba(0,0,0,0.15);
          z-index: 100001;
          padding: 16px;
          animation: slideUp 0.2s ease;
        `;

        let menuHTML = `
          <div style="text-align:center;margin-bottom:12px;">
            <div style="width:40px;height:4px;background:var(--muted);border-radius:2px;margin:0 auto 12px;"></div>
            <div style="font-weight:600;font-size:16px;">${escapeHtml(member.name)}</div>
          </div>
        `;

        if (!isAdmin) {
          menuHTML += `
            <div class="member-action-item" data-action="make-admin" style="
              display:flex;align-items:center;gap:12px;padding:14px;
              border-radius:8px;cursor:pointer;
            ">
              <i class="fa-solid fa-user-shield" style="color:#00a884;width:24px;"></i>
              <span>Make group admin</span>
            </div>
          `;
        }

        menuHTML += `
          <div class="member-action-item" data-action="remove" style="
            display:flex;align-items:center;gap:12px;padding:14px;
            border-radius:8px;cursor:pointer;color:#f15c6d;
          ">
            <i class="fa-solid fa-user-minus" style="width:24px;"></i>
            <span>Remove from group</span>
          </div>
          <div class="member-action-item" data-action="cancel" style="
            display:flex;align-items:center;justify-content:center;gap:12px;padding:14px;
            border-radius:8px;cursor:pointer;margin-top:8px;
            background:var(--surface-alt, #f0f0f0);
          ">
            <span>Cancel</span>
          </div>
        `;

        menu.innerHTML = menuHTML;
        document.body.appendChild(menu);

        // Add hover effects
        menu.querySelectorAll(".member-action-item").forEach((item) => {
          item.onmouseenter = () => item.style.background = "var(--surface-alt, #f5f5f5)";
          item.onmouseleave = () => {
            if (item.dataset.action !== "cancel") item.style.background = "";
          };
        });

        // Action handlers
        menu.querySelector('[data-action="make-admin"]')?.addEventListener("click", async () => {
          menu.remove();
          try {
            await makeGroupAdmin(conversation_id, uid, true);
            delete window.groupMemberCache[conversation_id];
            closePanel();
            setTimeout(() => openGroupInfoPanel(conversation_id), 350);
          } catch (err) {
            console.error("make admin failed:", err);
            alert("Failed to make admin");
          }
        });

        menu.querySelector('[data-action="remove"]')?.addEventListener("click", async () => {
          menu.remove();
          if (!confirm(`Remove ${member.name} from group?`)) return;
          try {
            await removeMembersFromGroup(conversation_id, [uid]);
            delete window.groupMemberCache[conversation_id];
            closePanel();
            setTimeout(() => openGroupInfoPanel(conversation_id), 350);
          } catch (err) {
            console.error("remove member failed:", err);
            alert("Failed to remove member");
          }
        });

        menu.querySelector('[data-action="cancel"]')?.addEventListener("click", () => {
          menu.remove();
        });

        // Close on outside click
        setTimeout(() => {
          document.addEventListener("click", function closeMenu(ev) {
            if (!menu.contains(ev.target) && !item.contains(ev.target)) {
              menu.remove();
              document.removeEventListener("click", closeMenu);
            }
          });
        }, 100);
      };
    });
  }

  // Add to favorites (local storage for now)
  document.getElementById("addFavoritesRow").onclick = () => {
    const favs = JSON.parse(localStorage.getItem("favoriteChats") || "[]");
    if (favs.includes(conversation_id)) {
      alert("Already in favorites");
    } else {
      favs.push(conversation_id);
      localStorage.setItem("favoriteChats", JSON.stringify(favs));
      alert("Added to favorites");
    }
  };
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
