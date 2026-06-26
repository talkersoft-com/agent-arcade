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
import { terminalMachine } from "./machines/terminalActor.js";
import { applyNotch, $ } from "./dom.js";
import { bus } from "./bus.js";
import { draw, setFocusedSnapshotGetter, setTerminalUpGetter } from "./render.js";
import { wireKeyboard, applyExitSettings } from "./keyboard.js";
import { wireToasts } from "./toast.js";
import { wireIpc, startDataLoop } from "./ipc.js";
import { setDictationHost, setDictationAvailable, applyDictationSettings } from "./dictation.js";
import {
  setTerminalHost, setTerminalActor, wireTerminal, renderTerm,
  terminalUp, shellDataWriter, shellExitWriter, setComposeSplit,
} from "./terminal.js";

function boot() {
  applyNotch();

  const arcade = createActor(arcadeMachine);

  // ── terminal region actor (Phase 0006) ──
  // ONE actor for the session, owning the terminal lifecycle (closed → peek → sync →
  // shell + the compose flag). The shell-push writers are PROVIDED here so the single
  // IPC translate site → SHELL.DATA/SHELL.EXIT events drive the machine, and the
  // machine's actions write to the live xterm (see terminal.js).
  const termActor = createActor(terminalMachine.provide({
    actions: { onShellData: ({ event }) => shellDataWriter(event), onShellExit: ({ event }) => shellExitWriter(event) },
  }));
  setTerminalActor(termActor);

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
  // subscription in step. When a terminal surface is up, also repaint its inside.
  arcade.subscribe((snap) => {
    syncFocusSubscription();
    draw(snap);
    if (terminalUp()) renderTerm();
  });

  // render.js asks the terminal actor "is a terminal surface up?" to route the
  // top-level container visibility (terminal replaces the agent menu).
  setTerminalUpGetter(() => terminalUp());

  // Terminal-actor subscription: any terminal transition repaints the root containers
  // (so agent-menu ⇄ terminal-view visibility flips) AND the terminal's own inside.
  termActor.subscribe(() => { draw(arcade.getSnapshot()); if (terminalUp()) renderTerm(); });

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

  // ── dictation host bridge ──
  // Lets the dictation manager reach the root machine: read the focused agent (to start
  // a recording on), and push per-agent dictation status onto the ORIGINATING agent's
  // actor (durable per-agent model — the status names that agent even after navigation).
  setDictationHost({
    focusedAgent: () => api.focusedAgent(),
    setAgentStatus: (agentId, status) => {
      if (!agentId) return;
      arcade.send({ type: "ENSURE_ACTOR", id: agentId });
      arcade.send({ type: "STATUS", agentId, state: status });
      // "delivered" is transient — settle back to idle (matches the reference's onStatus).
      if (status === "delivered") setTimeout(() => {
        const a = arcade.getSnapshot().context.agentActors[agentId];
        if (a && a.getSnapshot().context.status === "delivered") arcade.send({ type: "STATUS", agentId, state: "idle" });
      }, 1500);
    },
  });

  // ── terminal host bridge ──
  // Lets the terminal controller reach the root machine: the focused agent (to scrape /
  // shell / macro against), the @-command list, and a send() into the root machine (for
  // ⌘←/→ agent switching from the terminal peek).
  setTerminalHost({
    focusedAgent: () => api.focusedAgent(),
    commands: () => arcade.getSnapshot().context.commands,
    send: (e) => arcade.send(e),
    // The per-agent actor (durable draft store) — terminal.js reads/writes the
    // terminal-view prompt draft (termDraft) through this, replacing its old Map.
    actorFor: (id) => arcade.getSnapshot().context.agentActors[id] || null,
  });

  wireToasts();
  // Global recording indicator (bottom-right ● REC, every view): driven off the
  // dictation machine's state events. Visible whenever a recording is live.
  bus.on("dictation:state", ({ recording }) => {
    const el = $("rec-indicator"); if (el) el.classList.toggle("on", !!recording);
  });
  wireTerminal();          // macro-bar / prompt click + input handlers (Phase 0006)
  wireKeyboard(api);
  wireIpc((e) => arcade.send(e));

  arcade.start();
  termActor.start();
  startDataLoop((e) => arcade.send(e));

  // Seed dictation availability + timing/recordingNavBehavior from cached state, then
  // keep them live (onDictation push handled in the IPC seam; settings re-read on focus).
  (async () => {
    try { if (window.arcade && window.arcade.dictationGet) setDictationAvailable(await window.arcade.dictationGet()); } catch {}
    try {
      if (window.arcade && window.arcade.settings) {
        const st = await window.arcade.settings();
        applyDictationSettings(st);
        applyExitSettings(st);
        if (st && Number.isFinite(st.compose_split)) setComposeSplit(st.compose_split);
      }
    } catch {}
  })();
  window.addEventListener("focus", async () => {
    try { if (window.arcade && window.arcade.settings) { const st = await window.arcade.settings(); applyDictationSettings(st); applyExitSettings(st); } } catch {}
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
