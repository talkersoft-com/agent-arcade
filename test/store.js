// Tests for lib/store — where agents come from.
//
// The bug this exists to prevent: an agent created in the web console never
// appeared in the app. loadAgents() read the YAML in EVERY mode, so signing in
// changed a label and nothing else. The headline scenario below is exactly that
// case — an agent that exists in the API and NOT in the YAML — asserted from both
// editions, because the answer must differ between them.
//
// The edition is frozen per process, so each scenario runs in its own child.
//
// Run: node test/store.js
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const edition = require("../lib/edition");

// An agent that exists ONLY in the backend — the one you made in the console.
const WEB_AGENT = { id: "web-1", name: "Made In Console", program: "claude", order: 0, active: true };
// An agent that exists only in the local YAML.
const YAML_AGENT = { id: "yaml-1", name: "Made On This Mac", program: "claude", order: 0, active: true };

const yamlDoc = () => ({ agents: [YAML_AGENT], groups: [], commands: [{ id: "c1", name: "Deploy" }] });

// A fetch stub standing in for agent-arcade-api. Records calls so tests can assert
// ORDER (a save must refresh before it pushes) and payload shape.
function fakeApi({ agents = [WEB_AGENT], groups = [], fail = false } = {}) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const method = opts.method || "GET";
    calls.push({ method, url, body: opts.body ? JSON.parse(opts.body) : null });
    if (fail) throw new Error("network down");
    if (method === "GET") {
      // An older backend omits `commands` entirely; a current one always sends it.
      const body = { agents, groups, systems: [] };
      if (impl.withCommands) body.commands = [{ id: "k1", name: "FromApi" }];
      return { ok: true, json: async () => body };
    }
    if (method === "PUT") { agents = opts.body ? JSON.parse(opts.body).agents : agents; return { ok: true }; }
    return { ok: true };
  };
  impl.calls = calls;
  impl.current = () => agents;
  return impl;
}

