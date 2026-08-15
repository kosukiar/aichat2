import "./style.css";
import { startMicCapture, AudioPlayer } from "./audio-utils";
import { ghostSvg } from "./ghost";
import type { ChatMessage, SessionSummary } from "./api";
import {
  getUserId,
  setUserId,
  listSessions,
  createSession,
  getSession,
  patchSession,
  deleteSession,
} from "./api";

const WS_URL = import.meta.env.VITE_WS_URL;

const app = document.querySelector<HTMLDivElement>("#app")!;

if (!WS_URL) {
  app.innerHTML =
    "<p style='color:#f87171;text-align:center;margin-top:2rem'>VITE_WS_URL が設定されていません</p>";
  throw new Error("VITE_WS_URL is not set");
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
app.innerHTML = `
  <div class="layout">
    <aside class="sidebar glass" id="sidebar" aria-label="サイドバー">
      <div class="sidebar-head">
        <span class="brand"><span class="brand-logo">${ghostSvg()}</span>Nova&nbsp;Sonic</span>
        <button class="icon-btn close-drawer" id="closeDrawerBtn" aria-label="メニューを閉じる">✕</button>
      </div>
      <button class="new-chat" id="newChatBtn">＋ New chat</button>
      <nav class="session-list" id="sessionList" aria-label="セッション一覧"></nav>
      <div class="sidebar-foot">
        <button class="user-chip" id="userChip" aria-label="ログインコードを表示・変更"></button>
      </div>
    </aside>

    <div class="scrim" id="scrim"></div>

    <main class="main">
      <header class="topbar">
        <button class="icon-btn hamburger" id="hamburgerBtn" aria-label="メニューを開く">☰</button>
        <span class="brand-logo topbar-logo">${ghostSvg()}</span>
        <h1>Voice Chat</h1>
      </header>

      <section class="stage">
        <button class="mic-button" id="micBtn" aria-label="マイクのオン・オフ切り替え"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/></svg></button>
        <div id="status">マイクボタンを押して会話を開始</div>
      </section>

      <div id="transcript" role="log" aria-live="polite" aria-label="会話ログ"></div>
    </main>
  </div>

  <div class="modal-overlay" id="loginModal" hidden>
    <div class="modal glass" role="dialog" aria-modal="true" aria-labelledby="loginTitle">
      <h2 id="loginTitle">ログインコード</h2>
      <p class="modal-desc">
        任意のコードを入力してください。スマホと PC で同じコードを使うと、会話履歴が同期されます。
      </p>
      <input id="loginInput" class="login-input" type="text" autocomplete="off"
             placeholder="例: my-secret-code" aria-label="ログインコード" />
      <div class="modal-actions">
        <button id="loginSave" class="btn-primary">保存</button>
      </div>
    </div>
  </div>
`;

const micBtn = document.getElementById("micBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const transcriptEl = document.getElementById("transcript")!;
const sidebarEl = document.getElementById("sidebar")!;
const scrimEl = document.getElementById("scrim")!;
const sessionListEl = document.getElementById("sessionList")!;
const newChatBtn = document.getElementById("newChatBtn") as HTMLButtonElement;
const hamburgerBtn = document.getElementById("hamburgerBtn") as HTMLButtonElement;
const closeDrawerBtn = document.getElementById("closeDrawerBtn") as HTMLButtonElement;
const userChip = document.getElementById("userChip") as HTMLButtonElement;
const loginModal = document.getElementById("loginModal")!;
const loginInput = document.getElementById("loginInput") as HTMLInputElement;
const loginSave = document.getElementById("loginSave") as HTMLButtonElement;

// ---------------------------------------------------------------------------
// Voice pipeline state (preserved from the original implementation)
// ---------------------------------------------------------------------------
let ws: WebSocket | null = null;
let micHandle: { stop: () => void } | null = null;
let audioPlayer: AudioPlayer | null = null;
let isSessionActive = false;
let currentRole: string | null = null;
let isSpeculative = false;

// ---------------------------------------------------------------------------
// Session-management state
// ---------------------------------------------------------------------------
let currentSessionId: string | null = null;
let needsTitle = false;
let pendingAppend: ChatMessage[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
// The bubble currently being streamed, mirrored for persistence.
let activeMsg: ChatMessage | null = null;

function setStatus(text: string) {
  statusEl.textContent = text;
}

// ---------------------------------------------------------------------------
// Transcript rendering — merges consecutive same-speaker fragments + escapes.
// Nova Sonic streams both ASR and the assistant response as many small text
// events, so without merging each fragment would create a new row.
// ---------------------------------------------------------------------------
let lastMsgEl: HTMLDivElement | null = null;
let lastMsgRole: string | null = null;

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function renderBubble(role: string, text: string): HTMLDivElement {
  const label = role === "USER" ? "You" : "Assistant";
  const div = document.createElement("div");
  div.className = `msg ${role.toLowerCase()}`;
  div.dataset.text = text;
  div.innerHTML = `<span class="label">${label}:</span>${escapeHtml(text)}`;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return div;
}

function addMessage(role: string, text: string) {
  if (!text) return;

  if (lastMsgRole === role && lastMsgEl) {
    // Same speaker as the previous fragment -> append to the same bubble.
    const prev = lastMsgEl.dataset.text ?? "";
    // Guard against an occasional duplicate event repeating the tail.
    const merged = prev.endsWith(text) ? prev : prev ? `${prev} ${text}` : text;
    const label = role === "USER" ? "You" : "Assistant";
    lastMsgEl.dataset.text = merged;
    lastMsgEl.innerHTML = `<span class="label">${label}:</span>${escapeHtml(merged)}`;
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    if (activeMsg) activeMsg.text = merged;
  } else {
    // Speaker changed -> finalize the previous bubble, then start a new one.
    finalizeActive();
    lastMsgEl = renderBubble(role, text);
    lastMsgRole = role;
    activeMsg = { role: role === "USER" ? "USER" : "ASSISTANT", text };
  }
}

// Start the next message in a fresh bubble (e.g. after a session ends).
function resetTranscriptState() {
  lastMsgEl = null;
  lastMsgRole = null;
}

function clearTranscript() {
  transcriptEl.innerHTML = "";
  activeMsg = null;
  pendingAppend = [];
  resetTranscriptState();
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function finalizeActive() {
  if (!activeMsg) return;
  const m = activeMsg;
  activeMsg = null;
  if (!currentSessionId) return; // persistence disabled (no login)
  pendingAppend.push(m);
  if (m.role === "USER" && needsTitle) {
    needsTitle = false;
    void setSessionTitle(m.text.slice(0, 40));
  }
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPending();
  }, 1500);
}

async function flushPending() {
  const uid = getUserId();
  if (!uid || !currentSessionId || pendingAppend.length === 0) return;
  const batch = pendingAppend.splice(0, pendingAppend.length);
  try {
    await patchSession(uid, currentSessionId, { appendMessages: batch });
  } catch (err) {
    console.error("Failed to persist messages:", err);
    pendingAppend.unshift(...batch); // requeue for the next flush
  }
}

async function setSessionTitle(title: string) {
  const uid = getUserId();
  if (!uid || !currentSessionId || !title) return;
  try {
    await patchSession(uid, currentSessionId, { title });
    await refreshSessions();
  } catch (err) {
    console.error("Failed to set session title:", err);
  }
}

async function ensureSession() {
  const uid = getUserId();
  if (!uid || currentSessionId) return;
  try {
    const s = await createSession(uid);
    currentSessionId = s.id;
    needsTitle = true;
    await refreshSessions();
  } catch (err) {
    console.error("Failed to auto-create session:", err);
  }
}

async function refreshSessions() {
  const uid = getUserId();
  if (!uid) {
    sessionListEl.innerHTML = "";
    return;
  }
  try {
    const sessions = await listSessions(uid);
    renderSessionList(sessions);
  } catch (err) {
    console.error("Failed to list sessions:", err);
  }
}

function renderSessionList(sessions: SessionSummary[]) {
  sessionListEl.innerHTML = "";
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "session-empty";
    empty.textContent = "まだ会話がありません";
    sessionListEl.appendChild(empty);
    return;
  }
  for (const s of sessions) {
    const item = document.createElement("div");
    item.className = "session-item" + (s.id === currentSessionId ? " active" : "");

    const title = document.createElement("button");
    title.className = "session-title";
    title.textContent = s.title || "New chat";
    title.addEventListener("click", () => void loadSession(s.id));

    const del = document.createElement("button");
    del.className = "session-del";
    del.setAttribute("aria-label", "このセッションを削除");
    del.textContent = "×";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      void removeSession(s.id);
    });

    item.append(title, del);
    sessionListEl.appendChild(item);
  }
}

