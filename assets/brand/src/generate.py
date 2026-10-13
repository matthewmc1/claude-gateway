#!/usr/bin/env python3
"""Generates the SVG files in assets/brand/ (mark, wordmark, banner, cards).

The wordmark is drawn with a small original monoline geometric letterform set
defined below (stroked paths, no fonts), so it renders identically everywhere.
Run:  python3 assets/brand/src/generate.py   then   bash assets/brand/build.sh
"""
import math, os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
ACCENT = "#3987e5"
DARK, SURFACE, LIGHT = "#0d0e11", "#15171c", "#f4f4f1"


def f(n):
    return ("%.2f" % n).rstrip("0").rstrip(".")


# ---------------------------------------------------------------- the mark
# 512x512 box. A doorway (arch) with a usage gauge standing in it.
def mark_body(fg, accent=ACCENT, track_op="0.28", detail=True):
    """Returns SVG elements for the mark, centred in a 512 box (bbox 96..416)."""
    cx, cy, r, sw = 256, 336, 72, 42
    val = 0.66  # share of the gauge that is "used"
    a0 = math.pi  # left
    a1 = math.pi - math.pi * val
    sx, sy = cx + r * math.cos(a0), cy - r * math.sin(a0)
    ex, ey = cx + r * math.cos(a1), cy - r * math.sin(a1)
    arch = ('<path d="M124 416V256a132 132 0 0 1 264 0V416" fill="none" stroke="%s" '
            'stroke-width="56" stroke-linejoin="round"/>' % fg)
    track = ""
    if detail:
        track = ('<path d="M%s %sA%d %d 0 0 1 %s %s" fill="none" stroke="%s" stroke-opacity="%s" '
                 'stroke-width="%d" stroke-linecap="round"/>' %
                 (f(sx), f(sy), r, r, f(cx + r), f(cy), fg, track_op, sw))
    value = ('<path d="M%s %sA%d %d 0 0 1 %s %s" fill="none" stroke="%s" stroke-width="%d" '
             'stroke-linecap="round"/>' % (f(sx), f(sy), r, r, f(ex), f(ey), accent, sw))
    hub = '<circle cx="%d" cy="%d" r="20" fill="%s"/>' % (cx, cy, fg) if detail else ""
    return arch + track + value + hub


def svg(w, h, body, title, desc=None, extra_attrs=""):
    d = "<desc>%s</desc>" % desc if desc else ""
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %s %s" width="%s" height="%s" '
            'role="img" aria-labelledby="t"%s><title id="t">%s</title>%s%s</svg>\n'
            % (w, h, w, h, extra_attrs, title, d, body))


# ---------------------------------------------------------------- wordmark glyphs
# Monoline, centreline paths. Units: x-height 9, cap/ascender 13, descender 4, baseline 0, y down.
GLYPHS = {
    "G": (13, "M11.5 -10.7A6.5 6.5 0 1 0 13 -6.5H7"),
    "a": (9, "M9 -4.5A4.5 4.5 0 1 1 0 -4.5A4.5 4.5 0 1 1 9 -4.5M9 -9V0"),
    "t": (7, "M3 -13V-4A4 4 0 0 0 7 0M0 -9H7"),
    "e": (9, "M0 -4.5H9A4.5 4.5 0 1 0 7.4 -1.05"),
    "w": (13, "M0 -9L3.25 0L6.5 -9L9.75 0L13 -9"),
    "y": (9.4, "M0 -9L4.7 0M9.4 -9L2.2 5"),
    "B": (9.5, "M0 -13V0M0 -13H5A3.25 3.25 0 0 1 5 -6.5H0M0 -6.5H6A3.25 3.25 0 0 1 6 0H0"),
    "u": (9, "M0 -9V-4.5A4.5 4.5 0 0 0 9 -4.5M9 -9V0"),
    "d": (9, "M9 -4.5A4.5 4.5 0 1 1 0 -4.5A4.5 4.5 0 1 1 9 -4.5M9 -13V0"),
    "g": (9, "M9 -4.5A4.5 4.5 0 1 1 0 -4.5A4.5 4.5 0 1 1 9 -4.5M9 -9V0A4 4 0 0 1 5 4H2.5"),
    "s": (8.6, "M8 -8C7 -9.6 2 -10 1.5 -7C1 -4.7 8.6 -5.2 8.6 -2.2C8.6 0.6 2.4 1 0.6 -1.4"),
}
STROKE = 2.5
GAP = 2.4  # between glyph ink edges


