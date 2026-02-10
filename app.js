// ===== Config =====
const API_URL = "https://public-rag-api.ytec-nagano.workers.dev/chat";

// ===== Turnstile token holder =====
let TURNSTILE_TOKEN = "";

window.onTurnstileSuccess = function (token) {
  TURNSTILE_TOKEN = token || "";
};
window.onTurnstileExpired = function () {
  TURNSTILE_TOKEN = "";
};
window.onTurnstileError = function () {
  TURNSTILE_TOKEN = "";
};

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
    id: crypto.randomUUID(),
    title: "新しいチャット",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: []
  };
}

let threads = loadThreads();
if (!threads.length) {
  threads = [newThread()];
  saveThreads(threads);
}
let activeId = threads[0].id;

// ===== DOM =====
const chatEl = document.getElementById("chat");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");
const newChatBtn = document.getElementById("newChatBtn");
const clearBtn = document.getElementById("clearBtn");
const threadListEl = document.getElementById("threadList");
const threadTitleEl = document.getElementById("threadTitle");

// ===== Render =====
function renderThreads() {
  threadListEl.innerHTML = "";
  const sorted = [...threads].sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
  for (const t of sorted) {
    const div = document.createElement("div");
    div.className = "thread" + (t.id === activeId ? " active" : "");
    div.onclick = () => { activeId = t.id; renderAll(); };

    const title = document.createElement("div");
    title.className = "thread-title";
    title.textContent = t.title || "チャット";

    const meta = document.createElement("div");
    meta.className = "thread-meta";
    meta.textContent = `${t.messages.length} messages`;

    div.appendChild(title);
    div.appendChild(meta);
    threadListEl.appendChild(div);
  }
}

function renderChat() {
  const t = threads.find(x => x.id === activeId);
  threadTitleEl.textContent = t?.title || "チャット";

  chatEl.innerHTML = "";
  for (const m of (t?.messages || [])) {
    const bubble = document.createElement("div");
    bubble.className = "msg " + (m.role === "user" ? "user" : "assistant");
    bubble.textContent = m.content;
    chatEl.appendChild(bubble);
  }
  chatEl.scrollTop = chatEl.scrollHeight;
}

function renderAll() {
  renderThreads();
  renderChat();
}
renderAll();

// ===== Autosize input =====
function autosize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
}
inputEl.addEventListener("input", autosize);
autosize();

// Enter to send (Shift+Enter = newline)
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

sendBtn.onclick = send;
newChatBtn.onclick = () => {
  const t = newThread();
  threads.unshift(t);
  activeId = t.id;
  saveThreads(threads);
  renderAll();
};
clearBtn.onclick = () => {
  const t = threads.find(x => x.id === activeId);
  if (!t) return;
  t.messages = [];
  t.title = "新しいチャット";
  t.updatedAt = nowIso();
  saveThreads(threads);
  renderAll();
};

function addMessage(role, content) {
  const t = threads.find(x => x.id === activeId);
  if (!t) return;

  t.messages.push({ role, content, at: nowIso() });
  t.updatedAt = nowIso();

  if (t.messages.length === 1 && role === "user") {
    t.title = content.slice(0, 18) + (content.length > 18 ? "…" : "");
  }

  saveThreads(threads);
  renderAll();
}

function getTurnstileToken() {
  // ① callbackで保持しているtoken（最優先）
  if (TURNSTILE_TOKEN) return TURNSTILE_TOKEN;

  // ② hidden field からも拾う（Turnstileの描画方式差異対策）
  const el =
    document.querySelector('input[name="cf-turnstile-response"]') ||
    document.querySelector('textarea[name="cf-turnstile-response"]');
  const v = el ? (el.value || "") : "";
  return v;
}

function resetTurnstile() {
  if (window.turnstile && typeof window.turnstile.reset === "function") {
    try { window.turnstile.reset(); } catch { /* ignore */ }
  }
  TURNSTILE_TOKEN = "";
}

async function callApi(userText) {
  const t = threads.find(x => x.id === activeId);
  const token = getTurnstileToken();

  const payload = {
    message: userText,
    thread_id: activeId,
    history: (t?.messages || []).slice(-10),
    turnstileToken: token
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.reply || `API error: ${res.status}`);

  return {
    reply: data.reply ?? "",
    sources: Array.isArray(data.sources) ? data.sources : []
  };
}

async function send() {
  const text = inputEl.value.trim();
  if (!text) return;

  // 送信直前にtokenを必ず読む
  const token = getTurnstileToken();
  if (!token) {
    addMessage("assistant", "Turnstileトークンが取得できていません。ページを再読み込みして、成功表示後に送信してください。");
    return;
  }

  inputEl.value = "";
  autosize();

  addMessage("user", text);
  addMessage("assistant", `…\n（debug: turnstileToken length=${token.length}）`);

  const t = threads.find(x => x.id === activeId);
  const idx = t.messages.length - 1;

  try {
    const result = await callApi(text);
    const replyText = result.reply ?? "";
    const sources = result.sources ?? [];

    let appended = replyText;
    if (sources.length) {
      appended += `\n\n【参照】`;
      for (const s of sources.slice(0, 5)) {
        const title = s.title || s.id || "source";
        const score = (typeof s.score === "number") ? `（score ${s.score.toFixed(3)}）` : "";
        appended += `\n・${title}${score}`;
      }
    }

    t.messages[idx].content = appended;
    t.updatedAt = nowIso();
    saveThreads(threads);
    renderAll();
  } catch (e) {
    t.messages[idx].content = `エラー：${e.message}`;
    t.updatedAt = nowIso();
    saveThreads(threads);
    renderAll();
  } finally {
    // 送信後にreset（送信前に消さない）
    resetTurnstile();
  }
}
