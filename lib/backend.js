// THE single source of truth for where speech runs.
//
// Both the app and the launcher resolve the backend through here. They used to
// answer separately — the app from its own logic, the launcher from a legacy
// `api_url` in the yaml — which is how the daemon ended up talking to one host
// while the client talked to another, and dictation returned 401 against a
// backend nobody had authenticated to.
//
// Rules, in order:
//
//   paid licence            → OUR CLOUD, at an embedded DNS name for the current
//                             environment. Never a value from the yaml. Users
//                             should have to decompile to find a hostname, and
//                             environments swap here, not in anyone's config.
//   free + dictation on     → localhost on the configured port.
//   free + dictation off    → NOTHING. Dictation is off by default on the free
//                             plan because it needs a separate speech server
//                             installed; promising it before that exists just
//                             produces failures the user can't act on.
//
// The yaml holds a PORT and a SWITCH. It never holds a URL.
"use strict";

// Embedded per environment. Adding prod later is a line here, not a setting.
const CLOUD_ENVS = {
  dev: process.env.SPEECH_API_URL || "http://voice-dev.talkersoft.com:9100",
};
const DEFAULT_ENV = "dev";
const DEFAULT_PORT = 9100;

// Keys that must never survive in a user's config: they let a stale URL override
// the embedded one, which is exactly the bug this module exists to prevent.
const FORBIDDEN_KEYS = ["api_url", "servers", "active_server", "backend_mode"];

function localPort(doc) {
  const n = parseInt(doc && doc.local_port, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}
function cloudEnv(doc) {
  const e = String((doc && doc.cloud_env) || "").trim();
  return CLOUD_ENVS[e] ? e : DEFAULT_ENV;
}
// Free-plan dictation is OPT-IN: it needs a local speech server the user installs
// separately, so defaulting it on would advertise something that isn't there.
function dictationEnabled(doc) {
  return (doc && doc.dictation_enabled) === true;
}

// resolve returns what the client AND the daemon must both use.
//   paid — does this machine hold a qualifying licence right now?
function resolve(doc, paid) {
  if (paid) {
    return { mode: "cloud", enabled: true, port: localPort(doc), url: CLOUD_ENVS[cloudEnv(doc)] };
  }
  const enabled = dictationEnabled(doc);
  return {
    mode: "free",
    enabled,
    port: localPort(doc),
    url: enabled ? `http://localhost:${localPort(doc)}` : "",
  };
}

// stripForbidden removes legacy URL/server keys from a config doc. Returns true
// when something was dropped, so the caller knows to write the file back.
function stripForbidden(doc) {
  let changed = false;
  for (const k of FORBIDDEN_KEYS) {
    if (doc && Object.prototype.hasOwnProperty.call(doc, k)) { delete doc[k]; changed = true; }
  }
  return changed;
}

module.exports = { resolve, stripForbidden, localPort, cloudEnv, dictationEnabled, CLOUD_ENVS, DEFAULT_PORT };