def text_paths(text, color, sw=STROKE):
    """Returns (svg group markup, advance width in glyph units incl. stroke)."""
    x = sw / 2
    parts = []
    for ch in text:
        if ch == " ":
            x += 6
            continue
        w, d = GLYPHS[ch]
        parts.append('<path transform="translate(%s 0)" d="%s"/>' % (f(x), d))
        x += w + sw + GAP
    total = x - GAP - sw / 2 + sw / 2
    g = ('<g fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round">%s</g>'
         % (color, f(sw), "".join(parts)))
    return g, total


def wordmark(fg, bg_note):
    # layout in px: mark 512 box scaled to 112 (bbox 96..416 => 70px), text cap height 13 units
    tg, tw = text_paths("Gateway Budgets", fg)
    scale_t = 3.9          # glyph units -> px  (cap ~ 51px)
    mark_s = 0.36          # 512 -> 184px box (bbox 115px)
    mark_px = 512 * mark_s
    pad = 16
    # vertical: text baseline so cap-centre aligns with mark centre
    H = 200
    mark_x = pad - 96 * mark_s + 2  # bbox starts at pad
    mark_y = (H - mark_px) / 2
    text_x = pad + 320 * mark_s + 34
    base_y = H / 2 + (13 / 2) * scale_t - 2
    W = text_x + tw * scale_t + pad
    body = ('<g transform="translate(%s %s) scale(%s)">%s</g>' % (f(mark_x), f(mark_y), f(mark_s), mark_body(fg)) +
            '<g transform="translate(%s %s) scale(%s)">%s</g>' % (f(text_x), f(base_y), f(scale_t), tg))
    return svg(f(W), H, body, "Gateway Budgets", "Gateway Budgets logo: an archway containing a usage gauge. " + bg_note), W, H


def write(name, content):
    with open(os.path.join(OUT, name), "w") as fh:
        fh.write(content)


# ---------------------------------------------------------------- files
# Mark: default for light backgrounds, -dark for dark backgrounds. 512 box, transparent.
write("logo-mark.svg", svg(512, 512, mark_body(DARK), "Gateway Budgets mark",
                           "An archway containing a usage gauge. For light backgrounds."))
write("logo-mark-dark.svg", svg(512, 512, mark_body(LIGHT), "Gateway Budgets mark",
                                "An archway containing a usage gauge. For dark backgrounds."))

wl, W, H = wordmark(DARK, "For light backgrounds.")
write("logo-wordmark.svg", wl)
wd, _, _ = wordmark(LIGHT, "For dark backgrounds.")
write("logo-wordmark-dark.svg", wd)

# App icon: opaque dark rounded square, light arch, accent gauge.
icon_bg = '<rect width="1024" height="1024" rx="230" fill="%s"/>' % DARK
icon_edge = ('<rect x="2" y="2" width="1020" height="1020" rx="228" fill="none" stroke="#ffffff" '
             'stroke-opacity="0.08" stroke-width="4"/>')
# mark bbox 320 in 512-box; scale 1.9 => 608px of 1024 (59%)
s = 1.9
off = 512 - 256 * s
write("icon.svg", svg(1024, 1024, icon_bg + icon_edge +
      '<g transform="translate(%s %s) scale(%s)">%s</g>' % (f(off), f(off), f(s), mark_body(LIGHT)),
      "Gateway Budgets app icon"))

# Small-size icon (favicon): bolder, no track or hub, tighter crop on dark tile.
def mark_small(fg):
    cx, cy, r, sw = 256, 322, 70, 66
    val = 0.62
    a1 = math.pi - math.pi * val
    sx, sy = cx - r, cy
    ex, ey = cx + r * math.cos(a1), cy - r * math.sin(a1)
    return ('<path d="M120 420V256a136 136 0 0 1 272 0V420" fill="none" stroke="%s" stroke-width="72"/>' % fg +
            '<path d="M%s %sA%d %d 0 0 1 %s %s" fill="none" stroke="%s" stroke-width="%d" stroke-linecap="round"/>'
            % (f(sx), f(sy), r, r, f(ex), f(ey), ACCENT, sw))

