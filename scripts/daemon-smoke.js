#!/usr/bin/env node
// Smoke test for the dictation daemon (protocol v1, NDJSON over a local socket).
//
// Cross-platform by construction: unix domain socket on macOS/Linux, named pipe
// on Windows — this same file is the Phase-3 harness for the Win 11 Latitude.
//
//   node scripts/daemon-smoke.js [wav] [--client name] [--no-dictate]
//
// It ensures a daemon exists (connect first; spawn `dictation-go --daemon` on
// refusal — the same Docker-CLI pattern the apps use), then drives one full
// session: hello→welcome, info, health, dictate a fixture WAV, assert result.
// Exit 0 = PASS, 1 = FAIL.
"use strict";

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DEV = !!process.env.DICTATE_DEV;
const args = process.argv.slice(2);
const clientName = args.includes("--client") ? args[args.indexOf("--client") + 1] : "cli";
const noDictate = args.includes("--no-dictate");
const wavPath = path.resolve(args.find((a) => a.endsWith(".wav")) || path.join(ROOT, "testdata", "sample.wav"));

function localAddr() {
  if (process.platform === "win32") return `\\\\.\\pipe\\agent-arcade-dictation${DEV ? "-dev" : ""}`;
  return path.join(os.homedir(), ".hv", DEV ? "dictation.dev.sock" : "dictation.sock");
}

function daemonBin() {
  return path.join(ROOT, "go", "bin", process.platform === "win32" ? "dictation-go.exe" : "dictation-go");
}

// Same resolution order as the apps: explicit env wins, else the settings YAML.
function apiUrl() {
  if (process.env.DICTATION_API_URL) return process.env.DICTATION_API_URL.trim();
  const yamlPath = path.join(os.homedir(), ".hv", DEV ? "agent-arcade.dev.yaml" : "agent-arcade.yaml");
  try {
    const m = fs.readFileSync(yamlPath, "utf8").match(/^api_url:\s*["']?([^\s"'#]+)/m);
    if (m) return m[1];
  } catch {}
  return "";
}

function fail(msg) {
  console.error(`FAIL — ${msg}`);
  process.exit(1);
}

function spawnDaemon(url) {
  const bin = daemonBin();
  if (!fs.existsSync(bin)) fail(`daemon binary missing at ${bin} — run "npm run build:go"`);
  console.log(`[smoke] spawning daemon: ${bin} --daemon`);
  spawn(bin, ["--daemon"], {
    env: { ...process.env, DICTATION_API_URL: url },
    detached: true,
    stdio: "ignore",
  }).unref();
}

// Connect with the ensure-daemon loop: refused/missing → (unix) unlink the
// stale socket file → spawn → retry with backoff. A live daemon that answers
// `stale` counts as a failed attempt too — the retry lands on the fresh binary.
function connectEnsuring(url, deadlineMs) {
  const addr = localAddr();
  const t0 = Date.now();
  let delay = 250;
  let spawned = false;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect({ path: addr });
      sock.once("connect", () => resolve(sock));
      sock.once("error", (e) => {
        sock.destroy();
        if (Date.now() - t0 > deadlineMs) return reject(new Error(`cannot reach daemon at ${addr}: ${e.code || e.message}`));
        if (process.platform !== "win32") { try { fs.unlinkSync(addr); } catch {} }
        if (!spawned) { spawned = true; spawnDaemon(url); }
        setTimeout(attempt, delay);
        delay = Math.min(delay * 2, 4000);
      });
    };
    attempt();
  });
}

// Line-framed JSON reader with a queue + typed waits; unrelated broadcasts
// (logs, another client's health_result) are reported but never break a wait.
function session(sock) {
  const waiting = [];
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === "log") { console.log(`[daemon] ${msg.msg}`); continue; }
      const idx = waiting.findIndex((w) => w.types.includes(msg.type) && (!w.pred || w.pred(msg)));
      if (idx >= 0) waiting.splice(idx, 1)[0].resolve(msg);
      else console.log(`[smoke] (ignored ${msg.type})`);
    }
  });
  sock.on("close", () => {
    for (const w of waiting.splice(0)) w.reject(new Error(`connection closed while waiting for ${w.types.join("/")}`));
  });
  return {
    send: (obj) => sock.write(JSON.stringify(obj) + "\n"),
    expect: (types, pred, ms) =>
      new Promise((resolve, reject) => {
        const w = { types: [].concat(types), pred, resolve, reject };
        waiting.push(w);
        setTimeout(() => {
          const i = waiting.indexOf(w);
          if (i >= 0) { waiting.splice(i, 1); reject(new Error(`timeout waiting for ${w.types.join("/")}`)); }
        }, ms).unref();
      }),
  };
}

(async () => {
  const url = apiUrl();
  if (!url) fail("no API URL — set DICTATION_API_URL or api_url: in ~/.hv/agent-arcade.yaml");
  if (!noDictate && !fs.existsSync(wavPath)) fail(`fixture WAV missing: ${wavPath}`);

  console.log(`[smoke] addr=${localAddr()} client=${clientName} api=${url}`);
  const sock = await connectEnsuring(url, 20000);
  const s = session(sock);

  s.send({ type: "hello", client: clientName, app_version: "smoke", protocol: 1 });
  const wel = await s.expect(["welcome", "stale"], null, 5000);
  if (wel.type === "stale") {
    // Old binary stepped down; one more ensure-connect must land on the fresh one.
    console.log("[smoke] daemon reported stale — reconnecting to the fresh binary");
    sock.destroy();
    const sock2 = await connectEnsuring(url, 20000);
    const s2 = session(sock2);
    s2.send({ type: "hello", client: clientName, app_version: "smoke", protocol: 1 });
    const wel2 = await s2.expect("welcome", null, 5000);
    console.log(`[smoke] welcome: daemon v${wel2.daemon_version} api=${wel2.api_url} healthy=${wel2.healthy}`);
    console.log("PASS — stale handshake + respawn path verified (rerun for the full flow)");
    process.exit(0);
  }
  console.log(`[smoke] welcome: daemon v${wel.daemon_version} protocol=${wel.protocol} api=${wel.api_url} healthy=${wel.healthy}`);

  s.send({ type: "info" });
  const info = await s.expect("info_result", null, 5000);
  console.log(`[smoke] info: v${info.daemon_version} up=${info.uptime_s || 0}s clients=[${(info.clients || []).join(", ")}]`);

  s.send({ type: "health" });
  const health = await s.expect("health_result", null, 15000);
  console.log(`[smoke] health: ok=${health.ok} (${health.detail})`);
  if (!health.ok) fail("API health check failed — daemon works but the backend is unreachable");

  if (!noDictate) {
    const jobId = `smoke-${process.pid}-${Date.now()}`;
    s.send({ type: "dictate", job_id: jobId, wav_path: wavPath, source: "test" });
    const st = await s.expect("status", (m) => m.job_id === jobId, 10000);
    console.log(`[smoke] status: ${st.state}`);
    const res = await s.expect(["result", "error"], (m) => m.job_id === jobId, 120000);
    if (res.type === "error") fail(`dictate error at stage=${res.stage}: ${res.error}`);
    console.log(`[smoke] result in ${res.ms}ms: ${JSON.stringify(res.cleaned_text || res.raw_text || "")}`);
  }

  console.log("PASS — daemon protocol v1 round-trip OK");
  process.exit(0);
})().catch((e) => fail(e.message));
