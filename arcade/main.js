// Agent Arcade — the fullscreen "video-game" surface, now a MODULE of the Studio
// process (not a separate app/process). Studio's main.js requires this file and
// calls openArcade() to create the fullscreen window IN-PROCESS. Running in the
// same process as Studio means one macOS TCC identity: the System Events
// (Automation) permission granted to the app applies to the Arcade too — a
// detached child process couldn't reliably inherit it.
//
// It reuses the shared binaries (go/bin/dictation-go for the API, wezterm-bridge for
// routing) and the same ~/.hv/agent-arcade.yaml Studio writes. Mic capture stays
// in the renderer (TCC). Exports: openArcade(), onArcadeClosed(cb).

const { app, BrowserWindow, ipcMain, screen, shell, globalShortcut } = require("electron");
const { spawn, execFile } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const readline = require("readline");
const yaml = require("js-yaml");

const ROOT = path.join(__dirname, "..");
// Bundled native binaries can't run from inside app.asar (asarUnpack in the build
// config); rewrite to the unpacked copy. No-op in dev.
const unpacked = (p) => p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
const GO_BIN = unpacked(path.join(ROOT, "go", "bin", "dictation-go"));
const WEZ_BRIDGE = unpacked(path.join(ROOT, "wezterm-bridge", "bin", "wezterm-bridge"));
// Official prebuilt WezTerm.app, packed into the npm tarball at publish time (see
// .github/workflows/publish.yml). Preferred so a fresh `npm i -g` works with no
// system WezTerm; absent in local dev → resolvers fall back to a system install.
const WEZTERM_APP_BIN = unpacked(path.join(ROOT, "vendor", "wezterm", "WezTerm.app", "Contents", "MacOS"));
// App-managed WezTerm config (agent-colored/faded tabs + the shared unix mux).
// Shipped with the app and loaded ONLY for WezTerm processes we launch, so the
// user's own ~/.wezterm.lua is never touched. Threaded into every wezterm
// subprocess via WEZTERM_CONFIG_FILE (and --config-file on the GUI).
const AA_WEZTERM_CONFIG = unpacked(path.join(ROOT, "wezterm", "agent-arcade.wezterm.lua"));
const weztermEnv = () => ({ ...process.env, WEZTERM_BIN, WEZTERM_CONFIG_FILE: AA_WEZTERM_CONFIG });
// Dev build uses a separate settings file (matches Studio). DICTATE_DEV is
// inherited from the Studio that spawned this Arcade, so they read the same file.
const SETTINGS = path.join(os.homedir(), ".hv", process.env.DICTATE_DEV ? "agent-arcade.dev.yaml" : "agent-arcade.yaml");
// Carry over the legacy dictate-settings*.yaml filename if Studio hasn't yet.
try {
  const legacy = path.join(os.homedir(), ".hv", process.env.DICTATE_DEV ? "dictate-settings.dev.yaml" : "dictate-settings.yaml");
  if (!fs.existsSync(SETTINGS) && fs.existsSync(legacy)) fs.renameSync(legacy, SETTINGS);
} catch {}
const CLAUDE_CWD = process.env.CLAUDE_CWD || path.join(os.homedir(), "workspace");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const WEZTERM_BIN = resolveWezterm();

function resolveWezterm() {
  if (process.env.WEZTERM_BIN) return process.env.WEZTERM_BIN;
  for (const p of [path.join(WEZTERM_APP_BIN, "wezterm"), "/opt/homebrew/bin/wezterm", "/usr/local/bin/wezterm"]) { try { if (fs.existsSync(p)) return p; } catch {} }
  return "wezterm";
}

