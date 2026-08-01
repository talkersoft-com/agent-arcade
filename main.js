// Agent Arcade Studio — Electron main process (the config app).
//
// Manage agents + systems, configure global/app settings, and launch the Agent
// Arcade. Dictation STREAMS: the renderer captures mic audio and main transcribes
// (via the long-lived Go bridge over NDJSON) and routes the cleaned text straight
// into the agent's WezTerm pane — nothing is saved to disk.

const { app, BrowserWindow, ipcMain, session, screen, Tray, Menu, nativeImage, dialog, protocol, globalShortcut, shell } = require("electron");
const { spawn, execFile } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("node:crypto");
const yaml = require("js-yaml");

// Dev hot-reload: when running from the SOURCE repo (or DICTATE_DEV), renderer
// changes reload the window instantly; main/preload changes restart the app.
// We detect "from source" by the presence of studio/src — the published package
// ships only studio/dist, so this never activates in a user's npm install (where
// app.isPackaged would be unreliable, since it runs via `electron .`). Raw sources
// are ignored; esbuild's --watch rebuilds dist/, and THAT change triggers the reload.
const RUNNING_FROM_SOURCE = (() => {
  try { return require("fs").existsSync(require("path").join(__dirname, "studio", "src", "main.jsx")); }
  catch { return false; }
})();
if (process.env.DICTATE_DEV || RUNNING_FROM_SOURCE) {
  try {
    require("electron-reloader")(module, {
      ignore: ["go", "wezterm-bridge", "recordings", "node_modules", "studio/src", "arcade/src"],
    });
  } catch (e) {
    console.error("[main] hot-reload disabled:", e.message);
  }
}

// The resident menu-bar launcher (Docker-style). Selected by a CLI
// flag so the macOS login item (which passes args, not env) can start it at boot;
// the env var is the spawn-from-Studio path. Tray-only, no Studio subsystems.
if (process.argv.includes("--launcher") || process.env.DICTATE_LAUNCHER === "1") {
  require("./launcher/main.js");
  return;
}

// The app's display name — drives the macOS application menu ("Agent Arcade
// Studio", "About Agent Arcade Studio", "Quit Agent Arcade Studio") and the
// userData dir. A dev build gets a DISTINCT name so it has its own single-instance
// lock + userData and can coexist with an installed copy without either quitting
// the other. Set before app is ready so it takes effect everywhere.
const DEV = !!process.env.DICTATE_DEV;
const APP_NAME = DEV ? "Agent Arcade Studio (Dev)" : "Agent Arcade Studio";
app.setName(APP_NAME);
// Pin userData to the (per-build) name so the single-instance lock is keyed to THIS
// build — dev vs prod don't share a lock, but each is still a singleton.
app.setPath("userData", path.join(app.getPath("appData"), APP_NAME));

// ── THE EDITION DECISION ──────────────────────────────────────────────────────
// Settled HERE: before any window, before the capability probe, before auth is
// restored, and before the Arcade module is even required. From this line on the
// answer cannot change, so nothing downstream has to cope with it changing.
//
//   local — free. YAML on this machine. No login, no API, no network.
//   cloud — paid. The backend owns the config.
//
// This replaces deriving cloud-vs-local from live auth state on every read. Auth
// restores asynchronously and lands AFTER windows are up, so for a moment at boot
// a paid user looked unlicensed — and one-shot startup work that ran in that
// window never got a second chance. See lib/edition.js for the full account.
//
// A licence change does not flip this in place: it persists the new edition and
// restarts the app. See the auth "change" handler below.
const edition = require("./lib/edition");
const EDITION = edition.resolve({ dev: DEV, log: (m) => logLine("info", `edition: ${m}`) });

// Single instance — ALWAYS (dev AND packaged). One app process owns Studio AND the
// Agent Arcade window; a second launch (e.g. the launcher's "Launch Arcade", or just
// re-running it) routes into the RUNNING instance via the second-instance event
// instead of stacking another process. Exactly one process, one Dock icon, one TCC
// identity — no more pile-up of stray instances.
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

// The Agent Arcade is a WINDOW in this process (not a separate app), required as a
// module. One process = one macOS TCC identity, so the System Events (Automation)
// grant the user gives the app also covers the Arcade's pop-out positioning.
const arcade = require("./arcade/main.js");

// Bundled native binaries/assets can't be executed/read from inside app.asar, so
// they're marked asarUnpack in the build config — rewrite the path to the unpacked
// copy. A no-op in dev (the path has no "app.asar" segment).
const unpacked = (p) => p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
const GO_BIN = unpacked(path.join(__dirname, "go", "bin", "dictation-go"));
// Dictation IPC (docs/plans/daemon-ipc/PLAN.md): one shared daemon over a local
// socket serves every window — NDJSON protocol v1 via lib/dictation-client.js.
const { connectDictation } = require("./lib/dictation-client");
const { Auth } = require("./lib/auth");
const { registerHost } = require("./lib/registry");
const { syncOnLogin } = require("./lib/config-sync");
const { fetchLicense, fetchEntitlements } = require("./lib/license");
const { safeStorage } = require("electron");

// Talkersoft ID auth. The identity service URL comes from the backend's
// /capabilities (auth_issuer); when the backend requires no auth it stays empty
// and the Account row simply says so. On every token change we push it to the
// daemon (so dictation is authenticated) and to the renderer (the Account row).
// OUR identity service, embedded like every other host of ours.
//
// This used to be discovered from whatever speech backend was active
// (/capabilities → auth_issuer). That worked only while the active backend was
// always ours. Now that a signed-out user is on the LOCAL engine, discovery
// returns nothing — and signing in became impossible: you couldn't sign in
// because you were local, and couldn't reach cloud because you weren't signed in.
//
// Signing in has nothing to do with where speech runs, so it no longer asks a
// speech server. The backend's advertised issuer is still honoured if present, but
// it can only ever be a fallback, never the reason sign-in is unavailable.
const ID_ISSUER = (process.env.ID_ISSUER || "https://id-dev.talkersoft.com").replace(/\/+$/, "");
const auth = new Auth({
  issuer: () => ID_ISSUER || (lastCaps && lastCaps.auth_issuer) || "",
  safeStorage,
  openExternal: (u) => { try { shell.openExternal(u); } catch {} },
  log: (m) => logLine("info", `auth: ${m}`),
});
// The account store — agents / groups / systems / macros. ONE implementation,
// picked from the frozen edition: the YAML locally, agent-arcade-api in the cloud
// edition. Nothing downstream branches on which; see lib/store/index.js.
//
// Initialised here, before any window, so the very first loadAgents() answers from
// the right place. In the cloud edition that first answer comes from the on-disk
// cache (instant, works offline) and converges when start()'s refresh lands.
const store = require("./lib/store");
store.init({
  dir: path.join(os.homedir(), ".hv"),
  dev: DEV,
  readDoc, writeDoc,
  token: () => auth.token(),
  deviceId: auth.deviceId,
  log: (m) => logLine("info", m),
  onChange: () => { toRenderer("agents:changed"); toRenderer("config:changed", { mode: store.isCloud() ? "api" : "local" }); },
});

// Managed-config mode: false = local YAML (anonymous, the free path); true = the
// backend drives agents (joined). Set by the sign-in sync below.
let apiMode = false;
// Tracked only to spot a sign-in/sign-out TRANSITION in the auth handler. It does
// not select the backend — the edition does that, and it was frozen at boot.
let signedIn = false;
let wasSignedIn = false;

// schedulePush is GONE — deliberately. It re-uploaded the whole YAML after any
// local edit, which meant a stale local file could overwrite account data and
// the "when does my YAML go up?" answer was "whenever". The contract now:
// YAML → database exactly ONCE (the migrate, decided by the backend's per-device
// flag), and every later edit goes through the store to the API directly. The
// database never writes back into a YAML.

// License badge state — a tiny file the launcher reads to show "License: Free ·
// local" / "License: Hobbyist · connected" in the tray, so which license is in
// use is always visible. main writes it on every auth change; the launcher
// fs.watches ~/.hv and rebuilds its menu. Also broadcast to renderers.
const LICENSE_STATE_PATH = path.join(os.homedir(), ".hv", DEV ? "agent-arcade-license.dev.json" : "agent-arcade-license.json");
function licenseLabel(lic) {
  const k = (lic || "free").toString().toLowerCase();
  if (!k || k === "free") return "Free";
  return k.charAt(0).toUpperCase() + k.slice(1); // hobbyist → Hobbyist
}
function setLicenseState({ signedIn: si, lic, mode }) {
  const state = { signedIn: !!si, lic: lic || "free", mode: mode || "local", label: licenseLabel(lic), updated: Date.now() };
  try {
    fs.mkdirSync(path.dirname(LICENSE_STATE_PATH), { recursive: true });
    fs.writeFileSync(LICENSE_STATE_PATH, JSON.stringify(state));
  } catch (e) { logLine("err", `license-state: ${e.message}`); }
  toRenderer("license:changed", state);
}

