// ===== 設定（あとでWorkers URLに差し替え）=====
const API_URL = ""; // 例: "https://public-rag-api.xxx.workers.dev/chat"

// ===== 簡易ストレージ（ブラウザ内）=====
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

// ===== UI描画 =====
function renderThreads() {
  threadListEl.innerHTML = "";
  const sorted = [...threads].sort((a,b) => (b.updatedAt > a.updatedAt ? 1 : -1));
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

// ===== 入力の自動高さ調整 =====
function autosize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
}
inputEl.addEventListener("input", autosize);
autosize();

// Enter送信（Shift+Enterで改行）
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

  // タイトル自動生成（最初のユーザー発言から）
  if (t.messages.length === 1 && role === "user") {
    t.title = content.slice(0, 18) + (content.length > 18 ? "…" : "");
  }

  saveThreads(threads);
  renderAll();
}

async function callApi(userText) {
  // Workersがまだ無い間はダミー応答
  if (!API_URL) {
    await new Promise(r => setTimeout(r, 400));
    return `（ダミー）受け取りました：\n${userText}\n\n次はWorkers APIに接続します。`;
  }

  const t = threads.find(x => x.id === activeId);
  const payload = {
    message: userText,
    thread_id: activeId,
    history: (t?.messages || []).slice(-10) // 直近だけ送る
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`API error: ${res.status} ${txt}`);
  }
  const data = await res.json();
  return data.reply ?? data.message ?? JSON.stringify(data);
}

async function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  autosize();

  addMessage("user", text);
  addMessage("assistant", "…"); // 一時表示

  // 最後のassistantを置き換える
  const t = threads.find(x => x.id === activeId);
  const idx = t.messages.length - 1;

  try {
    const reply = await callApi(text);
    t.messages[idx].content = reply;
    t.updatedAt = nowIso();
    saveThreads(threads);
    renderAll();
  } catch (e) {
    t.messages[idx].content = `エラー：${e.message}`;
    t.updatedAt = nowIso();
    saveThreads(threads);
    renderAll();
  }
}
