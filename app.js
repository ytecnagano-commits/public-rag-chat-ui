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