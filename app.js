// ===== Config =====
const BOT_AVATAR_SRC = "./bot-avatar.jpg";

const WELCOME_MESSAGE = `こんにちは！Y-TEC トラブル解決BOT【ワイテッくん】だよ。
役に立ったり立たなかったりするよ！

【使い方】
- 症状を1文で（例：Wi‑Fiがつながらない）
- 機種/OS（例：Windows 11 / iPhone 15）
- 直前にやったこと（更新/設定変更/ソフト導入など）
- エラーメッセージ（あればそのまま）

【注意】
- 分解作業を行うときには静電気等での機器破損や手が滑っての怪我にはくれぐれも注意してね。
- バッテリー膨張や感電のおそれがある水濡れ等は作業時に危険が伴うので絶対に無理はしないでね。
- 法律・電気工事などは一般案内になるので、必要なら専門家へ確認してね。
- パスワード/個人情報は絶対に送っちゃダメだよ！
- 僕はAIなので、起こっているトラブルを直接診断しているわけではなく、過去の事例から情報を提供しているだけだよ。
- AIの特性上、ハルシネーションを起こしてウソをついたり、関係のない情報を提示するかもしれないので自己責任で利用してね。`;

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
    messages: [{ role: "assistant", content: WELCOME_MESSAGE, sources: null }]
  };
}

function ensureWelcomeMessage(thread) {
  if (!thread) return;
  thread.messages = thread.messages || [];
  if (thread.messages.length === 0) {
    thread.messages.push({ role: "assistant", content: WELCOME_MESSAGE, sources: null });
    thread.updatedAt = nowIso();
    saveThreads(threads);
  }
}

// ===== DOM =====
const $ = (sel) => document.querySelector(sel);

const elThreadList = $("#threadList");
const elNewChatBtn  = $("#newChatBtn");
const elClearBtn    = $("#clearBtn");
const elCopyBtn     = $("#copyBtn");
const elDownloadBtn = $("#downloadBtn");
const elThreadTitle = $("#threadTitle");
const elChat        = $("#chat");
const elInput       = $("#input");
const elSendBtn     = $("#sendBtn");

const elMenuBtn     = $("#menuBtn");
const elSidebar     = document.querySelector(".sidebar");
const elBackdrop    = $("#sidebarBackdrop");

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

function formatMessageHtml(text) {
  const escaped = escapeHtml(text || "");

  // Preserve markdown links like: [label](https://example.com)
  const stash = [];
  let tmp = escaped.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => {
    const token = `__MDLINK_${stash.length}__`;
    stash.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    return token;
  });

  // Linkify bare URLs
  tmp = tmp.replace(/https?:\/\/[^\s<>"]+/g, (raw) => {
    let url = raw;
    let trail = '';
    // Trim common trailing punctuation (including Japanese)
    while (url && /[\]\)\}\>、。．，\.\!\?\;\:」』】）》]+$/.test(url)) {
      trail = url.slice(-1) + trail;
      url = url.slice(0, -1);
    }
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
  });

  // Restore markdown anchors
  for (let i = 0; i < stash.length; i++) {
    const token = `__MDLINK_${i}__`;
    tmp = tmp.split(token).join(stash[i]);
  }

  return tmp.replace(/\n/g, '<br>');
}



function exportThreadMarkdown(t){
  const lines = [];
  lines.push(`# ${t.title || "新しいチャット"}`);
  lines.push("");
  for (const m of (t.messages || [])) {
    const who = (m.role === "user") ? "ユーザー" : "ワイテッくん";
    lines.push(`## ${who}`);
    lines.push(m.content || "");
    if (Array.isArray(m.sources) && m.sources.length) {
      lines.push("");
      lines.push("### 参照（ナレッジからの事例）");
      for (const s of m.sources) {
        const title = s.title ? s.title : s.id;
        const score = (s.score === null || s.score === undefined) ? "" : ` (score ${Number(s.score).toFixed(3)})`;
        lines.push(`- ${title}${score}`);
      }
    }
    lines.push("");
  }
  lines.push("---");
  lines.push(`exported_at: ${new Date().toISOString()}`);
  return lines.join("\n");
}

