import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../store.js";
import { tester, isUuid, randomPaletteColor, accelToSymbols } from "../ipc.js";
import { AvatarGlyph } from "../components/Avatar.jsx";
import { HexColorPicker } from "../components/HexColorPicker.jsx";

const TOUR = [
  { key: "welcome", target: null, title: "Welcome to Agent Arcade 👋",
    body: "Before we launch your Arcade, let's set up your first agent — it only takes a minute.", primary: "Get started" },
  { key: "name", target: "#agent-name", panel: "general", focus: "agent-name", title: "Name your agent",
    body: "Something memorable — like “Backend agent”.", require: (f) => f.name.trim(), reqMsg: "Give your agent a name to continue." },
  { key: "desc", target: "#agent-description", panel: "general", focus: "agent-description", title: "Describe it",
    body: "A sentence or two about its job and personality — the more you give it, the more it comes to life." },
  { key: "cwd", target: "#agent-cwd", panel: "general", focus: "agent-cwd", title: "Working folder",
    body: "Where this agent runs — its working directory (cwd). Leave blank for the default, ~/workspace." },
  { key: "program", target: "#agent-program", panel: "advanced", focus: "agent-program", title: "Choose a compatible agent",
    body: "Claude is ready to go now — more (like Codex) are on the way.", unlock: true },
  { key: "addmore", target: "#agent-new", title: "That's your agent 🎉",
    body: "Spin up as many as you like — just hit + New agent. In the Arcade you hop between them with ⌘← →.", primary: "Next" },
  { key: "orient", target: null, panel: null, title: "You're all set ✨",
    body: "Agent Arcade lives in your menu bar — that's where Preferences (dictation, displays, your summon hotkey) live too.", primary: "Enter the Arcade" },
];

