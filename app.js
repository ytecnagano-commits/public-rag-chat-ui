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

if (!chatEl || !inputEl || !sendBtn || !threadListEl || !threadTitleEl) {
  console.error("Missing required DOM elements. Check element IDs in index.html.");
}

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
if (newChatBtn) newChatBtn.onclick = () => {
  const t = newThread();
  threads.unshift(t);
  activeId = t.id;
  saveThreads(threads);
  renderAll();
};
if (clearBtn) clearBtn.onclick = () => {
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

// ===== Turnstile token getter (hybrid) =====
function getTurnstileToken() {
  // ① callback保持
  if (TURNSTILE_TOKEN) return TURNSTILE_TOKEN;

  // ② hidden field fallback
  const el =
    document.querySelector('input[name="cf-turnstile-response"]') ||
    document.querySelector('textarea[name="cf-turnstile-response"]');
  const v = el ? (el.value || "") : "";
  return v;
}

function waitForTurnstileToken(timeoutMs = 3000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const t = getTurnstileToken();
      if (t) return resolve(t);
      if (Date.now() - start > timeoutMs) return reject(new Error("Turnstile token timeout"));
      setTimeout(tick, 80);
    };
    tick();
  });
}


// reset policies
function resetTurnstileSoft() {
  // 成功時：トークンだけ空に（UIのwidgetは触らない）
  TURNSTILE_TOKEN = "";
}
function resetTurnstileHard() {
  // 失敗時：widgetをリセットして取り直す
  TURNSTILE_TOKEN = "";
  if (window.turnstile && typeof window.turnstile.reset === "function") {
    try { window.turnstile.reset(); } catch { /* ignore */ }
  }
}

/**
 * Returns:
 * { reply: string, sources: Array<{id?:string, title?:string, score?:number}> }
 */
async function callApi(userText, token) {
  const t = threads.find(x => x.id === activeId);

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

let SENDING = false;

async function send() {
  if (SENDING) return; // 連打防止（token取り直し前の空送信を防ぐ）
  const text = inputEl.value.trim();
  if (!text) return;

  const token = getTurnstileToken();
  if (!token) {
    addMessage("assistant", "Turnstileトークンが取得できていません。成功表示を待ってから送信してください。");
    return;
  }

  SENDING = true;
  sendBtn.disabled = true;

  inputEl.value = "";
  autosize();

  addMessage("user", text);
  addMessage("assistant", "…");

  const t = threads.find(x => x.id === activeId);
  const idx = t.messages.length - 1;

  let ok = false;

  try {
    const result = await callApi(text, token);
    ok = true;

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
    // 成功/失敗どちらでも次のトークンを取り直す（使い回し・空白時間を避ける）
    resetTurnstileHard();

    SENDING = false;

    // 取り直し中の連打を防ぐ（トークンが入るまで送信ボタンを無効化）
    sendBtn.disabled = true;
    waitForTurnstileToken(3000)
      .catch(() => null)
      .finally(() => {
        sendBtn.disabled = false;
      });
  }
}
