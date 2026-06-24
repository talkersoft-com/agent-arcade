// IPC → XState seam. THE ONLY place a raw window.arcade.* push becomes an XState
// event (per docs/IPC.md §0). Components never touch ipc or a machine directly:
//   - state TRANSITIONS  → arcade.send({...})  (XState)
//   - ambient SIGNALS    → bus.emit(...)       (mitt: toasts, "agents changed")
//
// This module also owns the data-load loop (initial + 4s poll + focus refresh),
// translating each load into a single DATA event.
//
// Phase 0004 binds: data reads (agents/systems/groups/commands), onStatus, focus
// refresh. onDictationEvent / onDictation are bound as NO-OP seams here so the wiring
// structure exists for Phase 0005 (dictation) to slot its machine in without rework —
// each raw push still arrives at exactly one translate site.
import { bus } from "./bus.js";

const arcade = window.arcade || {};

// Load the full data snapshot and translate it into one DATA event. Mirrors the
// reference loadData()'s Promise.all over the read-only arcade:* channels.
export async function loadData(send) {
  try {
    const [systems, agents, groups, commands] = await Promise.all([
      safe(arcade.systems, []),
      safe(arcade.agents, []),
      safe(arcade.groups, []),
      safe(arcade.commands, []),
    ]);
    send({ type: "DATA", data: { systems, agents, groups, commands } });
    bus.emit("agents:changed");
  } catch (e) {
    bus.emit("toast", { text: "Failed to load agents: " + (e && e.message), kind: "error" });
  }
}

function safe(fn, fallback) {
  try { return fn ? Promise.resolve(fn()).catch(() => fallback) : Promise.resolve(fallback); }
  catch { return Promise.resolve(fallback); }
}

// Wire every main → renderer push to its single translate site. Called once at boot.
export function wireIpc(send) {
  // STATUS (legacy translated channel + local non-Go status). Routes to the owning
  // per-agent actor as a STATUS.SET, and emits an ambient msg toast when carried.
  if (arcade.onStatus) {
    arcade.onStatus((s) => {
      if (!s) return;
      if (s.agentId) {
        send({ type: "ENSURE_ACTOR", id: s.agentId });
        send({ type: "STATUS", agentId: s.agentId, state: s.state, msg: s.msg });
      }
      if (s.msg) bus.emit("toast", { text: s.msg, kind: s.state === "error" ? "error" : "info" });
    });
  }

  // Esc is eaten by macOS for the fullscreen window, so main routes it via a menu
  // accelerator. Translate it to a single ESCAPE event the keyboard layer's handler
  // consumes (kept here so it shares the one-translate-site rule).
  if (arcade.onEsc) arcade.onEsc(() => bus.emit("escape"));

  // ── seams reserved for later phases — bound now so the structure exists ──
  // Phase 0005 (dictation): onDictationEvent (raw Go NDJSON) + onDictation (gate).
  // Each push is translated ONCE here into a machine event when 0005 lands. For now
  // we forward as ambient notifications only (no machine owns them yet).
  if (arcade.onDictationEvent) arcade.onDictationEvent((p) => bus.emit("dictation:event", p));
  if (arcade.onDictation) arcade.onDictation((p) => bus.emit("dictation:available", p));
  // Phase 0006 (workspace shell): onShellData / onShellExit translate here.
  if (arcade.onShellData) arcade.onShellData((p) => bus.emit("shell:data", p));
  if (arcade.onShellExit) arcade.onShellExit((p) => bus.emit("shell:exit", p));
}

// Start the load loop: initial load, 4s poll, and a reload on window focus (so a new
// agent created in Studio appears immediately). Mirrors the reference's cadence.
export function startDataLoop(send) {
  loadData(send);
  setInterval(() => loadData(send), 4000);
  window.addEventListener("focus", () => loadData(send));
}
