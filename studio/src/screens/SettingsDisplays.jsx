import React, { useEffect, useState } from "react";
import { useStore } from "../store.js";
import { tester } from "../ipc.js";

export function SettingsDisplays() {
  const screens = useStore((s) => s.screens);
  const display = useStore((s) => s.display);
  const watch = useStore((s) => s.watch);
  const wezterm = useStore((s) => s.wezterm);

  // monitor select value
  const curKey = display && Number.isFinite(display.monitor_x) ? `${display.monitor_x},${display.monitor_y}` : "";

  // watch (pop-out) editable fields
  const [wx, setWx] = useState("");
  const [wy, setWy] = useState("");
  const [ww, setWw] = useState("");
  const [wh, setWh] = useState("");
  useEffect(() => { fillWatch(watch); }, [watch]);
  function fillWatch(w) {
    const has = w && Number.isFinite(w.monitor_x);
    setWx(has ? w.monitor_x : ""); setWy(has ? w.monitor_y : "");
    setWw(has ? w.monitor_w : ""); setWh(has ? w.monitor_h : "");
  }
  function readWatch() {
    const x = parseInt(wx, 10), y = parseInt(wy, 10), w = parseInt(ww, 10), h = parseInt(wh, 10);
    if (![x, y].every(Number.isFinite)) return null;
    return { monitor_x: x, monitor_y: y, monitor_w: Number.isFinite(w) ? w : 0, monitor_h: Number.isFinite(h) ? h : 0 };
  }

  const [wezSyncStatus, setWezSyncStatus] = useState("Checking for WezTerm…");
  const [wezGeom, setWezGeom] = useState(null);
  const [wezSaved, setWezSaved] = useState("");
  const [cols, setCols] = useState(wezterm && wezterm.cols ? wezterm.cols : "");
  const [rows, setRows] = useState(wezterm && wezterm.rows ? wezterm.rows : "");
  useEffect(() => { setCols(wezterm && wezterm.cols ? wezterm.cols : ""); setRows(wezterm && wezterm.rows ? wezterm.rows : ""); }, [wezterm]);

  // detect live WezTerm on mount (the Displays tab is mounted only when active)
  useEffect(() => { refreshWeztermSync(); }, []);
  async function refreshWeztermSync() {
    setWezSyncStatus("Checking for WezTerm…"); setWezGeom(null);
    const d = await tester.detectWezterm();
    if (d && d.ok) { setWezSyncStatus(`● Terminal detected · ${d.w}×${d.h} @ ${d.x},${d.y} (${d.display})`); setWezGeom(d); }
    else if (d && d.reason === "permission") setWezSyncStatus("⚠ Automation permission needed — grant System Events.");
    else setWezSyncStatus("○ WezTerm not running — open & position it, then capture.");
  }

  async function onMonitorChange(e) {
    const val = e.target.value;
    if (!val) { await tester.setDisplay(null); useStore.setState({ display: {} }); return; }
    const opt = e.target.selectedOptions[0];
    const [x, y] = val.split(",").map(Number);
    const d = { monitor_x: x, monitor_y: y, monitor_w: +opt.dataset.w, monitor_h: +opt.dataset.h };
    await tester.setDisplay(d);
    useStore.setState({ display: d });
  }

  async function watchSave() {
    const v = readWatch();
    if (!v) return;
    await tester.setWatch(v);
    const w = await tester.getWatch();
    useStore.setState({ display: await tester.getDisplay(), watch: w || {} });
  }
  async function watchReset() {
    await tester.setWatch(null);
    useStore.setState({ watch: await tester.getWatch() || {} });
  }
  function capture() {
    if (!wezGeom) return;
    fillWatch({ monitor_x: wezGeom.x, monitor_y: wezGeom.y, monitor_w: wezGeom.w, monitor_h: wezGeom.h });
    setWezSaved(`captured ${wezGeom.w}×${wezGeom.h} @ ${wezGeom.x},${wezGeom.y} into the fields — review, then Save`);
  }
  async function syncToArcade() {
    const [ratio, disp, scr] = await Promise.all([tester.getViewRatio(), tester.getDisplay(), tester.listScreens()]);
    if (!ratio || !(ratio.w > 0) || !(ratio.h > 0)) { setWezSaved("⚠ no view ratio yet — open the Arcade's Live Terminal once, then Sync"); return; }
    let mw = disp && Number.isFinite(disp.monitor_w) ? disp.monitor_w : 0;
    let mh = disp && Number.isFinite(disp.monitor_h) ? disp.monitor_h : 0;
    if (!mw || !mh) { const p = (scr || []).find((s) => s.primary) || (scr || [])[0]; if (p) { mw = p.w; mh = p.h; } }
    if (!mw || !mh) return;
    const w = Math.round(mw * ratio.w), h = Math.round(mh * ratio.h);
    setWw(w); setWh(h);
    setWezSaved(`🧮 synced → ${w}×${h}  (${mw}×${mh} × ${ratio.w}/${ratio.h}) · Test, then Save`);
  }
  async function testSize() {
    const v = readWatch();
    if (!v) { setWezSaved("⚠ X and Y are required"); return; }
    if (!(v.monitor_w > 0 && v.monitor_h > 0)) { setWezSaved("⚠ set W and H first (Sync or Capture)"); return; }
    setWezSaved("▶ testing…");
    const r = await tester.weztermSetBounds({ x: v.monitor_x, y: v.monitor_y, w: v.monitor_w, h: v.monitor_h });
    if (r && r.ok) setWezSaved(`▶ applied ${v.monitor_w}×${v.monitor_h} @ ${v.monitor_x},${v.monitor_y}`);
    else if (r && r.reason === "permission") setWezSaved("⚠ Automation permission needed (System Events)");
    else if (r && r.reason === "not-running") setWezSaved("○ open a WezTerm window first (pop out a terminal)");
    else setWezSaved("⚠ test failed");
  }
  async function saveGrid() {
    const c = parseInt(cols, 10) || 0, r = parseInt(rows, 10) || 0;
    const saved = await tester.setWezterm({ cols: c, rows: r });
    useStore.setState({ wezterm: saved });
  }

  return (
    <div className="panel active" style={{ overflow: "auto" }}>
      <div className="hint sgroup-intro">Which monitors the Arcade and its pop-out terminal use, and the watch-window size.</div>

      <div className="dict-sec">Arcade monitor</div>
      <div className="disp-group">
        <div className="row"><label>Arcade monitor</label>
          <select style={{ flex: "0 1 360px" }} value={curKey} onChange={onMonitorChange}>
            <option value="">Primary (default)</option>
            {screens.map((s) => (
              <option key={`${s.x},${s.y}`} value={`${s.x},${s.y}`} data-w={s.w} data-h={s.h}>
                Display {s.index + 1} — {s.w}×{s.h}{s.primary ? " (primary)" : ""} @ {s.x},{s.y}
              </option>
            ))}
          </select>
        </div>
        <div className="hint">Which display the Agent Arcade opens fullscreen on. Takes effect next time you launch the Arcade.</div>
      </div>

      <div className="dict-sec" style={{ marginTop: 16 }}>Pop-out terminal</div>
      <div className="disp-group">
        <div className="hint">Where the Terminal <b>watch</b> window lands when you pop it out (<code>⌘P</code>, or dictate without the in-Arcade terminal).</div>
        <div className="row">
          <label style={{ flex: "0 0 150px" }}>Position · size</label>
          <span className="fld">X <input type="number" value={wx} onChange={(e) => setWx(e.target.value)} /></span>
          <span className="fld">Y <input type="number" value={wy} onChange={(e) => setWy(e.target.value)} /></span>
          <span className="fld">W <input type="number" value={ww} onChange={(e) => setWw(e.target.value)} /></span>
          <span className="fld">H <input type="number" value={wh} onChange={(e) => setWh(e.target.value)} /></span>
          <button style={{ marginLeft: 6 }} onClick={watchSave}>Save</button>
          <button className="ghost" title="Clear the saved position so the window returns to your primary display — fixes a lost / off-screen window or an unplugged monitor" onClick={watchReset}>Reset</button>
        </div>
        <div className="row" style={{ alignItems: "center" }}>
          <label style={{ flex: "0 0 150px" }}>Sync from Terminal</label>
          <span className="hint" style={{ flex: 1 }}>{wezSyncStatus}</span>
          <button className="ghost" onClick={refreshWeztermSync}>Re-check</button>
        </div>
        <div className="row">
          <span style={{ flex: "0 0 150px" }}></span>
          <button className="secondary" title="Compute the perfect W×H from the Arcade monitor and the live-terminal view ratio" onClick={syncToArcade}>🧮 Sync to Arcade view</button>
          <button className="ghost" title="Resize the open WezTerm window to the W/H + X/Y above so you can see it" onClick={testSize}>▶ Test size</button>
          <button className="ghost" disabled={!wezGeom} title="Manual fallback: read the live WezTerm window's current size into the fields (does not save)" onClick={capture}>📍 Capture current</button>
          <span className="hint" style={{ marginLeft: 8 }}>{wezSaved}</span>
        </div>
        <div className="hint">Recommended flow: <b>Sync to Arcade view</b> (computes the perfect W×H = Arcade monitor × live-terminal view ratio) → <b>Test size</b> (applies it to the open WezTerm window so you can see it) → <b>Save</b>. <b>Capture current</b> is a manual fallback that reads the live window's size into the fields (it does <i>not</i> save). Needs the Automation permission.</div>
      </div>

      <div className="dict-sec" style={{ marginTop: 16 }}>Terminal grid</div>
      <div className="disp-group">
        <div className="row">
          <label style={{ flex: "0 0 150px" }}>Terminal grid size</label>
          <input type="number" min="20" max="500" placeholder="cols" style={{ flex: "0 0 90px" }} value={cols} onChange={(e) => setCols(e.target.value)} />
          <span style={{ opacity: 0.6 }}>×</span>
          <input type="number" min="5" max="300" placeholder="rows" style={{ flex: "0 0 90px" }} value={rows} onChange={(e) => setRows(e.target.value)} />
          <span style={{ opacity: 0.6 }}>cols × rows</span>
          <button style={{ marginLeft: 8 }} onClick={saveGrid}>Save</button>
        </div>
        <div className="hint">Size of the pop-out WezTerm watch window in characters (e.g. <code>132 × 38</code>). Applied when the watch window opens. Leave blank for Terminal default.</div>
      </div>
    </div>
  );
}
