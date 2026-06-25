// mitt event bus — the cross-component / DOM-decoupled NOTIFICATION channel.
//
// Rule (from the phase contract): mitt = notifications; XState = transitions.
// Use the bus for ambient, fire-and-forget signals that any component may want to
// observe without coupling to a machine: toasts, "agents changed" refresh pings,
// "draft saved" hints, etc. State CHANGES (mode/selection/draft) flow through the
// XState actors, never here.
//
// Known event names (informal registry — keep in sync as phases land):
//   "toast"          { text, kind }      — sticky toast (errors/info)
//   "toast:hide"     —                   — dismiss the sticky toast
//   "agents:changed" —                   — data refresh landed; rail may have moved
//   "dictation:*"    —                   — reserved for Phase 0005
//   "terminal:*"     —                   — reserved for Phase 0006
import mitt from "mitt";

export const bus = mitt();