const SCENARIOS = {
  // ── THE headline case ───────────────────────────────────────────────────────
  async "cloud-edition-sees-an-agent-that-is-only-in-the-api"(dir) {
    saveEdition(dir, "cloud");
    edition.resolve({ dir, dev: false });
    const store = freshStore();
    const api = fakeApi();
    store.init({ dir, ...deps(dir), fetchImpl: api });
    await store.start();
    const names = store.agents().map((a) => a.name);
    has(names, "Made In Console", "the console-created agent must reach the app");
    eq(names.includes("Made On This Mac"), false, "cloud edition must NOT read the local YAML");
  },

  async "local-edition-reads-yaml-and-never-the-api"(dir) {
    saveEdition(dir, "local");
    edition.resolve({ dir, dev: false });
    const store = freshStore();
    const api = fakeApi();
    store.init({ dir, ...deps(dir), fetchImpl: api });
    await store.start();
    const names = store.agents().map((a) => a.name);
    has(names, "Made On This Mac", "local edition reads the YAML");
    eq(names.includes("Made In Console"), false, "local edition must not pull from the API");
    eq(api.calls.length, 0, "the free path must make NO network calls at all");
    eq(store.commands().length, 1, "macros come from the YAML locally");
  },

  // ── offline / boot behaviour ────────────────────────────────────────────────
  async "cloud-boots-from-cache-when-the-api-is-unreachable"(dir) {
    saveEdition(dir, "cloud");
    edition.resolve({ dir, dev: false });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cloud-config-cache.json"),
      JSON.stringify({ agents: [WEB_AGENT], groups: [], systems: [], commands: [] }));
    const store = freshStore();
    store.init({ dir, ...deps(dir), fetchImpl: fakeApi({ fail: true }) });
    await store.start();
    has(store.agents().map((a) => a.name), "Made In Console", "a dead backend must not empty the app");
    eq(store.status().stale, true, "and it must report itself stale, not pretend to be current");
  },

  async "cloud-with-no-cache-and-no-network-is-empty-but-honest"(dir) {
    saveEdition(dir, "cloud");
    edition.resolve({ dir, dev: false });
    const store = freshStore();
    store.init({ dir, ...deps(dir), fetchImpl: fakeApi({ fail: true }) });
    const r = await store.start();
    eq(store.agents().length, 0, "nothing to show");
    eq(r.ok, false, "and start() says so rather than reporting success");
    eq(store.status().error, "network down", "the reason is carried, not swallowed");
  },

  // ── device fields survive account data being replaced wholesale ─────────────
  async "refresh-preserves-per-machine-fields"(dir) {
    saveEdition(dir, "cloud");
    edition.resolve({ dir, dev: false });
    const store = freshStore();
    store.init({ dir, ...deps(dir), fetchImpl: fakeApi() });
    await store.start();
    // The app attaches a live WezTerm pane to the agent.
    store.device().patchAgent("web-1", { pane_id: 42, avatar_path: "/tmp/a.png" });
    eq(store.agents()[0].pane_id, 42, "the pane shows on the agent");
    await store.refresh(); // the API replaces the whole snapshot
    eq(store.agents()[0].pane_id, 42, "a refresh must not detach a live pane");
    eq(store.agents()[0].avatar_path, "/tmp/a.png", "nor forget the cached avatar");
  },

  // Device fields must not reach account storage in EITHER edition — that is how
  // one laptop's pane ids used to end up in an account two machines read.
  async "device-fields-never-reach-the-yaml"(dir) {
    saveEdition(dir, "local");
    edition.resolve({ dir, dev: false });
    const store = freshStore();
    let written = null;
    store.init({ dir, readDoc: yamlDoc, writeDoc: (d) => { written = d; }, token: () => "", deviceId: "d" });
    await store.start();
    await store.saveAgents([{ ...YAML_AGENT, pane_id: 9, avatar_path: "/tmp/y.png", avatar_status: "ready" }]);
    const saved = written.agents[0];
    eq("pane_id" in saved, false, "pane_id must not be written into the config file");
    eq("avatar_path" in saved, false, "nor avatar_path");
    eq(saved.name, "Made On This Mac", "real fields still persist");
  },

  // The upgrade path. Existing users carry pane ids INSIDE their YAML agents; if
  // those aren't lifted out on first run, every agent detaches from its running
  // terminal exactly once and relaunches into a fresh one.
  async "adopts-pane-ids-that-still-live-in-the-yaml"(dir) {
    saveEdition(dir, "local");
    edition.resolve({ dir, dev: false });
    const store = freshStore();
    const legacy = () => ({ agents: [{ ...YAML_AGENT, pane_id: 24, avatar_status: "ready" }], groups: [], commands: [] });
    store.init({ dir, readDoc: legacy, writeDoc: () => {}, token: () => "", deviceId: "d" });
    store.device().adoptFrom(legacy().agents);
    eq(store.device().forAgent("yaml-1").pane_id, 24, "the pane id moved to device state");
    eq(store.agents()[0].pane_id, 24, "and the agent still reports it");
  },

  // ── writes ──────────────────────────────────────────────────────────────────
  async "save-refreshes-before-it-pushes"(dir) {
    saveEdition(dir, "cloud");
    edition.resolve({ dir, dev: false });
    const store = freshStore();
    const api = fakeApi();
    store.init({ dir, ...deps(dir), fetchImpl: api });
    await store.start();
    api.calls.length = 0;
    await store.saveAgents([{ ...WEB_AGENT, name: "Renamed" }]);
    const methods = api.calls.map((c) => c.method);
    eq(methods[0], "GET", "a write must re-read first — pushing a stale snapshot is what deleted agents");
    has(methods, "PUT", "then push");
    eq(methods.indexOf("GET") < methods.indexOf("PUT"), true, "in that order");
  },

  async "save-never-sends-per-machine-fields-to-the-api"(dir) {
    saveEdition(dir, "cloud");
    edition.resolve({ dir, dev: false });
    const store = freshStore();
    const api = fakeApi();
    store.init({ dir, ...deps(dir), fetchImpl: api });
    await store.start();
    await store.saveAgents([{ ...WEB_AGENT, pane_id: 7, avatar_path: "/tmp/x.png", avatar_status: "ready" }]);
    const put = api.calls.find((c) => c.method === "PUT");
    const sent = put.body.agents[0];
    eq("pane_id" in sent, false, "pane_id is this machine's, not the account's");
    eq("avatar_path" in sent, false, "avatar_path is a local cache location");
    eq("avatar_status" in sent, false, "avatar_status likewise");
    eq(sent.name, "Made In Console", "real fields still go");
  },

  // An app can be newer than the backend it points at. Against an OLDER API (one
  // that doesn't send a `commands` key), signing in must not make a person's whole
  // macro bar disappear, and must not quietly write macros where they'll be lost.
  async "older-backend-keeps-macros-on-yaml"(dir) {
    saveEdition(dir, "cloud");
    edition.resolve({ dir, dev: false });
    const store = freshStore();
    store.init({ dir, ...deps(dir), fetchImpl: fakeApi() });
    await store.start();
    eq(store.commands().length, 1, "macros survive the cloud edition");
    eq(store.commands()[0].name, "Deploy", "and they're the real ones");
    let threw = "";
    try { await store.saveCommands([]); } catch (e) { threw = e.message; }
    eq(threw.includes("no endpoint"), true, "saving macros must refuse loudly, not silently drop them");
  },

  // …and the moment the backend IS deployed, the same app switches over with no
  // second release: a `commands` key in the response is the only signal needed.
  async "current-backend-serves-macros-from-the-api"(dir) {
    saveEdition(dir, "cloud");
    edition.resolve({ dir, dev: false });
    const store = freshStore();
    const api = fakeApi();
    api.withCommands = true;
    store.init({ dir, ...deps(dir), fetchImpl: api });
    await store.start();
    eq(store.commands().length, 1, "macros now come from the backend");
    eq(store.commands()[0].name, "FromApi", "and they're the account's, not the laptop's");
  },

  // The Settings indicator tells the person where their macros actually live. It
  // reads this flag, so the flag has to be right in both directions or the app is
  // making a confident claim about the wrong thing.
  async "status-reports-where-macros-really-live"(dir) {
    saveEdition(dir, "cloud");
    edition.resolve({ dir, dev: false });
    const store = freshStore();
    const api = fakeApi();
    store.init({ dir, ...deps(dir), fetchImpl: api });
    await store.start();
    eq(store.status().commandsFromApi, false, "an older backend: macros are still on this Mac");
    api.withCommands = true;
    await store.refresh();
    eq(store.status().commandsFromApi, true, "a current backend: macros are on the account");
  },

  async "local-save-writes-yaml"(dir) {
    saveEdition(dir, "local");
    edition.resolve({ dir, dev: false });
    const store = freshStore();
    let written = null;
    store.init({
      dir, readDoc: yamlDoc, writeDoc: (d) => { written = d; },
      token: () => "", deviceId: "dev-1", fetchImpl: fakeApi(),
    });
    await store.start();
    await store.saveAgents([YAML_AGENT, { id: "yaml-2", name: "Second" }]);
    eq(written.agents.length, 2, "the YAML got both agents");
    eq(written.commands.length, 1, "and the rest of the doc survived the write");
  },
};

