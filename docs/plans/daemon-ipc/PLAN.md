# Dictation Daemon — IPC Migration Plan (master)

**Status:** EXECUTING — Phases 1–3 implemented + scripted-verified 2026-07-18
(branch `fluffy-flourmill`). Phase 4 (irreversible stdio deletion) is GATED on:
Todd's interactive `npm run dev` pass (phase-2 checklist), the Latitude harness
run (phase-3 checklist), and the soak period phase-4 calls for.
**Scope guard:** no npm package is published during this plan. All testing is local
(`npm run dev` / `npm run start` on macOS, standalone harness on Windows 11).

Replace the per-window `dictation-go` stdio children with **one daemon** serving all
clients over a **Unix domain socket** (macOS/Linux) / **named pipe** (Windows 11),
with 1:1 feature parity and the Electron layer fully decoupled from the Go binary.

## Phases

| Phase | File | Deliverable | Exit test |
|---|---|---|---|
| 1 | [phase-1-go-daemon.md](phase-1-go-daemon.md) | `dictation-go --daemon` (macOS first), stdio untouched | scripted socket smoke test green |
| 2 | [phase-2-clients-and-supervision.md](phase-2-clients-and-supervision.md) | `lib/dictation-client.js`, both apps switched, launcher + client-side supervision, Preferences restart row | full dictation via `npm run dev`; kill/upgrade drills self-heal |
| 3 | [phase-3-windows-transport.md](phase-3-windows-transport.md) | named-pipe transport + standalone Windows harness | smoke test green on the Dell Latitude (Win 11) |
| 4 | [phase-4-retire-stdio.md](phase-4-retire-stdio.md) | stdio pattern deleted; docs updated | regression pass on macOS; no stdio remnants |

## Locked decisions (from pre-planning, 2026-07-18)

1. **Self-aware daemon (staleness).** At boot the daemon stats its own binary
   (`os.Executable()` → size+mtime). On **every new client connection** it re-stats;
   if the file changed or vanished (npm upgrade), it answers the `hello` with
   `{"type":"stale"}`, finishes in-flight jobs, and **exits 0**. Whoever respawns it
   by path gets the new binary. No version negotiation needed; `daemon_version` in
   `welcome` is observability only.
2. **Every client ensures the daemon** (Docker-CLI pattern). Connect first; if refused,
   unlink the stale socket file, spawn `dictation-go --daemon` detached, retry with
   backoff. The launcher additionally supervises (child spawn + respawn-on-exit with
   capped backoff + deliberate-quit flag) so healing exists even with zero windows open.
3. **The socket IS the single-instance lock.** Two racers both spawn; second `bind`
   fails; loser exits silently; both clients connect to the winner. No pidfiles.
4. **Stateless per-client daemon.** The `hello` handshake is the entire session.
   Recovery from ANY failure (crash, sleep/wake weirdness, wedge) is the one universal
   path: reconnect → `hello` → `welcome`. Clients emit `down` while disconnected →
   `dictationAvailable=false` (existing UX).
5. **Sleep/wake.** Unix sockets survive sleep (both ends freeze together). The only
   real casualty is the daemon→API TCP pool: set short HTTP timeouts + one retry on
   connection-level failure in the Go API client.
6. **Manual escape hatch.** Preferences → Dictation gets a "Dictation daemon" action
   row: chip `v0.3.0 · up 2h · 2 clients` + **Restart** button (sends `shutdown`;
   supervision revives it; chip flicker = proof it took effect).
7. **Jobs.** WAV still travels by temp-file path. One goroutine per job (no more
   serialization). Results unicast to the owning connection; owner gone → dropped
   (today's semantics). `job_id` correlation unchanged.
8. **Out of scope:** npm publish, streaming ASR, launchd KeepAlive for the launcher,
   full Windows port of the Electron app (only the daemon+transport is exercised on
   Windows, via the Phase-3 harness).

## Protocol v1 (NDJSON over local socket)

New messages: `hello`, `welcome` (replaces `ready`), `stale`, `shutdown`, `info`/`info_result`.
Unchanged payloads: `dictate`, `status`, `result`, `error`, `health`, `health_result`, `log`
(log gains optional `job_id`). Routing: job events **unicast** to owner;
`health_result` + `log` **broadcast**.

```
client → daemon   {"type":"hello","client":"arcade|studio|launcher|cli","app_version":"x.y.z","protocol":1}
daemon → client   {"type":"welcome","daemon_version":"x.y.z","protocol":1,"api_url":"…","healthy":true}
daemon → client   {"type":"stale","reason":"binary changed on disk"}          // then daemon exits
client → daemon   {"type":"shutdown","reason":"user_restart|version_skew|quit"}
client → daemon   {"type":"info"}
daemon → client   {"type":"info_result","daemon_version":"…","uptime_s":123,"clients":["arcade","studio"]}
```

## Addresses

| Platform | Address | Notes |
|---|---|---|
| macOS / Linux | `~/.hv/dictation.sock` (dev: `dictation.dev.sock`) | unlink-before-bind; connect-before-unlink on the client side |
| Windows 11 | `\\.\pipe\agent-arcade-dictation` (dev: `…-dev`) | via `Microsoft/go-winio`; pipes self-clean, no stale files |

## Test strategy (no publishing)

- macOS: `npm run dev` end-to-end dictation; drill scripts in each phase
  (kill daemon → auto-heal; `touch` the binary → stale-exit → respawn; sleep/wake).
- Windows 11 (Dell Latitude): Phase-3 standalone harness — build the daemon with Go,
  run `node scripts/daemon-smoke.js` against the named pipe. No Electron app required.

## Rollback

Phases 1–2 keep the stdio path compiled and reachable behind `DICTATE_IPC=stdio`;
flipping the env var is the rollback. Only Phase 4 burns the boats.
