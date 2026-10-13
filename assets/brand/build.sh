#!/usr/bin/env bash
# Regenerates every PNG/ICO in assets/brand/ from the SVG sources.
#   bash assets/brand/build.sh            (requires rsvg-convert: brew install librsvg)
# To change the artwork, edit src/generate.py, run `python3 src/generate.py`, then this script.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
command -v rsvg-convert >/dev/null || { echo "rsvg-convert not found (brew install librsvg)" >&2; exit 1; }

r() { # r <svg> <out.png> <width> <height>
  rsvg-convert --width "$3" --height "$4" "$1" -o "$2"
}

r icon.svg                       icon-1024.png                      1024 1024
r icon.svg                       icon-512.png                       512  512
r favicon.svg                    favicon-16.png                     16   16
r favicon.svg                    favicon-32.png                     32   32
r favicon.svg                    favicon-48.png                     48   48
r favicon.svg                    favicon-192.png                    192  192
r favicon.svg                    apple-touch-icon-180.png           180  180
r adaptive-icon-foreground.svg   adaptive-icon-foreground-1024.png  1024 1024
r adaptive-icon-monochrome.svg   adaptive-icon-monochrome-1024.png  1024 1024
r splash-icon.svg                splash-icon-1024.png               1024 1024
r splash-icon-light.svg          splash-icon-light-1024.png         1024 1024
r social-preview.svg             social-preview-1280x640.png        1280 640
r readme-banner.svg              readme-banner-1200x300.png         1200 300
# solid background layer for Android adaptive icons
printf '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#0d0e11"/></svg>' \
  | rsvg-convert --width 1024 --height 1024 -o adaptive-icon-background-1024.png

# favicon.ico: 16/32/48 PNG-compressed entries (no ImageMagick needed)
python3 - <<'PY'
import struct
imgs = [(s, open("favicon-%d.png" % s, "rb").read()) for s in (16, 32, 48)]
off = 6 + 16 * len(imgs)
dirs, data = b"", b""
for s, png in imgs:
    dirs += struct.pack("<BBBBHHII", s, s, 0, 0, 1, 32, len(png), off + len(data))
    data += png
open("favicon.ico", "wb").write(struct.pack("<HHH", 0, 1, len(imgs)) + dirs + data)
PY
echo "built $(ls ./*.png ./favicon.ico | wc -l) raster files"
