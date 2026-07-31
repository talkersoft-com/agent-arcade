// Talkersoft ID client for Agent Arcade (Studio main process).
//
// Owns the sign-in loop and the tokens: opens the system browser to the identity
// service, catches the redirect on a one-shot localhost listener (the fly-login
// shape), stores the long-lived refresh token encrypted via Electron safeStorage
// (Keychain — never in the YAML), keeps the short access token in memory, and
// refreshes it before expiry. Emits "change" whenever the access token or
// identity changes so the main process can push it to the daemon + renderer.
"use strict";

const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { EventEmitter } = require("events");

const HV_DIR = path.join(os.homedir(), ".hv");
const DEV = !!process.env.DICTATE_DEV;
// Refresh token, encrypted at rest (Keychain via safeStorage). Dev + prod split.
const REFRESH_FILE = path.join(HV_DIR, DEV ? "id-refresh.dev.dat" : "id-refresh.dat");
// Stable per-machine device id (one seat). Shared by every process on this box.
const DEVICE_FILE = path.join(HV_DIR, "device-id");

// deviceId reads (or creates once) the machine's device UUID.
function deviceId() {
  try {
    const v = fs.readFileSync(DEVICE_FILE, "utf8").trim();
    if (v) return v;
  } catch {}
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(HV_DIR, { recursive: true });
    fs.writeFileSync(DEVICE_FILE, id + "\n", { mode: 0o600 });
  } catch {}
  return id;
}

function deviceLabel() {
  try { return os.hostname(); } catch { return "this machine"; }
}
function platformName() {
  return process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
}

class Auth extends EventEmitter {
  // issuer: () => the identity base URL (from the backend's /capabilities
  //   auth_issuer), or "" when the backend doesn't require auth.
  // safeStorage: Electron's safeStorage (encrypt/decrypt at rest).
  // openExternal: shell.openExternal (opens the system browser).
  constructor({ issuer, safeStorage, openExternal, log }) {
    super();
    this.issuerFn = issuer;
    this.safe = safeStorage;
    this.openExternal = openExternal;
    this.log = log || (() => {});
    this.access = "";      // in-memory access token (the wristband)
    this.email = "";
    this.lic = "";
    this.expMs = 0;        // access token expiry (epoch ms)
    this.refreshTimer = null;
    this.deviceId = deviceId();
  }

  issuer() { return (this.issuerFn() || "").replace(/\/+$/, ""); }
  token() { return this.access; }
  status() { return { signedIn: !!this.access, email: this.email, lic: this.lic }; }

  // ---- persisted refresh token (Keychain) ------------------------------------
  _saveRefresh(rt) {
    try {
      fs.mkdirSync(HV_DIR, { recursive: true });
      if (this.safe && this.safe.isEncryptionAvailable()) {
        fs.writeFileSync(REFRESH_FILE, this.safe.encryptString(rt), { mode: 0o600 });
      } else {
        // No Keychain (rare) — refuse to persist in plaintext; session-only auth.
        this.log("safeStorage unavailable — refresh token kept in memory only");
      }
    } catch (e) { this.log("save refresh failed: " + e.message); }
  }
  _loadRefresh() {
    try {
      const buf = fs.readFileSync(REFRESH_FILE);
      if (this.safe && this.safe.isEncryptionAvailable()) return this.safe.decryptString(buf);
    } catch {}
    return "";
  }
  _clearRefresh() { try { fs.unlinkSync(REFRESH_FILE); } catch {} }

  _apply(tokens) {
    this.access = tokens.access_token || "";
    this.email = tokens.email || this.email;
    this.lic = tokens.lic || "";
    const ttl = parseInt(tokens.expires_in, 10);
    this.expMs = Date.now() + (Number.isFinite(ttl) ? ttl : 900) * 1000;
    if (tokens.refresh_token) this._saveRefresh(tokens.refresh_token);
    this._scheduleRefresh();
    this.emit("change", this.status());
  }