// First-run guided wizard: the new-agent editor in "wizard" mode (only the step's
// field shows) plus a spotlight overlay. Mirrors the reference tour.
export function Tour({ onDone }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const [programs, setPrograms] = useState([]);
  const [idx, setIdx] = useState(0);
  const [unlocked, setUnlocked] = useState(false);
  const [agentSaved, setAgentSaved] = useState(false);
  const [createdId, setCreatedId] = useState(null);
  const [subtab, setSubtab] = useState("general");
  const [tourMsg, setTourMsg] = useState("");
  const [summonSym, setSummonSym] = useState("⌘⌥A");
  const [trayIcon, setTrayIcon] = useState("");

  const [f, setF] = useState(() => ({ name: "", description: "", cwd: "", program: "claude", color: randomPaletteColor() }));
  const upd = (patch) => setF((cur) => ({ ...cur, ...patch }));

  const ringRef = useRef(null);
  const bubbleRef = useRef(null);
  const scrimRef = useRef(null);

  useEffect(() => {
    (async () => {
      try { const s = await tester.getShortcuts(); setSummonSym(accelToSymbols((s && s.summon) || "Command+Alt+A")); } catch {}
      try { setTrayIcon((tester.trayIcon ? await tester.trayIcon() : "") || ""); } catch {}
      setPrograms((await tester.agentPrograms()) || []);
    })();
  }, []);

  const step = TOUR[idx];
  useEffect(() => { if (step.panel) setSubtab(step.panel); if (step.focus) setTimeout(() => { const el = document.getElementById(step.focus); if (el) el.focus(); }, 60); }, [idx]);

  // position the spotlight + bubble whenever the step changes / on resize
  useLayoutEffect(() => { positionTour(); }, [idx, subtab]);
  useEffect(() => {
    const onResize = () => positionTour();
    window.addEventListener("resize", onResize, true);
    return () => window.removeEventListener("resize", onResize, true);
  }, [idx]);

  function positionTour() {
    const s = TOUR[idx];
    const ring = ringRef.current, bubble = bubbleRef.current, scrim = scrimRef.current;
    if (!ring || !bubble || !scrim) return;
    const el = s.target ? document.querySelector(s.target) : null;
    if (!el) {
      ring.style.display = "none"; scrim.style.display = "block"; bubble.style.display = "block";
      bubble.style.left = Math.round(window.innerWidth / 2 - bubble.offsetWidth / 2) + "px";
      bubble.style.top = Math.round(window.innerHeight / 2 - bubble.offsetHeight / 2) + "px";
      return;
    }
    scrim.style.display = "none";
    const r = el.getBoundingClientRect(), pad = 6, inset = 4;
    let rx = r.left - pad, ry = r.top - pad, rw = r.width + pad * 2, rh = r.height + pad * 2;
    if (rx < inset) { rw += rx - inset; rx = inset; }
    if (ry < inset) { rh += ry - inset; ry = inset; }
    if (rx + rw > window.innerWidth - inset) rw = window.innerWidth - inset - rx;
    if (ry + rh > window.innerHeight - inset) rh = window.innerHeight - inset - ry;
    ring.style.display = "block";
    ring.style.left = rx + "px"; ring.style.top = ry + "px"; ring.style.width = rw + "px"; ring.style.height = rh + "px";
    bubble.style.display = "block";
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight, gap = 14;
    let top = r.bottom + gap;
    if (top + bh > window.innerHeight - 10) top = Math.max(10, r.top - gap - bh);
    let left = Math.max(10, Math.min(window.innerWidth - bw - 10, r.left + r.width / 2 - bw / 2));
    bubble.style.left = Math.round(left) + "px"; bubble.style.top = Math.round(top) + "px";
  }

  async function saveAgent() {
    const name = f.name.trim();
    if (!name) return { ok: false, error: "Give your agent a name first.", field: "name" };
    const a = { id: createdId, name, description: f.description.trim(), program: f.program, cwd: f.cwd.trim(), color: f.color.trim(), active: true };
    const saved = await tester.agentsSave(a);
    if (saved && saved.ok === false) return { ok: false, error: saved.error || "Could not save." };
    const created = (!createdId && Array.isArray(saved)) ? (saved.find((x) => x.name === name) || null) : null;
    return { ok: true, saved, created };
  }
  async function ensureAgentSaved() {
    if (agentSaved) return { ok: true };
    const res = await saveAgent();
    if (!res.ok) return res;
    setAgentSaved(true);
    if (res.created) setCreatedId(res.created.id);
    await refreshAgents();
    if (res.created && (res.created.description || "").trim().length >= 1) tester.agentsGenerateAvatar(res.created.id);
    return { ok: true, created: res.created };
  }

  async function next() {
    const s = TOUR[idx];
    if (s.require && !s.require(f)) { setTourMsg(s.reqMsg || "Required."); if (s.focus) { const el = document.getElementById(s.focus); if (el) el.focus(); } return; }
    if (s.unlock) setUnlocked(true);
    const nextStep = TOUR[idx + 1];
    if (nextStep && nextStep.key === "addmore" && !agentSaved) {
      const r = await ensureAgentSaved();
      if (!r.ok) { setTourMsg(r.error || "Could not save."); if (r.field === "name") setIdx(1); return; }
    }
    if (idx < TOUR.length - 1) { setTourMsg(""); setIdx(idx + 1); }
  }
  function back() { if (idx > 0 && !agentSaved) { setTourMsg(""); setIdx(idx - 1); } }
  async function finish() {
    const r = await ensureAgentSaved();
    if (!r.ok) { setIdx(1); setTourMsg(r.error || "Give your agent a name first."); return; }
    try { await tester.seedArcadeTour(); } catch {}
    onDone && onDone();
    await tester.launchArcade();
  }

  // Enter = primary forward; Shift+Enter newline in description.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Enter") return;
      if (e.target && e.target.id === "agent-description" && e.shiftKey) return;
      e.preventDefault();
      if (idx === TOUR.length - 1) finish(); else next();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const last = idx === TOUR.length - 1;

  return (
    <>
      {/* wizard editor — only the step's field is visible (.wz-hide hides the rest) */}
      <div className="view active" id="view-agents">
        <div id="agent-editor" className="agent-editor wizard" style={{ display: "flex" }}>
          <div className="ed-head">
            <div className="ed-avatar-wrap"><AvatarGlyph color={f.color} size={72} /></div>
            <div className="ed-head-text">
              <div className="ed-name">New agent</div>
              <div className="ed-status"><span className="badge stop">new agent</span></div>
            </div>
          </div>
          <div className="ed-body">
            {subtab === "general" && (
              <div className="subpanel active">
                <div className="row"><label>Name</label><input id="agent-name" type="text" placeholder="e.g. Backend agent" style={{ flex: 1 }} value={f.name} onChange={(e) => upd({ name: e.target.value })} /></div>
                <div className="row" style={{ alignItems: "flex-start" }}><label>Description</label>
                  <div style={{ flex: 1 }}>
                    <textarea id="agent-description" rows={3} style={{ width: "100%", resize: "vertical" }} placeholder="What does this agent do?" value={f.description} onChange={(e) => upd({ description: e.target.value })} />
                  </div>
                </div>
                <div className="row"><label>Working dir</label><input id="agent-cwd" type="text" placeholder="~/workspace (default)" style={{ flex: 1 }} value={f.cwd} onChange={(e) => upd({ cwd: e.target.value })} /></div>
                <div className="row wz-hide" style={{ alignItems: "flex-start" }}><label>Color</label>
                  <div style={{ flex: 1 }}><HexColorPicker value={f.color} onChange={(v) => upd({ color: v })} /></div>
                </div>
              </div>
            )}
            {subtab === "advanced" && (
              <div className="subpanel active">
                <div className="row"><label>Agent</label>
                  <select id="agent-program" style={{ flex: "0 1 320px" }} value={f.program} onChange={(e) => upd({ program: e.target.value })}>
                    {programs.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* spotlight overlay */}
      <div id="tour-scrim" ref={scrimRef} style={{ display: "block" }} />
      <div id="tour-ring" ref={ringRef} />
      <div id="tour-bubble" ref={bubbleRef} role="dialog" aria-modal="true" style={{ display: "block" }}>
        <div id="tour-step">Step {idx + 1} of {TOUR.length}</div>
        <h3 id="tour-title">{step.title}</h3>
        <p id="tour-body">
          {step.key === "orient"
            ? `Agent Arcade lives in your menu bar — Preferences (dictation, displays, your summon hotkey) live there too.${summonSym ? ` Press ${summonSym} any time to summon it.` : ""} Look for it up here:`
            : step.body}
        </p>
        {step.key === "orient" && trayIcon ? (
          <div id="tour-menubar" style={{ display: "flex" }} aria-hidden="true">
            <span className="mb-fake" /><span className="mb-fake" />
            <span className="mb-ours"><img src={trayIcon} alt="Agent Arcade menu-bar icon" /></span>
            <span className="mb-clock">9:41</span>
          </div>
        ) : null}
        <div className="tour-msg" id="tour-msg" style={{ display: tourMsg ? "block" : "none" }}>{tourMsg}</div>
        <div className="tour-btns">
          <button className="ghost" type="button" onClick={back} style={{ display: (idx > 0 && !agentSaved) ? "" : "none" }}>Back</button>
          <span className="spacer" />
          <button className="secondary" type="button" onClick={finish} style={{ display: (last || unlocked) ? "" : "none" }}>{(step.primary && last) ? step.primary : "Save & enter Arcade"}</button>
          <button type="button" onClick={next} style={{ display: last ? "none" : "" }}>{(step.primary && !last) ? step.primary : "Next"}</button>
        </div>
      </div>
    </>
  );
}
