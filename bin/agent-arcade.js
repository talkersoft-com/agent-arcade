#!/usr/bin/env node
"use strict";
// `agent-arcade` — the global command installed by:
//     npm install -g @talkersoft-com/agent-arcade-studio
// Launches the Electron app in menu-bar (launcher) mode, detached, so it runs in
// the background and your terminal returns immediately. Works from any directory.
const { spawn } = require("child_process");
const path = require("path");

let electron;
try {
  // In a plain Node context, `require("electron")` resolves to the path of the
  // bundled electron binary (electron must be a runtime dependency for this).
  electron = require("electron");
} catch (e) {
  console.error("Agent Arcade: the Electron runtime isn't installed.");
  console.error("Reinstall:  npm install -g @talkersoft-com/agent-arcade-studio");
  process.exit(1);
}

const appDir = path.join(__dirname, ".."); // package root — where main.js lives
// The installed command is ALWAYS the production build. `npm run dev`
// (DICTATE_DEV) is an internal-only mode — separate settings file, dev icon,
// hot-reload — and must never leak into a published package. Strip it from the
// environment even if the user has it exported in their shell, so `agent-arcade`
// matches `npm run prod` (which launches with `env -u DICTATE_DEV`).
const env = { ...process.env };
delete env.DICTATE_DEV;
const child = spawn(electron, [appDir, "--launcher", ...process.argv.slice(2)], {
  stdio: "ignore",
  detached: true, // survive the terminal closing; it's a resident menu-bar app
  env,
});
child.unref();
console.log("Agent Arcade launched — look for the menu-bar icon. (Quit it from there.)");
