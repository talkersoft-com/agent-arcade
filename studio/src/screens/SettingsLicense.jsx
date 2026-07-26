import React, { useEffect, useState } from "react";
import { tester } from "../ipc.js";

// License view — one calm screen: which plan is in use, what it unlocks, and
// (when paid) how many devices are on the account. Nothing here is hardcoded:
// the tier comes from the wristband and the feature list from the backend
// catalog, so retuning a plan in the database shows up here with no app change.
//
// A Free user's read is the PUBLIC, identity-free catalog — the product API
// still records nothing about them.

const FEATURE_LABELS = {
  managed_config: "Agents synced across your machines",
  cloud_speech: "Cloud speech (faster dictation)",
  web_console: "Web console",
  web_agent_editor: "Edit agents on the web",
};
const labelFor = (k) => FEATURE_LABELS[k] || k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function SettingsLicense() {
  const [lic, setLic] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const refresh = async () => {
    try { const r = await tester.licenseGet(); setLic(r || null); } catch { setLic(null); }
    setLoading(false);
  };
  useEffect(() => {
    refresh();
    if (tester.onAuthChanged) tester.onAuthChanged(() => refresh());
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  const login = async () => {
    setBusy(true); setMsg("Opening your browser…");
    try {
      const r = await tester.authLogin();
      setMsg(r && r.ok ? "" : `Sign-in failed: ${(r && r.error) || "unknown"}`);
    } catch (e) { setMsg("Sign-in failed: " + e.message); }
    setBusy(false); refresh();
  };
  const logout = async () => { setBusy(true); try { await tester.authLogout(); } catch {} setBusy(false); refresh(); };

  if (loading) return <div className="subpanel active"><div className="hint">Loading your license…</div></div>;

  const l = lic || { signedIn: false, tier: "free", label: "Free", paid: false, entitlements: null };
  const ents = l.entitlements || {};
  const granted = Object.keys(ents).filter((k) => ents[k] === "true");
  const missing = Object.keys(ents).filter((k) => ents[k] !== "true");
  // What a Free user would gain by upgrading (from the public catalog).
  const upgrade = l.upgrade || null;
  const gains = upgrade ? Object.keys(upgrade).filter((k) => upgrade[k] === "true" && ents[k] !== "true") : [];

  return (
    <div className="subpanel active">
      <div className="disp-actions" style={{ marginTop: 0, borderTop: "none", paddingTop: 0 }}>
        <div className="disp-act-row">
          <div className="disp-act-icon">{l.paid ? "🎟️" : "○"}</div>
          <div className="disp-act-main">
            <div className="disp-act-name">
              {l.label} {l.paid
                ? <span className="badge run">{l.mode === "api" ? "connected" : "local"}</span>
                : <span className="badge stop">local</span>}
            </div>
            <div className="disp-act-sub">
              {l.signedIn
                ? <>Signed in as <b>{l.email || "—"}</b></>
                : "Not signed in — Agent Arcade is running entirely on this machine."}
              {l.paid && Number.isFinite(l.deviceCount) ? <> · {l.deviceCount} device{l.deviceCount === 1 ? "" : "s"} on your account</> : null}
              {msg ? <><br /><span style={{ color: "#e53e3e" }}>{msg}</span></> : null}
            </div>
          </div>
          <div className="disp-act-trail">
            {l.signedIn
              ? <button className="ghost" onClick={logout} disabled={busy}>{busy ? "…" : "Sign out"}</button>
              : <button onClick={login} disabled={busy}>{busy ? "…" : "Sign in with Google"}</button>}
          </div>
        </div>
      </div>

      {!l.paid && (
        <div className="hint" style={{ marginTop: 10 }}>
          Your agents and settings stay in a file on this Mac, and dictation runs locally.
          {l.signedIn ? " Nothing is stored on our servers on the free plan." : ""}
        </div>
      )}

      {(granted.length > 0 || missing.length > 0) && (
        <div style={{ marginTop: 14 }}>
          <div className="dict-sec">Your plan includes</div>
          <div className="dict-opts">
            {granted.map((k) => (
              <div key={k} className="dopt" style={{ cursor: "default" }}>
                <span className="dbox" style={{ opacity: 1 }}>✓</span>
                <span className="dopt-text">{labelFor(k)}</span>
              </div>
            ))}
            {missing.map((k) => (
              <div key={k} className="dopt" style={{ cursor: "default", opacity: .55 }}>
                <span className="dbox" style={{ opacity: .35 }} />
                <span className="dopt-text">{labelFor(k)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {gains.length > 0 && (
        <div className="hint" style={{ marginTop: 12 }}>
          Upgrading unlocks {gains.map(labelFor).join(", ").toLowerCase()}.
        </div>
      )}

      {!l.entitlements && (
        <div className="hint" style={{ marginTop: 12 }}>
          Couldn’t reach the licensing service — showing what’s known on this machine.
        </div>
      )}
    </div>
  );
}
