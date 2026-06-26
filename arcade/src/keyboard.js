// Keyboard routing — the document keydown handler + the Esc handler, ported from the
// reference's contract for the surfaces this phase owns (rail + agent view + ⌘←/→ +
// the type box). Each key becomes an XState event (root machine) or a per-agent actor
// event (draft/view). Stubs for dictation (⌘D/⌘P) and terminal (t/⌘F/⌘W/…) are clearly
// marked and route to no-op handlers so the ROUTING STRUCTURE is already in place for
// Phase 0005/0006 to fill in.
import { $ } from "./dom.js";
import { bus } from "./bus.js";
import {
  toggleDictation, cancelDictation, commitForNavigation,
  isRecording, recordingAgentId, isDictationAvailable, recordingNav,
} from "./dictation.js";
import {
  toggleTerm, openTerm, closeTerm, switchTerminalInView, interruptPane, sendTermInput,
  pageInPane, enterSync, exitSync, syncSend, keyEventToBytes, enterShell, exitShell,
  toggleCompose, terminalUp, inSyncMode, inShellMode, inComposeMode,
  isMacroPickerOpen, macroPickerState, cancelMacroPicker, mpMove, mpAdvance,
  startMacro, resolveMacro, exactPromptMacro,
} from "./terminal.js";

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

  // Exit-confirm overlay (warn-on-exit) buttons.
  const exitNo = $("exit-no"); if (exitNo) exitNo.addEventListener("click", closeExitConfirm);
  const exitYes = $("exit-yes"); if (exitYes) exitYes.addEventListener("click", confirmExit);

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

  // EXIT CONFIRM (warn-on-exit): the overlay owns all keys until answered.
  if (confirmingExit) {
    e.preventDefault();
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { exitChoice ^= 1; renderExitConfirm(); }
    else if (e.key === "y" || e.key === "Y") confirmExit();
    else if (e.key === "n" || e.key === "N" || e.key === "Escape") closeExitConfirm();
    else if (e.key === "Enter") { exitChoice === 1 ? confirmExit() : closeExitConfirm(); }
    return;
  }

  // ── MACRO PICKER (Phase 0006): owns all keys while open (text args keep cursor
  // arrows). Placed before everything else, mirroring the reference. ──
  if (isMacroPickerOpen()) {
    const mp = macroPickerState();
    const arg = mp && mp.phase === "arg" ? mp.cmd.args[mp.ai] : null;
    const isText = !!arg && arg.type === "text";
    const isFlag = !!arg && arg.type === "flag";
    if (e.key === "Escape") { e.preventDefault(); cancelMacroPicker(); return; }
    if (e.key === "Enter") { e.preventDefault(); mpAdvance(); return; }
    if (!isText && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); mpMove(e.key === "ArrowUp" ? -1 : 1); return; }
    if (isFlag && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === " ")) { e.preventDefault(); mpMove(1); return; }
    return;
  }

  // Held-key guard (matches the reference: allow held nav arrows only — but ALL keys
  // repeat in sync/shell, where every keystroke is forwarded raw to the pane/PTY).
  if (e.repeat && !inSyncMode() && !inShellMode() && !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"].includes(e.key)) return;

  // ── AGENT view ──
  if (api.isMode("agent")) {
    const actor = api.focusedActor();
    const inserting = actor && actor.getSnapshot().context.view === "insert";

    // INSERT (type box): textarea owns typing; we only intercept Enter (send) / Esc
    // (cancel). The 'input' listener keeps the draft actor in sync as you type. (Type
    // box and terminal are mutually exclusive — terminalUp() is false here.)
    if (inserting) {
      if (e.key === "Escape") { e.preventDefault(); cancelInsert(api); }
      else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTyped(api); }
      return;
    }

    // ── dictation (⌘D toggle) / watch (⌘P) ── carved out FIRST so the chord works
    // even inside sync (every other key still reaches the pane). ⌘ only (not Ctrl) so
    // Ctrl+D stays a real EOF in sync.
    if (isDictationAvailable() && e.metaKey && (e.key === "d" || e.key === "D")) { e.preventDefault(); toggleDictation(); return; }
    if (e.metaKey && (e.key === "p" || e.key === "P")) { e.preventDefault(); manualPopOut(api); return; }

    // ── WORKSPACE SHELL: xterm's textarea owns every keystroke. Only ⌘A (the ONLY way
    // out) is carved out here; Esc comes via the menu accelerator (handleEscape →
    // exitShell). Everything else hands off to xterm. ──
    if (inShellMode()) {
      if (e.metaKey && (e.key === "a" || e.key === "A")) { e.preventDefault(); exitShell(); return; }
      return;
    }

    // ── SYNC mode: every key (incl. Esc) → the pane raw; ⌘A exits; selection-aware ⌘C. ──
    if (inSyncMode()) {
      if (e.metaKey && (e.key === "a" || e.key === "A")) { e.preventDefault(); exitSync(); return; }
      if (e.metaKey && (e.key === "c" || e.key === "C") && String(window.getSelection() || "").trim()) return; // real copy
      const bytes = keyEventToBytes(e);
      if (bytes != null) { e.preventDefault(); syncSend(bytes); }
      return;
    }

    // ── TERMINAL PEEK: prompt input focused. Enter sends, ^C interrupts, ⌘F sync,
    // ⌘W shell, ⌘E compose, PgUp/PgDn scroll, ⌘←/→ switch terminal, Esc closes. ──
    if (terminalUp()) {
      if (e.metaKey && e.key === "ArrowLeft") { e.preventDefault(); navTerminal(api, -1); return; }
      if (e.metaKey && e.key === "ArrowRight") { e.preventDefault(); navTerminal(api, 1); return; }
      if (e.metaKey && (e.key === "w" || e.key === "W")) { e.preventDefault(); enterShell(); return; }
      if (e.ctrlKey && (e.key === "c" || e.key === "C")) { e.preventDefault(); interruptPane(); return; }
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) { e.preventDefault(); enterSync(); return; }
      if ((e.metaKey || e.ctrlKey) && (e.key === "e" || e.key === "E")) { e.preventDefault(); toggleCompose(); return; }
      if (e.key === "Enter") {
        const compose = inComposeMode();
        const sendCombo = compose ? (e.metaKey || e.ctrlKey) : !e.shiftKey;
        if (sendCombo) {
          // @-command: run the macro ONLY when the ENTIRE prompt is exactly "@name" and it
          // matches (same rule as the blue highlight). "@Exec 123" / "@Exec hello" / extra
          // text → falls through and sends as normal input.
          const ta = $("av-term-input");
          const agent = api.focusedAgent();
          const cmd = agent ? exactPromptMacro(ta && ta.value, agent.id) : null;
          if (cmd) {
            e.preventDefault();
            // Clear BOTH the textarea and the durable XState draft so the consumed "@name"
            // doesn't reappear on re-render / agent-switch.
            if (ta) { ta.value = ""; ta.classList.remove("macro-match"); }
            const actor = api.focusedActor && api.focusedActor();
            if (actor) actor.send({ type: "TERM_DRAFT.CLEAR" });
            if (compose) toggleCompose(false);
            startMacro(cmd.name);
            return;
          }
        }
        if (compose) {
          if (e.metaKey || e.ctrlKey) { e.preventDefault(); sendTermInput(); toggleCompose(false); }
          /* plain Enter (and Shift+Enter) = newline */
        } else if (!e.shiftKey) { e.preventDefault(); sendTermInput(); }
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); if (inComposeMode()) toggleCompose(false); else closeTerm(); return; }
      if (!inComposeMode()) {
        if (e.key === "PageUp") { e.preventDefault(); pageInPane("pageup"); return; }
        if (e.key === "PageDown") { e.preventDefault(); pageInPane("pagedown"); return; }
      }
      return; // everything else types into the prompt textarea
    }

    // ── AGENT MENU (no terminal up) ──
    // ⌘←/→ switch agent (deliberate gesture; bare arrows are inert on the menu). When a
    // recording is in flight, route through the recordingNavBehavior gate first.
    if (e.metaKey && e.key === "ArrowLeft") { e.preventDefault(); navAgent(api, -1); return; }
    if (e.metaKey && e.key === "ArrowRight") { e.preventDefault(); navAgent(api, 1); return; }

    // ^C interrupt — send Esc into the agent's pane (works from the menu too).
    if (e.ctrlKey && (e.key === "c" || e.key === "C")) { e.preventDefault(); interruptPane(); return; }

    switch (e.key) {
      case "i": case "I": e.preventDefault(); if (!isRecording()) startInsert(api); break;  // typing within the agent
      case "t": case "T": e.preventDefault(); toggleTerm(); break;     // open the live terminal peek
      // Esc → cancel a live recording (discard) FIRST; otherwise back to rail.
      case "Escape": if (isRecording()) { cancelDictation(); } else { api.send({ type: "EXIT_TO_RAIL" }); } break;
    }
    return;
  }

  // ── AGENTS rail (main menu) ──
  switch (e.key) {
    case "ArrowRight": e.preventDefault(); api.send({ type: "RAIL_MOVE", dA: 1 }); break;
    case "ArrowLeft": e.preventDefault(); api.send({ type: "RAIL_MOVE", dA: -1 }); break;
    case "ArrowDown": e.preventDefault(); api.send({ type: "RAIL_MOVE", dG: 1 }); break;
    case "ArrowUp": e.preventDefault(); api.send({ type: "RAIL_MOVE", dG: -1 }); break;
    case "Enter": gateRailEnter(api); break;
    case "Escape": if (isRecording()) { cancelDictation(); } else { requestExit(); } break;   // rail top level
    case "f": case "F": e.preventDefault(); api.send({ type: "CYCLE_FILTER", dir: e.shiftKey ? -1 : 1 }); break;
    default:
      if (/^[1-9]$/.test(e.key)) { api.send({ type: "SELECT_INDEX", index: +e.key - 1 }); }
  }
}

