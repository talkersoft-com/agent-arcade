// Thin subscribe(state) → DOM render layer — replaces the reference draw().
// It reads the root machine snapshot (mode/selection/data) plus the focused agent's
// actor snapshot (durable draft + view sub-state) and updates the EXISTING DOM nodes
// from index.html. No framework, no VDOM.
//
// Wiring: main.js subscribes the root actor to draw(); it also re-subscribes to the
// focused agent actor so draft/view changes repaint without a root transition.
import { $, esc, PERSON, personSvg } from "./dom.js";
import { buildRail, railAgentAt, railSig } from "./railModel.js";

// Carousel geometry — must match the CSS (reference RAIL_PITCH/FIRST/ROW).
const RAIL_PITCH = 200, RAIL_FIRST = 100, RAIL_ROW = 236;
let lastRailSig = "";

// The focused agent's actor snapshot, if any. Supplied by main.js via setActorView.
let getFocusedSnapshot = () => null;
export function setFocusedSnapshotGetter(fn) { getFocusedSnapshot = fn; }

// Whether a terminal surface (peek/sync/shell) is up — supplied by main.js from the
// terminal actor. When true the terminal owns the screen (replaces the agent menu).
let isTerminalUp = () => false;
export function setTerminalUpGetter(fn) { isTerminalUp = fn; }

function railOf(ctx) { return buildRail(ctx.agents, ctx.groups, ctx.filterSystemId); }

export function draw(snapshot) {
  const ctx = snapshot.context;
  const mode = snapshot.matches("agent") ? "agent" : "rail";
  // Phase 0006: the terminal view is its OWN top-level surface (peek/sync/shell). When
  // up it replaces the agent menu and owns the whole screen (terminal.renderTerm paints
  // the inside; here we just route the container visibility). Only meaningful in agent mode.
  const inTerm = mode === "agent" && isTerminalUp();
  // 0 agents after the first load → the welcome orb owns the screen (gated on
  // `loaded` so it can't flash on boot).
  const welcome = ctx.loaded && mode === "rail" && !ctx.agents.length;

  $("welcome").style.display = welcome ? "flex" : "none";
  $("rail").style.display = (mode === "rail" && !welcome) ? "flex" : "none";
  $("strip").style.display = (mode === "agent" || welcome) ? "none" : "block";
  $("help").style.display = (mode === "agent" || welcome) ? "none" : "block";
  $("agent-view").style.display = (mode === "agent" && !inTerm) ? "flex" : "none";
  $("term-view").style.display = inTerm ? "flex" : "none";
  $("title").style.display = (inTerm || welcome) ? "none" : "block";
  renderSysFilter(ctx, mode);

  if (welcome) { /* static, CSS-driven */ }
  else if (mode === "rail") renderRail(ctx);
  else renderAgent(ctx);
}

// ── optional system filter strip (only when ≥1 system exists) ──
function renderSysFilter(ctx, mode) {
  const el = $("sys-filter"); if (!el) return;
  if (mode !== "rail" || !ctx.systems.length || !ctx.agents.length) {
    el.style.display = "none"; el.innerHTML = ""; return;
  }
  el.style.display = "flex";
  const chip = (id, label, n) =>
    `<div class="sf-chip${(id || null) === ctx.filterSystemId ? " sel" : ""}" data-sys="${id == null ? "" : esc(id)}">${esc(label)}<span class="sf-n">${n}</span></div>`;
  el.innerHTML = chip(null, "All", ctx.agents.length)
    + ctx.systems.filter((s) => s.active !== false).slice().sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((s) => chip(s.id, s.name || "(unnamed)", ctx.agents.filter((a) => a.system_id === s.id).length)).join("");
}

// ── agents rail (carousel) ──
function agentCardHTML(a, selected) {
  const c = a.color || "#7a8290";
  const badge = a.running ? `<span class="badge run">running</span>` : `<span class="badge stop">stopped</span>`;
  const face = a.avatar_status === "ready"
    ? `<img class="avimg" src="aaimg://a/${a.id}?v=${a.seed || 0}" alt="" />`
    : PERSON;
  return `<div class="agent ${selected ? "sel" : ""}" style="--c:${c}">
    <div class="dot" style="--c:${c}">${face}</div>
    <div class="nm">${esc(a.name || "(unnamed)")}</div>
    <div class="st">${badge}</div>
  </div>`;
}

