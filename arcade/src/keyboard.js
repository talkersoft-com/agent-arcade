// Keyboard routing — the document keydown handler + the Esc handler, ported from the
// reference's contract for the surfaces this phase owns (rail + agent view + ⌘←/→ +
// the type box). Each key becomes an XState event (root machine) or a per-agent actor
// event (draft/view). Stubs for dictation (⌘D/⌘P) and terminal (t/⌘F/⌘W/…) are clearly
// marked and route to no-op handlers so the ROUTING STRUCTURE is already in place for
// Phase 0005/0006 to fill in.
import { $ } from "./dom.js";
import { bus } from "./bus.js";

// `api` is supplied by main.js: { send, focusedActor, focusedAgent, isMode, ctx }.
export function wireKeyboard(api) {
  // macOS eats Esc for the fullscreen window; main routes it via a menu accelerator,
  // translated to a bus "escape" by the IPC seam. This is the single Esc source.
  bus.on("escape", () => handleEscape(api));

  document.addEventListener("keydown", (e) => onKeydown(e, api));

  // Re-center the carousel on resize (transforms are pixel-based off rail width).
  window.addEventListener("resize", () => { if (api.isMode("rail")) api.repositionRail(); });

  // Welcome orb click → start setup (Studio first-agent wizard).
  const welOrb = $("wel-orb");
  if (welOrb) welOrb.addEventListener("click", () => igniteSetup());

  // Keep the per-agent draft in sync on every keystroke in the type box. This is the
  // write side of the durable draft (render.js is the read side).
  const ta = $("av-input");
  if (ta) ta.addEventListener("input", () => {
    const actor = api.focusedActor();
    if (actor) actor.send({ type: "DRAFT.SET", draft: ta.value });
  });
}

let igniting = false;
async function igniteSetup() {
  if (igniting) return; igniting = true;
  const w = $("welcome"); if (w) w.classList.add("igniting");
  setTimeout(async () => {
    try { if (window.arcade && window.arcade.startSetup) await window.arcade.startSetup(); } catch {}
    igniting = false; if (w) w.classList.remove("igniting");
  }, 480);
}

function onKeydown(e, api) {
  const ctx = api.ctx();
  const agents = ctx.agents;

  // WELCOME (0 agents): Enter/Space → setup; swallow other nav.
  if (api.isMode("rail") && ctx.loaded && !agents.length) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); igniteSetup(); }
    return;
  }

  // Held-key guard (matches the reference: allow held nav arrows only).
  if (e.repeat && !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;

  // ── AGENT view ──
  if (api.isMode("agent")) {
    const actor = api.focusedActor();
    const inserting = actor && actor.getSnapshot().context.view === "insert";

    // INSERT (type box): textarea owns typing; we only intercept Enter (send) / Esc
    // (cancel). The 'input' listener keeps the draft actor in sync as you type.
    if (inserting) {
      if (e.key === "Escape") { e.preventDefault(); cancelInsert(api); }
      else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTyped(api); }
      return;
    }

    // ── dictation / watch — STUBBED for Phase 0005 (structure in place) ──
    if (e.metaKey && (e.key === "d" || e.key === "D")) { e.preventDefault(); stubDictation(); return; }
    if (e.metaKey && (e.key === "p" || e.key === "P")) { e.preventDefault(); stubWatch(); return; }

    // ⌘←/→ switch agent (deliberate gesture; bare arrows are inert on the menu).
    if (e.metaKey && e.key === "ArrowLeft") { e.preventDefault(); api.send({ type: "SWITCH_AGENT", dir: -1 }); return; }
    if (e.metaKey && e.key === "ArrowRight") { e.preventDefault(); api.send({ type: "SWITCH_AGENT", dir: 1 }); return; }

    // ^C interrupt — STUBBED for Phase 0006 (terminal/pane).
    if (e.ctrlKey && (e.key === "c" || e.key === "C")) { e.preventDefault(); stubInterrupt(); return; }

    switch (e.key) {
      case "i": case "I": e.preventDefault(); startInsert(api); break;
      case "t": case "T": e.preventDefault(); stubTerminal(); break;   // Phase 0006
      case "Escape": api.send({ type: "EXIT_TO_RAIL" }); break;
    }
    return;
  }

  // ── AGENTS rail (main menu) ──
  switch (e.key) {
    case "ArrowRight": e.preventDefault(); api.send({ type: "RAIL_MOVE", dA: 1 }); break;
    case "ArrowLeft": e.preventDefault(); api.send({ type: "RAIL_MOVE", dA: -1 }); break;
    case "ArrowDown": e.preventDefault(); api.send({ type: "RAIL_MOVE", dG: 1 }); break;
    case "ArrowUp": e.preventDefault(); api.send({ type: "RAIL_MOVE", dG: -1 }); break;
    case "Enter": api.send({ type: "ENTER_AGENT" }); break;
    case "Escape": requestExit(); break;   // rail is the top level — Esc exits
    case "f": case "F": e.preventDefault(); api.send({ type: "CYCLE_FILTER", dir: e.shiftKey ? -1 : 1 }); break;
    default:
      if (/^[1-9]$/.test(e.key)) { api.send({ type: "SELECT_INDEX", index: +e.key - 1 }); }
  }
}

