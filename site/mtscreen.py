"""3615 MESHCORE screen dumps: a dependency-free parser and an HTML/CSS text render.

Used by site/build.py (the gallery's "text" view) and tools/tour/tour.py (reading the
pages it walks). Pure standard library, so `python3 -I` is enough.

Dump format v1 (USB `screen`, see the firmware docs and tools/screenshot/README.md):

    SCREEN v1 cols=<40|80> rows=25 mode=<mixte|videotex> page=<id>
    ROW <r> <text_hex> <attr_hex>      text: UTF-8, one character per cell
    CURSOR <r> <c> <0|1>               attr: 4 hex digits (16 bits) per cell
    OK

Attribute bits: 0 inverse, 1 blink, 2 underline (on a mosaic: separated), 3 bold,
4 double height, 5 double width, 6 mosaic G1, 7 concealed, 8-10 foreground colour,
11-13 background colour, 14 continuation (covered by a double-size neighbour).

The HTML render is one <div> per row, holding runs of cells with the same attributes as
<span>s, in the site's Minitel web fonts (site/tools/make_webfont.py). Every character has
the same advance and the font's ascent + descent equal the row height, so cells line up
without per-cell boxes, and the text stays selectable and copies as plain text:
  - G1 mosaics are the Unicode sextant characters, drawn by the same fonts (a "separated"
    font for the disjoint form);
  - double height / width / size are inline-blocks scaled 2x by CSS transforms; the glyph
    is written on the lower row and grows upward into the row above (the firmware's
    convention), the covered cells are kept as blank space;
  - blink is a CSS animation: in the "off" half the cell shows only its paper colour, as
    the photo renderer does; the visible cursor is an inverted, blinking cell.
"""
import html
import os
import re
import unicodedata

A_INV, A_BLINK, A_LINE, A_BOLD = 0x0001, 0x0002, 0x0004, 0x0008
A_DBLH, A_DBLW, A_MOSAIC, A_CONCEAL = 0x0010, 0x0020, 0x0040, 0x0080
A_CONT = 0x4000
DEFAULT_ATTR = 0x0700   # white on black

HERE = os.path.dirname(os.path.abspath(__file__))
COVERAGE = os.path.join(HERE, "assets", "fonts", "coverage.txt")


class Screen:
    def __init__(self, cols=40, rows=25):
        self.cols, self.rows = cols, rows
        self.mode = self.page = self.version = ""
        self.chars = [[" "] * cols for _ in range(rows)]
        self.attrs = [[DEFAULT_ATTR] * cols for _ in range(rows)]
        self.cursor = None   # (row, col, visible)
        self.seen_rows = 0

    def row_text(self, r):
        return "".join(self.chars[r])

    def text(self):
        return "\n".join(self.row_text(r).rstrip() for r in range(self.rows))

    def is_blank(self):
        return all(c == " " for row in self.chars for c in row) and \
            not any(a & A_INV for row in self.attrs for a in row)


_KW = re.compile(r"\b(SCREEN|ROW|CURSOR)\b(.*)")


def parse_dump(text):
    """Parse a `screen` dump; tolerates indents, the CLI echo, CR/LF and unrelated lines
    (same rules as tools/screenshot/minitel_screen.py, without numpy)."""
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
            continue
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
        chars = list(txt)[:cols]
        scr.chars[r] = chars + [" "] * (cols - len(chars))
        for c, a in enumerate(attrs[:cols]):
            scr.attrs[r][c] = a
    scr.seen_rows = len(rows)
    scr.cursor = cursor
    return scr