// ── recordingNavBehavior gate (Phase 0005) ──────────────────────────────────────
// Navigating to ANOTHER agent while recording:
//   send (default): commit dictation to the ORIGINAL agent, then navigate immediately;
//                   toast "Sent to [name]". The job actor outlives the navigation.
//   lock:           block navigation; toast "Locked while recording".
// Navigating WITHIN the recording agent (or not recording) → proceed unchanged.

// ⌘←/→ agent switch from the agent view (always targets a different agent).
async function navAgent(api, dir) {
  if (isRecording()) {
    if (recordingNav() === "lock") { lockedToast(); return; }
    // send: commit to the original agent, THEN navigate immediately (don't await Go).
    const name = await commitForNavigation();
    if (name) bus.emit("toast", { text: "Sent to " + name, kind: "info" });
  }
  api.send({ type: "SWITCH_AGENT", dir });
}

// ⌘←/→ from the TERMINAL peek: switch the focused agent (root machine) AND keep the
// peek up on the new agent (re-point + ensure its pane is live). Mirrors the
// reference's switchTerminalInView — staying in the terminal, not the menu.
async function navTerminal(api, dir) {
  if (isRecording()) {
    if (recordingNav() === "lock") { lockedToast(); return; }
    const name = await commitForNavigation();
    if (name) bus.emit("toast", { text: "Sent to " + name, kind: "info" });
  }
  const before = api.focusedAgent();
  api.send({ type: "SWITCH_AGENT", dir });   // root machine moves focus (guarded; no-op at an end)
  const after = api.focusedAgent();
  if (after && (!before || after.id !== before.id)) switchTerminalInView(dir); // re-open peek only if focus moved
}

