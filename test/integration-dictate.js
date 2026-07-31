// Integration test: a REAL wav through the REAL daemon to the REAL backend.
// No mocks. Proves the whole chain — socket, hello, token, transcription — or
// fails with the stage that broke. Run: node test/integration-dictate.js <wav>
"use strict";
const net = require("net"), fs = require("fs"), os = require("os"), path = require("path");

const SOCK = path.join(os.homedir(), ".hv", process.env.DICTATE_DEV ? "dictation.dev.sock" : "dictation.sock");
const WAV = process.argv[2];
if (!WAV || !fs.existsSync(WAV)) { console.error("FAIL: need a readable wav path"); process.exit(1); }

const t0 = Date.now();
const done = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"}: ${msg} (${Date.now() - t0}ms)`); process.exit(ok ? 0 : 1); };

const s = net.connect(SOCK);
s.on("error", (e) => done(false, `cannot reach daemon at ${SOCK} — ${e.message}`));
s.on("connect", () => {
  s.write(JSON.stringify({ type: "hello", client: "cli", app_version: "itest", protocol: 1 }) + "\n");
  s.write(JSON.stringify({ type: "dictate", job_id: "itest-1", wav_path: WAV, source: "cli", cleanup: false }) + "\n");
});
let buf = "";
s.on("data", (d) => {
  buf += d; const lines = buf.split("\n"); buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === "welcome") {
      console.log(`  daemon v${m.daemon_version}  api=${m.api_url}  healthy=${m.healthy}`);
      if (!m.api_url) done(false, "daemon has NO api_url — nothing to transcribe against");
      if (m.healthy === false) done(false, `daemon reports backend unhealthy at ${m.api_url}`);
    } else if (m.type === "status") console.log(`  status: ${m.state}`);
    else if (m.type === "log") console.log(`  log: ${m.msg}`);
    else if (m.type === "error") done(false, `stage=${m.stage} ${m.error}`);
    else if (m.type === "result") {
      const text = (m.cleaned_text || m.raw_text || "").trim();
      console.log(`  transcript: ${JSON.stringify(text)}`);
      if (!text) done(false, "job returned an EMPTY transcript");
      done(true, `dictation returned ${text.split(/\s+/).length} words`);
    }
  }
});
setTimeout(() => done(false, "timed out after 60s with no result"), 60000);
