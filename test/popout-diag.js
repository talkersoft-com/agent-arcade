// Pop-out monitor diagnostic — run with `npm run test`.
//
// Reproduces exactly what the app does when you pop out a terminal, and reports
// the ground truth: configured monitor, live displays, whether a GUI attached,
// and which monitor the watch window ACTUALLY landed on after the AX move.
//
// Runs under Electron so it sees the same display geometry the app does.
const { app, screen } = require("electron");
const { spawn, execFile } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const yaml = require("js-yaml");

const SETTINGS = path.join(os.homedir(), ".hv", "dictate-settings.yaml");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function readDoc() { try { return yaml.load(fs.readFileSync(SETTINGS, "utf8")) || {}; } catch { return {}; } }
function resolveWezterm() {
  if (process.env.WEZTERM_BIN) return process.env.WEZTERM_BIN;
  for (const p of ["/opt/homebrew/bin/wezterm", "/usr/local/bin/wezterm"]) if (fs.existsSync(p)) return p;
  return "wezterm";
}
function resolveWeztermGui() {
  for (const p of ["/opt/homebrew/bin/wezterm-gui", "/usr/local/bin/wezterm-gui",
                   "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui"]) if (fs.existsSync(p)) return p;
  return null;
}
const WT = resolveWezterm();
function wez(args) { return new Promise((res) => execFile(WT, ["cli", ...args], { env: { ...process.env } }, (e, o) => res(e ? null : String(o)))); }
function osa(script) { return new Promise((res) => execFile("osascript", ["-e", script], (e, o) => res(e ? { err: String(e.message).trim() } : { out: String(o).trim() }))); }
const axGet = () => osa(`tell application "System Events" to tell (first process whose name contains "wezterm") to get {position, size} of front window`);
const axCount = () => osa(`tell application "System Events" to count (every process whose name contains "wezterm")`);
const axWindows = () => osa(`tell application "System Events" to tell (first process whose name contains "wezterm") to get position of every window`);
const axActivate = () => osa(`tell application "System Events" to set frontmost of (first process whose name contains "wezterm") to true`);
const axMove = (x, y) => osa(`tell application "System Events" to tell (first process whose name contains "wezterm") to set position of front window to {${x}, ${y}}`);

function whichDisplay(disps, x, y) {
  return disps.find((d) => x >= d.bounds.x - 5 && x < d.bounds.x + d.bounds.width &&
                           y >= d.bounds.y - 60 && y < d.bounds.y + d.bounds.height);
}

async function main() {
  log("\n===== POP-OUT MONITOR DIAGNOSTIC =====\n");

  const wd = readDoc().watch_display || {};
  log("① Configured pop-out monitor (YAML watch_display):");
  log("   ", JSON.stringify(wd));

  const primary = screen.getPrimaryDisplay().id;
  const disps = screen.getAllDisplays();
  log("\n② Live displays (as the app sees them):");
  disps.forEach((d, i) => log(`   [${i}] id=${d.id}  origin=${d.bounds.x},${d.bounds.y}  size=${d.bounds.width}x${d.bounds.height}  scale=${d.scaleFactor}${d.id === primary ? "  (PRIMARY)" : ""}`));

  const target = disps.find((d) => d.bounds.x === wd.monitor_x && d.bounds.y === wd.monitor_y);
  log("\n③ Does the configured monitor still match a real display?");
  log("   ", target ? `YES → id=${target.id} (${target.bounds.width}x${target.bounds.height})`
                     : "NO — stale config. Re-pick 'Pop-out terminal monitor' in Settings.");

  // Apple Events / Automation reachable?
  const cnt = await axCount();
  log("\n④ Apple Events (Automation) check:");
  if (cnt.err) {
    log("    DENIED or no wezterm process:", cnt.err);
    if (/not allowed|assistive|-1743|-25211|1002/i.test(cnt.err))
      log("    >>> Grant Automation → System Events to this app, then re-run.");
  } else {
    log("    OK — wezterm processes visible:", cnt.out);
  }

  // GUI attached?  (match the app: a client = a non-empty list-clients array)
  const countClients = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a.length : 0; } catch { return 0; } };
  let clients = await wez(["list-clients", "--format", "json"]);
  let n = countClients(clients);
  log("\n⑤ WezTerm GUI clients attached to mux:", n);
  if (n === 0) {
    const gui = resolveWeztermGui();
    if (!gui) { log("    ERROR: wezterm-gui not found"); return finish(2); }
    log("    Spawning watch window:", gui, "connect unix");
    const errlog = fs.openSync("/tmp/vd-gui.log", "w");
    spawn(gui, ["connect", "unix"], { detached: true, stdio: ["ignore", "ignore", errlog] }).unref();
    for (let i = 0; i < 20; i++) { await delay(400); clients = await wez(["list-clients", "--format", "json"]); n = countClients(clients); if (n > 0) break; }
    log("    After spawn → clients attached:", n);
    if (n === 0) {
      log("    ERROR: watch window never attached. wezterm-gui stderr:");
      try { log(fs.readFileSync("/tmp/vd-gui.log", "utf8") || "    (empty)"); } catch {}
      return finish(2);
    }
    await delay(600);
  }

  const wins = await axWindows();
  log("\n⑥ wezterm windows (positions):", wins.out || `(error: ${wins.err})`);

  const before = await axGet();
  log("\n⑦ Front window BEFORE move:", before.out || `(error: ${before.err})`);
  {
    const m = before.out && before.out.match(/(-?\d+),\s*(-?\d+)/);
    if (m) { const d = whichDisplay(disps, +m[1], +m[2]); log("    → on display:", d ? d.id : "unknown"); }
  }

  if (!Number.isFinite(wd.monitor_x)) { log("\nNo pop-out monitor configured (primary/default) — nothing to move."); return finish(0); }

  log("\n⑧ Bringing wezterm forward, then moving to", `{${wd.monitor_x}, ${wd.monitor_y}}`);
  await axActivate();
  await delay(250);
  const mv = await axMove(Math.round(wd.monitor_x), Math.round(wd.monitor_y));
  if (mv.err) log("    move FAILED:", mv.err);
  await delay(600);

  const after = await axGet();
  log("\n⑨ Front window AFTER move:", after.out || `(error: ${after.err})`);
  const m = after.out && after.out.match(/(-?\d+),\s*(-?\d+)/);
  if (m) {
    const landed = whichDisplay(disps, +m[1], +m[2]);
    log("\n===== RESULT =====");
    log("   configured monitor:", target ? target.id : "(unmatched)");
    log("   window landed on  :", landed ? landed.id : "unknown");
    if (target && landed && landed.id === target.id) log("   ✅ PASS — watch window is on the configured monitor.");
    else log("   ❌ FAIL — see positions above.");
  }
  return finish(0);
}

function finish(code) { setTimeout(() => app.exit(code), 250); }
app.disableHardwareAcceleration();
app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
app.on("window-all-closed", () => {});
