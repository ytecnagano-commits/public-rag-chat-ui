"use strict";

// ===== Workers URL =====
const API_URL = "https://public-rag-api.ytec-nagano.workers.dev/chat";

// ===== LocalStorage =====
const LS_KEY = "public_rag_chat_threads_v1";
const nowIso = () => new Date().toISOString();

const $ = (sel) => document.querySelector(sel);

function loadThreads() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
  catch { return []; }
}
function saveThreads(threads) {
  localStorage.setItem(LS_KEY, JSON.stringify(threads));
}
function newThread() {
  return {
    id: crypto.randomUUID(),
    title: "新しいチャット",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: []
  };
}
function pickTitleFromText(text) {
  const t = (text || "").trim().replace(/\s+/g, " ");
  return t.length > 24 ? t.slice(0, 24) + "…" : (t || "新しいチャット");
}

// ===== UI refs =====
let threads = [];
let activeId = null;

const listEl = $("#threadList");
const newBtn = $("#newThreadBtn");
const titleEl = $("#threadTitle");
const clearBtn = $("#clearThreadBtn");
const chatEl = $("#chat");
const inputEl = $("#input");
const sendBtn = $("#sendBtn");

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderThreadList() {
  if (!listEl) return;
  listEl.innerHTML = "";
  threads.forEach((t) => {
    const div = document.createElement("div");
    div.className = "threadItem" + (t.id === activeId ? " active" : "");
    div.innerHTML = `
      <div class="threadTitle">${escapeHtml(t.title)}</div>
      <div class="threadMeta">${escapeHtml((t.messages?.length || 0) + " messages")}</div>
    `;
    div.addEventListener("click", () => {
      activeId = t.id;
      saveThreads(threads);
      renderAll();
    });
    listEl.appendChild(div);
  });
}

function renderChat() {
  if (!chatEl) return;
  const t = threads.find(x => x.id === activeId);
  if (!t) return;

  titleEl && (titleEl.textContent = t.title);

  chatEl.innerHTML = "";
  for (const m of t.messages) {
    const row = document.createElement("div");
    row.className = "msgRow " + (m.role === "user" ? "user" : "assistant");
    row.innerHTML = `
      <div class="msgBubble">
        <div class="msgText">${escapeHtml(m.content).replaceAll("\n", "<br>")}</div>
        ${m.sources?.length ? `
          <div class="msgSources">
            <div class="srcHead">【参照】</div>
            <ul>
              ${m.sources.map(s =>
                `<li>${escapeHtml(s.title || s.id)}（score ${Number(s.score ?? 0).toFixed(3)}）</li>`
              ).join("")}
            </ul>
          </div>` : ""
        }
      </div>
    `;
    chatEl.appendChild(row);
  }
  chatEl.scrollTop = chatEl.scrollHeight;
}

function renderAll() {
  renderThreadList();
  renderChat();
}

function ensureActiveThread() {
  if (!threads.length) {
    const t = newThread();
    threads = [t];
    activeId = t.id;
    saveThreads(threads);
    return;
  }
  if (!activeId || !threads.some(t => t.id === activeId)) {
    activeId = threads[0].id;
  }
}

async function sendMessage() {
  const text = (inputEl?.value || "").trim();
  if (!text) return;

  const t = threads.find(x => x.id === activeId);
  if (!t) return;

  // UI lock
  sendBtn.disabled = true;

  // push user msg
  t.messages.push({ role: "user", content: text, at: nowIso() });
  if (t.messages.length === 1) t.title = pickTitleFromText(text);
  t.updatedAt = nowIso();
  saveThreads(threads);
  renderAll();

  inputEl.value = "";
  inputEl.style.height = "auto";

  try {
    const payload = {
      message: text,
      thread_id: t.id,
      history: t.messages
        .filter(m => m.role === "user" || m.role === "assistant")
        .slice(-12)
        .map(m => ({ role: m.role, content: m.content })),
    };

    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.reply || `HTTP ${res.status}`;
      t.messages.push({ role: "assistant", content: msg, at: nowIso() });
      saveThreads(threads);
      renderAll();
      return;
    }

    const reply = String(data?.reply ?? "");
    const sources = Array.isArray(data?.sources) ? data.sources : [];
    t.messages.push({ role: "assistant", content: reply, sources, at: nowIso() });
    t.updatedAt = nowIso();
    saveThreads(threads);
    renderAll();
  } catch (e) {
    t.messages.push({ role: "assistant", content: `エラー：${e?.message || e}`, at: nowIso() });
    saveThreads(threads);
    renderAll();
  } finally {
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

function bindEvents() {
  newBtn?.addEventListener("click", () => {
    const t = newThread();
    threads.unshift(t);
    activeId = t.id;
    saveThreads(threads);
    renderAll();
    inputEl?.focus();
  });

  clearBtn?.addEventListener("click", () => {
    if (!confirm("この会話を削除しますか？")) return;
    threads = threads.filter(t => t.id !== activeId);
    activeId = threads[0]?.id || null;
    ensureActiveThread();
    saveThreads(threads);
    renderAll();
  });

  sendBtn?.addEventListener("click", sendMessage);

  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // autosize
  inputEl?.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
  });
}

function init() {
  threads = loadThreads();
  ensureActiveThread();
  bindEvents();
  renderAll();
  inputEl?.focus();
}

document.addEventListener("DOMContentLoaded", init);
