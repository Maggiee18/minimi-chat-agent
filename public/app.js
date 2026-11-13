// Plain JS, no build step. A turn renders as: question, steps, memory, sources, answer, actions, related.
const $ = (s, r = document) => r.querySelector(s);
const root = document.documentElement;
const thread = $("#thread"), input = $("#input"), form = $("#composer"), send = $("#send"), jump = $("#jump");
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const mobile = matchMedia("(max-width: 860px)");

let conversationId = location.hash.slice(1) || crypto.randomUUID();
let controller = null;
let follow = true; // keep the newest text in view unless the user scrolls up to read

/* ---------- small helpers ---------- */

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function icon(name) { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.innerHTML = `<use href="#i-${name}"/>`; return s; }
function iconBtn(name, label) { const b = el("button", "icon-btn"); b.type = "button"; b.append(icon(name)); b.setAttribute("aria-label", label); b.title = label; return b; }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const plural = (n, w) => `${n} ${n === 1 ? w : w.endsWith("h") ? w + "es" : w + "s"}`;
const fmtAsked = (ms) => new Date(ms).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
const longDay = (d) => d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

let toastTimer;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
}

/* ---------- scrolling ---------- */

const atBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
thread.addEventListener("scroll", () => { follow = atBottom(); jump.hidden = follow || document.body.classList.contains("is-empty"); }, { passive: true });
function stick() { if (follow) thread.scrollTop = thread.scrollHeight; }
jump.onclick = () => { follow = true; thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" }); };

/* ---------- answer rendering ---------- */

function renderAnswer(md, sources) {
  const byN = new Map(sources.map((s) => [s.n, s]));
  const withCites = md.replace(/\[(\d{1,2})\](?!\()/g, (m, n) => {
    const s = byN.get(Number(n));
    return s ? `<a class="cite" data-n="${n}" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(`${s.title} (${host(s.url)})`)}">${n}</a>` : m;
  });
  const box = document.createElement("div");
  box.innerHTML = DOMPurify.sanitize(marked.parse(withCites), { ADD_ATTR: ["target", "data-n"] });
  box.querySelectorAll("table").forEach((t) => { const w = el("div", "table-wrap"); t.replaceWith(w); w.append(t); });
  box.querySelectorAll("a:not(.cite)").forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
  return box.innerHTML;
}

function favicon(url) {
  const f = el("span", "fav", host(url)[0]?.toUpperCase() ?? "•");
  const img = new Image(16, 16);
  img.alt = ""; img.referrerPolicy = "no-referrer";
  img.onload = () => { if (img.naturalWidth > 1) { f.textContent = ""; f.append(img); } };
  img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host(url))}&sz=32`;
  return f;
}

function renderSources(box, sources, cited) {
  box.innerHTML = "";
  const isCited = (s) => cited?.includes(s.n);
  const order = cited?.length ? [...sources.filter(isCited).sort((a, b) => a.n - b.n), ...sources.filter((s) => !isCited(s))] : sources;
  box.classList.toggle("dim", !!cited?.length);
  order.slice(0, 12).forEach((s, i) => {
    const a = el("a", "source" + (isCited(s) ? " cited" : ""));
    a.href = s.url; a.target = "_blank"; a.rel = "noopener"; a.dataset.n = s.n; a.style.animationDelay = `${i * 30}ms`;
    a.append(el("span", "t", s.title));
    const date = s.published ? new Date(s.published) : null;
    const meta = host(s.url) + (date && !isNaN(date) ? `, ${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : "");
    const d = el("span", "d"); d.append(favicon(s.url), el("span", null, meta), el("span", "n", s.n));
    a.append(d); box.append(a);
  });
}

function sourceSkeletons(box) {
  if (box.children.length) return;
  for (let i = 0; i < 3; i++) { const s = el("div", "source skeleton"); s.append(el("div", "bar"), el("div", "bar short")); box.append(s); }
}

