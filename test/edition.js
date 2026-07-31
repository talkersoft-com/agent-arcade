// Tests for lib/edition.js — the boot-time edition decision.
//
// The property under test is a per-PROCESS invariant ("resolved once, then frozen
// for the life of the process"), so each scenario runs in its own child process.
// Asserting it in-process would only prove that a module-level variable holds a
// value, which is not the thing that broke.
//
// Run: node test/edition.js
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const edition = require("../lib/edition");
const { LOCAL, CLOUD } = edition;

// ── scenarios ─────────────────────────────────────────────────────────────────
// Each runs in a fresh process against a throwaway state dir. Throw to fail.
const SCENARIOS = {
  // Nothing saved → free/offline. This is the default a first-run user gets, and
  // the one a corrupt or unreadable file must degrade to.
  "fresh-is-local"(dir) {
    eq(edition.resolve({ dir, dev: false }), LOCAL, "no saved state should resolve local");
    eq(edition.isLocal(), true, "isLocal");
    eq(edition.isCloud(), false, "isCloud");
  },

  "saved-cloud-is-cloud"(dir) {
    save(dir, { edition: CLOUD, lic: "hobbyist" });
    eq(edition.resolve({ dir, dev: false }), CLOUD, "saved cloud should resolve cloud");
    eq(edition.isCloud(), true, "isCloud");
  },

  "corrupt-file-is-local"(dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(edition.stateFile(dir, false), "{ this is not json");
    eq(edition.resolve({ dir, dev: false }), LOCAL, "corrupt state must degrade to local, not throw");
  },

  "unknown-value-is-local"(dir) {
    save(dir, { edition: "enterprise-deluxe", lic: "hobbyist" });
    eq(edition.resolve({ dir, dev: false }), LOCAL, "an unrecognised edition must degrade to local");
  },

  // THE invariant. Once resolved, the answer cannot change under a running
  // process — not by another process writing the file, not by our own prefer().
  "frozen-against-disk"(dir) {
    eq(edition.resolve({ dir, dev: false }), LOCAL, "starts local");
    save(dir, { edition: CLOUD, lic: "hobbyist" });          // someone else writes
    eq(edition.current(), LOCAL, "a disk change must NOT alter a resolved process");
    edition.prefer(CLOUD, { lic: "hobbyist" });              // we write it ourselves
    eq(edition.current(), LOCAL, "prefer() saves for next boot, it does not switch now");
    eq(read(dir).edition, CLOUD, "prefer() must persist for the next boot");
  },

  // A switch persists first, then restarts — and only ever restarts once.
  "switch-restarts-once"(dir) {
    edition.resolve({ dir, dev: false });
    let restarts = 0;
    const relaunch = () => { restarts += 1; };

    eq(edition.switchTo(CLOUD, { lic: "hobbyist", relaunch }), true, "first switch commits");
    eq(restarts, 1, "restart requested once");
    eq(read(dir).edition, CLOUD, "new edition persisted before the restart");
    eq(read(dir).lic, "hobbyist", "licence persisted alongside it");
    eq(edition.current(), CLOUD_IS_NOT_LIVE_YET, "the running process stays on its booted edition");

    // Auth can fire "change" repeatedly (token refreshes). None of those may stack
    // another restart on top of one already committed.
    eq(edition.switchTo(CLOUD, { lic: "hobbyist", relaunch }), false, "second switch is a no-op");
    eq(edition.switchTo(LOCAL, { lic: "free", relaunch }), false, "no switch after one is committed");
    eq(restarts, 1, "still exactly one restart");
  },

  "switch-to-same-edition-does-nothing"(dir) {
    edition.resolve({ dir, dev: false });
    let restarts = 0;
    eq(edition.switchTo(LOCAL, { lic: "free", relaunch: () => { restarts += 1; } }), false, "same edition is not a switch");
    eq(restarts, 0, "no restart");
  },

  // If the new edition can't be written, restarting would boot back into the old
  // one and try again — forever. So a failed write means no restart.
  "unwritable-state-does-not-restart"(dir) {
    edition.resolve({ dir, dev: false });
    fs.mkdirSync(path.dirname(edition.stateFile(dir, false)), { recursive: true });
    fs.mkdirSync(edition.stateFile(dir, false), { recursive: true }); // a DIR where the file goes
    let restarts = 0;
    eq(edition.switchTo(CLOUD, { lic: "hobbyist", relaunch: () => { restarts += 1; } }), false, "must not commit");
    eq(restarts, 0, "must not restart into an unsaved edition");
  },

  // The only place live licence state is read.
  "entitlement-mapping"() {
    eq(edition.entitledFrom(null), LOCAL, "no status → local");
    eq(edition.entitledFrom({}), LOCAL, "empty status → local");
    eq(edition.entitledFrom({ signedIn: false, lic: "hobbyist" }), LOCAL, "signed out with a licence → local");
    eq(edition.entitledFrom({ signedIn: true }), LOCAL, "signed in, no licence → local");
    eq(edition.entitledFrom({ signedIn: true, lic: "free" }), LOCAL, "signed in on free → local");
    eq(edition.entitledFrom({ signedIn: true, lic: "Free" }), LOCAL, "case-insensitive free → local");
    eq(edition.entitledFrom({ signedIn: true, lic: "hobbyist" }), CLOUD, "signed in, paid → cloud");
  },

  // dev and prod keep separate editions, like every other piece of app state.
  "dev-and-prod-are-separate"(dir) {
    save(dir, { edition: CLOUD, lic: "hobbyist" }, false);   // prod file says cloud
    eq(edition.resolve({ dir, dev: true }), LOCAL, "the dev build must not inherit prod's edition");
  },
};

// `switchTo` must not mutate the running process — spelled out so the assertion
// reads as the intent rather than as a puzzle.
const CLOUD_IS_NOT_LIVE_YET = LOCAL;

// ── harness ───────────────────────────────────────────────────────────────────
function eq(got, want, what) {
  if (got !== want) throw new Error(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
function save(dir, state, dev = false) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(edition.stateFile(dir, dev), JSON.stringify({ updated: 1, ...state }));
}
function read(dir, dev = false) {
  return JSON.parse(fs.readFileSync(edition.stateFile(dir, dev), "utf8"));
}

// Child mode: run one scenario and exit non-zero on failure.
const only = process.argv[2];
if (only) {
  const dir = process.argv[3];
  try { SCENARIOS[only](dir); process.exit(0); }
  catch (e) { console.error(e.message); process.exit(1); }
}

// Parent mode: one child per scenario.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-edition-"));
let failed = 0;
for (const name of Object.keys(SCENARIOS)) {
  const dir = path.join(root, name);
  const r = spawnSync(process.execPath, [__filename, name, dir], { encoding: "utf8" });
  const ok = r.status === 0;
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `\n        ${(r.stderr || "").trim()}`}`);
}
fs.rmSync(root, { recursive: true, force: true });

const total = Object.keys(SCENARIOS).length;
console.log(`${failed ? "FAIL" : "PASS"}: edition — ${total - failed}/${total} scenarios`);
process.exit(failed ? 1 : 0);
