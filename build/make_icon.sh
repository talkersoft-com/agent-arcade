#!/usr/bin/env bash
# Regenerate the app icon: render the PNG (needs a Python with Pillow) then the .icns.
set -euo pipefail
cd "$(dirname "$0")/.."

PY=""
for cand in python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "import PIL" >/dev/null 2>&1; then PY="$cand"; break; fi
done
if [ -z "$PY" ]; then
  echo "error: no Python with Pillow found. Install it: pip3 install Pillow" >&2
  exit 1
fi
echo "rendering icon with $PY"
"$PY" build/make_icon.py
bash build/make_icns.sh
