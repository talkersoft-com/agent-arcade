// Agent Arcade Launcher — the resident menu-bar (status item) process.
//
// A tiny, always-on background agent (Docker-style): no Dock icon, no window, no
// Go bridge — just the Saturn icon in the macOS menu bar with a menu to launch the
// Studio (config app) or jump straight into the Arcade. It registers itself to
// open at login so it returns on every boot. Single-instance: only ever one icon.
//
// This is NOT a separate executable — it's the same one-bundle app run in launcher
// mode (selected by the `--launcher` flag / DICTATE_LAUNCHER env; see main.js).

const { app, Tray, Menu, nativeImage, dialog, globalShortcut } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const yaml = require("js-yaml");

const ROOT = path.join(__dirname, "..");
// Dev build (`npm run dev` sets DICTATE_DEV): use a DISTINCT name + icon so the
// dev menu-bar agent is obviously different from a prod install and — critically —
// gets its OWN single-instance lock (the lock is keyed by app name/userData), so
// dev and prod launchers can coexist instead of one killing the other. setName
// MUST run before requestSingleInstanceLock for the lock to use the right key.
const DEV = !!process.env.DICTATE_DEV;
const APP_LABEL = DEV ? "Agent Arcade (Dev)" : "Agent Arcade";
app.setName(APP_LABEL);
// Pin a per-build userData dir so the single-instance lock is keyed to THIS build
// (dev vs prod). Unpackaged Electron otherwise shares one default userData, so the
// dev and prod launchers would fight over the same lock and only one icon would
// survive. With distinct userData, the cyan (dev) and gold (prod) icons coexist.
app.setPath("userData", path.join(app.getPath("appData"), APP_LABEL));
// One launcher per build — a second instance would mean a duplicate menu-bar icon.
if (!app.requestSingleInstanceLock()) { app.quit(); return; } // top-level return is valid in CommonJS

let tray = null;

// Launch the one app (Studio + Arcade are now a SINGLE process). Plain → Studio;
// `--arcade` → open the Arcade window. Single-instance in main.js means a second
// launch routes into the running app (via second-instance) instead of forking a
// rival process. Clear our own launcher env so the child never runs as a launcher.
function spawnBundle(extraArgs) {
  const env = { ...process.env, DICTATE_LAUNCHER: "", DICTATE_ARCADE: "" };
  const args = extraArgs || [];
  try {
    if (app.isPackaged) {
      spawn(process.execPath, args, { cwd: app.getPath("home"), env, detached: true, stdio: "ignore" }).unref();
    } else {
      spawn(path.join(ROOT, "node_modules", ".bin", "electron"), [ROOT, ...args], { cwd: ROOT, env, detached: true, stdio: "ignore" }).unref();
    }
  } catch (e) { console.error("[launcher] spawn failed:", e.message); }
}
function openStudio() { spawnBundle([]); }                  // plain → Studio
function launchArcade() { spawnBundle(["--arcade"]); }      // → open the Agent Arcade window
function openPreferences() { spawnBundle(["--preferences"]); } // → Studio, opened on Preferences
function openAccount() { spawnBundle(["--account"]); }         // → the Account window

// ── Global summon hotkey ────────────────────────────────────────────────────────
// The launcher is the PERSISTENT process, so it (not the disposable Studio window)
// owns the global hotkey — otherwise the shortcut would die the moment all windows
// close, which is exactly when "summon" matters most. Triggering spawns `--arcade`;
// the running app routes that (single-instance) to toggleArcade, and cold it starts
// straight into the Arcade. The binding lives in the shared YAML (re-read on
// change); a sentinel file lets the Studio recorder release the combo while it
// captures a new one.
const HV_DIR = path.join(os.homedir(), ".hv");
const SETTINGS_PATH = path.join(HV_DIR, DEV ? "agent-arcade.dev.yaml" : "agent-arcade.yaml");
const SUSPEND_PATH = path.join(HV_DIR, DEV ? ".summon-suspend.dev" : ".summon-suspend");
// Joined = a stored Talkersoft ID session exists (same file the auth layer writes).
// (A previous version hid Studio + Preferences when this file existed. It is no
// longer consulted for that: a file on disk is not proof of a working session,
// and treating it as one stranded signed-out users with no route back in.)