async function loadSession(id: string) {
  const uid = getUserId();
  if (!uid) return;
  try {
    const s = await getSession(uid, id);
    currentSessionId = s.id;
    needsTitle = false;
    clearTranscript();
    for (const m of s.messages ?? []) renderBubble(m.role, m.text);
    void refreshSessions();
    closeDrawer();
  } catch (err) {
    console.error("Failed to load session:", err);
  }
}

async function newChat() {
  clearTranscript();
  currentSessionId = null;
  needsTitle = false;
  const uid = getUserId();
  if (!uid) {
    openLogin();
    return;
  }
  try {
    const s = await createSession(uid);
    currentSessionId = s.id;
    needsTitle = true;
    await refreshSessions();
  } catch (err) {
    console.error("Failed to create session:", err);
  }
  closeDrawer();
}

async function removeSession(id: string) {
  const uid = getUserId();
  if (!uid) return;
  try {
    await deleteSession(uid, id);
    if (id === currentSessionId) {
      currentSessionId = null;
      clearTranscript();
    }
    await refreshSessions();
  } catch (err) {
    console.error("Failed to delete session:", err);
  }
}

// ---------------------------------------------------------------------------
// Identity / login modal
// ---------------------------------------------------------------------------
function renderUserChip() {
  const uid = getUserId();
  userChip.textContent = uid ? `👤 ${uid}` : "👤 ログイン";
}