write("favicon.svg", svg(512, 512,
      '<rect width="512" height="512" rx="112" fill="%s"/>' % DARK +
      '<g transform="translate(256 256) scale(1.05) translate(-256 -256)">%s</g>' % mark_small(LIGHT),
      "Gateway Budgets favicon"))

# Android adaptive foreground: transparent, content inside central 66% (safe zone ~ 676px of 1024).
s = 1.45  # 320*1.45 = 464px  (45%)
off = 512 - 256 * s
write("adaptive-icon-foreground.svg", svg(1024, 1024,
      '<g transform="translate(%s %s) scale(%s)">%s</g>' % (f(off), f(off), f(s), mark_body(LIGHT)),
      "Gateway Budgets adaptive icon foreground"))

# Monochrome (themed icons): single colour silhouette, transparent
def mark_mono(fg):
    return mark_body(fg, accent=fg, detail=False)
write("adaptive-icon-monochrome.svg", svg(1024, 1024,
      '<g transform="translate(%s %s) scale(%s)">%s</g>' % (f(off), f(off), f(s), mark_mono("#000000")),
      "Gateway Budgets adaptive icon monochrome"))

# Splash: transparent mark for dark splash backgrounds, with room around it.
s = 1.3
off = 512 - 256 * s
write("splash-icon.svg", svg(1024, 1024,
      '<g transform="translate(%s %s) scale(%s)">%s</g>' % (f(off), f(off), f(s), mark_body(LIGHT)),
      "Gateway Budgets splash icon"))
write("splash-icon-light.svg", svg(1024, 1024,
      '<g transform="translate(%s %s) scale(%s)">%s</g>' % (f(off), f(off), f(s), mark_body(DARK)),
      "Gateway Budgets splash icon for light backgrounds"))

# Extra glyphs for the tagline (same stroke font)
GLYPHS.update({
    "O": (13, "M13 -6.5A6.5 6.5 0 1 1 0 -6.5A6.5 6.5 0 1 1 13 -6.5"),
    "n": (9, "M0 -9V0M0 -4.5A4.5 4.5 0 0 1 9 -4.5V0"),
    "h": (9, "M0 -13V0M0 -4.5A4.5 4.5 0 0 1 9 -4.5V0"),
    "r": (6, "M0 -9V0M0 -4.5A4.5 4.5 0 0 1 6 -9"),
    "C": (13, "M11.5 -10.7A6.5 6.5 0 1 0 11.5 -2.3"),
    "l": (0, "M0 -13V0"),
    "o": (9, "M9 -4.5A4.5 4.5 0 1 1 0 -4.5A4.5 4.5 0 1 1 9 -4.5"),
    "c": (8.5, "M8 -7.3A4.5 4.5 0 1 0 8 -1.7"),
    "i": (0, "M0 -9V0M0 -13V-13"),
    "p": (9, "M0 -9V4M9 -4.5A4.5 4.5 0 1 1 0 -4.5A4.5 4.5 0 1 1 9 -4.5"),
    "v": (9, "M0 -9L4.5 0L9 -9"),
    "b": (9, "M0 -13V0M9 -4.5A4.5 4.5 0 1 1 0 -4.5A4.5 4.5 0 1 1 9 -4.5"),
    "m": (15, "M0 -9V0M0 -4.5A3.75 3.75 0 0 1 7.5 -4.5V0M7.5 -4.5A3.75 3.75 0 0 1 15 -4.5V0"),
    "k": (8, "M0 -13V0M8 -9L0 -3.5M2.6 -5.4L8 0"),
    "A": (12, "M0 0L6 -13L12 0M2 -4.6H10"),
    "x": (8, "M0 -9L8 0M8 -9L0 0"),
    ":": (0, "M0 -9V-9M0 0V0"),
    ".": (0, "M0 0V0"),
    "f": (6, "M6 -13A4 4 0 0 0 2.5 -10V0M0 -9H6"),
    "-": (5, "M0 -4.5H5"),
})

