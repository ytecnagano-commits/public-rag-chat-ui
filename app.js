// ===== Config =====
const API_URL = "https://public-rag-api.ytec-nagano.workers.dev/chat";

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
const elRateBanner  = $("#rateBanner");

// ===== State =====
let threads = loadThreads();
let activeId = (threads[0] && threads[0].id) || null;

// sending / rate limit state
let isSending = false;
let rateLocked = false;
let rateTimer = null;
let currentAbort = null;

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
  // chat is a section; scroll within page
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
  updateComposerState();
}

function showRateBanner(seconds) {
  if (!elRateBanner) return;

  // lock composer
  rateLocked = true;
  updateComposerState();

  // stop in-flight request (prevents late replies during cooldown)
  try { currentAbort?.abort(); } catch {}

  if (rateTimer) clearInterval(rateTimer);

  let remain = Math.max(0, Number(seconds || 20));
  elRateBanner.hidden = false;

  const render = () => {
    elRateBanner.textContent = `アクセスが多すぎます。${remain}秒待ってから再試行してください。`;
  };
  render();

  rateTimer = setInterval(() => {
    remain -= 1;
    if (remain <= 0) {
      clearInterval(rateTimer);
      rateTimer = null;
      elRateBanner.hidden = true;
      elRateBanner.textContent = "";
      rateLocked = false;
      updateComposerState();
      elInput.focus();
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
    btn.className = "thread-item" + (t.id === activeId ? " active" : "");
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
    const row = document.createElement("div");
    row.className = "msg-row " + (m.role === "user" ? "user" : "assistant");

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";

    // main content
    bubble.innerHTML = nl2br(m.content || "");

    // sources (optional)
    if (Array.isArray(m.sources) && m.sources.length) {
      const src = document.createElement("div");
      src.className = "sources";
      const items = m.sources.map(s => {
        const title = s.title ? s.title : s.id;
        const score = (s.score === null || s.score === undefined) ? "" : `（score ${Number(s.score).toFixed(3)}）`;
        return `・${escapeHtml(title)} ${escapeHtml(score)}`;
      }).join("<br>");
      src.innerHTML = `<div class="sources-title">【参照】</div>${items}`;
      bubble.appendChild(src);
    }

    row.appendChild(bubble);
    elChat.appendChild(row);
  }

  // update title
  elThreadTitle.textContent = t.title || "新しいチャット";

  // scroll
  scrollChatToBottom();
}

function renderAll() {
  // ensure active
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
function buildHistoryForApi(t, maxTurns = 8) {
  const msgs = (t.messages || []).slice(-maxTurns);
  // Convert to OpenAI-style chat history (role/content)
  return msgs.map(m => ({ role: m.role, content: m.content }));
}

async function callApi(message, threadId, history) {
  const body = {
    message,
    thread_id: threadId,
    history: history || []
  };

  // Abort previous request if any
  try { currentAbort?.abort(); } catch {}
  currentAbort = new AbortController();

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: currentAbort.signal
  });

  // Try to parse JSON always
  let data = null;
  try { data = await res.json(); } catch { data = { reply: await res.text().catch(() => "") }; }

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

  // title heuristic: first user message becomes title
  if (role === "user" && (!t.title || t.title === "新しいチャット")) {
    t.title = (content || "").slice(0, 18).trim() || "新しいチャット";
  }

  saveThreads(threads);
  renderAll();
}

async function sendMessage() {
  const t = getActiveThread();
  if (!t) return;

  // During cooldown, do nothing
  if (rateLocked) return;

  const text = (elInput.value || "").trim();
  if (!text) return;

  elInput.value = "";
  addMessage("user", text);

  setSending(true);
  try {
    const history = buildHistoryForApi(t, 10);
    const result = await callApi(text, t.id, history);

    const reply = String(result?.reply ?? "").trim();
    const sources = Array.isArray(result?.sources) ? result.sources : [];

    if (reply) addMessage("assistant", reply, sources);
    else addMessage("assistant", "（応答が空でした）", sources);
  } catch (e) {
    if (e?.name === "AbortError") {
      // do nothing
    } else if (e?.status === 429) {
      const retry = Number(e?.data?.retry_after ?? 20);
      showRateBanner(retry);
    } else {
      const msg = (e && e.message) ? e.message : String(e);
      addMessage("assistant", `エラー：${msg}`);
    }
  } finally {
    setSending(false);
    if (!rateLocked) elInput.focus();
  }
}

function clearActiveThread() {
  if (!activeId) return;
  threads = threads.filter(t => t.id !== activeId);
  activeId = (threads[0] && threads[0].id) || null;
  saveThreads(threads);
  renderAll();
}

function createNewThreadAndSelect() {
  const t = newThread();
  threads.unshift(t);
  activeId = t.id;
  saveThreads(threads);
  renderAll();
  elInput.focus();
}

// ===== Events =====
elNewChatBtn.addEventListener("click", createNewThreadAndSelect);
elClearBtn.addEventListener("click", clearActiveThread);
elSendBtn.addEventListener("click", sendMessage);

elInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
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
