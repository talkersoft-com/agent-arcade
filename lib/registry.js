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
function safeOsVersion() {
  try { return os.version(); } catch { try { return os.release(); } catch { return ""; } }
}

// registerHost upserts this machine into the backend registry. Fire-and-forget:
// it never throws, so a registry hiccup can't break sign-in or dictation. The
// device_id is the stable ~/.hv/device-id; the owner comes from the wristband,
// never the body, so a host can't be claimed across accounts.
async function registerHost({ token, deviceId, appVersion, log = () => {} }) {
  if (!token || !deviceId) return false;
  try {
    const resp = await fetch(REGISTRY_URL + "/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({
        device_id: deviceId,
        label: safeHostname(),
        platform: platformName(),
        os_version: safeOsVersion(),
        app_version: appVersion || "",
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) { log("register HTTP " + resp.status); return false; }
    log(`joined as ${safeHostname()} (${platformName()})`);
    return true;
  } catch (e) {
    log("register failed: " + e.message);
    return false;
  }
}

module.exports = { registerHost, REGISTRY_URL };
