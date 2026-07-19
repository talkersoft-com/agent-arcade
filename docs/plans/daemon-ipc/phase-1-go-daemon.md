# Phase 1 — Go daemon mode (macOS first)

Part of [PLAN.md](PLAN.md). Est: ~1.5 days. **stdio stays fully intact this phase.**

## Goal

`dictation-go --daemon` listens on the Unix socket, speaks protocol v1 to many
concurrent clients, self-detects staleness, and exits cleanly on `shutdown` —
while the existing stdin/stdout mode keeps working untouched.

## Work items

1. **Transport seam** — `go/transport.go`
   - `listenLocal() (net.Listener, error)`: `runtime.GOOS` switch —
     darwin/linux → unlink stale path, `net.Listen("unix", sockPath())`, `chmod 0600`;
     windows → stub returning "built in phase 3" error (compiles, not wired).
   - `sockPath()`: `~/.hv/dictation.sock`, `.dev` variant when `DICTATE_DEV=1`.
   - Bind failure with a live listener on the other end = another daemon won the
     race → log to stderr, **exit 0 silently** (locked decision #3).

2. **Connection hub** — `go/hub.go`
   - Accept loop; per-connection: bufio scanner (1 MB cap, same as today), write mutex.
   - First message MUST be `hello` → register `{conn, client, app_version}` → reply
     `welcome`. Anything else first → protocol error, drop connection.
   - Registry keyed by connection; `job_id → conn` ownership map.
   - `emitTo(conn, msg)` (unicast) / `broadcast(msg)`; both tolerate dead conns
     (deregister on write error).

3. **Staleness self-check** — `go/selfcheck.go`
   - At boot: `os.Executable()` → record `(size, mtime)`.
   - On each accepted connection, before `welcome`: re-stat. Changed/missing →
     send `stale`, stop accepting, drain in-flight jobs (bounded 10 s), exit 0.

4. **Message handling** (reuse existing `handleDictate`, API client verbatim)
   - `dictate`: goroutine per job; `status`/`result`/`error` unicast to owner;
     owner disconnected → drop (locked decision #7).
   - `health`: probe now; `health_result` **broadcast** (shared truth).
   - `info` → `info_result` (version, uptime, connected client names) — feeds the
     Phase-2 Preferences row.
   - `shutdown`: reply nothing, close listener, drain, exit 0.
   - `log`: broadcast; include `job_id` when job-scoped.

5. **API client hardening (sleep/wake, locked decision #5)** — `go/api.go`
   - `http.Client` timeouts: connect 5 s, total 120 s (transcription can be slow).
   - One retry on connection-level error (refused/reset/EOF before response) —
     never retry after bytes were received.

6. **Version stamp** — build with
   `-ldflags "-X main.version=$(node -p "require('../package.json').version")"`;
   surface in `welcome`/`info_result`. Wire into `package.json` `build:go`.

## npm scripts (local testing only)

```json
"daemon":       "go/bin/dictation-go --daemon",
"daemon:smoke": "node scripts/daemon-smoke.js"
```

`scripts/daemon-smoke.js` (new, ~80 lines, plain Node `net`): connects, does
`hello`→`welcome`, sends `health`, sends a `dictate` for `testdata/sample.wav`,
asserts a `result` arrives, prints PASS/FAIL. Doubles as the Phase-3 Windows harness.

## Exit criteria

- [x] `npm run daemon` + `npm run daemon:smoke` → PASS on macOS.
- [x] Two smoke clients concurrently → each gets only its own job's `result`.
- [x] Second `npm run daemon` while one runs → exits 0 silently, first unaffected.
- [x] `touch go/bin/dictation-go` → next connection gets `stale`, daemon exits;
      smoke script's spawn-retry brings up the (new) binary.
- [x] `echo '{"type":"health"}' | nc -U ~/.hv/dictation.sock` → rejected (no hello) —
      protocol gate works.
- [x] Existing stdio mode still passes: stdio `health` round-trip verified scripted;
      interactive `npm run dev` dictate covered by the Phase-2 regression drills.
