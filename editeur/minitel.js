// 3615 MESHCORE slide designer: screen model, charset, encoder and decoders.
// Pure JS, no DOM: loaded by index.html and by the Node tests (test/encoder-test.js).
//
// The encoder mirrors the firmware (ui-minitel/MinitelScreen.cpp attrChange, emitCells,
// encodeSpan, encodeClear; MinitelCharset.cpp encodeCell, latinDiacritic, kLatinBase),
// plus the Vidéotex character colour (ESC 0x40+c) as tools/mtl/render.go sends it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Minitel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- attributes (same bits as the firmware's enum Attr) --------------------------------
  const A_INV = 1, A_BOLD = 2, A_UL = 4, A_BLINK = 8, A_DBLH = 16, A_MOSAIC = 32, A_DBLW = 64;
  const ROWS = 24;
  const FG_DEFAULT = 7;
  const SLIDE_MAX = 12288;
  const SLIDES = 8;
  const COVER = 0;   // cell code of the right half of a double-width character

  // ---- grid ------------------------------------------------------------------------------
  // cells are indexed (row - 1) * cols + (col - 1); ch = Unicode code point of a text cell,
  // the G1 code 0x20-0x7F of a mosaic cell, or 0 for a cover cell. fg: Vidéotex character
  // colour 0-7; bg: background colour 0-7, mosaic cells only (40 col; ESC 0x50+c).
  function newGrid(cols) {
    const n = ROWS * cols;
    return { cols, ch: new Uint32Array(n).fill(32), at: new Uint8Array(n), fg: new Uint8Array(n).fill(FG_DEFAULT), bg: new Uint8Array(n) };
  }
  function cloneGrid(g) {
    return { cols: g.cols, ch: g.ch.slice(), at: g.at.slice(), fg: g.fg.slice(), bg: g.bg.slice() };
  }
  function rowLimit(g, row) { return row === ROWS ? g.cols - 1 : g.cols; }
  function idx(g, row, col) { return (row - 1) * g.cols + (col - 1); }

  function gridToJSON(g) {
    const rows = [];
    for (let r = 1; r <= ROWS; r++) {
      let t = '', a = [], f = '', b = '';
      for (let c = 1; c <= g.cols; c++) {
        const i = idx(g, r, c);
        t += String.fromCodePoint(g.ch[i]);
        a.push(g.at[i]);
        f += g.fg[i];
        b += g.bg[i];
      }
      const row = { t, a, f };
      if (/[1-7]/.test(b)) row.b = b;   // background colours: only when there are some
      rows.push(row);
    }
    return { cols: g.cols, rows };
  }
  function gridFromJSON(o) {
    const cols = o && o.cols === 80 ? 80 : 40;
    const g = newGrid(cols);
    (o.rows || []).slice(0, ROWS).forEach((row, ri) => {
      const cps = Array.from(row.t || '').map(s => s.codePointAt(0));
      for (let c = 0; c < cols; c++) {
        const i = ri * cols + c;
        if (c < cps.length) g.ch[i] = cps[c];
        if (row.a && c < row.a.length) g.at[i] = row.a[c] & 0x7F;
        if (row.f && c < row.f.length) g.fg[i] = (+row.f[c]) & 7;
        if (row.b && c < row.b.length) g.bg[i] = (+row.b[c]) & 7;
      }
    });
    normalize(g);
    return g;
  }

  // ---- charset ---------------------------------------------------------------------------
  // Latin-1 0xC0-0xFF: base letter (firmware kLatinBase)
  const kLatinBase = 'AAAAAAACEEEEIIIIDNOOOOOxOUUUUYPsaaaaaaaceeeeiiiidnooooo/ouuuuypy';
  const kLatinExtA =
    'AaAaAaCcCcCcCcDd' + 'DdEeEeEeEeEeGgGg' + 'GgGgHhHhIiIiIiIi' + 'IiJjJjKkkLlLlLlL' +
    'lLlNnNnNnnNnOoOo' + 'OoOoRrRrRrSsSsSs' + 'SsTtTtTtUuUuUuUu' + 'UuUuWwYyYZzZzZzs';

  function latinDiacritic(c) {
    switch (c) {
      case 0xE0: case 0xE8: case 0xEC: case 0xF2: case 0xF9: return 0x41;  // grave
      case 0xE1: case 0xE9: case 0xED: case 0xF3: case 0xFA: return 0x42;  // acute
      case 0xE2: case 0xEA: case 0xEE: case 0xF4: case 0xFB: return 0x43;  // circumflex
      case 0xE4: case 0xEB: case 0xEF: case 0xF6: case 0xFC: return 0x48;  // diaeresis
      case 0xE7: return 0x4B;                                              // cedilla
    }
    return 0;
  }
  function latinBase(c) { return c >= 0xC0 && c <= 0xFF ? kLatinBase.charCodeAt(c - 0xC0) : 0x3F; }

  // Vidéotex G2 (SS2 0x19 + code), beyond the diacritics. The first nine are the firmware's;
  // the arrows, Œ and œ are extra G2 signs of the Minitel the designer can also send.
  const G2_OUT = new Map([
    [0xA3, 0x23], [0xA7, 0x27], [0xB0, 0x30], [0xB1, 0x31], [0xBC, 0x3C], [0xBD, 0x3D],
    [0xBE, 0x3E], [0xDF, 0x7B], [0xF7, 0x38],
    [0x2190, 0x2C], [0x2191, 0x2D], [0x2192, 0x2E], [0x2193, 0x2F], [0x152, 0x6A], [0x153, 0x7A],
  ]);
  const G2_IN = new Map([[0x24, 0x24], [0x26, 0x23]]);
  for (const [cp, b] of G2_OUT) G2_IN.set(b, cp);
  const BAR = 0x2500;   // the Vidéotex G0 0x60 sign (a long horizontal bar)

  // Mixte: the ISO 646 French set through SO .. SI (firmware encodeCell)
  const FR_OUT = new Map([[0xA3, 0x23], [0xE0, 0x40], [0xB0, 0x5B], [0xE7, 0x5C], [0xA7, 0x5D], [0xE9, 0x7B], [0xF9, 0x7C], [0xE8, 0x7D]]);
  const FR_IN = new Map();
  for (const [cp, b] of FR_OUT) FR_IN.set(b, cp);

  function valid40(cp) {
    if (cp >= 0x20 && cp <= 0x7E) return cp !== 0x60;
    return latinDiacritic(cp) !== 0 || G2_OUT.has(cp) || cp === BAR;
  }
  function valid80(cp) { return (cp >= 0x20 && cp <= 0x7E) || FR_OUT.has(cp); }
  function validFor(cp, wide) { return wide ? valid80(cp) : valid40(cp); }

  const FOLD = new Map([
    [0xA0, ' '], [0xA1, '!'], [0xA2, 'c'], [0xA5, 'Y'], [0xA9, 'c'], [0xAB, '"'], [0xBB, '"'], [0xAE, 'R'],
    [0xB2, '2'], [0xB3, '3'], [0xB9, '1'], [0xB5, 'u'], [0xB7, '.'], [0xBF, '?'],
    [0x2018, "'"], [0x2019, "'"], [0x201A, "'"], [0x2032, "'"], [0x02BC, "'"],
    [0x201C, '"'], [0x201D, '"'], [0x201E, '"'], [0x2033, '"'],
    [0x2010, '-'], [0x2011, '-'], [0x2012, '-'], [0x2013, '-'], [0x2014, '-'], [0x2015, '-'], [0x2212, '-'],
    [0x2026, '.'], [0x2022, '*'], [0x2023, '*'], [0x25CF, '*'], [0x20AC, 'E'], [0x2122, 'T'],
    [0x2502, '|'], [0x2503, '|'], [0x2551, '|'], [0x2501, '-'], [0x2550, '-'],
  ]);
  // what the Mixte encoder sends for the 40 col-only signs (firmware: ± + ß s ÷ / ¼½¾ ?)
  const FOLD80 = new Map([
    [0xB1, '+'], [0xDF, 's'], [0xF7, '/'], [0xBC, '?'], [0xBD, '?'], [0xBE, '?'],
    [0x2190, '<'], [0x2192, '>'], [0x2191, '^'], [0x2193, 'v'], [0x152, 'O'], [0x153, 'o'], [BAR, '-'],
  ]);

  // A typed / imported character -> the cell the Minitel can show in that mode (null: nothing).
  function foldChar(cp, wide) {
    if (cp === 9) return 32;
    if (cp < 0x20 || cp === 0x7F || (cp >= 0x80 && cp < 0xA0)) return null;
    if (cp >= 0x300 && cp <= 0x36F) return null;   // combining marks
    if (validFor(cp, wide)) return cp;
    if (cp === 0x60) return 0x27;                   // no backquote in Vidéotex G0 (firmware)
    if (wide && FOLD80.has(cp)) return FOLD80.get(cp).charCodeAt(0);
    if (FOLD.has(cp)) return FOLD.get(cp).charCodeAt(0);
    if (cp >= 0xC0 && cp <= 0xFF) return latinBase(cp);
    if (cp >= 0x100 && cp <= 0x17F) return kLatinExtA.charCodeAt(cp - 0x100);
    if (cp >= 0x2500 && cp <= 0x257F) return wide ? 0x2B : (cp === 0x2500 ? BAR : 0x2B);
    if (cp >= 0x2580 && cp <= 0x259F) return 0x23;
    const base = String.fromCodePoint(cp).normalize('NFD').codePointAt(0);
    if (base >= 0x20 && base < 0x7F) return base;
    return 0x3F;
  }

  // Bytes of one cell (firmware encodeCell, + the extra G2 signs and the G0 bar in 40 col)
  function encodeCell(c, wide) {
    if (c >= 0x20 && c <= 0x7E) {
      if (!wide && c === 0x60) c = 0x27;   // no backquote in the Vidéotex G0 set
      return [c];
    }
    if (!wide) {
      const d = latinDiacritic(c);
      if (d) return [0x19, d, latinBase(c)];
      if (G2_OUT.has(c)) return [0x19, G2_OUT.get(c)];
      if (c === BAR) return [0x60];
      return [c >= 0xC0 && c <= 0xFF ? latinBase(c) : 0x3F];
    }
    if (FR_OUT.has(c)) return [0x0E, FR_OUT.get(c), 0x0F];
    if (FOLD80.has(c)) return [FOLD80.get(c).charCodeAt(0)];
    return [c >= 0xC0 && c <= 0xFF ? latinBase(c) : 0x3F];
  }

  // ---- attributes per mode (firmware effective()) -----------------------------------------
  function effective(a, wide) {
    if (!wide) return a & (A_INV | A_BLINK | A_DBLH | A_DBLW | A_MOSAIC | ((a & A_MOSAIC) ? A_UL : 0));
    let r = a & (A_INV | A_BOLD | A_BLINK | ((a & A_MOSAIC) ? 0 : A_UL));
    if (a & (A_DBLH | A_DBLW)) r |= A_BOLD;
    return r;
  }

  // Mixte has no mosaic: a full block becomes an inverse blank, a thin bar '-' or '_'.
  function mosaicMixte(code, a) {
    const bits = (code & 0x1F) | ((code & 0x40) ? 0x20 : 0);
    if (bits === 0) return [0x20, a];
    if (bits === 0x3F) return [0x20, a | A_INV];
    if ((bits & 0x0F) === 0) return [0x5F, a];
    return [0x2D, a];
  }

  // ---- encoder ---------------------------------------------------------------------------
  function csi(o, s) { o.push(0x1B, 0x5B); for (const ch of s) o.push(ch.charCodeAt(0)); }

  // from / to: {a: effective attributes, fg: colour 0-7 (40 col; 7 in 80 col)}
  function attrChange(o, wide, from, to) {
    if (from.a === to.a && from.fg === to.fg && from.bg === to.bg) return;
    if (!wide) {
      // A_UL only comes with A_MOSAIC here: "lignage" (disjoint mosaics), turned off by SI.
      let ul = from.a & A_UL;
      if ((from.a ^ to.a) & A_MOSAIC) {
        if (ul) o.push(0x1B, 0x59);
        ul = 0;
        o.push((to.a & A_MOSAIC) ? 0x0E : 0x0F);   // SO: G1 mosaic, SI: back to G0
      }
      if ((to.a & A_UL) !== ul) o.push(0x1B, (to.a & A_UL) ? 0x5A : 0x59);   // disjoint / joined
      if ((from.a ^ to.a) & (A_DBLH | A_DBLW))
        o.push(0x1B, 0x4C + ((to.a & A_DBLH) ? 1 : 0) + ((to.a & A_DBLW) ? 2 : 0));
      if (from.fg !== to.fg) o.push(0x1B, 0x40 + to.fg);   // character colour (grey level)
      if (from.bg !== to.bg) o.push(0x1B, 0x50 + to.bg);   // background colour (mosaic cells)
      if ((from.a ^ to.a) & A_INV) o.push(0x1B, (to.a & A_INV) ? 0x5D : 0x5C);
      if ((from.a ^ to.a) & A_BLINK) o.push(0x1B, (to.a & A_BLINK) ? 0x48 : 0x49);
      return;
    }
    // ISO 6429, one SGR per sequence
    let f = from.a;
    const t = to.a;
    if (f & ~t) { csi(o, '0m'); f = 0; }
    if ((t & A_BOLD) && !(f & A_BOLD)) csi(o, '1m');
    if ((t & A_UL) && !(f & A_UL)) csi(o, '4m');
    if ((t & A_BLINK) && !(f & A_BLINK)) csi(o, '5m');
    if ((t & A_INV) && !(f & A_INV)) csi(o, '7m');
  }

  function move(o, wide, row, col) {
    if (!wide) o.push(0x1F, 0x40 + row, 0x40 + col);
    else csi(o, row + ';' + col + 'H');
  }

  function encodeClear(wide) {
    if (!wide) return [0x0C, 0x14];   // FF: clear, home, attributes reset; cursor off
    const o = [0x0F];                 // SI: US set
    csi(o, '0m'); csi(o, '2J'); csi(o, 'H');
    return o;
  }

  const REP_MAX = 63;
  const DEFAULT = { a: 0, fg: FG_DEFAULT, bg: 0 };

  // firmware encodeSpan: move to (row, c0), the cells c0..c1, attributes back to default
  function encodeSpan(g, row, c0, c1, o) {
    o = o || [];
    const wide = g.cols === 80;
    const lim = rowLimit(g, row);
    if (c1 > lim) c1 = lim;
    while (c0 > 1 && g.ch[idx(g, row, c0)] === COVER) c0--;   // never start on a cover cell
    if (c0 < 1 || c0 > c1) return o;
    move(o, wide, row, c0);
    let cur = DEFAULT;
    for (let c = c0; c <= c1; c++) {
      const i = idx(g, row, c);
      const raw = g.at[i];
      let cell = g.ch[i];
      let a = effective(raw, wide);
      const fg = wide ? FG_DEFAULT : g.fg[i];
      const bg = !wide && (raw & A_MOSAIC) ? g.bg[i] : 0;
      if ((raw & A_MOSAIC) && wide) [cell, a] = mosaicMixte(cell, a);
      if (!wide && (cur.a & A_MOSAIC) && cur.bg && !(a & A_MOSAIC)) {
        // after mosaics on a coloured background, the terminal keeps that background as the
        // zone's for the text that follows (a mosaic is a delimiter): end the run, and move
        // (a move puts every attribute back to its default)
        attrChange(o, wide, cur, DEFAULT);
        move(o, wide, row, c);
        cur = DEFAULT;
      }
      const to = { a, fg, bg };
      attrChange(o, wide, cur, to);
      cur = to;
      let len;
      if (a & A_MOSAIC) {
        o.push((cell & 0x7F) | 0x20);
        len = 1;
      } else {
        if (cell === COVER) {
          if (!wide) continue;   // the terminal already moved past it
          cell = 0x20;
        }
        const b = encodeCell(cell, wide);
        for (const v of b) o.push(v);
        len = b.length;
      }
      if (wide || (raw & A_DBLW) || len < 1) continue;
      const rc = g.ch[i];
      let run = 0;   // the same cell, the same attributes, right after it: Vidéotex REP
      while (c + run < c1) {
        const j = i + run + 1;
        if (g.ch[j] !== rc || g.at[j] !== raw || g.fg[j] !== g.fg[i] || g.bg[j] !== g.bg[i]) break;
        run++;
      }
      while (run > 0) {
        const n = run > REP_MAX ? REP_MAX : run;
        if (n * len <= 2) break;   // REP costs 2 bytes: the rest goes out as is
        o.push(0x12, 0x40 + n);
        c += n;
        run -= n;
      }
    }
    attrChange(o, wide, cur, DEFAULT);
    return o;
  }

  function isBlank(g, i) {
    const wide = g.cols === 80;
    return g.ch[i] === 0x20 && effective(g.at[i], wide) === 0 && (wide || (g.fg[i] === FG_DEFAULT && g.bg[i] === 0));
  }

  // The spans a row goes out as: 40 col one span from the first to the last non-blank cell
  // (blank gaps cost at most 3 bytes with REP, as much as a move); 80 col split on gaps of
  // more than 8 blanks (a CSI move costs 6-8 bytes, no REP in Mixte).
  function rowSpans(g, row) {
    const wide = g.cols === 80;
    const lim = rowLimit(g, row);
    const spans = [];
    let start = 0, end = 0, gap = 0;
    for (let c = 1; c <= lim; c++) {
      if (isBlank(g, idx(g, row, c))) { gap++; continue; }
      if (!start) start = c;
      else if (wide && gap > 8) { spans.push([start, end]); start = c; }
      end = c;
      gap = 0;
    }
    if (start) spans.push([start, end]);
    return spans;
  }

  // The whole slide: clear, then each row's spans top to bottom (a double-height row is
  // written after the row above it, so its top halves land over that row, as on screen).
  function encodeSlide(g) {
    const o = encodeClear(g.cols === 80);
    for (let r = 1; r <= ROWS; r++) for (const [a, b] of rowSpans(g, r)) encodeSpan(g, r, a, b, o);
    return Uint8Array.from(o);
  }

  // ---- normalisation: keep a grid something the encoder and the terminal agree on ---------
  function setBlank(g, i) { g.ch[i] = 0x20; g.at[i] = 0; g.fg[i] = FG_DEFAULT; g.bg[i] = 0; }

  function normalize(g) {
    const wide = g.cols === 80;
    for (let r = 1; r <= ROWS; r++) {
      const lim = rowLimit(g, r);
      for (let c = 1; c <= g.cols; c++) {
        const i = idx(g, r, c);
        if (c > lim) { setBlank(g, i); continue; }
        let a = g.at[i] & 0x7F, ch = g.ch[i];
        if (wide) {
          if (a & A_MOSAIC) { [ch, a] = mosaicMixte(ch, a & ~A_MOSAIC & ~A_UL); }
          a &= A_INV | A_BOLD | A_UL | A_BLINK;
          if (ch === COVER) ch = 0x20;
          else if (!valid80(ch)) ch = foldChar(ch, true) || 0x20;
          g.fg[i] = FG_DEFAULT;
          if (ch === 0x20 && !(a & (A_INV | A_UL))) a = 0;
        } else {
          a &= ~A_BOLD;
          if (a & A_MOSAIC) {
            a &= A_MOSAIC | A_UL | A_BLINK;
            ch = (ch & 0x7F) | 0x20;
          } else {
            a &= ~A_UL;
            if (r === 1) a &= ~A_DBLH;   // no double height on row 1
            if (ch !== COVER && !valid40(ch)) ch = foldChar(ch, false) || 0x20;
            if (ch === 0x20 && !(a & (A_INV | A_DBLH | A_DBLW))) { a = 0; g.fg[i] = FG_DEFAULT; }
          }
        }
        g.ch[i] = ch;
        g.at[i] = a;
        if (wide || !(a & A_MOSAIC)) g.bg[i] = 0;
        else g.bg[i] &= 7;
      }
      if (wide) continue;
      // double width: owner + cover cell with the same attributes
      for (let c = 1; c <= lim; c++) {
        const i = idx(g, r, c);
        if (g.ch[i] === COVER) { setBlank(g, i); continue; }   // orphan cover
        if (!(g.at[i] & A_DBLW)) continue;   // (mosaic cells never keep a size)
        if (c + 1 <= lim && g.ch[i + 1] === COVER) {
          g.at[i + 1] = g.at[i];
          g.fg[i + 1] = g.fg[i];
          c++;
        } else {
          g.at[i] &= ~A_DBLW;
          if (g.ch[i] === 0x20 && !(g.at[i] & (A_INV | A_DBLH))) setBlank(g, i);
        }
      }
    }
    return g;
  }

  // ---- 40 <-> 80 conversion ----------------------------------------------------------------
  const BRIGHT = [false, false, true, true, false, true, true, true];   // colour codes at grey >= 0.55
  function convert40to80(g40, offset) {
    const g = newGrid(80);
    for (let r = 1; r <= ROWS; r++) {
      for (let c = 1; c <= 40; c++) {
        const tc = c + offset;
        if (tc < 1 || tc > 80) continue;
        const s = idx(g40, r, c), d = idx(g, r, tc);
        let ch = g40.ch[s], a = g40.at[s];
        if (ch === COVER) { ch = 0x20; }
        if ((a & A_MOSAIC) && (ch & 0x5F) === 0 && BRIGHT[g40.bg[s]]) [ch, a] = [0x20, A_INV | (a & A_BLINK)];
        else if (a & A_MOSAIC) [ch, a] = mosaicMixte(ch, a & A_BLINK);
        else a = effective(a, true);
        g.ch[d] = ch;
        g.at[d] = a;
      }
    }
    return normalize(g);
  }
  function convert80to40(g80, first) {
    const g = newGrid(40);
    for (let r = 1; r <= ROWS; r++) {
      for (let c = 1; c <= 40; c++) {
        const sc = c + first - 1;
        if (sc < 1 || sc > 80) continue;
        const s = idx(g80, r, sc), d = idx(g, r, c);
        g.ch[d] = g80.ch[s];
        g.at[d] = g80.at[s] & (A_INV | A_BLINK);
      }
    }
    return normalize(g);
  }

  // ---- decoders ------------------------------------------------------------------------------
  function composeG2(diacritic, letter) {
    for (let c = 0xE0; c <= 0xFF; c++)
      if (latinDiacritic(c) === diacritic && latinBase(c) === letter) return c;
    return letter;
  }

  // Vidéotex (.vdt) -> 40 col grid. Covers what common pages use: FF, US moves (both forms),
  // BS HT LF VT CR RS CAN, REP, SS2 accents and G2 signs, SO/SI mosaics, ESC attributes
  // (colour, blink, size, inverse, lignage), CSI cursor moves / erases; PRO1-3 skipped.
  function decodeVideotex(bytes) {
    const g = newGrid(40);
    let row = 1, col = 1;
    let st;
    const reset = () => { st = { inv: false, blink: false, dblh: false, dblw: false, fg: FG_DEFAULT, bg: 0, mosaic: false, ul: false }; };
    reset();
    let last = null;   // last sign shown, for REP
    const n = bytes.length;
    let k = 0;
    const next = () => (k < n ? bytes[k++] & 0x7F : -1);
    const clearRow = (r, from, to) => { for (let c = from; c <= to; c++) setBlank(g, idx(g, r, c)); };
    const advance = (w) => {
      col += w;
      if (col > 40) { col = 1; row = row >= 24 ? 1 : row + 1; st.bg = 0; }   // serial attributes end with the row
    };
    const put = (cp, mosaic) => {
      last = { cp, mosaic };
      if (row < 1) { advance(1); return; }   // row 0 (status row): not part of the page
      const i = idx(g, row, col);
      if (mosaic) {
        g.ch[i] = cp; g.at[i] = A_MOSAIC | (st.ul ? A_UL : 0) | (st.blink ? A_BLINK : 0); g.fg[i] = st.fg; g.bg[i] = st.bg;
        advance(1);
        return;
      }
      if (cp === 0x20 && st.bg && !st.inv && !st.dblh && !st.dblw) {
        // a space on a coloured background (text mode): looks like an empty mosaic on that background
        g.ch[i] = 0x20; g.at[i] = A_MOSAIC | (st.blink ? A_BLINK : 0); g.fg[i] = st.fg; g.bg[i] = st.bg;
        advance(1);
        return;
      }
      g.bg[i] = 0;
      const dblw = st.dblw && col < 40;
      const dblh = st.dblh && row > 1;
      let a = (st.inv ? A_INV : 0) | (st.blink ? A_BLINK : 0) | (dblh ? A_DBLH : 0) | (dblw ? A_DBLW : 0);
      g.ch[i] = cp; g.at[i] = a; g.fg[i] = st.fg;
      if (dblw) { g.ch[i + 1] = COVER; g.at[i + 1] = a; g.fg[i + 1] = st.fg; }
      advance(dblw ? 2 : 1);
    };
    while (k < n) {
      const b = next();
      if (b >= 0x20) {
        if (st.mosaic && (b < 0x40 || b >= 0x60)) put(b === 0x7F ? 0x7F : b, true);
        else if (b === 0x7F) continue;
        else if (b === 0x60) put(BAR, false);
        else put(b, false);
        continue;
      }
      switch (b) {
        case 0x08: col--; if (col < 1) { col = 40; if (row > 1) row--; } break;
        case 0x09: advance(1); break;
        case 0x0A: row = row >= 24 ? 1 : row + 1; st.bg = 0; break;
        case 0x0B: if (row > 1) row--; else row = 24; break;
        case 0x0C: for (let i = 0; i < g.ch.length; i++) setBlank(g, i); row = 1; col = 1; reset(); break;
        case 0x0D: col = 1; break;
        case 0x0E: st.mosaic = true; st.ul = false; break;
        case 0x0F: st.mosaic = false; st.ul = false; break;
        case 0x12: {   // REP
          const c = next();
          if (c < 0 || !last) break;
          for (let t = 0; t < (c & 0x3F); t++) put(last.cp, last.mosaic);
          break;
        }
        case 0x18: if (row >= 1) clearRow(row, col, 40); break;   // CAN
        case 0x19: {   // SS2
          const c = next();
          if (c >= 0x41 && c <= 0x4F) {
            const l = next();
            if (l >= 0x20) put(composeG2(c, l), false);
          } else if (G2_IN.has(c)) put(G2_IN.get(c), false);
          else if (c >= 0x20) put(0x3F, false);
          break;
        }
        case 0x1E: row = 1; col = 1; reset(); break;   // RS: home
        case 0x1F: {   // US: position
          const r = next(), c = next();
          if (r < 0 || c < 0) break;
          if (r >= 0x30 && r <= 0x32 && c >= 0x30 && c <= 0x39) { row = (r - 0x30) * 10 + (c - 0x30); col = 1; }
          else { row = r - 0x40; col = c - 0x40; }
          if (row < 0 || row > 24) row = 1;
          if (col < 1 || col > 40) col = 1;
          reset();
          break;
        }
        case 0x1B: {   // ESC
          const c = next();
          if (c >= 0x40 && c <= 0x47) st.fg = c - 0x40;
          else if (c >= 0x50 && c <= 0x57) st.bg = c - 0x50;   // background colour (mosaics; text: spaces only)
          else if (c === 0x48) st.blink = true;
          else if (c === 0x49) st.blink = false;
          else if (c >= 0x4C && c <= 0x4F) { st.dblh = !!((c - 0x4C) & 1); st.dblw = !!((c - 0x4C) & 2); }
          else if (c === 0x5C) st.inv = false;
          else if (c === 0x5D) st.inv = true;
          else if (c === 0x59) st.ul = false;
          else if (c === 0x5A) { if (st.mosaic) st.ul = true; }
          else if (c === 0x39) k += 1;   // PRO1
          else if (c === 0x3A) k += 2;   // PRO2
          else if (c === 0x3B) k += 3;   // PRO3
          else if (c === 0x23) k += 2;   // ESC 23 20 xx: full-screen attribute
          else if (c === 0x28 || c === 0x29 || c === 0x22) k += 1;   // charset designations
          else if (c === 0x5B) {   // CSI
            let p = '', f;
            while ((f = next()) >= 0 && f >= 0x20 && f < 0x40) p += String.fromCharCode(f);
            const nums = p.replace(/^\?/, '').split(';').map(x => parseInt(x, 10));
            const n1 = isNaN(nums[0]) ? 1 : nums[0];
            if (f === 0x41) row = Math.max(1, row - n1);
            else if (f === 0x42) row = Math.min(24, row + n1);
            else if (f === 0x43) col = Math.min(40, col + n1);
            else if (f === 0x44) col = Math.max(1, col - n1);
            else if (f === 0x48 || f === 0x66) { row = Math.min(24, Math.max(1, n1)); col = Math.min(40, Math.max(1, isNaN(nums[1]) ? 1 : nums[1])); }
            else if (f === 0x4A) {
              const m = isNaN(nums[0]) ? 0 : nums[0];
              for (let r = 1; r <= 24; r++) {
                if (m === 2 || (m === 0 && r > row) || (m === 1 && r < row)) clearRow(r, 1, 40);
              }
              if (row >= 1 && m === 0) clearRow(row, col, 40);
              if (row >= 1 && m === 1) clearRow(row, 1, col);
            } else if (f === 0x4B) {
              const m = isNaN(nums[0]) ? 0 : nums[0];
              if (row >= 1) clearRow(row, m === 0 ? col : 1, m === 1 ? col : 40);
            }
          }
          break;
        }
        default: break;   // NUL, BEL, cursor on/off, CON/COF ...
      }
    }
    return normalize(g);
  }

  // Mixte / ISO 6429 (as exported for 80 col) -> 80 col grid
  function decodeMixte(bytes) {
    const g = newGrid(80);
    let row = 1, col = 1, a = 0, fr = false;
    const n = bytes.length;
    let k = 0;
    const clr = (r, c0, c1) => { for (let c = c0; c <= c1; c++) setBlank(g, idx(g, r, c)); };
    while (k < n) {
      const b = bytes[k++] & 0x7F;
      if (b >= 0x20 && b < 0x7F) {
        const cp = fr && FR_IN.has(b) ? FR_IN.get(b) : b;
        const i = idx(g, row, col);
        g.ch[i] = cp; g.at[i] = a;
        col++;
        if (col > 80) { col = 1; if (row < 24) row++; }
        continue;
      }
      if (b === 0x0E) fr = true;
      else if (b === 0x0F) fr = false;
      else if (b === 0x0D) col = 1;
      else if (b === 0x0A) { if (row < 24) row++; }
      else if (b === 0x08) { if (col > 1) col--; }
      else if (b === 0x0C) { for (let i = 0; i < g.ch.length; i++) setBlank(g, i); row = 1; col = 1; }
      else if (b === 0x1B && bytes[k] === 0x5B) {
        k++;
        let p = '', f;
        while (k < n && (f = bytes[k++] & 0x7F) >= 0x20 && f < 0x40) p += String.fromCharCode(f);
        const nums = p.split(';').map(x => parseInt(x, 10));
        const n1 = isNaN(nums[0]) ? 1 : nums[0];
        if (f === 0x48 || f === 0x66) { row = Math.min(24, Math.max(1, n1)); col = Math.min(80, Math.max(1, isNaN(nums[1]) ? 1 : nums[1])); }
        else if (f === 0x41) row = Math.max(1, row - n1);
        else if (f === 0x42) row = Math.min(24, row + n1);
        else if (f === 0x43) col = Math.min(80, col + n1);
        else if (f === 0x44) col = Math.max(1, col - n1);
        else if (f === 0x6D) {
          for (const v of (p === '' ? [0] : nums)) {
            if (v === 0 || isNaN(v)) a = 0;
            else if (v === 1) a |= A_BOLD;
            else if (v === 4) a |= A_UL;
            else if (v === 5) a |= A_BLINK;
            else if (v === 7) a |= A_INV;
            else if (v === 22) a &= ~A_BOLD;
            else if (v === 24) a &= ~A_UL;
            else if (v === 25) a &= ~A_BLINK;
            else if (v === 27) a &= ~A_INV;
          }
        } else if (f === 0x4A) {
          const m = isNaN(nums[0]) ? 0 : nums[0];
          for (let r = 1; r <= 24; r++) if (m === 2 || (m === 0 && r > row) || (m === 1 && r < row)) clr(r, 1, 80);
          if (m === 0) clr(row, col, 80);
          if (m === 1) clr(row, 1, col);
        } else if (f === 0x4B) {
          const m = isNaN(nums[0]) ? 0 : nums[0];
          clr(row, m === 0 ? col : 1, m === 1 ? col : 80);
        }
      }
    }
    return normalize(g);
  }

  // plain text (UTF-8 already decoded) -> grid, one line per row
  function decodeText(text, cols) {
    const g = newGrid(cols);
    const wide = cols === 80;
    text.replace(/\r\n?/g, '\n').split('\n').slice(0, ROWS).forEach((line, ri) => {
      let c = 1;
      for (const ch of line) {
        if (c > cols) break;
        const cp = foldChar(ch.codePointAt(0), wide);
        if (cp == null) continue;
        g.ch[idx(g, ri + 1, c)] = cp;
        c++;
      }
    });
    return normalize(g);
  }

  // what a byte stream looks like: 'vdt', 'mixte' or 'text'
  function sniff(bytes) {
    let esc = 0, csiN = 0, ctl = 0, us = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 0x1B) { esc++; if (bytes[i + 1] === 0x5B) csiN++; }
      else if (b === 0x1F) us++;
      else if (b < 0x20 && b !== 0x0A && b !== 0x0D && b !== 0x09) ctl++;
    }
    if (csiN > 0 && csiN >= esc / 2 && us === 0) return 'mixte';
    if (esc || us || ctl) return 'vdt';
    return 'text';
  }

  return {
    A_INV, A_BOLD, A_UL, A_BLINK, A_DBLH, A_MOSAIC, A_DBLW, ROWS, FG_DEFAULT, SLIDE_MAX, SLIDES, COVER, BAR,
    newGrid, cloneGrid, rowLimit, idx, gridToJSON, gridFromJSON, normalize, setBlank, isBlank,
    latinDiacritic, latinBase, foldChar, valid40, valid80, validFor, encodeCell, effective, mosaicMixte,
    attrChange, encodeClear, encodeSpan, rowSpans, encodeSlide,
    convert40to80, convert80to40, decodeVideotex, decodeMixte, decodeText, sniff, composeG2,
  };
});
