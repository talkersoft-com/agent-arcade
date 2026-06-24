#!/usr/bin/env bash
# Launch the sibling backend's one-command Apple-Silicon dev server.
# The backend repo (agent-arcade-api) is a sibling of this repo in the deck layout.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dev="$here/../agent-arcade-api/dev.sh"
if [[ ! -x "$dev" ]]; then
  if [[ -f "$dev" ]]; then
    echo "backend: $dev exists but is not executable — run: chmod +x '$dev'" >&2
  else
    echo "backend: can't find the backend launcher at $dev" >&2
    echo "         expected sibling repo 'agent-arcade-api' with a dev.sh — clone it next to this repo." >&2
  fi
  exit 1
fi
exec "$dev" "$@"