// Rail Enter: entering an agent moves focus to another agent (or the same one). If a
// recording is in flight it was started on a DIFFERENT focused agent, so this is always
// a "navigate to another agent" event w.r.t. the recording.
async function gateRailEnter(api) {
  if (isRecording()) {
    if (recordingNav() === "lock") { lockedToast(); return; }
    const name = await commitForNavigation();
    if (name) bus.emit("toast", { text: "Sent to " + name, kind: "info" });
  }
  api.send({ type: "ENTER_AGENT" });
}

function lockedToast() { bus.emit("toast", { text: "Locked while recording", kind: "info" }); }

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

// ── warn-on-exit confirm (app.warn_on_exit). The single exit entry point: with the
// setting on, pop a Yes/No the user must answer (default No so a stray Enter won't quit). ──
let warnOnExit = false;      // set from arcade settings (applyExitSettings)
let confirmingExit = false;  // the overlay is up
let exitChoice = 0;          // 0 = No (default), 1 = Yes
export function applyExitSettings(st) { if (st && typeof st.warn_on_exit === "boolean") warnOnExit = st.warn_on_exit; }
function requestExit() {
  if (!warnOnExit) { try { if (window.arcade && window.arcade.exit) window.arcade.exit(); } catch {} return; }
  confirmingExit = true; exitChoice = 0;
  const o = $("exit-overlay"); if (o) o.classList.add("on");
  renderExitConfirm();
}
function renderExitConfirm() {
  const no = $("exit-no"), yes = $("exit-yes");
  if (no) no.classList.toggle("sel", exitChoice === 0);
  if (yes) yes.classList.toggle("sel", exitChoice === 1);
}
function closeExitConfirm() { confirmingExit = false; const o = $("exit-overlay"); if (o) o.classList.remove("on"); }
function confirmExit() { closeExitConfirm(); try { if (window.arcade && window.arcade.exit) window.arcade.exit(); } catch {} }

