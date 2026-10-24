#!/usr/bin/env bash
# Renders App/Assets.xcassets/<set>.appiconset/icon.svg (default AppIcon; also
# AppIcon-Spooky) to the opaque 1024 px
# AppIcon-1024.png with headless Chromium (no SVG delegate needed). App Store
# icons must have no alpha channel; iOS applies the corner mask itself. The
# window is taller than the icon because headless Chromium's viewport is
# shorter than its window; the screenshot is cropped back to 1024 x 1024.
set -euo pipefail
SET="${1:-AppIcon}"
cd "$(dirname "$0")/../App/Assets.xcassets/$SET.appiconset"
CHROME="${CHROME:-$(ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome 2>/dev/null | tail -n1)}"
[ -x "${CHROME:-}" ] || CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
{ echo '<html><head><style>html,body{margin:0;overflow:hidden}svg{display:block;width:1024px;height:1024px}</style></head><body>'
  sed '/^<!--/,/-->$/d' icon.svg
  echo '</body></html>'; } > "$tmp/icon.html"
"$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1024,1400 --screenshot="$tmp/raw.png" "file://$tmp/icon.html" 2>/dev/null
python3 -c "from PIL import Image; Image.open('$tmp/raw.png').convert('RGB').crop((0, 0, 1024, 1024)).save('AppIcon-1024.png')"
echo "wrote $(pwd)/AppIcon-1024.png"
# The Watch app needs its own catalog copy of the main icon; asset catalogs can't share files.
if [ "$SET" = AppIcon ]; then cp AppIcon-1024.png ../../../Watch/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png; fi
