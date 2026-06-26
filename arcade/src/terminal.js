// Terminal controller — the renderer-side owner of the Arcade's terminal-facing
// surfaces (Phase 0006). It pairs with the `terminalMachine` (state region) the way
// dictation.js pairs with dictationMachine: the MACHINE owns the lifecycle (closed →
// peek → sync → shell + the compose flag), this CONTROLLER owns the imperative DOM /
// poll / xterm / ANSI / @-macro-picker work, ported 1:1 from the reference renderer.
//
// Surfaces:
//   1. peek    : live pane PEEK — poll window.arcade.getText(agent) → ANSI→HTML scrape,
//                centered (#av-term-inner); prompt input → sendText on Enter.
//   2. ^C      : interrupt → window.arcade.paneKey(agent,"escape").
//   3. sync    : every-key-raw-to-the-pane (keyEventToBytes verbatim) → paneSend; ⌘A exits.
//   4. shell   : ⌘W workspace shell (AAXterm xterm.js + node-pty over shellOpen/Input/
//                Resize + onShellData/onShellExit). ⌘A/Esc back. One xterm+PTY per agent.
//   5. @-macro : the chip bar + keyboard arg picker (select/text/flag), composeMacro with
//                shell-quoting for select/text and RAW token for flags, run in the shell.
//   6. optimistic-with-reconciliation: wezterm ops reflect exit-0 immediately and surface
//                {ok:false,error,code} as an ERROR (status/toast) — never assumed success.
//
// `host` (set by main.js) bridges to the root machine: { focusedAgent(), commands(),
//   send(event), termSnapshot() }.  `term` (set by main.js) is the terminal actor.
import { $, esc } from "./dom.js";
import { bus } from "./bus.js";

const arcade = (typeof window !== "undefined" && window.arcade) || {};

let host = null;       // { focusedAgent, commands, send (root machine), termSnapshot }
let term = null;       // the terminal actor (createActor(terminalMachine))
export function setTerminalHost(h) { host = h; }
export function setTerminalActor(a) { term = a; }

// ── state mirrors (read from the actor's snapshot) ──
function snap() { return term ? term.getSnapshot() : null; }
function inPeek() { const s = snap(); return !!(s && s.matches("peek")); }
function inSync() { const s = snap(); return !!(s && s.matches("sync")); }
function inShell() { const s = snap(); return !!(s && s.matches("shell")); }
function inTerm() { const s = snap(); return !!(s && (s.matches("peek") || s.matches("sync") || s.matches("shell"))); }
function isCompose() { const s = snap(); return !!(s && s.context.compose); }
export function terminalUp() { return inTerm(); }      // keyboard.js asks "is a terminal surface up?"
export function inSyncMode() { return inSync(); }
export function inShellMode() { return inShell(); }
export function inComposeMode() { return isCompose(); }

function currentAgent() { return host ? host.focusedAgent() : null; }
function commandsFor(id) { const all = (host && host.commands()) || []; return all.filter((c) => !c.agent_id || c.agent_id === id); }
function setAvMsg(t, err) { const m = $("av-msg"); if (m) { m.textContent = t || ""; m.style.color = err ? "#e5484d" : "#9aa4b2"; } }

// ═══════════════════════════════════════════════════════════════════════════════
// 0. wiring — install the shell-push action writers + the DOM click handlers once.
// ═══════════════════════════════════════════════════════════════════════════════
let wired = false;
// Per-agent terminal-prompt draft now lives in the per-agent XState actor
// (agentActor context.termDraft) — the durable, single source of truth, same model as
// the agent-view type box. These helpers read/write it through the terminal host bridge;
// the DOM textarea is just the live editor, reflected from the actor on open / switch.
function draftActor() { const a = currentAgent(); return a && host && host.actorFor ? host.actorFor(a.id) : null; }
function readTermDraft() { const ac = draftActor(); return ac ? (ac.getSnapshot().context.termDraft || "") : ""; }
function setTermDraft(text) { const ac = draftActor(); if (ac) ac.send({ type: "TERM_DRAFT.SET", text }); }
function clearTermDraft() { const ac = draftActor(); if (ac) ac.send({ type: "TERM_DRAFT.CLEAR" }); }
function appendTermDraft(text) { const ac = draftActor(); if (ac) ac.send({ type: "TERM_DRAFT.APPEND", text }); }

