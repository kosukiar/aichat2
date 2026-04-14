import "./style.css";
import { startMicCapture, AudioPlayer } from "./audio-utils";

const WS_URL = import.meta.env.VITE_WS_URL;
if (!WS_URL) {
  document.querySelector<HTMLDivElement>("#app")!.innerHTML =
    "<p style='color:red;text-align:center;margin-top:2rem'>VITE_WS_URL が設定されていません</p>";
  throw new Error("VITE_WS_URL is not set");
}

let ws: WebSocket | null = null;
let micHandle: { stop: () => void } | null = null;
let audioPlayer: AudioPlayer | null = null;
let isSessionActive = false;
let currentRole: string | null = null;
let isSpeculative = false;

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <h1>🎙️ Nova Sonic Voice Chat</h1>
  <p class="subtitle">Amazon Nova Sonic でリアルタイム音声会話</p>
  <button class="mic-button" id="micBtn" aria-label="マイクのオン・オフ切り替え">🎤</button>
  <div id="status">マイクボタンを押して会話を開始</div>
  <div id="transcript" role="log" aria-live="polite" aria-label="会話ログ"></div>
  <div id="feedback" role="region" aria-label="フィードバック"></div>
`;

const micBtn = document.getElementById("micBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const transcriptEl = document.getElementById("transcript")!;
const feedbackEl = document.getElementById("feedback")!;

micBtn.addEventListener("click", toggleSession);

function setStatus(text: string) {
  statusEl.textContent = text;
}

function addMessage(role: string, text: string) {
  const div = document.createElement("div");
  div.className = `msg ${role.toLowerCase()}`;
  const label = role === "USER" ? "You" : "Assistant";
  div.innerHTML = `<span class="label">${label}:</span>${text}`;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

async function toggleSession() {
  if (isSessionActive) {
    await stopSession();
  } else {
    await startSession();
  }
}

async function startSession() {
  console.log("startSession called, connecting to", WS_URL);
  micBtn.classList.add("connecting");
  setStatus("接続中...");

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.error("WebSocket creation failed:", err);
    setStatus("WebSocket 作成に失敗しました");
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

      case "feedback":
        showFeedback(msg.content);
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
    setStatus("マイクへのアクセスが拒否されました");
    await stopSession();
  }
}

async function stopSession() {
  if (ws?.readyState === WebSocket.OPEN) {
    setStatus("フィードバックを生成中...");
    ws.send(JSON.stringify({ type: "end_session" }));
  }
  micHandle?.stop();
  micHandle = null;
}

function showFeedback(content: string) {
  feedbackEl.innerHTML = `<div class="feedback-content"><h2>📋 会話フィードバック</h2><pre>${content}</pre></div>`;
  cleanupSession();
}

function cleanupSession() {
  isSessionActive = false;
  micBtn.classList.remove("active", "connecting");
  setStatus("マイクボタンを押して会話を開始");
  audioPlayer?.stop();
  audioPlayer = null;
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    ws.close();
  }
  ws = null;
}
