// ===== Config =====
const BOT_AVATAR_SRC = "./bot-avatar.jpg";

const API_URL = "https://public-rag-api.ytec-nagano.workers.dev/chat";
const METRICS_URL = API_URL.replace(/\/chat\b/, "/metrics");

// ===== Storage =====
const LS_KEY = "public_rag_chat_threads_v1";
const nowIso = () => new Date().toISOString();

function loadThreads() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
  catch { return []; }
}
function saveThreads(threads) {
  localStorage.setItem(LS_KEY, JSON.stringify(threads));
}
function newThread() {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "_" + Math.random().toString(16).slice(2),
    title: "新しいチャット",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: [] // {role:"user"|"assistant", content:"", sources?:[]}
  };
}

// ===== DOM =====
const $ = (sel) => document.querySelector(sel);

const elThreadList = $("#threadList");
const elNewChatBtn  = $("#newChatBtn");
const elClearBtn    = $("#clearBtn");
const elThreadTitle = $("#threadTitle");
const elChat        = $("#chat");
const elInput       = $("#input");
const elSendBtn     = $("#sendBtn");

// banner
const elBanner       = $("#rateBanner");
const elBannerText   = $("#rateBannerText");
const elAutoResend   = $("#rateAutoResend");

// status
const elStatusLine  = $("#statusLine");
const elStatusText  = $("#statusText");

// metrics
const elMetricsBucket  = $("#metricsBucket");
const elMReq = $("#mReq");
const elMOk  = $("#mOk");
const elMRl  = $("#mRl");
const elMErr = $("#mErr");
const elMetricsUpdated = $("#metricsUpdated");

// ===== State =====
let threads = loadThreads();
let activeId = (threads[0] && threads[0].id) || null;

let isSending = false;
let rateLocked = false;
let bannerTimer = null;
let currentAbort = null;

// When we already added the user's message but couldn't get a reply yet,
// we keep a pending call so we can retry without duplicating the user message.
let pendingCall = null; // { text: string, threadId: string, tries: number }

function getActiveThread() {
  return threads.find(t => t.id === activeId) || null;
}

