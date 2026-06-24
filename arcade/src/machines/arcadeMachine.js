// Root Arcade machine (XState v5). Owns:
//   - top-level mode: rail ⇄ agent view (the navigation region, with guards)
//   - the data snapshot {agents, systems, groups, commands, filterSystemId, loaded}
//   - rail selection {selG, sel} and the focused agent {focusId}
//   - a MAP of spawned per-agent actors (context.agentActors), one per visited
//     agent, each holding that agent's durable draft + view sub-state.
//
// Components NEVER touch this machine directly other than through send() at the
// composition root (main.js wires keyboard → events, and the render layer
// subscribes). The IPC seam (ipc.js) is the only translator of raw IPC → events.
//
// Phase 0004 scope: rail + agent view + ⌘←/→ switching + durable drafts. Terminal /
// sync / shell / dictation are 0005/0006 — events for them are NOT defined here yet;
// the keyboard layer routes those keys to clearly-marked stubs.
import { createMachine, assign } from "xstate";
import { agentMachine } from "./agentActor.js";
import { buildRail, railAgentAt, locateAgent, neighborInGroup } from "../railModel.js";

// ── helpers over context (pure) ──
function rail(ctx) {
  return buildRail(ctx.agents, ctx.groups, ctx.filterSystemId);
}
// Clamp {selG, sel} into the current rail so a data refresh that removed groups/
// agents can't strand the selection (mirrors render()'s in-range guard).
function clampSel(ctx) {
  const m = rail(ctx);
  let selG = ctx.selG, sel = ctx.sel;
  if (selG >= m.groups.length) selG = m.groups.length - 1;
  if (selG < 0) selG = 0;
  const len = m.groups[selG] ? m.groups[selG].agents.length : 0;
  if (sel >= len) sel = Math.max(0, len - 1);
  if (sel < 0) sel = 0;
  return { selG, sel };
}