// ── Esc handler (single source of truth; routed from the menu accelerator) ──
// macOS eats Esc for the fullscreen window, so main routes it via a menu accelerator.
// Precedence mirrors the reference's handleEscape().
function handleEscape(api) {
  // Exit-confirm overlay first — Esc = No (cancel the exit).
  if (confirmingExit) { closeExitConfirm(); return; }
  // Macro picker — Esc cancels it.
  if (isMacroPickerOpen()) { cancelMacroPicker(); return; }
  // Esc cancels a live recording (discard — the ONLY discard path), staying put.
  if (isRecording()) { cancelDictation(); return; }
  if (api.isMode("agent")) {
    const actor = api.focusedActor();
    if (actor && actor.getSnapshot().context.view === "insert") { cancelInsert(api); return; }
    // WORKSPACE SHELL: Esc belongs to the SHELL (forward to the PTY) — the only way out
    // is ⌘A / ⌘W, never Esc.
    if (inShellMode()) { const a = api.focusedAgent(); if (a && window.arcade && window.arcade.shellInput) window.arcade.shellInput(a.id, "\x1b"); return; }
    // SYNC: Esc belongs to the pane (like the shell); ⌘A exits sync.
    if (inSyncMode()) { syncSend("\x1b"); return; }
    // TERMINAL PEEK: compose → collapse; else close the terminal back to the menu.
    if (terminalUp()) { if (inComposeMode()) toggleCompose(false); else closeTerm(); return; }
    api.send({ type: "EXIT_TO_RAIL" });
    return;
  }
  requestExit(); // rail is the top level
}

function setAvMsg(t, err) { const m = $("av-msg"); if (m) { m.textContent = t || ""; m.style.color = err ? "#e5484d" : "#9aa4b2"; } }

// ── ⌘P: pop out (or focus) the GUI "watch" terminal window for the focused agent.
// Launches the agent's session first if it isn't running, so ⌘P "just works" anywhere. ──
async function manualPopOut(api) {
  const a = api.focusedAgent(); if (!a) return;
  const aid = a.id;
  if (!a.running) {
    bus.emit("toast", { text: "Launching agent…", kind: "info" });
    try {
      const r = window.arcade && window.arcade.launchAgent ? await window.arcade.launchAgent(aid) : null;
      if (!r || !r.ok) { bus.emit("toast", { text: "Couldn't launch agent: " + ((r && r.error) || "unknown"), kind: "error" }); return; }
    } catch (e) { bus.emit("toast", { text: "Couldn't launch agent: " + (e && e.message), kind: "error" }); return; }
    bus.emit("agents:reload");
  }
  try {
    const res = window.arcade && window.arcade.popOut ? await window.arcade.popOut(aid, true) : null; // force = explicit user intent
    if (res && res.ok) bus.emit("toast", { text: "Popped out — watch on the other monitor", kind: "info" });
    else bus.emit("toast", { text: "Pop-out failed: " + ((res && res.error) || ""), kind: "error" });
  } catch (e) { bus.emit("toast", { text: "Pop-out failed: " + (e && e.message), kind: "error" }); }
}