async function copyToClipboard(text){
  try{
    await navigator.clipboard.writeText(text);
    return true;
  }catch{
    return false;
  }
}

function showCopyModal(text){
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-card">
      <div class="modal-head">
        <div class="modal-title">コピー用テキスト</div>
        <button class="modal-close btn btn-ghost" type="button">×</button>
      </div>
      <textarea class="modal-text" spellcheck="false"></textarea>
      <div class="modal-actions">
        <button class="btn btn-primary modal-select" type="button">全選択</button>
        <button class="btn btn-ghost modal-ok" type="button">閉じる</button>
      </div>
      <div class="modal-note">※ブラウザが自動コピーをブロックしたので、ここから手動でコピーしてください。</div>
    </div>
  `;
  modal.querySelector(".modal-text").value = text;
  const close = () => modal.remove();
  modal.querySelector(".modal-backdrop").addEventListener("click", close);
  modal.querySelector(".modal-close").addEventListener("click", close);
  modal.querySelector(".modal-ok").addEventListener("click", close);
  modal.querySelector(".modal-select").addEventListener("click", () => {
    const ta = modal.querySelector(".modal-text");
    ta.focus();
    ta.select();
  });
  document.body.appendChild(modal);
}

function downloadJsonFile(filename, obj){
  const text = JSON.stringify(obj, null, 2);
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
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
      <div class="thread-main">
        <div class="thread-title">${escapeHtml(t.title || "（無題）")}</div>
        <div class="thread-meta">${escapeHtml((t.messages?.length || 0) + " messages")}</div>
      </div>
      <button class="thread-del" type="button" title="削除">×</button>
    `;
    btn.querySelector(".thread-del")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!confirm("このチャット履歴を削除しますか？（このブラウザ内のデータです）")) return;
      const idx = threads.findIndex(x => x.id === t.id);
      if (idx >= 0) threads.splice(idx, 1);

      if (activeId === t.id) {
        activeId = (threads[0] && threads[0].id) || null;
        if (!activeId) {
          const nt = newThread();
          threads = [nt];
          activeId = nt.id;
        }
      }
      saveThreads(threads);
      renderAll();
  ensureWelcomeMessage(getActiveThread());

  // Mobile: sidebar drawer
  elMenuBtn?.addEventListener("click", () => {
    const open = elSidebar?.classList.contains("open");
    setSidebarOpen(!open);
  });
  elBackdrop?.addEventListener("click", () => setSidebarOpen(false));
  window.addEventListener("resize", () => { if (!isMobileLayout()) setSidebarOpen(false); });
    });

    btn.addEventListener("click", () => {
      activeId = t.id;
      renderAll();
      if (isMobileLayout()) setSidebarOpen(false);
    });
    elThreadList.appendChild(btn);
  }
}

