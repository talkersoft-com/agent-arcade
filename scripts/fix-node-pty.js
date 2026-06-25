#!/usr/bin/env node
"use strict";
// node-pty ships its macOS `spawn-helper` binary WITHOUT the executable bit when
// the prebuilt binary is used (no from-source build runs to chmod it). node-pty's
// spawn() execs that helper to set up the pty, so a 0644 spawn-helper makes every
// spawn fail with "posix_spawnp failed" — which is exactly what breaks the Arcade's
// ⌘W workspace shell (the live terminal scrape uses the wezterm bridge and is fine;
// only the interactive shell uses node-pty). Restore +x after install.
//
// Runs as our package's `postinstall`, so it fires on every
// `npm install -g @talkersoft-com/agent-arcade-studio`. Safe, idempotent, and a
// no-op when node-pty isn't present (e.g. a CI checkout without deps).
const fs = require("fs");
const path = require("path");

try {
  const root = path.dirname(require.resolve("node-pty/package.json"));
  const targets = [];
  const prebuilds = path.join(root, "prebuilds");
  if (fs.existsSync(prebuilds)) {
    for (const dir of fs.readdirSync(prebuilds)) {
      targets.push(path.join(prebuilds, dir, "spawn-helper"));
    }
  }
  targets.push(path.join(root, "build", "Release", "spawn-helper")); // from-source builds

  let fixed = 0;
  for (const f of targets) {
    try {
      if (fs.existsSync(f)) { fs.chmodSync(f, 0o755); fixed++; }
    } catch {}
  }
  if (fixed) console.log(`[agent-arcade] node-pty spawn-helper made executable (${fixed})`);
} catch {
  // node-pty not installed / not resolvable — nothing to do.
}
