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
  login() {
    return new Promise((resolve, reject) => {
      const issuer = this.issuer();
      if (!issuer) return reject(new Error("the backend does not advertise an identity service (auth_issuer)"));

      const server = http.createServer((req, res) => {
        const u = new URL(req.url, "http://localhost");
        if (u.pathname !== "/cb") { res.writeHead(404); res.end(); return; }
        const err = u.searchParams.get("error");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body style="font:16px system-ui;text-align:center;padding:3rem">
          <h2>${err ? "Sign-in problem" : "Signed in to Talkersoft"}</h2>
          <p>${err ? escapeHtml(err) : "You can close this window and return to Agent Arcade."}</p>
          </body></html>`);
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

module.exports = { Auth, deviceId };
