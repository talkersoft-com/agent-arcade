// Preload: the only bridge between the sandboxed renderer and main.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tester", {
  // streaming dictation: capture a WAV → main transcribes/cleans and routes the
  // text into the agent's pane (no saved recordings).
  dictate: (agentId, wav) => ipcRenderer.invoke("studio:dictate", { agentId, wav }),
  // global app + monitor + wezterm settings (persisted to ~/.hv/agent-arcade.yaml)
  getApp: () => ipcRenderer.invoke("app:get"),
  setApp: (s) => ipcRenderer.invoke("app:set", s),
  micVolGet: () => ipcRenderer.invoke("mic:volume:get"),
  // dictation daemon (Preferences restart row): shared-daemon status + restart
  daemonInfo: () => ipcRenderer.invoke("daemon:info"),
  daemonRestart: () => ipcRenderer.invoke("daemon:restart"),
  micVolSet: (n) => ipcRenderer.invoke("mic:volume:set", n),
  // global hotkeys (Settings → Shortcuts)
  trayIcon: () => ipcRenderer.invoke("ui:trayIcon"),
  seedArcadeTour: () => ipcRenderer.invoke("tour:seedArcade"),
  getShortcuts: () => ipcRenderer.invoke("shortcuts:get"),
  setSummonHotkey: (accel) => ipcRenderer.invoke("shortcuts:setSummon", accel),
  suspendShortcuts: () => ipcRenderer.invoke("shortcuts:suspend"),
  resumeShortcuts: () => ipcRenderer.invoke("shortcuts:resume"),
  dictationOptionsCatalog: () => ipcRenderer.invoke("dictationOptions:catalog"),
  getWezterm: () => ipcRenderer.invoke("wezterm:get"),
  setWezterm: (s) => ipcRenderer.invoke("wezterm:set", s),
  listScreens: () => ipcRenderer.invoke("screen:list"),
  getDisplay: () => ipcRenderer.invoke("display:get"),
  setDisplay: (d) => ipcRenderer.invoke("display:set", d),
  getWatch: () => ipcRenderer.invoke("watch:get"),
  setWatch: (d) => ipcRenderer.invoke("watch:set", d),
  detectWezterm: () => ipcRenderer.invoke("wezterm:detect"),
  launchWezterm: () => ipcRenderer.invoke("wezterm:launch"),
  getViewRatio: () => ipcRenderer.invoke("viewRatio:get"),
  weztermSetBounds: (b) => ipcRenderer.invoke("wezterm:setBounds", b),
  // One-button: open WezTerm + size it to the Arcade view on the chosen monitor +
  // persist (opts.monitor = "x,y" of the target display, or "" for the Arcade monitor).
  weztermFit: (opts) => ipcRenderer.invoke("wezterm:fit", opts),
  // Center the live WezTerm window on the chosen monitor — keeps its size, only moves it.
  weztermCenter: (opts) => ipcRenderer.invoke("wezterm:center", opts),
  // macOS Automation (Apple Events → System Events) permission — needed for
  // Capture/Test/pop-out. check = probe status; request = surface the prompt and,
  // if not granted, open System Settings → Privacy & Security → Automation.
  permCheck: () => ipcRenderer.invoke("perm:automation:check"),
  permRequest: () => ipcRenderer.invoke("perm:automation:request"),
  // agent programs (catalog of selectable harnesses — claude today)
  agentPrograms: () => ipcRenderer.invoke("programs:list"),
  // systems (machines that host agents)
  systemsList: () => ipcRenderer.invoke("systems:list"),
  systemsSave: (s) => ipcRenderer.invoke("systems:save", s),
  systemsAdd: (name) => ipcRenderer.invoke("systems:add", name), // returns the created {id,name}
  systemsDelete: (id) => ipcRenderer.invoke("systems:delete", id),
  systemsReorder: (ids) => ipcRenderer.invoke("systems:reorder", ids),
  // groups (human-facing buckets for agents; independent of system)
  groupsList: () => ipcRenderer.invoke("groups:list"),
  groupsSave: (g) => ipcRenderer.invoke("groups:save", g),
  groupsDelete: (id) => ipcRenderer.invoke("groups:delete", id),
  groupsReorder: (ids) => ipcRenderer.invoke("groups:reorder", ids),
  // agents (CRUD, persisted to the YAML store)
  agentsList: () => ipcRenderer.invoke("agents:list"),
  agentsSave: (a) => ipcRenderer.invoke("agents:save", a),
  agentsDelete: (id) => ipcRenderer.invoke("agents:delete", id),
  agentsClone: (id) => ipcRenderer.invoke("agents:clone", id),
  agentsReorder: (ids) => ipcRenderer.invoke("agents:reorder", ids),
  agentsGenerateAvatar: (id) => ipcRenderer.invoke("agents:generateAvatar", id),
  agentsLaunch: (id) => ipcRenderer.invoke("agents:launch", id),
  agentsKill: (id) => ipcRenderer.invoke("agents:kill", id),
  agentsClearSession: (id) => ipcRenderer.invoke("agents:clearSession", id),
  agentsFocus: (id) => ipcRenderer.invoke("agents:focus", id),
  // Same pop-out the Arcade uses (⌘P): attaches/positions the WezTerm watch window. force=true = explicit user intent.
  agentsPopOut: (id) => ipcRenderer.invoke("arcade:popOut", { agentId: id, force: true }),
  agentsSendText: (id, text) => ipcRenderer.invoke("agents:sendText", { id, text }),
  agentsSendEsc: (id) => ipcRenderer.invoke("agents:sendEsc", id),
  agentsGetText: (id) => ipcRenderer.invoke("agents:getText", id),
  wezPaneIds: () => ipcRenderer.invoke("wez:paneIds"),
  launchArcade: () => ipcRenderer.invoke("arcade:launch"),
  // dictation capability gate (main owns the /capabilities probe; fail-closed)
  dictationGet: () => ipcRenderer.invoke("dictation:get"),
  dictationApiUrl: () => ipcRenderer.invoke("dictation:apiUrl"),
  dictationTest: (url) => ipcRenderer.invoke("dictation:test", url),
  dictationSetApiUrl: (url) => ipcRenderer.invoke("dictation:setApiUrl", url),
  // backend servers (multi-server, single-active; verb:noun IPC)
  serversList: () => ipcRenderer.invoke("servers:list"),
  serversAdd: (name, url) => ipcRenderer.invoke("servers:add", { name, url }),
  serversRemove: (name) => ipcRenderer.invoke("servers:remove", name),
  serversSetActive: (name) => ipcRenderer.invoke("servers:setActive", name),
  serversUpdate: (oldName, name, url) => ipcRenderer.invoke("servers:update", { oldName, name, url }),
  modelReveal: () => ipcRenderer.invoke("model:reveal"),
  modelRemove: () => ipcRenderer.invoke("model:remove"),
  openExternal: (url) => ipcRenderer.invoke("ui:openExternal", url),
  onDictation: (cb) => ipcRenderer.on("dictation:available", (_e, s) => cb(s)),
  onOpenPreferences: (cb) => ipcRenderer.on("ui:openPreferences", () => cb()),
  onOpenStudio: (cb) => ipcRenderer.on("ui:openStudio", () => cb()),
  // events from Go bridge / main
  onEvent: (cb) => ipcRenderer.on("dictation:event", (_e, msg) => cb(msg)),
  onLog: (cb) => ipcRenderer.on("dictation:log", (_e, entry) => cb(entry)),
});
