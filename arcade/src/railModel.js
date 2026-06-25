// Pure rail model — bucket the (optionally system-filtered) agents into groups,
// exactly as the reference renderer.js buildRail() does. No globals: everything is
// derived from the data snapshot passed in. The root machine holds {agents, groups,
// systems, filterSystemId} in context and calls these to compute the carousel.

// All agents by default; only narrowed when a system filter is picked. Unassigned
// agents always show in "All".
export function sysAgents(agents, filterSystemId) {
  return filterSystemId ? agents.filter((a) => a.system_id === filterSystemId) : agents;
}

// Default (id "") first when it has members, then active custom groups by order;
// only non-empty buckets render. Inactive group → hidden; orphaned group_id →
// falls back to Default (never orphaned). `grouped` flips on once a custom group
// has a member.
export function buildRail(agents, groups, filterSystemId) {
  const groupById = {}; (groups || []).forEach((g) => { groupById[g.id] = g; });
  const visible = sysAgents(agents || [], filterSystemId).filter((a) => a.active !== false);
  const def = { id: "", name: "Default", agents: [] };
  const custom = (groups || []).filter((g) => g.active !== false).slice().sort((a, b) => a.order - b.order)
    .map((g) => ({ id: g.id, name: g.name, agents: [] }));
  const customById = {}; custom.forEach((b) => { customById[b.id] = b; });
  for (const a of visible) {
    const g = a.group_id ? groupById[a.group_id] : null;
    if (a.group_id && g && g.active === false) continue;        // inactive group → hidden
    if (a.group_id && customById[a.group_id]) customById[a.group_id].agents.push(a);
    else def.agents.push(a);                                    // no group / orphaned / fallback → Default
  }
  const nonEmptyCustom = custom.filter((b) => b.agents.length);
  const buckets = [];
  if (def.agents.length) buckets.push(def);
  buckets.push(...nonEmptyCustom);
  if (!buckets.length) buckets.push(def);                       // keep one empty bucket so callers never crash
  const flat = buckets.flatMap((b) => b.agents);
  return { groups: buckets, grouped: nonEmptyCustom.length > 0, flat };
}

// The agent currently selected on the rail, for a given {selG, sel}.
export function railAgentAt(rail, selG, sel) {
  return rail.groups[selG] && rail.groups[selG].agents[sel];
}

// Find the {selG, sel} that points at a specific agent id (used to keep selection
// aligned across data refreshes / returning to the rail). Returns null if absent.
export function locateAgent(rail, id) {
  if (!id) return null;
  for (let gi = 0; gi < rail.groups.length; gi++) {
    const ai = rail.groups[gi].agents.findIndex((a) => a.id === id);
    if (ai >= 0) return { selG: gi, sel: ai };
  }
  return null;
}

// The neighbour agent in the SAME group as `focusId`, dir = ±1. Clamped (no wrap),
// matching the reference's neighborInGroup(). Returns null when there's no move
// (lone agent / already at an end). Falls back to selG when focusId isn't found.
export function neighborInGroup(rail, focusId, selG, dir) {
  let gi = rail.groups.findIndex((g) => g.agents.some((a) => a.id === focusId));
  if (gi < 0) gi = selG;
  const list = rail.groups[gi] ? rail.groups[gi].agents : [];
  if (!list.length) return null;
  let i = list.findIndex((a) => a.id === focusId);
  if (i < 0) i = 0;
  i = Math.max(0, Math.min(list.length - 1, i + dir)); // clamp — no wrap
  const a = list[i];
  return (!a || a.id === focusId) ? null : a;
}

// Signature of the rail's STRUCTURE (group id/name + agent ids in order). Running/
// recording state is intentionally excluded so it never forces a DOM rebuild —
// same contract as the reference's railSig().
export function railSig(rail) {
  return rail.groups.map((g) => g.id + ":" + g.name + ":" + g.agents.map((a) => a.id).join(",")).join("|");
}
