#!/usr/bin/env node
// Kill any already-running instance of THIS app so `npm run dev|prod` can always
// relaunch cleanly — the single-instance lock would otherwise silently block the
// new launch (the classic "I ran npm run prod and nothing came up").
//
//   node scripts/relaunch.js dev    → kills the source DEV instance (DICTATE_DEV=1)
//   node scripts/relaunch.js prod   → kills the source PROD instance AND the packaged
//                                     "Agent Arcade.app" (both share the prod lock identity)
//
// How instances are told apart: dev and prod launch with identical `electron .`
// args; the ONLY difference is the DICTATE_DEV env var, which `ps -E` exposes. The
// project path is detectable because the Electron binary lives under node_modules/.
const { execSync } = require("child_process");
const path = require("path");

const mode = (process.argv[2] || "prod").toLowerCase();
const dryRun = process.argv.includes("--dry") || process.argv.includes("-n"); // preview only, kill nothing
const PROJ = path.resolve(__dirname, "..");
const sleep = (s) => { try { execSync(`sleep ${s}`); } catch {} };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function candidates() {
  let out = "";
  try { out = execSync("ps -Aww -E -o pid=,command=", { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }); } catch { return []; }
  const pids = new Set();
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10), cmd = m[2];
    if (pid === process.pid || pid === process.ppid) continue;
    if (/--type=/.test(cmd)) continue;                 // Electron helper/renderer children — killing the main is enough
    const isSource = cmd.includes(PROJ) && /[/\\]electron[/\\]dist[/\\]/i.test(cmd);
    const isPackaged = /Agent Arcade\.app\//.test(cmd);
    const isDev = /\bDICTATE_DEV=1\b/.test(cmd);
    if (mode === "dev") {
      if (isSource && isDev) pids.add(pid);
    } else {
      if (isSource && !isDev) pids.add(pid);
      if (isPackaged) pids.add(pid);                   // packaged app holds the same prod single-instance lock
    }
  }
  return [...pids];
}

const pids = candidates();
if (!pids.length) { console.log(`[relaunch] no ${mode} instance running — launching fresh`); process.exit(0); }

if (dryRun) { console.log(`[relaunch] (dry run) would stop ${mode} instance: pid ${pids.join(", ")}`); process.exit(0); }
console.log(`[relaunch] stopping ${mode} instance (pid ${pids.join(", ")})…`);
for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
sleep(0.6);
for (const pid of pids) { if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} } }
for (let i = 0; i < 25 && pids.some(alive); i++) sleep(0.2);   // wait up to ~5s for the lock to release
console.log(`[relaunch] stopped — launching fresh`);
process.exit(0);