export const arcadeMachine = createMachine({
  id: "arcade",
  initial: "rail",
  context: {
    agents: [],
    systems: [],
    groups: [],
    commands: [],
    filterSystemId: null,
    loaded: false,          // first load() done — gates the welcome orb (no boot flash)
    selG: 0,
    sel: 0,
    focusId: null,          // agent id while in agent view
    agentActors: {},        // id -> spawned per-agent actor (durable draft store)
  },
  states: {
    // ── AGENTS RAIL — always the top level / main menu ──
    rail: {
      on: {
        RAIL_MOVE: { actions: "railMove" },
        // Number-key jump (1–9) within the selected group.
        SELECT_INDEX: { actions: "selectIndex" },
        CYCLE_FILTER: { actions: "cycleFilter" },
        SET_FILTER: { actions: "setFilter" },
        // Open the selected agent → agent view. Guard: there must BE a selected agent
        // (empty rail / no agents → stay put).
        ENTER_AGENT: {
          target: "agent",
          guard: "hasSelection",
          actions: "focusSelected",
        },
      },
    },

    // ── AGENT VIEW (drill-in menu) ──
    agent: {
      on: {
        // ⌘←/→ switch to the prev/next agent IN THE SAME GROUP (clamped, no wrap).
        // Guard: a neighbour must exist (lone agent / at an end → no-op, stay).
        SWITCH_AGENT: {
          guard: "hasNeighbor",
          actions: "switchAgent",
        },
        // Esc / back → rail. focusId is kept aligned to the rail selection on the way
        // out so returning lands on the same agent.
        EXIT_TO_RAIL: { target: "rail", actions: "alignSelToFocus" },
      },
    },
  },

  // Global data refresh — applies in any state. Keeps the selection aligned to the
  // currently-focused (agent view) or selected (rail) agent across the refresh.
  on: {
    DATA: { actions: "applyData" },
    // Ensure a per-agent actor exists for an id (spawned lazily on first visit).
    ENSURE_ACTOR: { actions: "ensureActor" },
    // Fan a status push (from the IPC seam) into the owning per-agent actor.
    STATUS: { actions: "routeStatus" },
  },
}, {
  guards: {
    hasSelection: (a) => !!railAgentAt(rail(a.context), a.context.selG, a.context.sel),
    hasNeighbor: (a) =>
      !!neighborInGroup(rail(a.context), a.context.focusId, a.context.selG, a.event.dir),
  },
  actions: {
    // ── rail navigation ──
    railMove: assign(({ context, event }) => {
      const m = rail(context);
      if (!m.flat.length) return {};
      let { selG, sel } = context;
      const dG = event.dG || 0, dA = event.dA || 0;
      if (dA) { const len = m.groups[selG].agents.length; sel = Math.max(0, Math.min(len - 1, sel + dA)); }
      if (dG) {
        const ng = m.groups.length; const col = sel;
        selG = Math.max(0, Math.min(ng - 1, selG + dG));
        sel = Math.min(col, m.groups[selG].agents.length - 1);
      }
      return { selG, sel };
    }),
    selectIndex: assign(({ context, event }) => {
      const m = rail(context);
      const len = m.groups[context.selG] ? m.groups[context.selG].agents.length : 0;
      const n = event.index;
      return n >= 0 && n < len ? { sel: n } : {};
    }),
    cycleFilter: assign(({ context, event }) => {
      if (!context.systems.length) return {};
      const order = [null, ...context.systems.map((s) => s.id)];
      const i = order.indexOf(context.filterSystemId);
      const dir = event.dir || 1;
      return { filterSystemId: order[(i + dir + order.length) % order.length], selG: 0, sel: 0 };
    }),
    setFilter: assign(({ event }) => ({ filterSystemId: event.systemId || null, selG: 0, sel: 0 })),

    // ── enter / switch / exit ──
    focusSelected: assign(({ context, spawn, self }) => {
      const a = railAgentAt(rail(context), context.selG, context.sel);
      if (!a) return {};
      const actors = ensureSpawn(context.agentActors, a.id, spawn);
      // Park the focused agent's actor in "menu" on (re)entry; its draft is preserved.
      actors[a.id].send({ type: "MENU" });
      return { focusId: a.id, agentActors: actors };
    }),
    switchAgent: assign(({ context, event, spawn }) => {
      const a = neighborInGroup(rail(context), context.focusId, context.selG, event.dir);
      if (!a) return {};
      const loc = locateAgent(rail(context), a.id) || {};
      const actors = ensureSpawn(context.agentActors, a.id, spawn);
      actors[a.id].send({ type: "MENU" });
      return {
        focusId: a.id,
        selG: loc.selG != null ? loc.selG : context.selG,
        sel: loc.sel != null ? loc.sel : context.sel,
        agentActors: actors,
      };
    }),
    alignSelToFocus: assign(({ context }) => {
      const loc = locateAgent(rail(context), context.focusId);
      return loc ? { selG: loc.selG, sel: loc.sel, focusId: null } : { focusId: null };
    }),

    // ── lazy actor spawn ──
    ensureActor: assign(({ context, event, spawn }) => ({
      agentActors: ensureSpawn(context.agentActors, event.id, spawn),
    })),

    // Route a status push to the owning per-agent actor (spawned by ENSURE_ACTOR
    // first). Maps the channel's `state` onto the actor's STATUS.SET.
    routeStatus: ({ context, event }) => {
      const actor = context.agentActors[event.agentId];
      if (actor) actor.send({ type: "STATUS.SET", status: event.state });
    },

    // ── data refresh ──
    applyData: assign(({ context, event, spawn }) => {
      const d = event.data || {};
      const next = {
        agents: d.agents != null ? d.agents : context.agents,
        systems: d.systems != null ? d.systems : context.systems,
        groups: d.groups != null ? d.groups : context.groups,
        commands: d.commands != null ? d.commands : context.commands,
        loaded: true,
      };
      let filterSystemId = context.filterSystemId;
      // If the filtered system vanished / went inactive, fall back to All.
      if (filterSystemId && !next.systems.some((s) => s.id === filterSystemId && s.active !== false)) {
        filterSystemId = null;
      }
      const merged = { ...context, ...next, filterSystemId };
      // Keep selection aligned to the agent we were on (focused in agent view, else
      // the rail-selected one), then clamp into range.
      const anchorId = context.focusId || (() => {
        const a = railAgentAt(rail(context), context.selG, context.sel);
        return a && a.id;
      })();
      let selG = merged.selG, sel = merged.sel;
      const loc = anchorId && locateAgent(rail(merged), anchorId);
      if (loc) { selG = loc.selG; sel = loc.sel; }
      const clamped = clampSel({ ...merged, selG, sel });
      // Pre-spawn an actor for the focused agent so its draft survives refreshes even
      // before the user re-enters (idempotent).
      let agentActors = context.agentActors;
      if (context.focusId) agentActors = ensureSpawn(agentActors, context.focusId, spawn);
      return { ...next, filterSystemId, selG: clamped.selG, sel: clamped.sel, agentActors };
    }),
  },
});

// Spawn a per-agent actor on first visit; reuse it forever after (this is what makes
// the draft durable). Returns a (possibly new) actors map.
function ensureSpawn(actors, id, spawn) {
  if (!id || actors[id]) return actors;
  const actor = spawn(agentMachine, { id: "agent-" + id, input: { id }, syncSnapshot: true });
  return { ...actors, [id]: actor };
}
