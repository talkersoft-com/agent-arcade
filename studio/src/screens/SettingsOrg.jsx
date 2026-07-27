import React, { useState } from "react";
import { useStore } from "../store.js";
import { tester } from "../ipc.js";

// Shared management row used by both Systems and Groups (rename, active toggle,
// reorder ▲▼, delete-when-empty). Mirrors loadSystemsUI()/loadGroupsUI().
function MgmtList({ items, agents, idKey, list, reload, save, del, reorder, emptyHint, countOf }) {
  if (!items.length) return <div className="hint" dangerouslySetInnerHTML={{ __html: emptyHint }} />;
  const move = async (id, dir) => {
    const ids = items.map((x) => x.id);
    const idx = ids.indexOf(id), to = idx + dir;
    if (to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(idx, 1)[0]);
    await reorder(ids); reload();
  };
  return items.map((it, i) => {
    const n = countOf(it.id);
    return (
      <div className={"mgmt-row" + (it.active === false ? " inactive" : "")} key={it.id}>
        <input type="text" defaultValue={it.name}
          onBlur={async (e) => { const name = e.target.value.trim(); if (!name) { reload(); return; } await save({ id: it.id, name }); reload(); }}
          onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }} />
        <span className="mgmt-count">{n} agent{n === 1 ? "" : "s"}</span>
        <label className="switch-label">
          <span className="switch"><input type="checkbox" checked={it.active !== false}
            onChange={async (e) => { await save({ id: it.id, active: e.target.checked }); reload(); }} /><span className="slider" /></span> Active
        </label>
        <span className="mgmt-actions">
          <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => move(it.id, -1)}>▲</button>
          <button className="icon-btn" title="Move down" disabled={i === items.length - 1} onClick={() => move(it.id, 1)}>▼</button>
          <button className="del-btn" disabled={n > 0} title={n > 0 ? "Reassign its agents first" : ""}
            onClick={async () => {
              if (!confirm("Delete this " + (idKey === "sys" ? "system" : "group") + "?")) return;
              const res = await del(it.id);
              if (res && res.ok === false) alert(`Can't delete — ${res.count} agent${res.count === 1 ? " is" : "s are"} still tied. Reassign first.`);
              reload();
            }}>Delete</button>
        </span>
      </div>
    );
  });
}

export function SettingsOrg() {
  const groups = useStore((s) => s.groups);
  const agents = useStore((s) => s.agents);
  const loadOrg = useStore((s) => s.loadOrg);

  const [grpName, setGrpName] = useState("");

  const grpCount = (gid) => agents.filter((a) => (a.group_id || "") === gid).length;

  async function addGroup() {
    const name = grpName.trim(); if (!name) return;
    await tester.groupsSave({ name }); setGrpName(""); loadOrg();
  }

  return (
    <div className="panel active" style={{ overflow: "auto" }}>
      <div className="hint sgroup-intro">Menu groups</div>
      <div className="hint sgroup-intro">The sections agents appear under in the Agent Arcade menu. Agents with no group live in the built-in <b>Default</b>, and a group only shows when it has active agents in it. Which <i>machine</i> an agent runs on is decided by its workspace, managed on the web console.</div>
      <div className="row">
        <input type="text" placeholder="Group name — e.g. Research" style={{ flex: 1 }}
          value={grpName} onChange={(e) => setGrpName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addGroup(); } }} />
        <button onClick={addGroup}>Add group</button>
      </div>
      <div id="groups-list" style={{ marginTop: 14 }}>
        <MgmtList items={groups} agents={agents} idKey="grp" countOf={grpCount}
          reload={loadOrg} save={(g) => tester.groupsSave(g)} del={(id) => tester.groupsDelete(id)} reorder={(ids) => tester.groupsReorder(ids)}
          emptyHint='No groups yet — add one above. Agents stay in the built-in <b>Default</b> until you assign them.' />
      </div>
    </div>
  );
}
