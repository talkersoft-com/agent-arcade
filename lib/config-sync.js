// Config sync — the YAML↔API bridge for joined users.
//
// Not signed in: the app is pure local YAML (untouched, the free path). Signed
// in: agent-arcade-api is the source of truth. On the FIRST join we upload the
// local YAML (one-time migrate); thereafter we PULL the API's config into the
// local YAML on sign-in (so the Arcade renders the account's agents) and PUSH
// local changes back. The local YAML becomes a cache/mirror; per-machine runtime
// fields (pane_id) and the local avatar cache are preserved by id across a pull.
//
// Everything here is best-effort and non-fatal: if the API is unreachable
// (off-LAN), we log and leave the app on its local YAML — dictation never breaks.
"use strict";

const fs = require("fs");
const path = require("path");
const { REGISTRY_URL } = require("./registry");

// Runtime/local-only fields that never go to the API.
const LOCAL_ONLY = ["pane_id", "avatar_path", "avatar_status", "has_avatar"];
function toApiAgent(a) {
  const out = {};
  for (const k of Object.keys(a)) if (!LOCAL_ONLY.includes(k)) out[k] = a[k];
  return out;
}

async function apiGet(p, token) {
  const r = await fetch(REGISTRY_URL + p, {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(p + " HTTP " + r.status);
  return r.json();
}
async function apiSend(method, p, token, body) {
  return fetch(REGISTRY_URL + p, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
}

// buildBody maps the local YAML doc to the API's Config shape.
function buildBody(doc) {
  return {
    agents: (Array.isArray(doc.agents) ? doc.agents : []).map(toApiAgent),
    groups: Array.isArray(doc.groups) ? doc.groups : [],
    // Macros and account settings. These were missing entirely, which is why
    // "promote to the cloud" carried agents and groups and silently left a
    // person's whole macro library — usually the largest section of their config
    // file — behind on one laptop. An older backend ignores both fields.
    commands: Array.isArray(doc.commands) ? doc.commands : [],
    settings: accountSettings(doc.app || {}),
    // `systems` is retired: which machine an agent runs on is decided by its
    // WORKSPACE now, which the account owns — the YAML has no say in it. Sent as
    // empty so an older server sees no systems rather than resurrecting them.
    systems: [],
  };
}

// accountSettings picks the preferences that should FOLLOW A PERSON to a second
// machine, and leaves behind the ones that describe this computer. The summon
// hotkey should be the same everywhere; the selected microphone, the monitor
// geometry and the wezterm window size emphatically should not — they'd be wrong
// on the other machine and would fight between them on every sync.
const ACCOUNT_SETTINGS = [
  "sync_wezterm_tabs", "warn_on_exit", "compose_split",
  "dictation_tail_ms", "dictation_pad_ms", "shortcuts",
];
function accountSettings(app) {
  const out = {};
  for (const k of ACCOUNT_SETTINGS) if (app[k] !== undefined) out[k] = app[k];
  return out;
}

// dq appends this machine's identity to a config path. Every config call has to
// say WHICH DEVICE is asking: the API answers with that machine's workspace, and
// — more importantly — scopes its delete to that workspace on a push. Without it
// the server would treat a partial payload as the whole account and delete every
// other workspace's agents.
function dq(p, deviceId) {
  if (!deviceId) return p;
  return p + (p.includes("?") ? "&" : "?") + "device_id=" + encodeURIComponent(deviceId);
}

// pushConfig sends the current local config up to the API (after a local edit).
async function pushConfig({ token, deviceId, readDoc, log = () => {} }) {
  if (!token) return false;
  try {
    const r = await apiSend("PUT", dq("/config", deviceId), token, buildBody(readDoc()));
    if (!r.ok) { log("push HTTP " + r.status); return false; }
    return true;
  } catch (e) { log("push failed: " + e.message); return false; }
}

// syncOnLogin runs once per sign-in. Returns { mode: "api" | "local" }.
async function syncOnLogin({ token, deviceId, readDoc, device, avatarsDir, log = () => {} }) {
  if (!token) return { mode: "local" };
  let status;
  try { status = await apiGet(dq("/config/status", deviceId), token); }
  catch (e) { log("backend unreachable, staying on local YAML: " + e.message); return { mode: "local" }; }

  const doc = readDoc();
  const localAgents = Array.isArray(doc.agents) ? doc.agents : [];

  if (!status.migrated) {
    try {
      const r = await apiSend("POST", dq("/config/migrate", deviceId), token, buildBody(doc));
      if (r.ok || r.status === 409) log(`migrated ${localAgents.length} agents to the backend`);
      else log("migrate HTTP " + r.status);
    } catch (e) { log("migrate failed: " + e.message); return { mode: "local" }; }
    await uploadAvatars(localAgents, token, avatarsDir, log);
  }

  // The pull is the STORE's job now (lib/store/cloud.js), not this function's.
  // This used to write the API's agents straight into the local YAML, which is
  // what made one file mean two things at once — and gave a later local edit
  // something STALE to push back with a workspace-scoped delete. The YAML is now
  // left exactly as it was: in the cloud edition nothing reads it, and if the
  // person signs out it is their rollback, untouched.
  let cfg;
  try { cfg = await apiGet(dq("/config", deviceId), token); }
  catch (e) { log("pull failed: " + e.message); return { mode: "api" }; }
  log(`config now driven by the backend (${(cfg.agents || []).length} agents)`);
  await fetchMissingAvatars(cfg.agents || [], token, avatarsDir, device, log);
  return { mode: "api" };
}

// uploadAvatars pushes any locally-cached avatar PNGs so the web console can show
// them. Best-effort, per agent.
async function uploadAvatars(agents, token, avatarsDir, log) {
  for (const a of agents) {
    const p = a.avatar_path || path.join(avatarsDir, `${a.id}.png`);
    try {
      if (!fs.existsSync(p)) continue;
      const bytes = fs.readFileSync(p);
      const r = await fetch(REGISTRY_URL + `/agents/${a.id}/avatar`, {
        method: "POST",
        headers: { "Content-Type": "image/png", Authorization: "Bearer " + token },
        body: bytes,
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) log(`avatar upload ${a.id}: HTTP ${r.status}`);
    } catch (e) { log(`avatar upload ${a.id}: ${e.message}`); }
  }
}

// fetchMissingAvatars pulls avatars the API has but this machine doesn't (e.g. a
// second machine signing in). Where a PNG landed on disk is DEVICE state — it is
// a path on this computer — so it is recorded there rather than written back into
// the agent record, which is account data.
async function fetchMissingAvatars(apiAgents, token, avatarsDir, device, log) {
  for (const a of apiAgents) {
    if (!a.has_avatar) continue;
    const dest = path.join(avatarsDir, `${a.id}.png`);
    try {
      if (!fs.existsSync(dest)) {
        const r = await fetch(REGISTRY_URL + `/agents/${a.id}/avatar`, {
          headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) continue;
        fs.mkdirSync(avatarsDir, { recursive: true });
        fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
      }
      device.patchAgent(a.id, { avatar_path: dest, avatar_status: "ready" });
    } catch (e) { log(`avatar fetch ${a.id}: ${e.message}`); }
  }
}

module.exports = { syncOnLogin, pushConfig };