// Shell-quote a path with whitespace/metacharacters so a dropped path stays a single
// argument when the prompt is later sent as a command.
function shqPath(p) { return /[\s'"()$&;|<>*?`\\]/.test(p) ? "'" + String(p).replace(/'/g, "'\\''") + "'" : p; }
// Absolute path(s) from a drop: real OS file drags (Finder, VSCode Explorer) via
// webUtils.getPathForFile; fall back to text/uri-list (VSCode editor tabs) then a plain
// path in text/plain.
function pathsFromDrop(e) {
  const dt = e.dataTransfer; if (!dt) return [];
  const out = [];
  if (dt.files && dt.files.length && arcade.pathForFile) {
    for (const f of dt.files) { const p = arcade.pathForFile(f); if (p) out.push(p); }
  }
  if (!out.length) {
    for (const line of (dt.getData("text/uri-list") || "").split(/\r?\n/)) {
      const u = line.trim();
      if (!u || u.startsWith("#") || !u.startsWith("file://")) continue;
      try { out.push(decodeURIComponent(new URL(u).pathname)); } catch {}
    }
  }
  if (!out.length) {
    const t = (dt.getData("text/plain") || "").trim();
    if (t && (t.startsWith("/") || t.startsWith("~"))) out.push(t);
  }
  return out;
}

export function wireTerminal() {
  if (wired) return; wired = true;
  // The @-macro chip bar + picker click handlers (terminal peek only).
  const bar = $("macro-bar");
  if (bar) bar.addEventListener("click", (e) => {
    const chip = e.target.closest(".macro-chip"); if (!chip) return;
    if (chip.dataset.more) openMacroList(); else startMacro(chip.dataset.cmd);
  });
  // Passive "@…" autocomplete hint + auto-grow on the prompt.
  const inp = $("av-term-input");
  if (inp) {
    inp.addEventListener("input", autoGrow);
    inp.addEventListener("input", macroHint);
    // Persist the draft per-agent (durable via the actor) so it survives close/reopen.
    inp.addEventListener("input", () => setTermDraft(inp.value));
  }
  // ── file drag-and-drop → append absolute path(s) to the prompt draft ──
  // The whole terminal view is the drop zone (the small textarea alone is a poor target),
  // but ONLY in the peek surface — never sync or shell. We hard-stop the window's default
  // file-drop (which would navigate the renderer to the file and blank the app) and insert
  // through the actor (TERM_DRAFT.APPEND), keeping XState the source of truth; the textarea
  // is then reflected from it.
  const dropAllowed = () => inPeek();                                   // peek only (false in sync/shell)
  const overTermView = (t) => !!(t && t.closest && t.closest("#term-view"));
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    const ok = dropAllowed() && overTermView(e.target);
    if (e.dataTransfer) e.dataTransfer.dropEffect = ok ? "copy" : "none";
    const tv = $("term-view"); if (tv) tv.classList.toggle("drop-over", ok);
  });
  window.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) { const tv = $("term-view"); if (tv) tv.classList.remove("drop-over"); }
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();                                                // never let a drop navigate the window
    const tv = $("term-view"); if (tv) tv.classList.remove("drop-over");
    if (!dropAllowed() || !overTermView(e.target)) return;
    const paths = pathsFromDrop(e); if (!paths.length) return;
    appendTermDraft(paths.map(shqPath).join("\n"));                     // each path on its own line
    const i = $("av-term-input"); if (i) { i.value = readTermDraft(); autoGrow(); i.focus(); }
  });
  // Re-fit the live shell on resize (only while it's up).
  window.addEventListener("resize", () => { if (inShell()) fitShell(); });
}

// The terminal actor's onShellData/onShellExit actions are provided here (see main.js
// machine.provide), so the SINGLE translate site (ipc.js → driveShell) drives the
// machine and the machine writes to the live xterm. These are the real writers.
export function shellDataWriter({ agentId, data }) { const s = shells.get(agentId); if (s) s.term.write(data); }
export function shellExitWriter({ agentId }) { const s = shells.get(agentId); if (s) s.term.write("\r\n\x1b[2m[shell exited — ⌘A back]\x1b[0m\r\n"); }

// ── the ONE translate site for shell pushes → the terminal machine ──
// ipc.js calls these with the raw onShellData/onShellExit payloads; they become
// SHELL.DATA / SHELL.EXIT events on the machine, whose provided actions write to xterm.
export function driveShellData(p) { if (term) term.send({ type: "SHELL.DATA", ...p }); }
export function driveShellExit(p) { if (term) term.send({ type: "SHELL.EXIT", ...p }); }