// License badge — written by main on each auth change (see setLicenseState). Shown
// as a disabled tray item so the active license/mode is always visible. Absent
// file → Free · local (the default, e.g. never signed in).
const LICENSE_STATE_PATH = path.join(HV_DIR, DEV ? "agent-arcade-license.dev.json" : "agent-arcade-license.json");
function licenseLine() {
  try {
    const s = JSON.parse(fs.readFileSync(LICENSE_STATE_PATH, "utf8"));
    const where = s.mode === "api" ? "connected" : (s.mode === "connecting" ? "connecting…" : "local");
    return `License: ${s.label || "Free"} · ${where}`;
  } catch { return "License: Free · local"; }
}
function readSummonAccel() {
  try {
    const doc = yaml.load(fs.readFileSync(SETTINGS_PATH, "utf8")) || {};
    const a = ((doc.app || {}).shortcuts || {}).summon;
    return a === undefined ? "Command+Alt+A" : String(a || "").trim(); // undefined → default; "" → disabled
  } catch { return "Command+Alt+A"; }
}
// "Fresh setup" = no agents configured yet. The launcher boots hidden in the menu
// bar; only a fresh install pops Studio so the user can create their first agent.
// After that, the icon and the summon hotkey are the only way in.
function hasAnyAgents() {
  try {
    const doc = yaml.load(fs.readFileSync(SETTINGS_PATH, "utf8")) || {};
    return Array.isArray(doc.agents) && doc.agents.length > 0;
  } catch { return false; }
}
function registerSummon() {
  try { globalShortcut.unregisterAll(); } catch {}
  if (fs.existsSync(SUSPEND_PATH)) return;          // recorder is capturing — stay released
  const accel = readSummonAccel();
  if (!accel) return;                               // disabled
  try {
    const ok = globalShortcut.register(accel, () => launchArcade());
    console.error(`[launcher] summon hotkey ${accel} → ${ok ? "registered" : "IN USE (not registered)"}`);
  } catch (e) { console.error("[launcher] summon hotkey:", e.message); }
}
// Re-register whenever the settings YAML or the suspend sentinel changes. Watching
// the dir (debounced) survives editors' atomic-save rename churn.
let watchTimer = null;
function watchConfig() {
  try {
    fs.watch(HV_DIR, (_evt, file) => {
      if (file && (file === path.basename(SETTINGS_PATH) || file === path.basename(SUSPEND_PATH))) {
        clearTimeout(watchTimer); watchTimer = setTimeout(registerSummon, 120);
      }
    });
  } catch (e) { console.error("[launcher] watch:", e.message); }
}

// The app is a background menu-bar utility — useless unless it's running — so it
// ALWAYS opens at login (prod). No user toggle: to stop it, uninstall (or remove it
// under System Settings ▸ General ▸ Login Items). Dev builds never auto-start.
// macOS login items pass args (not env), so we hand it the --launcher flag.
function ensureOpenAtLogin() {
  if (DEV) return; // never auto-start a dev build at boot
  try {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: ["--launcher"] });
  } catch (e) { console.error("[launcher] open-at-login:", e.message); }
}

function showAbout() {
  const icon = nativeImage.createFromPath(path.join(ROOT, "assets", "app-icon.png"));
  dialog.showMessageBox({
    type: "info",
    icon: icon.isEmpty() ? undefined : icon,
    title: `About ${APP_LABEL}`,
    message: APP_LABEL,
    detail: [
      `v${app.getVersion()}  ·  © 2026 Talkersoft`,
      "",
      "Languages:",
      "    JavaScript · Go",
      "Runtime:",
      "    Electron · Chromium · Node.js",
      "Terminal:",
      "    WezTerm — https://wezterm.org",
      "Libraries:",
      "    js-yaml",
      "    electron-builder",
      "    electron-reloader",
    ].join("\n"),
    buttons: ["OK"],
  });
}

// ── dictation daemon supervision ────────────────────────────────────────────────
// The launcher is the resident process, so it supervises the shared daemon: spawn
// as a CHILD, respawn on exit with capped backoff. Every app also ensures the
// daemon client-side (lib/dictation-client.js), so this is belt-and-suspenders —
// healing even with zero windows open. Exit-0 within 2s means we LOST the bind
// race (a client-spawned daemon already serves): don't respawn-loop against the
// lock — connect a monitor client instead, whose ensure loop revives the daemon
// if that winner ever dies.
const { connectDictation, shutdownDaemon } = require(path.join(ROOT, "lib", "dictation-client.js"));
const GO_BIN = path.join(ROOT, "go", "bin", "dictation-go").replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
function readApiUrl() {
  try {
    const doc = yaml.load(fs.readFileSync(SETTINGS_PATH, "utf8")) || {};
    return (doc.api_url || "").toString().trim() || (process.env.DICTATION_API_URL || "").trim();
  } catch { return (process.env.DICTATION_API_URL || "").trim(); }
}
let daemonChild = null;
let monitorClient = null;
let quitting = false;
let daemonBackoff = 250;
function superviseDaemon() {
  if (quitting) return;
  const apiUrl = readApiUrl();
  if (!apiUrl || !fs.existsSync(GO_BIN)) {           // not configured/built yet —
    setTimeout(superviseDaemon, 30000); return;      // check again, don't crash-loop
  }
  const t0 = Date.now();
  daemonChild = spawn(GO_BIN, ["--daemon"], { env: { ...process.env, DICTATION_API_URL: apiUrl }, stdio: "ignore" });
  daemonChild.once("error", (e) => { console.error("[launcher] daemon spawn:", e.message); daemonChild = null; setTimeout(superviseDaemon, 10000); });
  daemonChild.once("exit", (code) => {
    daemonChild = null;
    if (quitting) return;
    if (code === 0 && Date.now() - t0 < 2000) { monitorDaemon(); return; } // lost the bind — someone else serves
    const delay = daemonBackoff;
    daemonBackoff = Math.min(daemonBackoff * 2, 10000);
    console.error(`[launcher] daemon exited (code=${code}) — respawn in ${delay}ms`);
    setTimeout(superviseDaemon, delay);
  });
  setTimeout(() => { if (daemonChild) daemonBackoff = 250; }, 60000); // 60s healthy → reset backoff
}
function monitorDaemon() {
  if (monitorClient || quitting) return;
  monitorClient = connectDictation({ client: "launcher", appVersion: app.getVersion(), bin: GO_BIN, apiUrl: readApiUrl });
}

