// Device-local state — what is true of THIS MACHINE, and must never travel to an
// account.
//
// The problem it solves: fields like `pane_id` lived INSIDE each agent record in
// the YAML. That single file therefore held three different kinds of thing at
// once — account data (agents, groups, macros), device data (which WezTerm pane an
// agent is attached to right now, where its avatar PNG was cached), and app
// config. Every sync had to remember to strip the device fields on the way out and
// re-graft them on the way back, and every code path that forgot became a bug:
// a pull that detached a live pane, or a push that sent this laptop's pane ids to
// an account two other machines also read.
//
// So they get their own file. Account data can then be replaced wholesale — from
// the API, from a migration, from anywhere — without any of it needing to know
// that a pane id exists.
//
// A pane id is meaningless on another machine by definition: it names a pane in
// THIS computer's WezTerm mux. That's the test for whether something belongs here.
"use strict";

const fs = require("fs");
const path = require("path");

// Per-agent device fields, keyed by agent id.
const AGENT_FIELDS = ["pane_id", "avatar_path", "avatar_status"];

const EMPTY = () => ({ agents: {}, mux_id: "" });

function create({ dir, dev = false, log = () => {} }) {
  const file = path.join(dir, dev ? "device-state.dev.json" : "device-state.json");
  let state = load();

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!raw || typeof raw !== "object") return EMPTY();
      return { agents: raw.agents && typeof raw.agents === "object" ? raw.agents : {}, mux_id: String(raw.mux_id || "") };
    } catch { return EMPTY(); }
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state));
    } catch (e) { log(`write failed: ${e.message}`); }
  }

  return {
    path: file,

    // adopt is the one-time upgrade path: lift the device fields out of agents
    // that still carry them in the YAML. Without this, everyone's panes detach
    // exactly once on the version that introduces this file — agents would relaunch
    // into fresh terminals instead of reattaching to the ones already running.
    // Only fills gaps, so it can run every boot without clobbering newer values.
    adoptFrom(agents) {
      let adopted = 0;
      for (const a of agents || []) {
        if (!a || !a.id) continue;
        const has = state.agents[a.id] || {};
        const next = { ...has };
        for (const f of AGENT_FIELDS) {
          if (next[f] === undefined && a[f] !== undefined && a[f] !== "" && a[f] !== 0) next[f] = a[f];
        }
        if (Object.keys(next).length && JSON.stringify(next) !== JSON.stringify(has)) {
          state.agents[a.id] = next;
          adopted += 1;
        }
      }
      if (adopted) { save(); log(`adopted device fields for ${adopted} agent(s) from the config file`); }
      return adopted;
    },

    // overlay grafts this machine's fields onto account records on the way OUT to
    // the app. Account data stays pristine; callers see a whole agent.
    overlay(agents) {
      return (agents || []).map((a) => {
        const d = state.agents[a && a.id] || {};
        return {
          ...a,
          pane_id: d.pane_id || 0,
          avatar_path: d.avatar_path || "",
          avatar_status: d.avatar_status || "",
        };
      });
    },

    // strip removes them on the way IN, so nothing device-shaped is ever written
    // into account storage — the YAML in the local edition, the API in the cloud one.
    strip(agent) {
      const out = {};
      for (const k of Object.keys(agent || {})) if (!AGENT_FIELDS.includes(k)) out[k] = agent[k];
      return out;
    },

    forAgent(id) { return { ...(state.agents[id] || {}) }; },

    patchAgent(id, patch) {
      if (!id) return;
      const cur = state.agents[id] || {};
      const next = { ...cur };
      let changed = false;
      for (const f of AGENT_FIELDS) {
        if (patch && patch[f] !== undefined && patch[f] !== cur[f]) { next[f] = patch[f]; changed = true; }
      }
      if (!changed) return;
      state.agents[id] = next;
      save();
    },

    // A pane id is only valid within ONE mux-server lifetime. When the mux
    // restarts, every stored id points at a pane that no longer exists (or worse,
    // an unrelated one that took the number), so they all go.
    muxId() { return state.mux_id; },
    setMuxId(v) { state.mux_id = String(v || ""); save(); },
    clearPanes() {
      let cleared = 0;
      for (const id of Object.keys(state.agents)) {
        if (state.agents[id].pane_id) { state.agents[id].pane_id = 0; cleared += 1; }
      }
      if (cleared) save();
      return cleared;
    },

    // Test seam only.
    __state() { return JSON.parse(JSON.stringify(state)); },
    __reload() { state = load(); },
  };
}

module.exports = { create, AGENT_FIELDS };
