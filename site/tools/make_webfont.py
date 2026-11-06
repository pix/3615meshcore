#!/usr/bin/env python3
"""Build the site's Minitel web fonts (WOFF2) from the CC0 Minitel font.

    uv run --with fonttools --with brotli --with numpy python3 -I site/tools/make_webfont.py

Input: tools/screenshot/font/Minitel.sfd (Zigazou/Minitel-Canvas, Frederic Bisson, CC0 1.0).
The font draws the Minitel ROM characters as pixel outlines on an 8 x 10 dot grid. It is read
with the screenshot tools' own parser (minitel_screen.load_font) and each glyph is rebuilt from
its dots, so the web fonts match the photo renderer dot for dot.

Outputs in site/assets/fonts/ (committed; only rerun this when the font or the cell maths change):

  minitel40.woff2    40-column cell: 8 x 10 dots, advance 1 em, line 1.25 em.
  minitel80.woff2    80-column cell: the same glyphs cropped to dot columns 1-6 and set on
                     narrow dots (2/3 wide), advance 0.5 em, so 80 cells span the same width
                     as 40 (the Minitel's 80-column dots are narrower, not the screen wider).
  minitel40s.woff2   G1 mosaics, separated ("disjoint") form, 40-column cell.
  minitel80s.woff2   the same, 80-column cell.

Both text fonts also carry the G1 mosaics in their contiguous form, at the Unicode sextant
code points (U+1FB00..U+1FB3B, plus U+258C, U+2590, U+2588 for the three sextants Unicode
puts in Block Elements), so a mosaic cell is a character: it copies as a sextant, takes the
inverse, blink and double-size attributes like text, and glows like text.

The vertical metrics are exact: ascent 1 em, descent 0.25 em, no line gap, both in hhea and
OS/2 (USE_TYPO_METRICS), so with line-height 1.25 a row is exactly 10 dots and a span's
background fills its cell with no gap.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools", "screenshot"))

import minitel_screen  # noqa: E402  (the screenshot tools' SFD parser, numpy)
from fontTools.fontBuilder import FontBuilder  # noqa: E402
from fontTools.pens.ttGlyphPen import TTGlyphPen  # noqa: E402

UPM = 1536          # units per em: 8 dots of 192 (40 col), 12 narrow dots of 128 (80 col)
DOT_H = 192         # 10 dots = 1920 = 1.25 em
ASC, DESC = 1536, 384
OUT = os.path.join(ROOT, "site", "assets", "fonts")

# G1 mosaic: bits 0..4 and 6 of the code are TL, TR, ML, MR, BL, BR (as minitel_screen).
SEXTANT_BITS = [0, 1, 2, 3, 4, 6]


def sextant_codepoint(v):
    """v = 6-bit sextant value, bit i = position i+1 (1 TL, 2 TR, 3 ML, 4 MR, 5 BL, 6 BR)."""
    if v == 0:
        return 0x20
    if v == 21:
        return 0x258C   # left half block
    if v == 42:
        return 0x2590   # right half block
    if v == 63:
        return 0x2588   # full block
    return 0x1FB00 + v - 1 - (v > 21) - (v > 42)


def rect(pen, x0, y0, x1, y1):
    # clockwise in y-up coordinates (TrueType outer contour)
    pen.moveTo((x0, y1))
    pen.lineTo((x1, y1))
    pen.lineTo((x1, y0))
    pen.lineTo((x0, y0))
    pen.closePath()


def dots_glyph(bitmap, col0, ncols, dot_w):
    """Glyph from a 10-row bitmap, dot columns col0..col0+ncols-1; one rectangle per run."""
    pen = TTGlyphPen(None)
    any_ = False
    for r in range(bitmap.shape[0]):
        top = ASC - r * DOT_H
        c = 0
        while c < ncols:
            if bitmap[r, col0 + c]:
                s = c
                while c < ncols and bitmap[r, col0 + c]:
                    c += 1
                rect(pen, s * dot_w, top - DOT_H, c * dot_w, top)
                any_ = True
            else:
                c += 1
    return pen.glyph() if any_ else TTGlyphPen(None).glyph()


def mosaic_glyph(v, cw, dot_w, separated):
    pen = TTGlyphPen(None)
    xs = [(0, cw // 2), (cw // 2, cw)]
    ys = [(0, 3), (3, 7), (7, 10)]
    for i in range(6):
        if v & (1 << i):
            (x0, x1), (y0, y1) = xs[i % 2], ys[i // 2]
            if separated:
                x1, y1 = x1 - 1, y1 - 1
            rect(pen, x0 * dot_w, ASC - y1 * DOT_H, x1 * dot_w, ASC - y0 * DOT_H)
    return pen.glyph()


def build(family, wide, text, separated, path):
    cw = 6 if wide else 8
    dot_w = 128 if wide else 192
    adv = cw * dot_w          # 768 (0.5 em) or 1536 (1 em)
    col0 = 1 if wide else 0   # 80 col shows the font's dot columns 1..6
    glyphs, cmap = {".notdef": TTGlyphPen(None).glyph(), "space": TTGlyphPen(None).glyph()}, {0x20: "space"}
    if text:
        for cp, bm in sorted(minitel_screen.load_font().items()):
            if cp <= 0x20 or cp >= 0x10000:
                continue   # control range, and the font's private helper glyphs
            name = f"uni{cp:04X}"
            glyphs[name] = dots_glyph(bm, col0, cw, dot_w)
            cmap[cp] = name
    for v in range(1, 64):
        cp = sextant_codepoint(v)
        name = f"u{cp:05X}" if cp > 0xFFFF else f"uni{cp:04X}"
        glyphs[name] = mosaic_glyph(v, cw, dot_w, separated)
        cmap[cp] = name
    order = list(glyphs)
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    # TrueType places the outline by the hmtx left side bearing (phantom points): it must
    # equal each glyph's xMin, or the glyph is shifted to x = 0.
    glyf = fb.font["glyf"]
    fb.setupHorizontalMetrics({g: (adv, getattr(glyf[g], "xMin", 0) if glyf[g].numberOfContours else 0)
                               for g in order})
    fb.setupHorizontalHeader(ascent=ASC, descent=-DESC, lineGap=0)
    fb.setupNameTable({
        "familyName": family,
        "styleName": "Regular",
        "copyright": "Glyphs from Minitel.sfd, Zigazou/Minitel-Canvas by Frederic Bisson, CC0 1.0",
        "description": "3615 MESHCORE site font, rebuilt dot by dot from the CC0 Minitel font",
    })
    fb.setupOS2(version=4, sTypoAscender=ASC, sTypoDescender=-DESC, sTypoLineGap=0,
                usWinAscent=ASC, usWinDescent=DESC, fsSelection=0x40 | 0x80,
                achVendID="NONE", xAvgCharWidth=adv)
    fb.setupPost(isFixedPitch=1)
    fb.font.flavor = "woff2"
    fb.save(path)
    print(f"{path}: {len(order)} glyphs, advance {adv}/{UPM} em")


def main():
    os.makedirs(OUT, exist_ok=True)
    build("Minitel40", False, True, False, os.path.join(OUT, "minitel40.woff2"))
    build("Minitel80", True, True, False, os.path.join(OUT, "minitel80.woff2"))
    build("Minitel40 Sep", False, False, True, os.path.join(OUT, "minitel40s.woff2"))
    build("Minitel80 Sep", True, False, True, os.path.join(OUT, "minitel80s.woff2"))
    # code points the text fonts cover, for site/build.py (no fontTools needed there)
    cps = sorted(cp for cp in minitel_screen.load_font() if 0x20 < cp < 0x10000)
    with open(os.path.join(OUT, "coverage.txt"), "w") as f:
        f.write("# code points drawn by minitel40/80.woff2 (besides space and the sextants)\n")
        f.write(" ".join(f"{cp:04X}" for cp in cps) + "\n")


if __name__ == "__main__":
    main()
