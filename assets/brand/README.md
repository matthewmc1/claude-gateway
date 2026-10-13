# Brand assets

The mark for **Gateway Budgets**: an archway (the gateway) with a usage gauge standing in the doorway (the budget).
It is original artwork made of one arch stroke and one arc, with no connection to any other company's marks.
Everything here is released under the repository's MIT license, so you can ship it in a fork. If you fork the project
and publish it as your own product, give it your own name and mark.

## Files

| File | Use |
|---|---|
| `logo-mark.svg` | Square mark, transparent, **for light backgrounds** (dark arch) |
| `logo-mark-dark.svg` | Square mark, transparent, **for dark backgrounds** (light arch) |
| `logo-wordmark.svg` / `logo-wordmark-dark.svg` | Mark + "Gateway Budgets", for light / dark backgrounds |
| `icon.svg`, `icon-1024.png`, `icon-512.png` | App icon: opaque dark rounded square (iOS, web manifest, store listings) |
| `favicon.svg`, `favicon.ico`, `favicon-{16,32,48,192}.png`, `apple-touch-icon-180.png` | Small-size icon: heavier strokes, no gauge track or hub so it stays legible at 16 px |
| `adaptive-icon-foreground-1024.png`, `adaptive-icon-background-1024.png`, `adaptive-icon-monochrome-1024.png` | Android adaptive icon layers. Content stays inside the central 66% safe zone |
| `splash-icon-1024.png` / `splash-icon-light-1024.png` | Transparent mark for dark / light splash screens |
| `social-preview-1280x640.png` | GitHub social preview (upload in repo Settings, Social preview) |
| `readme-banner.svg`, `readme-banner-1200x300.png` | README header |
| `src/generate.py`, `build.sh` | How the files are produced (below) |

All text in the SVGs is drawn as stroked paths from a small monoline letterform set defined in `src/generate.py`.
There are no fonts to install, and the files render the same everywhere.

## Colour tokens

| Token | Value | Use |
|---|---|---|
| Accent | `#3987e5` | The gauge value arc. The only brand colour. |
| Dark | `#0d0e11` | Dark backgrounds, mark on light |
| Surface | `#15171c` | Cards and panels on dark |
| Light | `#f4f4f1` | Light backgrounds, mark on dark |
| Muted text on dark | `#a8adb8` | Taglines on dark |

The accent is the same on light and dark. Do not introduce a second brand colour.

## Usage

- **Clear space:** keep at least the width of the arch stroke (about 1/6 of the mark's height) free on every side. For the wordmark, keep the height of the capital "G" clear all round.
- **Minimum size:** the full mark from 32 px, the wordmark from 120 px wide. Below 32 px use `favicon.svg`, not the full mark.
- **Backgrounds:** use the plain variant on light and `-dark` on dark. On photos or mid-tones, put the mark on a solid `#0d0e11` or `#f4f4f1` tile (that is what `icon.svg` is).
- **Do not:** recolour the arch or gauge, stretch or rotate the mark, add shadows or gradients, outline it, change the gauge fill level for effect, retype the name in another font, or place it on a background with too little contrast.
- **Do not:** combine it with, or alter it towards, any other company's logo or mark, including Anthropic's or Claude's.

## Not affiliated notice

Reusable text for the README, the app footer and the docs site:

> Gateway Budgets is an independent, open-source project. It is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic, PBC, used here only to describe what the software works with.

Short form: *Independent open-source project. Not affiliated with Anthropic.*

## Regenerating

Requires `rsvg-convert` (`brew install librsvg`) and Python 3 (standard library only).

```bash
python3 assets/brand/src/generate.py   # only if you changed the artwork: rewrites the SVGs
bash assets/brand/build.sh             # rasterises every PNG and builds favicon.ico
```

`favicon.ico` is assembled from the 16, 32 and 48 px PNGs by a short Python snippet inside `build.sh`, so no ImageMagick is needed.
After changing artwork, open the PNGs and check 16 px and 32 px sizes by eye before committing.
