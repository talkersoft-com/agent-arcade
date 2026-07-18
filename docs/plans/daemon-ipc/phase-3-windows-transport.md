# Phase 3 — Windows transport (named pipes) + Dell Latitude harness

Part of [PLAN.md](PLAN.md). Est: ~0.5–1 day. Requires Phase 1 (Phase 2 not required —
the harness is Electron-free). Target machine: **Dell Latitude, Windows 11**.

## Goal

The daemon and the smoke harness run natively on Windows 11 over
`\\.\pipe\agent-arcade-dictation`, proving the transport seam is truly cross-platform.
The full Electron app is NOT ported (bundled WezTerm.app, osascript, TCC are
macOS-only) — this phase validates the IPC layer only, so the daemon is ready the
day a Windows port begins.

## Work items

1. **Go: named-pipe listener** — fill the `windows` arm of `listenLocal()`
   - Dependency: `github.com/Microsoft/go-winio` (`go.mod`).
   - `winio.ListenPipe(pipeName(), &winio.PipeConfig{})`; pipe name
     `\\.\pipe\agent-arcade-dictation` (+`-dev` under `DICTATE_DEV`).
   - No unlink dance — pipes vanish with their creator; bind-fail race handling
     identical to unix (exit 0 silently).
   - Guard unix-only code (`chmod`, unlink) behind the GOOS switch.
   - Staleness self-check: verify `os.Executable()` stat behaves on NTFS
     (it does; note Windows locks running binaries — npm upgrade over a RUNNING
     daemon fails on Windows, so document: upgrade drill there is stop-then-upgrade).

2. **Node: pipe address already wired** (Phase 2 `localAddr()`); verify
   `net.connect({ path: "\\\\.\\pipe\\…" })` against the Go daemon — this is the
   one integration nobody can prove without a real Windows box.

3. **Harness for the Latitude** — no Electron, no app install:
   - `scripts/win/README.md`: install Go + Node (winget one-liners), clone, then:
     ```
     cd go && go build -o bin/dictation-go.exe .
     set DICTATION_API_URL=http://<dgx-spark>:9100
     bin\dictation-go.exe --daemon
     node ..\scripts\daemon-smoke.js        (second terminal)
     ```
   - `daemon-smoke.js` needs zero changes if Phase 1 wrote it against `localAddr()`.
   - Network note: the Latitude must reach the dgx-spark (same LAN/VPN as the Macs);
     `--selftest test/fixtures/hello.wav` is the API-reachability preflight.

4. **CI-less cross-compile check** (on the Mac, cheap regression guard):
   `GOOS=windows GOARCH=amd64 go build ./...` added to `build:go` as a compile-only
   step — Windows arm can never silently rot.

## Exit criteria (on the Dell Latitude)

- [ ] `go build` succeeds natively on Win 11.
- [ ] Daemon binds the pipe; second instance exits 0 silently.
- [ ] `node scripts/daemon-smoke.js` → PASS: hello/welcome, health, dictate fixture
      WAV → `result` with real transcript from the dgx-spark.
- [ ] Two concurrent smoke clients → correct unicast routing (same as mac test).
- [ ] Kill daemon while smoke client polls → client's ensure-loop respawns it.
- [ ] On the Mac: `GOOS=windows` compile step green in `npm run build:go`.
