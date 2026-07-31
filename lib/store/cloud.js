// The CLOUD edition's account store: agent-arcade-api is the source of truth.
//
// The YAML is not read here and not written here. That is the entire point — in
// the cloud edition the app had been reading agents out of the local file in every
// mode, so an agent created in the web console could never appear no matter how
// long you waited. Signing in only set a label; it never changed where the data
// came from.
//
// SHAPE
//
// Reads are synchronous against an in-memory snapshot, because every caller needs
// a list immediately (menu builds, rail renders, IPC replies) and making them all
// async would be a rewrite of the whole surface for no gain. The snapshot is:
//
//   1. hydrated at boot from a CACHE FILE, so the app draws instantly and works
//      offline. The cache is not config — it is the last thing the API told us,
//      and it is never merged into the YAML.
//   2. refreshed from the API as soon as a token exists, then on window focus,
//      after every mutation, and on a slow poll. Each refresh that changes
//      anything fires onChange, and the renderers re-fetch.
//
// A WebSocket replaces the poll later; the refresh triggers stay the same.
//
// WRITES
//
// A mutation refreshes first, applies the caller's list on top, then PUTs the
// whole config. Refreshing first is what keeps this safe: the old code pushed the
// STALE LOCAL YAML with a workspace-scoped delete, which could remove an agent
// created in the console between syncs. The remaining window is one request wide
// rather than one session wide. Per-agent endpoints will close it entirely.
"use strict";

const fs = require("fs");
const path = require("path");
const { REGISTRY_URL } = require("../registry");

const SLICES = ["agents", "groups", "systems", "commands"];

// dq names THIS DEVICE on every config call. The API answers with the device's
// workspace and — critically — scopes its delete to that workspace on a write.
// Without it the server treats a partial payload as the whole account.
function dq(p, deviceId) {
  if (!deviceId) return p;
  return p + (p.includes("?") ? "&" : "?") + "device_id=" + encodeURIComponent(deviceId);
}

// Slices the API may not serve yet. Macros only gained a table and a payload
// field in migrations 000009/000010, and an app can be newer than the backend it
// is pointed at. If we simply read them from the API, a person signing in against
// an older deployment would watch their entire macro bar vanish.
//
// So the fallback is decided by what the SERVER actually says, not by a version
// guess: an older API omits the `commands` key entirely, a current one always
// sends the array (empty or not). Absent → read macros from the local YAML.
// Present → the API owns them. It heals itself the moment the backend is
// deployed, with no second release of the app.
const MAY_LAG = ["commands"];

function create({ cachePath, token, deviceId, device, localFallback = () => [], log = () => {}, onChange = () => {}, fetchImpl = fetch }) {
  // The snapshot every synchronous read answers from.
  let snap = { agents: [], groups: [], systems: [], commands: [] };
  let loaded = false;   // has a real API response ever landed?
  let lastError = "";
  let inFlight = null;
  const served = { commands: false }; // which lagging slices this backend serves

  // ── cache file: last known API state, so boot is instant and offline works ──
  function readCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (!raw || typeof raw !== "object") return null;
      const out = {};
      for (const s of SLICES) out[s] = Array.isArray(raw[s]) ? raw[s] : [];
      return out;
    } catch { return null; }
  }
  function writeCache(next) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(next));
    } catch (e) { log(`cache write failed: ${e.message}`); }
  }

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  async function api(method, p, body) {
    const t = token();
    if (!t) throw new Error("not signed in yet");
    const r = await fetchImpl(REGISTRY_URL + p, {
      method,
      headers: {
        Authorization: "Bearer " + t,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`${p} HTTP ${r.status}`);
    return method === "GET" ? r.json() : null;
  }

  // adopt replaces the snapshot outright. It can do that safely because the
  // snapshot is PURE ACCOUNT DATA — the live pane and cached avatar live in
  // lib/device-state.js and are grafted on at read time. Before that split this
  // function had to hand-preserve them on every refresh, and any path that forgot
  // detached a running terminal.
  function adopt(cfg) {
    // Does this backend know about macros at all? An older one omits the key.
    served.commands = Object.prototype.hasOwnProperty.call(cfg, "commands");
    const next = {};
    for (const s of SLICES) next[s] = Array.isArray(cfg[s]) ? cfg[s] : [];
    const changed = !same(next, snap);
    snap = next;
    loaded = true;
    if (changed) writeCache(snap);
    return changed;
  }

  async function refresh() {
    // No token yet is NOT a failure — it's the ordinary state between the first
    // window opening and the session restoring, and a focus event lands right in
    // it. Logging that as "refresh failed" is the kind of false alarm that trains
    // people to ignore the log, which is where a real failure then hides.
    if (!token()) return { ok: false, changed: false, pending: true };
    if (inFlight) return inFlight; // coalesce: focus + poll + mutation can collide
    inFlight = (async () => {
      try {
        const cfg = await api("GET", dq("/config", deviceId));
        const changed = adopt(cfg);
        lastError = "";
        if (changed) { log(`config refreshed — ${snap.agents.length} agents`); onChange("all"); }
        return { ok: true, changed, source: "api" };
      } catch (e) {
        lastError = e.message;
        // Non-fatal by design: a refresh that can't reach the backend leaves the
        // last good snapshot in place. The app keeps working, just not current.
        log(`refresh failed: ${e.message}`);
        return { ok: false, changed: false, error: e.message };
      } finally { inFlight = null; }
    })();
    return inFlight;
  }

  return {
    kind: "cloud",
    isCloud: true,

    // start hydrates from cache (synchronous, instant) and kicks one refresh. It
    // deliberately does NOT await the network: a slow or unreachable backend must
    // not hold up the first window.
    async start() {
      const cached = readCache();
      if (cached) { snap = cached; log(`loaded ${snap.agents.length} agents from cache`); }
      return refresh();
    },

    refresh,

    list(slice) {
      if (MAY_LAG.includes(slice) && !served[slice]) return localFallback(slice);
      const arr = Array.isArray(snap[slice]) ? snap[slice] : [];
      return slice === "agents" ? device.overlay(arr) : arr;
    },

    async save(slice, next) {
      if (!SLICES.includes(slice)) throw new Error(`unknown slice ${slice}`);
      if (MAY_LAG.includes(slice) && !served[slice]) {
        // Refusing loudly beats writing somewhere the person will lose it.
        throw new Error(`${slice} cannot be saved yet — this backend has no endpoint for them`);
      }
      await refresh(); // narrow the clobber window to one request
      const arr = Array.isArray(next) ? next : [];
      const merged = { ...snap, [slice]: slice === "agents" ? arr.map(device.strip) : arr };
      const body = {
        agents: (merged.agents || []).map(device.strip),
        groups: merged.groups || [],
        systems: [], // retired: a machine's agents are decided by its WORKSPACE
        ...(served.commands ? { commands: merged.commands || [] } : {}),
      };
      await api("PUT", dq("/config", deviceId), body);
      snap = merged;
      writeCache(snap);
      onChange(slice);
      await refresh(); // adopt whatever the server actually stored
      return this.list(slice);
    },

    status() {
      return { kind: "cloud", ok: loaded, stale: !loaded || !!lastError, error: lastError, commandsFromApi: served.commands };
    },
  };
}

module.exports = { create, SLICES };