  _scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    // Refresh ~1 minute before expiry (min 10s).
    const lead = Math.max(10_000, this.expMs - Date.now() - 60_000);
    this.refreshTimer = setTimeout(() => this.refresh().catch((e) => this.log("refresh: " + e.message)), lead);
    if (this.refreshTimer.unref) this.refreshTimer.unref();
  }

  // ---- startup: try to restore a session from the stored refresh token -------
  async restore() {
    const rt = this._loadRefresh();
    if (!rt || !this.issuer()) return false;
    try { await this._refreshWith(rt); return true; }
    catch (e) { this.log("restore failed: " + e.message); return false; }
  }

  async refresh() {
    const rt = this._loadRefresh();
    if (!rt) throw new Error("no refresh token");
    return this._refreshWith(rt);
  }

  // ensureFresh silently renews the access token when it's missing or within 5
  // minutes of expiry, but only if we have a stored session. Called whenever the
  // daemon (re)connects and on demand, so a stale token can't reach speech-api.
  async ensureFresh() {
    if (!this._loadRefresh()) return false;
    if (this.access && this.expMs - Date.now() > 5 * 60_000) return true; // still good
    try { await this.refresh(); return true; }
    catch (e) { this.log("ensureFresh: " + e.message); return false; }
  }

  async _refreshWith(rt) {
    const resp = await fetch(this.issuer() + "/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: rt, device_id: this.deviceId }),
    });
    if (resp.status === 403) { this._forceSignedOut(); throw new Error("license inactive"); }
    if (!resp.ok) { this._forceSignedOut(); throw new Error("refresh HTTP " + resp.status); }
    this._apply(await resp.json());
  }

  _forceSignedOut() {
    this.access = ""; this.lic = ""; this.expMs = 0;
    clearTimeout(this.refreshTimer);
    this._clearRefresh();
    this.emit("change", this.status());
  }

  // ---- interactive login (system browser + one-shot loopback catcher) --------
  // loginHint (optional): an email the person typed, passed to Google so their
  // chooser opens on that account. Only a hint — the chooser is always shown, so
  // this can never sign someone in as an account they didn't confirm.
  login(loginHint) {
    return new Promise((resolve, reject) => {
      const issuer = this.issuer();
      if (!issuer) return reject(new Error("the backend does not advertise an identity service (auth_issuer)"));

      const server = http.createServer((req, res) => {
        const u = new URL(req.url, "http://localhost");
        if (u.pathname !== "/cb") { res.writeHead(404); res.end(); return; }
        const err = u.searchParams.get("error");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(callbackPage(err));
        server.close();
        clearTimeout(timer);
        if (err) return reject(new Error(err));
        this._apply({
          access_token: u.searchParams.get("access_token"),
          refresh_token: u.searchParams.get("refresh_token"),
          expires_in: u.searchParams.get("expires_in"),
          lic: u.searchParams.get("lic"),
          email: u.searchParams.get("email"),
        });
        resolve(this.status());
      });

      const timer = setTimeout(() => { server.close(); reject(new Error("login timed out")); }, 5 * 60_000);
      if (timer.unref) timer.unref();

      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        const redirect = `http://localhost:${port}/cb`;
        const q = new URLSearchParams({
          redirect,
          device_id: this.deviceId,
          device_label: deviceLabel(),
          platform: platformName(),
        });
        const hint = (loginHint || "").toString().trim();
        if (hint) q.set("login_hint", hint);
        this.openExternal(`${issuer}/oauth/google/login?${q.toString()}`);
      });
      server.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
  }

  async logout() {
    const rt = this._loadRefresh();
    if (rt && this.issuer()) {
      try {
        await fetch(this.issuer() + "/logout", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: rt }),
        });
      } catch {}
    }
    this._forceSignedOut();
  }
}

// The page the browser lands on after Google. It used to be an unbranded
// "Signed in to Talkersoft" on a localhost URL that sat there — which reads like
// something went wrong, and leaves you wondering what to do next. Now it says
// which app to go back to and closes itself, so the browser stops being part of
// the experience the moment its job is done.
// Read once, reuse. Inlined rather than linked because the loopback server closes
// immediately after answering /cb, so any follow-up request for an asset would be
// refused before the browser could load it.
let ICON_DATA_URI = null;
function appIconDataURI() {
  if (ICON_DATA_URI !== null) return ICON_DATA_URI;
  try {
    const png = fs.readFileSync(path.join(__dirname, "..", "assets", "app-icon.png"));
    ICON_DATA_URI = "data:image/png;base64," + png.toString("base64");
  } catch { ICON_DATA_URI = ""; } // fall back to the drawn mark below
  return ICON_DATA_URI;
}

function callbackPage(err) {
  const ok = !err;
  const icon = appIconDataURI();
  return `<!doctype html><html><head><meta charset="utf-8"><title>${ok ? "Signed in" : "Sign-in problem"}</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;height:100vh;display:grid;place-items:center;background:#0e131a;color:#e7ecf3;
       font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;text-align:center}
  @media (prefers-color-scheme:light){body{background:#f5f7fa;color:#18212f}}
  .c{max-width:380px;padding:24px}
  .orb{width:60px;height:60px;border-radius:14px;margin:0 auto 18px;display:block;
       box-shadow:0 10px 26px -12px rgba(0,0,0,.55)}
  .orb.fallback{border-radius:50%;
       background:radial-gradient(circle at 35% 30%,#2dd4bf,transparent 70%),
                  conic-gradient(from 210deg,#2dd4bf,#0a63b0,#2dd4bf);box-shadow:0 0 30px -6px #2dd4bf}
  .brand{font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;
         color:#2dd4bf;margin:0 0 10px}
  h1{font-size:19px;margin:0 0 8px;letter-spacing:-.01em}
  p{margin:0;opacity:.75;font-size:14px}
  .err{color:#f87171}
</style></head><body><div class="c">
  ${icon ? `<img class="orb" src="${icon}" alt="" width="60" height="60" />` : `<div class="orb fallback"></div>`}
  <div class="brand">Agent Arcade</div>
  <h1>${ok ? "You're signed in" : "Sign-in problem"}</h1>
  <p class="${ok ? "" : "err"}">${ok ? "Return to Agent Arcade — this tab closes itself." : escapeHtml(err)}</p>
</div>
${ok ? "<script>setTimeout(function(){window.close()},1200)<\/script>" : ""}
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

module.exports = { Auth, deviceId };