function renderMemory(box, recall) {
  box.innerHTML = "";
  if (!recall) return;
  for (const it of recall.items) {
    const d = new Date(it.at);
    const card = el("div", "memory");
    const stamp = el("div", "stamp"); stamp.append(el("b", null, d.getDate()), d.toLocaleDateString(undefined, { month: "short" }));
    const label = it.why === "on-date" ? `You asked on ${longDay(d)}` : it.why === "near-date" ? `Closest match: ${longDay(d)}` : `Related, from ${longDay(d)}`;
    card.append(stamp, el("div", "label", label), el("div", "then", it.question));
    box.append(card);
  }
  if (!recall.items.some((i) => i.why === "near-date")) {
    for (const r of recall.ranges.filter((r) => r.empty)) box.append(el("div", "memory missing", `Nothing saved from ${r.label}, so there is no earlier answer to check.`));
  }
}

/* ---------- a turn ---------- */

function turnShell(question, askedAt) {
  const turn = el("article", "turn");
  const steps = el("details", "steps");
  const summary = el("summary"); summary.append(el("span", "dot"), el("span", "label", "Thinking"));
  const list = el("ol"); steps.append(summary, list);
  const memory = el("div", "memories"), sources = el("div", "sources"), answer = el("div", "answer"), actions = el("div", "actions"), related = el("div", "related");
  turn.append(el("h2", "q", question), el("div", "asked", fmtAsked(askedAt)), steps, memory, sources, answer, actions, related);
  thread.append(turn);
  // Hovering a citation lights up its source card.
  answer.addEventListener("mouseover", (e) => { const c = e.target.closest(".cite"); sources.querySelectorAll(".source").forEach((s) => s.classList.toggle("hl", !!c && s.dataset.n === c.dataset.n)); });
  answer.addEventListener("mouseleave", () => sources.querySelectorAll(".hl").forEach((s) => s.classList.remove("hl")));
  const addStep = (cls, html) => { const li = el("li", "step " + cls); li.innerHTML = html; list.append(li); return li; };
  const setLabel = (t) => { summary.querySelector(".label").textContent = t; };
  return { turn, steps, list, addStep, setLabel, memory, sources, answer, actions, related, question };
}

function finishSteps(ui, recall, searches, sourceCount) {
  const bits = [];
  const mem = recall?.items.length ?? 0;
  if (recall && (mem || recall.ranges.length)) bits.push(mem ? `Recalled ${plural(mem, "conversation")}` : "Checked memory");
  if (searches) bits.push(plural(searches, "search"));
  if (sourceCount) bits.push(plural(sourceCount, "source"));
  ui.steps.classList.remove("running");
  if (!bits.length || !ui.list.children.length) { ui.steps.hidden = true; return; }
  ui.setLabel(bits.join(", "));
  ui.steps.open = false;
}

function renderActions(ui, text, ms) {
  ui.actions.innerHTML = "";
  const copy = iconBtn("copy", "Copy answer");
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(text); toast("Copied to clipboard"); } catch { toast("Copy failed: your browser blocked clipboard access"); }
  };
  const retry = iconBtn("retry", "Ask again");
  retry.onclick = () => !answering() && ask(ui.question);
  ui.actions.append(copy, retry);
  if (ms) ui.actions.append(el("span", "time", `${(ms / 1000).toFixed(1)}s`));
}

function renderRelated(ui, questions) {
  ui.related.innerHTML = "";
  if (!questions?.length) return;
  ui.related.append(el("h3", null, "Ask next"));
  questions.forEach((q, i) => {
    const b = el("button"); b.type = "button"; b.style.animationDelay = `${i * 60}ms`;
    b.append(el("span", null, q), icon("arrow"));
    b.onclick = () => !answering() && ask(q);
    ui.related.append(b);
  });
  stick();
}

function notice(ui, message, retryable = true) {
  const n = el("div", "notice"); n.append(el("span", null, message));
  if (retryable) { const b = el("button", null, "Try again"); b.type = "button"; b.onclick = () => { if (answering()) return; n.remove(); ask(ui.question); }; n.append(b); }
  ui.answer.after(n);
}

/* ---------- asking ---------- */