// ── device identity ────────────────────────────────────────────────────────────
// A device is a friendly name + an icon (the icon comes from the platform). The
// name is what a person picks this machine by — today in the web console, later
// in a Devices menu when driving one machine from another. Asked ONCE, the first
// time a licensed user registers this machine; stored in the YAML alongside
// everything else, and sent as the registry label.
let deviceNameWin = null;
// Set while a sign-in is waiting for the person to name this machine; resolving it
// lets registration + config sync continue in the right order.
let pendingDeviceName = null;
function deviceName() { try { return (readDoc().device_name || "").toString().trim(); } catch { return ""; } }
function setDeviceName(name) {
  const d = readDoc();
  d.device_name = (name || "").toString().trim().slice(0, 60);
  writeDoc(d);
}
function platformKey() {
  return process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
}
ipcMain.handle("deviceName:suggest", () => ({
  suggested: deviceName() || (() => { try { return os.hostname().replace(/\.local$/i, ""); } catch { return ""; } })(),
  platform: platformKey(),
}));
ipcMain.handle("deviceName:save", (_e, name) => {
  setDeviceName(name);
  logLine("info", `device named "${deviceName()}"`);
  if (deviceNameWin && !deviceNameWin.isDestroyed()) deviceNameWin.close();
  deviceNameWin = null;
  // Registration is NOT done here: joinThenSync owns the order (register, then
  // import into a workspace named after this machine). Releasing the waiter is
  // all that's needed.
  if (pendingDeviceName) { const go = pendingDeviceName; pendingDeviceName = null; go(); }
  return { ok: true };
});
function askDeviceName() {
  if (deviceNameWin && !deviceNameWin.isDestroyed()) { deviceNameWin.show(); deviceNameWin.focus(); return; }
  deviceNameWin = new BrowserWindow({
    width: 440, height: 430, resizable: false, fullscreenable: false, minimizable: false,
    title: "Name this device", titleBarStyle: "hiddenInset",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  deviceNameWin.loadFile(path.join(__dirname, "renderer", "device-name.html"));
  deviceNameWin.center();
  // Closed without saving → carry on with the hostname, so a dismissed prompt
  // can't strand the sign-in half-done.
  deviceNameWin.on("closed", () => {
    deviceNameWin = null;
    if (pendingDeviceName) { const go = pendingDeviceName; pendingDeviceName = null; go(); }
  });
}

// ── signed-out prompt ──────────────────────────────────────────────────────────
// When a session lapses there is nothing the app can do on its own: the refresh
// token is dead, so every cloud call will keep failing. A toast on each failure
// tells you something is wrong without telling you what to DO about it, and the
// fix (Preferences ▸ sign in) is somewhere you have to already know to look.
//
// So we surface it where the user is: a small window that says what happened and
// offers the one action that fixes it. The Google consent screen itself still
// opens in the real browser — Google refuses OAuth inside embedded webviews, and
// the loopback catcher in lib/auth.js expects that flow.
//
// SINGLE-FLIGHT. Several failures usually arrive together (a dictation, a config
// push, an avatar). Without a guard each would open another window and another
// browser tab. `userSignedOut` additionally suppresses it after a DELIBERATE sign
// out, where being asked to sign back in would be obnoxious.
let accountWin = null;
let userSignedOut = false;
// openAccount is the ONLY way a sign-in starts. Every door — first run, a lapsed
// session, Preferences, the tray — opens this same window, so the transaction
// looks identical wherever it began. `reason` only changes the wording, never the
// mechanics.
//
// The Google consent screen itself still opens in the system browser: Google
// refuses OAuth inside embedded webviews, and the loopback catcher in
// lib/auth.js is built around that. What this window fixes is everything either
// side of it — knowing who you're signed in as, being able to choose a different
// account, and having somewhere that says what just happened.
//
// SINGLE-FLIGHT: failures arrive in clusters (a dictation, a config push, an
// avatar). Without this, each would open its own window and its own browser tab.
function openAccount(reason) {
  if (accountWin && !accountWin.isDestroyed()) { accountWin.show(); accountWin.focus(); return; }
  accountWin = new BrowserWindow({
    width: 430, height: 470, resizable: false, fullscreenable: false, minimizable: false,
    alwaysOnTop: reason === "expired" || reason === "lapsed",
    title: DEV ? "Agent Arcade Account (Dev)" : "Agent Arcade Account", titleBarStyle: "hiddenInset",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  accountWin.loadFile(path.join(__dirname, "renderer", "account.html"), {
    search: reason ? `?reason=${encodeURIComponent(reason)}` : "",
  });
  accountWin.center();
  accountWin.on("closed", () => { accountWin = null; });
  if (reason) logLine("info", `account window opened (${reason})`);
}
ipcMain.handle("account:open", (_e, reason) => { openAccount(reason || ""); return { ok: true }; });
ipcMain.handle("account:done", (_e, how) => {
  // Dismissing a prompt they didn't ask for shouldn't nag them again this run.
  if (how === "closed") userSignedOut = true;
  if (accountWin && !accountWin.isDestroyed()) accountWin.close();
  accountWin = null;
  return { ok: true };
});

// license:get — the app's license view. Paid reads its own authoritative record;
// Free reads only the public, identity-free catalog (so an unpaid user is still
// never tracked by the product API). Always answers, even offline.
ipcMain.handle("license:get", async () => {
  const st = auth.status ? auth.status() : { signedIn: signedIn, email: "", lic: "" };
  const tier = (st.lic || "free").toString();
  const paid = !!st.signedIn && tier !== "free";
  const base = { signedIn: !!st.signedIn, tier, label: licenseLabel(tier), email: st.email || "", mode: apiMode ? "api" : "local", paid };
  const log = (m) => logLine("info", `license: ${m}`);
  if (paid) {
    const lic = await fetchLicense({ token: auth.token(), log });
    if (lic) return { ...base, entitlements: lic.entitlements || {}, deviceCount: lic.device_count, email: lic.email || base.email };
    return { ...base, entitlements: null, deviceCount: null };
  }
  const all = await fetchEntitlements({ log });
  return { ...base, entitlements: (all && all[tier]) || null, upgrade: (all && all.hobbyist) || null, deviceCount: null };
});

// edition:get — what is driving this app's data, in the app's own words.
//
// This exists because "am I on my own file or my account?" was invisible. The
// old license row said "connected", which described the SESSION, not the source
// of the agents on screen — and for a long while it was a label over a lie: the
// app said connected and went on reading the local YAML anyway.
ipcMain.handle("edition:get", () => {
  const st = store.status();
  return {
    edition: EDITION,
    isCloud: EDITION === edition.CLOUD,
    ok: st.ok,
    stale: st.stale,
    error: st.error || "",
    counts: { agents: store.agents().length, groups: store.groups().length, commands: store.commands().length },
    // Macros only move to the account once the backend serves them; until then
    // they are still this machine's. Say which, rather than implying both.
    macrosOnAccount: EDITION === edition.CLOUD && store.status().commandsFromApi === true,
  };
});

// joinThenSync registers this machine and only then pulls/imports its config —
// the backend needs the device to exist before it will import into a workspace
// for it. On a first run the name prompt resolves first, so the workspace is
// named what the person chose rather than a hostname.
async function joinThenSync(status) {
  if (!deviceName()) {
    await new Promise((resolve) => { pendingDeviceName = resolve; askDeviceName(); });
  }
  await registerHost({
    token: auth.token(), deviceId: auth.deviceId, appVersion: app.getVersion(),
    label: deviceName(), log: (m) => logLine("info", `registry: ${m}`),
  });
  const res = await syncOnLogin({
    token: auth.token(), deviceId: auth.deviceId, readDoc, device: store.device(), avatarsDir: avatarsDir(),
    log: (m) => logLine("info", `config-sync: ${m}`),
    // Fired ONLY when the backend's per-device flag says this machine has never
    // imported — the migrate moment is announced, and only when it is real.
    onMigrating: (inv) => {
      toRenderer("config:migrating", inv);
      logLine("info", `config-sync: moving this Mac's setup to your account — ${inv.agents} agents, ${inv.groups} groups, ${inv.commands} macros (one-time, one-way)`);
    },
  });
  apiMode = res.mode === "api";
  setLicenseState({ signedIn: true, lic: status.lic, mode: res.mode });
  toRenderer("config:changed", { mode: res.mode, lic: status.lic });
  toRenderer("agents:changed"); // renderers re-fetch agents:list
  return res.mode; // "api" only when the backend actually took the config
}

// relaunchApp restarts this process. The edition is decided at boot (top of this
// file), so changing it means going back through boot — there is deliberately no
// in-place path. WezTerm panes survive: the mux is a separate process and pane ids
// are persisted, so agents come back attached to the terminals they were in.
function relaunchApp() {
  // Drop --account: that flag makes boot open the Account window and return before
  // any Studio/Arcade window is created, so after a successful sign-in it would
  // leave the person staring at the window they just finished with.
  const args = process.argv.slice(1).filter((a) => a !== "--account");
  app.relaunch({ args });
  app.quit(); // quit (not exit) so before-quit closes the daemon client cleanly
}

// promoteToCloud is the free → paid door. It registers this machine and uploads
// the local YAML FIRST, and restarts into the cloud edition ONLY if that actually
// succeeded. Booting into a cloud edition whose config never made it up would show
// an empty app, which is indistinguishable from data loss.
let promoting = false;
async function promoteToCloud(status) {
  const mode = await joinThenSync(status);
  if (mode !== "api") {
    promoting = false; // a later sign-in (or a reachable backend) can try again
    setLicenseState({ signedIn: true, lic: status.lic, mode: "local" });
    logLine("info", "promote: the backend didn't take the config — staying local for now");
    return;
  }
  edition.switchTo(edition.CLOUD, {
    lic: status.lic,
    reason: "paid licence, config synced",
    log: (m) => logLine("info", `edition: ${m}`),
    relaunch: relaunchApp,
  });
}

auth.on("change", (status) => {
  if (dc) dc.setToken(auth.token());
  toRenderer("auth:changed", status);

  const transition = signedIn !== status.signedIn;
  signedIn = status.signedIn;

  // The edition this licence is ENTITLED to, read live. This is the last live
  // licence read in the app, and the only thing it is allowed to do is move us to
  // the OTHER edition — by restart. It never changes behaviour in place.
  const entitled = edition.entitledFrom(status);
  const elog = (m) => logLine("info", `edition: ${m}`);

  // ── free → paid: promote, then restart into the cloud edition ────────────────
  if (entitled === edition.CLOUD && EDITION === edition.LOCAL) {
    if (promoting) return; // token refreshes fire this repeatedly; one promote only
    promoting = true;
    setLicenseState({ signedIn: true, lic: status.lic, mode: "connecting" });
    promoteToCloud(status).catch((e) => { promoting = false; logLine("err", `promote: ${e.message}`); });
    return;
  }

  // ── paid → free: leave the cloud edition ────────────────────────────────────
  if (entitled === edition.LOCAL && EDITION === edition.CLOUD) {
    apiMode = false;
    wasSignedIn = false;
    setLicenseState({ signedIn: !!status.signedIn, lic: status.lic || "free", mode: "local" });
    toRenderer("config:changed", { mode: "local", lic: status.lic || "free" });

    // Restart ONLY for a deliberate sign-out, where the person just acted and
    // expects the app to change.
    if (userSignedOut) {
      edition.switchTo(edition.LOCAL, { lic: "free", reason: "signed out", log: elog, relaunch: relaunchApp });
      return;
    }
    // Everything else that lands here — a session lapsing, a licence pulled, or a
    // 5xx from the identity service on a routine refresh (lib/auth.js forces
    // signed-out on any non-ok response, not just a rejection) — must NOT yank a
    // running app out from under them over what may be a transient server fault.
    // Save the local edition for the next launch, say what happened, and let the
    // next boot do the switch. Signing back in before then costs nothing: the
    // saved edition simply goes back to cloud and nothing ever moved.
    edition.prefer(edition.LOCAL, { lic: status.lic || "free", log: elog });
    startupProbe().catch(() => {});
    // Ask for a sign-in ONCE, rather than letting every failed cloud call emit its
    // own toast about a problem the user can't act on.
    if (!status.signedIn) openAccount("expired");
    return;
  }

  // ── steady state: this process booted into the edition it should be in ──────
  if (transition) startupProbe().catch(() => {});

  if (EDITION === edition.LOCAL) {
    // The free path — signed out, or signed in on the free plan. ALL product-API
    // traffic is gated on a qualifying licence, not merely on being signed in: a
    // free user is known only by identity in Talkersoft ID, and the product API
    // tracks NOTHING for them. No device registration, no managed config sync.
    setLicenseState({ signedIn: !!status.signedIn, lic: status.lic || "free", mode: "local" });
    toRenderer("config:changed", { mode: "local", lic: status.lic || "free" });
    return;
  }

  // Cloud edition, licence still qualifying: this machine joins the fleet, then syncs.
  //
  // ORDER MATTERS. The backend imports a machine's YAML into a workspace of its
  // own, and refuses to import for a device it has never seen. Registration used
  // to be fire-and-forget, so on a brand-new machine the import raced ahead of it
  // and was turned away — precisely the case this is for. So: register first,
  // await it, then sync. On a first run the name prompt comes first and the sync
  // waits for it, which is also the right order for a person.
  if (!wasSignedIn) {
    wasSignedIn = true;
    setLicenseState({ signedIn: true, lic: status.lic, mode: "connecting" });
    joinThenSync(status).catch((e) => logLine("err", `config-sync: ${e.message}`));
  } else {
    // A later token refresh: keep last_seen fresh, nothing else.
    if (deviceName()) {
      registerHost({
        token: auth.token(), deviceId: auth.deviceId, appVersion: app.getVersion(),
        label: deviceName(), log: (m) => logLine("info", `registry: ${m}`),
      });
    }
    setLicenseState({ signedIn: true, lic: status.lic, mode: apiMode ? "api" : "local" });
  }
});

// WezTerm "last leg": deliver cleaned text into a WezTerm/Claude pane via the
// bundled Go bridge binary (which itself shells out to `wezterm cli`).
const WEZTERM_BRIDGE_BIN = unpacked(path.join(__dirname, "wezterm-bridge", "bin", "wezterm-bridge"));
// WezTerm itself: the official prebuilt WezTerm.app, downloaded at publish time and
// packed into the npm tarball (see .github/workflows/publish.yml). Preferring this
// lets a fresh `npm i -g` drive WezTerm with nothing else installed. Absent in local
// dev (not committed to git) — the resolvers fall back to a system install.
const WEZTERM_APP_BIN = unpacked(path.join(__dirname, "vendor", "wezterm", "WezTerm.app", "Contents", "MacOS"));
const WEZTERM_BIN = resolveWezterm();
// App-managed WezTerm config (agent-colored/faded tabs + the shared unix mux),
// shipped with the app and loaded ONLY for WezTerm processes we launch — the
// user's own ~/.wezterm.lua is left untouched. Threaded in via WEZTERM_CONFIG_FILE
// (and --config-file on the GUI launch).
const AA_WEZTERM_CONFIG = unpacked(path.join(__dirname, "wezterm", "agent-arcade.wezterm.lua"));
const weztermEnv = () => ({ ...process.env, WEZTERM_BIN, WEZTERM_CONFIG_FILE: AA_WEZTERM_CONFIG });

// Spawn Claude in this working directory (so it boots already in the workspace).
// Hardcoded default; override with CLAUDE_CWD.
const CLAUDE_CWD = process.env.CLAUDE_CWD || path.join(os.homedir(), "workspace");

// A GUI-launched Electron app has a minimal PATH (no /opt/homebrew/bin), so the
// `wezterm` binary won't resolve by name. Find it explicitly.
function resolveWezterm() {
  if (process.env.WEZTERM_BIN) return process.env.WEZTERM_BIN;
  for (const p of [path.join(WEZTERM_APP_BIN, "wezterm"), "/opt/homebrew/bin/wezterm", "/usr/local/bin/wezterm"]) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return "wezterm";
}

// Same problem, worse: the agent pane runs the program via `bash -lc` inside the
// WezTerm mux-server, whose PATH comes from /etc/profile — NOT the user's zsh
// config — so `claude` (typically in ~/.local/bin) isn't found and the pane dies
// instantly ("agents don't pop up"). Resolve an ABSOLUTE path so it runs no matter
// the PATH. claude is a self-contained binary, so the path alone is enough.
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
  // Last resort: ask the user's login+interactive shell (where their PATH lives).
  try {
    const sh = process.env.SHELL || "/bin/zsh";
    const out = require("child_process")
      .execFileSync(sh, ["-lic", "command -v claude"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n").pop().trim();
    if (out && fs.existsSync(out)) return out;
  } catch {}
  return "claude";
}
const CLAUDE_BIN = resolveClaude();

function envInt(k, def) { const v = parseInt(process.env[k] || "", 10); return Number.isFinite(v) ? v : def; }
function envBool(k, def) {
  const v = (process.env[k] || "").toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return def;
}

// Settings persist as YAML under ~/.hv so they survive restarts / hand-edits.
// The dev build (`npm run dev` → DICTATE_DEV) reads a FULLY SEPARATE file. Nothing
// is ever copied from prod — if the file is missing (fresh install, or you deleted
// it to test), the app stubs a brand-new minimal config: the new-user experience.
// DICTATE_DEV is inherited by the spawned Arcade and Launcher, so all three modes
// agree on which file to read. (DEV is declared once at the top, by the
// single-instance setup.)
const SETTINGS_PATH = path.join(os.homedir(), ".hv", DEV ? "agent-arcade.dev.yaml" : "agent-arcade.yaml");
// One-time filename migration: the config used to be dictate-settings*.yaml (this
// tool grew well past "dictation"). Rename it to agent-arcade*.yaml before anything
// reads it, so existing setups carry over seamlessly.
(function migrateSettingsFilename() {
  try {
    const legacy = path.join(os.homedir(), ".hv", DEV ? "dictate-settings.dev.yaml" : "dictate-settings.yaml");
    if (!fs.existsSync(SETTINGS_PATH) && fs.existsSync(legacy)) fs.renameSync(legacy, SETTINGS_PATH);
  } catch (e) { console.error("[main] settings rename:", e.message); }
})();

let win = null;
let jobSeq = 0;

function toRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function logLine(level, msg) {
  console.error(`[main:${level}]`, msg);
}

// ── settings (YAML at ~/.hv/agent-arcade.yaml) ───────────────────────────────--
const SETTINGS_HEADER = "# Agent Arcade settings — agents + systems + app/monitor config. Hand-editable.\n";
// About is a CUSTOM window (renderer/about.html), not the native macOS panel — the
// native panel renders credits in a fixed, darker, scrollable text box we can't
// restyle. Our window is one cohesive lighter panel: icon, name, version, a padded
// gap, then the credits. See createAboutWindow().
let aboutWin = null;
function createAboutWindow() {
  if (aboutWin && !aboutWin.isDestroyed()) { aboutWin.focus(); return; }
  aboutWin = new BrowserWindow({
    width: 380, height: 505, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, title: "About Agent Arcade Studio", show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  aboutWin.setMenu(null);
  aboutWin.loadFile(path.join(__dirname, "renderer", "about.html"),
    { query: { name: "Agent Arcade Studio", v: app.getVersion() } });
  aboutWin.once("ready-to-show", () => aboutWin.show());
  aboutWin.on("closed", () => { aboutWin = null; });
}
function readDoc() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) return yaml.load(fs.readFileSync(SETTINGS_PATH, "utf8")) || {};
  } catch (e) { logLine("err", `read settings: ${e.message}`); }
  return {};
}
function writeDoc(doc) {
  // A URL must never live in user config — a stale one there is what pointed the
  // daemon and the client at two different backends. See lib/backend.js.
  try { backend.stripForbidden(doc); } catch {}
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, SETTINGS_HEADER + yaml.dump(doc, { lineWidth: 100 }));
}
// ── mux identity ────────────────────────────────────────────────────────────────
// A WezTerm pane id is only valid within ONE mux-server lifetime (ids are never
// reused while it lives). So a stored pane_id can only point at the WRONG pane if
// the mux RESTARTED (reboot / logout / crash) and an unrelated pane took that id.
// We pin pane_ids to the mux process id: when it changes, every stored pane_id is
// from a dead mux → clear them all (agents respawn fresh + `claude --resume`). A
// plain app/process restart keeps the same mux, so ids are preserved.
function muxPid() {
  try {
    const out = require("child_process").execFileSync("pgrep", ["-f", "wezterm-mux-server"], { encoding: "utf8" });
    return (out || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
  } catch { return ""; } // pgrep exits non-zero when there is no match
}
function reconcileMux() {
  const cur = muxPid(); if (!cur) return;            // no mux up yet → nothing to reconcile
  // Which mux is running, and which panes belong to it, are facts about THIS
  // machine — device state, not account config.
  const dev = store.device();
  const prev = dev.muxId();
  if (prev === cur) return;                          // same mux → stored pane ids still valid
  // Only a KNOWN, different previous mux means the ids are stale. A first run with no
  // recorded mux just adopts the current one (live ids are still validated normally),
  // so we don't orphan panes already running in this mux.
  const cleared = prev ? dev.clearPanes() : 0;
  dev.setMuxId(cur);
  logLine("info", `mux ${prev ? (cleared ? `changed → cleared ${cleared} stale pane id(s)` : "changed") : "baseline set"} (mux=${cur})`);
}
// ── backend servers (multi-server, single-active) ──────────────────────────────--
// The user can save several backend servers (name + url); exactly ONE is active at a
// time. Stored TOP-LEVEL (round-tripped by writeDoc) as `servers:` (a list of
// {name,url}) + `active_server:` (the NAME of the active one). The active server's url
// is ALSO mirrored into top-level `api_url:` so any legacy reader stays correct.
//   1. doc.servers (non-empty array) → use it;
//   2. else legacy doc.api_url set → [{name:"Default", url:api_url}] (migration);
//   3. else → [{name:"Local", url:LOCALHOST_DEFAULT}] (fresh-install default).
const LOCALHOST_DEFAULT = "http://localhost:9100";

// ── the two buckets ────────────────────────────────────────────────────────────
// There are exactly two ways to run this, and conflating them is what made the
// app nag people for a login they didn't need:
//
//   free  — speech runs on THIS Mac (Apple silicon). localhost, one machine, and
//           we never ask for an account, because nothing of ours is involved.
//   cloud — speech runs on ours. The host is an EMBEDDED DNS name chosen by
//           environment (the Spark today, GCP tomorrow, throwaway environments in
//           between). A login is always required, because it's our GPU.
//
// Users never type a server URL. The only thing adjustable in free mode is the
// PORT, because 9100 can collide with something else already on the machine and
// there'd otherwise be no way out of that.
// Resolved in lib/backend.js — the SAME module the launcher uses, so the client
// and the shared daemon can never disagree about the host. No URL is ever read
// from the yaml; the licence decides cloud vs this Mac.
const backend = require("./lib/backend");

// THE EDITION DECIDES THE BACKEND, and the edition was decided at boot.
//
//   local edition → this Mac (signed out, or signed in on the free plan)
//   cloud edition → ours
//
// Holding a paid licence is still what earns the cloud edition — see
// edition.entitledFrom in the auth handler. The difference is that the question is
// answered ONCE, at a point where the answer is knowable, rather than re-asked at
// runtime by callers who may be racing the session restore. That race is what
// silently disabled dictation: this function used to read auth.status() live, and
// during boot it answered "free" for a paid user.
//
// Signing out drops back to the local engine, which is always there underneath —
// via a restart, not an in-place flip. Which environment "ours" means lives in
// lib/backend.js and is set by us; a user should have to decompile to find a
// hostname.
function paidLicence() { return EDITION === edition.CLOUD; }
function backendMode() { return paidLicence() ? "cloud" : "free"; }

// Cloud is ours, so it requires an account. Free never does — this single
// predicate is what every prompt, the licence check, device registration and
// config sync hang off, instead of "is the user signed in?".
function cloudMode() { return backendMode() === "cloud"; }
function backendConfig() {
  return {
    mode: backendMode(),
    port: localPort(),
    env: cloudEnv(),
    // NOTE: the resolved host is deliberately NOT returned. The renderer never
    // needs it (main runs the probe), and not sending it means the hostname isn't
    // sitting in a window object for anyone poking at the UI.
  };
}
// The ONLY adjustable part: the local port. Mode and environment aren't settings.
// The resolved host, for main's own use only.
function backendConfig0Url() { return backend.resolve(readDoc(), paidLicence()).url; }
function setBackendConfig(patch) {
  const doc = readDoc();
  if (patch && patch.port !== undefined) {
    const n = parseInt(patch.port, 10);
    if (!Number.isFinite(n) || n <= 0 || n >= 65536) return { ok: false, error: "Enter a port between 1 and 65535." };
    doc.local_port = n;
  }
  // Free-plan dictation is opt-in: it needs a speech server installed separately.
  if (patch && patch.enabled !== undefined) doc.dictation_enabled = !!patch.enabled;
  writeDoc(doc);
  return { ok: true, ...backendConfig() };
}
// When signed in, the speech backend DNS is COMPILED IN — the user picks no
// server (that's a logged-out-only choice). Overridable via env for testing.
const COMPILED_SPEECH_URL = (process.env.SPEECH_API_URL || "http://voice-dev.talkersoft.com:9100").trim();
function normalizeServer(s) {
  return { name: String((s && s.name) || "").trim(), url: String((s && s.url) || "").trim() };
}
function readServers() {
  const doc = readDoc();
  if (Array.isArray(doc.servers) && doc.servers.length) {
    const list = doc.servers.map(normalizeServer).filter((s) => s.name && s.url);
    if (list.length) return list;
  }
  const legacy = (doc.api_url || "").toString().trim();
  if (legacy) return [{ name: "Default", url: legacy }];
  return [{ name: "Local", url: LOCALHOST_DEFAULT }];
}
// The active server: the one whose name === doc.active_server, else the first.
function activeServer() {
  const servers = readServers();
  const want = (readDoc().active_server || "").toString().trim();
  return servers.find((s) => s.name === want) || servers[0];
}
// Persist the full server model: write `servers` + `active_server`, and MIRROR the
// active url into top-level `api_url` (legacy readers). active is clamped to a real
// server (or the first); never persist an empty list.
function writeServers(servers, active) {
  let list = (Array.isArray(servers) ? servers : []).map(normalizeServer).filter((s) => s.name && s.url);
  if (!list.length) list = [{ name: "Local", url: LOCALHOST_DEFAULT }];
  let activeName = (active == null ? "" : String(active)).trim();
  if (!list.some((s) => s.name === activeName)) activeName = list[0].name;
  const doc = readDoc();
  doc.servers = list;
  doc.active_server = activeName;
  doc.api_url = (list.find((s) => s.name === activeName) || list[0]).url; // mirror for legacy readers
  writeDoc(doc);
  return { servers: list, active: activeName };
}
// The base url to use for dictation/model/probe operations. The active server's url,
// unless DICTATION_API_URL overrides it (dev last-resort, highest priority).
// The ONE url both the client and the shared daemon use. (An earlier attempt
// returned a different host when signed in, while the daemon stayed on the old
// one — they never converged and dictation died in a restart loop. One source.)
function loadApiUrl() {
  if (process.env.DICTATION_API_URL) return process.env.DICTATION_API_URL.trim();
  return backendConfig0Url();
}
const nameKey = (s) => String(s || "").trim().toLowerCase();
// Server CRUD helpers (each persists via writeServers). Validation: non-empty trimmed
// name+url, case-insensitive-unique names. They return the updated {servers,active} or
// {ok:false,error} on a validation failure.
function serversList() {
  const servers = readServers();
  return { servers, active: activeServer().name };
}
function serversAdd(name, url) {
  name = String(name || "").trim(); url = String(url || "").trim();
  if (!name || !url) return { ok: false, error: "Name and URL are required." };
  const servers = readServers();
  if (servers.some((s) => nameKey(s.name) === nameKey(name))) return { ok: false, error: "A server with that name already exists." };
  const wasEmpty = !servers.length; // (readServers never returns empty, but keep intent)
  servers.push({ name, url });
  // Adding never changes the active server unless it was the very first one added.
  const active = wasEmpty ? name : activeServer().name;
  return { ok: true, ...writeServers(servers, active) };
}
function serversRemove(name) {
  name = String(name || "").trim();
  let servers = readServers();
  const wasActive = activeServer().name === name;
  servers = servers.filter((s) => s.name !== name);
  // Never leave zero servers — re-seed Local→localhost if the last one was removed.
  if (!servers.length) return { ok: true, ...writeServers([{ name: "Local", url: LOCALHOST_DEFAULT }], "Local") };
  // Removing the active server promotes the first remaining one to active.
  const active = wasActive ? servers[0].name : activeServer().name;
  return { ok: true, ...writeServers(servers, active) };
}
function serversSetActive(name) {
  name = String(name || "").trim();
  const servers = readServers();
  if (!servers.some((s) => s.name === name)) return { ok: false, error: "No such server." };
  return { ok: true, ...writeServers(servers, name) };
}
function serversUpdate(oldName, fields) {
  oldName = String(oldName || "").trim();
  const name = String((fields && fields.name) || "").trim();
  const url = String((fields && fields.url) || "").trim();
  if (!name || !url) return { ok: false, error: "Name and URL are required." };
  const servers = readServers();
  const idx = servers.findIndex((s) => s.name === oldName);
  if (idx < 0) return { ok: false, error: "No such server." };
  if (servers.some((s, i) => i !== idx && nameKey(s.name) === nameKey(name))) return { ok: false, error: "A server with that name already exists." };
  servers[idx] = { name, url };
  // If we renamed the active server, follow the rename so it stays active.
  const active = activeServer().name === oldName ? name : activeServer().name;
  return { ok: true, ...writeServers(servers, active) };
}

// ── dictation capability probe (single source of truth) ─────────────────────────
// The MAIN process owns the active server + the probe. We hit `{url}/capabilities`
// exactly once at startup (the ACTIVE server's url) and then ONLY on explicit triggers
// (Settings Test, active-server switch, model remove). NEVER on a timer.
// dictationAvailable is derived here and pushed to BOTH renderers; everything fails
// CLOSED (blank/unreachable/timeout/garbage/downloading/no-asr → false).
let dictationAvailable = false; // single source of truth (fails closed until proven)
let lastCaps = null;            // last successful capabilities payload (or null)
// GET {url}/capabilities with a short timeout → { ok, caps, error }. Never throws.
async function probeCapabilities(url) {
  const base = (url == null ? "" : String(url)).trim().replace(/\/+$/, "");
  if (!base) return { ok: false, error: "no api_url" };
  try {
    const resp = await fetch(base + "/capabilities", { signal: AbortSignal.timeout(1500) });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    let caps;
    try { caps = await resp.json(); } catch { return { ok: false, error: "bad response" }; }
    if (!caps || typeof caps !== "object") return { ok: false, error: "bad response" };
    return { ok: true, caps };
  } catch (e) {
    const msg = (e && e.name === "TimeoutError") ? "timeout" : ((e && e.message) || "unreachable");
    return { ok: false, error: msg };
  }
}
// Only a reachable backend advertising asr:"ready" enables dictation. Anything else
// (blank/unreachable/timeout/garbage/downloading/no-asr) → false.
function availableFrom(probe) {
  return !!(probe && probe.ok && probe.caps && probe.caps.asr === "ready");
}
// Push the current dictationAvailable (+ caps) to BOTH renderers (Studio + Arcade).
function broadcastDictation() {
  const payload = { available: dictationAvailable, caps: lastCaps };
  toRenderer("dictation:available", payload);
  try { arcade.broadcastDictation(payload); } catch {}
}
// Apply a probe result: update the flag + cache and broadcast it. Returns the probe.
function applyProbe(probe) {
  const was = dictationAvailable;
  dictationAvailable = availableFrom(probe);
  lastCaps = probe && probe.ok ? probe.caps : null;
  broadcastDictation();
  // Availability DRIVES the daemon client, rather than a one-shot call at boot.
  //
  // The original reason was a race: the boot probe ran before the session was
  // restored, so a paid user looked unlicensed for a moment and the single
  // spawnGo() at startup bailed with nothing to start it again. That race is gone
  // — the edition is frozen before this runs, so the probe hits the right backend
  // on the first try. This recovery stays for the case it should always have been
  // for: a backend that simply wasn't up yet when we looked.
  if (dictationAvailable && !was) {
    logLine("info", "dictation became available — connecting the daemon");
    spawnGo();
  }
  return probe;
}
// Startup probe policy: probe the ACTIVE server's url exactly once. The fresh-install
// default (a "Local" server → localhost:9100) replaces the old auto-discover branch.
// No retries, no polling, fail-closed.
async function startupProbe() {
  const url = loadApiUrl();
  // No backend for this plan is a NORMAL state, not a failure: free-plan dictation
  // is opt-in (it needs a speech server installed separately). Probing a blank url
  // only produced an ERROR-level "no api_url", which surfaced as an alarming toast
  // on every launch for a condition the user can't act on. Say nothing and mark
  // dictation unavailable.
  if (!url) {
    logLine("info", "dictation not configured yet — no backend for this plan");
    applyProbe({ ok: false, error: "not configured" });
    return;
  }
  const probe = await probeCapabilities(url);
  logLine(probe.ok ? "info" : "err", `dictation probe ${url} → ${probe.ok ? `asr:${probe.caps.asr}` : probe.error}`);
  applyProbe(probe);
}
function getDictation() { return { available: dictationAvailable, caps: lastCaps }; }
// Seed the server model into the YAML on first run (or migrate a legacy api_url-only
// config) so the defaults are persisted to our store rather than left implicit.
function ensureServers() {
  const doc = readDoc();
  if (Array.isArray(doc.servers) && doc.servers.length && doc.active_server) return;
  const list = readServers(); // applies migration / fresh-install default
  writeServers(list, activeServer().name);
}
// ── agents (stored in the same YAML; treated as a tiny database) ───────────────
// Claude session ids are UUIDs (crypto.randomUUID). Validate before persisting.
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ""));
function normalizeAgent(a) {
  return {
    id: String(a.id || crypto.randomUUID()),
    name: String(a.name || ""),
    cwd: String(a.cwd || ""),                // start folder for claude
    color: String(a.color || ""),            // terminal/tab color (assigned on create)
    program: String(a.program || "claude"), // which agent harness this runs (see AGENT_PROGRAMS); only "claude" today
    order: Number.isFinite(parseInt(a.order, 10)) ? parseInt(a.order, 10) : 0, // sort position in the grid / Arcade rail (drag-and-drop)
    text_cleanup: a.text_cleanup === undefined ? true : !!a.text_cleanup, // false = raw Parakeet only (skip AI cleanup)
    dictation_options: Array.isArray(a.dictation_options) ? DICTATION_OPTION_KEYS.filter((k) => a.dictation_options.includes(k)) : [], // enabled cleanup tweaks (only apply when text_cleanup on)
    esc_before_send: a.esc_before_send === undefined ? true : !!a.esc_before_send, // send one Esc before dictation (clear Claude menus)
    esc_delay_ms: Number.isFinite(parseInt(a.esc_delay_ms, 10)) ? parseInt(a.esc_delay_ms, 10) : 50,
    session_id: String(a.session_id || ""),  // claude --session-id / --resume (manually editable)
    pane_id: parseInt(a.pane_id, 10) || 0,   // current live wezterm pane (0 = none)
    system_id: String(a.system_id || ""),    // which system (machine) this agent belongs to
    group_id: String(a.group_id || ""),      // which group buckets this agent ("" = built-in Default)
    active: a.active === undefined ? true : !!a.active, // false = hidden in the Arcade (still editable in Studio)
    description: String(a.description || ""), // agent's job/personality; drives the generated avatar (optional)
    avatar_status: ["pending", "ready", "failed"].includes(a.avatar_status) ? a.avatar_status : "", // generation state
    avatar_path: String(a.avatar_path || ""), // local PNG path (Electron userData) when ready
    seed: parseInt(a.seed, 10) || 0,          // deterministic avatar seed
    notes: String(a.notes || ""),
  };
}

// ── groups (a human-facing bucket for agents; independent of system) ───────────
// Groups are pure organization/UI: an agent's group_id is orthogonal to its
// system_id, so one group can span machines. "Default" is IMPLICIT (never stored)
// — an agent with no/empty group_id lives there, so agents can never be orphaned.
// In the Arcade a group only renders on a system that has active agents in it.
function normalizeGroup(g) {
  return {
    id: String(g.id || crypto.randomUUID()),
    name: String(g.name || ""),
    order: Number.isFinite(parseInt(g.order, 10)) ? parseInt(g.order, 10) : 0, // sort position among custom groups
    active: g.active === undefined ? true : !!g.active, // false = whole group hidden in the Arcade
  };
}
function loadGroups() {
  const list = store.groups();
  return list.map(normalizeGroup).sort((a, b) => a.order - b.order);
}
function saveGroups(groups) {
  const next = (groups || []).map(normalizeGroup);
  Promise.resolve(store.saveGroups(next)).catch((e) => logLine("err", `save groups: ${e.message}`));
  return next.sort((a, b) => a.order - b.order);
}

// ── systems (machines that host agents; mock layer for future remote control) ──
// Systems are name-only. No os/description. An agent with an empty system_id is
// "Default" (belongs to no system) and is never auto-assigned to one.
function normalizeSystem(s) {
  return {
    id: String(s.id || crypto.randomUUID()),
    name: String(s.name || "").trim(),
    order: Number.isFinite(parseInt(s.order, 10)) ? parseInt(s.order, 10) : 0, // sort position among systems
    active: s.active === undefined ? true : !!s.active, // false = system hidden in the Arcade filter
  };
}
function loadSystems() {
  const list = store.systems();
  return list.map(normalizeSystem).sort((a, b) => a.order - b.order);
}
function saveSystems(systems) {
  const doc = readDoc();
  doc.systems = (systems || []).map(normalizeSystem);
  writeDoc(doc);
  return loadSystems();
}
// ── agent programs (the catalog of selectable agent harnesses) ────────────────
// This is a BUSINESS RULE, not user config — the set of supported harnesses ships
// with the app, so it lives in code (not the YAML). Only "claude" today; codex /
// hermes / others get added here. Each agent instance picks one via `program`.
const AGENT_PROGRAMS = [{ id: "claude", label: "Claude", command: "claude" }];
function loadAgentPrograms() {
  return AGENT_PROGRAMS;
}

// ── dictation options (PER AGENT) ──────────────────────────────────────────────
// The catalog of optional AI-cleanup tweaks. Each option maps 1:1 to a server-side
// cleanup fragment (internal/fragments). These are PER AGENT (agent.dictation_options
// is a list of enabled keys) and only apply when that agent has Text cleanup on. The
// catalog itself is a business rule, so it lives in code, not the YAML.
const DICTATION_OPTIONS = [
  { key: "clean_speech",   label: "Clean speech",      desc: "Remove fillers & false starts; apply spoken corrections" },
  { key: "preserve_code",  label: "Preserve code",     desc: "Keep code, paths, commands, flags & casing verbatim" },
  { key: "structure_task", label: "Structure task",    desc: "Lay work out as Task / Context / Constraints / Output" },
  { key: "specify_output", label: "Specify output",    desc: "State the deliverable: a diff, file, function, or explanation" },
  { key: "no_invention",   label: "No invention",      desc: "Don't add anything you didn't say; mark gaps as TODO" },
  { key: "acceptance",     label: "Acceptance criteria", desc: "Turn \"it should…\" into an acceptance-criteria checklist" },
  { key: "concise",        label: "Concise",           desc: "Keep it short and direct" },
];
const DICTATION_OPTION_KEYS = DICTATION_OPTIONS.map((o) => o.key);
// CSV of an agent's enabled option keys, in canonical order — the `dictation_options`
// arg sent to the API. (Only used when the agent has text_cleanup on.)
function agentOptionsCSV(agent) {
  const sel = Array.isArray(agent && agent.dictation_options) ? agent.dictation_options : [];
  return DICTATION_OPTION_KEYS.filter((k) => sel.includes(k)).join(",");
}
// Tidy legacy YAML keys: drop the old GLOBAL dictation options (now per-agent), the
// pre-rename `fragments:` block, the dead single-target `claude:` block, and the
// code-defined `agent_programs` list.
function migrateLegacyConfig() {
  const doc = readDoc();
  let changed = false;
  // The old global `dictation_options:`/`fragments:` blocks were objects (key→bool);
  // per-agent options replaced them. Remove the stale top-level blocks.
  for (const k of ["dictation_options", "fragments"]) {
    if (k in doc && !Array.isArray(doc[k])) { delete doc[k]; changed = true; logLine("info", `removed legacy global ${k} block`); }
  }
  if ("claude" in doc) { // legacy single-target block; nothing reads it anymore
    delete doc.claude;
    changed = true;
    logLine("info", "removed legacy YAML claude block");
  }
  if ("agent_programs" in doc) { // business rule now lives in code, not config
    delete doc.agent_programs;
    changed = true;
    logLine("info", "removed agent_programs from YAML (now code-defined)");
  }
  if (changed) writeDoc(doc);
}

// Distinct, terminal-friendly palette for auto-assigning agent colors.
const AGENT_COLORS = [
  "#e6194B", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4",
  "#f032e6", "#bfef45", "#469990", "#9A6324", "#800000", "#000075",
];
function pickColor(taken) {
  const free = AGENT_COLORS.filter((c) => !taken.includes(c));
  const pool = free.length ? free : AGENT_COLORS;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── global app settings (shared YAML `app:` block; apply to Studio + Arcade) ──
// compose_split = % of the Arcade's ⌘E compose view given to the text editor (the
// rest is the live terminal). Clamped 20–80; default 60 (a 60/40 editor/terminal).
function clampSplit(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(20, Math.min(80, n)) : 60; }
// Dictation end-of-speech timing buffers (read live by the Arcade). Integers, clamped.
function clampInt(v, lo, hi, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; }
// Users tend to hit ⌘D the instant the last word leaves their mouth — generous defaults
// keep capturing through that (600ms tail) and give the ASR endpointer a clean finish
// (400ms pad, synthetic silence = no added latency).
function clampDictTail(v) { return clampInt(v, 0, 1500, 600); } // ms of extra capture after ⌘D send
function clampDictPad(v)  { return clampInt(v, 0, 1000, 400); } // ms of trailing silence padded onto the WAV
// Default global "summon" hotkey. ⌘⌥A — mnemonic (A = Arcade), low conflict,
// rebindable in Settings → Shortcuts. Electron accelerator syntax.
const DEFAULT_SUMMON = "Command+Alt+A";
// Normalize the `shortcuts` map. summon defaults to ⌘⌥A; "" means explicitly
// disabled. Unknown keys (e.g. future "agent:<id>" bindings) pass through, so the
// binding model is extensible without a schema change.
function normalizeShortcuts(s) {
  const out = {};
  if (s && typeof s === "object") for (const [k, v] of Object.entries(s)) out[k] = String(v == null ? "" : v).trim();
  if (out.summon === undefined) out.summon = DEFAULT_SUMMON;
  return out;
}
// Normalize the `app:` block: booleans default ON (absent === true), split clamped.
function normalizeApp(a) {
  return {
    sync_wezterm_tabs: a.sync_wezterm_tabs !== false,
    warn_on_exit: a.warn_on_exit !== false, // confirm before quitting — ON by default (live xterm shells are lost on exit); opt OUT by unchecking
    compose_split: clampSplit(a.compose_split),
    dictation_tail_ms: clampDictTail(a.dictation_tail_ms), // end-of-speech capture drain (0–1500, default 250)
    dictation_pad_ms: clampDictPad(a.dictation_pad_ms),    // trailing-silence pad (0–1000, default 200)
    mic_device_id: String(a.mic_device_id || ""),          // chosen input device ("" = system default)
    mic_device_label: String(a.mic_device_label || ""),    // its label — fallback match when the id goes stale (KVM/dock re-enumeration)
    mic_last_used: String(a.mic_last_used || ""),          // label of the device the last recording ACTUALLY used (written after each capture)
    shortcuts: normalizeShortcuts(a.shortcuts),
  };
}
function loadAppSettings() {
  return normalizeApp(readDoc().app || {});
}
function saveAppSettings(s) {
  const doc = readDoc();
  // Merge over existing app fields so a control that sends only its own key (e.g.
  // the sync-tabs toggle) doesn't wipe the others (e.g. compose_split, warn_on_exit).
  doc.app = normalizeApp({ ...(doc.app || {}), ...(s || {}) });
  writeDoc(doc);
  return loadAppSettings();
}
// Seed the app-settings block into the YAML on first run so the defaults (e.g.
// warn_on_exit ON) are persisted to our "database" rather than left implicit.
function ensureAppSettings() {
  const doc = readDoc();
  const a = doc.app || {};
  if (a.sync_wezterm_tabs === undefined || a.warn_on_exit === undefined || a.compose_split === undefined || a.dictation_tail_ms === undefined || a.dictation_pad_ms === undefined || a.shortcuts === undefined) {
    doc.app = normalizeApp(a);
    writeDoc(doc);
  }
}
// WezTerm launch size (cols × rows). Only applied when the GUI is started fresh
// (no instance running) — WezTerm can't resize an existing window from the CLI.
// Default pop-out terminal size, written into the YAML on first init. 132×38 is a
// comfortable default on the Mac display; the user can change or blank it in Studio → Settings.
const DEFAULT_WEZTERM = { cols: 132, rows: 38 };
function loadWezterm() {
  const w = readDoc().wezterm || {};
  const cols = parseInt(w.cols, 10), rows = parseInt(w.rows, 10);
  return { cols: cols > 0 ? cols : 0, rows: rows > 0 ? rows : 0 };
}
// Seed the default pop-out size into the YAML when it has no valid wezterm block.
function ensureDefaultWezterm() {
  const w = readDoc().wezterm || {};
  if (parseInt(w.cols, 10) > 0 && parseInt(w.rows, 10) > 0) return;
  const doc = readDoc();
  doc.wezterm = { ...DEFAULT_WEZTERM };
  writeDoc(doc);
}
function saveWezterm(s) {
  const doc = readDoc();
  const cols = parseInt(s && s.cols, 10), rows = parseInt(s && s.rows, 10);
  if (cols > 0 && rows > 0) doc.wezterm = { cols, rows };
  else delete doc.wezterm; // blank → use WezTerm's own default
  writeDoc(doc);
  return loadWezterm();
}

// Agents come from the STORE, which is the YAML in the local edition and the API
// in the cloud edition — decided once, in lib/store, from the frozen edition. This
// used to read the YAML unconditionally, which is why an agent created in the web
// console could never appear here however long you waited.
function loadAgents() {
  const list = store.agents();
  // Stable sort by `order` so both Studio (agents:list) and the Arcade rail render
  // in the user's drag-and-drop order. Ties keep their original (insertion) order.
  return list.map(normalizeAgent).map((a, i) => ({ a, i })).sort((x, y) => (x.a.order - y.a.order) || (x.i - y.i)).map((x) => x.a);
}
// Claude persists a session to ~/.claude/projects/<proj>/<id>.jsonl only after a
// real exchange. A session id that was launched but never used has no file — so
// `--resume` would instant-fail. Check existence to decide resume vs fresh-start.
function sessionPersisted(sessionId) {
  if (!sessionId) return false;
  const base = path.join(os.homedir(), ".claude", "projects");
  try {
    for (const d of fs.readdirSync(base)) {
      if (fs.existsSync(path.join(base, d, sessionId + ".jsonl"))) return true;
    }
  } catch {}
  return false;
}
// Writes go to whichever store this edition uses. In the cloud edition the store
// re-reads before it pushes, so an edit here can no longer overwrite something
// created in the console since the last sync — the old path mirrored the STALE
// local YAML up with a workspace-scoped delete.
function saveAgents(agents) {
  const next = (agents || []).map(normalizeAgent);
  Promise.resolve(store.saveAgents(next)).catch((e) => logLine("err", `save agents: ${e.message}`));
  return next.map((a, i) => ({ a, i })).sort((x, y) => (x.a.order - y.a.order) || (x.i - y.i)).map((x) => x.a);
}
// ── Go bridge ─────────────────────────────────────────────────────────────────
// Daemon-mode client: one connection to the shared daemon, ensured (spawned by
// path) whenever nobody is serving. handleGo consumes its messages unchanged.
let dc = null;
function ensureDaemonClient() {
  if (dc) return dc;
  dc = connectDictation({ client: "studio", appVersion: app.getVersion(), bin: GO_BIN, apiUrl: loadApiUrl, token: () => auth.token() });
  dc.on("message", handleGo);
  dc.on("up", () => {
    logLine("info", "dictation daemon connected");
    // Make sure the daemon always gets a current token on (re)connect — covers
    // app-reopen and daemon-restart gaps so a stale wristband never reaches the
    // backend. ensureFresh is a no-op when the token is still good.
    auth.ensureFresh().then((ok) => { if (ok) dc.setToken(auth.token()); });
  });
  dc.on("down", () => logLine("err", "dictation daemon unavailable — reconnecting"));
  dc.on("log", (m) => logLine("info", `daemon-client: ${m}`));
  return dc;
}
function spawnGo() {
  // Gate on the cached probe: no reachable/ready backend → no client yet. (The
  // daemon itself is cheap, but a missing api_url would just spawn a failing one.)
  if (!dictationAvailable) return;
  // No backend resolved is a NORMAL state, not a fault: not signed in on a paid
  // plan, and free-plan dictation not switched on. Dictation is simply
  // unavailable — the UI already reflects that. It used to raise an error telling
  // the user to set `api_url` in the yaml, which is now a key we strip on write,
  // so the instruction was both alarming and impossible to follow.
  if (!loadApiUrl()) {
    logLine("info", "dictation not configured — no backend for this plan yet");
    return;
  }
  ensureDaemonClient();
}
function writeGo(obj) { return !!(dc && dc.send(obj)); }

// jobId -> { agentId, tmp } for in-flight streaming dictations
const pending = {};
function cleanupTmp(p) { if (p) fs.unlink(p, () => {}); }

// Go result for a streaming dictate → route the cleaned text into the agent's pane,
// then drop the temp WAV (on both result and error — no leak).
function handleGo(m) {
  const j = pending[m.job_id]; if (!j) return;
  if (m.type === "result") { delete pending[m.job_id]; cleanupTmp(j.tmp); routeToAgent(j.agentId, m.cleaned_text); }
  else if (m.type === "error") {
    delete pending[m.job_id]; cleanupTmp(j.tmp);
    // An auth failure (required mode, stale/expired token) self-heals: force a
    // refresh and re-push the token so the NEXT dictation succeeds. The user just
    // retries once — no re-login unless the 90-day refresh token is truly dead.
    if (m.stage === "auth") {
      // Usually self-heals: refresh and re-push the token, and the next dictation
      // works. When it can't, the session is dead and dictation stays broken until
      // someone signs in — so ASK, right now.
      //
      // Two things this deliberately overrides:
      //   • the signed-in→signed-out transition check, because someone already
      //     signed out never transitions and would otherwise get a toast forever;
      //   • the post-sign-out mute, because the user just pressed a key asking for
      //     something that needs a session. Answering that isn't nagging — the
      //     mute exists to stop UNPROMPTED popups, not to refuse a request.
      auth.refresh()
        .then(() => { if (dc) dc.setToken(auth.token()); })
        .catch((e) => {
          // Only ask for a login if the backend is OURS. A local Apple-silicon
          // server has no account to sign in to, so prompting there would be
          // asking someone to authenticate to us in order to use their own Mac.
          if (!cloudMode()) { logLine("info", `dictation auth: ${e.message}`); return; }
          logLine("info", `dictation auth: ${e.message} — asking to sign in`);
          userSignedOut = false;
          openAccount("dictation");
        });
    }
    toRenderer("dictation:event", { type: "error", agentId: j.agentId, error: m.error });
  }
}

// cleaned text → the agent's WezTerm pane (honoring its esc settings), then keep
// keyboard focus on the Studio so the user can immediately dictate again.
async function routeToAgent(agentId, text) {
  const clean = (text == null ? "" : String(text)).trim();
  const agent = loadAgents().find((a) => a.id === agentId);
  if (!agent || !agent.pane_id) { toRenderer("dictation:event", { type: "error", agentId, error: "agent not running" }); return; }
  if (!clean) { toRenderer("dictation:event", { type: "result", agentId, text: "" }); return; }
  try {
    const args = ["send", "-pane", String(agent.pane_id), "-raise"];
    if (agent.esc_before_send !== false) args.push("-esc", "-esc-delay", String(agent.esc_delay_ms || 50));
    args.push("-text", clean);
    await runWez(args);
    if (win && !win.isDestroyed()) { win.show(); app.focus({ steal: true }); }
    toRenderer("dictation:event", { type: "result", agentId, text: clean });
  } catch (e) { toRenderer("dictation:event", { type: "error", agentId, error: e.message }); }
}

// ── wezterm bridge (cleaned text → a WezTerm/Claude pane) ──────────────────
// Runs the bundled wezterm-bridge binary once per action (not long-lived). WEZTERM_BIN
// is injected so the bridge finds `wezterm` despite the app's minimal PATH.
function runWez(args) {
  return new Promise((resolve, reject) => {
    execFile(WEZTERM_BRIDGE_BIN, args, { env: weztermEnv(), maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || "").toString().trim() || err.message;
          if (err.code === "ENOENT") {
            const e = new Error(`wezterm-bridge binary missing — run "npm run build:wezterm"`);
            e.code = "ENOENT";
            return reject(e);
          }
          // Surface the bridge's non-zero EXIT CODE so a caller's {ok:false,error}
          // result can carry it (the bridge exits 1 on any failure, 2 on bad usage).
          // execFile sets err.code to the numeric exit status here. Keep .message the
          // bridge's stderr (unchanged); just attach the code so the seam is visible.
          const e = new Error(msg);
          e.code = err.code;
          return reject(e);
        }
        resolve((stdout || "").toString());
      });
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Make sure the WezTerm GUI is up before we try to spawn into it. If it isn't,
// stale gui sockets get left behind (the CLI keeps trying a dead one), so we
// clear those, launch the app, and wait for it to answer.
function guiRunning() {
  return new Promise((res) => execFile("pgrep", ["-f", "wezterm-gui"], (_e, out) => res(!!(out && out.trim()))));
}
function clearWeztermSockets() {
  try {
    const dir = path.join(os.homedir(), ".local", "share", "wezterm");
    for (const f of fs.readdirSync(dir)) {
      // gui-sock-<pid> (per-GUI), sock (headless mux), default-* (the active-conn symlink)
      if (f.startsWith("gui-sock-") || f === "sock" || f.startsWith("default-")) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    }
  } catch {}
}
// A real, drivable WezTerm = a GUI process AND a reachable mux. A headless
// mux-server (auto-spawned by stray `wezterm cli` calls) is NOT enough — spawns
// would land in an invisible window. So we require both, and self-heal otherwise.
// Start the WezTerm GUI. On a fresh start we honor the configured launch size by
// overriding initial_cols/initial_rows (the only point WezTerm sizes a new window).
function resolveWeztermGui() {
  for (const p of [path.join(WEZTERM_APP_BIN, "wezterm-gui"),
                   "/opt/homebrew/bin/wezterm-gui", "/usr/local/bin/wezterm-gui",
                   "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui"]) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}
function launchWeztermGui() {
  const { cols, rows } = loadWezterm();
  const gui = resolveWeztermGui();
  if (gui) {
    try {
      // --config-file / --config are top-level options → must precede `start`.
      const args = ["--config-file", AA_WEZTERM_CONFIG];
      if (cols && rows) args.push("--config", `initial_cols=${cols}`, "--config", `initial_rows=${rows}`);
      args.push("start");
      const child = spawn(gui, args, { detached: true, stdio: "ignore", env: weztermEnv() });
      child.unref();
      logLine("info", `launching WezTerm${cols && rows ? ` at ${cols}×${rows}` : ""} (app config)`);
      return;
    } catch (e) { logLine("err", `WezTerm launch failed (${e.message}); falling back`); }
  }
  try { execFile("open", ["-a", "WezTerm"]); } catch {}
}
// Bring the WezTerm GUI fully forward: frontmost + UN-MINIMIZE + raise its window. A
// fresh `connect unix` window (or one the user minimized to the Dock) otherwise stays
// hidden — frontmost alone won't un-minimize it.
function raiseWezterm() {
  const script = [
    'tell application "System Events"',
    '  set ps to (every process whose name contains "wezterm")',
    '  if (count of ps) is 0 then return',
    '  set p to item 1 of ps',
    '  set frontmost of p to true',
    '  try',
    '    if (count of windows of p) > 0 then',
    '      set w to window 1 of p',
    '      try',
    '        set value of attribute "AXMinimized" of w to false',
    '      end try',
    '      perform action "AXRaise" of w',
    '    end if',
    '  end try',
    'end tell',
  ].join("\n");
  return new Promise((res) => execFile("osascript", ["-e", script], () => res()));
}
// Headless-first: agents only need a reachable mux (no GUI). `wezterm cli`
// auto-starts a wezterm-mux-server, so a successful pane-ids means the mux is up.
// The GUI "watch" window is opened on demand from the Arcade (pop-out), not here.
async function ensureMux() {
  for (let i = 0; i < 10; i++) {
    try { await runWez(["pane-ids"]); reconcileMux(); return true; } catch {}
    // Self-heal once on the first failure: a stale active-connection symlink
    // (default-*) left by a WezTerm that exited — e.g. switching from a standalone
    // install to the vendored one, a crash, or a reboot — points the CLI at a dead
    // gui-sock and it keeps dialing the corpse instead of starting fresh. Clearing
    // the orphan sockets lets the next `pane-ids` auto-start a clean headless mux.
    if (i === 0) clearWeztermSockets();
    await delay(400);
  }
  return false;
}
async function ensureWezterm() {
  if (await guiRunning()) { try { await runWez(["pane-ids"]); return true; } catch {} }
  logLine("info", "WezTerm not drivable — resetting (kill orphan mux, clear sockets, relaunch GUI)…");
  await new Promise((res) => execFile("pkill", ["-9", "-f", "wezterm-mux-server"], () => res()));
  clearWeztermSockets();
  launchWeztermGui();
  for (let i = 0; i < 20; i++) {
    await delay(700);
    if (await guiRunning()) { try { await runWez(["pane-ids"]); logLine("ok", "WezTerm GUI ready"); return true; } catch {} }
  }
  return false;
}

// ── IPC ───────────────────────────────────────────────────────────────────────
// studio:dictate — renderer captured a WAV → transcribe/clean via the bridge and
// stream the result into the agent's pane. Temp WAV is removed when the job ends.
ipcMain.handle("studio:dictate", (_e, payload) => {
  const agent = loadAgents().find((a) => a.id === (payload && payload.agentId));
  if (!agent) return { ok: false, error: "no agent" };
  const n = ++jobSeq;
  const tmp = path.join(os.tmpdir(), `studio-${n}-${process.pid}.wav`);
  try { fs.writeFileSync(tmp, Buffer.from(payload.wav)); } catch (e) { return { ok: false, error: e.message }; }
  const jobId = `studio-${n}`;
  pending[jobId] = { agentId: agent.id, tmp };
  if (!writeGo({ type: "dictate", job_id: jobId, wav_path: tmp, source: "studio", cleanup: agent.text_cleanup, dictation_options: agent.text_cleanup ? agentOptionsCSV(agent) : "" })) {
    delete pending[jobId]; cleanupTmp(tmp);
    return { ok: false, error: "Go bridge not running" };
  }
  return { ok: true };
});

ipcMain.handle("app:get", () => loadAppSettings());
ipcMain.handle("app:set", (_e, s) => saveAppSettings(s));
// macOS input volume (0–100) for the SYSTEM DEFAULT input device — the OS-level gain
// that silently zeroed the built-in mic once. Chromium can't touch it; osascript can.
ipcMain.handle("mic:volume:get", () => new Promise((res) =>
  execFile("osascript", ["-e", "input volume of (get volume settings)"], (e, out) => res(e ? -1 : parseInt(out, 10)))));
ipcMain.handle("mic:volume:set", (_e, n) => new Promise((res) => {
  const v = Math.max(0, Math.min(100, parseInt(n, 10) || 0));
  execFile("osascript", ["-e", `set volume input volume ${v}`], (e) => res({ ok: !e, volume: v }));
}));

// ── Talkersoft ID account (Preferences ▸ Account row) ────────────────────────────
// Sign in via the system browser (loopback catcher); the access token flows to
// the daemon and dictation is authenticated. required_by tells the renderer
// whether the backend actually enforces auth (so the row can nudge when needed).
ipcMain.handle("auth:status", () => ({
  ...auth.status(),
  issuer: (lastCaps && lastCaps.auth_issuer) || "",
  required_by: (lastCaps && lastCaps.auth) || "off",
}));
ipcMain.handle("auth:login", async (_e, loginHint) => {
  userSignedOut = false;
  try { return { ok: true, status: await auth.login(loginHint) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("auth:logout", async () => {
  userSignedOut = true; // deliberate — never prompt them back in
  try { await auth.logout(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ── dictation daemon (Preferences ▸ "Dictation daemon" action row) ───────────────
// info() feeds the chip (version · uptime · clients); restart sends shutdown and
// lets the ensure/supervision loops revive it — the chip's uptime reset is the
// user-visible proof the restart took effect.
ipcMain.handle("daemon:info", async () => {
  try { const info = await ensureDaemonClient().info(); return { ok: true, info }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("daemon:restart", () => ({ ok: !!ensureDaemonClient().shutdown("user_restart") }));

// ── dictation capability (single source of truth, owned here) ────────────────────
// Renderers read the cached flag on load; main pushes "dictation:available" on change.
ipcMain.handle("dictation:get", () => getDictation());
ipcMain.handle("dictation:apiUrl", () => loadApiUrl());
// Settings "Test" — probe the ENTERED url (no save). Re-gates from the result so a
// successful test flips dictation on live; a failed test fails closed.
ipcMain.handle("dictation:test", async (_e, url) => {
  const probe = await probeCapabilities(url);
  applyProbe(probe);
  if (probe.ok) startDictationBridge(); else stopDictationBridge();
  return probe;
});
// Save a new url for the ACTIVE server → persist (mirrors api_url) + re-probe →
// broadcast. Kept as a thin alias that edits the active server in place.
ipcMain.handle("dictation:setApiUrl", async (_e, url) => {
  const a = activeServer();
  serversUpdate(a.name, { name: a.name, url });
  const saved = loadApiUrl();
  const probe = await probeCapabilities(saved);
  logLine(probe.ok ? "info" : "err", `dictation: active server url → ${saved || "(blank)"} (${probe.ok ? `asr:${probe.caps.asr}` : probe.error})`);
  applyProbe(probe);
  if (probe.ok) startDictationBridge(); else stopDictationBridge();
  return { api_url: saved, probe };
});

// ── backend servers IPC (multi-server, single-active; verb:noun) ─────────────────
ipcMain.handle("backend:get", () => backendConfig());
// Probe the CURRENT backend. main resolves the host, so the caller never learns it.
ipcMain.handle("backend:test", async () => {
  const url = backendConfig0Url();
  const probe = await probeCapabilities(url);
  return { ok: !!(probe && probe.ok), caps: (probe && probe.caps) || null, error: (probe && probe.error) || "" };
});
ipcMain.handle("backend:set", (_e, patch) => setBackendConfig(patch || {}));
ipcMain.handle("servers:list", () => serversList());
ipcMain.handle("servers:add", (_e, p) => serversAdd(p && p.name, p && p.url));
ipcMain.handle("servers:remove", (_e, name) => serversRemove(name));
ipcMain.handle("servers:update", (_e, p) => serversUpdate(p && p.oldName, { name: p && p.name, url: p && p.url }));
// Switch the active server → persist + mirror api_url, then re-probe THAT server and
// re-broadcast availability (the existing probe path drives the dictation gate live).
ipcMain.handle("servers:setActive", async (_e, name) => {
  const res = serversSetActive(name);
  if (!res.ok) return res;
  const probe = await probeCapabilities(loadApiUrl());
  logLine(probe.ok ? "info" : "err", `dictation: active server → ${res.active} (${probe.ok ? `asr:${probe.caps.asr}` : probe.error})`);
  applyProbe(probe);
  if (probe.ok) startDictationBridge(); else stopDictationBridge();
  return { ...res, probe };
});
// ── model management (reveal / remove the backend's downloaded speech model) ─────
// model_path comes from the latest caps (a dir on the BACKEND machine). Reveal only
// makes sense when that machine is THIS machine (api_url host is localhost), so we
// gate it to local. Remove POSTs to the backend then re-probes to refresh state.
function apiHostIsLocal(url) {
  try { const h = new URL((url == null ? "" : String(url)).trim()).hostname; return h === "localhost" || h === "127.0.0.1" || h === "::1"; }
  catch { return false; }
}
// Open the model dir in Finder — only valid for a local backend (path is on this box).
ipcMain.handle("model:reveal", async () => {
  const url = loadApiUrl();
  if (!apiHostIsLocal(url)) return { ok: false, error: "only available for a local backend" };
  const p = lastCaps && lastCaps.model_path ? String(lastCaps.model_path) : "";
  if (!p) return { ok: false, error: "no model path" };
  const res = await shell.openPath(p); // returns "" on success, else an error string
  return res ? { ok: false, error: res } : { ok: true };
});
// Ask the backend to delete its downloaded model, then re-probe so the UI + gate refresh.
ipcMain.handle("model:remove", async () => {
  const url = loadApiUrl();
  const base = (url == null ? "" : String(url)).trim().replace(/\/+$/, "");
  if (!base) return { ok: false, error: "no api_url" };
  try {
    const resp = await fetch(base + "/model/remove", { method: "POST", signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    let body = null; try { body = await resp.json(); } catch {}
    logLine("info", `model: removed at ${base}${body && body.path ? ` (${body.path})` : ""}`);
  } catch (e) {
    const msg = (e && e.name === "TimeoutError") ? "timeout" : ((e && e.message) || "unreachable");
    return { ok: false, error: msg };
  }
  // Re-probe through the existing path so the Model row + dictation state refresh.
  const probe = await probeCapabilities(base);
  applyProbe(probe);
  if (probe.ok && availableFrom(probe)) startDictationBridge(); else stopDictationBridge();
  return { ok: true, probe };
});

// Availability re-probes gate the UI, not the transport: the daemon connection
// persists across flaps (an idle daemon serving nobody costs nothing), so
// "start" just ensures the client exists and "stop" is intentionally a no-op.
function startDictationBridge() { if (dictationAvailable) spawnGo(); }
function stopDictationBridge() {}

// ── Global hotkeys ─────────────────────────────────────────────────────────────
// The PERSISTENT launcher process owns the global summon hotkey — a disposable
// window process can't (it dies on window-all-closed, which is exactly when summon
// is needed). Studio's role is only: (a) persist the binding to the shared YAML
// (the launcher re-reads on change), (b) toggle a suspend sentinel so the recorder
// can capture a combo without the launcher grabbing it, (c) a transient
// register/unregister to tell the UI instantly whether a combo is free.
const SUSPEND_PATH = path.join(os.homedir(), ".hv", DEV ? ".summon-suspend.dev" : ".summon-suspend");
function checkAccelAvailable(accel) {
  if (!accel) return true;
  try { const ok = globalShortcut.register(accel, () => {}); if (ok) globalShortcut.unregister(accel); return ok; }
  catch { return false; }
}
// The menu-bar (tray) icon as a data: URL — the renderer's CSP allows data: but not
// file:, so the guided tour can't <img src="../assets/…">. Dev/prod-correct.
ipcMain.handle("ui:trayIcon", () => {
  try {
    const f = path.join(__dirname, "assets", DEV ? "tray-icon-dev@2x.png" : "tray-icon@2x.png");
    return "data:image/png;base64," + fs.readFileSync(f).toString("base64");
  } catch { return ""; }
});
// Open a credit/license link in the user's default browser (http/https only).
ipcMain.handle("ui:openExternal", (_e, url) => {
  try { if (typeof url === "string" && /^https?:\/\//i.test(url)) shell.openExternal(url); } catch {}
});
// Seed the Arcade's first-run tour. A TOP-LEVEL, self-deleting `tour:` key (NOT
// under app: — that block is whitelist-normalized on every save): each present key
// is an Arcade screen still owed an ambient hint. The Arcade ticks them off and
// deletes the key when empty, leaving no trace. Called once, at wizard completion.
ipcMain.handle("tour:seedArcade", () => {
  const doc = readDoc();
  doc.tour = { rail: true, agent: true, terminal: true };
  writeDoc(doc);
  return { ok: true };
});
ipcMain.handle("shortcuts:get", () => loadAppSettings().shortcuts || {});
// Save the summon accelerator (merging over any other bindings); the launcher
// picks it up via its YAML watch. Checked while suspended → the result is accurate.
ipcMain.handle("shortcuts:setSummon", (_e, accel) => {
  const a = (accel == null ? "" : String(accel)).trim();
  const ok = checkAccelAvailable(a);
  saveAppSettings({ shortcuts: { ...(loadAppSettings().shortcuts || {}), summon: a } });
  try { fs.unlinkSync(SUSPEND_PATH); } catch {}        // resume → launcher re-registers the saved binding
  logLine(ok ? "info" : "err", `summon hotkey → ${a || "(disabled)"}${a && !ok ? " (in use by another app)" : ""}`);
  return { ok, accel: a };
});
// While the recorder is capturing, the sentinel tells the launcher to release the
// combo so the keypress reaches the renderer (and the availability check is true).
ipcMain.handle("shortcuts:suspend", () => { try { fs.writeFileSync(SUSPEND_PATH, "1"); } catch {} return { ok: true }; });
ipcMain.handle("shortcuts:resume", () => { try { fs.unlinkSync(SUSPEND_PATH); } catch {} return { ok: true }; });
ipcMain.handle("dictationOptions:catalog", () => DICTATION_OPTIONS); // per-agent option catalog (UI renders checkboxes)
ipcMain.handle("wezterm:get", () => loadWezterm());
ipcMain.handle("wezterm:set", (_e, s) => saveWezterm(s));

// Displays for the Arcade monitor picker. Bounds are Electron DIPs — the Arcade
// is also Electron, so it matches the saved origin directly (no scaling math).
ipcMain.handle("screen:list", () => {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id, index: i, x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height,
    primary: d.id === primaryId,
  }));
});
ipcMain.handle("display:get", () => readDoc().display || {});
ipcMain.handle("display:set", (_e, d) => {
  const doc = readDoc();
  if (d && Number.isFinite(d.monitor_x)) {
    doc.display = { monitor_x: d.monitor_x, monitor_y: d.monitor_y, monitor_w: d.monitor_w, monitor_h: d.monitor_h };
  } else {
    delete doc.display; // "primary / default"
  }
  writeDoc(doc);
  logLine("info", `arcade monitor → ${doc.display ? doc.display.monitor_x + "," + doc.display.monitor_y : "primary"}`);
  return doc.display || {};
});
// Pop-out / "watch" terminal monitor — where the GUI watch window opens (separate
// from the Arcade monitor above). Read by the Arcade when it pops out WezTerm.
ipcMain.handle("watch:get", () => readDoc().watch_display || {});
ipcMain.handle("watch:set", (_e, d) => {
  const doc = readDoc();
  if (d && Number.isFinite(d.monitor_x)) {
    doc.watch_display = { monitor_x: d.monitor_x, monitor_y: d.monitor_y, monitor_w: d.monitor_w, monitor_h: d.monitor_h };
  } else {
    delete doc.watch_display; // "primary / default"
  }
  writeDoc(doc);
  logLine("info", `pop-out terminal monitor → ${doc.watch_display ? doc.watch_display.monitor_x + "," + doc.watch_display.monitor_y : "primary"}`);
  return doc.watch_display || {};
});
// Read the LIVE WezTerm window geometry via macOS Accessibility (System Events) —
// the same mechanism the Arcade uses to place the pop-out. Lets the user position
// WezTerm by hand and capture it as the watch placement. Returns ok:false with a
// reason when there's no window or Automation isn't granted (so the UI can gate).
function detectWeztermWindow() {
  const script = 'tell application "System Events" to tell (first process whose name contains "wezterm") to get {position, size} of front window';
  return new Promise((res) => {
    execFile("osascript", ["-e", script], (e, out, se) => {
      if (e) {
        const denied = /-1743|not allowed|not authoriz/i.test(String(se || ""));
        return res({ ok: false, reason: denied ? "permission" : "not-running" });
      }
      const nums = (String(out).match(/-?\d+/g) || []).map(Number);
      if (nums.length < 4) return res({ ok: false, reason: "not-running" });
      const [x, y, w, h] = nums;
      const all = screen.getAllDisplays();
      const idx = all.findIndex((d) => {
        const b = d.bounds; return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
      });
      res({ ok: true, x, y, w, h, display: idx >= 0 ? `Display ${idx + 1}` : "off-screen" });
    });
  });
}
ipcMain.handle("wezterm:detect", () => detectWeztermWindow());
// Open the WezTerm GUI window (Displays settings) so the user can drag it to the
// monitor/size they want, then Capture it. SINGLE-INSTANCE: repeated clicks used to
// spawn a fresh standalone `wezterm-gui … start` each time (2nd/3rd/4th windows), which
// also made the AppleScript resize/detect target an ambiguous "first wezterm process".
// Now: if a GUI is already running, just focus it; otherwise bring up the shared unix
// mux and attach exactly ONE GUI (the same model the Arcade pop-out uses), so
// Test/Capture/Sync all act on a single, unambiguous window.
async function ensureWeztermGuiUp() {
  if (await guiRunning()) { await raiseWezterm(); return { ok: true, reused: true }; }
  if (await ensureMux()) {
    const gui = resolveWeztermGui();
    if (gui) {
      const { cols, rows } = loadWezterm();
      const args = ["--config-file", AA_WEZTERM_CONFIG];
      if (cols && rows) args.push("--config", `initial_cols=${cols}`, "--config", `initial_rows=${rows}`);
      args.push("connect", "unix");
      try {
        spawn(gui, args, { detached: true, stdio: "ignore", env: weztermEnv() }).unref();
        logLine("info", `opened WezTerm (mux)${cols && rows ? ` at ${cols}×${rows}` : ""}`);
        // Wait for the new window to attach, then bring it forward (it opens in the
        // background / minimized otherwise).
        for (let i = 0; i < 12; i++) { await delay(300); if (await guiRunning()) break; }
        await delay(300); await raiseWezterm();
        return { ok: true };
      } catch (e) { logLine("err", `WezTerm open failed (${e.message}); falling back`); }
    }
  }
  launchWeztermGui(); // fallback: standalone start when the mux can't be brought up
  await delay(800); await raiseWezterm();
  return { ok: true };
}
ipcMain.handle("wezterm:launch", () => ensureWeztermGuiUp());
// Live-terminal view-box ratio (persisted by the Arcade): box size ÷ Arcade window.
// Studio's pop-out "Sync" multiplies it by the Arcade monitor dims to get the perfect
// WezTerm window size, so the popped-out window matches the in-Arcade view box.
ipcMain.handle("viewRatio:get", () => readDoc().view_ratio || {});
// Test the computed placement: move + size the front WezTerm window to {x,y,w,h} via
// System Events (same Accessibility path as detect/pop-out), so the user can eyeball
// it before saving. Resizes an existing window; reports not-running if none is open.
function setWeztermBounds(x, y, w, h) {
  const script = 'tell application "System Events" to tell (first process whose name contains "wezterm")\n' +
    `  set position of front window to {${x}, ${y}}\n` +
    `  set size of front window to {${w}, ${h}}\n` +
    "end tell";
  return new Promise((res) => {
    execFile("osascript", ["-e", script], (e, _out, se) => {
      if (e) {
        const s = String(se || "");
        const denied = /-1743|not allowed|not authoriz/i.test(s);
        const norun = /-1728|-1719|isn'?t running|not running|Can.?t get|no .*window/i.test(s);
        return res({ ok: false, reason: denied ? "permission" : (norun ? "not-running" : "error"), error: s.trim() });
      }
      res({ ok: true });
    });
  });
}
ipcMain.handle("wezterm:setBounds", (_e, b) => setWeztermBounds(
  parseInt(b && b.x, 10) || 0, parseInt(b && b.y, 10) || 0,
  parseInt(b && b.w, 10) || 0, parseInt(b && b.h, 10) || 0));

// ── One-button "Open & fit terminal to Arcade view" ───────────────────────────
// The whole pop-out-placement job, atomically: bring up exactly one WezTerm GUI,
// compute the window size from the chosen monitor × the live Arcade view ratio,
// CENTER it on that monitor, apply position+size, and PERSIST it as watch_display so
// the real ⌘P pop-out (arcade/main.js positionWatchWindow) reproduces it. Replaces the
// old Sync→Test→Capture→Save dance — each of those was one step of this.
//   opts.monitor: "x,y" key of the target display, or "" / missing → the Arcade's
//                 configured monitor, else the primary.
ipcMain.handle("wezterm:fit", async (_e, opts) => {
  const ratio = readDoc().view_ratio || {};
  if (!(ratio.w > 0) || !(ratio.h > 0)) return { ok: false, reason: "no-ratio" };

  const all = screen.getAllDisplays();
  const ad = readDoc().display;

  // SIZE basis = the ARCADE monitor (the display the Arcade runs fullscreen on). The
  // pop-out must match the terminal VIEW AREA inside that Arcade, so W×H = Arcade
  // monitor × view ratio — e.g. 1728×1117 × 0.809/0.887 = 1398×991. The placement
  // monitor below only decides WHERE the window lands; it NEVER affects the size.
  let aw = ad && Number.isFinite(ad.monitor_w) ? ad.monitor_w : 0;
  let ah = ad && Number.isFinite(ad.monitor_h) ? ad.monitor_h : 0;
  if (!aw || !ah) { const p = screen.getPrimaryDisplay(); aw = p.bounds.width; ah = p.bounds.height; }
  const w = Math.round(aw * ratio.w), h = Math.round(ah * ratio.h);

  // Bring up / focus the single GUI first.
  await ensureWeztermGuiUp();

  // W/H-ONLY: resize to the Arcade view size, but DO NOT move the window — keep its
  // CURRENT x/y so the user's placement is preserved (per request). Read the live window
  // position; only when that's unavailable (e.g. a brand-new window with no readable
  // position) fall back to centering on the chosen monitor (pick → Arcade monitor → primary).
  const cur = await detectWeztermWindow();
  let x, y;
  if (cur && cur.ok) {
    x = cur.x; y = cur.y;
  } else {
    const key = opts && typeof opts.monitor === "string" ? opts.monitor.trim() : "";
    let disp = null;
    if (key) { const [kx, ky] = key.split(",").map(Number); disp = all.find((d) => d.bounds.x === kx && d.bounds.y === ky) || null; }
    if (!disp && ad && Number.isFinite(ad.monitor_x)) disp = all.find((d) => d.bounds.x === ad.monitor_x && d.bounds.y === ad.monitor_y) || null;
    if (!disp) disp = screen.getPrimaryDisplay();
    const b = disp.bounds;
    x = Math.round(b.x + (b.width - w) / 2); y = Math.round(b.y + (b.height - h) / 2);
  }

  const r = await setWeztermBounds(x, y, w, h);
  if (!r.ok) return { ok: false, reason: r.reason || "error", error: r.error };

  // Persist so ⌘P reproduces this exact size (and the preserved position).
  const doc = readDoc();
  doc.watch_display = { monitor_x: x, monitor_y: y, monitor_w: w, monitor_h: h };
  writeDoc(doc);
  const idx = all.findIndex((d) => x >= d.bounds.x && x < d.bounds.x + d.bounds.width && y >= d.bounds.y && y < d.bounds.y + d.bounds.height);
  logLine("info", `pop-out fitted (size only) → ${w}×${h} @ ${x},${y}`);
  return { ok: true, x, y, w, h, display: idx >= 0 ? `Display ${idx + 1}` : "" };
});

// ── Center the pop-out on a monitor ───────────────────────────────────────────
// KEEPS the window's current SIZE; only moves it to the center of the target monitor
// (explicit "Watch on monitor" pick → the monitor it's currently on → primary). Persists.
ipcMain.handle("wezterm:center", async (_e, opts) => {
  await ensureWeztermGuiUp();
  const cur = await detectWeztermWindow();
  if (!cur || !cur.ok) return { ok: false, reason: (cur && cur.reason) || "not-running" };
  const all = screen.getAllDisplays();
  const key = opts && typeof opts.monitor === "string" ? opts.monitor.trim() : "";
  let disp = null;
  if (key) { const [kx, ky] = key.split(",").map(Number); disp = all.find((d) => d.bounds.x === kx && d.bounds.y === ky) || null; }
  if (!disp) disp = all.find((d) => cur.x >= d.bounds.x && cur.x < d.bounds.x + d.bounds.width && cur.y >= d.bounds.y && cur.y < d.bounds.y + d.bounds.height) || null;
  if (!disp) disp = screen.getPrimaryDisplay();
  const b = disp.bounds;
  const x = Math.round(b.x + (b.width - cur.w) / 2), y = Math.round(b.y + (b.height - cur.h) / 2);
  const r = await setWeztermBounds(x, y, cur.w, cur.h);
  if (!r.ok) return { ok: false, reason: r.reason || "error", error: r.error };
  const doc = readDoc();
  doc.watch_display = { monitor_x: x, monitor_y: y, monitor_w: cur.w, monitor_h: cur.h };
  writeDoc(doc);
  const idx = all.indexOf(disp);
  logLine("info", `pop-out centered → ${cur.w}×${cur.h} @ ${x},${y} (Display ${idx + 1})`);
  return { ok: true, x, y, w: cur.w, h: cur.h, display: idx >= 0 ? `Display ${idx + 1}` : "" };
});

// ── macOS Automation permission (Apple Events → System Events) ──
// Capture / Test size / pop-out all drive WezTerm through System Events, which needs the
// app to hold "Automation" permission. We can't query TCC directly, so we PROBE: run a
// harmless System Events event. Success = granted; the -1743 error = denied or not-yet-
// decided (running it also surfaces the first-time consent dialog when undecided).
function probeAutomation() {
  const script = 'tell application "System Events" to get name of first process';
  return new Promise((res) => execFile("osascript", ["-e", script], (e, _o, se) => {
    if (!e) return res({ state: "granted" });
    const s = String(se || "");
    res({ state: /-1743|not allowed|not authoriz/i.test(s) ? "denied" : "error", error: s.trim() });
  }));
}
ipcMain.handle("perm:automation:check", () => probeAutomation());
// Trigger the consent dialog (when undecided). macOS will NOT re-prompt after a prior
// deny, so if it's still not granted we open System Settings → Automation so the user can
// toggle it on manually. Returns the resulting state for the UI.
ipcMain.handle("perm:automation:request", async () => {
  const r = await probeAutomation();
  if (r.state !== "granted") {
    try { execFile("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"]); } catch {}
  }
  return r;
});
// ── Systems IPC (CRUD over the YAML store) ─────────────────────────────────────
ipcMain.handle("programs:list", () => loadAgentPrograms());
ipcMain.handle("systems:list", () => loadSystems());
ipcMain.handle("systems:save", (_e, sys) => {
  sys = sys || {};
  const systems = loadSystems();
  const id = sys.id || crypto.randomUUID();
  const existing = systems.find((s) => s.id === id) || {};
  // New systems go to the end of the order; existing keep their slot unless told otherwise.
  const order = sys.order !== undefined ? sys.order : (existing.order !== undefined ? existing.order : systems.length);
  const merged = normalizeSystem({ ...existing, id, name: sys.name !== undefined ? sys.name : existing.name, order, active: sys.active !== undefined ? sys.active : existing.active });
  const idx = systems.findIndex((s) => s.id === id);
  if (idx >= 0) systems[idx] = merged; else systems.push(merged);
  logLine("info", `saved system "${merged.name}"`);
  return saveSystems(systems);
});
// Create a system from a name and RETURN the new {id,name,order} so the agent editor
// can select it immediately after inline creation.
ipcMain.handle("systems:add", (_e, name) => {
  const systems = loadSystems();
  const merged = normalizeSystem({ name, order: systems.length });
  if (!merged.name) return { ok: false, error: "System name is required." };
  systems.push(merged);
  saveSystems(systems);
  logLine("info", `added system "${merged.name}"`);
  return merged;
});
ipcMain.handle("systems:delete", (_e, id) => {
  // Refuse while agents are still tied — the UI must reassign them first.
  const count = loadAgents().filter((a) => a.system_id === id).length;
  if (count > 0) return { ok: false, error: "in use", count };
  const systems = loadSystems().filter((s) => s.id !== id);
  logLine("info", `deleted system ${id}`);
  saveSystems(systems);
  return { ok: true };
});
// systems:reorder — persist a new ordering (array of system ids, in display order).
ipcMain.handle("systems:reorder", (_e, ids) => {
  const byId = new Map(loadSystems().map((s) => [s.id, s]));
  const next = (Array.isArray(ids) ? ids : []).map((id, i) => ({ ...(byId.get(id) || {}), id, order: i })).filter((s) => byId.has(s.id));
  return saveSystems(next);
});

// ── Groups IPC (CRUD over the YAML store) ──────────────────────────────────────
ipcMain.handle("groups:list", () => loadGroups());
ipcMain.handle("groups:save", (_e, grp) => {
  grp = grp || {};
  const groups = loadGroups();
  const id = grp.id || crypto.randomUUID();
  const existing = groups.find((g) => g.id === id) || {};
  // New groups go to the end of the order; existing keep their slot unless told otherwise.
  const order = grp.order !== undefined ? grp.order : (existing.order !== undefined ? existing.order : groups.length);
  const merged = normalizeGroup({ ...existing, id, name: grp.name, order, active: grp.active !== undefined ? grp.active : existing.active });
  if (!merged.name) return { ok: false, error: "Group name is required." };
  const idx = groups.findIndex((g) => g.id === id);
  if (idx >= 0) groups[idx] = merged; else groups.push(merged);
  logLine("info", `saved group "${merged.name}"`);
  return saveGroups(groups);
});
ipcMain.handle("groups:delete", (_e, id) => {
  // Refuse while agents are still tied — the UI must reassign them first.
  const count = loadAgents().filter((a) => (a.group_id || "") === id).length;
  if (count > 0) return { ok: false, error: "in use", count };
  const groups = loadGroups().filter((g) => g.id !== id);
  logLine("info", `deleted group ${id}`);
  saveGroups(groups);
  return { ok: true };
});
// groups:reorder — persist a new ordering (array of group ids, in display order).
ipcMain.handle("groups:reorder", (_e, ids) => {
  const byId = new Map(loadGroups().map((g) => [g.id, g]));
  const next = (Array.isArray(ids) ? ids : []).map((id, i) => ({ ...(byId.get(id) || {}), id, order: i })).filter((g) => byId.has(g.id));
  return saveGroups(next);
});

// ── Agents IPC (CRUD over the YAML store) ──────────────────────────────────────
ipcMain.handle("agents:list", () => { reconcileMux(); return loadAgents(); }); // drop dead-mux pane ids before the UI derives "running"
ipcMain.handle("agents:save", (_e, agent) => {
  agent = agent || {};
  const agents = loadAgents();
  const id = agent.id || crypto.randomUUID();
  const existing = agents.find((a) => a.id === id) || {};
  // Merge only the keys the caller actually sent, so a config-screen edit can't
  // wipe session_id / pane_id that the dashboard manages.
  const patch = {};
  for (const k of ["name", "cwd", "notes", "session_id", "pane_id", "color", "text_cleanup", "dictation_options", "esc_before_send", "esc_delay_ms", "system_id", "group_id", "active", "description", "avatar_status", "avatar_path", "seed", "order"]) {
    if (agent[k] !== undefined) patch[k] = agent[k];
  }
  // Preserve an existing agent's order; a brand-new agent is appended to the end.
  const order = patch.order !== undefined ? patch.order : (existing.order !== undefined ? existing.order : agents.length);
  const merged = normalizeAgent({ ...existing, id, ...patch, order });
  // Required-field backstop (the renderer validates too): a Claude session id (if set)
  // must be a valid UUID. system_id passes through as-is — empty means "Default"
  // (no system), and that is never auto-reassigned.
  if (!merged.name) return { ok: false, error: "Name is required." };
  // Description is OPTIONAL at save time — existing agents may have none and aren't
  // forced to add one. A non-empty description is needed only at avatar *generation*
  // time (the Regenerate button / new-agent intro), never as a save block.
  if (merged.session_id && !isUuid(merged.session_id)) return { ok: false, error: "Claude session must be a valid UUID (or blank)." };
  if (!merged.color) merged.color = pickColor(agents.filter((a) => a.id !== id).map((a) => a.color).filter(Boolean));
  const idx = agents.findIndex((a) => a.id === id);
  if (idx >= 0) agents[idx] = merged; else agents.push(merged);
  logLine("info", `saved agent "${merged.name}"`);
  return saveAgents(agents);
});
// agents:reorder — persist a new ordering (array of agent ids, in display order).
// Agents not present in the list keep their data and are appended after the listed
// ones (so a partial list can't drop them). Mirrors systems:reorder/groups:reorder.
ipcMain.handle("agents:reorder", (_e, ids) => {
  const agents = loadAgents();
  const byId = new Map(agents.map((a) => [a.id, a]));
  const seen = new Set();
  let i = 0;
  const next = [];
  for (const id of (Array.isArray(ids) ? ids : [])) {
    const a = byId.get(id);
    if (!a || seen.has(id)) continue;
    seen.add(id);
    next.push({ ...a, order: i++ });
  }
  // Append any agents not named in the list, preserving their relative order.
  for (const a of agents) {
    if (seen.has(a.id)) continue;
    next.push({ ...a, order: i++ });
  }
  return saveAgents(next);
});
ipcMain.handle("agents:delete", (_e, id) => {
  const agents = loadAgents().filter((a) => a.id !== id);
  logLine("info", `deleted agent ${id}`);
  return saveAgents(agents);
});
// agents:clone — duplicate an agent's settings under a fresh identity. Clears the
// session (a shared id would collide) and picks a new color so the copy is
// visually distinct.
ipcMain.handle("agents:clone", (_e, id) => {
  const agents = loadAgents();
  const src = agents.find((a) => a.id === id);
  if (!src) return { ok: false, error: "agent not found" };
  const clone = normalizeAgent({
    ...src,
    id: crypto.randomUUID(),
    name: `${src.name} (copy)`,
    color: pickColor(agents.map((a) => a.color).filter(Boolean)),
    session_id: "",
    pane_id: 0,
  });
  agents.push(clone);
  saveAgents(agents);
  logLine("info", `cloned "${src.name}" → "${clone.name}"`);
  return { ok: true, agent: clone };
});

// helper: update one agent in place and persist
function patchAgent(id, fields) {
  const agents = loadAgents();
  const agent = agents.find((a) => a.id === id);
  if (!agent) return null;
  Object.assign(agent, fields);
  saveAgents(agents);
  return loadAgents().find((a) => a.id === id);
}

// agents:generateAvatar — generate (or regenerate) an agent's avatar. Requires a
// non-empty description (the prompt signal). Calls the API's /generate-avatar, saves
// the PNG locally to userData/avatars/<id>.png, and records avatar_status/path/seed.
// Synchronous from the caller's view (~1-3s); the renderer shows pending→ready.
function avatarsDir() {
  const d = path.join(app.getPath("userData"), "avatars");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
ipcMain.handle("agents:generateAvatar", async (_e, id) => {
  const agent = loadAgents().find((a) => a.id === id);
  if (!agent) return { ok: false, error: "agent not found" };
  // Avatar generation just needs a non-empty description (same as the API). It is
  // NOT a requirement to create an agent — name is the only required field.
  const desc = (agent.description || "").trim();
  if (!desc) return { ok: false, error: "Add a description first." };
  const apiUrl = loadApiUrl();
  if (!apiUrl) return { ok: false, error: "Dictation API not configured (api_url)." };
  patchAgent(id, { avatar_status: "pending" });
  try {
    // The backend gates /generate-avatar on a wristband (and a qualifying
    // license). We already hold a token when signed in — send it, or the call
    // comes back 401 and avatars silently stop working.
    const token = auth.token();
    const resp = await fetch(apiUrl + "/generate-avatar", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify({ agent_id: agent.id, name: agent.name, description: desc, accent_color: agent.color || "#4363d8" }),
      signal: AbortSignal.timeout(45000),
    });
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 200);
      if (resp.status === 401) throw new Error("Sign in to generate avatars.");
      if (resp.status === 403) throw new Error("Your plan doesn't include avatar generation.");
      throw new Error(`API ${resp.status}: ${detail}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) throw new Error("empty image");
    const file = path.join(avatarsDir(), `${agent.id}.png`);
    fs.writeFileSync(file, buf);
    const seed = parseInt(resp.headers.get("x-seed"), 10) || agent.seed || 0;
    patchAgent(id, { avatar_status: "ready", avatar_path: file, seed });
    logLine("info", `avatar generated for "${agent.name}" → ${file}`);
    return { ok: true, avatar_path: file, seed };
  } catch (e) {
    patchAgent(id, { avatar_status: "failed" });
    logLine("err", `avatar generation failed for "${agent.name}": ${e.message}`);
    return { ok: false, error: e.message };
  }
});

// agents:launch — start (or resume) the agent's claude session in a WezTerm pane.
// No session_id yet → new session (claude --session-id <uuid>).
// Has session_id   → resume it      (claude --resume <uuid>).
ipcMain.handle("agents:launch", async (_e, id) => {
  // Mux up + reconciled FIRST, then load the agent so a dead-mux pane_id is dropped.
  if (!(await ensureMux())) return { ok: false, error: "WezTerm mux could not be started" };
  const agent = loadAgents().find((a) => a.id === id);
  if (!agent) return { ok: false, error: "agent not found" };
  let cwd = agent.cwd || CLAUDE_CWD;
  if (cwd.startsWith("~")) cwd = path.join(os.homedir(), cwd.slice(1));
  let sessionId = agent.session_id;
  let mode;
  const claudeArgs = [];
  if (sessionId && sessionPersisted(sessionId)) {
    mode = "resume"; claudeArgs.push("--resume", sessionId);          // real history → restore it
  } else if (sessionId) {
    mode = "start"; claudeArgs.push("--session-id", sessionId);        // id exists but never used → start with it
  } else {
    sessionId = crypto.randomUUID(); mode = "new"; claudeArgs.push("--session-id", sessionId);
  }
  try {
    const spawnArgs = ["spawn", "-claude", "-bin", CLAUDE_BIN, "-cwd", cwd];
    if (agent.color) spawnArgs.push("-tabcolor", agent.color);
    if (agent.name) spawnArgs.push("-name", agent.name);
    spawnArgs.push("--", ...claudeArgs);
    const out = await runWez(spawnArgs);
    const paneId = parseInt(out.trim(), 10);
    if (!Number.isFinite(paneId)) throw new Error(`spawn returned no pane id: ${out.trim()}`);
    const updated = patchAgent(id, { session_id: sessionId, pane_id: paneId });
    logLine("ok", `${mode === "resume" ? "resumed" : "launched"} "${agent.name}" (${mode}) session=${sessionId.slice(0, 8)}… pane=${paneId}`);
    return { ok: true, agent: updated, mode };
  } catch (e) { logLine("err", `launch "${agent.name}": ${e.message}`); return { ok: false, error: e.message }; }
});

// agents:kill — terminate the process/pane but KEEP session_id (so it can resume).
ipcMain.handle("agents:kill", async (_e, id) => {
  const agent = loadAgents().find((a) => a.id === id);
  if (!agent) return { ok: false, error: "agent not found" };
  try {
    if (agent.pane_id) await runWez(["kill", "-pane", String(agent.pane_id)]);
    const updated = patchAgent(id, { pane_id: 0 });
    logLine("info", `killed "${agent.name}" (session kept: ${agent.session_id ? agent.session_id.slice(0, 8) + "…" : "none"})`);
    return { ok: true, agent: updated };
  } catch (e) { logLine("err", `kill "${agent.name}": ${e.message}`); return { ok: false, error: e.message }; }
});

// agents:clearSession — forget the session entirely (kill pane if live, drop session_id).
ipcMain.handle("agents:clearSession", async (_e, id) => {
  const agent = loadAgents().find((a) => a.id === id);
  if (!agent) return { ok: false, error: "agent not found" };
  try { if (agent.pane_id) await runWez(["kill", "-pane", String(agent.pane_id)]); } catch {}
  const updated = patchAgent(id, { pane_id: 0, session_id: "" });
  logLine("info", `cleared session for "${agent.name}"`);
  return { ok: true, agent: updated };
});

// agents:focus — bring the agent's pane to the front.
ipcMain.handle("agents:focus", async (_e, id) => {
  const agent = loadAgents().find((a) => a.id === id);
  if (!agent || !agent.pane_id) return { ok: false, error: "agent has no live pane" };
  try {
    await runWez(["activate", "-pane", String(agent.pane_id)]); // select the right pane/tab
    try { execFile("open", ["-a", "WezTerm"]); } catch {}        // raise the WezTerm window to the front
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// agents:sendText — route cleaned dictation into an agent's pane (+Enter) and
// bring its terminal to the front. Liveness-checked so a dead pane gives a clear
// error instead of vanishing into nothing.
ipcMain.handle("agents:sendText", async (_e, payload) => {
  const id = payload && payload.id;
  const text = (payload && payload.text) || "";
  const agent = loadAgents().find((a) => a.id === id);
  if (!agent) return { ok: false, error: "agent not found" };
  if (!String(text).trim()) return { ok: false, error: "nothing to send" };
  if (!agent.pane_id) return { ok: false, error: `"${agent.name}" isn't running — Launch it on the Dashboard` };
  try {
    const out = await runWez(["pane-ids"]);
    const live = out.split("\n").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
    if (!live.includes(agent.pane_id)) return { ok: false, error: `"${agent.name}" pane is gone — relaunch on the Dashboard` };
  } catch (e) { return { ok: false, error: e.message }; }
  try {
    const sendArgs = ["send", "-pane", String(agent.pane_id), "-raise"];
    if (agent.esc_before_send !== false) sendArgs.push("-esc", "-esc-delay", String(agent.esc_delay_ms || 50));
    sendArgs.push("-text", String(text));
    await runWez(sendArgs);
    // The -raise above selects the agent's tab in WezTerm, which can pull the
    // terminal forward and steal keyboard focus. Pull focus back to the app so
    // the user can immediately dictate again with Space. (Use the Focus button
    // to deliberately bring the terminal forward.)
    if (win && !win.isDestroyed()) { win.show(); app.focus({ steal: true }); }
    logLine("ok", `→ agent "${agent.name}" (pane ${agent.pane_id}): ${JSON.stringify(String(text).slice(0, 80))}`);
    return { ok: true, paneId: agent.pane_id, name: agent.name };
  } catch (e) { logLine("err", `send to agent: ${e.message}`); return { ok: false, error: e.message }; }
});

// agents:sendEsc — send a single Esc to the agent's pane (dismiss a menu/prompt).
ipcMain.handle("agents:sendEsc", async (_e, id) => {
  const agent = loadAgents().find((a) => a.id === id);
  if (!agent || !agent.pane_id) return { ok: false, error: "agent has no live pane" };
  try { await runWez(["esc", "-pane", String(agent.pane_id)]); logLine("info", `Esc → "${agent.name}" (pane ${agent.pane_id})`); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// arcade:launch — open the Agent Arcade as a fullscreen WINDOW in THIS process
// (see arcade/main.js openArcade()). Studio tucks itself behind it and resurfaces
// when the Arcade closes (wired via arcade.onArcadeClosed in whenReady).
function launchArcadeApp() {
  // No system required — the Arcade lands on Agents when none are configured.
  try {
    if (win && !win.isDestroyed()) win.hide(); // hide Studio behind the fullscreen Arcade
    arcade.openArcade();
    logLine("ok", "opened Agent Arcade window");
    return { ok: true };
  } catch (e) { logLine("err", `launch arcade: ${e.message}`); return { ok: false, error: e.message }; }
}
ipcMain.handle("arcade:launch", () => launchArcadeApp());

// agents:getText — capture the agent's terminal pane content (its visible screen).
ipcMain.handle("agents:getText", async (_e, id) => {
  const agent = loadAgents().find((a) => a.id === id);
  if (!agent || !agent.pane_id) return { ok: false, error: "agent has no live pane" };
  try { return { ok: true, text: await runWez(["get-text", "-pane", String(agent.pane_id)]) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// wez:paneIds — the set of live pane ids, for dashboard liveness.
ipcMain.handle("wez:paneIds", async () => {
  try {
    reconcileMux(); // pane ids from a previous mux are not "live" for our agents
    const out = await runWez(["pane-ids"]);
    const ids = out.split("\n").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
    return { ok: true, ids };
  } catch (e) { return { ok: false, error: e.message, ids: [] }; }
});

// ── first-run onboarding (the login/create/free choice, BEFORE the guided tour) ─
// Shown once on a CLEAN first run (no agents, not yet onboarded). The choice is
// persisted as a top-level `onboarded:` flag so it never reappears. Force it for
// testing with DICTATE_ONBOARD=1.
let onboardWin = null;
function onboarded() { try { return readDoc().onboarded === true; } catch { return false; } }
function setOnboarded() { const d = readDoc(); d.onboarded = true; writeDoc(d); }
function needsOnboarding() {
  if (process.env.DICTATE_ONBOARD === "1") return true;
  return !onboarded() && loadAgents().length === 0;
}
function createOnboardingWindow() {
  if (onboardWin && !onboardWin.isDestroyed()) { onboardWin.show(); onboardWin.focus(); return; }
  onboardWin = new BrowserWindow({
    width: 480, height: 560, resizable: false, fullscreenable: false, minimizable: false,
    title: "Welcome to Agent Arcade", titleBarStyle: "hiddenInset",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  onboardWin.loadFile(path.join(__dirname, "renderer", "onboarding.html"));
  onboardWin.center();
}
// The renderer calls this after the user picks (login/create → auth already ran;
// free → straight through). Record it, close the choice window, and hand off to
// the normal first-run experience (Arcade welcome/tour, or Studio).
ipcMain.handle("onboarding:done", (_e, choice) => {
  setOnboarded();
  logLine("info", `onboarding: ${String(choice || "")}`);
  if (onboardWin && !onboardWin.isDestroyed()) { onboardWin.close(); }
  onboardWin = null;
  if (wantArcade()) { openArcadeWindow(); }
  else { if (!win || win.isDestroyed()) createWindow(); win.show(); win.focus(); }
  return { ok: true };
});

function createWindow(opts) {
  win = new BrowserWindow({
    width: 1280, height: 940, minHeight: 760, title: DEV ? "Agent Arcade Studio (Dev)" : "Agent Arcade Studio",
    acceptFirstMouse: true, // macOS: act on the first click even when the window isn't key (no "click twice")
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  // ?dev=1 → the renderer paints the Home Saturn amber + tags the title (debug build).
  // ?view=settings → the renderer opens straight on Preferences (menu-bar "Preferences…").
  const query = {};
  if (DEV) query.dev = "1";
  if (opts && opts.view) query.view = opts.view;
  win.loadFile(path.join(__dirname, "renderer", "index.html"), Object.keys(query).length ? { query } : undefined);
  win.center(); // a normal windowed size (1280×860) — Studio/Preferences don't need fullscreen
}

// macOS application menu. A CUSTOM menu is required to make the bold app-name menu
// read "Agent Arcade Studio" — app.setName alone doesn't override the default
// menu's title (it falls back to the bundle/process name, e.g. "Electron" in dev).
// Keeps Edit (copy/paste in inputs) + View/Window roles.
function installAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Agent Arcade Studio", submenu: [
      { label: "About Agent Arcade Studio", click: () => createAboutWindow() }, { type: "separator" },
      { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" },
      { role: "quit" },
    ] },
    { label: "Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
    ] },
    { label: "View", submenu: [
      { role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "togglefullscreen" },
    ] },
    // Custom Window menu — deliberately NO "Close Window" item, because role:"windowMenu"
    // binds ⌘W to Close at the menu level, which preempts the page keydown handler. The
    // Arcade uses ⌘W to enter the workspace shell (xterm); the global accelerator would
    // close the window before enterShell() ever runs. Keep minimize/zoom/front; the red
    // traffic-light button still closes the window.
    { label: "Window", submenu: [
      { role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" },
    ] },
  ]));
}

// ── menu-bar launcher (a separate resident process) ─────────────────────────────
// The always-on Saturn menu-bar icon lives in its OWN tiny process (launcher mode
// → launcher/main.js): Dock-hidden, no Go bridge, no window — it just launches
// Studio/Arcade. Studio spawns it on first run; the launcher then registers itself
// to open at login so it returns on every boot (Docker-style). It is single-
// instance, so spawning it repeatedly never creates a second menu-bar icon.
function ensureLauncher() {
  const env = { ...process.env, DICTATE_ARCADE: "", DICTATE_LAUNCHER: "1" };
  try {
    if (app.isPackaged) {
      spawn(process.execPath, ["--launcher"], { cwd: app.getPath("home"), env, detached: true, stdio: "ignore" }).unref();
    } else {
      spawn(path.join(__dirname, "node_modules", ".bin", "electron"),
        [__dirname, "--launcher"], { cwd: __dirname, env, detached: true, stdio: "ignore" }).unref();
    }
  } catch (e) { logLine("err", `launcher: ${e.message}`); }
}

// Cloud reads go stale the moment anything changes in the web console or on
// another machine, and there is no push channel yet. So: refresh on the moment
// that matters to a person — coming back to a window — with a slow poll
// underneath for changes made while a window already had focus. A WebSocket
// replaces the poll later; these triggers stay either way.
//
// The local edition has nothing to refresh FROM, so it wires none of this.
function wireStoreRefresh() {
  if (!store.isCloud()) return;
  const refresh = () => { store.refresh().catch(() => {}); };
  app.on("browser-window-focus", refresh);
  const t = setInterval(refresh, 60_000);
  if (t.unref) t.unref(); // never hold the process open for a poll
}

// Launched straight into the Arcade? The launcher's "Launch Arcade" passes
// --arcade; DICTATE_ARCADE stays supported for back-compat.
const wantArcade = () => process.argv.includes("--arcade") || process.env.DICTATE_ARCADE === "1";
const wantAccount = () => process.argv.includes("--account");
// Menu-bar "Preferences…" → open Studio straight on the Preferences view.
const wantPreferences = (argv) => (Array.isArray(argv) ? argv : process.argv).includes("--preferences");
// Open the Arcade window (or greet in Studio if there's no system yet).
function openArcadeWindow() {
  // No system required — boots straight into the Arcade (lands on Agents if none configured).
  if (win && !win.isDestroyed()) win.hide();
  arcade.openArcade();
}

// aaimg:// serves locally-stored avatars (userData/avatars/<id>.png) to both renderers
// under the strict CSP. Registered before 'ready'; handled in whenReady below.
protocol.registerSchemesAsPrivileged([
  { scheme: "aaimg", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

app.whenReady().then(() => {
  protocol.handle("aaimg", (request) => {
    try {
      const u = new URL(request.url); // aaimg://a/<id>?v=<seed>
      const id = decodeURIComponent((u.pathname || "").replace(/^\/+/, "")) || u.hostname;
      const buf = fs.readFileSync(path.join(app.getPath("userData"), "avatars", path.basename(id) + ".png"));
      return new Response(buf, { headers: { "content-type": "image/png", "cache-control": "no-cache" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
  // Upgrade path: pane ids / avatar paths / the mux id used to live INSIDE the
  // config file. Lift them into device state before anything reads an agent, or
  // every agent detaches from its running terminal exactly once.
  try {
    const legacy = readDoc();
    store.device().adoptFrom(legacy.agents || []);
    if (!store.device().muxId() && legacy.mux_id) store.device().setMuxId(String(legacy.mux_id));
  } catch (e) { logLine("err", `device-state adopt: ${e.message}`); }
  ensureDefaultWezterm(); // seed default pop-out terminal size (80×26) if unset
  ensureAppSettings(); // seed the app block (warn_on_exit ON, sync tabs, compose split, summon hotkey)
  migrateLegacyConfig(); // tidy legacy YAML: fragments→dictation_options, drop claude/agent_programs
  ensureServers(); // seed servers/active_server (or migrate a legacy api_url-only config)
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === "media" || permission === "microphone" || permission === "audioCapture"));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    permission === "media" || permission === "microphone" || permission === "audioCapture");
  // Use our own Saturn icon for the Dock (instead of the generic Electron icon in
  // dev; packaged builds already carry the .icns). About is a custom window now.
  const appIcon = nativeImage.createFromPath(path.join(__dirname, "assets", "app-icon.png"));
  if (!appIcon.isEmpty() && app.dock) app.dock.setIcon(appIcon);
  installAppMenu(); // app menu reads "Agent Arcade Studio" (not "Electron"/package name)
  const arcadeOnly = wantArcade(); // launched straight into the Arcade (tray "Launch Agent Arcade" / summon hotkey)
  // First run (clean config): show the login/create/free choice BEFORE any Studio/
  // Arcade window or the tour. onboarding:done then opens the real window.
  // The tray's "Account…" opens the same window every other door opens.
  if (wantAccount()) { openAccount(""); return; }

  const firstRun = needsOnboarding();
  if (firstRun) createOnboardingWindow();
  else if (!arcadeOnly) createWindow(wantPreferences() ? { view: "settings" } : undefined); // Studio window only when launched AS Studio
  arcade.onArcadeClosed(() => {
    // Exiting the Arcade returns to the MENU BAR — never auto-pops Studio. If this
    // process exists only for the Arcade, quit (the launcher is home base). If Studio
    // hosted it (you opened Studio, or the first-run wizard), return to Studio.
    if (arcadeOnly) { app.quit(); return; }
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  });
  // Welcome orb (0 agents) → open Studio so its first-agent wizard runs. Create the
  // Studio window if this was an Arcade-only launch. On wizard finish, Studio calls
  // launchArcade → the Arcade re-shows and reloads.
  arcade.onSetupRequested(() => {
    if (!win || win.isDestroyed()) createWindow();
    win.show(); win.focus();
  });
  if (!firstRun && arcadeOnly) openArcadeWindow(); // booted straight into the Arcade (unless onboarding is showing first)
  ensureLauncher(); // spawn the resident menu-bar launcher (it self-registers for login)
  // ONE capability probe at startup (or one speculative localhost probe when api_url
  // is blank). It derives dictationAvailable, pushes it to both renderers, and only
  // then spawns the Go bridge — gated on availability so a missing backend is silent.
  // Probe the backend first (populates lastCaps.auth_issuer), then try to restore
  // a saved session, then bring up the daemon (which the restored token rides via
  // the auth "change" → dc.setToken path).
  startupProbe().finally(() => {
    auth.restore().finally(() => {
      spawnGo();
      // Hydrate the account store. AFTER restore, so the cloud edition has a token
      // to read with; locally it's a no-op. Not awaited — a slow or unreachable
      // backend must never hold up a window, and the cache already drew one.
      store.start().catch((e) => logLine("err", `store: ${e.message}`));
    });
  });
  wireStoreRefresh();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
// A second launch routes here (single-instance) instead of starting a rival
// process. --arcade → open the Arcade window in THIS instance; else focus Studio.
app.on("second-instance", (_e, argv) => {
  // The launcher's summon hotkey re-spawns `--arcade`; route it to a toggle so a
  // second press dismisses the Arcade (show ⇄ hide), matching the in-app ⌘ behavior.
  if (Array.isArray(argv) && argv.includes("--arcade")) { arcade.toggleArcade(); return; }
  // "Account…" from the menu bar. This was MISSING, which is why the menu item did
  // nothing: the launcher spawns the app with the flag, the single-instance lock
  // routes it here, and with no branch it fell through to "open Studio" — or, when
  // Studio was already open, to nothing visible at all.
  if (Array.isArray(argv) && argv.includes("--account")) { openAccount(""); return; }
  // "Preferences…" from the menu bar: open/focus Studio and jump to the Preferences view.
  if (wantPreferences(argv)) {
    if (!win || win.isDestroyed()) { createWindow({ view: "settings" }); return; }
    win.show(); win.focus();
    try { win.webContents.send("ui:openPreferences"); } catch {}
    return;
  }
  // Plain "Open Agent Arcade Studio" from the menu bar: open/focus Studio AND route
  // to the Agents view — so clicking it while Preferences is showing switches back
  // (mirrors the --preferences branch above). Without this you get stuck on Prefs.
  if (!win || win.isDestroyed()) { createWindow(); return; }
  win.show(); win.focus();
  try { win.webContents.send("ui:openStudio"); } catch {}
});
// Closing the last window QUITS the process (incl. macOS). The resident menu-bar
// launcher is the persistent piece that relaunches Studio/Arcade — so "close" means
// gone, not a lingering invisible process. Combined with the single-instance lock,
// this keeps it to exactly one app process.
// The daemon OUTLIVES windows and app instances by design — quitting an app only
// closes its client connection; the launcher's quit path owns daemon shutdown.
app.on("window-all-closed", () => { if (dc) dc.close(); app.quit(); });
app.on("before-quit", () => { if (dc) { dc.close(); dc = null; } });
app.on("will-quit", () => globalShortcut.unregisterAll());
