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
    systems: Array.isArray(doc.systems) ? doc.systems : [],
  };
}

// pushConfig sends the current local config up to the API (after a local edit).
async function pushConfig({ token, readDoc, log = () => {} }) {
  if (!token) return false;
  try {
    const r = await apiSend("PUT", "/config", token, buildBody(readDoc()));
    if (!r.ok) { log("push HTTP " + r.status); return false; }
    return true;
  } catch (e) { log("push failed: " + e.message); return false; }
}

// syncOnLogin runs once per sign-in. Returns { mode: "api" | "local" }.
async function syncOnLogin({ token, readDoc, writeDoc, avatarsDir, log = () => {} }) {
  if (!token) return { mode: "local" };
  let status;
  try { status = await apiGet("/config/status", token); }
  catch (e) { log("backend unreachable, staying on local YAML: " + e.message); return { mode: "local" }; }

  const doc = readDoc();
  const localAgents = Array.isArray(doc.agents) ? doc.agents : [];

  if (!status.migrated) {
    try {
      const r = await apiSend("POST", "/config/migrate", token, buildBody(doc));
      if (r.ok || r.status === 409) log(`migrated ${localAgents.length} agents to the backend`);
      else log("migrate HTTP " + r.status);
    } catch (e) { log("migrate failed: " + e.message); return { mode: "local" }; }
    await uploadAvatars(localAgents, token, avatarsDir, log);
  }

  // Pull the API config → local YAML (API wins), preserving local runtime fields.
  let cfg;
  try { cfg = await apiGet("/config", token); }
  catch (e) { log("pull failed: " + e.message); return { mode: "api" }; }
  const prevById = new Map(localAgents.map((a) => [a.id, a]));
  doc.agents = (cfg.agents || []).map((a) => {
    const prev = prevById.get(a.id) || {};
    // Preserve per-machine runtime fields the API doesn't know about — the LIVE
    // WezTerm pane especially, or every relaunch/pop-out spawns a new red tab
    // instead of reattaching to the existing pane.
    return { ...a, pane_id: prev.pane_id || 0, avatar_path: prev.avatar_path || "", avatar_status: prev.avatar_status || "" };
  });
  doc.groups = cfg.groups || [];
  doc.systems = cfg.systems || [];
  writeDoc(doc);
  log(`config now driven by the backend (${doc.agents.length} agents)`);
  await fetchMissingAvatars(cfg.agents || [], doc.agents, token, avatarsDir, writeDoc, readDoc, log);
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
// second machine signing in), so the local Arcade shows them too.
async function fetchMissingAvatars(apiAgents, localAgents, token, avatarsDir, writeDoc, readDoc, log) {
  const localById = new Map(localAgents.map((a) => [a.id, a]));
  let changed = false;
  for (const a of apiAgents) {
    if (!a.has_avatar) continue;
    const dest = path.join(avatarsDir, `${a.id}.png`);
    try {
      if (fs.existsSync(dest)) { // already have it — just make sure the path is set
        const la = localById.get(a.id);
        if (la && !la.avatar_path) { la.avatar_path = dest; la.avatar_status = "ready"; changed = true; }
        continue;
      }
      const r = await fetch(REGISTRY_URL + `/agents/${a.id}/avatar`, {
        headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) continue;
      fs.mkdirSync(avatarsDir, { recursive: true });
      fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
      const la = localById.get(a.id);
      if (la) { la.avatar_path = dest; la.avatar_status = "ready"; changed = true; }
    } catch (e) { log(`avatar fetch ${a.id}: ${e.message}`); }
  }
  if (changed) { const d = readDoc(); d.agents = localAgents; writeDoc(d); }
}

module.exports = { syncOnLogin, pushConfig };