async function ask(message) {
  controller?.abort(); // only ever a finished answer still waiting for suggestions
  setEmpty(false);
  if (location.hash.slice(1) !== conversationId) history.replaceState(null, "", `#${conversationId}`);
  document.querySelectorAll(".related").forEach((r) => (r.innerHTML = "")); // old suggestions are stale now
  const ui = turnShell(message, Date.now());
  ui.steps.open = true; ui.steps.classList.add("running");
  ui.answer.innerHTML = '<div class="thinking"><i></i><i></i><i></i></div>';
  follow = true;
  requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });

  let text = "", sources = [], recall = null, frame = 0, searches = 0, finished = false;
  const live = new Map();
  const paint = () => { frame = 0; if (text) ui.answer.innerHTML = renderAnswer(text, sources); stick(); };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };

  const mine = new AbortController();
  controller = mine;
  setBusy(true);
  try {
    const res = await fetch("/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, message, tz }), signal: mine.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server error ${res.status}`);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        switch (ev.type) {
          case "recall": {
            recall = ev.recall;
            const n = recall.items.length, dates = recall.ranges.map((r) => r.label).join(" and ");
            ui.addStep("mem", n ? `Found ${plural(n, "past conversation")}${dates ? ` for ${esc(dates)}` : ""}` : `Checked memory${dates ? ` for ${esc(dates)}` : ""}, nothing saved`);
            ui.setLabel("Checking memory");
            renderMemory(ui.memory, recall);
            stick();
            break;
          }
          case "search":
            searches++;
            live.set(ev.id, ui.addStep("live", `Searching <q>${esc(ev.query)}</q>${ev.since ? `<small>since ${esc(ev.since)}</small>` : ""}`));
            ui.setLabel(searches > 1 ? `Searching the web (${searches})` : "Searching the web");
            sourceSkeletons(ui.sources);
            stick();
            break;
          case "search_done": {
            const li = live.get(ev.id); if (!li) break;
            li.classList.remove("live");
            li.classList.add(ev.error ? "fail" : "done");
            li.insertAdjacentHTML("beforeend", ev.error ? "<small>failed</small>" : `<small>${plural(ev.count, "result")}</small>`);
            break;
          }
          case "sources": sources = ev.sources; renderSources(ui.sources, sources); ui.setLabel("Reading sources"); break;
          case "text":
            if (!text) ui.setLabel("Writing");
            text += ev.delta; ui.answer.classList.add("streaming"); schedule(); break;
          case "retract": text = ""; ui.answer.innerHTML = '<div class="thinking"><i></i><i></i><i></i></div>'; break;
          case "done":
            finished = true;
            if (frame) { cancelAnimationFrame(frame); frame = 0; }
            ui.answer.classList.remove("streaming");
            ui.answer.innerHTML = renderAnswer(text, sources);
            renderSources(ui.sources, sources, ev.cited);
            finishSteps(ui, recall, ev.searches, ev.cited.length || sources.length);
            renderActions(ui, text, ev.latencyMs);
            setBusy(true, true); // the answer is complete; suggestions may still be on their way
            break;
          case "followups": renderRelated(ui, ev.questions); break;
          case "error": notice(ui, ev.message); break;
        }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") { if (!finished) notice(ui, "Stopped. The partial answer above was not saved.", true); }
    else notice(ui, /Failed to fetch|NetworkError|network/i.test(e.message) ? "Lost the connection to the agent. Check the server is still running, then try again." : e.message);
  } finally {
    if (frame) cancelAnimationFrame(frame);
    if (!finished) {
      if (text) ui.answer.innerHTML = renderAnswer(text, sources); else ui.answer.innerHTML = "";
      ui.answer.classList.remove("streaming");
      live.forEach((li) => li.classList.remove("live"));
      ui.sources.querySelectorAll(".skeleton").forEach((s) => s.remove());
      finishSteps(ui, recall, searches, sources.length);
    }
    if (controller === mine) setBusy(false); // a newer question may already own the composer
    loadConversations();
  }
}

/* ---------- threads ---------- */