// A GUI-launched app has a minimal PATH and the pane runs via `bash -lc` (whose PATH
// comes from /etc/profile, not the user's zsh), so `claude` isn't found and the pane
// dies on spawn. Resolve an ABSOLUTE path so it runs regardless. Mirrors Studio.
const CLAUDE_BIN = resolveClaude();
function resolveClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const home = os.homedir();
  for (const p of [
    path.join(home, ".local/bin/claude"),
    path.join(home, ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ]) { try { if (fs.existsSync(p)) return p; } catch {} }
  try {
    const sh = process.env.SHELL || "/bin/zsh";
    const out = require("child_process")
      .execFileSync(sh, ["-lic", "command -v claude"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n").pop().trim();
    if (out && fs.existsSync(out)) return out;
  } catch {}
  return "claude";
}

let win = null, go = null, jobSeq = 0;
let onClosed = null; // Studio sets this via onArcadeClosed() to resurface when the Arcade closes
const pending = {}; // jobId -> { agentId }
// Dictation availability is OWNED by Studio's main.js (it does the single probe);
// it pushes the result here via broadcastDictation(). We cache it so (a) the Arcade
// renderer can read it on load and (b) spawnGo can gate the bridge. Fails closed.
let dictationState = { available: false, caps: null };

function toRenderer(ch, payload) { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }
// Called by Studio's main process when the probe result changes — cache it and
// forward to the Arcade renderer so it re-gates the dictation UI live (no restart).
function broadcastDictation(payload) {
  dictationState = { available: !!(payload && payload.available), caps: (payload && payload.caps) || null };
  toRenderer("dictation:available", dictationState);
  // If the Arcade is already up and the bridge wasn't started yet (e.g. the probe
  // resolved after an arcade-only launch), start it now that dictation is available.
  if (dictationState.available && goStarted && (!go || go.killed)) spawnGo();
}

// ── shared YAML store (read-only here) ─────────────────────────────────────────
function readDoc() {
  try { if (fs.existsSync(SETTINGS)) return yaml.load(fs.readFileSync(SETTINGS, "utf8")) || {}; } catch {}
  return {};
}
// DGX Spark API base URL — REQUIRED in the shared YAML (`api_url:`). No host is
// hardcoded; the env var only acts as a dev override. Empty string = not configured.
function loadApiUrl() {
  return (readDoc().api_url || "").toString().trim() || (process.env.DICTATION_API_URL || "").trim();
}
// global app settings (shared YAML `app:` block; written by Agent Arcade Studio).
// compose_split = % of the ⌘E compose view given to the editor (rest = terminal).
function clampSplit(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(20, Math.min(80, n)) : 60; }
function clampInt(v, lo, hi, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; }
function loadApp() {
  const a = readDoc().app || {};
  // sync + warn_on_exit default ON (uncheck to opt out); split clamped 20–80.
  // dictation_tail_ms / dictation_pad_ms = end-of-speech timing buffers read live by the Arcade.
  return {
    sync_wezterm_tabs: a.sync_wezterm_tabs !== false,
    warn_on_exit: a.warn_on_exit !== false,
    compose_split: clampSplit(a.compose_split),
    dictation_tail_ms: clampInt(a.dictation_tail_ms, 0, 1500, 250),
    dictation_pad_ms: clampInt(a.dictation_pad_ms, 0, 1000, 200),
  };
}
function loadWezterm() {
  const w = readDoc().wezterm || {};
  const cols = parseInt(w.cols, 10), rows = parseInt(w.rows, 10);
  return { cols: cols > 0 ? cols : 0, rows: rows > 0 ? rows : 0 };
}
function loadAgents() {
  const list = Array.isArray(readDoc().agents) ? readDoc().agents : [];
  // Honor the drag-and-drop order set in Studio: stable sort by `order` so the rail
  // renders agents (within their groups) in the user's chosen order.
  return list.map((a) => ({
    id: String(a.id || ""), name: String(a.name || ""), color: String(a.color || ""),
    cwd: String(a.cwd || ""), pane_id: parseInt(a.pane_id, 10) || 0,
    system_id: String(a.system_id || ""), session_id: String(a.session_id || ""),
    group_id: String(a.group_id || ""),       // "" = built-in Default group
    active: a.active === undefined ? true : !!a.active, // false = hidden in the Arcade
    order: Number.isFinite(parseInt(a.order, 10)) ? parseInt(a.order, 10) : 0, // drag-and-drop sort position
    avatar_status: ["pending", "ready", "failed"].includes(a.avatar_status) ? a.avatar_status : "",
    seed: parseInt(a.seed, 10) || 0,          // for the aaimg cache-bust
    program: String(a.program || "claude"),
    text_cleanup: a.text_cleanup !== false,
    dictation_options: Array.isArray(a.dictation_options) ? a.dictation_options.map(String) : [], // per-agent cleanup tweaks
    esc_before_send: a.esc_before_send !== false,
    esc_delay_ms: parseInt(a.esc_delay_ms, 10) || 50,
  })).map((a, i) => ({ a, i })).sort((x, y) => (x.a.order - y.a.order) || (x.i - y.i)).map((x) => x.a);
}
function loadSystems() {
  const list = Array.isArray(readDoc().systems) ? readDoc().systems : [];
  return list.map((s) => ({ id: String(s.id || ""), name: String(s.name || ""), os: s.os || "mac" }));
}
function loadGroups() {
  const list = Array.isArray(readDoc().groups) ? readDoc().groups : [];
  return list
    .map((g) => ({ id: String(g.id || ""), name: String(g.name || ""), order: parseInt(g.order, 10) || 0, active: g.active === undefined ? true : !!g.active }))
    .sort((a, b) => a.order - b.order);
}
// @-command macros (operator shortcuts). Agent-scoped (agent_id "" = global). The
// renderer composes `cd <cwd> && <run>` (filling {placeholders}) and runs it in the
// agent's workspace shell. Validation here is light; the UI does the picking.
// Macro arg types. We accept friendly aliases so a hand-edited YAML doesn't
// silently fall back to "select": anything unrecognized stays a select (the
// historical default). "flag" = ON/OFF toggle that emits a literal token;
// "text" = free user-defined value; "select" = pick from `options`.
function argType(t) {
  switch (String(t || "").toLowerCase()) {
    case "flag": case "bool": case "boolean": case "toggle": case "switch": return "flag";
    case "text": case "input": case "string": case "value": case "freetext": case "free": return "text";
    default: return "select";
  }
}
function loadCommands() {
  const list = Array.isArray(readDoc().commands) ? readDoc().commands : [];
  return list.map((c) => ({
    id: String(c.id || ""),
    agent_id: String(c.agent_id || ""),                 // "" = global (every agent)
    name: String(c.name || ""),                         // invoked as @name
    description: String(c.description || ""),
    cwd: String(c.cwd || ""),
    run: String(c.run || ""),
    confirm: c.confirm === undefined ? true : !!c.confirm,
    pinned: !!c.pinned,
    args: Array.isArray(c.args) ? c.args.map((a) => {
      const type = argType(a.type);
      return {
        key: String(a.key || ""),
        label: String(a.label || a.key || ""),
        type,                                             // "select" | "text" | "flag"
        // flags are optional by nature (OFF is a valid answer); others default to required
        required: type === "flag" ? !!a.required : (a.required === undefined ? true : !!a.required),
        // flag default is a boolean (ON/OFF); select/text default is a string value
        default: type === "flag" ? !!a.default : (a.default === undefined ? "" : String(a.default)),
        // flag type only: the literal token emitted when ON (e.g. "--force" or bare "force").
        // Empty → the renderer falls back to "--<key>".
        flag: String(a.flag || ""),
        options: Array.isArray(a.options)
          ? a.options.map((o) => ({ value: String(o.value), label: String(o.label || o.value) }))
          : [],
      };
    }) : [],
  })).filter((c) => c.name && c.run);
}
// An agent's enabled dictation-option keys as a CSV — the `dictation_options` arg
// sent to the API. Options are PER AGENT now; the server reorders/validates keys, so
// order here doesn't matter. (Only used when the agent has text_cleanup on.)
function agentOptionsCSV(agent) {
  const sel = Array.isArray(agent && agent.dictation_options) ? agent.dictation_options : [];
  return sel.join(",");
}
// write-back: the arcade can now open sessions, so it must persist pane_id/session_id.
// Patch the raw agent object in place to preserve every other field (and other blocks).
const SETTINGS_HEADER = "# Agent Arcade settings — agents + systems + dictation options. Hand-editable.\n";
function writeDoc(doc) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, SETTINGS_HEADER + yaml.dump(doc, { lineWidth: 100 }));
}
// ── mux identity ────────────────────────────────────────────────────────────────
// A WezTerm pane id is only meaningful within ONE mux-server lifetime; the server
// never reuses ids while it lives. So a stored pane_id can only point at the WRONG
// pane if the mux RESTARTED (reboot / logout / crash) and an unrelated pane took
// that id. We pin pane_ids to the mux's process id: when it changes, every stored
// pane_id is from a dead mux → clear them all (agents respawn fresh + `claude
// --resume`). A plain app/process restart keeps the same mux → ids preserved.
function muxPid() {
  try {
    const out = require("child_process").execFileSync("pgrep", ["-f", "wezterm-mux-server"], { encoding: "utf8" });
    return (out || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
  } catch { return ""; } // pgrep exits non-zero when there is no match
}
function reconcileMux() {
  const cur = muxPid(); if (!cur) return;            // no mux up yet → nothing to reconcile
  const doc = readDoc();
  const prev = String(doc.mux_id || "");
  if (prev === cur) return;                          // same mux → stored pane ids still valid
  // Only a KNOWN, different previous mux means the ids are stale. A first run with no
  // recorded mux just adopts the current one (live ids are still validated normally),
  // so we don't orphan panes already running in this mux.
  let cleared = false;
  if (prev && Array.isArray(doc.agents)) doc.agents.forEach((a) => { if (a.pane_id) { a.pane_id = 0; cleared = true; } });
  doc.mux_id = cur;
  writeDoc(doc);
  console.error(`[mux] ${prev ? (cleared ? "changed → cleared stale pane ids" : "changed") : "baseline set"} (mux=${cur})`);
}
function patchAgentRaw(id, fields) {
  const doc = readDoc();
  if (!Array.isArray(doc.agents)) return;
  const a = doc.agents.find((x) => String(x.id) === String(id));
  if (!a) return;
  Object.assign(a, fields);
  writeDoc(doc);
}
// Claude only writes ~/.claude/projects/<proj>/<id>.jsonl after a real exchange, so a
// never-used session id can't be --resume'd. Existence decides resume vs fresh start.
function sessionPersisted(sessionId) {
  if (!sessionId) return false;
  const base = path.join(os.homedir(), ".claude", "projects");
  try { for (const d of fs.readdirSync(base)) if (fs.existsSync(path.join(base, d, sessionId + ".jsonl"))) return true; } catch {}
  return false;
}

// ── shared mux (headless) + optional GUI "watch" window ────────────────────────
function resolveWeztermGui() {
  for (const p of [path.join(WEZTERM_APP_BIN, "wezterm-gui"),
                   "/opt/homebrew/bin/wezterm-gui", "/usr/local/bin/wezterm-gui",
                   "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui"]) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}
// The functional path needs only a reachable mux — no GUI. `wezterm cli` auto-starts
// a headless wezterm-mux-server, so a successful pane-ids means the mux is up.
async function ensureMux() {
  for (let i = 0; i < 10; i++) {
    try { await runWez(["pane-ids"]); reconcileMux(); return true; } catch {}
    await delay(400);
  }
  return false;
}
// Is a GUI window attached to the shared mux? Returns the client (with
// focused_pane_id) or null — this is how we know there's a visible "watch" terminal.
function guiAttached() {
  return new Promise((res) => {
    execFile(WEZTERM_BIN, ["cli", "list-clients", "--format", "json"], { env: weztermEnv() },
      (e, out) => { if (e) return res(null); try { const c = JSON.parse(out); res(Array.isArray(c) && c.length ? c[0] : null); } catch { res(null); } });
  });
}
function listJson() {
  return new Promise((res) => execFile(WEZTERM_BIN, ["cli", "list", "--format", "json"], { env: weztermEnv(), maxBuffer: 8 << 20 },
    (e, out) => { if (e) return res([]); try { res(JSON.parse(out)); } catch { res([]); } }));
}
// Focus the agent's colored tab in the watch window (activate-tab by the pane's tab
// id reliably switches the *visible* tab — activate-pane alone may not across tabs).
async function activateAgentTab(paneId) {
  const p = (await listJson()).find((x) => x.pane_id === paneId);
  if (p && Number.isFinite(p.tab_id)) {
    await new Promise((res) => execFile(WEZTERM_BIN, ["cli", "activate-tab", "--tab-id", String(p.tab_id)], { env: weztermEnv() }, () => res()));
  } else { try { await runWez(["activate", "-pane", String(paneId)]); } catch {} }
}
// `--position` AND Lua `window:set_position` are both ignored for mux-connected
// windows (verified), so macOS Accessibility (System Events) is the only thing that
// actually moves the watch window. AX uses the same coord space as Electron's
// display bounds (incl. a monitor placed above the primary, i.e. negative y).
function axMove(x, y) {
  const script = `tell application "System Events" to tell (first process whose name contains "wezterm") to set position of front window to {${x}, ${y}}`;
  return new Promise((res) => execFile("osascript", ["-e", script], (e, _o, se) =>
    res({ ok: !e, denied: /-1743|not allow|not authoriz/i.test(String(se || "")) })));
}
// After an AX move the window often keeps drawing at its OLD spot until it's
// activated (macOS defers the recomposite while another app is frontmost). Bring
// WezTerm forward to force the redraw onto the chosen monitor.
function axActivate() {
  const script = `tell application "System Events" to set frontmost of (first process whose name contains "wezterm") to true`;
  return new Promise((res) => execFile("osascript", ["-e", script], () => res()));
}
function axPos() {
  const script = `tell application "System Events" to tell (first process whose name contains "wezterm") to get position of front window`;
  return new Promise((res) => execFile("osascript", ["-e", script], (e, out) => {
    if (e) return res(null);
    const m = String(out).match(/(-?\d+)\s*,\s*(-?\d+)/);
    res(m ? { x: +m[1], y: +m[2] } : null);
  }));
}
// Returns { ok, reason }. Driving System Events from Electron needs *Automation*
// permission ("<app> wants to control System Events"), NOT the Accessibility API —
// so we don't pre-check a flag (that checks the wrong permission and can misreport).
// Instead we attempt the move and VERIFY by reading the position back: the attempt
// itself triggers the macOS Automation prompt the first time, and the read-back
// tells us definitively whether the window actually landed on the chosen monitor.
async function positionWatchWindow() {
  // Bring WezTerm forward FIRST so the move targets the right (frontmost) window
  // and the window surfaces from behind the fullscreen Arcade.
  await axActivate();
  await delay(150);
  const d = readDoc().watch_display || {};
  if (!Number.isFinite(d.monitor_x)) return { ok: true }; // no monitor configured → leave it
  const x = Math.round(d.monitor_x), y = Math.round(d.monitor_y);
  // Retry and confirm by reading the position back (X within tolerance = right monitor).
  for (let i = 0; i < 6; i++) {
    const m = await axMove(x, y);
    if (m.denied) {
      // Not authorized → bail immediately. Firing the full retry loop here would
      // stack 6 Automation prompts (the "multiple allow popups" bug). Nudge to the
      // settings pane once; the renderer shows a sticky message.
      if (!axSettingsOpened) {
        axSettingsOpened = true;
        try { shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"); } catch {}
      }
      return { ok: false, reason: "permission" };
    }
    await delay(200);
    const p = await axPos();
    if (p && Math.abs(p.x - x) <= 40) { await axActivate(); return { ok: true }; }
  }
  // Granted, but the window didn't land where asked (rare). Not a permission issue,
  // so don't nag about System Events.
  return { ok: false, reason: "position" };
}
let axSettingsOpened = false;
// Pop out (or focus) the GUI watch window on the configured monitor, showing this
// agent's tab. If a GUI is already attached we just activate the tab (orange→red).
async function popOut(agentId, force = false) {
  if (!(await ensureMux())) return { ok: false, error: "mux unavailable" };
  let ag = loadAgents().find((a) => a.id === agentId);
  if (!ag) return { ok: false, error: "agent not found" };
  // Auto-resume: ⌘P on a stopped agent should open its session first, then pop out
  // (mirrors Studio's Resume). Also self-heals a stale pane_id whose pane has died.
  let live = false;
  if (ag.pane_id) {
    try { live = (await runWez(["pane-ids"])).split("\n").map((s) => parseInt(s.trim(), 10)).includes(ag.pane_id); } catch {}
  }
  if (!live) {
    const r = await launchAgentById(agentId);
    if (!r.ok) return { ok: false, error: r.error || "could not start agent" };
    ag = loadAgents().find((a) => a.id === agentId) || ag; // reload to pick up the new pane_id
  }
  let client = await guiAttached();
  const fresh = !client;
  if (!client) {
    const gui = resolveWeztermGui();
    if (!gui) return { ok: false, error: "wezterm-gui not found" };
    const { cols, rows } = loadWezterm();
    // --config-file (our app-managed config) must precede the `connect` subcommand.
    const args = ["--config-file", AA_WEZTERM_CONFIG];
    if (cols && rows) args.push("--config", `initial_cols=${cols}`, "--config", `initial_rows=${rows}`);
    args.push("connect", "unix");
    try { spawn(gui, args, { detached: true, stdio: "ignore", env: weztermEnv() }).unref(); } catch (e) { return { ok: false, error: e.message }; }
    for (let i = 0; i < 20; i++) { await delay(400); client = await guiAttached(); if (client) break; }
    if (!client) return { ok: false, error: "watch window did not attach" };
  }
  await activateAgentTab(ag.pane_id);                              // focus the colored agent tab
  if (fresh) await delay(300);                                    // let a freshly-spawned window materialize
  // Place the watch window on the configured monitor when it's FRESHLY attached, or
  // when the user explicitly asks (⌘P, force=true). We deliberately do NOT re-move
  // it on every dictate — repeated System Events moves spam Automation prompts and
  // throw a scary "couldn't be moved" toast mid-dictation. Dictation only needs the
  // window visible (it is); placement is the job of the explicit ⌘P.
  let placement = { ok: true };
  if (fresh || force) placement = await positionWatchWindow();
  if (win && !win.isDestroyed()) { win.show(); app.focus({ steal: true }); } // hand keys back to the arcade
  let warning;
  if (force && !placement.ok && placement.reason === "permission") {
    warning = "Terminal popped out, but couldn't be moved to your chosen monitor.\n\n" +
      "Fix: System Settings → Privacy & Security → Automation → turn ON \"System Events\" under \"Agent Arcade\", " +
      "then FULLY QUIT and relaunch Agent Arcade (the macOS permission only takes effect on a fresh launch).";
  }
  return { ok: true, warning };
}
ipcMain.handle("arcade:popOut", (_e, payload) => {
  const p = payload && typeof payload === "object" ? payload : { agentId: payload };
  return popOut(p.agentId, !!p.force);
});

// ── workspace shell (xterm.js front-end ↔ node-pty back-end) ─────────────────────
// ⌘W in the terminal view opens a REAL interactive shell in the agent's workspace
// folder, rendered by xterm.js — separate from the agent's WezTerm pane. One PTY
// per agent, kept alive for the Arcade session so ⌘A/⌘W preserve scrollback and any
// running process. node-pty is a native module (electron-rebuild); if it failed to
// load we degrade gracefully and the renderer surfaces the error.
let nodePty = null;
try { nodePty = require("node-pty"); } catch (e) { console.error("[arcade] node-pty unavailable:", e.message); }
const shells = new Map(); // agentId → pty process

function resolveShellCwd(agent) {
  let cwd = (agent && agent.cwd) || CLAUDE_CWD;
  if (cwd.startsWith("~")) cwd = path.join(os.homedir(), cwd.slice(1));
  try { if (!fs.statSync(cwd).isDirectory()) cwd = os.homedir(); } catch { cwd = os.homedir(); }
  return cwd;
}

ipcMain.handle("arcade:shellOpen", (_e, payload) => {
  const p = (payload && typeof payload === "object") ? payload : {};
  const agentId = p.agentId;
  if (!nodePty) return { ok: false, error: "node-pty unavailable — run \"npm run rebuild\"" };
  const agent = loadAgents().find((a) => a.id === agentId);
  if (!agent) return { ok: false, error: "agent not found" };
  if (shells.has(agentId)) return { ok: true, reused: true, cwd: resolveShellCwd(agent) };
  const cwd = resolveShellCwd(agent);
  const shellPath = process.env.SHELL || "/bin/zsh";
  const cols = Math.max(20, parseInt(p.cols, 10) || 80);
  const rows = Math.max(5, parseInt(p.rows, 10) || 24);
  let proc;
  try {
    proc = nodePty.spawn(shellPath, [], { name: "xterm-256color", cols, rows, cwd, env: { ...process.env, TERM: "xterm-256color" } });
  } catch (e) { return { ok: false, error: e.message }; }
  proc.onData((data) => toRenderer("arcade:shellData", { agentId, data }));
  proc.onExit(() => { shells.delete(agentId); toRenderer("arcade:shellExit", { agentId }); });
  shells.set(agentId, proc);
  return { ok: true, cwd };
});

ipcMain.handle("arcade:shellInput", (_e, payload) => {
  const p = payload || {};
  const proc = shells.get(p.agentId);
  if (proc && typeof p.data === "string") proc.write(p.data);
  return { ok: !!proc };
});

ipcMain.handle("arcade:shellResize", (_e, payload) => {
  const p = payload || {};
  const proc = shells.get(p.agentId);
  if (proc) { try { proc.resize(Math.max(20, p.cols | 0), Math.max(5, p.rows | 0)); } catch {} }
  return { ok: !!proc };
});

function killShells() { for (const proc of shells.values()) { try { proc.kill(); } catch {} } shells.clear(); }

// ── shared binaries ────────────────────────────────────────────────────────────
function spawnGo() {
  // Gate on availability (Studio's probe): no reachable/ready backend → no bridge.
  if (!dictationState.available) return;
  const apiUrl = loadApiUrl();
  if (!apiUrl) {
    toRenderer("status", { state: "error", msg: `No API URL configured — set "api_url:" in ${SETTINGS} (e.g. api_url: http://host:9100)` });
    return;
  }
  go = spawn(GO_BIN, [], { env: { ...process.env, DICTATION_API_URL: apiUrl }, stdio: ["pipe", "pipe", "pipe"] });
  go.on("error", (e) => toRenderer("status", { state: "error", msg: `bridge: ${e.message}` }));
  readline.createInterface({ input: go.stdout }).on("line", (l) => { const t = l.trim(); if (!t) return; let m; try { m = JSON.parse(t); } catch { return; } handleGo(m); });
}
function writeGo(o) { if (go && !go.killed) go.stdin.write(JSON.stringify(o) + "\n"); }
function runWez(args) {
  return new Promise((res, rej) => execFile(WEZ_BRIDGE, args, { env: weztermEnv(), maxBuffer: 4 << 20 },
    (e, so, se) => e ? rej(new Error((se || "").toString().trim() || e.message)) : res((so || "").toString())));
}

// cleaned text → route into the selected agent's pane (with its esc settings)
async function routeToAgent(agentId, text) {
  // Empty/silent transcription arrives as undefined (omitempty) — never send it,
  // or we'd type the literal "undefined" into the pane.
  const clean = (text == null ? "" : String(text)).trim();
  const ag = loadAgents().find((a) => a.id === agentId);
  if (!ag || !ag.pane_id) { toRenderer("status", { agentId, state: "error", msg: "agent not running" }); return; }
  if (!clean) { toRenderer("status", { agentId, state: "idle", msg: "no speech detected" }); return; }
  toRenderer("status", { agentId, state: "sending" });
  try {
    const args = ["send", "-pane", String(ag.pane_id), "-raise"];
    if (ag.esc_before_send) args.push("-esc", "-esc-delay", String(ag.esc_delay_ms));
    args.push("-text", clean);
    await runWez(args);
    if (win && !win.isDestroyed()) { win.show(); app.focus({ steal: true }); } // keep keyboard on the arcade
    toRenderer("status", { agentId, state: "delivered", text: clean });
  } catch (e) { toRenderer("status", { agentId, state: "error", msg: e.message }); }
}

function handleGo(m) {
  const j = pending[m.job_id]; if (!j) return;
  if (m.type === "result") { delete pending[m.job_id]; routeToAgent(j.agentId, m.cleaned_text); }
  else if (m.type === "error") { delete pending[m.job_id]; toRenderer("status", { agentId: j.agentId, state: "error", msg: m.error }); }
}

// ── IPC ────────────────────────────────────────────────────────────────────────
ipcMain.handle("arcade:agents", async () => {
  reconcileMux(); // drop pane ids from a previous mux before deriving "running"
  const agents = loadAgents();
  let live = [];
  try { live = (await runWez(["pane-ids"])).split("\n").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite); } catch {}
  return agents.map((a) => ({ ...a, running: !!(a.pane_id && live.includes(a.pane_id)) }));
});
ipcMain.handle("arcade:systems", () => loadSystems());
ipcMain.handle("arcade:groups", () => loadGroups());
ipcMain.handle("arcade:commands", () => loadCommands());
// Persist the live-terminal view-box ratio (box size ÷ Arcade window) so Studio's
// pop-out "Sync" can compute the matching WezTerm window size from the monitor dims.
ipcMain.handle("arcade:saveViewRatio", (_e, r) => {
  const w = parseFloat(r && r.w), h = parseFloat(r && r.h);
  if (!(w > 0 && w <= 1) || !(h > 0 && h <= 1)) return { ok: false };
  const doc = readDoc();
  doc.view_ratio = { w: +w.toFixed(4), h: +h.toFixed(4) };
  writeDoc(doc);
  return { ok: true };
});
ipcMain.handle("arcade:settings", () => loadApp()); // global app settings (e.g. compose_split)
ipcMain.handle("arcade:dictationGet", () => dictationState); // cached availability (Studio owns the probe)
// First-run tour: a self-deleting top-level `tour:` map (seeded by the Studio
// wizard). Each present key = an Arcade screen still owed an ambient hint.
// Welcome orb → hand off to Studio's first-agent wizard. We hide the Arcade window
// (not close — so onArcadeClosed/quit doesn't fire) and let Studio drive setup;
// when the wizard finishes it re-shows the Arcade (which reloads on focus).
let onSetup = null;
function onSetupRequested(cb) { onSetup = cb; }
ipcMain.handle("arcade:startSetup", () => {
  if (win && !win.isDestroyed()) win.hide();
  if (onSetup) onSetup();
  return { ok: true };
});
ipcMain.handle("arcade:tour", () => readDoc().tour || {});
ipcMain.handle("arcade:tourDone", (_e, screen) => {
  const doc = readDoc();
  if (doc.tour && Object.prototype.hasOwnProperty.call(doc.tour, screen)) {
    delete doc.tour[screen];
    if (!Object.keys(doc.tour).length) delete doc.tour; // last one → remove the key, no trace
    writeDoc(doc);
  }
  return { ok: true };
});
// renderer captured a WAV → transcribe/clean via the bridge, then route on result
ipcMain.handle("arcade:dictate", (_e, payload) => {
  const ag = loadAgents().find((a) => a.id === (payload && payload.agentId));
  if (!ag) return { ok: false, error: "no agent" };
  const tmp = path.join(os.tmpdir(), `arcade-${jobSeq}-${process.pid}.wav`);
  try { fs.writeFileSync(tmp, Buffer.from(payload.wav)); } catch (e) { return { ok: false, error: e.message }; }
  const jobId = `arc-${++jobSeq}`;
  pending[jobId] = { agentId: ag.id };
  toRenderer("status", { agentId: ag.id, state: "sending" });
  writeGo({ type: "dictate", job_id: jobId, wav_path: tmp, source: "arcade", cleanup: ag.text_cleanup, dictation_options: ag.text_cleanup ? agentOptionsCSV(ag) : "" });
  return { ok: true };
});
// lockstep: when the arcade selection changes, switch WezTerm to that agent's
// pane (its tab), then pull focus back so arrow keys keep driving the arcade.
let activateSeq = 0;
ipcMain.handle("arcade:activate", async (_e, agentId) => {
  if (!loadApp().sync_wezterm_tabs) return { ok: true, skipped: true }; // global setting off
  if (!(await guiAttached())) return { ok: true, skipped: true };       // no watch window → nothing to sync
  const ag = loadAgents().find((a) => a.id === agentId);
  if (!ag || !ag.pane_id) return { ok: false };
  // Latest-wins: if a newer activate arrives while this one is in flight, drop this
  // one's focus-steal so rapidly-issued activates can't ping-pong the visible tab.
  const seq = ++activateSeq;
  try {
    await activateAgentTab(ag.pane_id);   // activate-tab by tab id (reliably switches the visible tab)
    if (seq !== activateSeq) return { ok: true, stale: true };
    if (win && !win.isDestroyed()) { win.show(); app.focus({ steal: true }); }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
// open the agent's session: spawn a WezTerm pane running claude (new / resume by
// session_id), persist pane_id+session_id back to the shared YAML. Mirrors Studio.
// Reusable so popOut can auto-resume a stopped agent (⌘P on a stopped card).
async function launchAgentById(id) {
  // Mux up FIRST — this also reconciles stale pane ids if the mux restarted, so the
  // agent we then load reflects the reconciled state (no reuse of a dead-mux id).
  if (!(await ensureMux())) return { ok: false, error: "WezTerm mux could not be started" };
  const agent = loadAgents().find((a) => a.id === id);
  if (!agent) return { ok: false, error: "agent not found" };
  if (agent.pane_id) {
    try { const live = (await runWez(["pane-ids"])).split("\n").map((s) => parseInt(s.trim(), 10)); if (live.includes(agent.pane_id)) return { ok: true, mode: "already", paneId: agent.pane_id }; } catch {}
  }
  let cwd = agent.cwd || CLAUDE_CWD;
  if (cwd.startsWith("~")) cwd = path.join(os.homedir(), cwd.slice(1));
  let sessionId = agent.session_id, mode;
  const claudeArgs = [];
  if (sessionId && sessionPersisted(sessionId)) { mode = "resume"; claudeArgs.push("--resume", sessionId); }
  else if (sessionId) { mode = "start"; claudeArgs.push("--session-id", sessionId); }
  else { sessionId = crypto.randomUUID(); mode = "new"; claudeArgs.push("--session-id", sessionId); }
  try {
    const spawnArgs = ["spawn", "-claude", "-bin", CLAUDE_BIN, "-cwd", cwd];
    if (agent.color) spawnArgs.push("-tabcolor", agent.color);
    if (agent.name) spawnArgs.push("-name", agent.name);
    spawnArgs.push("--", ...claudeArgs);
    const out = await runWez(spawnArgs);
    const paneId = parseInt(out.trim(), 10);
    if (!Number.isFinite(paneId)) throw new Error(`spawn returned no pane id: ${out.trim()}`);
    patchAgentRaw(id, { session_id: sessionId, pane_id: paneId });
    return { ok: true, mode, paneId };
  } catch (e) { return { ok: false, error: e.message }; }
}
ipcMain.handle("arcade:launchAgent", (_e, id) => launchAgentById(id));
// typed text (insert mode) → route straight to the agent's pane (no transcription)
ipcMain.handle("arcade:sendText", async (_e, payload) => {
  const id = payload && payload.agentId, text = (payload && payload.text) || "";
  if (!String(text).trim()) return { ok: false, error: "nothing to send" };
  const ag = loadAgents().find((a) => a.id === id);
  if (!ag || !ag.pane_id) return { ok: false, error: "agent not running" };
  try {
    const args = ["send", "-pane", String(ag.pane_id), "-raise"];
    if (ag.esc_before_send) args.push("-esc", "-esc-delay", String(ag.esc_delay_ms));
    args.push("-text", String(text));
    await runWez(args);
    if (win && !win.isDestroyed()) { win.show(); app.focus({ steal: true }); }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
// the live pane's grid size (cols x rows) so the arcade can scale to fit it
function paneSize(paneId) {
  return new Promise((res) => {
    execFile(WEZTERM_BIN, ["cli", "list", "--format", "json"], { env: weztermEnv(), maxBuffer: 8 << 20 },
      (e, out) => {
        if (e) return res(null);
        try { const p = JSON.parse(out).find((x) => x.pane_id === paneId); res(p && p.size ? { cols: p.size.cols, rows: p.size.rows } : null); }
        catch { res(null); }
      });
  });
}
// capture the focused agent's terminal screen (toggled in the agent view)
ipcMain.handle("arcade:getText", async (_e, agentId) => {
  const ag = loadAgents().find((a) => a.id === agentId);
  if (!ag || !ag.pane_id) return { ok: false, error: "no live pane" };
  try {
    const [text, size] = await Promise.all([
      runWez(["get-text", "-pane", String(ag.pane_id), "-escapes"]),
      paneSize(ag.pane_id),
    ]);
    return { ok: true, text, cols: size ? size.cols : 0, rows: size ? size.rows : 0 };
  } catch (e) { return { ok: false, error: e.message }; }
});
// forward a navigation key (PageUp/PageDown) straight into the pane's PTY, so the
// app (Claude) scrolls its own history — same as pressing it in WezTerm directly.
const KEY_SEQ = { pageup: "\x1b[5~", pagedown: "\x1b[6~", escape: "\x1b" };
function sendRaw(paneId, bytes) {
  return new Promise((res) => {
    const p = execFile(WEZTERM_BIN, ["cli", "send-text", "--pane-id", String(paneId), "--no-paste"],
      { env: weztermEnv() }, (e) => res(e ? { ok: false, error: e.message } : { ok: true }));
    p.stdin.write(bytes); p.stdin.end();
  });
}
ipcMain.handle("arcade:paneKey", (_e, payload) => {
  const ag = loadAgents().find((a) => a.id === (payload && payload.agentId));
  const seq = KEY_SEQ[payload && payload.key];
  if (!ag || !ag.pane_id || !seq) return Promise.resolve({ ok: false });
  return sendRaw(ag.pane_id, seq);
});
// sync mode: forward arbitrary raw bytes (a translated keystroke) into the pane's
// PTY without raising/stealing focus, so every key drives WezTerm directly.
ipcMain.handle("arcade:paneSend", (_e, payload) => {
  const ag = loadAgents().find((a) => a.id === (payload && payload.agentId));
  const bytes = payload && payload.bytes;
  if (!ag || !ag.pane_id || !bytes) return Promise.resolve({ ok: false });
  return sendRaw(ag.pane_id, bytes);
});
ipcMain.handle("arcade:exit", () => { if (win && !win.isDestroyed()) win.close(); }); // close the window → back to Studio (same process)

// ── window on the configured monitor ───────────────────────────────────────────
function pickDisplay() {
  const d = readDoc().display || {};
  const all = screen.getAllDisplays();
  if (Number.isFinite(d.monitor_x) && Number.isFinite(d.monitor_y)) {
    const m = all.find((s) => s.bounds.x === d.monitor_x && s.bounds.y === d.monitor_y);
    if (m) return m;
  }
  return screen.getPrimaryDisplay();
}
function createWindow() {
  const disp = pickDisplay();
  const { x, y, width, height } = disp.bounds;
  win = new BrowserWindow({
    x, y, width, height, frame: false, backgroundColor: "#0b0e14", show: false, // show only once painted → no load flash
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => win.show());
  // IMPORTANT: simple (legacy) fullscreen instead of native fullscreen. Native
  // macOS fullscreen puts the window in its OWN Space, so activating the WezTerm
  // watch window on another monitor switches the primary away from the Arcade
  // ("jumps to the left desktop"). Simple fullscreen just covers the screen and
  // stays on the normal desktop, so the watch window can surface beside it.
  win.setSimpleFullScreen(true);
  // Capture Esc only while the Arcade is the focused app (see grabEsc/releaseEsc).
  win.on("focus", grabEsc);
  win.on("blur", releaseEsc);
  win.on("closed", () => { releaseEsc(); killShells(); win = null; if (onClosed) onClosed(); }); // tell Studio to resurface
  // Built-in MacBook displays have a camera notch at top-center; tell the renderer
  // so it can keep content out from under it (no dead space on external monitors).
  win.loadFile(path.join(__dirname, "renderer", "index.html"), disp.internal ? { query: { notch: "1" } } : undefined);
}

// macOS swallows the Esc keydown for a simpleFullScreen window before it reaches
// EITHER the page or a menu accelerator (both verified dead). A globalShortcut is
// the only thing that catches it — but we register it ONLY while the Arcade is
// focused and release it on blur, so Esc works normally in every other app.
function sendEsc() { if (win && !win.isDestroyed()) win.webContents.send("arcade:esc"); }
function grabEsc() { try { if (!globalShortcut.isRegistered("Escape")) globalShortcut.register("Escape", sendEsc); } catch {} }
function releaseEsc() { try { globalShortcut.unregister("Escape"); } catch {} }
// ── public entry (called by Studio's main process) ──────────────────────────────
// openArcade() creates the fullscreen window in THIS (the Studio) process. The Go
// bridge is spawned once, lazily. onArcadeClosed(cb) lets Studio resurface itself
// when the Arcade window is closed (Esc / arcade:exit).
let goStarted = false;
function openArcade() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); grabEsc(); return; }
  if (!goStarted) { goStarted = true; spawnGo(); }
  createWindow();
  grabEsc(); // window starts focused; ensure Esc is captured even if 'focus' doesn't fire on first show
}
function onArcadeClosed(cb) { onClosed = cb; }
function isArcadeVisible() { return !!(win && !win.isDestroyed() && win.isVisible()); }
// Global "summon" toggle: if the Arcade is up and frontmost, dismiss it (hide the
// app so focus returns to wherever the user was); otherwise bring it up. Hiding —
// not closing — so we don't fire onArcadeClosed (which would resurface Studio).
function toggleArcade() {
  if (isArcadeVisible() && win.isFocused()) {
    win.hide();
    if (process.platform === "darwin") app.hide(); // hand focus back to the previous app
    return false;
  }
  openArcade();
  app.focus({ steal: true });
  return true;
}
// Kill the Arcade's Go bridge when the app quits (Studio owns app lifecycle now).
app.on("before-quit", () => { if (go && !go.killed) go.kill(); killShells(); });

module.exports = { openArcade, onArcadeClosed, toggleArcade, isArcadeVisible, onSetupRequested, broadcastDictation };
