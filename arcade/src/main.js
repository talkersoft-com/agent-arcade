// Arcade composition root — vanilla JS + XState + mitt, NO React.
//
// Topology:
//   root actor (arcadeMachine)
//     ├─ context.agentActors[id] : per-agent actor (agentMachine) — durable draft +
//     │                            per-agent view sub-state (one spawned per visit)
//     └─ subscribe → render.draw() (the subscribe(state)→DOM layer)
//   ipc.js  : the ONLY raw-IPC → XState translate site (+ data loop)
//   bus     : mitt notifications (toasts, "agents changed")
//   keyboard: keydown → machine/actor events (rail + agent view + ⌘←/→ + draft)
//
// The headline fix — durable per-agent draft — falls out of the topology: each
// agent's draft lives in its own actor's context, which survives navigation because
// the actor is spawned once and kept in the root's context map for the session.
import { createActor } from "xstate";
import { arcadeMachine } from "./machines/arcadeMachine.js";
import { applyNotch } from "./dom.js";
import { draw, setFocusedSnapshotGetter } from "./render.js";
import { wireKeyboard } from "./keyboard.js";
import { wireToasts } from "./toast.js";
import { wireIpc, startDataLoop } from "./ipc.js";

function boot() {
  applyNotch();

  const arcade = createActor(arcadeMachine);

  // ── focused per-agent actor tracking ──
  // We re-subscribe the render layer to whichever agent actor is currently focused, so
  // its draft/view/status changes repaint WITHOUT a root transition. render.js reads
  // the focused snapshot via this getter.
  let focusedId = null;
  let focusedUnsub = null;
  function focusedActor() {
    const ctx = arcade.getSnapshot().context;
    return focusedId ? ctx.agentActors[focusedId] : null;
  }
  setFocusedSnapshotGetter(() => {
    const a = focusedActor();
    return a ? a.getSnapshot() : null;
  });

  function syncFocusSubscription() {
    const snap = arcade.getSnapshot();
    const id = snap.matches("agent") ? snap.context.focusId : null;
    if (id === focusedId) return;
    if (focusedUnsub) { focusedUnsub(); focusedUnsub = null; }
    focusedId = id;
    const actor = id ? snap.context.agentActors[id] : null;
    if (actor) focusedUnsub = actor.subscribe(() => draw(arcade.getSnapshot())).unsubscribe;
  }

  // Root subscription: redraw on every transition, and keep the focused-actor
  // subscription in step.
  arcade.subscribe((snap) => {
    syncFocusSubscription();
    draw(snap);
  });

  // ── keyboard API surface (decouples keyboard.js from machine internals) ──
  const api = {
    send: (e) => arcade.send(e),
    ctx: () => arcade.getSnapshot().context,
    isMode: (m) => arcade.getSnapshot().matches(m),
    focusedActor,
    focusedAgent: () => {
      const ctx = arcade.getSnapshot().context;
      return ctx.agents.find((a) => a.id === ctx.focusId) || null;
    },
    repositionRail: () => draw(arcade.getSnapshot()),
  };

  wireToasts();
  wireKeyboard(api);
  wireIpc((e) => arcade.send(e));

  arcade.start();
  startDataLoop((e) => arcade.send(e));
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
