// The LOCAL edition's account store: the YAML on this machine, and nothing else.
//
// No network, no token, no account. This is the free path, and it behaves exactly
// as the app always has — the store interface is just where those reads and writes
// now live, so the cloud edition can be a peer rather than a special case bolted
// onto the same functions.
//
// Reads are synchronous by design. Every caller in the app expects a list right
// now (menu builds, rail renders, IPC replies), and making them async would mean
// rewriting the entire surface for no benefit here.
"use strict";

// SLICES are the account-owned collections — the things a person makes, which
// follow them to another machine when they promote. Everything else in the YAML
// (display geometry, wezterm size, mux id, pane ids, onboarding) is DEVICE state
// and deliberately not part of this interface.
const SLICES = ["agents", "groups", "systems", "commands"];

function create({ readDoc, writeDoc, device, onChange = () => {} }) {
  const list = (slice) => {
    const v = readDoc()[slice];
    const arr = Array.isArray(v) ? v : [];
    // Device fields (the live pane, the cached avatar) live in their own file now,
    // not inside the agent record. They are grafted on here so callers still see a
    // whole agent, and stripped again on the way back down.
    return slice === "agents" ? device.overlay(arr) : arr;
  };
  const save = (slice, next) => {
    const doc = readDoc();
    const arr = Array.isArray(next) ? next : [];
    doc[slice] = slice === "agents" ? arr.map(device.strip) : arr;
    writeDoc(doc);
    onChange(slice);
    return list(slice);
  };

  return {
    kind: "local",
    isCloud: false,
    // Nothing to hydrate: the file IS the truth, read fresh on every call.
    async start() { return { ok: true, source: "yaml" }; },
    async refresh() { onChange("all"); return { ok: true, source: "yaml" }; },
    list,
    save,
    // The local store is always "current" — there is no remote to be behind.
    status() { return { kind: "local", ok: true, stale: false, error: "", commandsFromApi: false }; },
  };
}

module.exports = { create, SLICES };
