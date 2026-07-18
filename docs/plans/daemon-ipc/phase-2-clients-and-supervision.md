# Phase 2 — Node client library, app switch-over, supervision

Part of [PLAN.md](PLAN.md). Est: ~1 day. Requires Phase 1.
Rollback: `DICTATE_IPC=stdio` env flips both apps back to the old spawn path.

## Goal

Both Electron mains stop knowing a Go binary exists. They talk to
`lib/dictation-client.js`; the daemon is ensured by every client and supervised by
the launcher; Preferences gains the restart row.

## Work items

1. **`lib/dictation-client.js`** (new, shared by both apps; plain CommonJS)
   - `connectDictation({ client, appVersion })` → EventEmitter.
   - Events mirroring today's `handleGo` cases 1:1: `welcome`, `status`, `result`,
     `error`, `health_result`, `log`, plus `down` (disconnected) / `up`.
   - Methods: `dictate(msg)`, `health()`, `info()`, `shutdown(reason)`, `close()`.
   - **Ensure-daemon connect loop** (locked decision #2):
     1. `net.connect(addr)` → success → `hello` → wait `welcome`.
     2. Refused/ENOENT → (unix only) unlink socket path if present →
        spawn `DAEMON_BIN --daemon` detached, stdio ignore → retry.
     3. Backoff 250 ms → 4 s, forever. Emit `down` after first failure, `up` on welcome.
   - `stale` received → treat as disconnect; the retry loop lands on the fresh binary.
   - Address helper `localAddr()`: darwin/linux → `~/.hv/dictation.sock`;
     win32 → `\\\\.\\pipe\\agent-arcade-dictation` (works as-is via Node named-pipe
     support; exercised for real in Phase 3). `.dev` variants under `DICTATE_DEV`.

2. **Arcade switch-over** — `arcade/main.js`
   - Remove `spawn(GO_BIN)` + readline plumbing → `connectDictation({client:"arcade"})`.
   - `handleGo(m)` body survives as the event handlers (payloads identical).
   - `down`/`up` drive the existing dictation-availability push to the renderer.
   - Keep old path behind `DICTATE_IPC=stdio` until Phase 4.

3. **Studio switch-over** — `main.js` — same treatment (`client:"studio"`).

4. **Launcher supervision** — `launcher/main.js`
   - On ready: `superviseDaemon()` — spawn as CHILD (not detached), respawn on exit
     with capped backoff (250 ms → 10 s), reset backoff after 60 s healthy.
   - `quitting` flag: `quitAgentArcade` sends `shutdown("quit")` via a throwaway
     client, sets flag, then proceeds with 0.2.22 behavior. No respawn race.
   - Bind-lost race (client already spawned one): supervisor child exits 0 instantly;
     treat exit-0-within-2 s as "lost the bind" → do NOT backoff-respawn, just
     connect a monitor client instead.

5. **Preferences restart row** — `studio/src/screens/SettingsBackend.jsx`
   (locked decision #6; existing `disp-act-row` pattern)
   - Row: 🔄 `Dictation daemon` · sub: `v0.3.0 · up 2h 14m · 2 clients` (from
     `info()`, refreshed on tab focus) · trail: **Restart** button.
   - Restart → `shutdown("user_restart")` → poll `info()` until back → chip refresh
     (the flicker is the proof-of-effect, mic-row philosophy).

## Exit criteria (all via `npm run dev`, no publish)

- [ ] Full dictation round-trip in the Arcade; "Last recording used" still updates.
- [ ] Studio Diagnostics → Dictate works; BOTH apps show one shared daemon in `info`.
- [ ] `kill -9` the daemon mid-session → apps flicker unavailable → self-heal < 5 s.
- [ ] `touch go/bin/dictation-go` (upgrade drill) → daemon stale-exits on next
      connect → fresh daemon, zero manual steps.
- [ ] Close lid 30 s, wake, dictate immediately → succeeds (one internal retry allowed).
- [ ] Quit Agent Arcade from tray → daemon exits too; relaunching Arcade alone
      (launcher dead) still gets a daemon (client-side ensure).
- [ ] Restart row: button click → chip uptime resets; recording during restart
      fails gracefully with today's error toast, next one succeeds.
- [ ] `DICTATE_IPC=stdio npm run dev` → old path still fully works (rollback proof).
