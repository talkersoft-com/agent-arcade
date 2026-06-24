import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../store.js";
import { tester, accelToSymbols, eventToAccel } from "../ipc.js";

const CREDITS = [
  { name: "WezTerm", note: "GPU terminal & multiplexer · MIT", links: [["repo", "https://github.com/wez/wezterm"], ["license", "https://github.com/wez/wezterm/blob/main/LICENSE.md"]] },
  { name: "Electron", note: "MIT", links: [["repo", "https://github.com/electron/electron"]] },
  { name: "xterm.js", note: "MIT", links: [["repo", "https://github.com/xtermjs/xterm.js"]] },
  { name: "node-pty", note: "MIT", links: [["repo", "https://github.com/microsoft/node-pty"]] },
  { name: "js-yaml", note: "MIT", links: [["repo", "https://github.com/nodeca/js-yaml"]] },
];

export function SettingsGeneral() {
  const app = useStore((s) => s.app);
  const shortcuts = useStore((s) => s.shortcuts);

  const [syncTabs, setSyncTabs] = useState(app.sync_wezterm_tabs !== false);
  const [warnExit, setWarnExit] = useState(!!app.warn_on_exit);
  const [composeSplit, setComposeSplit] = useState(app.compose_split || 60);

  const [scCurrent, setScCurrent] = useState((shortcuts && shortcuts.summon) || "");
  const [scRecording, setScRecording] = useState(false);
  const [scMsg, setScMsg] = useState("Press to show Agent Arcade; press again to hide. Click Record…, then press your key combo (needs at least one of ⌘/⌃/⌥/⇧).");

  useEffect(() => { setSyncTabs(app.sync_wezterm_tabs !== false); setWarnExit(!!app.warn_on_exit); setComposeSplit(app.compose_split || 60); }, [app]);
  useEffect(() => { setScCurrent((shortcuts && shortcuts.summon) || ""); }, [shortcuts]);

  async function toggleSync(v) { setSyncTabs(v); await tester.setApp({ sync_wezterm_tabs: v }); }
  async function toggleWarn(v) { setWarnExit(v); await tester.setApp({ warn_on_exit: v }); }
  async function saveCompose() {
    const saved = await tester.setApp({ compose_split: parseInt(composeSplit, 10) });
    setComposeSplit(saved.compose_split);
    useStore.setState((s) => ({ app: { ...s.app, ...saved } }));
  }

  // ── shortcut recorder ──
  const recordingRef = useRef(false);
  async function scStart() {
    if (recordingRef.current) return;
    recordingRef.current = true; setScRecording(true);
    await tester.suspendShortcuts();
    setScMsg("Listening… press your combo, or Esc to cancel.");
  }
  async function scStop(reapply) {
    recordingRef.current = false; setScRecording(false);
    if (reapply) await tester.resumeShortcuts();
  }
  useEffect(() => {
    if (!scRecording) return;
    const onKey = async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.code === "Escape") { await scStop(true); setScMsg("Recording cancelled."); return; }
      const r = eventToAccel(e);
      if (!r) return;
      if (r.error) { setScMsg("Add a modifier (⌘ / ⌃ / ⌥ / ⇧) plus a key."); return; }
      await scStop(false);
      const res = await tester.setSummonHotkey(r.accel);
      setScCurrent(r.accel);
      useStore.setState((s) => ({ shortcuts: { ...s.shortcuts, summon: r.accel } }));
      if (res && res.ok) setScMsg(`Summon set to ${accelToSymbols(r.accel)}.`);
      else setScMsg(`${accelToSymbols(r.accel)} is in use by another app — saved, but inactive. Try another.`);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [scRecording]);

  async function scClear() { await tester.setSummonHotkey(""); setScCurrent(""); useStore.setState((s) => ({ shortcuts: { ...s.shortcuts, summon: "" } })); setScMsg("Summon hotkey disabled."); }

  return (
    <div className="panel active" style={{ overflow: "auto" }}>
      <div className="hint sgroup-intro">Behavior of Agent Arcade Studio <b>and</b> the Agent Arcade. Saved to <code>~/.hv/agent-arcade.yaml</code>.</div>
      <div className="toggle-cards">
        <label className="dict-master">
          <span className="switch"><input type="checkbox" checked={syncTabs} onChange={(e) => toggleSync(e.target.checked)} /><span className="slider" /></span>
          <span className="dm-text">
            <span className="dm-title">Sync Terminal tabs</span>
            <span className="dm-sub">Switch the terminal tab to the selected agent when you change agents (e.g. arrowing in the Arcade).</span>
          </span>
        </label>
        <label className="dict-master">
          <span className="switch"><input type="checkbox" checked={warnExit} onChange={(e) => toggleWarn(e.target.checked)} /><span className="slider" /></span>
          <span className="dm-text">
            <span className="dm-title">Warn before exiting the Arcade</span>
            <span className="dm-sub">Ask before quitting (on by default; protects unsaved work in your live terminals). Turn off to exit without asking.</span>
          </span>
        </label>
      </div>

      <div className="dict-sec">Compose</div>
      <div className="row" style={{ marginTop: 8 }}>
        <label style={{ width: 150 }}>Compose split</label>
        <input type="number" min="20" max="80" step="5" placeholder="60" style={{ flex: "0 0 90px" }}
          value={composeSplit} onChange={(e) => setComposeSplit(e.target.value)} />
        <span style={{ opacity: 0.6 }}>% editor</span>
        <button style={{ marginLeft: 8 }} onClick={saveCompose}>Save</button>
      </div>
      <div className="hint">In the Arcade's <code>⌘E</code> compose view, how much of the height the text editor gets (the rest is the live terminal). <code>60</code> = 60/40, <code>50</code> = even. Range 20–80. Re-open <code>⌘E</code> in the Arcade to apply.</div>

      <div className="dict-sec" style={{ marginTop: 16 }}>Shortcuts</div>
      <div className="hint">Global hotkeys — they work from any app, even when Agent Arcade isn't focused. Saved to <code>~/.hv/agent-arcade.yaml</code>.</div>
      <div className="row" style={{ marginTop: 8, alignItems: "center" }}>
        <label style={{ width: 170 }}>Summon Agent Arcade</label>
        <code className={"sc-chord" + (scRecording ? " recording" : "") + (!scCurrent && !scRecording ? " empty" : "")}>
          {scRecording ? "Press keys…" : (scCurrent ? accelToSymbols(scCurrent) : "Disabled")}
        </code>
        <button style={{ marginLeft: 8 }} onClick={() => (scRecording ? scStop(true).then(() => setScMsg("Recording cancelled.")) : scStart())}>{scRecording ? "Cancel" : "Record…"}</button>
        <button style={{ marginLeft: 6 }} onClick={scClear}>Disable</button>
      </div>
      <div className="hint">{scMsg}</div>

      <div className="dict-sec" style={{ marginTop: 18 }}>Credits</div>
      <div className="hint">Agent Arcade is built on these open-source projects.</div>
      <div className="credits-list">
        {CREDITS.map((c) => (
          <div className="credit-row" key={c.name}>
            <b>{c.name}</b> — {c.note}{"  "}
            {c.links.map(([label, href], i) => (
              <React.Fragment key={href}>
                {i > 0 ? " · " : " "}
                <a className="ext-link" onClick={(e) => { e.preventDefault(); tester.openExternal(href); }}>{label}</a>
              </React.Fragment>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