// ===== Utils =====
function escapeHtml(s) {
  return (s ?? "").toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function nl2br(s) {
  return escapeHtml(s).replace(/\n/g, "<br>");
}

function scrollChatToBottom() {
  elChat.scrollTop = elChat.scrollHeight;
}

function updateComposerState() {
  const disabled = isSending || rateLocked;
  elSendBtn.disabled = disabled;
  elInput.disabled = disabled;
  elSendBtn.classList.toggle("is-loading", isSending);
}

function setSending(v) {
  isSending = !!v;
  refreshMetrics();
updateComposerState();
  if (isSending) {
    setStatus("接続中…");
  } else {
    // hide when not sending (banner handles rate-limit / retry messaging)
    if (!rateLocked) setStatus("");
  }
}

function stopInFlight() {
  try { currentAbort?.abort(); } catch {}
  currentAbort = null;
}

function setStatus(text) {
  if (!elStatusLine) return;
  const t = (text || "").trim();
  if (!t) {
    elStatusLine.hidden = true;
    if (elStatusText) elStatusText.textContent = "";
    return;
  }
  elStatusLine.hidden = false;
  if (elStatusText) elStatusText.textContent = t;
  else elStatusLine.textContent = t;
}


// ===== Metrics =====
async function fetchMetrics() {
  try {
    const res = await fetch(METRICS_URL, { method: "GET" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function renderMetrics(data) {
  if (!data) return;
  if (elMetricsBucket) elMetricsBucket.textContent = data.bucket ? data.bucket : "-";
  if (elMReq) elMReq.textContent = String(data.current?.req ?? 0);
  if (elMOk)  elMOk.textContent  = String(data.current?.ok  ?? 0);
  if (elMRl)  elMRl.textContent  = String(data.current?.rl  ?? 0);
  if (elMErr) elMErr.textContent = String(data.current?.err ?? 0);

  if (elMetricsUpdated) {
    const t = data.updated_at ? new Date(data.updated_at) : null;
    elMetricsUpdated.textContent = t ? `更新: ${t.toLocaleString()}` : "更新: -";
  }
}

async function refreshMetrics() {
  const data = await fetchMetrics();
  if (data) renderMetrics(data);
}

// Poll every 10s (lightweight)
setInterval(refreshMetrics, 10_000);

function clearBanner() {
  if (!elBanner) return;
  elBanner.hidden = true;
  elBanner.classList.remove("banner--warn");
  if (elBannerText) elBannerText.textContent = "";
  if (bannerTimer) clearInterval(bannerTimer);
  bannerTimer = null;
}

function showBanner({ mode, seconds, message }) {
  if (!elBanner) return;

  // mode: "rate" | "retry"
  clearBanner();
  setStatus("");

  // rate lock during countdown
  rateLocked = true;
  refreshMetrics();
updateComposerState();

  // stop in-flight to prevent late replies showing up during cooldown
  stopInFlight();
  if (mode !== "retry") setStatus("");

  let remain = Math.max(0, Number(seconds || 0));
  elBanner.hidden = false;

  if (mode === "retry") elBanner.classList.add("banner--warn");

  const render = () => {
    const prefix = (mode === "retry")
      ? "一時的に混雑/通信エラーの可能性があります。"
      : "アクセスが多すぎます。";
    const suffix = (mode === "retry")
      ? ` ${remain}秒後に再試行します。`
      : ` ${remain}秒待ってから再試行してください。`;

    if (elBannerText) elBannerText.textContent = message || (prefix + suffix);
    else elBanner.textContent = message || (prefix + suffix);

    // small status line: show only for retry countdown
    if (mode === "retry") {
      setStatus(`再試行まで ${remain}秒…`);
    }
  };

  render();

  bannerTimer = setInterval(() => {
    remain -= 1;
    if (remain <= 0) {
      clearInterval(bannerTimer);
      bannerTimer = null;

      rateLocked = false;
      refreshMetrics();
updateComposerState();
      clearBanner();
  setStatus("");
      setStatus("");
      elInput.focus();

      // Auto action at the end of countdown
      if (pendingCall) {
        if (mode === "rate") {
          if (elAutoResend?.checked) {
            // retry the same call (do NOT add user message again)
            void performApiCall(pendingCall);
          } else {
            // user chose not to resend
            pendingCall = null;
          }
        } else if (mode === "retry") {
          // retry automatically (limited inside performApiCall)
          void performApiCall(pendingCall);
        }
      }
      return;
    }
    render();
  }, 1000);
}

// ===== Render =====
function renderThreadList() {
  elThreadList.innerHTML = "";
  for (const t of threads) {
    const btn = document.createElement("button");
    btn.className = "thread" + (t.id === activeId ? " active" : "");
    btn.type = "button";
    btn.innerHTML = `
      <div class="thread-title">${escapeHtml(t.title || "（無題）")}</div>
      <div class="thread-meta">${escapeHtml((t.messages?.length || 0) + " messages")}</div>
    `;
    btn.addEventListener("click", () => {
      activeId = t.id;
      renderAll();
    });
    elThreadList.appendChild(btn);
  }
}

function renderChat() {
  const t = getActiveThread();
  elChat.innerHTML = "";
  if (!t) return;

  for (const m of (t.messages || [])) {
    const isUser = (m.role === "user");

    const row = document.createElement("div");
    row.className = "msg-row " + (isUser ? "user" : "assistant");

    // avatar
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    if (!isUser) {
      const img = document.createElement("img");
      img.alt = "bot";
      img.src = BOT_AVATAR_SRC;
      img.loading = "lazy";
      avatar.appendChild(img);
    } else {
      // User avatar is optional; keep a simple fallback label
      const span = document.createElement("span");
      span.className = "avatar-fallback";
      span.textContent = "YOU";
      avatar.appendChild(span);
    }

    // bubble
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.innerHTML = nl2br(m.content || "");

    if (Array.isArray(m.sources) && m.sources.length) {
      const items = m.sources.map(s => {
        const title = s.title ? s.title : s.id;
        const score = (s.score === null || s.score === undefined) ? "" : `（score ${Number(s.score).toFixed(3)}）`;
        return `・${escapeHtml(title)} ${escapeHtml(score)}`;
      }).join("<br>");
      const src = document.createElement("div");
      src.style.marginTop = "10px";
      src.style.color = "var(--muted)";
      src.style.fontSize = "12px";
      src.innerHTML = `<div style="margin-bottom:6px; font-weight:700; color:var(--text)">【参照】</div>${items}`;
      bubble.appendChild(src);
    }

    if (!isUser) row.appendChild(avatar);
    row.appendChild(bubble);
    elChat.appendChild(row);
  }

  elThreadTitle.textContent = t.title || "新しいチャット";
  scrollChatToBottom();
}

function renderAll() {
  if (!activeId) {
    const t = newThread();
    threads.unshift(t);
    activeId = t.id;
    saveThreads(threads);
  }
  renderThreadList();
  renderChat();
}

// ===== API =====
function buildHistoryForApi(t, maxTurns = 10) {
  const msgs = (t.messages || []).slice(-maxTurns);
  return msgs.map(m => ({ role: m.role, content: m.content }));
}

async function callApi(message, threadId, history) {
  const body = { message, thread_id: threadId, history: history || [] };

  // cancel previous in-flight
  stopInFlight();
  currentAbort = new AbortController();

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: currentAbort.signal,
  });

  let data = null;
  try { data = await res.json(); }
  catch { data = { reply: await res.text().catch(() => "") }; }

  if (!res.ok) {
    const msg = data?.reply || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ===== Actions =====
function addMessage(role, content, sources) {
  const t = getActiveThread();
  if (!t) return;

  t.messages = t.messages || [];
  t.messages.push({ role, content, sources: sources || null });
  t.updatedAt = nowIso();

  if (role === "user" && (!t.title || t.title === "新しいチャット")) {
    t.title = (content || "").trim() || "新しいチャット";
  }

  saveThreads(threads);
  renderAll();
}

function isTransientStatus(status) {
  return [502, 503, 504, 520, 522, 524].includes(Number(status));
}

async function performApiCall(call) {
  const t = getActiveThread();
  if (!t) return;

  // If user switched threads, do nothing.
  if (call.threadId !== t.id) {
    pendingCall = null;
    return;
  }

  const tries = Number(call.tries || 0);
  pendingCall = { ...call, tries };

  setSending(true);

  try {
    const history = buildHistoryForApi(t, 10);
    const result = await callApi(call.text, t.id, history);

    const reply = String(result?.reply ?? "").trim();
    const sources = Array.isArray(result?.sources) ? result.sources : [];

    pendingCall = null;

    if (reply) addMessage("assistant", reply, sources);
    else addMessage("assistant", "（応答が空でした）", sources);
  } catch (e) {
    if (e?.name === "AbortError") {
      // aborted (e.g. user sent another message / cooldown)
    } else if (e?.status === 429) {
      const retry = Number(e?.data?.retry_after ?? 20);
      // keep pendingCall, show rate banner
      showBanner({ mode: "rate", seconds: retry });
    } else if (isTransientStatus(e?.status) || e?.message?.includes("Failed to fetch")) {
      // limited retries to avoid infinite loops
      const nextTries = tries + 1;
      if (nextTries >= 3) {
        const msg = (e && e.message) ? e.message : String(e);
        addMessage("assistant", `エラー：${msg}`);
        pendingCall = null;
      } else {
        pendingCall = { ...call, tries: nextTries };
        showBanner({ mode: "retry", seconds: 3 });
      }
    } else {
      const msg = (e && e.message) ? e.message : String(e);
      addMessage("assistant", `エラー：${msg}`);
      pendingCall = null;
    }
  } finally {
    setSending(false);
    if (!rateLocked) elInput.focus();
  }
}

async function sendMessage() {
  const t = getActiveThread();
  if (!t) return;

  if (rateLocked || isSending) return;

  const text = (elInput.value || "").trim();
  if (!text) return;

  // Clear UI input (message is stored in history)
  elInput.value = "";
  elInput.style.height = "auto";

  // Add user message once
  addMessage("user", text);

  // Prepare pending call and execute
  pendingCall = { text, threadId: t.id, tries: 0 };
  await performApiCall(pendingCall);
}

function clearActiveThread() {
  if (!activeId) return;
  threads = threads.filter(t => t.id !== activeId);
  activeId = (threads[0] && threads[0].id) || null;
  saveThreads(threads);
  pendingCall = null;
  clearBanner();
  setStatus("");
  rateLocked = false;
  setSending(false);
  renderAll();
}

function createNewThreadAndSelect() {
  const t = newThread();
  threads.unshift(t);
  activeId = t.id;
  saveThreads(threads);
  pendingCall = null;
  clearBanner();
  setStatus("");
  rateLocked = false;
  setSending(false);
  renderAll();
  elInput.focus();
}

// ===== Events =====
elNewChatBtn.addEventListener("click", createNewThreadAndSelect);
elClearBtn.addEventListener("click", clearActiveThread);
elSendBtn.addEventListener("click", sendMessage);

elInput.addEventListener("keydown", (e) => {
  if (rateLocked || isSending) return;

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendMessage();
  }
});

// Auto-grow textarea (simple)
elInput.addEventListener("input", () => {
  elInput.style.height = "auto";
  elInput.style.height = Math.min(elInput.scrollHeight, 180) + "px";
});

// ===== Boot =====
if (!activeId) createNewThreadAndSelect();
else renderAll();
refreshMetrics();
updateComposerState();