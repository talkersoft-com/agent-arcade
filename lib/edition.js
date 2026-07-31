// THE EDITION DECISION.
//
// Agent Arcade runs as exactly one of two editions:
//
//   local — free. YAML on this machine. No login, no API, no network.
//   cloud — paid. The backend owns the config. Requires a qualifying licence.
//
// The edition is resolved ONCE, at boot, before any window opens — and then it is
// frozen for the life of the process. Nothing downstream ever has to handle it
// changing, because it cannot change.
//
// WHY THIS EXISTS
//
// The app used to derive cloud-vs-local from live auth state on every read. Auth
// restores asynchronously and finishes AFTER windows are up, so for a moment at
// boot a paid user looked unlicensed. Anything that read the answer inside that
// window got the wrong one — and any one-shot startup work that ran there never
// got a second chance. That is precisely how the Arcade's dictation client came to
// never be created: it was gated on a probe that hadn't resolved yet, so
// recordings were captured, written to a temp file, and handed to a send that
// could not send.
//
// A licence change therefore does NOT flip a switch in place. It persists the new
// edition and restarts the app, so the new edition gets a real boot. A two-second
// relaunch buys the elimination of an entire class of ordering bug.
//
// The persisted file is also what the menu-bar launcher reads to decide which
// backend to hand the shared daemon — so the client and the daemon are answering
// from the same frozen decision rather than racing each other's licence lookups.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const LOCAL = "local";
const CLOUD = "cloud";

function stateDir() { return path.join(os.homedir(), ".hv"); }
function stateFile(dir, dev) {
  return path.join(dir || stateDir(), dev ? "agent-arcade-edition.dev.json" : "agent-arcade-edition.json");
}

// persisted reads the saved edition WITHOUT freezing anything — for processes that
// only need to look (the launcher), and for tests.
//
// Missing, unreadable or corrupt all answer null, and every caller treats that as
// local. That is the safe direction to fail: local needs no account, no token and
// no network, so a bad read degrades to an app that still works offline rather
// than to one that tries to reach a backend it can't authenticate to.
function persisted(opts) {
  const { dev = false, dir = stateDir() } = opts || {};
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(dir, dev), "utf8"));
    if (!raw || typeof raw !== "object") return null;
    return {
      edition: raw.edition === CLOUD ? CLOUD : LOCAL,
      lic: String(raw.lic || "free"),
      updated: Number(raw.updated) || 0,
    };
  } catch { return null; }
}

// write persists the preferred edition for the NEXT boot. Throws on failure — the
// callers below turn that into "don't restart", because restarting without having
// saved the new edition would boot straight back into the old one, forever.
function write({ edition, lic, dev = false, dir = stateDir() }) {
  const state = {
    edition: edition === CLOUD ? CLOUD : LOCAL,
    lic: String(lic || "free"),
    updated: Date.now(),
  };
  fs.mkdirSync(dir || stateDir(), { recursive: true });
  fs.writeFileSync(stateFile(dir, dev), JSON.stringify(state));
  return state;
}

// ── the frozen decision ───────────────────────────────────────────────────────
let frozen = null;          // this process's edition, once resolved
let frozenOpts = null;      // where it was read from, so later writes match
let switching = false;      // a restart is already committed — never queue a second

// resolve settles the edition for this process. Idempotent: the first call wins
// and every later call — including from another module — gets that same answer,
// even if the file on disk changes underneath us.
function resolve(opts) {
  if (frozen) return frozen;
  // dev defaults from the environment, not to false. Every process in the app
  // (Studio, the Arcade, the menu-bar launcher) has to reach the SAME answer, and
  // one that simply forgot to pass the flag used to resolve the production
  // edition instead — then spawn a daemon on the wrong socket, which is the
  // two-processes-disagree failure this whole split exists to prevent.
  const { dev = !!process.env.DICTATE_DEV, dir = stateDir(), log = () => {} } = opts || {};
  frozenOpts = { dev, dir };
  const saved = persisted({ dev, dir });
  frozen = saved ? saved.edition : LOCAL;
  log(saved ? `${frozen} edition` : `${frozen} edition (nothing saved yet — the free, offline path)`);
  return frozen;
}

function current() { return frozen || resolve(); }
function isCloud() { return current() === CLOUD; }
function isLocal() { return current() === LOCAL; }

// entitledFrom maps an auth status to the edition that licence is entitled to.
//
// This is the ONE place live licence state is allowed to influence anything, and
// all it can do is trigger a restart into the other edition. Being signed in is
// not enough: a signed-in free user is still the local edition, known to identity
// but consuming nothing of ours.
function entitledFrom(status) {
  try {
    if (!status || !status.signedIn) return LOCAL;
    const lic = String(status.lic || "").toLowerCase();
    return lic && lic !== "free" ? CLOUD : LOCAL;
  } catch { return LOCAL; }
}

// prefer saves the edition for the next boot without touching this process. Used
// when we know the edition is wrong but restarting now would be the wrong moment —
// a lapsed session, where the person needs to see why before anything moves.
function prefer(next, opts) {
  const { lic = "free", log = () => {} } = opts || {};
  try {
    write({ edition: next, lic, ...(frozenOpts || {}) });
    return true;
  } catch (e) { log(`could not save the ${next} edition: ${e.message}`); return false; }
}

// switchTo persists the new edition and restarts. Returns true only when the
// restart was actually committed.
//
// Guards, in order: never switch to the edition we're already in; never start a
// second restart; and never restart unless the new edition reached disk.
function switchTo(next, opts) {
  const { lic = "free", reason = "", relaunch, log = () => {} } = opts || {};
  const want = next === CLOUD ? CLOUD : LOCAL;
  const from = current();
  if (want === from) return false;
  if (switching) return false;
  if (!prefer(want, { lic, log })) return false;
  switching = true;
  log(`${from} → ${want}${reason ? ` (${reason})` : ""} — restarting`);
  try { if (typeof relaunch === "function") relaunch(); }
  catch (e) { log(`restart failed: ${e.message} — the ${want} edition will load on the next launch`); }
  return true;
}

module.exports = {
  LOCAL, CLOUD,
  resolve, current, isCloud, isLocal,
  entitledFrom, prefer, switchTo,
  persisted, stateFile,
};
