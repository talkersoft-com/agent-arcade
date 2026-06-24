#!/usr/bin/env bash
# Build build/icon.icns from build/icon-1024.png (run build/make_icon.py first).
set -euo pipefail
cd "$(dirname "$0")"

rm -rf icon.iconset && mkdir icon.iconset
while read -r sz name; do
  [ -z "$name" ] && continue
  sips -z "$sz" "$sz" icon-1024.png --out "icon.iconset/icon_${name}.png" >/dev/null
done <<'EOF'
16 16x16
32 16x16@2x
32 32x32
64 32x32@2x
128 128x128
256 128x128@2x
256 256x256
512 256x256@2x
512 512x512
1024 512x512@2x
EOF

iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset
echo "wrote $(pwd)/icon.icns"
