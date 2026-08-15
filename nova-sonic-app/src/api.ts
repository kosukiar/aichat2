// Session persistence + user identity for the Nova Sonic voice chat.
//
// The REST base is derived from the WebSocket endpoint (VITE_WS_URL): the same
// host serves both, so we just swap the scheme (ws -> http, wss -> https).

export interface ChatMessage {
  role: "USER" | "ASSISTANT";
  text: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
}

export interface SessionPatch {
  appendMessages?: ChatMessage[];
  title?: string;
}

// `?? ""` keeps this module importable even when VITE_WS_URL is unset; main.ts
// owns the user-facing "not configured" guard.
const WS_URL: string = import.meta.env.VITE_WS_URL ?? "";

// wss: -> https:, ws: -> http:  (order matters so wss isn't mangled by the ws rule)
export const API_BASE: string = WS_URL.replace(/^wss:/i, "https:").replace(
  /^ws:/i,
  "http:"
);

const USER_KEY = "nova_user_id";

export function getUserId(): string | null {
  return localStorage.getItem(USER_KEY);
}

export function setUserId(id: string): void {
  localStorage.setItem(USER_KEY, id);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`API ${path} failed: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listSessions(userId: string): Promise<SessionSummary[]> {
  const data = await requestJson<{ sessions: SessionSummary[] }>(
    `/api/sessions?userId=${encodeURIComponent(userId)}`
  );
  return data.sessions ?? [];
}

export async function createSession(
  userId: string,
  title?: string
): Promise<SessionDetail> {
  return requestJson<SessionDetail>(`/api/sessions`, {
    method: "POST",
    body: JSON.stringify({ userId, title }),
  });
}

export async function getSession(
  userId: string,
  id: string
): Promise<SessionDetail> {
  return requestJson<SessionDetail>(
    `/api/sessions/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}`
  );
}

export async function patchSession(
  userId: string,
  id: string,
  patch: SessionPatch
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/sessions/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, ...patch }),
    }
  );
  if (!res.ok) {
    throw new Error(`PATCH /api/sessions/${id} failed: HTTP ${res.status}`);
  }
}

export async function deleteSession(userId: string, id: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/sessions/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    throw new Error(`DELETE /api/sessions/${id} failed: HTTP ${res.status}`);
  }
}
