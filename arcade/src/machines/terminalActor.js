// Terminal region machine (XState v5) — the agent's terminal-facing surfaces as a
// single lifecycle, replacing the reference's loose `showTerm`/`syncMode`/`shellMode`
// booleans with one explicit state region. ONE actor for the session; the focused
// agent is read from context, set on each (re)open.
//
// States (the surfaces this region owns):
//   closed : no terminal view up — the agent MENU is showing (reference showTerm=false).
//   peek   : the live pane peek (reference showTerm) — getText scrape + prompt input.
//            `compose` (context flag) is the ⌘E expanded editor, a sub-mode of peek.
//   sync   : full-screen every-key-to-the-pane (reference syncMode). ⌘A exits → peek.
//   shell  : the ⌘W workspace shell (xterm.js + node-pty). ⌘A/Esc exits → peek.
//
// The CONTROLLER (terminal.js) owns the imperative DOM/poll/xterm work (the dictation.js
// pattern); this machine owns ONLY the state region + the focused agent + the compose
// flag, and is driven from the one IPC translate site for shell data/exit.
//
// onShellData/onShellExit are translated (ipc.js → terminal.js) into SHELL.DATA /
// SHELL.EXIT events: SHELL.DATA writes to the live xterm, SHELL.EXIT marks the shell
// dead (the controller prints the "[shell exited — ⌘A back]" line). Driving them
// through this one machine — instead of an ambient bus emit — is the Phase 0006
// "convert the shell pushes to drive the machine at the one translate site" change.
import { createMachine, assign } from "xstate";

export const terminalMachine = createMachine({
  id: "terminal",
  initial: "closed",
  context: {
    agentId: null,        // the agent whose terminal this region is showing
    compose: false,       // ⌘E expanded-editor flag (peek sub-mode)
    shellDead: false,     // the PTY exited (SHELL.EXIT) — controller shows the dead notice
  },
  states: {
    closed: {
      on: {
        OPEN: { target: "peek", actions: "setAgent" },
      },
    },
    peek: {
      // entering peek always clears compose (reference closeTerm/toggleTerm reset).
      entry: assign({ compose: false }),
      on: {
        OPEN: { actions: "setAgent" },         // ⌘←/→ switch terminal to another agent (stay in peek)
        CLOSE: { target: "closed" },
        "SYNC.ENTER": { target: "sync" },
        "SHELL.ENTER": { target: "shell", actions: assign({ shellDead: false }) },
        "COMPOSE.TOGGLE": { actions: assign({ compose: ({ context, event }) => (event.on != null ? !!event.on : !context.compose) }) },
        "COMPOSE.OFF": { actions: assign({ compose: false }) },
      },
    },
    sync: {
      on: {
        "SYNC.EXIT": { target: "peek" },
        CLOSE: { target: "closed" },
      },
    },
    shell: {
      on: {
        "SHELL.EXIT_TO_AGENT": { target: "peek" },  // ⌘A / Esc → back to the WezTerm peek
        CLOSE: { target: "closed" },
        // Shell pushes (the one translate site): data → controller writes to xterm;
        // the PTY exiting marks the shell dead (controller prints the notice).
        "SHELL.DATA": { actions: "onShellData" },
        "SHELL.EXIT": { actions: ["onShellExit", assign({ shellDead: true })] },
      },
    },
  },
}, {
  actions: {
    setAgent: assign({ agentId: ({ event }) => event.agentId }),
    // Placeholders — terminal.js installs the real DOM writers via createActor's
    // machine.provide({ actions: { onShellData, onShellExit } }) at boot, so SHELL.DATA
    // writes to the live xterm and SHELL.EXIT prints the dead-shell notice. This is what
    // makes the shell pushes drive the machine (not an ambient bus emit) at one site.
    onShellData: () => {},
    onShellExit: () => {},
  },
});