// ── harness ───────────────────────────────────────────────────────────────────
function eq(got, want, what) {
  if (got !== want) throw new Error(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
function has(arr, want, what) {
  if (!arr.includes(want)) throw new Error(`${what}: ${JSON.stringify(want)} missing from ${JSON.stringify(arr)}`);
}
function saveEdition(dir, ed) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(edition.stateFile(dir, false), JSON.stringify({ edition: ed, lic: "hobbyist", updated: 1 }));
}
function deps(dir) {
  return { readDoc: yamlDoc, writeDoc: () => {}, token: () => "tok", deviceId: "dev-1" };
}
// The store is a per-process singleton like the edition it follows; each child
// gets its own, and init() takes fetchImpl so no test touches the network.
function freshStore() {
  const store = require("../lib/store");
  store.__reset();
  return store;
}

const only = process.argv[2];
if (only) {
  SCENARIOS[only](process.argv[3])
    .then(() => process.exit(0))
    .catch((e) => { console.error(e.message); process.exit(1); });
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-store-"));
  let failed = 0;
  for (const name of Object.keys(SCENARIOS)) {
    const r = spawnSync(process.execPath, [__filename, name, path.join(root, name)], { encoding: "utf8" });
    const ok = r.status === 0;
    if (!ok) failed += 1;
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `\n        ${(r.stderr || "").trim()}`}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
  const total = Object.keys(SCENARIOS).length;
  console.log(`${failed ? "FAIL" : "PASS"}: store — ${total - failed}/${total} scenarios`);
  process.exit(failed ? 1 : 0);
}
