import React, { useEffect, useState } from "react";
import { useStore } from "../store.js";
import { tester, fmtBytes, apiUrlIsLocal } from "../ipc.js";

function capsSummary(caps) {
  if (!caps) return "";
  const yn = (b) => (b ? "yes" : "no");
  return `cleanup ${yn(caps.text_cleanup)} · image-gen ${yn(caps.image_gen)} · backend ${caps.backend || "?"}`;
}

export function SettingsBackend() {
  const servers = useStore((s) => s.servers);
  const activeServer = useStore((s) => s.activeServer);
  const backendApiUrl = useStore((s) => s.backendApiUrl);
  const dictationAvailable = useStore((s) => s.dictationAvailable);
  const dictationCaps = useStore((s) => s.dictationCaps);
  const loadBackend = useStore((s) => s.loadBackend);
  const app = useStore((s) => s.app);

  const [addName, setAddName] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [addMsg, setAddMsg] = useState({ text: "", color: "" });
  const [probes, setProbes] = useState({}); // name -> {symbol,color,title}

  const [dictTail, setDictTail] = useState(Number.isFinite(app.dictation_tail_ms) ? app.dictation_tail_ms : 250);
  const [dictPad, setDictPad] = useState(Number.isFinite(app.dictation_pad_ms) ? app.dictation_pad_ms : 200);
  useEffect(() => {
    setDictTail(Number.isFinite(app.dictation_tail_ms) ? app.dictation_tail_ms : 250);
    setDictPad(Number.isFinite(app.dictation_pad_ms) ? app.dictation_pad_ms : 200);
  }, [app]);

  async function setActive(name) {
    const res = await tester.serversSetActive(name);
    if (res && res.ok) useStore.setState({ servers: res.servers, activeServer: res.active, backendApiUrl: (res.servers.find((s) => s.name === res.active) || {}).url || "" });
    else loadBackend();
  }
  async function test(name) {
    const srv = servers.find((s) => s.name === name); if (!srv) return;
    setProbes((p) => ({ ...p, [name]: { symbol: "⣾", color: "#718096", title: "" } }));
    const probe = await tester.dictationTest(srv.url);
    let r;
    if (probe && probe.ok && probe.caps && probe.caps.asr === "ready") r = { symbol: "✓", color: "#2f855a", title: "ready" };
    else if (probe && probe.ok && probe.caps && probe.caps.asr === "downloading") r = { symbol: "⏳", color: "#b7791f", title: "model downloading" };
    else if (probe && probe.ok) r = { symbol: "⚠", color: "#b7791f", title: "reachable, no ready engine" };
    else r = { symbol: "✗", color: "#c53030", title: (probe && probe.error) || "unreachable" };
    setProbes((p) => ({ ...p, [name]: r }));
  }
  async function remove(name) {
    if (!confirm(`Remove server "${name}"?`)) return;
    const res = await tester.serversRemove(name);
    if (res && res.ok) useStore.setState({ servers: res.servers, activeServer: res.active, backendApiUrl: (res.servers.find((s) => s.name === res.active) || {}).url || "" });
  }
  async function add() {
    const name = addName.trim(), url = addUrl.trim();
    if (!name || !url) { setAddMsg({ text: "Name and URL are required.", color: "#c53030" }); return; }
    setAddMsg({ text: "⣾ adding…", color: "#718096" });
    const res = await tester.serversAdd(name, url);
    if (!res || !res.ok) { setAddMsg({ text: (res && res.error) || "Couldn't add server.", color: "#c53030" }); return; }
    useStore.setState({ servers: res.servers, activeServer: res.active, backendApiUrl: (res.servers.find((s) => s.name === res.active) || {}).url || "" });
    setAddName(""); setAddUrl("");
    setAddMsg({ text: `Added "${name}".`, color: "#2f855a" });
  }

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
      <div className="hint sgroup-intro">The dictation backends that transcribe your voice. Save several servers and pick exactly one as <b>active</b>. Dictation appears everywhere only when the active backend reports its speech engine is <b>ready</b>. Saved to <code>~/.hv/agent-arcade.yaml</code> (<code>servers</code> / <code>active_server</code>).</div>

      <div id="servers-list" style={{ marginTop: 8 }}>
        {!servers.length
          ? <div className="hint">No servers yet — add one below.</div>
          : servers.map((s) => {
            const probe = probes[s.name];
            return (
              <div className="row" key={s.name} style={{ alignItems: "center", border: "1px solid rgba(128,128,128,0.2)", borderRadius: 8, padding: "8px 12px", marginBottom: 8, ...(s.name === activeServer ? { borderColor: "rgba(72,196,244,0.5)" } : {}) }}>
                <label className="chk" style={{ marginRight: 6 }}>
                  <input type="radio" name="srv-active" checked={s.name === activeServer} onChange={() => setActive(s.name)} /> Active
                </label>
                <b>{s.name}</b>
                <code className="hint" style={{ marginLeft: 6, wordBreak: "break-all" }}>{s.url}</code>
                <span className="hint" style={{ marginLeft: 8, minWidth: 14, color: probe ? probe.color : "" }} title={probe ? probe.title : ""}>{probe ? probe.symbol : ""}</span>
                <button style={{ marginLeft: "auto" }} onClick={() => test(s.name)}>Test</button>
                <button className="danger" style={{ marginLeft: 6 }} onClick={() => remove(s.name)}>Remove</button>
              </div>
            );
          })}
      </div>

      <div className="row" style={{ marginTop: 8, alignItems: "center" }}>
        <input type="text" placeholder="Name (e.g. Spark)" style={{ flex: "0 1 200px" }} value={addName} onChange={(e) => setAddName(e.target.value)} />
        <input type="text" placeholder="http://host:9100" style={{ flex: 1, marginLeft: 8 }} value={addUrl} onChange={(e) => setAddUrl(e.target.value)} />
        <button style={{ marginLeft: 8 }} onClick={add}>Add server</button>
      </div>
      <div className="hint" style={{ minHeight: 18, marginTop: 6, color: addMsg.color }}>{addMsg.text}</div>
      <div className="hint" style={{ minHeight: 18, marginTop: 6, color: status.color }}>{status.html}</div>
      <div className="hint">Select a server's radio to make it active — it re-checks and flips dictation on/off live. <b>Test</b> probes that server without changing the active one.</div>

      <div className="row" style={{ marginTop: 12, alignItems: "center" }}>
        <label style={{ width: 150 }}>Model</label>
        <div className="hint" style={{ flex: 1, minHeight: 18 }}>
          {repo ? <><b>{repo}</b> &nbsp;·&nbsp; {modelState}</> : (caps ? modelState : "—")}
        </div>
        <button style={{ marginLeft: 8 }} disabled={!local || !present} title={!local ? "only available for a local backend" : (!present ? "no model to reveal" : "Show the model folder in Finder")} onClick={modelReveal}>Reveal in Finder</button>
        <button style={{ marginLeft: 6 }} disabled={!present} title={present ? "Delete the downloaded model on the backend" : "no model to remove"} onClick={modelRemove}>Remove model</button>
      </div>
      <div className="hint" style={{ marginTop: 4, wordBreak: "break-all" }}>{path}</div>

      <div className="hint sgroup-intro" style={{ marginTop: 16 }}>Dictation timing</div>
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
    </div>
  );
}