// Quit EVERYTHING: the Arcade/Studio run as detached sibling processes (not
// children), so app.quit() alone would leave them behind. SIGTERM each Electron
// process of THIS install — graceful, so every instance runs its before-quit
// (closing its daemon client; warn_on_exit still gets its say) — THEN stop the
// daemon (clients first, so no ensure loop respawns it), then exit. WezTerm is
// left alone on purpose — the mux keeps agent sessions alive.
function quitAgentArcade() {
  const { execFile } = require("child_process");
  quitting = true; // no supervised respawn racing the shutdown
  if (monitorClient) { try { monitorClient.close(); } catch {} monitorClient = null; }
  // pgrep + per-pid SIGTERM instead of pkill: pkill's pattern matches THIS
  // launcher too, and dying mid-callback would strand the daemon. Excluding our
  // own pid lets us sequence clients-then-daemon and only then exit ourselves.
  execFile("pgrep", ["-f", `[Ee]lectron ${ROOT}`], (_e, out) => {
    const pids = (out || "").split("\n").map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n) && n !== process.pid);
    for (const p of pids) { try { process.kill(p, "SIGTERM"); } catch {} }
    // Give the apps a beat to run before-quit (close their daemon clients) so
    // no ensure loop respawns the daemon we're about to stop.
    setTimeout(() => shutdownDaemon("quit").then(() => app.quit()), 400);
  });
}

function buildMenu() {
  const items = [
    { label: `${APP_LABEL} v${app.getVersion()}`, enabled: false },
    { label: licenseLine(), enabled: false },
    { type: "separator" },
    { label: "Launch Agent Arcade", click: launchArcade },
  ];
  // ALWAYS available. These used to be hidden for "joined" users, on the theory
  // that agents are managed online — but "joined" was decided by whether a
  // refresh-token FILE existed, not by whether the session actually worked. A
  // stale or revoked token therefore left the app signed out with the only route
  // to signing back in hidden: a dead end with no way out of it from the tray.
  // Preferences is where sign-in, the licence, dictation and displays live, so
  // hiding it can strand someone; showing it costs a joined user two menu lines.
  items.push(
    { label: "Open Agent Arcade Studio", click: openStudio },
    { label: "Preferences…", click: openPreferences },
    { label: "Account…", click: openAccount },
  );
  items.push({ type: "separator" });
  items.push(
    { label: `About ${APP_LABEL}…`, click: showAbout },
    { type: "separator" },
    { label: DEV ? "Quit Agent Arcade (Dev)" : "Quit Agent Arcade", click: quitAgentArcade },
  );
  return Menu.buildFromTemplate(items);
}
function refreshMenu() { if (tray) tray.setContextMenu(buildMenu()); }

function createTray() {
  // Cyan Saturn in dev, gold in prod — instantly distinguishable in the menu bar.
  const icon = DEV ? "tray-icon-dev.png" : "tray-icon.png";
  const img = nativeImage.createFromPath(path.join(ROOT, "assets", icon));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip(APP_LABEL);
  tray.setContextMenu(buildMenu());
  // Rebuild the menu when sign-in state changes (the refresh-token file appears or
  // disappears) so Studio/Preferences hide/show live without a relaunch.
  try { fs.watch(HV_DIR, { persistent: false }, () => refreshMenu()); } catch {}
}

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();      // headless menu-bar agent — no Dock icon
  app.setAboutPanelOptions({ applicationName: APP_LABEL, applicationVersion: app.getVersion(), copyright: "© 2026 Talkersoft" });
  createTray();
  ensureOpenAtLogin();                // always open at login (prod); no user toggle
  try { fs.unlinkSync(SUSPEND_PATH); } catch {} // clear a stale sentinel from a crashed recording
  registerSummon();                   // global summon hotkey (⌘⌥A or the user's binding)
  watchConfig();                      // live-apply rebinds from Settings → Shortcuts
  superviseDaemon();                  // resident supervision of the shared dictation daemon
  if (!hasAnyAgents()) launchArcade(); // fresh install → the Arcade's Welcome (start of the tour); else stay hidden
});
// No windows: the launcher must stay resident. Never quit on window-all-closed.
app.on("window-all-closed", (e) => { e.preventDefault(); });
app.on("will-quit", () => { try { globalShortcut.unregisterAll(); } catch {} });
