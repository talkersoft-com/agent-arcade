import React, { useState } from "react";
import { useStore } from "../store.js";
import { AgentsList } from "./AgentsList.jsx";
import { AgentEditor } from "./AgentEditor.jsx";

// Agents view: list ↔ tabbed editor. Clicking a card opens the editor directly
// (there is no separate detail page — the editor IS the agent screen).
export function Agents() {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const [editing, setEditing] = useState(undefined); // undefined = list; null = new; id = edit

  function open(agent) { setEditing(agent ? agent.id : null); }
  async function close() { await refreshAgents(); setEditing(undefined); }

  // New-agent save with a description kicks off the first avatar generation in the
  // background; the card refreshes when it's ready (introGenerateAvatar).
  async function onSaved(created, jumpToId) {
    if (jumpToId) { await refreshAgents(); setEditing(jumpToId); return; } // clone → jump into copy
    await refreshAgents();
    setEditing(undefined);
    if (created && (created.description || "").trim().length >= 1) {
      const r = await (window.tester ? window.tester.agentsGenerateAvatar(created.id) : Promise.resolve());
      if (r && r.ok) { useStore.setState((s) => ({ avatarBust: s.avatarBust + 1 })); await refreshAgents(); }
    }
  }

  return (
    <div className="view active" id="view-agents">
      {editing === undefined
        ? <AgentsList onOpenEditor={open} />
        : <AgentEditor editingId={editing} onClose={close} onSaved={onSaved} />}
    </div>
  );
}
