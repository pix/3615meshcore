"""Screen model for 3615 MESHCORE dumps: dump parser, Minitel font, dot raster.

Shared by minitel_render.py (photo render) and usable on its own:
    python3 -I minitel_screen.py dump.txt -o flat.png     # flat 1:1 dot image
"""
import os
import re
import sys
import unicodedata

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_SFD = os.path.join(HERE, "font", "Minitel.sfd")

# attribute bits (16 bits per cell)
A_INV, A_BLINK, A_LINE, A_BOLD = 0x0001, 0x0002, 0x0004, 0x0008
A_DBLH, A_DBLW, A_MOSAIC, A_CONCEAL = 0x0010, 0x0020, 0x0040, 0x0080
A_CONT = 0x4000

# Minitel 2 (monochrome) grey level of each Vidéotex colour index.
# Luminance order on a mono Minitel: black < blue < red < magenta < green < cyan < yellow < white.
GREY = {0: 0.0, 4: 0.30, 1: 0.45, 5: 0.55, 2: 0.65, 6: 0.75, 3: 0.87, 7: 1.0}

CELL_H = 10


class Screen:
    def __init__(self, cols=40, rows=25):
        self.cols, self.rows = cols, rows
        self.mode, self.page, self.version = "", "", ""
        self.chars = [[" "] * cols for _ in range(rows)]
        self.attrs = np.full((rows, cols), 0x0700, np.uint16)
        self.cursor = None  # (row, col, visible)
        self.seen_rows = 0

    def is_blank(self):
        return all(c == " " for row in self.chars for c in row) and not (self.attrs & A_INV).any()


_KW = re.compile(r"\b(SCREEN|ROW|CURSOR)\b(.*)")


def parse_dump(text):
    """Parse a `screen` dump. Tolerates indents, CLI echo, CR/LF and unrelated lines."""
    header, rows, cursor = {}, {}, None
    for raw in text.replace("\r", "\n").split("\n"):
        m = _KW.search(raw)
        if not m:
            continue
        kw, rest = m.group(1), m.group(2).split()
        try:
            if kw == "SCREEN":
                for tok in rest:
                    if "=" in tok:
                        k, v = tok.split("=", 1)
                        header[k] = v
                    elif tok.startswith("v"):
                        header["version"] = tok
            elif kw == "ROW" and len(rest) >= 2:
                r = int(rest[0])
                txt = bytes.fromhex(rest[1]).decode("utf-8", errors="replace")
                at = rest[2] if len(rest) > 2 else ""
                attrs = [int(at[i:i + 4], 16) for i in range(0, len(at) - 3, 4)]
                rows[r] = (txt, attrs)
            elif kw == "CURSOR" and len(rest) >= 3:
                cursor = (int(rest[0]), int(rest[1]), rest[2] not in ("0", "off"))
        except ValueError:
            continue  # garbled line: skip it
    if not rows and not header:
        raise ValueError("no SCREEN/ROW lines found in dump")
    cols = int(header.get("cols", 0) or 0)
    if cols not in (40, 80):
        cols = 80 if max((len(t) for t, _ in rows.values()), default=40) > 40 else 40
    nrows = int(header.get("rows", 25) or 25)
    scr = Screen(cols, nrows)
    scr.mode = header.get("mode", "")
    scr.page = header.get("page", "")
    scr.version = header.get("version", "")
    for r, (txt, attrs) in rows.items():
        if not 0 <= r < nrows:
            continue
        chars = list(txt)[:cols] + [" "] * max(0, cols - len(txt))
        scr.chars[r] = chars
        for c, a in enumerate(attrs[:cols]):
            scr.attrs[r, c] = a
    scr.seen_rows = len(rows)
    scr.cursor = cursor
    return scr


# ---------------------------------------------------------------- font

_FONT = None


def _raster_glyph(contours):
    """Even-odd fill of pixel-aligned polygons (128 units per dot, 8x10 cell, y from 1024 down)."""
    g = np.zeros((CELL_H, 8), bool)
    yc = 1024 - 128 * (np.arange(CELL_H) + 0.5)
    xc = 128 * (np.arange(8) + 0.5)
    X, Y = np.meshgrid(xc, yc)
    inside = np.zeros_like(g)
    for poly in contours:
        n = len(poly)
        for k in range(n):
            x1, y1 = poly[k]
            x2, y2 = poly[(k + 1) % n]
            if y1 == y2:
                continue
            cross = (y1 > Y) != (y2 > Y)
            xi = x1 + (Y - y1) * (x2 - x1) / (y2 - y1)
            inside ^= cross & (xi > X)
    return inside


def load_font(path=FONT_SFD):
    """Read the CC0 Minitel font (FontForge .sfd, pixel outlines) into {codepoint: 10x8 bool}."""
    global _FONT
    if _FONT is not None:
        return _FONT
    glyphs, enc, in_set, contours, cur = {}, None, False, [], None
    with open(path, encoding="latin-1") as f:
        for line in f:
            s = line.strip()
            if s.startswith("StartChar:"):
                enc, contours, cur = None, [], None
            elif s.startswith("Encoding:"):
                p = s.split()
                if len(p) > 1 and p[1].lstrip("-").isdigit():
                    enc = int(p[1])
            elif s == "SplineSet":
                in_set = True
            elif s == "EndSplineSet":
                in_set = False
                if cur:
                    contours.append(cur)
                cur = None
            elif in_set:
                p = s.split()
                if len(p) >= 3 and p[2] in ("m", "l"):
                    if p[2] == "m":
                        if cur:
                            contours.append(cur)
                        cur = []
                    if cur is not None:
                        cur.append((float(p[0]), float(p[1])))
            elif s == "EndChar" and enc is not None and 0 < enc < 0x110000:
                glyphs[enc] = _raster_glyph(contours)
    glyphs.setdefault(0x20, np.zeros((CELL_H, 8), bool))
    _FONT = glyphs
    return glyphs


