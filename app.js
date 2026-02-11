// ===== Config =====
const BOT_AVATAR_SRC = "./bot-avatar.jpg";

// Transient errors that are worth retrying
const TRANSIENT_STATUS = new Set([502, 503, 504, 520, 522, 524]);

// API endpoint (configurable)
const DEFAULT_API_URL = "https://public-rag-api.ytec-nagano.workers.dev/chat";
const LS_API_URL = "public_rag_api_url";
let API_URL = localStorage.getItem(LS_API_URL) || DEFAULT_API_URL;
let METRICS_URL = API_URL.replace(/\/chat$/, "/metrics");
function setApiUrl(url){
  API_URL = url;
  METRICS_URL = API_URL.replace(/\/chat$/, "/metrics");
  localStorage.setItem(LS_API_URL, API_URL);
}

// ===== Storage =====
const LS_KEY = "public_rag_chat_threads_v2";
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

const elApiUrlInput = $("#apiUrlInput");
const elSaveApiUrlBtn = $("#saveApiUrlBtn");

// rate/status
const elRateBanner = $("#rateBanner");
const elRateBannerText = $("#rateBannerText");
const elRateAutoResend = $("#rateAutoResend");
const elStatusLine = $("#statusLine");
const elStatusText = $("#statusText");

// metrics
const elMetricsBucket = $("#metricsBucket");
const elMReq = $("#mReq");
const elMOk = $("#mOk");
const elMRl = $("#mRl");
const elMErr = $("#mErr");
const elMetricsUpdated = $("#metricsUpdated");

// ===== State =====
let threads = loadThreads();
let activeId = (threads[0] && threads[0].id) || null;

let isSending = false;
let rateLocked = false;
let rateTimer = null;

let retryTimer = null;
let retryRemain = 0;
let retryAttemptsLeft = 0;
let retryPayload = null;

let currentAbort = null;

function getActiveThread() {
  return threads.find(t => t.id === activeId) || null;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function nl2br(s) {
  return escapeHtml(s).replace(/\n/g, "<br>");
}

function scrollChatToBottom() {
  elChat.scrollTop = elChat.scrollHeight;
}

// ===== UI state =====
function updateComposerState() {
  const disabled = isSending || rateLocked;
  if (elSendBtn) elSendBtn.disabled = disabled;
  if (elInput) elInput.disabled = disabled;
  if (elSendBtn) elSendBtn.classList.toggle("is-loading", isSending);
}
function setSending(v) {
  isSending = v;
  updateComposerState();
}

// ===== Metrics =====
async function refreshMetricsOnce() {
  if (!elMetricsBucket) return;
  try {
    const res = await fetch(METRICS_URL, { method: "GET" });
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    if (!data?.current) return;

    elMetricsBucket.textContent = data.bucket ?? "-";
    elMReq.textContent = String(data.current.req ?? 0);
    elMOk.textContent  = String(data.current.ok ?? 0);
    elMRl.textContent  = String(data.current.rl ?? 0);
    elMErr.textContent = String(data.current.err ?? 0);
    elMetricsUpdated.textContent = data.updated_at ? new Date(data.updated_at).toLocaleString() : "-";
  } catch {
    // ignore
  }
}
function startMetricsPolling() {
  refreshMetricsOnce();
  setInterval(refreshMetricsOnce, 10000);
}

// ===== Rate limit banner =====
function hideRateBanner() {
  if (!elRateBanner) return;
  elRateBanner.hidden = true;
  if (elRateBannerText) elRateBannerText.textContent = "";
  if (rateTimer) { clearInterval(rateTimer); rateTimer = null; }
}

function showRateBanner(seconds) {
  if (!elRateBanner) return;

  // stop any in-flight request
  try { currentAbort?.abort(); } catch {}

  rateLocked = true;
  updateComposerState();

  if (rateTimer) { clearInterval(rateTimer); rateTimer = null; }

  let remain = Math.max(0, Number(seconds || 20));
  elRateBanner.hidden = false;

  const render = () => {
    if (elRateBannerText) {
      elRateBannerText.textContent = `アクセスが多すぎます。${remain}秒待ってから再試行してください。`;
    }
  };
  render();

  rateTimer = setInterval(() => {
    remain -= 1;
    if (remain <= 0) {
      clearInterval(rateTimer);
      rateTimer = null;
      rateLocked = false;
      updateComposerState();
      hideRateBanner();

      // auto resend if enabled and we have a payload to resend
      const autoResend = !!elRateAutoResend?.checked;
      if (autoResend && retryPayload) {
        // resend the last payload (without adding user message again)
        resendPayload(retryPayload);
      } else {
        elInput?.focus();
      }
      return;
    }
    render();
  }, 1000);
}

// ===== Status line (connecting / retry) =====
function setStatus(text) {
  if (!elStatusLine || !elStatusText) return;
  if (!text) {
    elStatusLine.hidden = true;
    elStatusText.textContent = "";
    return;
  }
  elStatusLine.hidden = false;
  elStatusText.textContent = text;
}

// ===== Thread rendering =====
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

    // bubble
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.innerHTML = nl2br(m.content || "");

    if (Array.isArray(m.sources) && m.sources.length) {
      // Collapsible references (future-proof for multi-layer sources)
      const wrap = document.createElement("div");
      wrap.className = "refs";

      const details = document.createElement("details");
      details.className = "refs-details";
      details.open = false;

      const summary = document.createElement("summary");
      summary.className = "refs-summary";
      summary.textContent = `参照（${m.sources.length}件）`;
      details.appendChild(summary);

      const body = document.createElement("div");
      body.className = "refs-body";

      // Layer 1: Knowledge (Upstash Vector)
      const sec1 = document.createElement("div");
      sec1.className = "refs-section";
      sec1.innerHTML = `<div class="refs-head">ナレッジからの事例</div>`;

      const list1 = document.createElement("div");
      list1.className = "refs-list";

      const items = m.sources.map(s => {
        const title = s.title ? s.title : s.id;
        const score = (s.score === null || s.score === undefined) ? "" : `（score ${Number(s.score).toFixed(3)}）`;
        return `・${escapeHtml(title)} ${escapeHtml(score)}`;
      }).join("<br>");

      list1.innerHTML = items || "（なし）";
      sec1.appendChild(list1);

      // Placeholders for future layers (Wiki / Trusted sites) – we'll add in ⑤
      body.appendChild(sec1);

      details.appendChild(body);
      wrap.appendChild(details);
      bubble.appendChild(wrap);
    }

    if (!isUser) {
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      const img = document.createElement("img");
      img.alt = "bot";
      img.src = BOT_AVATAR_SRC;
      img.loading = "lazy";
      avatar.appendChild(img);
      row.appendChild(avatar);
    }

    row.appendChild(bubble);
    elChat.appendChild(row);
  }

  elThreadTitle.textContent = t.title || "新しいチャット";
  scrollChatToBottom();
}