// ═══════════════════════════════════════════════════════════════════════════════
// 1. RENDER — paint the active terminal surface. Called by the controller's own actor
//    subscription (main.js subscribes term → renderTerm) AND after data refreshes.
// ═══════════════════════════════════════════════════════════════════════════════
export function renderTerm() {
  if (!inTerm()) { stopPoll(); return; }
  const a = currentAgent();
  if (!a) { if (term) term.send({ type: "CLOSE" }); return; }
  const c = a.color || "#7a8290";
  const who = a.name || "(unnamed)";
  const tv = $("term-view");
  tv.style.setProperty("--c", c);
  const sync = inSync(), shell = inShell(), compose = isCompose();
  tv.classList.toggle("sync-open", sync);
  tv.classList.toggle("shell-open", shell);
  tv.classList.toggle("compose-open", compose && !sync && !shell);
  $("av-termwho").textContent = who;
  $("av-termtag").textContent = shell ? "Workspace" : sync ? "Sync" : "Live Terminal";
  $("term-help").innerHTML = shell
    ? `<kbd>⌘A</kbd> back to agent`
    : sync
      ? `<kbd>every key</kbd> → the pane (incl. <kbd>Esc</kbd>) &nbsp;·&nbsp; <kbd>⌘A</kbd> exit`
      : compose
        ? `<kbd>⌘</kbd>+<kbd>Enter</kbd> send &nbsp;·&nbsp; <kbd>Enter</kbd> newline &nbsp;·&nbsp; <kbd>Esc</kbd> collapse`
        : `<kbd>Enter</kbd> send &nbsp;·&nbsp; <kbd>⌘</kbd><kbd>←</kbd><kbd>→</kbd> terminal &nbsp;·&nbsp; <kbd>^C</kbd> interrupt &nbsp;·&nbsp; <kbd>⌘F</kbd> sync &nbsp;·&nbsp; <kbd>⌘W</kbd> workspace &nbsp;·&nbsp; <kbd>⌘E</kbd> expand &nbsp;·&nbsp; <kbd>Esc</kbd> close`;
  if (shell) setAvMsg("workspace shell — ⌘A back to agent");
  else if (sync) setAvMsg("sync — every key goes to the pane (incl. Esc) · ⌘A exit");
  else setAvMsg(compose ? "compose — ⌘+Enter send · Enter newline · Esc collapse" : "terminal — Enter sends · ^C interrupts · ⌘F sync · ⌘W workspace");
  renderMacroBar();
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. PEEK — toggle / open / refresh. `t` from the agent menu opens; Esc/CLOSE closes.
// ═══════════════════════════════════════════════════════════════════════════════
export async function toggleTerm() {
  if (inTerm()) { closeTerm(); return; }
  openTerm();
}
export async function openTerm() {
  const a = currentAgent(); if (!a) return;
  lastTermRaw = "";
  if (term) term.send({ type: "OPEN", agentId: a.id });   // machine → peek (renders via subscription)
  refreshAvTerm(); startPoll(2500);
  const inp = $("av-term-input"); if (inp) { inp.value = readTermDraft(); autoGrow(); inp.focus(); }
  // Ensure the pane is live (reuse / respawn + resume) — same guarantee as the reference.
  const res = await arcade.launchAgent(a.id);
  if (!(inPeek() && curId() === a.id)) return;             // user moved on meanwhile
  if (res && res.ok) { bus.emit("agents:reload"); const cur = currentAgent(); if (cur && cur.running) arcade.activate(a.id); refreshAvTerm(); }
}
export function closeTerm() {
  stopPoll();
  if (term) term.send({ type: "CLOSE" });
  const inp = $("av-term-input"); if (inp) inp.blur();
}
function curId() { const s = snap(); return s ? s.context.agentId : null; }

// ⌘←/→ in the peek → switch to the prev/next agent's terminal, staying in the peek.
// The actual agent switch is owned by the root machine (SWITCH_AGENT); this re-points
// the peek at the new focused agent and (debounced) ensures its pane is up.
let switchTimer = null;
export function switchTerminalInView(dir) {
  // keyboard.js drives the root SWITCH_AGENT first; here we re-open the peek on the new
  // focused agent and ensure its pane is live.
  const a = currentAgent(); if (!a) return;
  lastTermRaw = "";
  // Restore the new agent's saved prompt draft (each agent keeps its own, in its actor).
  const inp = $("av-term-input"); if (inp) { inp.value = readTermDraft(); autoGrow(); }
  if (term) term.send({ type: "OPEN", agentId: a.id });
  stopPoll(); refreshAvTerm();
  clearTimeout(switchTimer);
  switchTimer = setTimeout(async () => {
    if (!(inPeek() && curId() === a.id)) return;
    const res = await arcade.launchAgent(a.id);
    if (!(inPeek() && curId() === a.id)) return;
    if (res && res.ok) { bus.emit("agents:reload"); const cur = currentAgent(); if (cur && cur.running) arcade.activate(a.id); }
    refreshAvTerm(); startPoll(2500);
  }, 280);
}

// ── interrupt (^C → Esc into the pane). Works from peek and the agent menu. ──
// OPTIMISTIC-WITH-RECONCILIATION: reflect "interrupt sent" on exit-0; a non-zero
// exit surfaces {ok:false,error} as an error (status + toast), never assumed success.
export async function interruptPane() {
  const a = currentAgent(); if (!a) return;
  if (!a.running) { setAvMsg("agent not running", true); return; }
  const res = await arcade.paneKey(a.id, "escape");
  if (res && res.ok === false) {
    const m = "interrupt failed: " + (res.error || "") + (res.code != null ? ` (exit ${res.code})` : "");
    setAvMsg(m, true); bus.emit("toast", { text: m, kind: "error" });
    return;
  }
  setAvMsg("⎋ interrupt sent");
  if (inPeek()) setTimeout(refreshAvTerm, 200);
}

// ── send the prompt into the pane (Enter in the peek). ──
export async function sendTermInput() {
  const a = currentAgent(); const inp = $("av-term-input"); if (!inp) return;
  const text = inp.value;
  if (!a || !text.trim()) return;
  inp.value = ""; clearTermDraft(); autoGrow();
  const res = await arcade.sendText(a.id, text);
  if (res && res.ok === false) {
    const m = "send failed: " + (res.error || "") + (res.code != null ? ` (exit ${res.code})` : "");
    setAvMsg(m, true); bus.emit("toast", { text: m, kind: "error" });
  }
  inp.focus();
  setTimeout(refreshAvTerm, 350);
}

// PgUp/PgDn → send into the pane so Claude scrolls its own history, then re-capture.
export async function pageInPane(key) {
  const a = currentAgent(); if (!a) return;
  await arcade.paneKey(a.id, key);
  setTimeout(refreshAvTerm, 120);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. SYNC — ⌘F full-screen, every-key-to-the-pane. keyEventToBytes ported verbatim.
// ═══════════════════════════════════════════════════════════════════════════════
export function enterSync() {
  if (!inPeek()) return;
  const a = currentAgent(); if (!a || !a.running) { setAvMsg("agent not running", true); return; }
  if (term) term.send({ type: "SYNC.ENTER" });
  const inp = $("av-term-input"); if (inp) inp.blur();
  if (a.running) arcade.activate(a.id);
  startPoll(500);                              // tighter cadence for a live feel
  refreshAvTerm();
  setTimeout(applyTermFont, 60);
}
export function exitSync() {
  if (!inSync()) return;
  if (term) term.send({ type: "SYNC.EXIT" });
  startPoll(2500);
  const inp = $("av-term-input"); if (inp) { inp.focus(); autoGrow(); }
  setTimeout(applyTermFont, 60);
}

const CSI = "\x1b[";
// Translate a browser keydown into the bytes a terminal expects. Returns null = no send.
export function keyEventToBytes(e) {
  const k = e.key;
  switch (k) {
    case "Escape": return "\x1b";
    case "Enter": return "\r";
    case "Backspace": return "\x7f";
    case "Tab": return e.shiftKey ? CSI + "Z" : "\t";
    case "ArrowUp": return CSI + "A";
    case "ArrowDown": return CSI + "B";
    case "ArrowRight": return CSI + "C";
    case "ArrowLeft": return CSI + "D";
    case "Home": return CSI + "H";
    case "End": return CSI + "F";
    case "PageUp": return CSI + "5~";
    case "PageDown": return CSI + "6~";
    case "Delete": return CSI + "3~";
    case "Insert": return CSI + "2~";
  }
  if (/^F([1-9]|1[0-2])$/.test(k)) { // function keys F1–F12
    const map = { F1: "OP", F2: "OQ", F3: "OR", F4: "OS", F5: "15~", F6: "17~", F7: "18~", F8: "19~", F9: "20~", F10: "21~", F11: "23~", F12: "24~" };
    return "\x1b" + (k === "F1" || k === "F2" || k === "F3" || k === "F4" ? map[k] : "[" + map[k]);
  }
  if (k.length === 1) {
    if (e.ctrlKey && !e.metaKey) { // Ctrl+key → control code
      const lc = k.toLowerCase();
      if (lc >= "a" && lc <= "z") return String.fromCharCode(lc.charCodeAt(0) - 96); // ^A..^Z
      if (k === " ") return "\x00";
      const ctrl = { "[": "\x1b", "\\": "\x1c", "]": "\x1d", "^": "\x1e", "_": "\x1f" };
      if (ctrl[k]) return ctrl[k];
      return null;
    }
    if (e.altKey && !e.metaKey) return "\x1b" + k; // Meta/Alt prefix
    if (e.metaKey) return null;                    // leave ⌘ shortcuts to the OS/app
    return k;                                       // a plain printable character
  }
  return null;
}
// keep keystrokes in order despite each one being an async IPC round-trip
let syncChain = Promise.resolve(), syncRefreshTimer = null;
export function syncSend(bytes) {
  const a = currentAgent(); if (!a || !bytes) return;
  syncChain = syncChain.then(() => arcade.paneSend(a.id, bytes)).catch(() => {});
  clearTimeout(syncRefreshTimer);
  syncRefreshTimer = setTimeout(refreshAvTerm, 90); // reflect the result quickly
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. WORKSPACE SHELL — ⌘W. One AAXterm + node-pty PTY per agent, kept alive.
// ═══════════════════════════════════════════════════════════════════════════════
const shells = new Map();   // agentId → { term, fit, host }
function ensureShell(agent) {
  let s = shells.get(agent.id);
  if (s) return s;
  const host = document.createElement("div");
  host.className = "xterm-host";
  $("xterm-mount").appendChild(host);
  const term = new AAXterm.Terminal({
    fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, cursorBlink: true,
    scrollback: 5000, theme: { background: "#06080d", foreground: "#cdd3de", cursor: "#cdd3de" },
  });
  const fit = new AAXterm.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  term.onData((d) => arcade.shellInput(agent.id, d));   // keystrokes → the PTY
  s = { term, fit, host };
  shells.set(agent.id, s);
  return s;
}
function fitShell() {
  const a = currentAgent(); if (!a) return;
  const s = shells.get(a.id); if (!s) return;
  try { s.fit.fit(); arcade.shellResize(a.id, s.term.cols, s.term.rows); } catch {}
}
export function enterShell() {
  if (inShell()) return;
  const a = currentAgent(); if (!a) return;
  if (typeof AAXterm === "undefined") { setAvMsg("terminal library failed to load", true); return; }
  stopPoll();                 // the WezTerm peek isn't visible while the shell is up
  if (term) term.send({ type: "SHELL.ENTER", agentId: a.id });
  const s = ensureShell(a);
  for (const [id, sh] of shells) sh.host.style.display = (id === a.id) ? "block" : "none"; // only this agent's
  requestAnimationFrame(async () => {
    s.fit.fit();
    // OPTIMISTIC-WITH-RECONCILIATION: a failed shellOpen surfaces an error + drops back
    // to the peek (never assume the PTY spawned).
    const res = await arcade.shellOpen(a.id, s.term.cols, s.term.rows);
    if (!res || !res.ok) {
      const m = "workspace shell failed: " + ((res && res.error) || "unknown") + ((res && res.code != null) ? ` (exit ${res.code})` : "");
      setAvMsg(m, true); bus.emit("toast", { text: m, kind: "error" });
      if (term) term.send({ type: "SHELL.EXIT_TO_AGENT" });
      return;
    }
    arcade.shellResize(a.id, s.term.cols, s.term.rows);
    s.term.focus();
    if (pendingShell) setTimeout(flushPendingShell, res.reused ? 80 : 450);
  });
}
export function exitShell() {
  if (!inShell()) return;
  if (term) term.send({ type: "SHELL.EXIT_TO_AGENT" });
  startPoll(2500);
  const inp = $("av-term-input"); if (inp) { inp.focus(); autoGrow(); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. @-COMMAND MACROS — chip bar + keyboard arg picker (select/text/flag).
// ═══════════════════════════════════════════════════════════════════════════════
const MACRO_CHIP_CAP = 8;
let macroPickerOpen = false;
let mp = null;                // { agentId, phase, cmd, ai, sel, values, textVal, list }
let pendingShell = null;      // { line, autoRun } flushed once the workspace shell is ready
export function isMacroPickerOpen() { return macroPickerOpen; }
export function macroPickerState() { return mp; }

function resolveMacroToken(id, tok) {
  const list = commandsFor(id);
  const exact = list.find((c) => c.name === tok); if (exact) return exact;
  const pref = list.filter((c) => c.name.startsWith(tok));
  return pref.length === 1 ? pref[0] : null;
}
export function resolveMacro(id, tok) { return resolveMacroToken(id, tok); }

function renderMacroBar() {
  const a = currentAgent();
  const list = a ? commandsFor(a.id) : [];
  const show = !!a && inPeek() && !isCompose() && list.length > 0;
  const tv = $("term-view"); if (tv) tv.classList.toggle("macros-on", show);
  const barEl = $("macro-bar"); if (!barEl) return;
  if (!show) { barEl.innerHTML = ""; return; }
  const pinned = list.filter((c) => c.pinned);
  const ordered = pinned.length ? pinned : list;
  const shown = ordered.slice(0, MACRO_CHIP_CAP);
  const extra = list.length - shown.length;
  let html = shown.map((c) => `<span class="macro-chip" data-cmd="${esc(c.name)}" title="${esc(c.description)}"><span class="at">@</span>${esc(c.name)}</span>`).join("");
  if (extra > 0) html += `<span class="macro-chip more" data-more="1">+${extra} more</span>`;
  barEl.innerHTML = html;
}

// Resolve a macro ONLY when the entire prompt is exactly "@<name>" (nothing else) and it
// matches a command. This is the single rule for BOTH the blue highlight and execution:
// "@Exec" → match; "@Exec 123" / "@Exec hello" / multi-line → no match.
export function exactPromptMacro(value, agentId) {
  const m = String(value || "").trim().match(/^@([\w-]+)$/);
  return m ? resolveMacroToken(agentId, m[1]) : null;
}
function macroHint() {
  const inp = $("av-term-input"); if (!inp) return;
  if (!inPeek() || isCompose()) { inp.classList.remove("macro-match"); return; }
  const a = currentAgent(); if (!a) { inp.classList.remove("macro-match"); return; }
  // Blue highlight: entire prompt is exactly a matching @command.
  const exact = exactPromptMacro(inp.value, a.id);
  inp.classList.toggle("macro-match", !!exact);
  // Hint line while composing an "@token" (first line only, for the suggestions list).
  const m = (inp.value.split("\n")[0] || "").match(/^\s*@([\w-]*)$/);
  if (!m) return;
  const tok = m[1];
  const hits = commandsFor(a.id).filter((c) => c.name.startsWith(tok));
  if (exact) setAvMsg("@" + exact.name + " — Enter to run");
  else if (hits.length) setAvMsg("@ " + hits.map((c) => c.name).join("  ·  ") + "   — Enter to run");
  else if (tok) setAvMsg(`no @command matches “${tok}”`, true);
  else setAvMsg("@ commands: " + (commandsFor(a.id).length ? "Enter a name" : "none for this agent"));
}

function mpOpen() { macroPickerOpen = true; $("macro-picker").classList.add("on"); mpRender(); }
function mpClose() {
  macroPickerOpen = false; mp = null; $("macro-picker").classList.remove("on");
  if (inPeek()) { const i = $("av-term-input"); if (i) i.focus(); }
}
export function cancelMacroPicker() { if (macroPickerOpen) mpClose(); }
export function startMacro(name) {
  const a = currentAgent(); if (!a) return;
  const cmd = resolveMacroToken(a.id, name);
  if (!cmd) { setAvMsg(`no @command “${name}”`, true); return; }
  mp = { agentId: a.id, phase: cmd.args.length ? "arg" : "confirm", cmd, ai: 0, sel: 0, values: {}, textVal: "" };
  initArgSel(); mpOpen();
}
function openMacroList() {
  const a = currentAgent(); if (!a) return;
  const list = commandsFor(a.id); if (!list.length) return;
  mp = { agentId: a.id, phase: "choose", list, sel: 0, values: {} };
  mpOpen();
}
// flag type: literal token emitted when ON; empty → "--<key>".
function flagToken(arg) { return arg.flag || ("--" + arg.key); }
function initArgSel() {
  if (!mp || mp.phase !== "arg") return;
  const arg = mp.cmd.args[mp.ai];
  if (arg.type === "select") {
    const want = mp.values[arg.key] != null ? mp.values[arg.key] : arg.default;
    const i = arg.options.findIndex((o) => o.value === want);
    mp.sel = i < 0 ? 0 : i;
  } else if (arg.type === "flag") {
    const on = mp.values[arg.key] != null ? !!mp.values[arg.key] : !!arg.default;
    mp.sel = on ? 1 : 0;
  } else {
    mp.textVal = mp.values[arg.key] != null ? mp.values[arg.key] : (arg.default || "");
  }
}
function mpClamp(i, n) { return n ? Math.max(0, Math.min(n - 1, i)) : 0; }
export function mpMove(d) {
  if (!mp) return;
  if (mp.phase === "choose") { mp.sel = mpClamp(mp.sel + d, mp.list.length); mpRender(); return; }
  if (mp.phase !== "arg") return;
  const arg = mp.cmd.args[mp.ai];
  if (arg.type === "select") { mp.sel = mpClamp(mp.sel + d, arg.options.length); mpRender(); }
  else if (arg.type === "flag") { mp.sel = mp.sel ? 0 : 1; mpRender(); } // 2 rows: any move toggles
}
function mpRender() {
  if (!mp) return;
  if (mp.phase === "choose") {
    $("mp-cmd").innerHTML = `<span class="at">@</span>commands`;
    $("mp-title").textContent = "Run a command";
    $("mp-desc").textContent = currentAgent() ? currentAgent().name : "";
    $("mp-body").innerHTML = mp.list.map((c, i) =>
      `<div class="mp-opt ${i === mp.sel ? "sel" : ""}"><span class="at" style="opacity:.5">@</span>${esc(c.name)}<span class="ov">${esc(c.description)}</span></div>`).join("");
    $("mp-foot").innerHTML = `<kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>Enter</kbd> select · <kbd>Esc</kbd> cancel`;
    return;
  }
  const cmd = mp.cmd;
  $("mp-cmd").innerHTML = `<span class="at">@</span>${esc(cmd.name)}`;
  $("mp-title").textContent = cmd.name;
  $("mp-desc").textContent = cmd.description || "";
  if (mp.phase === "arg") {
    const arg = cmd.args[mp.ai], n = cmd.args.length;
    let body = `<div class="mp-step">Step ${mp.ai + 1} of ${n}</div><div class="mp-arglabel">${esc(arg.label)}</div>`;
    if (arg.type === "select") {
      body += arg.options.map((o, i) => `<div class="mp-opt ${i === mp.sel ? "sel" : ""}">${esc(o.label)}<span class="ov">${esc(o.value)}</span></div>`).join("");
      $("mp-body").innerHTML = body;
      $("mp-foot").innerHTML = `<kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>Enter</kbd> next · <kbd>Esc</kbd> cancel`;
    } else if (arg.type === "flag") {
      const rows = [{ label: "Off", ov: "(omitted)" }, { label: "On", ov: flagToken(arg) }];
      body += rows.map((o, i) => `<div class="mp-opt ${i === mp.sel ? "sel" : ""}">${esc(o.label)}<span class="ov">${esc(o.ov)}</span></div>`).join("");
      $("mp-body").innerHTML = body;
      $("mp-foot").innerHTML = `<kbd>↑</kbd><kbd>↓</kbd> toggle · <kbd>Enter</kbd> next · <kbd>Esc</kbd> cancel`;
    } else {
      body += `<input id="mp-input" class="mp-text" spellcheck="false" placeholder="${esc(arg.label)}" />`;
      $("mp-body").innerHTML = body;
      const inp = $("mp-input"); inp.value = mp.textVal || ""; setTimeout(() => inp.focus(), 0);
      $("mp-foot").innerHTML = `<kbd>Enter</kbd> next · <kbd>Esc</kbd> cancel`;
    }
    return;
  }
  // confirm/compose
  const line = composeMacro(cmd, mp.values);
  $("mp-body").innerHTML = `<div class="mp-step">Review</div><div class="mp-compose">${esc(line)}</div>`;
  $("mp-foot").innerHTML = cmd.confirm
    ? `<kbd>Enter</kbd> open in workspace shell (review &amp; ↵ to run) · <kbd>Esc</kbd> cancel`
    : `<kbd>Enter</kbd> run in workspace shell · <kbd>Esc</kbd> cancel`;
}
export function mpAdvance() {
  if (!mp) return;
  if (mp.phase === "choose") {
    const cmd = mp.list[mp.sel]; if (!cmd) return;
    mp.cmd = cmd; mp.ai = 0; mp.values = {}; mp.sel = 0; mp.phase = cmd.args.length ? "arg" : "confirm";
    initArgSel(); mpRender(); return;
  }
  if (mp.phase === "arg") {
    const arg = mp.cmd.args[mp.ai];
    let val;
    if (arg.type === "select") val = arg.options[mp.sel] ? arg.options[mp.sel].value : (arg.default || "");
    else if (arg.type === "flag") val = mp.sel ? flagToken(arg) : "";   // ON → token, OFF → omitted
    else val = (($("mp-input") ? $("mp-input").value : mp.textVal) || "");
    if (arg.type !== "flag" && arg.required && val.trim() === "") return; // flags: OFF is valid
    mp.values[arg.key] = val;
    if (mp.ai < mp.cmd.args.length - 1) { mp.ai++; mp.sel = 0; mp.textVal = ""; initArgSel(); mpRender(); return; }
    mp.phase = "confirm"; mpRender(); return;
  }
  // confirm → run
  const cmd = mp.cmd, line = composeMacro(cmd, mp.values), autoRun = !cmd.confirm;
  mpClose();
  runMacroInShell(line, autoRun);
}

// compose: fill {tokens}. Path tokens → shell expansions; arg values → single-quoted
// (select/text) so free-text can't break the line; flags emit their RAW token.
export function mpShq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function fillTemplate(tpl, values, args) {
  const byKey = Object.create(null);
  (args || []).forEach((a) => { byKey[a.key] = a; });
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => {
    if (k === "home") return "$HOME";
    if (k === "workspace") return '"${CLAUDE_CWD:-$HOME/workspace}"';
    if (k === "config") return '"${AGENT_ARCADE_HOME:-$HOME/.hv}"';
    if (Object.prototype.hasOwnProperty.call(values, k)) {
      const v = values[k];
      if (byKey[k] && byKey[k].type === "flag") return v ? String(v) : "";  // flag: RAW token (ON) or "" (OFF)
      return mpShq(v);                                                       // select/text: single-quoted
    }
    return m;
  });
}
export function composeMacro(cmd, values) {
  const run = fillTemplate(cmd.run, values, cmd.args);
  const cwd = cmd.cwd ? fillTemplate(cmd.cwd, values, cmd.args) : "";
  return cwd ? `cd ${cwd} && ${run}` : run;
}

// execute: drop the composed line into the agent's workspace shell. confirm:true →
// type WITHOUT Enter (operator reviews + ↵); else auto-run.
function runMacroInShell(line, autoRun) {
  const a = currentAgent(); if (!a) return;
  pendingShell = { line, autoRun };
  if (inShell() && shells.has(a.id)) flushPendingShell();
  else enterShell();          // opens the shell; flush once it's ready
}
function flushPendingShell() {
  const a = currentAgent(); if (!a || !pendingShell) return;
  const { line, autoRun } = pendingShell; pendingShell = null;
  if (!shells.has(a.id)) return;
  arcade.shellInput(a.id, line + (autoRun ? "\r" : ""));
  setAvMsg(autoRun ? "running in workspace shell…" : "command ready in workspace shell — ↵ to run");
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. COMPOSE (⌘E) — the expanded editor (peek sub-mode).
// ═══════════════════════════════════════════════════════════════════════════════
export function toggleCompose(on) {
  if (!inPeek()) return;
  if (term) term.send({ type: "COMPOSE.TOGGLE", on });
  const inp = $("av-term-input"); if (!inp) return;
  inp.style.height = "";
  applyComposeSplit();
  if (inp) inp.focus();
  if (!isCompose()) inp.scrollTop = 0;
  setTimeout(applyTermFont, 160);
}
let composeEditorPct = 60;
export function setComposeSplit(pct) { if (Number.isFinite(pct)) { composeEditorPct = pct; if (isCompose()) applyComposeSplit(); } }
function applyComposeSplit() {
  const inp = $("av-term-input"), termEl = $("av-term");
  if (isCompose()) { inp.style.flexGrow = String(composeEditorPct); termEl.style.flexGrow = String(100 - composeEditorPct); }
  else { inp.style.flexGrow = ""; termEl.style.flexGrow = ""; }
}
function autoGrow() {
  const inp = $("av-term-input"); if (!inp) return;
  if (isCompose()) return;
  inp.style.height = "";
  inp.scrollTop = 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. PEEK REFRESH — poll getText → ANSI→HTML scrape (centered). Ported verbatim.
// ═══════════════════════════════════════════════════════════════════════════════
let avTermTimer = null;
function stopPoll() { if (avTermTimer) { clearInterval(avTermTimer); avTermTimer = null; } }
function startPoll(ms) { stopPoll(); avTermTimer = setInterval(refreshAvTerm, ms); }
let lastTermRaw = "", paneCols = 0, paneRows = 0;
async function refreshAvTerm() {
  const a = currentAgent(); if (!a) return;
  const res = await arcade.getText(a.id);
  if (!res || !res.ok) { setAvMsg(res && res.error ? res.error : "no terminal", true); return; }
  if (res.cols) paneCols = res.cols;
  if (res.rows) paneRows = res.rows;
  const out = $("av-term"); if (!out) return;
  const raw = (res.text || "").replace(/\r/g, "").replace(/\n$/, "");
  if (raw !== lastTermRaw) {
    lastTermRaw = raw;
    const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 24;
    const prev = out.scrollTop;
    out.innerHTML = "<div class=\"av-term-inner\">" + ansiToHtml(raw) + "</div>";
    if (isCompose()) out.scrollTop = atBottom ? out.scrollHeight : prev;
  }
  applyTermFont();
}

// scale the terminal so the pane's full grid (cols×rows) fits the box; compose = fixed strip.
let cwPerPx = 0;
function charWidthPerPx() {
  if (cwPerPx) return cwPerPx;
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font-size:50px;font-family:" + getComputedStyle($("av-term")).fontFamily;
  probe.textContent = "M".repeat(80);
  document.body.appendChild(probe);
  cwPerPx = probe.getBoundingClientRect().width / 80 / 50;
  probe.remove();
  return cwPerPx;
}
function applyTermFont() {
  const out = $("av-term"); if (!out) return;
  if (isCompose()) { out.style.fontSize = "12px"; out.style.lineHeight = "1.45"; out.style.whiteSpace = "pre-wrap"; out.style.overflow = "auto"; return; }
  if (!paneCols || !paneRows) return;
  const boxW = out.clientWidth - 26, boxH = out.clientHeight - 22;
  if (boxW <= 0 || boxH <= 0) return;
  const fs = Math.max(6, Math.min(boxW / (paneCols * charWidthPerPx()), boxH / (paneRows * 1.2)) * 0.985);
  out.style.fontSize = fs.toFixed(2) + "px";
  out.style.lineHeight = "1.2";
  out.style.whiteSpace = "pre";
  out.style.overflow = "hidden";
  maybePersistViewRatio();
}
let lastSavedRatio = null;
function maybePersistViewRatio() {
  const out = $("av-term"); if (!out) return;
  const w = out.clientWidth, h = out.clientHeight, winW = window.innerWidth, winH = window.innerHeight;
  if (!w || !h || !winW || !winH) return;
  const rw = +(w / winW).toFixed(4), rh = +(h / winH).toFixed(4);
  if (lastSavedRatio && Math.abs(lastSavedRatio.w - rw) < 0.004 && Math.abs(lastSavedRatio.h - rh) < 0.004) return;
  lastSavedRatio = { w: rw, h: rh };
  if (arcade.saveViewRatio) arcade.saveViewRatio(rw, rh);
}

// ── ANSI (SGR) → HTML, so the pane's colors render like WezTerm. Ported verbatim. ──
const ANSI_FG = { 30: "#3f4451", 31: "#e06c75", 32: "#98c379", 33: "#e5c07b", 34: "#61afef", 35: "#c678dd", 36: "#56b6c2", 37: "#abb2bf",
  90: "#5c6370", 91: "#e06c75", 92: "#98c379", 93: "#e5c07b", 94: "#61afef", 95: "#c678dd", 96: "#56b6c2", 97: "#ffffff" };
const ANSI_BG = { 40: "#3f4451", 41: "#e06c75", 42: "#98c379", 43: "#e5c07b", 44: "#61afef", 45: "#c678dd", 46: "#56b6c2", 47: "#abb2bf",
  100: "#5c6370", 101: "#e06c75", 102: "#98c379", 103: "#e5c07b", 104: "#61afef", 105: "#c678dd", 106: "#56b6c2", 107: "#ffffff" };
function xterm256(i) {
  if (i < 16) return (ANSI_FG[i < 8 ? 30 + i : 82 + i]) || "#abb2bf";
  if (i >= 232) { const v = 8 + (i - 232) * 10; return `rgb(${v},${v},${v})`; }
  i -= 16; const r = Math.floor(i / 36), g = Math.floor((i % 36) / 6), b = i % 6;
  const ch = (x) => (x ? x * 40 + 55 : 0);
  return `rgb(${ch(r)},${ch(g)},${ch(b)})`;
}
function ansiToHtml(input) {
  let fg = null, bg = null, bold = false, dim = false, html = "", buf = "", i = 0;
  const n = input.length;
  const escHtml = (t) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const flush = () => {
    if (!buf) return;
    let st = "";
    if (fg) st += `color:${fg};`;
    if (bg) st += `background:${bg};`;
    if (bold) st += "font-weight:700;";
    if (dim) st += "opacity:.6;";
    html += st ? `<span style="${st}">${escHtml(buf)}</span>` : escHtml(buf);
    buf = "";
  };
  const applySGR = (params) => {
    const parts = params === "" ? ["0"] : params.split(";");
    for (let k = 0; k < parts.length; k++) {
      const p = parts[k];
      if (p.indexOf(":") >= 0) {
        const s = p.split(":"), head = parseInt(s[0], 10), mode = parseInt(s[1], 10), tgt = head === 38;
        if (head === 38 || head === 48) {
          if (mode === 2) { const [r, g, b] = s.slice(2).filter((x) => x !== "").map((x) => parseInt(x, 10) || 0).slice(-3); const col = `rgb(${r || 0},${g || 0},${b || 0})`; tgt ? (fg = col) : (bg = col); }
          else if (mode === 5) { const col = xterm256(parseInt(s[2], 10) || 0); tgt ? (fg = col) : (bg = col); }
        }
        continue;
      }
      const c = parseInt(p || "0", 10);
      if (c === 0) { fg = bg = null; bold = dim = false; }
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) { bold = dim = false; }
      else if (c === 39) fg = null;
      else if (c === 49) bg = null;
      else if (ANSI_FG[c]) fg = ANSI_FG[c];
      else if (ANSI_BG[c]) bg = ANSI_BG[c];
      else if (c === 38 || c === 48) {
        const tgt = c === 38, mode = parseInt(parts[k + 1], 10);
        if (mode === 5) { const col = xterm256(parseInt(parts[k + 2], 10) || 0); tgt ? (fg = col) : (bg = col); k += 2; }
        else if (mode === 2) { const col = `rgb(${parseInt(parts[k + 2], 10) || 0},${parseInt(parts[k + 3], 10) || 0},${parseInt(parts[k + 4], 10) || 0})`; tgt ? (fg = col) : (bg = col); k += 4; }
      }
    }
  };
  while (i < n) {
    const ch = input[i];
    if (ch === "\x1b") {
      if (input[i + 1] === "[") {
        let j = i + 2; while (j < n && !/[A-Za-z]/.test(input[j])) j++;
        if (input[j] === "m") { flush(); applySGR(input.slice(i + 2, j)); }
        i = j + 1; continue;
      }
      if (input[i + 1] === "]") { let j = i + 2; while (j < n && input[j] !== "\x07" && !(input[j] === "\x1b" && input[j + 1] === "\\")) j++; i = input[j] === "\x07" ? j + 1 : j + 2; continue; }
      if (input[i + 1] === "(" || input[i + 1] === ")") { i += 3; continue; }
      i += 2; continue;
    }
    buf += ch; i++;
  }
  flush();
  return html;
}
