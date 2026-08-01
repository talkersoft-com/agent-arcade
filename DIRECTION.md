# agent-arcade-free — direction (frozen 2026-08-01)

This repo (formerly `agent-arcade`) is the **free edition** of Agent Arcade, and
it is deliberately **frozen** at v0.9.0 while the cloud product moves to a clean
slate in `agent-arcade-client`.

## What this repo will become (deferred work — do not start yet)

Stripped to the free path, and nothing else:

- **YAML only.** Agents, groups and macros live in `~/.hv/agent-arcade.yaml`.
  No login, no accounts, no web backend, no product-API calls — the store split
  already isolates this as the `local` edition; the strip removes the `cloud`
  edition code paths entirely.
- **Apple-Silicon-local dictation only.** The daemon talks to a local
  Parakeet-MLX sidecar running on this Mac — no hosted speech backend, no
  tokens, no capability probes against remote hosts. The sidecar's source code
  **belongs in this repo** when the strip happens.
- The **one-time promote** (YAML → cloud account) remains the bridge OUT of
  this edition, into the paid client.

## What stays exactly as it is

- **npm publishing, unchanged.** The GitHub Action (`.github/workflows/publish.yml`,
  triggered by publishing a GitHub Release) keeps publishing
  `@talkersoft-com/agent-arcade` the same way it does today. npm distribution
  is for **testing only** — this system is not marketed and is unlikely to ship
  to users via npm.

## Loose end, recorded (2026-08-01): where the Apple Silicon backend is

The Parakeet-MLX sidecar + the `MLXASR`/`ASR_BACKEND=riva|mlx` provider split
shipped on **2026-06-20** (workflow `garnet-baklava`) into the **old**
`agent-arcade-api` — the dictation-era repo. That repo was **deleted from
GitHub** (~2026-07-25) when its name was recycled for the new product backend,
and no local clone survives on this machine. What survives locally is the model
weights only (`~/huggingface/parakeet-tdt-0.6b-v2-mlx`, `…-v3-mlx-8bit`).
`speech-api` was ported from it explicitly "stripped of the mlx backend" —
only the ASR interface comments remain there.

**Recovery path:** GitHub retains deleted repositories for ~90 days. Restore
via the org's web UI (Settings → Deleted repositories) — note the current
`agent-arcade-api` occupies the name, so: temporarily rename the new repo,
restore the old one, rename the restored repo to something like
`dictation-mlx-legacy`, rename the new one back. The MLX server code should
then be carried into THIS repo. **The 90-day clock started ~2026-07-25.**
