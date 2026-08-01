// Integration test: are the app's dictation clients actually ATTACHED to the daemon?
//
// This exists because of a whole day lost to a silent failure. The Arcade's daemon
// client was gated on a probe that hadn't resolved yet, so it was never created.
// Recordings were captured, written to disk, and dropped by a send that couldn't
// send. Nothing errored, because nothing was attempted — the daemon was healthy,
// the token was good, the backend transcribed fine. The app just never asked.
//
// A green transcription test does NOT cover this: it proves the daemon works, not
// that the app is talking to it. This asserts the connection itself.
//
// Run (with the app running): DICTATE_DEV=1 node test/integration-clients.js arcade
"use strict";
const net = require("net"), os = require("os"), path = require("path");

// The socket carries the EDITION now (go/transport.go, lib/dictation-client.js),
// so this must resolve it the same way the app does rather than guessing a name.
const edition = require("../lib/edition");
edition.resolve({ dev: !!process.env.DICTATE_DEV });
const SOCK = require("../lib/dictation-client").localAddr();
const want = process.argv.slice(2).filter(Boolean);
if (!want.length) { console.error("usage: integration-clients.js <client> [client...]"); process.exit(1); }

const done = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`); process.exit(ok ? 0 : 1); };

const s = net.connect(SOCK);
s.on("error", (e) => done(false, `cannot reach daemon at ${SOCK} — ${e.message}`));
s.on("connect", () => {
  s.write(JSON.stringify({ type: "hello", client: "cli", app_version: "itest", protocol: 1 }) + "\n");
  s.write(JSON.stringify({ type: "info" }) + "\n");
});
let buf = "";
s.on("data", (d) => {
  buf += d; const lines = buf.split("\n"); buf = lines.pop();
  for (const line of lines) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type !== "info_result") continue;
    const attached = m.clients || [];
    console.log(`  attached: [${attached.join(", ")}]`);
    const missing = want.filter((w) => !attached.includes(w));
    if (missing.length) done(false, `NOT attached: ${missing.join(", ")} — dictation from those windows goes nowhere`);
    done(true, `all expected clients attached: ${want.join(", ")}`);
  }
});
setTimeout(() => done(false, "daemon never answered info"), 5000);
