// Host registry client for Agent Arcade (Studio main process).
//
// When you sign in, this machine joins the managed backend: an upsert into
// agent-arcade-api's device registry, scoped to your tenant by the wristband
// (the same access token speech-api uses — agent-arcade-api verifies it against
// the identity service's JWKS). V1 is deliberately tiny: the server just learns
// which hosts joined, per account. Later this grows into per-host agent config
// (today it lives in each machine's YAML).
"use strict";

const os = require("os");

// The managed backend that owns the device registry. Overridable via env so we
// can repoint at a prod host without a rebuild — no hardcoded assumption baked in.
const REGISTRY_URL = (process.env.AGENT_ARCADE_API || "https://agent-arcade-api-dev.talkersoft.com").replace(/\/+$/, "");

function platformName() {
  return process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
}
function safeHostname() { try { return os.hostname(); } catch { return "this machine"; } }
// A SHORT os version for display. os.version() on macOS returns the whole kernel
// banner ("Darwin Kernel Version 25.5.0: Tue Jun 9 … RELEASE_ARM64_T6020"), which
// is useless in a card, so darwin uses os.release() ("25.5.0"). Windows/Linux
// os.version() is already friendly ("Windows 11 Pro"). Capped either way.
function safeOsVersion() {
  const pick = () => {
    try {
      if (process.platform === "darwin") return os.release();
      return os.version();
    } catch {
      try { return os.release(); } catch { return ""; }
    }
  };
  const v = (pick() || "").toString().trim();
  return v.length > 48 ? v.slice(0, 48) : v;
}

// registerHost upserts this machine into the backend registry. Fire-and-forget:
// it never throws, so a registry hiccup can't break sign-in or dictation. The
// device_id is the stable ~/.hv/device-id; the owner comes from the wristband,
// never the body, so a host can't be claimed across accounts.
// `label` is the FRIENDLY NAME the person gave this machine ("Work MacBook") —
// it's how they'll pick it out of a list when driving one machine from another.
// Falls back to the hostname only when no name has been chosen yet.
async function registerHost({ token, deviceId, appVersion, label, log = () => {} }) {
  if (!token || !deviceId) return false;
  const name = (label || "").toString().trim() || safeHostname();
  try {
    const resp = await fetch(REGISTRY_URL + "/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({
        device_id: deviceId,
        label: name,
        platform: platformName(),
        os_version: safeOsVersion(),
        app_version: appVersion || "",
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) { log("register HTTP " + resp.status); return false; }
    log(`joined as ${name} (${platformName()})`);
    return true;
  } catch (e) {
    log("register failed: " + e.message);
    return false;
  }
}

module.exports = { registerHost, REGISTRY_URL };
