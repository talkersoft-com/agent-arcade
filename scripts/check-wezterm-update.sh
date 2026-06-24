#!/usr/bin/env bash
# Check whether wez/wezterm has a newer *tagged* release than our pin.
#
#   scripts/check-wezterm-update.sh           # report only (exit 0 up-to-date, 10 if newer)
#   scripts/check-wezterm-update.sh --apply    # bump scripts/wezterm.version, re-vendor, smoke-test
#
# The "nightly" rolling tag is deliberately excluded — it isn't a pinnable,
# checksum-stable artifact. We only track real dated releases so the build stays
# deterministic. Requires `gh` (uses the GitHub API).
set -euo pipefail

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERFILE="$ROOT/scripts/wezterm.version"
PINNED="$(tr -d '[:space:]' < "$VERFILE")"

command -v gh >/dev/null 2>&1 || { echo "::error::gh CLI required" >&2; exit 1; }

# Newest non-nightly, non-prerelease release tag.
LATEST="$(gh api repos/wez/wezterm/releases \
  --jq '[.[] | select(.tag_name != "nightly" and (.prerelease | not))][0].tag_name')"
[ -n "$LATEST" ] || { echo "::error::could not determine latest wezterm release" >&2; exit 1; }

echo "pinned: $PINNED"
echo "latest: $LATEST"

emit() { [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1=$2" >> "$GITHUB_OUTPUT"; return 0; }

# Tags are sortable date strings (YYYYMMDD-HHMMSS-hash), so a string compare is a
# correct newer-than test.
if [ "$LATEST" = "$PINNED" ] || [[ ! "$LATEST" > "$PINNED" ]]; then
  echo "✓ up to date (pinned is the newest tagged release)"
  emit updated false
  exit 0
fi

echo "⬆ newer WezTerm release available: $PINNED → $LATEST"
emit updated false   # flipped to true only after a successful apply+smoke below

if [ "$APPLY" -eq 0 ]; then
  exit 10   # signal "update available" to callers that don't pass --apply
fi

echo "→ applying bump and re-vendoring…"
printf '%s\n' "$LATEST" > "$VERFILE"
bash "$ROOT/scripts/fetch-wezterm.sh"

# Smoke-test the freshly vendored binaries: all three present, executable, and the
# CLI reports the version we just pinned.
MACOS="$ROOT/vendor/wezterm/WezTerm.app/Contents/MacOS"
for b in wezterm wezterm-gui wezterm-mux-server; do
  test -x "$MACOS/$b" || { echo "::error::smoke: missing $b after update" >&2; exit 1; }
done
GOT="$("$MACOS/wezterm" --version 2>&1 | awk '{print $2}')"
if [ "$GOT" != "$LATEST" ]; then
  echo "::error::smoke: vendored wezterm reports '$GOT', expected '$LATEST'" >&2
  exit 1
fi
echo "✓ smoke passed: vendored wezterm $GOT"
emit updated true
