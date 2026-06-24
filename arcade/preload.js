// Arcade preload — the only bridge between the sandboxed renderer and main.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("arcade", {
  agents: () => ipcRenderer.invoke("arcade:agents"),
  systems: () => ipcRenderer.invoke("arcade:systems"),
  groups: () => ipcRenderer.invoke("arcade:groups"),
  commands: () => ipcRenderer.invoke("arcade:commands"),   // @-command macros
  saveViewRatio: (w, h) => ipcRenderer.invoke("arcade:saveViewRatio", { w, h }),
  settings: () => ipcRenderer.invoke("arcade:settings"),
  tour: () => ipcRenderer.invoke("arcade:tour"),
  tourDone: (screen) => ipcRenderer.invoke("arcade:tourDone", screen),
  startSetup: () => ipcRenderer.invoke("arcade:startSetup"), // welcome orb → Studio first-agent wizard
  dictate: (agentId, wav) => ipcRenderer.invoke("arcade:dictate", { agentId, wav }),
  activate: (agentId) => ipcRenderer.invoke("arcade:activate", agentId),
  launchAgent: (agentId) => ipcRenderer.invoke("arcade:launchAgent", agentId),
  popOut: (agentId, force) => ipcRenderer.invoke("arcade:popOut", { agentId, force: !!force }),
  sendText: (agentId, text) => ipcRenderer.invoke("arcade:sendText", { agentId, text }),
  getText: (agentId) => ipcRenderer.invoke("arcade:getText", agentId),
  paneKey: (agentId, key) => ipcRenderer.invoke("arcade:paneKey", { agentId, key }),
  paneSend: (agentId, bytes) => ipcRenderer.invoke("arcade:paneSend", { agentId, bytes }),
  exit: () => ipcRenderer.invoke("arcade:exit"),
  // Workspace shell (⌘W): xterm.js front-end ↔ node-pty back-end, one per agent.
  shellOpen: (agentId, cols, rows) => ipcRenderer.invoke("arcade:shellOpen", { agentId, cols, rows }),
  shellInput: (agentId, data) => ipcRenderer.invoke("arcade:shellInput", { agentId, data }),
  shellResize: (agentId, cols, rows) => ipcRenderer.invoke("arcade:shellResize", { agentId, cols, rows }),
  onShellData: (cb) => ipcRenderer.on("arcade:shellData", (_e, p) => cb(p)),
  onShellExit: (cb) => ipcRenderer.on("arcade:shellExit", (_e, p) => cb(p)),
  onStatus: (cb) => ipcRenderer.on("status", (_e, s) => cb(s)),
  onEsc: (cb) => ipcRenderer.on("arcade:esc", () => cb()), // Esc routed from a menu accelerator (macOS eats it from the page)
  // dictation capability gate (Studio's main owns the probe; pushed live here)
  dictationGet: () => ipcRenderer.invoke("arcade:dictationGet"),
  onDictation: (cb) => ipcRenderer.on("dictation:available", (_e, s) => cb(s)),
});
