import React, { useEffect, useState } from "react";
import { useStore } from "../store.js";
import { tester, fmtBytes, apiUrlIsLocal } from "../ipc.js";

function capsSummary(caps) {
  if (!caps) return "";
  const yn = (b) => (b ? "yes" : "no");
  return `cleanup ${yn(caps.text_cleanup)} · image-gen ${yn(caps.image_gen)} · backend ${caps.backend || "?"}`;
}

// Dictation daemon action row — the manual escape hatch for the shared daemon.
// The chip is the daemon's OWN answer over the socket (version · uptime ·
// connected clients), not a guess. Restart sends shutdown("user_restart"); the
// launcher/client ensure loops revive it, and the uptime resetting to seconds
// is the visible proof the restart took effect (mic-row philosophy).
// Account row — sign in to Talkersoft ID (Google). Shows verifiable state (the
// email comes from the verified token, not a guess). Only nudges when the active
// backend actually requires auth; otherwise it's an available-but-optional row.
function AccountSection() {
  const [st, setSt] = useState({ signedIn: false, email: "", lic: "", issuer: "", required_by: "off" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const refresh = async () => { try { const s = await tester.authStatus(); if (s) setSt((p) => ({ ...p, ...s })); } catch {} };
  useEffect(() => {
    refresh();
    if (tester.onAuthChanged) tester.onAuthChanged((s) => setSt((p) => ({ ...p, ...s })));
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

  const noIssuer = !st.issuer;
  return (
    <div className="disp-actions" style={{ marginTop: 0, borderTop: "none", paddingTop: 0 }}>
      <div className="disp-act-row">
        <div className="disp-act-icon">👤</div>
        <div className="disp-act-main">
          <div className="disp-act-name">Account</div>
          <div className="disp-act-sub">
            {st.signedIn
              ? <>Signed in as <b>{st.email}</b>{st.lic ? <> · license <b>{st.lic}</b></> : null}</>
              : noIssuer
                ? "The active backend doesn't require sign-in."
                : (st.required_by === "required" ? "Sign in to use dictation on this backend." : "Optional — sign in to associate dictation with your account.")}
            {msg ? <><br /><span style={{ color: "#e53e3e" }}>{msg}</span></> : null}
          </div>
        </div>
        <div className="disp-act-trail">
          {st.signedIn
            ? <button onClick={logout} disabled={busy}>{busy ? "…" : "Sign out"}</button>
            : <button onClick={login} disabled={busy || noIssuer}>{busy ? "…" : "Sign in with Google"}</button>}
        </div>
      </div>
    </div>
  );
}

function DaemonSection() {
  const [info, setInfo] = useState(null); // {daemon_version, uptime_s, clients}
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    try {
      const r = await tester.daemonInfo();
      if (r && r.ok) { setInfo(r.info); setErr(""); } else { setInfo(null); setErr((r && r.error) || "not connected"); }
    } catch (e) { setInfo(null); setErr(e.message || "not connected"); }
  };
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const restart = async () => {
    setBusy(true);
    setInfo(null); // chip goes blank while the old daemon dies — half the proof
    try { await tester.daemonRestart(); } catch {}
    const t0 = Date.now();
    const poll = async () => {
      try {
        const r = await tester.daemonInfo();
        if (r && r.ok && (r.info.uptime_s || 0) < 30) { setInfo(r.info); setErr(""); setBusy(false); return; }
      } catch {}
      if (Date.now() - t0 < 15000) setTimeout(poll, 500);
      else { setErr("daemon did not come back — check the launcher log"); setBusy(false); }
    };
    setTimeout(poll, 600);
  };
  const fmtUp = (s) => {
    s = s || 0;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`;
  };
  return (
    <div className="disp-actions" style={{ marginTop: 0, borderTop: "none", paddingTop: 0 }}>
      <div className="disp-act-row">
        <div className="disp-act-icon">🔄</div>
        <div className="disp-act-main">
          <div className="disp-act-name">Dictation daemon</div>
          <div className="disp-act-sub">
            {info
              ? <>v{info.daemon_version} · up {fmtUp(info.uptime_s)} · {(info.clients || []).length} client{(info.clients || []).length === 1 ? "" : "s"} ({(info.clients || []).join(", ") || "none"})</>
              : (busy ? "restarting…" : err || "connecting…")}
          </div>
        </div>
        <div className="disp-act-trail">
          <button onClick={restart} disabled={busy}>{busy ? "Restarting…" : "Restart"}</button>
        </div>
      </div>
    </div>
  );
}

// Microphone picker — dropdown only, no sound test. Persists app.mic_device_id +
// mic_device_label; both capture paths read it (the Arcade re-reads settings on window
// focus, so the change applies to the very next recording — nothing needs restarting).
// "Last recording used" is Chromium's track.label from the most recent capture — ground
// truth of which device actually recorded, not which one we asked for.
function MicSection({ app }) {
  const [mics, setMics] = useState([]);
  const [selected, setSelected] = useState(app.mic_device_id || "");
  const [lastUsed, setLastUsed] = useState(app.mic_last_used || "");
  const [levels, setLevels] = useState([]);   // rolling live-level history → the "sound lines"
  const [vol, setVol] = useState(null);       // macOS input volume 0–100 (system default device)
  useEffect(() => { setSelected(app.mic_device_id || ""); setLastUsed(app.mic_last_used || ""); }, [app]);

  // Always-on sound lines: passively meter the SELECTED device while this tab is open.
  // No test button — the meter simply is. Reopens when the selection changes.
  useEffect(() => {
    let raf = null, ctx = null, stream = null, alive = true;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: selected ? { deviceId: { exact: selected } } : true });
        if (!alive) { stream.getTracks().forEach((t) => t.stop()); return; }
        ctx = new AudioContext();
        const an = ctx.createAnalyser(); an.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Float32Array(an.fftSize);
        let last = 0;
        const tick = (t) => {
          if (!alive) return;
          if (t - last > 90) {
            last = t;
            an.getFloatTimeDomainData(buf);
            let sum = 0, peak = 0;
            for (let i = 0; i < buf.length; i++) { const s = buf[i]; sum += s * s; const a = Math.abs(s); if (a > peak) peak = a; }
            const lvl = Math.min(1, Math.sqrt(sum / buf.length) * 4);
            // clip = raw peak near full scale — the "over the red line" condition
            setLevels((p) => [...p.slice(-27), { l: lvl, clip: peak > 0.85 }]);
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch { setLevels([]); }
    })();
    return () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch {}
      try { if (ctx) ctx.close(); } catch {}
    };
  }, [selected]);

  // macOS input volume — read once, write on slider move (applies to the system
  // default input device; that OS gain is what silently zeroed the built-in mic).
  useEffect(() => { (async () => { try { const v = await tester.micVolGet(); if (Number.isFinite(v) && v >= 0) setVol(v); } catch {} })(); }, []);
  async function changeVol(v) {
    const n = Math.max(0, Math.min(100, parseInt(v, 10) || 0));
    setVol(n);
    try { await tester.micVolSet(n); } catch {}
  }

  async function refreshMics() {
    // one getUserMedia so device labels are populated (they're blank without permission)
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); } catch {}
    try { const d = await navigator.mediaDevices.enumerateDevices(); setMics(d.filter((x) => x.kind === "audioinput")); } catch {}
  }
  useEffect(() => {
    refreshMics();
    const onChange = () => refreshMics();
    // re-read last-used on focus: the Arcade (a separate process) writes it after each recording
    const onFocus = async () => { try { const a = await tester.getApp(); if (a) { setLastUsed(a.mic_last_used || ""); useStore.setState((s) => ({ app: { ...s.app, ...a } })); } } catch {} };
    navigator.mediaDevices.addEventListener && navigator.mediaDevices.addEventListener("devicechange", onChange);
    window.addEventListener("focus", onFocus);
    return () => {
      navigator.mediaDevices.removeEventListener && navigator.mediaDevices.removeEventListener("devicechange", onChange);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  async function selectMic(id) {
    setSelected(id);
    const label = id ? ((mics.find((m) => m.deviceId === id) || {}).label || "") : "";
    const saved = await tester.setApp({ mic_device_id: id, mic_device_label: label });
    useStore.setState((s) => ({ app: { ...s.app, ...saved } }));
  }

  return (
    <>
      <div className="hint sgroup-intro" style={{ marginTop: 0 }}>Microphone</div>
      <div className="disp-actions" style={{ marginTop: 0, borderTop: "none", paddingTop: 0 }}>
        <div className="disp-act-row">
          <div className="disp-act-icon">🎙</div>
          <div className="disp-act-main">
            <div className="disp-act-name">Input device</div>
            <div className="disp-act-sub">
              {lastUsed
                ? <>Last recording used: <b>{lastUsed}</b></>
                : "No recordings yet — after your next dictation, the device it actually used shows here."}
            </div>
          </div>
          <div className="disp-act-trail">
            <select value={selected} onChange={(e) => selectMic(e.target.value)} style={{ maxWidth: 280 }}>
              <option value="">System default</option>
              {mics.map((m, i) => <option key={m.deviceId || i} value={m.deviceId}>{m.label || `Microphone ${i + 1}`}</option>)}
            </select>
          </div>
        </div>

        <div className="disp-act-row">
          <div className="disp-act-icon">📈</div>
          <div className="disp-act-main">
            <div className="disp-act-name">Level</div>
            <div className="disp-act-sub">Speak normally — keep the lines under the red line. Red bars mean it's clipping.</div>
          </div>
          <div className="disp-act-trail" style={{ position: "relative", display: "flex", alignItems: "flex-end", gap: 2, height: 34, minWidth: 150 }}>
            {/* the red horizontal line — the ceiling to stay under */}
            <div style={{ position: "absolute", left: 0, right: 0, top: 4, borderTop: "2px solid rgba(229,62,62,0.8)" }} />
            {(levels.length ? levels : Array.from({ length: 28 }, () => ({ l: 0, clip: false }))).map((b, i) => (
              <div key={i} style={{
                width: 3,
                height: Math.max(2, b.l * 30),
                background: b.clip ? "#e53e3e" : (b.l > 0.08 ? "#48c4f4" : "rgba(128,128,128,0.45)"),
                borderRadius: 1,
              }} />
            ))}
          </div>
        </div>

        <div className="disp-act-row">
          <div className="disp-act-icon">🔊</div>
          <div className="disp-act-main">
            <div className="disp-act-name">Input volume</div>
            <div className="disp-act-sub">macOS input level for the system-default microphone — at 0 it records pure silence.</div>
          </div>
          <div className="disp-act-trail" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 200 }}>
            <input type="range" min="0" max="100" step="1" value={vol == null ? 0 : vol} disabled={vol == null}
              onChange={(e) => changeVol(e.target.value)} style={{ flex: 1 }} />
            <span className="hint" style={{ minWidth: 30, textAlign: "right" }}>{vol == null ? "—" : vol}</span>
          </div>
        </div>
      </div>
      <div className="hint">Device changes apply to the very next recording — nothing needs restarting. If the saved microphone isn't present (unplugged, KVM switched), recording falls back to the system default and tells you with a toast. The level meter runs live on the selected device while this tab is open.</div>
    </>
  );
}

// Where speech runs — DERIVED, not chosen. A paid licence means our servers; a
// free one (or no account) means this Mac. There is deliberately no picker, no
// environment, and no hostname anywhere on this screen: which environment a build
// talks to is ours to decide in the yaml, and a user should have to decompile to
// find a host.
//
// The one adjustable thing is the local port, because something else on the
// machine can already own it and there would otherwise be no way out.
function SpeechBackendSection() {
  const [cfg, setCfg] = useState(null);
  const [port, setPort] = useState("");
  const [msg, setMsg] = useState("");
  const [probe, setProbe] = useState(null);

  const load = async () => {
    const c = await tester.backendGet();
    setCfg(c); setPort(String(c.port));
  };
  useEffect(() => {
    load();
    if (tester.onAuthChanged) tester.onAuthChanged(() => load()); // licence → backend
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, []);

  async function savePort() {
    const r = await tester.backendSet({ port });
    if (r && r.ok) { setCfg(r); setPort(String(r.port)); setMsg(""); setProbe(null); }
    else setMsg((r && r.error) || "Could not save.");
  }
  async function test() {
    setProbe({ symbol: "⣾", color: "#718096", text: "checking…" });
    const r = await tester.backendTest();
    if (r && r.ok && r.caps && r.caps.asr === "ready") setProbe({ symbol: "✓", color: "#2f855a", text: "ready" });
    else if (r && r.ok && r.caps && r.caps.asr === "downloading") setProbe({ symbol: "⏳", color: "#b7791f", text: "model downloading" });
    else if (r && r.ok) setProbe({ symbol: "⚠", color: "#b7791f", text: "reachable, engine not ready" });
    else setProbe({ symbol: "✗", color: "#c53030", text: (r && r.error) || "unreachable" });
  }

  if (!cfg) return <div className="hint">Loading…</div>;
  const cloud = cfg.mode === "cloud";

  return (
    <>
      <div className="hint sgroup-intro" style={{ marginTop: 0 }}>Speech</div>
      <div className="disp-actions" style={{ marginTop: 0, borderTop: "none", paddingTop: 0 }}>
        <div className="disp-act-row">
          <div className="disp-act-icon">{cloud ? "☁️" : "🖥"}</div>
          <div className="disp-act-main">
            <div className="disp-act-name">
              {cloud ? "Agent Arcade cloud" : "This Mac"}
              {cloud ? <span className="badge run" style={{ marginLeft: 8 }}>connected</span> : null}
            </div>
            <div className="disp-act-sub">
              {cloud
                ? "Your plan includes cloud dictation, so speech runs on our servers."
                : "Dictation runs on this Mac's Apple silicon. Nothing leaves your computer."}
            </div>
          </div>
          <div className="disp-act-trail">
            <button className="ghost" onClick={test}>Test</button>
            {probe ? <span style={{ marginLeft: 10, color: probe.color }}>{probe.symbol} {probe.text}</span> : null}
          </div>
        </div>
      </div>

      {!cloud && (
        <div className="row" style={{ marginTop: 10, alignItems: "center" }}>
          <label style={{ minWidth: 40 }}>Port</label>
          <input type="number" min="1" max="65535" style={{ width: 110 }} value={port}
            onChange={(e) => setPort(e.target.value)}
            onBlur={savePort}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); savePort(); } }} />
          <span className="hint" style={{ marginLeft: 10 }}>
            Change this only if something else on your Mac already uses it.
          </span>
        </div>
      )}
      {msg ? <div className="hint" style={{ color: "#e53e3e", marginTop: 6 }}>{msg}</div> : null}
      <div className="hint" style={{ marginTop: 8 }}>
        Signed in on a paid plan, speech moves to our servers automatically. Sign out and it comes
        straight back here — see the <b>License</b> tab.
      </div>
    </>
  );
}

export function SettingsBackend() {
  const backendApiUrl = useStore((s) => s.backendApiUrl);
  const dictationAvailable = useStore((s) => s.dictationAvailable);
  const dictationCaps = useStore((s) => s.dictationCaps);
  const loadBackend = useStore((s) => s.loadBackend);
  const app = useStore((s) => s.app);


  const [dictTail, setDictTail] = useState(Number.isFinite(app.dictation_tail_ms) ? app.dictation_tail_ms : 250);
  const [dictPad, setDictPad] = useState(Number.isFinite(app.dictation_pad_ms) ? app.dictation_pad_ms : 200);
  useEffect(() => {
    setDictTail(Number.isFinite(app.dictation_tail_ms) ? app.dictation_tail_ms : 250);
    setDictPad(Number.isFinite(app.dictation_pad_ms) ? app.dictation_pad_ms : 200);
  }, [app]);


  async function saveTiming() {
    const saved = await tester.setApp({ dictation_tail_ms: parseInt(dictTail, 10), dictation_pad_ms: parseInt(dictPad, 10) });
    setDictTail(saved.dictation_tail_ms); setDictPad(saved.dictation_pad_ms);
    useStore.setState((s) => ({ app: { ...s.app, ...saved } }));
  }
  async function modelReveal() { await tester.modelReveal(); }
  async function modelRemove() {
    if (!confirm("Remove the downloaded model? It will re-download on next use.")) return;
    await tester.modelRemove();
  }

  // ── model row state (from caps) ──
  const caps = dictationCaps;
  const repo = caps && caps.model_repo ? String(caps.model_repo) : "";
  const path = caps && caps.model_path ? String(caps.model_path) : "";
  const present = !!(caps && caps.model_present) && Number(caps && caps.model_bytes) > 0;
  let modelState;
  if (caps && caps.asr === "downloading") modelState = "Downloading…";
  else if (present) modelState = fmtBytes(caps.model_bytes) || "downloaded";
  else modelState = "not downloaded";
  const local = apiUrlIsLocal(backendApiUrl);

  // backend status line
  let status;
  if (dictationAvailable && caps) status = { color: "#2f855a", html: <>✓ Connected — <b>{caps.asr_model || "asr"}</b> &nbsp;·&nbsp; {capsSummary(caps)}</> };
  else if (caps && caps.asr === "downloading") status = { color: "#b7791f", html: "⏳ Backend reachable — speech model downloading. Dictation will appear when it's ready." };
  else status = { color: "#718096", html: "Dictation unavailable — no reachable backend with a ready speech engine." };

  return (
    <div className="panel active" style={{ overflow: "auto" }}>
      <SpeechBackendSection />

      <hr className="sep" />

      <MicSection app={app} />

      <hr className="sep" />

      <div className="hint sgroup-intro" style={{ marginTop: 0 }}>Dictation timing</div>
      <div className="row" style={{ marginTop: 8 }}>
        <label style={{ width: 200 }}>End-of-speech capture (ms)</label>
        <input type="number" min="0" max="1500" step="50" placeholder="250" style={{ flex: "0 0 90px" }} value={dictTail} onChange={(e) => setDictTail(e.target.value)} />
        <span style={{ opacity: 0.6 }}>ms</span>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <label style={{ width: 200 }}>Trailing silence (ms)</label>
        <input type="number" min="0" max="1000" step="50" placeholder="200" style={{ flex: "0 0 90px" }} value={dictPad} onChange={(e) => setDictPad(e.target.value)} />
        <span style={{ opacity: 0.6 }}>ms</span>
        <button style={{ marginLeft: 8 }} onClick={saveTiming}>Save</button>
      </div>
      <div className="hint">How long the Arcade keeps capturing after you hit <code>⌘D</code> to send, and how much silence it pads onto the end. Higher = less chance of clipping the last word; adds latency. Tail 0–1500, silence 0–1000. Applies live in the Arcade.</div>

      <hr className="sep" />

      <DaemonSection />
      <div className="hint">One shared daemon serves every window over a local socket. It heals itself (kill it and it comes back); Restart is the manual escape hatch — the uptime resetting to seconds is your proof it took effect.</div>
    </div>
  );
}
