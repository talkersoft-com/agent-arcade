# Windows 11 daemon harness (Dell Latitude)

Standalone validation of the dictation daemon's Windows transport
(`\\.\pipe\agent-arcade-dictation`) — **no Electron app, no install**. This
proves the IPC layer is truly cross-platform so the daemon is ready the day a
Windows port of the app begins. Part of Phase 3 in
`docs/plans/daemon-ipc/PLAN.md`.

## One-time setup (PowerShell)

```powershell
winget install GoLang.Go OpenJS.NodeJS.LTS Git.Git
git clone https://github.com/talkersoft-com/agent-arcade.git
cd agent-arcade
```

## Build the daemon natively

```powershell
cd go
go build -o bin/dictation-go.exe .
cd ..
```

## Run

The Latitude must reach the dictation backend (same LAN/VPN as the Macs).
Preflight the API without any daemon involved:

```powershell
$env:DICTATION_API_URL = "http://<dgx-spark-host>:9100"
go\bin\dictation-go.exe --selftest testdata\sample.wav
```

Then the daemon + smoke test (two terminals, or let the smoke test spawn the
daemon itself — it does the same ensure-connect the apps do):

```powershell
# terminal 1 (optional — the smoke script spawns one if the pipe is silent)
go\bin\dictation-go.exe --daemon

# terminal 2
$env:DICTATION_API_URL = "http://<dgx-spark-host>:9100"
node scripts\daemon-smoke.js
```

`scripts/daemon-smoke.js` is the same file used on macOS — it resolves the
named pipe automatically on `win32`. Expect `PASS — daemon protocol v1
round-trip OK` with a real transcript.

## Exit-criteria drills (phase-3 file has the checklist)

- Second `dictation-go.exe --daemon` while one runs → exits 0 silently.
- Two smoke clients at once (`--client A` / `--client B`) → each gets only its
  own job's result.
- Kill the daemon in Task Manager, rerun the smoke test → it respawns one.

## Windows-specific note (upgrades)

NTFS locks a RUNNING executable: unlike macOS, replacing `dictation-go.exe`
under a live daemon fails. The upgrade drill on Windows is therefore
**stop-then-upgrade**: shut the daemon down (or kill it), replace the binary,
and the next client connection respawns the new one. The staleness self-check
still covers the delete-then-recreate path npm uses.