# Unicode -> code point present in the font, for chars the font stores elsewhere.
_ALIAS = {
    0x60: 0x2212, 0x2014: 0x2212, 0x2015: 0x2212, 0x2500: 0x2212,  # Minitel G0 0x60 is a long bar
    0x2018: 0x2019, 0xB4: 0x27, 0xA0: 0x20, 0x2502: 0x7C,
    0x2190: 0x2190, 0x2191: 0x2191, 0x2192: 0x2192, 0x2193: 0x2193,
    0xAB: 0x22, 0xBB: 0x22, 0x201C: 0x22, 0x201D: 0x22, 0xB7: 0x2E, 0x2022: 0x2E,
}


def glyph_for(ch):
    font = load_font()
    cp = ord(ch)
    cp = _ALIAS.get(cp, cp)
    g = font.get(cp)
    if g is not None:
        return g
    base = unicodedata.normalize("NFD", ch)[:1]  # É -> E, as the Minitel does (no accented caps)
    if base and ord(base) in font:
        return font[ord(base)]
    if ch.isspace() or unicodedata.category(ch).startswith("C"):
        return font[0x20]
    return font.get(0x3F, font[0x20])


def mosaic_glyph(code, cw, separated):
    """G1 2x3 block mosaic: bits 0..4 and 6 = TL, TR, ML, MR, BL, BR."""
    g = np.zeros((CELL_H, cw), bool)
    xs = [(0, cw // 2), (cw // 2, cw)]
    ys = [(0, 3), (3, 7), (7, 10)]
    bits = [0, 1, 2, 3, 4, 6]
    for i, b in enumerate(bits):
        if code & (1 << b):
            (x0, x1), (y0, y1) = xs[i % 2], ys[i // 2]
            if separated:
                x1, y1 = x1 - 1, y1 - 1
            g[y0:y1, x0:x1] = True
    return g


# ---------------------------------------------------------------- dot raster

def render_dots(scr, dh_up=True, show_cursor=True, blink_on=True):
    """Return (dots float32 [rows*10, cols*cw], cw): phosphor drive level 0..1 per dot.
    blink_on=False is the "off" half of the blink cycle: blinking cells (inverse ones
    included) show only their paper colour, and the cursor is hidden."""
    cols, rows = scr.cols, scr.rows
    cw = 8 if cols <= 40 else 6
    D = np.zeros((rows * CELL_H, cols * cw), np.float32)
    H, W = D.shape
    for r in range(rows):
        for c in range(cols):
            a = int(scr.attrs[r, c])
            if a & A_CONT:
                continue
            ch = scr.chars[r][c]
            fg = GREY.get((a >> 8) & 7, 1.0)
            bg = GREY.get((a >> 11) & 7, 0.0)
            if a & A_BLINK and not blink_on:
                fg = bg                       # the whole cell drops to its paper colour
            elif a & A_INV:
                fg, bg = bg, fg
            if a & A_MOSAIC:
                code = ord(ch) if len(ch) == 1 else 0x20
                g = mosaic_glyph(code & 0x7F, cw, bool(a & A_LINE))
            else:
                g = glyph_for(ch)
                if cw == 6:
                    g = g[:, 1:7]
                g = g.copy()
                if a & A_BOLD:
                    g[:, 1:] |= g[:, :-1]
                if a & A_LINE:
                    g[CELL_H - 1, :] = True
            if a & A_CONCEAL:
                g = np.zeros_like(g)
            sy = 2 if a & A_DBLH else 1
            sx = 2 if a & A_DBLW else 1
            big = np.repeat(np.repeat(g, sy, 0), sx, 1)
            y0 = r * CELL_H - (CELL_H if (sy == 2 and dh_up) else 0)
            x0 = c * cw
            gy0, gx0 = max(0, -y0), 0
            y0c, y1c = max(0, y0), min(H, y0 + big.shape[0])
            x1c = min(W, x0 + big.shape[1])
            if y1c <= y0c or x1c <= x0:
                continue
            blk = big[gy0:gy0 + (y1c - y0c), gx0:gx0 + (x1c - x0)]
            D[y0c:y1c, x0:x1c] = np.where(blk, fg, bg)
    if show_cursor and blink_on and scr.cursor and scr.cursor[2]:
        r, c = scr.cursor[0], scr.cursor[1]
        if 0 <= r < rows and 0 <= c < cols:
            sl = D[r * CELL_H:(r + 1) * CELL_H, c * cw:(c + 1) * cw]
            sl[...] = 1.0 - sl  # Minitel cursor: (blinking) block, shown "on"
    return D, cw


def main(argv=None):
    import argparse
    from PIL import Image
    ap = argparse.ArgumentParser(description="Flat dot image of a 3615 MESHCORE screen dump")
    ap.add_argument("dump")
    ap.add_argument("-o", "--out", default="flat.png")
    ap.add_argument("--scale", type=int, default=3)
    ap.add_argument("--dh-down", action="store_true")
    a = ap.parse_args(argv)
    text = sys.stdin.read() if a.dump == "-" else open(a.dump, encoding="utf-8", errors="replace").read()
    scr = parse_dump(text)
    D, cw = render_dots(scr, dh_up=not a.dh_down)
    sx = a.scale * (2 if cw == 8 else 1)  # keep 40/80 col physically the same width-ish
    img = np.repeat(np.repeat(D, a.scale * 2, 0), sx, 1)
    Image.fromarray((img * 255).astype(np.uint8)).save(a.out)
    print(f"{scr.cols} cols, mode={scr.mode} page={scr.page} -> {a.out}")


if __name__ == "__main__":
    main()