function renderRail(ctx) {
  const rail = $("rail");
  const m = railOf(ctx);
  const activeSys = ctx.filterSystemId && ctx.systems.find((s) => s.id === ctx.filterSystemId);
  $("title").textContent = "Agent Arcade — " + (activeSys ? activeSys.name : "Agents");
  const { selG, sel } = ctx;
  const filterHint = ctx.systems.length ? ` &nbsp;·&nbsp; <kbd>f</kbd> filter` : "";
  $("help").innerHTML = (m.grouped
    ? `<kbd>←</kbd> <kbd>→</kbd> agent &nbsp;·&nbsp; <kbd>↑</kbd> <kbd>↓</kbd> group &nbsp;·&nbsp; <kbd>Enter</kbd> open`
    : `<kbd>←</kbd> <kbd>→</kbd> select &nbsp;·&nbsp; <kbd>Enter</kbd> open`) + filterHint + ` &nbsp;·&nbsp; <kbd>Esc</kbd> exit`;

  if (!m.flat.length) {
    const msg = activeSys ? `No agents in ${esc(activeSys.name)} — press f for All.` : "No agents yet — add one in Agent Arcade Studio.";
    rail.innerHTML = `<div class="empty" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">${msg}</div>`;
    lastRailSig = ""; setStrip(ctx, null); return;
  }

  // Only REBUILD the DOM when the rail's STRUCTURE changes — the 4s poll / status
  // pushes redraw constantly; rebuilding every time snapped the carousel + flickered.
  const sig = railSig(m);
  if (sig === lastRailSig && rail.querySelector("#rail-col")) {
    refreshRailCards(rail, m, ctx);
    updateRailSelection(rail, m, selG, sel);
    setStrip(ctx, railAgentAt(m, selG, sel));
    return;
  }
  lastRailSig = sig;
  const colHTML = m.groups.map((g, gi) => {
    const cards = g.agents.map((a, i) => agentCardHTML(a, gi === selG && i === sel)).join("");
    const label = m.grouped ? `<div class="grp-label">${esc(g.name)}</div>` : "";
    return `<div class="grp" data-g="${gi}">${label}<div class="track">${cards}</div></div>`;
  }).join("");
  const chevs = m.grouped
    ? `<div class="chev up ${selG > 0 ? "" : "hide"}">▲</div><div class="chev dn ${selG < m.groups.length - 1 ? "" : "hide"}">▼</div>`
    : "";
  rail.innerHTML = `<div id="rail-col">${colHTML}</div>${chevs}`;
  positionRail(rail, m, selG, sel);
  setStrip(ctx, railAgentAt(m, selG, sel));
}

// Update only the live per-frame bits (running badge) on existing cards, in place.
function refreshRailCards(rail, m) {
  rail.querySelectorAll(".grp").forEach((grp, gi) => {
    const list = m.groups[gi] ? m.groups[gi].agents : [];
    grp.querySelectorAll(".agent").forEach((card, i) => {
      const a = list[i]; if (!a) return;
      const st = card.querySelector(".st");
      if (st) st.innerHTML = a.running ? `<span class="badge run">running</span>` : `<span class="badge stop">stopped</span>`;
    });
  });
}

function positionRail(rail, m, selG, sel) {
  const colEl = rail.querySelector("#rail-col"); if (!colEl) return;
  const W = rail.clientWidth || window.innerWidth;
  colEl.style.transform = `translateY(${-(selG * RAIL_ROW + RAIL_ROW / 2)}px)`;
  rail.querySelectorAll(".grp").forEach((grp, gi) => {
    grp.classList.toggle("active", gi === selG);
    const len = m.groups[gi] ? m.groups[gi].agents.length : 0;
    const colIdx = gi === selG ? sel : Math.min(sel, len - 1);
    const track = grp.querySelector(".track");
    if (track) track.style.transform = `translateX(${W / 2 - (colIdx * RAIL_PITCH + RAIL_FIRST)}px)`;
  });
}

// Re-center for the current selection WITHOUT a DOM rebuild, so CSS transforms slide.
function updateRailSelection(rail, m, selG, sel) {
  if (!rail.querySelector("#rail-col")) return;
  rail.querySelectorAll(".grp").forEach((grp, gi) => {
    grp.querySelectorAll(".agent").forEach((c, i) => c.classList.toggle("sel", gi === selG && i === sel));
  });
  const up = rail.querySelector(".chev.up"), dn = rail.querySelector(".chev.dn");
  if (up) up.classList.toggle("hide", !(m.grouped && selG > 0));
  if (dn) dn.classList.toggle("hide", !(m.grouped && selG < m.groups.length - 1));
  positionRail(rail, m, selG, sel);
}

