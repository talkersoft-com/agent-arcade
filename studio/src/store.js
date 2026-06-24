// Single Zustand store for Studio. The IPC seam (preload.js → window.tester) is the
// only place a raw IPC message becomes store state; components read the store, never
// ipcRenderer. Mirrors the reference renderer.js behavior 1:1.
import { create } from "zustand";
import { tester } from "./ipc.js";

export const useStore = create((set, get) => ({
  // ── top-level view: "agents" | "settings" ──
  view: "agents",
  activateView: (view) => set({ view }),

  // ── dictation availability gate (main owns the probe; pushed live) ──
  dictationAvailable: false,
  dictationCaps: null,
  setDictation: (s) =>
    set({ dictationAvailable: !!(s && s.available), dictationCaps: (s && s.caps) || null }),

  // ── agents / live panes / groups index ──
  agents: [],
  livePaneIds: [],
  groupsById: {},
  avatarBust: 0,
  async refreshAgents() {
    const [list, panes, groups] = await Promise.all([
      tester.agentsList(), tester.wezPaneIds(), tester.groupsList(),
    ]);
    const groupsById = {};
    (groups || []).forEach((g) => { groupsById[g.id] = g; });
    set({ agents: list || [], livePaneIds: (panes && panes.ids) || [], groupsById });
  },

  // ── catalogs (cached) ──
  dictationCatalog: null,
  async loadDictationCatalog() {
    let cat = get().dictationCatalog;
    if (!cat) { cat = await tester.dictationOptionsCatalog(); set({ dictationCatalog: cat }); }
    return cat;
  },
  programs: null,
  async loadPrograms() {
    let p = get().programs;
    if (!p) { p = await tester.agentPrograms(); set({ programs: p }); }
    return p;
  },

  // ── editor target / tour ──
  editingAgentId: null,
  editorOpen: false,
  wizard: false,
  tourState: null, // {idx, unlocked, agentSaved, summonSym, trayIcon} when active

  // ── systems / groups (Settings → Organization) ──
  systems: [],
  groups: [],
  async loadOrg() {
    const [systems, groups, agents] = await Promise.all([
      tester.systemsList(), tester.groupsList(), tester.agentsList(),
    ]);
    set({ systems: systems || [], groups: groups || [], agents: agents || [] });
  },

  // ── app settings / displays / shortcuts ──
  app: {},
  wezterm: { cols: 0, rows: 0 },
  screens: [],
  display: {},
  watch: {},
  shortcuts: { summon: "" },
  async loadSettings() {
    const [a, w, screens, display, watch, shortcuts] = await Promise.all([
      tester.getApp(), tester.getWezterm(), tester.listScreens(),
      tester.getDisplay(), tester.getWatch(), tester.getShortcuts(),
    ]);
    set({
      app: a || {}, wezterm: w || { cols: 0, rows: 0 }, screens: screens || [],
      display: display || {}, watch: watch || {}, shortcuts: shortcuts || { summon: "" },
    });
  },

  // ── backend servers ──
  servers: [],
  activeServer: "",
  backendApiUrl: "",
  async loadBackend() {
    try {
      const r = await tester.serversList();
      const servers = (r && r.servers) || [];
      const active = (r && r.active) || "";
      set({ servers, activeServer: active, backendApiUrl: (servers.find((s) => s.name === active) || {}).url || "" });
    } catch {}
  },
}));

// ── live IPC pushes (the seam → store). Subscribed once at boot. ──
export function wireIpc() {
  tester.onDictation && tester.onDictation((s) => useStore.getState().setDictation(s));
}
