// Integration test: the daemon split.
//
// Two things have to hold, and neither is provable by reading code:
//
//   1. The JS client and the Go daemon compute the SAME address for a given
//      edition. Two answers means a client talks to one daemon while another
//      serves someone else — the exact class of failure lib/backend.js exists to
//      prevent, and the reason dictation once returned 401 from a backend nobody
//      had authenticated to. This test proves agreement by actually connecting.
//
//   2. A daemon can run with NO backend. Free-plan dictation is opt-in, and the
//      old binary exited at launch without DICTATION_API_URL — so the only way to
//      run the free edition was to have the paid edition's backend. It must now
//      start, report itself unhealthy WITH A REASON, and refuse a job out loud.
//      Silence is the failure mode that cost a day.
//
// Uses a throwaway edition dir and its own socket, so it never touches a running
// app's daemon.
//
// Run: node test/daemon-editions.js
"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const BIN = path.join(REPO, "go", "bin", "dictation-go");

const done = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"}: daemon-editions — ${msg}`); process.exit(ok ? 0 : 1); };
function eq(got, want, what) {
  if (got !== want) throw new Error(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

// addrFor asks a CHILD process (the edition is frozen per process) what socket
// the JS client would use for a given edition.
function addrFor(ed, dir) {
  const script = `
    const e = require(${JSON.stringify(path.join(REPO, "lib", "edition"))});
    e.resolve({ dir: ${JSON.stringify(dir)}, dev: true });
    process.stdout.write(require(${JSON.stringify(path.join(REPO, "lib", "dictation-client"))}).localAddr());
  `;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agent-arcade-edition.dev.json"), JSON.stringify({ edition: ed, lic: "x", updated: 1 }));
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, DICTATE_DEV: "1" } });
  if (r.status !== 0) throw new Error(`addrFor(${ed}) failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function main() {
  if (!fs.existsSync(BIN)) done(false, `daemon binary missing at ${BIN} — run npm run build:go`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-daemon-"));

  // ── 1. the two editions do not share an address ────────────────────────────
  const localAddr = addrFor("local", path.join(root, "l"));
  const cloudAddr = addrFor("cloud", path.join(root, "c"));
  console.log(`  local: ${path.basename(localAddr)}`);
  console.log(`  cloud: ${path.basename(cloudAddr)}`);
  if (localAddr === cloudAddr) throw new Error("the editions share a socket — one daemon would force the other to step down");

  // ── 2. a backend-less daemon starts, on the address the CLIENT expects ─────
  // HOME is redirected so the daemon writes its socket into the throwaway dir and
  // cannot collide with the running app's.
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".hv"), { recursive: true });
  const env = { ...process.env, HOME: home, DICTATE_DEV: "1", DICTATION_EDITION: "local", DICTATION_PROVIDER: "none", DICTATION_API_URL: "" };
  const child = spawn(BIN, ["--daemon"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });

  const sock = path.join(home, ".hv", path.basename(localAddr));
  for (let i = 0; i < 60 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
  if (!fs.existsSync(sock)) {
    child.kill();
    throw new Error(`daemon never bound ${path.basename(sock)} — a free edition still cannot start a daemon.\n${stderr.trim()}`);
  }
  // The name the daemon chose is the name the client computes. That IS the test.
  eq(path.basename(sock), path.basename(localAddr), "Go and JS must agree on the socket name");

  // ── 3. it answers, unhealthy, with a reason ────────────────────────────────
  const msgs = await talk(sock, [
    { type: "hello", client: "itest", app_version: "test", protocol: 1 },
    { type: "dictate", job_id: "j1", wav_path: "/nonexistent.wav", source: "itest" },
  ]);
  const welcome = msgs.find((m) => m.type === "welcome");
  if (!welcome) throw new Error("no welcome from a backend-less daemon");
  eq(welcome.healthy, false, "a daemon with no speech server must report itself unhealthy");

  // ── 4. and it REFUSES OUT LOUD rather than swallowing the job ──────────────
  const err = msgs.find((m) => m.type === "error" && m.job_id === "j1");
  if (!err) throw new Error("a dictate with no backend produced NO reply — silence is the bug this whole split exists to end");
  if (!/speech server/i.test(err.error || "")) throw new Error(`the refusal must say why, got: ${err.error}`);
  console.log(`  refusal: "${err.error}"`);

  child.kill();
  fs.rmSync(root, { recursive: true, force: true });
  done(true, "editions use separate sockets; a backend-less daemon starts, reports unhealthy, and refuses out loud");
}

// talk opens one connection, sends the lines, and collects replies for a moment.
function talk(sockPath, lines) {
  return new Promise((resolve, reject) => {
    const out = [];
    const s = net.connect(sockPath);
    s.setEncoding("utf8");
    s.on("error", reject);
    s.on("connect", () => { for (const l of lines) s.write(JSON.stringify(l) + "\n"); });
    let buf = "";
    s.on("data", (d) => {
      buf += d;
      const parts = buf.split("\n"); buf = parts.pop();
      for (const p of parts) { try { out.push(JSON.parse(p)); } catch {} }
    });
    setTimeout(() => { s.destroy(); resolve(out); }, 1500);
  });
}

main().catch((e) => done(false, e.message));
