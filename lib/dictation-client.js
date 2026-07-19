// Shared dictation-daemon client (protocol v1, NDJSON over a local socket).
//
// Both Electron mains (Studio + Arcade) and the launcher talk to the daemon
// through this one seam — none of them know a Go binary exists beyond handing
// us its path to spawn when no daemon answers (the Docker-CLI ensure pattern,
// locked decision #2 in docs/plans/daemon-ipc/PLAN.md).
//
//   const dc = connectDictation({ client, appVersion, bin, apiUrl });
//   dc.on("message", (m) => ...)   every daemon message, verbatim; on welcome a
//                                  synthetic {type:"ready"} is delivered first so
//                                  existing renderer handlers see the stdio shape
//   dc.on("up"/"down", ...)        connection state edges (down = daemon outage)
//   dc.send(msg) → bool            false when disconnected (≙ old writeGo)
//   dc.info() → Promise            info_result for the Preferences daemon row
//   dc.shutdown(reason), dc.close()
"use strict";

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { spawn } = require("child_process");

const DEV = !!process.env.DICTATE_DEV;

function localAddr() {
  if (process.platform === "win32") return `\\\\.\\pipe\\agent-arcade-dictation${DEV ? "-dev" : ""}`;
  return path.join(os.homedir(), ".hv", DEV ? "dictation.dev.sock" : "dictation.sock");
}

function spawnDaemon(bin, apiUrl) {
  if (!bin || !fs.existsSync(bin) || !apiUrl) return false;
  try {
    spawn(bin, ["--daemon"], {
      env: { ...process.env, DICTATION_API_URL: apiUrl },
      detached: true,
      stdio: "ignore",
    }).unref();
    return true;
  } catch {
    return false;
  }
}

// connectDictation keeps one connection alive forever (until close()): connect →
// hello → welcome; any failure → unlink a stale socket, spawn the daemon by
// path, retry with backoff. `stale` from an upgraded-out daemon is just another
// disconnect — the respawn lands on the fresh binary.
function connectDictation(opts) {
  const { client, appVersion, bin } = opts;
  const apiUrl = typeof opts.apiUrl === "function" ? opts.apiUrl : () => opts.apiUrl || "";
  const ev = new EventEmitter();
  let sock = null;
  let welcomed = false;
  let closed = false;
  let wasUp = false;
  let backoff = 250;
  const infoWaiters = [];

  // errCode decides the ensure step: ECONNREFUSED = a dead daemon's socket file
  // is squatting the path (safe to unlink — refused proves no listener behind
  // it); ENOENT = no daemon at all. Both mean "nobody serving" → spawn one.
  // Any other close (daemon died mid-session, stale step-down) just retries —
  // the next attempt hits one of those two codes if nobody took over.
  function scheduleReconnect(errCode) {
    if (closed) return;
    if (wasUp) { wasUp = false; ev.emit("down"); }
    if (errCode === "ECONNREFUSED" && process.platform !== "win32") {
      try { fs.unlinkSync(localAddr()); } catch {}
    }
    if (errCode === "ECONNREFUSED" || errCode === "ENOENT") spawnDaemon(bin, apiUrl());
    const delay = backoff;
    backoff = Math.min(backoff * 2, 4000);
    setTimeout(connect, delay);
  }

  function onMessage(m) {
    if (m.type === "welcome") {
      welcomed = true;
      backoff = 250;
      if (!wasUp) { wasUp = true; ev.emit("up"); }
      ev.emit("welcome", m);
      // Config drift: the daemon was booted with a different API URL than this
      // client is configured for (the user changed servers). Restart it — the
      // respawn env carries the fresh URL, and every client reconverges.
      const want = (apiUrl() || "").trim();
      if (want && m.api_url && m.api_url !== want) {
        ev.emit("log", `daemon api_url ${m.api_url} ≠ configured ${want} — restarting daemon`);
        send({ type: "shutdown", reason: "config_change" });
        return;
      }
      // Compat shim: stdio mode opened with {"type":"ready"} — synthesize it so
      // renderer state machines stay byte-for-byte compatible until Phase 4.
      ev.emit("message", { type: "ready", api_url: m.api_url, healthy: m.healthy });
      return;
    }
    if (m.type === "stale") {
      ev.emit("log", "daemon reported stale binary — reconnecting");
      return; // daemon exits; 'close' drives the reconnect onto the fresh binary
    }
    if (m.type === "info_result" && infoWaiters.length) infoWaiters.shift().resolve(m);
    ev.emit("message", m);
  }

  function connect() {
    if (closed) return;
    welcomed = false;
    let errCode = "";
    sock = net.connect({ path: localAddr() });
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(JSON.stringify({ type: "hello", client, app_version: appVersion || "", protocol: 1 }) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { onMessage(JSON.parse(line)); } catch {}
      }
    });
    sock.on("error", (e) => { errCode = (e && e.code) || ""; }); // 'close' always follows
    sock.on("close", () => {
      sock = null;
      for (const w of infoWaiters.splice(0)) w.reject(new Error("daemon disconnected"));
      scheduleReconnect(errCode);
    });
  }

  function send(obj) {
    if (!sock || !welcomed) return false;
    try { sock.write(JSON.stringify(obj) + "\n"); return true; } catch { return false; }
  }

  ev.send = send;
  ev.dictate = (msg) => send({ ...msg, type: "dictate" });
  ev.health = () => send({ type: "health" });
  ev.shutdown = (reason) => send({ type: "shutdown", reason: reason || "" });
  ev.info = () =>
    new Promise((resolve, reject) => {
      if (!send({ type: "info" })) return reject(new Error("daemon not connected"));
      const w = { resolve, reject };
      infoWaiters.push(w);
      setTimeout(() => {
        const i = infoWaiters.indexOf(w);
        if (i >= 0) { infoWaiters.splice(i, 1); reject(new Error("info timeout")); }
      }, 3000).unref();
    });
  ev.close = () => {
    closed = true;
    if (sock) sock.destroy();
  };
  Object.defineProperty(ev, "connected", { get: () => !!(sock && welcomed) });

  connect();
  return ev;
}

// shutdownDaemon: best-effort one-shot "stop the daemon" (launcher quit path).
// Resolves true if a daemon acknowledged the hello and was told to shut down,
// false if nothing was listening. Never spawns, never retries.
function shutdownDaemon(reason) {
  return new Promise((resolve) => {
    const sock = net.connect({ path: localAddr() });
    const done = (ok) => { try { sock.destroy(); } catch {} resolve(ok); };
    const timer = setTimeout(() => done(false), 1500);
    timer.unref();
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(JSON.stringify({ type: "hello", client: "launcher", app_version: "", protocol: 1 }) + "\n");
      sock.write(JSON.stringify({ type: "shutdown", reason: reason || "quit" }) + "\n");
      setTimeout(() => { clearTimeout(timer); done(true); }, 150);
    });
    sock.on("error", () => { clearTimeout(timer); done(false); });
  });
}

module.exports = { connectDictation, shutdownDaemon, localAddr };
