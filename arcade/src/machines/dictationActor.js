// Per-dictation-JOB actor (XState v5) — ONE spawned per ⌘D capture, keyed by job_id.
//
// Lifecycle (states):
//   idle → recording → pending → confirmed | error
//
//   idle       : nothing happening (the actor is born already-recording in practice;
//                `idle` exists as the formal start so the machine reads top-to-bottom).
//   recording  : mic is capturing for `agentId`. ⌘D again COMMITS (build WAV, dispatch
//                via window.arcade.dictate) → pending. Esc CANCELS (discard) → final.
//   pending    : WAV dispatched; awaiting Go's verdict on dictation:event. The actor
//                (and its `agentId`) OUTLIVES navigation here — this is the async-commit
//                anchor. A Go result/error arriving while the user is on ANOTHER agent
//                still names THIS actor's `agentId`.
//   confirmed  : Go sent {type:"result"} for our job_id → cleaned text delivered to the
//                ORIGINATING agent (main routes it; we drive the UI/status). Final.
//   error      : Go sent {type:"error"} for our job_id, OR commit failed. Final.
//
// Critical design point — the job actor is keyed by job_id and carries the originating
// `agentId` in context. The dictation MANAGER (dictation.js) keys actors by job_id and
// resolves Go's events back to the right actor; the actor's `agentId` never changes, so
// confirming/erroring always names the agent the recording STARTED on, not the agent the
// user happens to be looking at when Go answers.
import { createMachine, assign } from "xstate";

export const dictationMachine = createMachine({
  id: "dictation",
  // input: { jobId, agentId, agentName } — supplied by the manager at spawn time.
  context: ({ input }) => ({
    jobId: input.jobId,
    agentId: input.agentId,        // the ORIGINATING agent — durable for the job's life
    agentName: input.agentName || "",
    cleanedText: null,             // filled on confirm (Go's cleaned_text)
    error: null,                   // filled on error (Go's error / commit failure)
  }),
  initial: "recording",
  states: {
    // Born recording (the manager starts mic capture before spawning).
    recording: {
      on: {
        // ⌘D again / commit-then-navigate: the manager has built+dispatched the WAV.
        COMMIT: { target: "pending" },
        // Esc: discard, no dispatch. The ONLY discard path.
        CANCEL: { target: "cancelled" },
        // Capture/dispatch failed before we even reached Go.
        FAIL: { target: "error", actions: assign({ error: ({ event }) => event.error || "capture failed" }) },
      },
    },
    // Dispatched; waiting for Go. Resolves ONLY on Go's events (via the IPC seam).
    pending: {
      on: {
        // {type:"result", job_id, agentId, cleaned_text} → confirmed for the ORIGINATING agent.
        RESULT: { target: "confirmed", actions: assign({ cleanedText: ({ event }) => event.cleaned_text || "" }) },
        // {type:"error", job_id} → error for the ORIGINATING agent.
        GO_ERROR: { target: "error", actions: assign({ error: ({ event }) => event.error || "dictation failed" }) },
      },
    },
    confirmed: { type: "final" },
    error: { type: "final" },
    cancelled: { type: "final" },   // Esc-discard: a distinct terminal so the UI can tell
  },
});