function openLogin() {
  loginInput.value = getUserId() ?? "";
  loginModal.hidden = false;
  loginInput.focus();
}

function closeLogin() {
  loginModal.hidden = true;
}

function saveLogin() {
  const code = loginInput.value.trim();
  if (!code) return;
  setUserId(code);
  renderUserChip();
  closeLogin();
  void refreshSessions();
}

// ---------------------------------------------------------------------------
// Drawer (mobile sidebar)
// ---------------------------------------------------------------------------
function openDrawer() {
  sidebarEl.classList.add("open");
  scrimEl.classList.add("show");
}

function closeDrawer() {
  sidebarEl.classList.remove("open");
  scrimEl.classList.remove("show");
}

// ---------------------------------------------------------------------------
// Voice session (WebSocket + audio pipeline — behavior preserved)
// ---------------------------------------------------------------------------
async function toggleSession() {
  if (isSessionActive) {
    await stopSession();
  } else {
    await startSession();
  }
}

async function startSession() {
  await ensureSession(); // auto-create a session if none is current
  console.log("startSession called, connecting to", WS_URL);
  micBtn.classList.add("connecting");
  setStatus("接続中...");

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.error("WebSocket creation failed:", err);
    setStatus("WebSocket 作成に失敗しました");
    micBtn.classList.remove("connecting");
    return;
  }
  audioPlayer = new AudioPlayer();

  ws.onopen = () => {
    console.log("WebSocket connected");
    ws!.send(JSON.stringify({ type: "start_session" }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case "session_started":
        isSessionActive = true;
        micBtn.classList.remove("connecting");
        micBtn.classList.add("active");
        setStatus("🔴 会話中... もう一度押すと停止");
        beginMicCapture();
        break;

      case "content_start":
        currentRole = msg.role;
        isSpeculative = msg.speculative;
        break;

      case "text":
        if (currentRole === "USER") {
          addMessage("USER", msg.content);
        } else if (currentRole === "ASSISTANT" && isSpeculative) {
          addMessage("ASSISTANT", msg.content);
        }
        break;

      case "audio":
        audioPlayer?.enqueue(msg.content);
        break;

      case "content_end":
        currentRole = null;
        isSpeculative = false;
        break;

      case "session_ended":
        cleanupSession();
        break;

      case "error":
        setStatus(`エラー: ${msg.message}`);
        cleanupSession();
        break;
    }
  };

  ws.onerror = (e) => {
    console.error("WebSocket error:", e);
    setStatus("接続エラー。サーバーが起動しているか確認してください。");
    cleanupSession();
  };

  ws.onclose = (e) => {
    console.log("WebSocket closed:", e.code, e.reason);
    if (isSessionActive) {
      cleanupSession();
    }
  };
}

async function beginMicCapture() {
  try {
    micHandle = await startMicCapture((base64Pcm) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "audio_chunk", content: base64Pcm }));
      }
    });
  } catch (err) {
    console.error("Mic capture failed:", err);
    setStatus("マイクへのアクセスが拒否されました");
    await stopSession();
  }
}

async function stopSession() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "end_session" }));
  }
  micHandle?.stop();
  micHandle = null;
  cleanupSession();
}

function cleanupSession() {
  isSessionActive = false;
  finalizeActive();
  void flushPending();
  resetTranscriptState();
  micBtn.classList.remove("active", "connecting");
  setStatus("マイクボタンを押して会話を開始");
  audioPlayer?.stop();
  audioPlayer = null;
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    ws.close();
  }
  ws = null;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
micBtn.addEventListener("click", () => void toggleSession());
newChatBtn.addEventListener("click", () => void newChat());
hamburgerBtn.addEventListener("click", openDrawer);
closeDrawerBtn.addEventListener("click", closeDrawer);
scrimEl.addEventListener("click", closeDrawer);
userChip.addEventListener("click", openLogin);
loginSave.addEventListener("click", saveLogin);
loginInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveLogin();
});
loginModal.addEventListener("click", (e) => {
  // Click the dimmed backdrop to dismiss — but only once a code is set,
  // so first-run visitors must enter one.
  if (e.target === loginModal && getUserId()) closeLogin();
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
renderUserChip();
if (getUserId()) {
  void refreshSessions();
} else {
  openLogin();
}