def load_dump(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        return parse_dump(f.read())


# ---------------------------------------------------------------- characters

_COVER = None
# as tools/screenshot/minitel_screen.py: characters the Minitel draws with another glyph
_ALIAS = {
    0x60: 0x2212, 0x2014: 0x2212, 0x2015: 0x2212, 0x2500: 0x2212,
    0x2018: 0x2019, 0xB4: 0x27, 0xA0: 0x20, 0x2502: 0x7C,
    0xAB: 0x22, 0xBB: 0x22, 0x201C: 0x22, 0x201D: 0x22, 0xB7: 0x2E, 0x2022: 0x2E,
}


def _coverage():
    global _COVER
    if _COVER is None:
        _COVER = {0x20}
        try:
            with open(COVERAGE) as f:
                for line in f:
                    if not line.startswith("#"):
                        _COVER.update(int(t, 16) for t in line.split())
        except OSError:
            _COVER.update(range(0x21, 0x7F))
    return _COVER


def display_char(ch):
    """The character the Minitel font draws for `ch` (no accented capitals, etc.)."""
    cover = _coverage()
    cp = _ALIAS.get(ord(ch), ord(ch)) if len(ch) == 1 else 0x3F
    if cp in cover:
        return chr(cp)
    base = unicodedata.normalize("NFD", ch)[:1]
    if base and ord(base) in cover:
        return base
    if ch.isspace() or unicodedata.category(ch).startswith("C"):
        return " "
    return "?"


def sextant(code):
    """G1 mosaic code (bits 0-4, 6 = TL TR ML MR BL BR) -> Unicode sextant character."""
    v = 0
    for i, b in enumerate((0, 1, 2, 3, 4, 6)):
        if code & (1 << b):
            v |= 1 << i
    if v == 0:
        return " "
    if v == 21:
        return "▌"
    if v == 42:
        return "▐"
    if v == 63:
        return "█"
    return chr(0x1FB00 + v - 1 - (v > 21) - (v > 42))


# ---------------------------------------------------------------- HTML

def _classes(a, cursor=False):
    """CSS classes and inline style for a cell's attributes."""
    fg, bg = (a >> 8) & 7, (a >> 11) & 7
    paper = bg
    if a & A_INV:
        fg, bg = bg, fg
    if cursor:   # the Minitel cursor: the cell inverted, blinking back to normal
        nfg, nbg = fg, bg
        fg, bg = bg, fg
    cls, style = [], []
    if fg != 7:
        cls.append(f"f{fg}")
    if bg != 0:
        cls.append(f"k{bg}")
    if a & A_MOSAIC:
        cls.append("m")
        if a & A_LINE:
            cls.append("sp")
    else:
        if a & A_LINE:
            cls.append("u")
        if a & A_BOLD:
            cls.append("w")
    if a & A_BLINK:
        cls.append("b")
        if paper:
            style.append(f"--pp:var(--c{paper})")
    if cursor:
        cls.append("cu")
        style.append(f"--cf:var(--c{nfg});--cb:var(--c{nbg})")
    if a & A_CONCEAL:
        cls.append("cc")
    return cls, style


def _span(text, cls, style, extra=None):
    cls = cls + (extra or [])
    attrs = ""
    if cls:
        attrs += f' class="{" ".join(cls)}"'
    if style:
        attrs += f' style="{";".join(style)}"'
    if "m" in cls:
        attrs += ' aria-hidden="true"'
    t = html.escape(text, quote=False)
    return f"<span{attrs}>{t}</span>" if attrs else t


def _cell_text(scr, r, c):
    a = scr.attrs[r][c]
    ch = scr.chars[r][c]
    if a & A_CONCEAL:
        return " "
    if a & A_MOSAIC:
        return sextant(ord(ch) & 0x7F if len(ch) == 1 else 0x20)
    return display_char(ch)


def row_html(scr, r):
    cols = scr.cols
    attrs = scr.attrs[r]
    cur = scr.cursor if scr.cursor and scr.cursor[2] else None
    out = []
    run_text, run_key = [], None

    def flush():
        nonlocal run_text, run_key
        if run_text:
            cls, style = run_key
            out.append(_span("".join(run_text), list(cls), list(style)))
        run_text, run_key = [], None

    c = 0
    while c < cols:
        a = attrs[c]
        if a & A_CONT:
            # the right half of a double-width cell on this row: its space is reserved by the
            # wide cell's margin; anything else (the row above a double height) is blank
            if c > 0 and attrs[c - 1] & A_DBLW and not attrs[c - 1] & A_CONT:
                c += 1
                continue
            key = ((), ())
            if run_key != key:
                flush()
                run_key = key
            run_text.append(" ")
            c += 1
            continue
        is_cur = cur is not None and cur[0] == r and cur[1] == c
        big = a & (A_DBLH | A_DBLW)
        cls, style = _classes(a, is_cur)
        if big or is_cur:
            flush()
            extra = []
            if big:
                extra.append({A_DBLH: "dh", A_DBLW: "dw", A_DBLH | A_DBLW: "ds"}[big])
                if a & A_DBLW and c + 1 < cols:
                    extra.append("rw")   # reserve the covered cell on the right
            out.append(_span(_cell_text(scr, r, c), cls, style, extra))
            c += 1
            continue
        key = (tuple(cls), tuple(style))
        if run_key != key:
            flush()
            run_key = key
        run_text.append(_cell_text(scr, r, c))
        c += 1
    flush()
    return "".join(out)


def screen_html(scr, label="", extra_class=""):
    """The whole screen as HTML: a .mt block of 25 row <div>s."""
    cls = f"mt mt{scr.cols}" + (f" {extra_class}" if extra_class else "")
    aria = f' aria-label="{html.escape(label)}"' if label else ""
    rows = "".join(f'<div class="mr">{row_html(scr, r) or " "}</div>' for r in range(scr.rows))
    return f'<div class="{cls}" role="group"{aria}>{rows}</div>'
