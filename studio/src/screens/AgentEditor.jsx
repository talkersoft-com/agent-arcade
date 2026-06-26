import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../store.js";
import {
  tester, isUuid, normHex, randomPaletteColor,
  startCapture, stopCapture, encodeWav,
} from "../ipc.js";
import { Avatar, AvatarGlyph } from "../components/Avatar.jsx";
import { HexColorPicker } from "../components/HexColorPicker.jsx";

const DESC_MIN = 1;

// Build the editor's initial field state from an agent (or null = new). Mirrors openEditor().
function initFields(agent) {
  return {
    name: agent ? (agent.name || "") : "",
    description: agent ? (agent.description || "") : "",
    cwd: agent ? (agent.cwd || "") : "",
    session_id: agent ? (agent.session_id || "") : "",
    color: agent ? (agent.color || "") : randomPaletteColor(),
    cleanup: agent ? (agent.text_cleanup !== false) : false,
    dictation_options: agent ? (agent.dictation_options || []) : [],
    esc: agent ? (agent.esc_before_send !== false) : false,
    esc_delay_ms: agent && Number.isFinite(agent.esc_delay_ms) ? agent.esc_delay_ms : 50,
    notes: agent ? (agent.notes || "") : "",
    group_id: agent ? (agent.group_id || "") : "",
    system_id: agent ? (agent.system_id || "") : "",
    active: agent ? (agent.active !== false) : true,
    program: agent ? (agent.program || "claude") : "claude",
  };
}