function renderAll() {
  renderThreadList();
  renderChat();
}

// ===== Message state =====
function ensureActiveThread() {
  if (!activeId) {
    const t = newThread();
    threads.unshift(t);
    activeId = t.id;
    saveThreads(threads);
  }
  return getActiveThread();
}

function addMessage(role, content, sources) {
  const t = ensureActiveThread();
  t.messages = t.messages || [];
  t.messages.push({ role, content, sources: sources || null });
  t.updatedAt = nowIso();

  // title heuristic: first user message becomes full title
  if (role === "user" && (!t.title || t.title === "新しいチャット")) {
    t.title = (content || "").trim() || "新しいチャット";
  }

  saveThreads(threads);
  renderAll();
}

// ===== API =====
async function callApi(message, threadId, history) {
  const body = { message, thread_id: threadId, history: history || [] };

  // abort previous request
  try { currentAbort?.abort(); } catch {}
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
    let msg = data?.reply || `HTTP ${res.status}`;
    if (res.status === 405) msg = "HTTP 405（POSTが許可されていません）: 接続先URLを Workers の /chat に変更してください";
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ===== Retry handling =====
function clearRetry() {
  if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
  retryRemain = 0;
  retryAttemptsLeft = 0;
  retryPayload = null;
  setStatus("");
}

function scheduleRetry(payload, seconds, attemptsLeft) {
  // payload is: { threadId, message, history }
  retryPayload = payload;
  retryRemain = seconds;
  retryAttemptsLeft = attemptsLeft;

  setStatus(`再試行まで ${retryRemain}秒…`);

  if (retryTimer) clearInterval(retryTimer);
  retryTimer = setInterval(() => {
    retryRemain -= 1;
    if (retryRemain <= 0) {
      clearInterval(retryTimer);
      retryTimer = null;
      setStatus("再試行中…");
      resendPayload(payload);
      return;
    }
    setStatus(`再試行まで ${retryRemain}秒…`);
  }, 1000);
}

async function resendPayload(payload) {
  if (!payload) return;
  const t = getActiveThread();
  const threadId = payload.threadId || t?.id;

  try {
    setSending(true);
    setStatus("接続中…");
    const data = await callApi(payload.message, threadId, payload.history);
    setStatus("");
    clearRetry();

    // add assistant response
    addMessage("assistant", data.reply || "（応答が空です）", data.sources || null);
  } catch (e) {
    if (e?.name === "AbortError") {
      // ignore
    } else if (e?.status === 429) {
      // rate limit -> show banner and let banner decide resend
      const retry = Number(e?.data?.retry_after ?? 20);
      showRateBanner(retry);
    } else if (TRANSIENT_STATUS.has(Number(e?.status)) && retryAttemptsLeft > 0) {
      // schedule another retry
      scheduleRetry(payload, 3, retryAttemptsLeft - 1);
    } else {
      setStatus("");
      clearRetry();
      addMessage("assistant", `エラー：${e?.message || e}`);
    }
  } finally {
    setSending(false);
    if (!rateLocked) elInput?.focus();
  }
}

// ===== Send message =====
async function sendMessage() {
  if (rateLocked) return;

  const t = ensureActiveThread();
  const text = (elInput.value || "").trim();
  if (!text) return;

  // reset transient retry state for this new message
  clearRetry();

  // build history (simple: last 6 messages)
  const history = (t.messages || []).slice(-6).map(m => ({ role: m.role, content: m.content }));

  // add user message immediately
  addMessage("user", text);

  elInput.value = "";
  elInput.style.height = "auto";

  const payload = { threadId: t.id, message: text, history };

  try {
    setSending(true);
    setStatus("接続中…");
    const data = await callApi(text, t.id, history);
    setStatus("");
    // add assistant response
    addMessage("assistant", data.reply || "（応答が空です）", data.sources || null);
  } catch (e) {
    if (e?.name === "AbortError") {
      // ignore
    } else if (e?.status === 429) {
      const retry = Number(e?.data?.retry_after ?? 20);
      // store payload for potential auto resend
      retryPayload = payload;
      showRateBanner(retry);
    } else if (TRANSIENT_STATUS.has(Number(e?.status))) {
      // schedule up to 2 retries
      scheduleRetry(payload, 3, 2);
    } else {
      setStatus("");
      addMessage("assistant", `エラー：${e?.message || e}`);
    }
  } finally {
    setSending(false);
    if (!rateLocked) elInput?.focus();
  }
}

// ===== Events =====
function autosizeTextarea() {
  elInput.style.height = "auto";
  elInput.style.height = Math.min(elInput.scrollHeight, 220) + "px";
}

elInput?.addEventListener("input", autosizeTextarea);

elInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

elSendBtn?.addEventListener("click", () => sendMessage());

elNewChatBtn?.addEventListener("click", () => {
  const t = newThread();
  threads.unshift(t);
  activeId = t.id;
  saveThreads(threads);
  hideRateBanner();
  clearRetry();
  renderAll();
  elInput?.focus();
});

elClearBtn?.addEventListener("click", () => {
  const t = getActiveThread();
  if (!t) return;
  t.messages = [];
  t.title = "新しいチャット";
  t.updatedAt = nowIso();
  saveThreads(threads);
  hideRateBanner();
  clearRetry();
  renderAll();
});

// ===== Init =====
(function init() {
  if (!threads.length) {
    const t = newThread();
    threads = [t];
    activeId = t.id;
    saveThreads(threads);
  }
  renderAll();

    // init API URL input (admin-only UI)
  const isAdmin = new URLSearchParams(location.search).get("admin") === "1"
    || localStorage.getItem("showApiConfig") === "1";

  const elApiWrap = document.querySelector("#apiConfigWrap");
  const elToggleApi = document.querySelector("#toggleApiConfigBtn");

  if (elToggleApi) elToggleApi.hidden = !isAdmin;
  if (elApiWrap) elApiWrap.hidden = !isAdmin;

  if (elApiUrlInput) elApiUrlInput.value = API_URL;

  elToggleApi?.addEventListener("click", () => {
    const next = !(elApiWrap && !elApiWrap.hidden);
    if (elApiWrap) elApiWrap.hidden = !next;
    localStorage.setItem("showApiConfig", next ? "1" : "0");
  });

  elSaveApiUrlBtn?.addEventListener("click", () => {
    const v = (elApiUrlInput?.value || "").trim();
    if (!v) return;
    setApiUrl(v);
    refreshMetricsOnce();
  });
startMetricsPolling();
  elInput?.focus();
})();
