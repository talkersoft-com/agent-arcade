import React, { useEffect, useState, useRef } from "react";
import { useStore } from "../store.js";
import { tester } from "../ipc.js";

export function SettingsDisplays() {
  const screens = useStore((s) => s.screens);
  const display = useStore((s) => s.display);
  const watch = useStore((s) => s.watch);
  const wezterm = useStore((s) => s.wezterm);

  // Arcade monitor select value
  const curKey = display && Number.isFinite(display.monitor_x) ? `${display.monitor_x},${display.monitor_y}` : "";

  // ── pop-out terminal ──
  // The single source of truth for placement is watch_display in the YAML; the one
  // "Fit" action computes the size from the Arcade view and persists it. The X/Y/W/H
  // fields below are a manual override (Advanced), seeded once from the saved value.
  const [watchMon, setWatchMon] = useState("");   // target display key "x,y" ("" = Same as Arcade)
  const [fitMsg, setFitMsg] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [wx, setWx] = useState("");
  const [wy, setWy] = useState("");
  const [ww, setWw] = useState("");
  const [wh, setWh] = useState("");
  const [cols, setCols] = useState("");
  const [rows, setRows] = useState("");

  // Seed the editable drafts from the saved values ONCE (the store loads async). Never
  // re-sync on later store refreshes — that used to clobber in-progress edits. Explicit
  // actions own the drafts from here on (Fit / Capture set them; Apply re-reads them).
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    if (watch && Number.isFinite(watch.monitor_x)) {
      fillWatch(watch);
      // reflect which monitor the saved window sits on, into the dropdown
      const s = (screens || []).find((s) => watch.monitor_x >= s.x && watch.monitor_x < s.x + s.w && watch.monitor_y >= s.y && watch.monitor_y < s.y + s.h);
      if (s) setWatchMon(`${s.x},${s.y}`);
      seeded.current = true;
    }
  }, [watch, screens]);
  const gridSeeded = useRef(false);
  useEffect(() => {
    if (gridSeeded.current) return;
    if (wezterm && (wezterm.cols || wezterm.rows)) {
      setCols(wezterm.cols || ""); setRows(wezterm.rows || ""); gridSeeded.current = true;
    }
  }, [wezterm]);

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

  // ── macOS Automation permission (System Events) ──
  // Probe silently on mount; the permission row shows a status chip. The Fit / Capture /
  // Apply actions also flip this when they hit a permission error, so it self-surfaces.
  const [perm, setPerm] = useState("");
  async function checkPerm() {
    setPerm("checking");
    const r = await tester.permCheck();
    setPerm((r && r.state) || "");
  }
  async function requestPerm() {
    setPerm("checking");
    const r = await tester.permRequest();   // surfaces the prompt; opens Settings if still not granted
    setPerm((r && r.state) || "error");
  }
  useEffect(() => { checkPerm(); }, []);

  async function onMonitorChange(e) {
    const val = e.target.value;
    if (!val) { await tester.setDisplay(null); useStore.setState({ display: {} }); return; }
    const opt = e.target.selectedOptions[0];
    const [x, y] = val.split(",").map(Number);
    const d = { monitor_x: x, monitor_y: y, monitor_w: +opt.dataset.w, monitor_h: +opt.dataset.h };
    await tester.setDisplay(d);
    useStore.setState({ display: d });
  }

  // THE action: open WezTerm, resize it to the Arcade view (W×H) WITHOUT moving it
  // (keeps its current position), then persist.
  async function fitToArcade() {
    setFitMsg("◌ opening & fitting WezTerm…");
    const r = await tester.weztermFit({ monitor: watchMon });
    if (!r || !r.ok) {
      if (r && r.reason === "no-ratio") setFitMsg("⚠ Open the Arcade’s Live Terminal once first — it has no view size to match yet.");
      else if (r && r.reason === "permission") { setPerm("denied"); setFitMsg("⚠ macOS is blocking window control — grant access in the row above, then retry."); }
      else if (r && r.reason === "not-running") setFitMsg("○ No WezTerm window available — try again.");
      else setFitMsg("⚠ Couldn’t fit the terminal.");
      return;
    }
    fillWatch({ monitor_x: r.x, monitor_y: r.y, monitor_w: r.w, monitor_h: r.h });
    useStore.setState({ watch: (await tester.getWatch()) || {} });
    setPerm("granted");   // it worked → permission is fine
    setFitMsg(`✓ resized to ${r.w}×${r.h} on ${r.display} (position kept) · saved`);
  }

  // Center the live window on the chosen monitor — keeps its current SIZE, only moves it.
  async function centerWindow() {
    setFitMsg("◌ centering WezTerm…");
    const r = await tester.weztermCenter({ monitor: watchMon });
    if (!r || !r.ok) {
      if (r && r.reason === "permission") { setPerm("denied"); setFitMsg("⚠ macOS is blocking window control — grant access in the row below, then retry."); }
      else if (r && r.reason === "not-running") setFitMsg("○ No WezTerm window available — open it first.");
      else setFitMsg("⚠ Couldn’t center the terminal.");
      return;
    }
    fillWatch({ monitor_x: r.x, monitor_y: r.y, monitor_w: r.w, monitor_h: r.h });
    useStore.setState({ watch: (await tester.getWatch()) || {} });
    setPerm("granted");
    setFitMsg(`✓ centered on ${r.display} (size kept) · saved`);
  }

  // Advanced: read the live window's current geometry into the fields (manual flow).
  async function captureCurrent() {
    setFitMsg("◌ reading WezTerm window…");
    const d = await tester.detectWezterm();
    if (!d || !d.ok) {
      if (d && d.reason === "permission") { setPerm("denied"); setFitMsg("⚠ macOS is blocking window control — grant access in the row above."); }
      else setFitMsg("○ No WezTerm window — use “Fit” first, then drag it.");
      return;
    }
    fillWatch({ monitor_x: d.x, monitor_y: d.y, monitor_w: d.w, monitor_h: d.h });
    setFitMsg(`read ${d.w}×${d.h} @ ${d.x},${d.y} into fields — Apply & save to keep`);
  }

  // Advanced: apply the manual X/Y/W/H to the live window AND persist (window + grid).
  async function applyAdvanced() {
    const v = readWatch();
    if (!v) { setFitMsg("⚠ X and Y are required."); return; }
    setFitMsg("▶ applying…");
    if (v.monitor_w > 0 && v.monitor_h > 0) {
      const r = await tester.weztermSetBounds({ x: v.monitor_x, y: v.monitor_y, w: v.monitor_w, h: v.monitor_h });
      if (r && r.reason === "permission") { setPerm("denied"); setFitMsg("⚠ macOS is blocking window control — grant access in the row above."); return; }
      if (r && r.ok) setPerm("granted");
    }
    await tester.setWatch(v);
    const c = parseInt(cols, 10) || 0, rr = parseInt(rows, 10) || 0;
    const savedGrid = await tester.setWezterm({ cols: c, rows: rr });
    useStore.setState({ watch: (await tester.getWatch()) || {}, wezterm: savedGrid });
    setFitMsg(`saved ${v.monitor_w}×${v.monitor_h} @ ${v.monitor_x},${v.monitor_y}`);
    setAdvancedOpen(false);   // collapse Advanced once applied & saved
  }

  const blocked = perm === "denied" || perm === "error";
  const permChip = perm === "granted" ? { cls: "ok", text: "✓ allowed" }
    : blocked ? { cls: "warn", text: "⚠ blocked" }
    : { cls: "", text: perm === "checking" ? "…" : "—" };

  return (
    <div className="panel active" style={{ overflow: "auto" }}>
      <div className="hint sgroup-intro">Which monitors the Arcade and its pop-out terminal use.</div>

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
      <div className="hint sgroup-intro">A WezTerm window that mirrors the Arcade’s live-terminal area — <code>⌘P</code>, or dictate without the in-Arcade terminal.</div>
      <div className="disp-group">
        {/* setting */}
        <div className="row">
          <label>Watch on monitor</label>
          <select className="grow" style={{ maxWidth: 320 }} value={watchMon} onChange={(e) => setWatchMon(e.target.value)}>
            <option value="">Same as Arcade monitor</option>
            {screens.map((s) => (
              <option key={`${s.x},${s.y}`} value={`${s.x},${s.y}`}>
                Display {s.index + 1} — {s.w}×{s.h}{s.primary ? " (primary)" : ""}
              </option>
            ))}
          </select>
        </div>

        {/* actions / diagnostics — a list of rows, scales as more are added */}
        <div className="disp-actions">
          <div className="disp-act-row">
            <span className="disp-act-icon">⤢</span>
            <div className="disp-act-main">
              <div className="disp-act-name">Fit to Arcade view</div>
              <div className="disp-act-sub">Resize WezTerm to match the live-terminal area (W×H) — keeps its current position.</div>
            </div>
            <div className="disp-act-trail">
              <button className="disp-act-btn" onClick={fitToArcade}>Fit</button>
            </div>
          </div>

          <div className="disp-act-row">
            <span className="disp-act-icon">◎</span>
            <div className="disp-act-main">
              <div className="disp-act-name">Center on monitor</div>
              <div className="disp-act-sub">Center the WezTerm window on the chosen monitor — keeps its current size.</div>
            </div>
            <div className="disp-act-trail">
              <button className="disp-act-btn" onClick={centerWindow}>Center</button>
            </div>
          </div>

          <div className="disp-act-row">
            <span className="disp-act-icon">📍</span>
            <div className="disp-act-main">
              <div className="disp-act-name">Capture current</div>
              <div className="disp-act-sub">Read the live window’s position &amp; size into the Advanced fields.</div>
            </div>
            <div className="disp-act-trail">
              <button className="disp-act-btn" onClick={() => { setAdvancedOpen(true); captureCurrent(); }}>Capture</button>
            </div>
          </div>

          <div className="disp-act-row">
            <span className="disp-act-icon">🔌</span>
            <div className="disp-act-main">
              <div className="disp-act-name">WezTerm control access</div>
              <div className="disp-act-sub">macOS Automation permission — needed to size &amp; place the window.</div>
            </div>
            <div className="disp-act-trail">
              <span className={`disp-chip ${permChip.cls}`}>{permChip.text}</span>
              <button className="disp-act-btn" onClick={blocked ? requestPerm : checkPerm}>{blocked ? "Grant access" : "Re-check"}</button>
            </div>
          </div>
        </div>

        {fitMsg && <div className="disp-result">{fitMsg}</div>}

        <button className="disp-adv-toggle" onClick={() => setAdvancedOpen((v) => !v)}>
          {advancedOpen ? "▾" : "▸"} Advanced — manual position, size &amp; grid
        </button>
        {advancedOpen && (
          <div className="disp-adv">
            <div className="row">
              <label style={{ flex: "0 0 90px" }}>Position · size</label>
              <span className="fld">X <input type="number" value={wx} onChange={(e) => setWx(e.target.value)} /></span>
              <span className="fld">Y <input type="number" value={wy} onChange={(e) => setWy(e.target.value)} /></span>
              <span className="fld">W <input type="number" value={ww} onChange={(e) => setWw(e.target.value)} /></span>
              <span className="fld">H <input type="number" value={wh} onChange={(e) => setWh(e.target.value)} /></span>
            </div>
            <div className="row">
              <label style={{ flex: "0 0 90px" }}>Grid</label>
              <input type="number" min="20" max="500" placeholder="cols" style={{ flex: "0 0 80px" }} value={cols} onChange={(e) => setCols(e.target.value)} />
              <span style={{ opacity: 0.6 }}>×</span>
              <input type="number" min="5" max="300" placeholder="rows" style={{ flex: "0 0 80px" }} value={rows} onChange={(e) => setRows(e.target.value)} />
              <span className="hint">cols × rows</span>
            </div>
            <div className="btnrow">
              <button className="secondary" title="Resize the open WezTerm window to these values and save them" onClick={applyAdvanced}>Apply &amp; save</button>
            </div>
            <div className="hint">Manual override — normally just use <b>Fit to Arcade view</b> above. Grid is the terminal’s character size (e.g. <code>132 × 38</code>); leave blank for the default.</div>
          </div>
        )}
      </div>
    </div>
  );
}