TAGLINE = "One gateway for Claude Code: attributed, capped, visible."


def tag_paths(color, sw):
    # tagline needs ':' ',' and '.' : build specially. Words are laid out char by char.
    x = sw / 2
    parts = []
    for ch in TAGLINE:
        if ch == " ":
            x += 5.5
            continue
        if ch in ":.,":
            if ch == ":":
                parts.append('<path transform="translate(%s 0)" d="M0 -9V-9M0 0V0"/>' % f(x))
            elif ch == ".":
                parts.append('<path transform="translate(%s 0)" d="M0 0V0"/>' % f(x))
            else:
                parts.append('<path transform="translate(%s 0)" d="M0 0L-0.8 3"/>' % f(x))
            x += sw + GAP
            continue
        if ch == "-":
            pass
        w, d = GLYPHS[ch]
        if ch in "il":
            if ch == "i":
                d = "M0 -9V0M0 -13V-13"
        parts.append('<path transform="translate(%s 0)" d="%s"/>' % (f(x), d))
        x += w + sw + GAP
    g = ('<g fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round">%s</g>'
         % (color, f(sw), "".join(parts)))
    return g, x



# Tagline helpers: split at the colon so it can sit on two lines
TAG1, TAG2 = "One gateway for Claude Code:", "attributed, capped, visible."


def line_paths(text, color, sw=2.0):
    global TAGLINE
    saved, TAGLINE = TAGLINE, text
    try:
        return tag_paths(color, sw)
    finally:
        TAGLINE = saved


MUTED = "#a8adb8"
tg, tw = text_paths("Gateway Budgets", LIGHT)

# Social preview 1280x640: centred stack
W, H = 1280, 640
ms = 0.6
name_s, tag_s = 5.2, 2.5
t1, w1 = line_paths(TAG1, MUTED)
t2, w2 = line_paths(TAG2, MUTED)
body = '<rect width="1280" height="640" fill="%s"/>' % DARK
body += '<rect x="0" y="630" width="1280" height="10" fill="%s"/>' % ACCENT
body += '<g transform="translate(%s %s) scale(%s)">%s</g>' % (f(W / 2 - 256 * ms), f(76 - 96 * ms), f(ms), mark_body(LIGHT))
body += '<g transform="translate(%s %s) scale(%s)">%s</g>' % (f(W / 2 - tw * name_s / 2), f(402), f(name_s), tg)
body += '<g transform="translate(%s %s) scale(%s)">%s</g>' % (f(W / 2 - w1 * tag_s / 2), f(484), f(tag_s), t1)
body += '<g transform="translate(%s %s) scale(%s)">%s</g>' % (f(W / 2 - w2 * tag_s / 2), f(534), f(tag_s), t2)
write("social-preview.svg", svg(W, H, body, "Gateway Budgets", TAGLINE))
print("social widths", tw * name_s, w1 * tag_s, w2 * tag_s)

# README banner 1200x300
W, H = 1200, 300
ms = 0.62
name_s, tag_s = 3.4, 2.1
tx = 64 + 320 * ms + 48
body = '<rect width="1200" height="300" fill="%s"/>' % DARK
body += '<g transform="translate(%s %s) scale(%s)">%s</g>' % (f(64 - 96 * ms), f((H - 320 * ms) / 2 - 96 * ms - 3), f(ms), mark_body(LIGHT))
body += '<g transform="translate(%s %s) scale(%s)">%s</g>' % (f(tx), f(112), f(name_s), tg)
body += '<g transform="translate(%s %s) scale(%s)">%s</g>' % (f(tx), f(174), f(tag_s), t1)
body += '<g transform="translate(%s %s) scale(%s)">%s</g>' % (f(tx), f(216), f(tag_s), t2)
body += '<rect x="0" y="294" width="1200" height="6" fill="%s"/>' % ACCENT
write("readme-banner.svg", svg(W, H, body, "Gateway Budgets", TAGLINE))
print("banner right edge", tx + max(tw * name_s, w1 * tag_s))