function groupLabel(ms) {
  const d = new Date(ms), today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

async function loadConversations() {
  const list = await fetch("/api/conversations").then((r) => r.json()).catch(() => null);
  const nav = $("#conversations"); nav.innerHTML = "";
  if (!list) { nav.append(el("p", "nav-empty", "Couldn't load threads.")); return; }
  if (!list.length) { nav.append(el("p", "nav-empty", "Your threads will show up here.")); return; }
  let last = "";
  for (const c of list) {
    const g = groupLabel(c.updatedAt);
    if (g !== last) { nav.append(el("div", "group", g)); last = g; }
    const a = el("a", c.id === conversationId ? "active" : "", c.title || "Untitled");
    a.href = `#${c.id}`; a.title = c.title || "";
    nav.append(a);
    if (c.id === conversationId) $("#title").textContent = c.title || "Ask";
  }
}

async function openConversation(id) {
  conversationId = id;
  thread.querySelectorAll(".turn").forEach((t) => t.remove());
  const exchanges = await fetch(`/api/conversations/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  setEmpty(!exchanges.length);
  for (const ex of exchanges) {
    const ui = turnShell(ex.userText, ex.createdAt);
    ui.turn.style.animation = "none";
    renderMemory(ui.memory, ex.recall);
    for (const q of ex.searches) ui.addStep("done", `Searched <q>${esc(q)}</q>`);
    renderSources(ui.sources, ex.sources);
    finishSteps(ui, ex.recall, ex.searches.length, ex.sources.length);
    ui.answer.innerHTML = renderAnswer(ex.answer, ex.sources);
    renderActions(ui, ex.answer, ex.latencyMs);
  }
  loadConversations();
  follow = true;
  requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
}

function setEmpty(on) {
  document.body.classList.toggle("is-empty", on);
  if (on) { $("#title").textContent = "Ask"; jump.hidden = true; }
  if (!answering()) input.placeholder = on ? "Ask anything" : "Ask a follow up";
}

function newThread() {
  if (answering()) return;
  controller?.abort();
  history.pushState(null, "", location.pathname);
  conversationId = crypto.randomUUID();
  thread.querySelectorAll(".turn").forEach((t) => t.remove());
  setEmpty(true); loadConversations(); closeSide();
  input.value = ""; autosize(); input.focus();
}

/* ---------- composer ---------- */

/** busy: a request is open. answerDone: it's only waiting for suggestions, so the user can already ask again. */
function setBusy(busy, answerDone = false) {
  const answering = busy && !answerDone;
  send.classList.toggle("stop", answering);
  send.setAttribute("aria-label", answering ? "Stop" : "Send");
  input.placeholder = answering ? "Answering…" : "Ask a follow up";
  if (!busy) controller = null;
  updateSend();
}
const answering = () => send.classList.contains("stop");
function updateSend() { send.disabled = !(send.classList.contains("stop") || input.value.trim()); }

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (send.classList.contains("stop")) { controller?.abort(); return; }
  const m = input.value.trim();
  if (!m) return;
  input.value = ""; autosize();
  ask(m);
});
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 220) + "px"; updateSend(); }
input.addEventListener("input", autosize);
$("#starters").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { input.value = b.textContent; form.requestSubmit(); } });

/* ---------- sidebar, theme, shortcuts ---------- */

function closeSide() { document.body.classList.remove("side-open"); }
function toggleSidebar(show) {
  if (mobile.matches) { document.body.classList.toggle("side-open", show); return; }
  root.classList.toggle("side-collapsed", !show);
  try { localStorage.setItem("sidebar", show ? "open" : "closed"); } catch {}
}
$("#collapse").onclick = () => toggleSidebar(false);
$("#expand").onclick = () => toggleSidebar(true);
$("#scrim").onclick = closeSide;
$("#new-chat").onclick = newThread;
$("#new-chat-top").onclick = newThread;
$("#conversations").addEventListener("click", (e) => { if (e.target.closest("a")) closeSide(); });
window.addEventListener("hashchange", () => { const id = location.hash.slice(1); if (id && id !== conversationId && !answering()) { controller?.abort(); openConversation(id); } });

const currentTheme = () => root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
function labelThemeButtons() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.querySelectorAll(".theme-toggle").forEach((b) => { b.setAttribute("aria-label", `Switch to ${next} theme`); b.title = `Switch to ${next} theme`; });
}
document.querySelectorAll(".theme-toggle").forEach((b) => (b.onclick = () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch {}
  labelThemeButtons();
}));
labelThemeButtons();

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); newThread(); }
  else if (e.key === "Escape") { if (send.classList.contains("stop")) controller?.abort(); else closeSide(); }
  else if (e.key === "/" && document.activeElement !== input && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); }
});

if (location.hash) openConversation(conversationId); else { setEmpty(true); loadConversations(); }
updateSend();