function renderChat() {
  const t = getActiveThread();
  elChat.innerHTML = "";
  if (!t) return;
  ensureWelcomeMessage(t);

  for (const m of (t.messages || [])) {
    const isUser = (m.role === "user");

    const row = document.createElement("div");
    row.className = "msg-row " + (isUser ? "user" : "assistant");

    // bubble
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.innerHTML = formatMessageHtml(m.content || "");

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
  t.messages = [{ role: "assistant", content: WELCOME_MESSAGE, sources: null }];
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
  const isAdmin = new URLSearchParams(location.search).get("admin") === "1";

  const elApiWrap = document.querySelector("#apiConfigWrap");
  const elToggleApi = document.querySelector("#toggleApiConfigBtn");
  const elAdminMetrics = document.querySelector("#adminMetricsWrap");

  const showApiConfig = isAdmin && localStorage.getItem("showApiConfig") === "1";
  if (elToggleApi) elToggleApi.hidden = !isAdmin;
  if (elApiWrap) elApiWrap.hidden = !showApiConfig;
  if (elAdminMetrics) elAdminMetrics.hidden = !isAdmin;

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




function showToast(message, ms = 1600){
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  // force reflow then show
  void el.offsetHeight;
  el.classList.add("show");
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, ms);
}

function genId(prefix="t"){
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2,10)}`;
}

function normalizeMessage(m){
  if (!m || typeof m !== "object") return null;
  const role = (m.role === "user" || m.role === "assistant") ? m.role : (m.role ? String(m.role) : "assistant");
  const content = (m.content ?? m.text ?? "");
  const msg = { role, content: String(content) };
  if (m.time) msg.time = m.time;
  if (Array.isArray(m.sources)) msg.sources = m.sources;
  return msg;
}

function normalizeThread(t){
  if (!t || typeof t !== "object") return null;
  const messagesRaw = Array.isArray(t.messages) ? t.messages : Array.isArray(t.chat) ? t.chat : [];
  const messages = messagesRaw.map(normalizeMessage).filter(Boolean);
  if (!messages.length) return null;

  const title = String(t.title || t.name || "取込チャット");
  return {
    id: genId("imp"),
    title,
    messages,
    createdAt: t.createdAt || Date.now(),
  };
}

function importThreadsFromJson(data){
  const list = [];
  if (Array.isArray(data)) list.push(...data);
  else if (data && typeof data === "object") {
    if (Array.isArray(data.threads)) list.push(...data.threads);
    else if (Array.isArray(data.data)) list.push(...data.data);
    else list.push(data);
  }

  let added = 0;
  for (const item of list) {
    const nt = normalizeThread(item);
    if (!nt) continue;
    threads.unshift(nt);
    added++;
  }
  if (added > 0){
    activeId = threads[0].id;
    saveThreads(threads);
  }
  return { count: added };
}

function bindTopbarActions(){
  const copyBtn = document.getElementById("copyBtn");
  const dlBtn = document.getElementById("downloadBtn");
  const clearBtn = document.getElementById("clearBtn");

    const importBtn = document.getElementById("importBtn");
  const importFileInput = document.getElementById("importFileInput");
copyBtn?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    const t = getActiveThread?.() || null;
    if (!t) return;
    const md = exportThreadMarkdown(t);
    const ok = await copyToClipboard(md);
    if (ok) { showToast("コピーしました"); } else { showCopyModal(md); }
  });

  dlBtn?.addEventListener("click", (ev) => {
    ev.preventDefault();
    const menu = document.getElementById("downloadMenu");
    if (!menu) {
      // フォールバック：メニューが無い場合はJSONをDL
      const t = getActiveThread?.() || null;
      if (!t) return;
      const safeTitle = (t.title || "chat").replace(/[\/:*?"<>|]+/g, "_").slice(0, 80);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadJsonFile(`ytec_${safeTitle}_${stamp}.json`, t);
      showToast?.("ダウンロードしました");
      return;
    }
    menu.hidden = !menu.hidden;
  });

  // close menu when clicking outside
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("downloadMenu");
    if (!menu) return;
    const btn = document.getElementById("downloadBtn");
    if (menu.hidden) return;
    const within = menu.contains(e.target) || btn?.contains(e.target);
    if (!within) menu.hidden = true;
  }, { capture: true });

  // handle menu item click
  document.getElementById("downloadMenu")?.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const fmt = target.getAttribute("data-dl");
    if (!fmt) return;
    ev.preventDefault();

    const t = getActiveThread?.() || null;
    if (!t) return;

    const safeTitle = (t.title || "chat").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    if (fmt === "json") {
      downloadJsonFile(`ytec_${safeTitle}_${stamp}.json`, t);
    } else if (fmt === "txt") {
      const md = exportThreadMarkdown(t);
      downloadTextFile(`ytec_${safeTitle}_${stamp}.txt`, md);
    } else if (fmt === "csv") {
      const csv = exportThreadCsv(t);
      downloadCsvFile(`ytec_${safeTitle}_${stamp}.csv`, csv);
    }

    const menu = document.getElementById("downloadMenu");
    if (menu) menu.hidden = true;
    showToast?.("ダウンロードしました");
  });

  clearBtn?.addEventListener("click", (ev) => {
    ev.preventDefault();
    clearActiveThread?.();
  });

  importBtn?.addEventListener("click", (ev) => {
    ev.preventDefault();
    if (!importFileInput) {
      showToast?.("取込UIが見つかりません");
      return;
    }
    importFileInput.value = "";
    importFileInput.click();
  });

  importFileInput?.addEventListener("change", async () => {
    const files = Array.from(importFileInput.files || []);
    if (!files.length) return;

    let totalImported = 0;
    let failed = 0;

    for (const file of files) {
      try{
        const text = await file.text();
        const data = JSON.parse(text);
        const res = importThreadsFromJson(data);
        totalImported += (res.count || 0);
      }catch(err){
        console.error("import failed:", file?.name, err);
        failed += 1;
      }
    }

    if (totalImported > 0){
      const msg = failed > 0
        ? `取込しました（${totalImported}件） / 失敗 ${failed}件`
        : `取込しました（${totalImported}件）`;
      showToast?.(msg);
      renderAll();
    } else {
      showToast?.(failed > 0 ? `取込できませんでした（失敗 ${failed}件）` : "取込できる会話がありません");
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindTopbarActions();
});


function downloadTextFile(filename, text, mime = "text/plain;charset=utf-8"){
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}


function downloadCsvFile(filename, csvText){
  // Excel対策：UTF-8 BOM + CRLF
  const bom = "\ufeff";
  downloadTextFile(filename, bom + csvText, "text/csv;charset=utf-8");
}

function csvEscape(v){
  const s = String(v ?? "");
  // escape double quotes by doubling
  const t = s.replace(/"/g, '""');
  return `"${t}"`;
}

function exportThreadCsv(thread){
  // Columns: idx, role, content, timeISO
  const rows = [];
  rows.push(["idx","role","content","timeISO"]);
  (thread.messages || []).forEach((m, i) => {
    const timeISO = m.time ? new Date(m.time).toISOString() : "";
    rows.push([String(i+1), m.role || "", m.content || "", timeISO]);
  });
  return rows.map(r => r.map(csvEscape).join(",")).join("\\r\\n");
}

function getActiveThread(){
  // relies on activeId + threads in scope; defined in original app.js
  try{
    return (threads || []).find(t => t.id === activeId) || null;
  }catch{
    return null;
  }
}

function clearActiveThread(){
  if (!confirm("この会話を削除しますか？（このブラウザ内のデータです）")) return;
  const idx = threads.findIndex(t => t.id === activeId);
  if (idx >= 0) threads.splice(idx, 1);
  if (!threads.length){
    const nt = newThread();
    threads = [nt];
    activeId = nt.id;
  }else{
    activeId = threads[0].id;
  }
  saveThreads(threads);
  renderAll();
}function isMobileLayout() {
  return window.matchMedia && window.matchMedia("(max-width: 900px)").matches;
}

function setSidebarOpen(open) {
  if (!elSidebar || !elBackdrop) return;
  if (open) {
    elSidebar.classList.add("open");
    elBackdrop.hidden = false;
  } else {
    elSidebar.classList.remove("open");
    elBackdrop.hidden = true;
  }
}





// v21: enforce mobile title truncation (simple & reliable)
function applyMobileTitleTruncate(){
  const el = document.getElementById("threadTitle");
  if(!el) return;
  const raw = el.getAttribute("data-full-title") || el.textContent || "";
  el.setAttribute("data-full-title", raw);
  if(window.matchMedia && window.matchMedia("(max-width: 900px)").matches){
    el.textContent = raw.length > 5 ? raw.slice(0,5) + "…" : raw;
  } else {
    el.textContent = raw;
  }
}

window.addEventListener("resize", applyMobileTitleTruncate);
document.addEventListener("DOMContentLoaded", ()=>{
  setTimeout(applyMobileTitleTruncate, 0);
});
