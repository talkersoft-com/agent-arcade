#!/usr/bin/env bash
# Fetch & vendor the PINNED official WezTerm.app into vendor/wezterm/.
#
# Single source of truth for dev, prod, AND ci: package.json "vendor:wezterm"
# (run as part of "build") and .github/workflows/publish.yml both invoke this
# script, so every launch path drives the *same* WezTerm build. That kills the
# version-drift class of bug where a vendored GUI can't attach to a mux started
# by a different wezterm on $PATH ("watch window did not attach").
#
# The download is checksum-verified against the release-published SHA-256 and is
# deterministic for a given tag. Nothing is committed: vendor/wezterm/ is
# gitignored and packed into the npm tarball via package.json "files".
#
# The pinned tag lives in scripts/wezterm.version (single source of truth, read by
# this script AND scripts/check-wezterm-update.sh). Bump it there — or let the
# WezTerm-update workflow open a PR that does.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEZTERM_TAG="$(tr -d '[:space:]' < "$ROOT/scripts/wezterm.version")"
[ -n "$WEZTERM_TAG" ] || { echo "::error::scripts/wezterm.version is empty" >&2; exit 1; }

VENDOR="$ROOT/vendor/wezterm"
DEST="$VENDOR/WezTerm.app"
MACOS="$DEST/Contents/MacOS"
TAGFILE="$VENDOR/.wezterm-tag"

# Idempotent: already vendored at this exact tag with all three binaries? Done.
if [ -f "$TAGFILE" ] && [ "$(cat "$TAGFILE" 2>/dev/null)" = "$WEZTERM_TAG" ] \
   && [ -x "$MACOS/wezterm" ] && [ -x "$MACOS/wezterm-gui" ] && [ -x "$MACOS/wezterm-mux-server" ]; then
  echo "✓ WezTerm $WEZTERM_TAG already vendored → vendor/wezterm/WezTerm.app"
  exit 0
fi

ZIP="WezTerm-macos-${WEZTERM_TAG}.zip"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/wez.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "↓ Fetching WezTerm $WEZTERM_TAG …"
# Prefer authenticated `gh` (kinder to rate limits) but only when it actually has a
# token — inside CI's other steps gh exists WITHOUT GH_TOKEN and would hard-fail.
# Fall back to plain curl: wez/wezterm releases are public, so no auth is needed.
fetched=0
if command -v gh >/dev/null 2>&1 && [ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
  if gh release download "$WEZTERM_TAG" --repo wez/wezterm \
       --pattern "$ZIP" --pattern "$ZIP.sha256" --dir "$TMP" --clobber 2>/dev/null; then
    fetched=1
  fi
fi
if [ "$fetched" -eq 0 ]; then
  base="https://github.com/wez/wezterm/releases/download/$WEZTERM_TAG"
  curl -fsSL "$base/$ZIP"        -o "$TMP/$ZIP"
  curl -fsSL "$base/$ZIP.sha256" -o "$TMP/$ZIP.sha256"
fi

# Verify integrity against the release-published checksum (first 64-hex token).
EXPECTED="$(tr -cd '0-9a-fA-F' < "$TMP/$ZIP.sha256" | cut -c1-64 | tr 'A-F' 'a-f')"
ACTUAL="$(shasum -a 256 "$TMP/$ZIP" | cut -d' ' -f1 | tr 'A-F' 'a-f')"
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "::error::WezTerm checksum mismatch (expected=$EXPECTED actual=$ACTUAL)" >&2
  exit 1
fi
echo "✓ WezTerm SHA-256 verified: $ACTUAL"

rm -rf "$VENDOR"
mkdir -p "$VENDOR" "$TMP/extract"
ditto -x -k "$TMP/$ZIP" "$TMP/extract"
APP="$(find "$TMP/extract" -maxdepth 3 -name 'WezTerm.app' -type d | head -1)"
test -n "$APP" || { echo "::error::WezTerm.app not found in $ZIP" >&2; exit 1; }
cp -R "$APP" "$DEST"

# Official notarized build; strip quarantine so a vendored launch outside
# /Applications doesn't trip Gatekeeper on dev machines. No-op in CI.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

for b in wezterm wezterm-gui wezterm-mux-server; do
  test -x "$MACOS/$b" || { echo "::error::bundled WezTerm missing $b" >&2; exit 1; }
done
echo "$WEZTERM_TAG" > "$TAGFILE"
echo "✓ Bundled WezTerm $WEZTERM_TAG → vendor/wezterm/WezTerm.app"