function setStrip(ctx, a) {
  const c = a ? (a.color || "#444") : "#444";
  $("strip").style.setProperty("--c", c);
  $("s-name").innerHTML = a ? `<b>${esc(a.name || "(unnamed)")}</b>` : "—";
  $("s-meta").textContent = a ? `${a.cwd || "~/workspace"}  ·  ${a.running ? "running" : "stopped"}` : "";
  // status line from the per-agent actor (idle by default).
  const snap = a ? getFocusedSnapshotById(ctx, a.id) : null;
  const st = snap ? snap.context.status : null;
  setMsg(stateLabel(st), st === "error");
}

function stateLabel(st) {
  return { recording: "● recording — ⌘D send · Esc cancel", sending: "⣾ sending…", delivered: "✓ delivered", error: "⚠ failed" }[st] || "● idle";
}
function setMsg(t, err) { const m = $("msg"); m.textContent = t || ""; m.style.color = err ? "#e5484d" : "#9aa4b2"; }
function setAvMsg(t, err) { const m = $("av-msg"); m.textContent = t || ""; m.style.color = err ? "#e5484d" : "#9aa4b2"; }

// ── agent view (drill-in menu) — durable draft restored here ──
function renderAgent(ctx) {
  const a = ctx.agents.find((x) => x.id === ctx.focusId);
  if (!a) return; // focus lost; root machine will route back to rail on next event
  const snap = getFocusedSnapshot();
  const view = snap ? snap.context.view : "menu";
  const draft = snap ? snap.context.draft : "";
  const status = snap ? snap.context.status : "idle";
  const inserting = view === "insert";

  const c = a.color || "#7a8290";
  const who = a.name || "(unnamed)";
  $("agent-view").style.setProperty("--c", c);
  const bigFace = a.avatar_status === "ready"
    ? `<img class="avimg" src="aaimg://a/${a.id}?v=${a.seed || 0}" alt="" />`
    : personSvg(c, 86);
  $("av-avatar").innerHTML = `<div class="dot" style="--c:${c};width:150px;height:150px;box-shadow:0 0 0 4px rgba(255,255,255,0.10),0 0 42px ${c}">${bigFace}</div>`;
  $("av-name").textContent = who;
  $("av-status").textContent = `${a.running ? "running" : "stopped"}  ·  ${a.cwd || "~/workspace"}`;
  $("title").textContent = who;

  const ta = $("av-input");
  ta.style.display = inserting ? "block" : "none";
  // DURABLE DRAFT: restore the per-agent draft into the box. We only overwrite the
  // DOM value when it diverges from the actor (avoids clobbering the caret while the
  // user is actively typing — the input handler keeps the actor in sync).
  if (ta.value !== draft) ta.value = draft;

  if (inserting) {
    $("av-help").style.display = "none";
    setAvMsg("type · Enter to send · Shift+Enter newline · Esc cancel");
    // focus the box when entering insert (idempotent — focus() on an already-focused
    // element is a no-op).
    if (document.activeElement !== ta) { ta.focus(); placeCaretEnd(ta); }
  } else {
    $("av-help").style.display = "";
    $("av-help").innerHTML =
      `<kbd>i</kbd> type${draft ? ' <span style="opacity:.7">(draft saved)</span>' : ""} &nbsp;·&nbsp; <kbd>t</kbd> terminal &nbsp;·&nbsp; <kbd>^C</kbd> interrupt &nbsp;·&nbsp; <kbd>⌘</kbd><kbd>←</kbd><kbd>→</kbd> agent &nbsp;·&nbsp; <kbd>⌘P</kbd> watch &nbsp;·&nbsp; <kbd>Esc</kbd> back`;
    const lbl = { recording: "● recording — ⌘D send · Esc cancel", sending: "⣾ sending…", delivered: "✓ delivered", error: "⚠ failed" }[status] || "● idle";
    setAvMsg(lbl, status === "error");
  }
}

function placeCaretEnd(ta) {
  try { const n = ta.value.length; ta.setSelectionRange(n, n); } catch {}
}

// Look up a per-agent actor snapshot by id (for the rail strip status line).
function getFocusedSnapshotById(ctx, id) {
  const actor = ctx.agentActors && ctx.agentActors[id];
  return actor ? actor.getSnapshot() : null;
}
