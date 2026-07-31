// The account store — ONE of two implementations, chosen by the edition.
//
// This is the module that answers "where do agents come from?", and it answers it
// exactly once per process. Before this existed, loadAgents() read the YAML in
// every mode and the API was a write-only mirror, so `apiMode` was a label rather
// than a data source and a cloud user's menus were still driven by a local file.
//
// Callers do not know or ask which implementation they got. There is no branch on
// edition anywhere downstream — if you find yourself writing one, the difference
// belongs in here instead.
"use strict";

const path = require("path");
const editionState = require("../edition");
const local = require("./local");
const cloud = require("./cloud");
const deviceState = require("../device-state");

const SLICES = local.SLICES;

let impl = null;
let device = null;

// init picks the implementation for this process. Idempotent — the first call
// wins, matching the edition it is derived from.
function init({ dir, dev = false, readDoc, writeDoc, token, deviceId, log = () => {}, onChange = () => {}, fetchImpl }) {
  if (impl) return impl;
  // This machine's own fields, kept OUT of account storage in both editions.
  device = deviceState.create({ dir, dev, log: (m) => log(`device-state: ${m}`) });
  if (editionState.isCloud()) {
    impl = cloud.create({
      // Dev and prod keep separate caches, like every other piece of app state.
      cachePath: path.join(dir, dev ? "cloud-config-cache.dev.json" : "cloud-config-cache.json"),
      token, deviceId, onChange, device,
      // Macros still live in the YAML until the commands endpoint ships.
      localFallback: (slice) => { const v = readDoc()[slice]; return Array.isArray(v) ? v : []; },
      ...(fetchImpl ? { fetchImpl } : {}), // tests inject; production uses global fetch
      log: (m) => log(`store(cloud): ${m}`),
    });
  } else {
    impl = local.create({ readDoc, writeDoc, onChange, device });
  }
  return impl;
}

// get returns the initialised store, or throws — an uninitialised store means a
// caller ran before boot wired it up, which is a bug worth failing loudly on
// rather than papering over with an empty list.
function get() {
  if (!impl) throw new Error("store used before init()");
  return impl;
}

// Convenience readers, so callers say what they want rather than passing strings.
const agents = () => get().list("agents");
const groups = () => get().list("groups");
const systems = () => get().list("systems");
const commands = () => get().list("commands");

const saveAgents = (list) => get().save("agents", list);
const saveGroups = (list) => get().save("groups", list);
const saveSystems = (list) => get().save("systems", list);
const saveCommands = (list) => get().save("commands", list);

module.exports = {
  SLICES, init, get,
  agents, groups, systems, commands,
  saveAgents, saveGroups, saveSystems, saveCommands,
  start: (...a) => get().start(...a),
  refresh: (...a) => get().refresh(...a),
  status: () => get().status(),
  isCloud: () => get().isCloud,
  device: () => device,
  __reset: () => { impl = null; device = null; }, // tests only
};
