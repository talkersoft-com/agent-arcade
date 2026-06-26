// Per-agent actor — ONE spawned per agent the user has visited. It owns that
// agent's *durable* context that must survive navigating away and back:
//
//   - draft       : the unsent text in the agent-view type box (the headline fix —
//                   in the reference this lived in a single shared #av-input that was
//                   blanked on every enter/exit, so the draft was lost on navigation).
//   - view        : the per-agent agent-view sub-state ("menu" | "insert"). The
//                   terminal sub-states (peek/sync/shell/compose) are added in 0006;
//                   "insert" is the only interactive sub-state this phase ships.
//   - status      : last delivery status for this agent ("idle"|"sending"|
//                   "delivered"|"error") — pushed in via the IPC seam.
//
// Because the actor LIVES for the Arcade session (spawned once, kept in the root
// machine's context map), its `draft` persists no matter how the user navigates.
// Re-entering the agent reads draft straight back out of `actor.getSnapshot()`.
import { createMachine, assign } from "xstate";

export const agentMachine = createMachine({
  id: "agent",
  context: ({ input }) => ({
    id: input.id,
    draft: "",            // durable unsent type-box text (agent-view #av-input)
    termDraft: "",        // durable unsent terminal-view prompt text (#av-term-input)
    view: "menu",         // "menu" | "insert"
    status: "idle",       // last known delivery status
  }),
  on: {
    // Durable draft write — fired on every keystroke in the type box. This is the
    // ONLY place the draft is mutated; the render layer reads it back verbatim.
    "DRAFT.SET": { actions: assign({ draft: ({ event }) => event.draft }) },
    "DRAFT.CLEAR": { actions: assign({ draft: "" }) },

    // Terminal-view prompt draft — same durable-per-agent pattern as `draft`, but for
    // the terminal peek's prompt box. SET on every keystroke, CLEAR on a successful
    // send. APPEND inserts text on its own line (used by file drag-and-drop), with no
    // leading blank line when the prompt is empty.
    "TERM_DRAFT.SET": { actions: assign({ termDraft: ({ event }) => event.text }) },
    "TERM_DRAFT.CLEAR": { actions: assign({ termDraft: "" }) },
    "TERM_DRAFT.APPEND": {
      actions: assign({
        termDraft: ({ context, event }) => {
          const cur = context.termDraft || "";
          return cur + (cur && !cur.endsWith("\n") ? "\n" : "") + event.text;
        },
      }),
    },

    // View sub-state. INSERT opens the type box (keeps existing draft); MENU closes
    // it WITHOUT clearing the draft, so re-opening shows the same text.
    INSERT: { actions: assign({ view: "insert" }) },
    MENU: { actions: assign({ view: "menu" }) },

    // Status pushed from the IPC seam (onStatus / dictation result|error).
    "STATUS.SET": { actions: assign({ status: ({ event }) => event.status }) },
  },
});