// ── agent-view: insert / send ──
function startInsert(api) {
  const actor = api.focusedActor();
  if (actor) actor.send({ type: "INSERT" }); // render.js focuses the box + restores draft
}
function cancelInsert(api) {
  // Cancel closes the box but DOES NOT clear the draft — that's the whole point of the
  // durable-draft fix. (A future "send" is the only thing that clears it.)
  const actor = api.focusedActor();
  if (actor) actor.send({ type: "MENU" });
  const ta = $("av-input"); if (ta) ta.blur();
}
async function sendTyped(api) {
  const actor = api.focusedActor();
  const agent = api.focusedAgent();
  const ta = $("av-input");
  const text = ta ? ta.value : "";
  if (actor) actor.send({ type: "MENU" });
  if (ta) ta.blur();
  if (!agent || !text.trim()) { setAvMsg("nothing to send"); return; }
  setAvMsg("⣾ sending…");
  try {
    const res = await window.arcade.sendText(agent.id, text);
    if (res && res.ok) {
      // Sent successfully → the draft is now consumed; clear it.
      if (actor) actor.send({ type: "DRAFT.CLEAR" });
      setAvMsg("✓ sent");
    } else {
      setAvMsg("send failed: " + (res && res.error), true);
    }
  } catch (err) {
    setAvMsg("send failed: " + (err && err.message), true);
  }
}

function requestExit() {
  // warn-on-exit overlay is a later surface; this phase exits straight away.
  try { if (window.arcade && window.arcade.exit) window.arcade.exit(); } catch {}
}

// ── Esc handler (single source of truth; routed from the menu accelerator) ──
function handleEscape(api) {
  if (api.isMode("agent")) {
    const actor = api.focusedActor();
    if (actor && actor.getSnapshot().context.view === "insert") { cancelInsert(api); return; }
    api.send({ type: "EXIT_TO_RAIL" });
    return;
  }
  requestExit(); // rail is the top level
}

function setAvMsg(t, err) { const m = $("av-msg"); if (m) { m.textContent = t || ""; m.style.color = err ? "#e5484d" : "#9aa4b2"; } }

// ── stubs for later phases (routing exists; behavior lands in 0005/0006) ──
function stubDictation() { bus.emit("toast", { text: "Dictation arrives in the next phase.", kind: "info" }); } // Phase 0005 (⌘D)
function stubWatch() { /* Phase 0005 — ⌘P watch window */ }
function stubTerminal() { bus.emit("toast", { text: "The terminal arrives in the next phase.", kind: "info" }); } // Phase 0006 (t)
function stubInterrupt() { /* Phase 0006 — ^C interrupt pane */ }