export function AgentEditor({ editingId, onClose, onSaved }) {
  const agents = useStore((s) => s.agents);
  const livePaneIds = useStore((s) => s.livePaneIds);
  const dictationAvailable = useStore((s) => s.dictationAvailable);
  const refreshAgents = useStore((s) => s.refreshAgents);
  const bumpAvatar = () => useStore.setState((s) => ({ avatarBust: s.avatarBust + 1 }));

  const editing = editingId ? agents.find((x) => x.id === editingId) : null;
  const [f, setF] = useState(() => initFields(editing));
  const upd = (patch) => setF((cur) => ({ ...cur, ...patch }));

  const [subtab, setSubtab] = useState("general");
  const [editorMsg, setEditorMsg] = useState("");
  const [sessionRO, setSessionRO] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);

  const [programs, setPrograms] = useState([]);
  const [groups, setGroups] = useState([]);
  const [systems, setSystems] = useState([]);
  const [catalog, setCatalog] = useState([]);

  const [newGroup, setNewGroup] = useState(null); // null = hidden; string = field value
  const [newSystem, setNewSystem] = useState(null);

  // Re-init when the editing target changes (e.g. after a clone jumps into the copy).
  useEffect(() => { setF(initFields(editing)); setSubtab("general"); setEditorMsg(""); setSessionRO(true); }, [editingId]);

  // Load catalogs once on open.
  useEffect(() => {
    let live = true;
    (async () => {
      const [p, g, sy, cat] = await Promise.all([
        tester.agentPrograms(), tester.groupsList(), tester.systemsList(), tester.dictationOptionsCatalog(),
      ]);
      if (!live) return;
      setPrograms(p || []); setGroups(g || []); setSystems(sy || []); setCatalog(cat || []);
    })();
    return () => { live = false; };
  }, []);

  // Dictation tab is hidden when unavailable; if it was active, fall back to General.
  useEffect(() => {
    if (!dictationAvailable && subtab === "dictation") setSubtab("general");
  }, [dictationAvailable, subtab]);

  // ── save ──
  async function saveAgentFromEditor() {
    const name = f.name.trim();
    const session = f.session_id.trim();
    if (!name) return { ok: false, error: "Name is required.", field: "name" };
    if (session && !isUuid(session)) return { ok: false, error: "Claude session must be a valid UUID, or left blank.", field: "session" };
    const a = {
      id: editingId, name, description: f.description.trim(), program: f.program, cwd: f.cwd.trim(),
      session_id: session, color: f.color.trim(), text_cleanup: f.cleanup,
      dictation_options: f.dictation_options,
      esc_before_send: f.esc, esc_delay_ms: parseInt(f.esc_delay_ms, 10) || 50,
      group_id: f.group_id, system_id: f.system_id, active: f.active, notes: f.notes.trim(),
    };
    const saved = await tester.agentsSave(a);
    if (saved && saved.ok === false) return { ok: false, error: saved.error || "Could not save." };
    const created = (!editingId && Array.isArray(saved)) ? (saved.find((x) => x.name === name) || null) : null;
    return { ok: true, saved, created };
  }

  async function onSave() {
    setEditorMsg("");
    const res = await saveAgentFromEditor();
    if (!res.ok) {
      setEditorMsg(res.error);
      if (res.field === "session") setSessionRO(false);
      return;
    }
    onSaved && onSaved(res.created);
  }

  async function onClone() {
    if (!editingId) return;
    const res = await tester.agentsClone(editingId);
    if (!res.ok) return;
    setMenuOpen(false);
    await refreshAgents();
    onSaved && onSaved(null, res.agent.id); // jump into the copy
  }
  async function onDelete() {
    if (!editingId) return;
    const a = agents.find((x) => x.id === editingId);
    if (!confirm(`Delete agent "${a ? a.name : editingId}"?\n\nThis removes the agent from your list. (Its Claude transcript on disk is not deleted.)`)) return;
    await tester.agentsDelete(editingId);
    onClose();
  }

  // ── inline group/system create ──
  async function addGroupInline() {
    if (newGroup === null) { setNewGroup(""); return; }
    const name = newGroup.trim();
    if (!name) { setNewGroup(null); return; }
    const saved = await tester.groupsSave({ name });
    const created = Array.isArray(saved) ? saved.find((g) => g.name === name) : null;
    const list = await tester.groupsList();
    setGroups(list || []);
    setNewGroup(null);
    if (created) upd({ group_id: created.id });
  }
  async function addSystemInline() {
    if (newSystem === null) { setNewSystem(""); return; }
    const name = newSystem.trim();
    if (!name) { setNewSystem(null); return; }
    const created = await tester.systemsAdd(name);
    const list = await tester.systemsList();
    setSystems(list || []);
    setNewSystem(null);
    if (created && created.id) upd({ system_id: created.id });
  }

  const descLen = f.description.trim().length;
  const descOk = descLen >= DESC_MIN;

  const subtabs = [
    { id: "general", label: "General" },
    { id: "advanced", label: "Agent Settings" },
    { id: "diagnostics", label: "Diagnostics" },
    ...(dictationAvailable ? [{ id: "dictation", label: "Dictation" }] : []),
  ];

  const headStatus = (() => {
    if (!editing) return <span className="badge stop">new agent</span>;
    const run = editing.pane_id && livePaneIds.includes(editing.pane_id);
    return (
      <>
        {run
          ? <span className="badge run">running · pane {editing.pane_id}</span>
          : <span className="badge stop">stopped</span>}
        {"   "}
        {editing.session_id ? "session " + editing.session_id.slice(0, 8) + "…" : "no session"}
        {"  ·  "}
        {editing.cwd ? editing.cwd : "~/workspace"}
      </>
    );
  })();

  return (
    <div id="agent-editor" className="agent-editor" style={{ display: "flex" }}>
      <div className="ed-head">
        <div className="ed-avatar-wrap">
          {editing ? <Avatar agent={editing} size={72} /> : <AvatarGlyph color={f.color} size={72} />}
          {editing ? (
            <button className="av-edit" title="Regenerate avatar" type="button" onClick={() => setRegenOpen(true)}>✎</button>
          ) : null}
        </div>
        <div className="ed-head-text">
          <div className="ed-name">{editing ? (editing.name || "(unnamed)") : "New agent"}</div>
          <div className="ed-status">{headStatus}</div>
        </div>
        {editing ? (
          <div className={"ed-menu" + (menuOpen ? " open" : "")} id="agent-menu">
            <button className="ed-menu-btn" type="button" title="More actions" aria-haspopup="true"
              onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}>⋮</button>
            <div className="ed-menu-pop">
              <button type="button" onClick={onClone}>Clone agent</button>
              <button type="button" className="danger-item" onClick={onDelete}>Delete agent</button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="subtabs" id="agent-subtabs">
        {subtabs.map((t) => (
          <button key={t.id} className={"subtab" + (subtab === t.id ? " active" : "")} type="button"
            onClick={() => setSubtab(t.id)}>{t.label}</button>
        ))}
      </div>

      <div className="ed-body">
        {subtab === "general" && (
          <div className="subpanel active">
            <div className="row"><label>Name</label>
              <input type="text" placeholder="e.g. Backend agent" style={{ flex: 1 }}
                value={f.name} onChange={(e) => upd({ name: e.target.value })} /></div>
            <div className="row" style={{ alignItems: "flex-start" }}><label>Description</label>
              <div style={{ flex: 1 }}>
                <textarea rows={3} style={{ width: "100%", resize: "vertical" }}
                  placeholder="What does this agent do? A sentence or two about its job and personality — the more you give it, the more it comes to life."
                  value={f.description} onChange={(e) => upd({ description: e.target.value })} />
                <div className="hint" style={descOk && descLen > 0 ? { color: "#38a169" } : {}}>
                  {descLen === 0 ? "Optional — a line or two gives your agent more personality." : "✓ looks good."}
                </div>
              </div>
            </div>
            <div className="row"><label>Group</label>
              <select style={{ flex: "0 1 320px" }} value={f.group_id} onChange={(e) => upd({ group_id: e.target.value })}>
                <option value="">Default</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}{g.active === false ? " (inactive)" : ""}</option>)}
              </select>
              {newGroup !== null && (
                <input type="text" placeholder="New group name" style={{ flex: "0 1 200px" }} autoFocus
                  value={newGroup} onChange={(e) => setNewGroup(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addGroupInline(); } }} />
              )}
              <button className="secondary" type="button" onClick={addGroupInline}>{newGroup === null ? "＋ New" : "Create"}</button>
            </div>
            <div className="row"><label>System</label>
              <select style={{ flex: "0 1 320px" }} value={f.system_id} onChange={(e) => upd({ system_id: e.target.value })}>
                <option value="">Default</option>
                {systems.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {newSystem !== null && (
                <input type="text" placeholder="New system name" style={{ flex: "0 1 200px" }} autoFocus
                  value={newSystem} onChange={(e) => setNewSystem(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSystemInline(); } }} />
              )}
              <button className="secondary" type="button" onClick={addSystemInline}>{newSystem === null ? "＋ New" : "Create"}</button>
            </div>
            <div className="row"><label>Active</label>
              <label className="chk"><input type="checkbox" checked={f.active} onChange={(e) => upd({ active: e.target.checked })} /> Show this agent in the Agent Arcade (off = hidden there, still editable here)</label>
            </div>
            <div className="row"><label>Working dir</label>
              <input type="text" placeholder="~/workspace (default)" style={{ flex: 1 }}
                value={f.cwd} onChange={(e) => upd({ cwd: e.target.value })} /></div>
            <div className="row" style={{ alignItems: "flex-start" }}><label>Color</label>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
                <HexColorPicker value={f.color} onChange={(v) => upd({ color: v })} />
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="swatch" style={{ background: f.color || "transparent" }} />
                  <input type="text" placeholder="#rrggbb" style={{ width: 120 }}
                    value={f.color} onChange={(e) => upd({ color: e.target.value })} />
                  <button className="secondary" type="button" onClick={() => upd({ color: randomPaletteColor() })}>Random</button>
                </div>
              </div>
            </div>
            <div className="row"><label>Notes</label>
              <input type="text" placeholder="optional" style={{ flex: 1 }}
                value={f.notes} onChange={(e) => upd({ notes: e.target.value })} /></div>
          </div>
        )}

        {subtab === "dictation" && (
          <div className="subpanel active">
            <label className="dict-master">
              <span className="switch"><input type="checkbox" checked={f.cleanup} onChange={(e) => upd({ cleanup: e.target.checked })} /><span className="slider" /></span>
              <span className="dm-text">
                <span className="dm-title">Clean dictation with the AI layer</span>
                <span className="dm-sub">Off = raw transcription only (faster). On = tidy it up and apply the options below.</span>
              </span>
            </label>
            <div>
              <div className="dict-sec">Cleanup options</div>
              <div className={"dict-opts" + (f.cleanup ? "" : " disabled")}>
                {catalog.map((o) => {
                  const checked = f.dictation_options.includes(o.key);
                  return (
                    <label key={o.key} className="dopt">
                      <input type="checkbox" checked={checked} disabled={!f.cleanup}
                        onChange={(e) => upd({
                          dictation_options: e.target.checked
                            ? [...f.dictation_options, o.key]
                            : f.dictation_options.filter((k) => k !== o.key),
                        })} />
                      <span className="dbox">✓</span>
                      <span className="dopt-text"><b>{o.label}</b> <span className="hint">— {o.desc}</span></span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {subtab === "advanced" && (
          <div className="subpanel active">
            <div className="row"><label>Agent</label>
              <select style={{ flex: "0 1 320px" }} value={f.program} onChange={(e) => upd({ program: e.target.value })}>
                {programs.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </div>
            <div className="row"><label>Claude session</label>
              <input type="text" readOnly={sessionRO} placeholder="(assigned on first launch)" style={{ flex: 1 }}
                value={f.session_id} onChange={(e) => upd({ session_id: e.target.value })} />
              <button className="ghost" title="Edit the session UUID (advanced)" onClick={() => setSessionRO((r) => !r)}>{sessionRO ? "Edit" : "Lock"}</button>
            </div>
            <div className="row"><label></label><span className="hint">Auto-managed UUID. Leave blank for a fresh session; only edit to resume a specific Claude session.</span></div>
            <div className="row"><label>Esc before send</label>
              <label className="chk"><input type="checkbox" checked={f.esc} onChange={(e) => upd({ esc: e.target.checked })} /> Press Esc once before sending (clears Claude menus/prompts)</label>
              <input type="number" min="0" step="10" style={{ width: 90 }} title="settle delay (ms)"
                value={f.esc_delay_ms} onChange={(e) => upd({ esc_delay_ms: e.target.value })} />
              <span className="hint">ms settle</span>
            </div>
          </div>
        )}

        {subtab === "diagnostics" && <Diagnostics editing={editing} />}
      </div>

      {editorMsg ? <div id="agent-editor-msg" style={{ minHeight: 16, fontSize: 12.5, color: "#e53e3e" }}>{editorMsg}</div> : <div style={{ minHeight: 16 }} />}
      <div className="ed-foot">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button onClick={onSave}>Save</button>
      </div>

      {regenOpen && <RegenModal editing={editing} color={f.color} description={f.description}
        descOk={descOk} onClose={() => setRegenOpen(false)} onDone={async () => { bumpAvatar(); await refreshAgents(); }} />}
    </div>
  );
}

// ── Diagnostics tab: status, launch/pop-out, recovery drawer, dictate, live terminal ──
function Diagnostics({ editing }) {
  const livePaneIds = useStore((s) => s.livePaneIds);
  const dictationAvailable = useStore((s) => s.dictationAvailable);
  const refreshAgents = useStore((s) => s.refreshAgents);
  const agents = useStore((s) => s.agents);

  const a = editing ? agents.find((x) => x.id === editing.id) : null;
  const run = a && a.pane_id && livePaneIds.includes(a.pane_id);

  const [msg, setMsg] = useState("");
  const [msgErr, setMsgErr] = useState(false);
  const [termHidden, setTermHidden] = useState(localStorage.getItem("aa_term_hidden") !== "0");
  const [termText, setTermText] = useState("");
  const [recording, setRecording] = useState(false);
  const termRef = useRef(null);
  const setDetailMsg = (t, err) => { setMsg(t || ""); setMsgErr(!!err); };

  // dictate result feedback (main routes the cleaned text; result/error tagged w/ agentId)
  useEffect(() => {
    if (!tester.onEvent) return;
    tester.onEvent((m) => {
      if (!m || !m.agentId || !a || m.agentId !== a.id) return;
      if (m.type === "result") setDetailMsg(m.text ? "✓ sent" : "no speech detected");
      else if (m.type === "error") setDetailMsg(m.error || "send failed", true);
    });
  }, [a && a.id]);

  // live terminal poll while open + revealed
  useEffect(() => {
    if (!a || !run || termHidden) return;
    let live = true;
    const refresh = async () => {
      const res = await tester.agentsGetText(a.id);
      if (!live || !res || !res.ok) return;
      setTermText((res.text || "").replace(/\s+$/, ""));
    };
    refresh();
    const id = setInterval(refresh, 2500);
    return () => { live = false; clearInterval(id); };
  }, [a && a.id, run, termHidden]);

  useEffect(() => {
    const out = termRef.current;
    if (out) out.scrollTop = out.scrollHeight;
  }, [termText]);

  if (!a) {
    return (
      <div className="subpanel active">
        <div className="detail-status">Save this agent first to launch it and see diagnostics.</div>
        <div className="detail-actions" />
      </div>
    );
  }

  async function act(action) {
    if (action === "launch") {
      setDetailMsg("starting…");
      const res = await tester.agentsLaunch(a.id);
      setDetailMsg(res.ok ? `${res.mode === "resume" ? "resumed" : "launched"} → pane ${res.agent.pane_id}` : `launch failed: ${res.error}`, !res.ok);
    } else if (action === "popout") {
      setDetailMsg("popping out terminal…");
      const res = await tester.agentsPopOut(a.id);
      if (res && res.ok) setDetailMsg(res.warning || "popped out", !!res.warning);
      else setDetailMsg(`pop-out failed: ${res && res.error}`, true);
    } else if (action === "kill") {
      const res = await tester.agentsKill(a.id);
      setDetailMsg(res.ok ? "killed (session kept)" : `kill failed: ${res.error}`, !res.ok);
    } else if (action === "esc") {
      const res = await tester.agentsSendEsc(a.id);
      setDetailMsg(res.ok ? "sent Esc" : `esc failed: ${res.error}`, !res.ok);
      return;
    }
    await refreshAgents();
  }

  async function dictateStart() {
    if (recording) return;
    try { await startCapture(); setRecording(true); setDetailMsg("recording — ⌘D to send, Esc to cancel"); }
    catch (err) { setDetailMsg("mic error: " + err.message, true); }
  }
  function dictateCancel() {
    if (!recording) return;
    try { stopCapture(); } catch {}
    setRecording(false); setDetailMsg("cancelled");
  }
  async function dictateSend() {
    if (!recording) return;
    setRecording(false);
    const { samples, rate } = stopCapture();
    if (!samples.length) { setDetailMsg("no audio captured", true); return; }
    setDetailMsg("sending…");
    const res = await tester.dictate(a.id, encodeWav(samples, rate));
    if (res && res.ok === false) setDetailMsg(res.error || "send failed", true);
  }

  // ⌘D start/send, Esc cancel — only on the Diagnostics tab.
  useEffect(() => {
    const onKey = (e) => {
      if (e.repeat) return;
      if (dictationAvailable && e.metaKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        if (recording) dictateSend(); else dictateStart();
      } else if (e.key === "Escape" && recording) {
        e.preventDefault(); dictateCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [recording, dictationAvailable]);

  return (
    <div className="subpanel active">
      <div className="detail-status">
        {run ? <span className="badge run">running · pane {a.pane_id}</span> : <span className="badge stop">stopped</span>}
        {"   "}
        {a.session_id ? "session " + a.session_id.slice(0, 8) + "…" : "no session"}
        {"  ·  "}
        {a.cwd ? a.cwd : "~/workspace"}
      </div>
      <div className="disp-actions">
        <div className="disp-act-row">
          <span className="disp-act-icon">{run ? "⤢" : "▶"}</span>
          <div className="disp-act-main">
            <div className="disp-act-name">{run ? "Pop out terminal" : (a.session_id ? "Resume agent" : "Launch agent")}</div>
            <div className="disp-act-sub">{run
              ? "Open this agent’s terminal in its own WezTerm window."
              : (a.session_id ? "Resume the saved session in a new pane." : "Start this agent in a new pane.")}</div>
          </div>
          <div className="disp-act-trail">
            {run
              ? <button className="disp-act-btn" onClick={() => act("popout")}>Pop out</button>
              : <button className="disp-act-btn" onClick={() => act("launch")}>{a.session_id ? "Resume" : "Launch"}</button>}
          </div>
        </div>

        {dictationAvailable && (
          <div className="disp-act-row">
            <span className="disp-act-icon">🎙</span>
            <div className="disp-act-main">
              <div className="disp-act-name">{recording ? <><span className="pulse" /> Recording…</> : "Dictate (⌘D)"}</div>
              <div className="disp-act-sub">{recording ? "⌘D to send · Esc to cancel." : "Speak a message — transcribed and sent to this agent."}</div>
            </div>
            <div className="disp-act-trail">
              {recording
                ? <>
                    <button className="disp-act-btn" onClick={dictateCancel}>Cancel</button>
                    <button className="disp-act-btn" onClick={dictateSend}>Send ▶</button>
                  </>
                : <button className="disp-act-btn" onClick={dictateStart}>Dictate</button>}
            </div>
          </div>
        )}

        {run && (
          <>
            <div className="disp-act-row">
              <span className="disp-act-icon">⎋</span>
              <div className="disp-act-main">
                <div className="disp-act-name">Send Esc</div>
                <div className="disp-act-sub">Send an Escape keypress to the agent’s terminal.</div>
              </div>
              <div className="disp-act-trail">
                <button className="disp-act-btn" onClick={() => act("esc")}>Send Esc</button>
              </div>
            </div>

            <div className="disp-act-row">
              <span className="disp-act-icon">⨯</span>
              <div className="disp-act-main">
                <div className="disp-act-name">Kill process</div>
                <div className="disp-act-sub">Stop the running process — the session is kept and can be resumed.</div>
              </div>
              <div className="disp-act-trail">
                <button className="disp-act-btn danger" onClick={() => act("kill")}>Kill</button>
              </div>
            </div>
          </>
        )}
      </div>
      <div className="hint" style={{ minHeight: 16, color: msgErr ? "#e53e3e" : "" }}>{msg}</div>

      {run && (
        <div style={{ marginTop: 8 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="hint">Terminal output (live)</span>
            <button className="ghost" type="button" onClick={() => {
              const next = !termHidden;
              setTermHidden(next);
              localStorage.setItem("aa_term_hidden", next ? "1" : "0");
            }}>{termHidden ? "Show" : "Hide"}</button>
          </div>
          {!termHidden && <pre id="term-out" ref={termRef}>{termText}</pre>}
        </div>
      )}
    </div>
  );
}

// ── Avatar Regenerate modal ──
function RegenModal({ editing, color, description, descOk, onClose, onDone }) {
  const [msg, setMsg] = useState("Generates a fresh avatar from this agent's description.");
  const [msgErr, setMsgErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = editing && editing.avatar_status === "ready";

  async function go() {
    const desc = (description || "").trim();
    if (desc.length < 1) { setMsg("Add a description first."); setMsgErr(true); return; }
    setBusy(true); setMsg("Generating avatar…"); setMsgErr(false);
    await tester.agentsSave({ id: editing.id, description: desc, color: (color || "").trim() });
    const r = await tester.agentsGenerateAvatar(editing.id);
    setBusy(false);
    if (r && r.ok) { await onDone(); onClose(); }
    else { setMsg("Generation failed: " + ((r && r.error) || "unknown error")); setMsgErr(true); }
  }

  return (
    <div className="modal-backdrop on" onClick={(e) => { if (e.target.classList.contains("modal-backdrop")) onClose(); }}>
      <div className="modal-card">
        <Avatar agent={editing} size={130} />
        <div style={{ fontWeight: 700 }}>{ready ? "Regenerate avatar?" : "Generate avatar?"}</div>
        <div className="hint" style={{ color: msgErr ? "#e53e3e" : "" }}>{msg}</div>
        <div className="row" style={{ justifyContent: "center", gap: 10 }}>
          <button type="button" disabled={busy || !descOk} onClick={go}>🎨 Regenerate</button>
          <button className="ghost" type="button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
