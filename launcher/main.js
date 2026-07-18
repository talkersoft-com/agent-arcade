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

// Quit EVERYTHING: the Arcade/Studio run as detached sibling processes (not
// children), so app.quit() alone would leave them behind. SIGTERM each Electron
// process of THIS install — graceful, so every instance runs its before-quit
// (killing its Go bridge; warn_on_exit still gets its say). The launcher matches
// the pattern too and exits the same way; app.quit() covers the nothing-matched
// case. WezTerm is left alone on purpose — the mux keeps agent sessions alive.
function quitAgentArcade() {
  const { execFile } = require("child_process");
  execFile("pkill", ["-f", `[Ee]lectron ${ROOT}`], () => app.quit());
}

function buildMenu() {
  const items = [
    { label: `${APP_LABEL} v${app.getVersion()}`, enabled: false },
    { type: "separator" },
    { label: "Launch Agent Arcade", click: launchArcade },
    { label: "Open Agent Arcade Studio", click: openStudio },
    { label: "Preferences…", click: openPreferences },
    { type: "separator" },
  ];
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
}

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();      // headless menu-bar agent — no Dock icon
  app.setAboutPanelOptions({ applicationName: APP_LABEL, applicationVersion: app.getVersion(), copyright: "© 2026 Talkersoft" });
  createTray();
  ensureOpenAtLogin();                // always open at login (prod); no user toggle
  try { fs.unlinkSync(SUSPEND_PATH); } catch {} // clear a stale sentinel from a crashed recording
  registerSummon();                   // global summon hotkey (⌘⌥A or the user's binding)
  watchConfig();                      // live-apply rebinds from Settings → Shortcuts
  if (!hasAnyAgents()) launchArcade(); // fresh install → the Arcade's Welcome (start of the tour); else stay hidden
});
// No windows: the launcher must stay resident. Never quit on window-all-closed.
app.on("window-all-closed", (e) => { e.preventDefault(); });
app.on("will-quit", () => { try { globalShortcut.unregisterAll(); } catch {} });
