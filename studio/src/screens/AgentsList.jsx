import React, { useRef } from "react";
import { useStore } from "../store.js";
import { tester } from "../ipc.js";
import { Avatar } from "../components/Avatar.jsx";

// Agents grid (cards) with drag-and-drop reorder + slick empty state. Mirrors the
// reference renderCards()/DnD handlers.
export function AgentsList({ onOpenEditor }) {
  const agents = useStore((s) => s.agents);
  const livePaneIds = useStore((s) => s.livePaneIds);
  const groupsById = useStore((s) => s.groupsById);
  const dictationAvailable = useStore((s) => s.dictationAvailable);
  const refreshAgents = useStore((s) => s.refreshAgents);

  const dragId = useRef(null);
  const justDragged = useRef(false);

  const isRunning = (a) => a.pane_id && livePaneIds.includes(a.pane_id);
  const empty = !agents.length;

  function clearDropIndicator(container) {
    container.querySelectorAll(".agent-card.drop-before, .agent-card.drop-after")
      .forEach((el) => el.classList.remove("drop-before", "drop-after"));
  }

  function onDragStart(e) {
    const card = e.target.closest(".agent-card");
    if (!card) return;
    dragId.current = card.dataset.id;
    card.classList.add("dragging");
    try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId.current); } catch {}
  }
  function onDragOver(e) {
    if (dragId.current == null) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "move"; } catch {}
    const container = e.currentTarget;
    const over = e.target.closest(".agent-card");
    clearDropIndicator(container);
    if (!over || over.dataset.id === dragId.current) return;
    const r = over.getBoundingClientRect();
    const before = e.clientX < r.left + r.width / 2;
    over.classList.add(before ? "drop-before" : "drop-after");
  }
  async function onDrop(e) {
    if (dragId.current == null) return;
    e.preventDefault();
    const container = e.currentTarget;
    const over = e.target.closest(".agent-card");
    const order = agents.map((a) => a.id);
    const from = order.indexOf(dragId.current);
    if (from < 0) { clearDropIndicator(container); return; }
    order.splice(from, 1);
    let to = order.length;
    if (over && over.dataset.id !== dragId.current) {
      const r = over.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      let idx = order.indexOf(over.dataset.id);
      if (idx < 0) idx = order.length;
      to = before ? idx : idx + 1;
    }
    order.splice(to, 0, dragId.current);
    clearDropIndicator(container);
    justDragged.current = true;
    await tester.agentsReorder(order);
    await refreshAgents();
  }
  function onDragEnd(e) {
    const d = e.currentTarget.querySelector(".agent-card.dragging");
    if (d) d.classList.remove("dragging");
    clearDropIndicator(e.currentTarget);
    dragId.current = null;
  }
  function onClick(e) {
    if (justDragged.current) { justDragged.current = false; return; }
    const card = e.target.closest(".agent-card");
    if (card) onOpenEditor(agents.find((x) => x.id === card.dataset.id) || null);
  }

  return (
    <div id="agents-list-panel">
      <div className="agents-header">
        <button id="agent-new" title="Add a new agent" onClick={() => onOpenEditor(null)}>
          <span className="na-plus">+</span><span>New agent</span>
        </button>
      </div>

      <div
        id="agents-cards"
        className="agent-cards"
        style={{ display: empty ? "none" : "grid" }}
        onClick={onClick}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
      >
        {agents.map((a) => {
          const grp = a.group_id && groupsById[a.group_id] ? groupsById[a.group_id].name : "Default";
          const c = a.color || "#888888";
          return (
            <div
              key={a.id}
              className="agent-card"
              draggable
              data-id={a.id}
              style={{ borderTop: `3px solid ${c}`, ...(a.active === false ? { opacity: 0.55 } : {}) }}
            >
              <Avatar agent={a} size={64} />
              <div className="ac-name">{a.name || "(unnamed)"}</div>
              <div className="ac-badges">
                {isRunning(a)
                  ? <span className="badge run">running</span>
                  : <span className="badge stop">stopped</span>}
                {a.active === false ? <> <span className="badge stop">hidden</span></> : null}
              </div>
              <div className="ac-sub">
                {grp} · {a.program ? a.program + " · " : ""}
                {a.session_id ? "session " + a.session_id.slice(0, 8) + "…" : "no session"}
              </div>
            </div>
          );
        })}
      </div>

      <div id="agents-empty" className="agents-empty" style={{ display: empty ? "flex" : "none" }}>
        <div className="ae-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-5 0-9 2.6-9 6v2h18v-2c0-3.4-4-6-9-6z" />
          </svg>
        </div>
        <div className="ae-title">No agents yet</div>
        <div className="ae-sub" id="agents-empty-sub">
          {dictationAvailable
            ? "Add your first agent to start dictating to it — give it a name, a working folder, and a color."
            : "Add your first agent — give it a name, a working folder, and a color."}
        </div>
        <button id="agents-empty-new" className="ae-cta" onClick={() => onOpenEditor(null)}>+ New agent</button>
      </div>
    </div>
  );
}
