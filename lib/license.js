// License view client (Studio main process).
//
// Two reads, deliberately different by tier:
//   • Paid  → GET /license with the wristband: the authoritative view (tier,
//     entitlements, device count) for THIS user.
//   • Free  → GET /entitlements: a PUBLIC, identity-free catalog read. It sends no
//     token and creates no server-side record, so a Free user is still never
//     tracked by the product API — but the tier's feature list stays DB-driven
//     instead of hardcoded here.
//
// Both are fail-soft: a hiccup returns nulls, never throws, so the license view
// degrades to "what we know locally" rather than breaking Settings.
"use strict";

const { REGISTRY_URL } = require("./registry");

// fetchLicense returns the caller's own licensing view (paid path).
async function fetchLicense({ token, log = () => {} }) {
  if (!token) return null;
  try {
    const resp = await fetch(REGISTRY_URL + "/license", {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) { log("license HTTP " + resp.status); return null; }
    return await resp.json(); // {tier, entitlements, device_count, email}
  } catch (e) {
    log("license failed: " + e.message);
    return null;
  }
}

// fetchEntitlements returns the public per-tier feature catalog (free path).
// No token, no identity — nothing is recorded about the caller.
async function fetchEntitlements({ log = () => {} } = {}) {
  try {
    const resp = await fetch(REGISTRY_URL + "/entitlements", { signal: AbortSignal.timeout(4000) });
    if (!resp.ok) { log("entitlements HTTP " + resp.status); return null; }
    const body = await resp.json();
    return body && body.entitlements ? body.entitlements : null; // {tier: {key: value}}
  } catch (e) {
    log("entitlements failed: " + e.message);
    return null;
  }
}

module.exports = { fetchLicense, fetchEntitlements };
