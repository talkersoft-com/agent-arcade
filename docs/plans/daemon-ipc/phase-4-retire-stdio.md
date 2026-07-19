# Phase 4 — Retire the stdio pattern

Part of [PLAN.md](PLAN.md). Est: ~0.5 day + docs. Requires Phases 1–3 soaked
(recommend ≥ a few days of daily-driver use on the Mac after Phase 2).
**This is the only irreversible phase — burn the boats knowingly.**

## Goal

`dictation-go` has exactly two modes: `--daemon` and `--selftest`. The Electron
apps have exactly one IPC path. Documentation matches reality.

## Work items

1. **Go** — delete the stdin scanner loop and stdio emitter from `main.go`;
   `--selftest` keeps working (it never used the stdio protocol). Update the
   package doc-comment (currently documents the stdin/stdout contract) to describe
   the socket protocol v1 instead.

2. **Node** — remove from both `arcade/main.js` and `main.js`:
   - the `DICTATE_IPC=stdio` fallback branch and env checks,
   - `spawn(GO_BIN)` + readline plumbing, `go.kill()` in `window-all-closed` /
     `before-quit` (the daemon outlives windows by design now; the launcher's
     `quitting` flag owns daemon shutdown).

3. **Docs** — `docs/IPC.md`: rewrite §transport (stdio → socket/pipe), add the
   protocol v1 message table from [PLAN.md](PLAN.md); README architecture blurb
   ("Go API bridge over NDJSON" → "NDJSON over a local socket — one daemon, many
   clients").

4. **Housekeeping** — `scripts/relaunch.js` kill patterns updated so
   `npm run kill:prod` / `kill:dev` also terminate a running daemon (dev iteration
   needs clean slates); scratch plan files in `docs/plans/daemon-ipc/` get a
   final STATUS: EXECUTED stamp with dates.

## Exit criteria

- [x] `grep -rn "stdin\|readline\|DICTATE_IPC" go/ arcade/main.js main.js` → only
      hits are `--selftest` internals and comments. (Verified 2026-07-18: one
      historical comment in hub.go + the unrelated WezTerm key-forward pipe.)
- [ ] Full regression on macOS via `npm run dev`: dictation from Arcade + Studio,
      mic picker + last-used row, restart row, kill/upgrade/sleep drills from
      Phase 2 all green.
- [ ] Windows smoke (Phase 3 harness) re-run green after the deletions.
- [ ] `npm run kill:dev && npm run dev` leaves exactly ONE daemon process.

## Explicitly still out of scope after this plan

npm publish of the daemon architecture (separate decision, own release notes),
streaming ASR (the daemon is now shaped for it), launchd KeepAlive for the
launcher, full Windows app port.

## STATUS: EXECUTED (code) — 2026-07-18

The cut is done: Go is `--daemon`/`--selftest` only (stdin loop + stdout emitter
deleted), both mains and the launcher have no spawn/readline/`DICTATE_IPC`
plumbing, `kill:dev`/`kill:prod` also stop the matching daemon, docs/IPC.md §3 +
README + package.json describe the socket transport. Daemon smoke re-ran green
against the cut binary (real transcript). The three unchecked boxes above are
Todd's verification gate — **no release until the new pattern is proven as good
or better than 0.2.22.**
