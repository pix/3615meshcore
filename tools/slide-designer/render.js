// Minitel screen rendering, as tools/screenshot/minitel_screen.py draws it: 8x10 dot cells
// (40 col) or 6x10 (80 col, glyph columns 1..6), the ROM font (Minitel.ttf, rasterised at
// dot centres), G1 sextant mosaics, double height drawn over the row above, Minitel 2 grey
// levels for the Vidéotex colours, bold = smear right, underline = bottom dot row.
(function (root) {
  'use strict';
  const M = root.Minitel;
  const CELL_H = 10;
  // luminance order on a mono Minitel: black < blue < red < magenta < green < cyan < yellow < white
  const GREY = [0.0, 0.45, 0.65, 0.87, 0.30, 0.55, 0.75, 1.0];
  const COLOUR_NAMES = ['noir', 'rouge', 'vert', 'jaune', 'bleu', 'magenta', 'cyan', 'blanc'];
  // the same Unicode -> font code point aliases as minitel_screen.py
  const ALIAS = new Map([
    [0x60, 0x2212], [0x2014, 0x2212], [0x2015, 0x2212], [0x2500, 0x2212],
    [0x2018, 0x2019], [0xB4, 0x27], [0xA0, 0x20], [0x2502, 0x7C],
    [0xAB, 0x22], [0xBB, 0x22], [0x201C, 0x22], [0x201D, 0x22], [0xB7, 0x2E], [0x2022, 0x2E],
  ]);

  let cmap = new Set();
  const glyphs = new Map();
  let fontReady = false;

  function b64ToBuf(b64) {
    const s = atob(b64);
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u.buffer;
  }

  // code points of the font (TrueType cmap format 4 / 12)
  function readCmap(buf) {
    const v = new DataView(buf);
    const set = new Set();
    const nt = v.getUint16(4);
    let cmapOff = 0;
    for (let i = 0; i < nt; i++) {
      const rec = 12 + i * 16;
      const tag = String.fromCharCode(v.getUint8(rec), v.getUint8(rec + 1), v.getUint8(rec + 2), v.getUint8(rec + 3));
      if (tag === 'cmap') cmapOff = v.getUint32(rec + 8);
    }
    if (!cmapOff) return set;
    const n = v.getUint16(cmapOff + 2);
    for (let i = 0; i < n; i++) {
      const off = cmapOff + v.getUint32(cmapOff + 4 + i * 8 + 4);
      const fmt = v.getUint16(off);
      if (fmt === 4) {
        const segX2 = v.getUint16(off + 6);
        const ends = off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
        for (let s = 0; s < segX2 / 2; s++) {
          const end = v.getUint16(ends + s * 2), start = v.getUint16(starts + s * 2);
          const delta = v.getInt16(deltas + s * 2), ro = v.getUint16(ranges + s * 2);
          for (let c = start; c <= end && c !== 0xFFFF; c++) {
            let gi;
            if (ro === 0) gi = (c + delta) & 0xFFFF;
            else {
              const p = ranges + s * 2 + ro + (c - start) * 2;
              gi = v.getUint16(p);
              if (gi) gi = (gi + delta) & 0xFFFF;
            }
            if (gi) set.add(c);
          }
        }
      } else if (fmt === 12) {
        const groups = v.getUint32(off + 12);
        for (let g = 0; g < groups; g++) {
          const p = off + 16 + g * 12;
          const s0 = v.getUint32(p), s1 = v.getUint32(p + 4);
          for (let c = s0; c <= s1 && c - s0 < 4096; c++) set.add(c);
        }
      }
    }
    return set;
  }

  async function loadFont() {
    const buf = b64ToBuf(root.MINITEL_TTF_B64);
    cmap = readCmap(buf);
    const face = new FontFace('MinitelROM', buf);
    await face.load();
    document.fonts.add(face);
    fontReady = true;
    glyphs.clear();
  }

  // rasterise one font glyph: 1024 units per em, 128 units per dot, the cell's top at
  // 1024 units above the baseline (8 dots), 10 dot rows; sampled at the dot centres.
  const K = 16;
  let rc = null;
  function raster(cp) {
    if (!rc) {
      const c = document.createElement('canvas');
      c.width = 8 * K; c.height = CELL_H * K;
      rc = c.getContext('2d', { willReadFrequently: true });
    }
    rc.clearRect(0, 0, 8 * K, CELL_H * K);
    rc.fillStyle = '#fff';
    rc.font = `${8 * K}px MinitelROM`;
    rc.textBaseline = 'alphabetic';
    rc.fillText(String.fromCodePoint(cp), 0, 8 * K);
    const d = rc.getImageData(0, 0, 8 * K, CELL_H * K).data;
    const g = new Uint8Array(CELL_H * 8);
    for (let y = 0; y < CELL_H; y++)
      for (let x = 0; x < 8; x++)
        g[y * 8 + x] = d[((y * K + K / 2) * 8 * K + (x * K + K / 2)) * 4 + 3] > 127 ? 1 : 0;
    return g;
  }

  const EMPTY = new Uint8Array(CELL_H * 8);
  function fontGlyph(cp) {
    if (!cmap.has(cp)) return null;
    if (!glyphs.has(cp)) glyphs.set(cp, raster(cp));
    return glyphs.get(cp);
  }

  // accent dots of a diacritic, from the 'e' that has it in the font
  const E_WITH = { 0x300: 0xE8, 0x301: 0xE9, 0x302: 0xEA, 0x308: 0xEB };
  function glyphFor(cp) {
    const key = 'g' + cp;
    if (glyphs.has(key)) return glyphs.get(key);
    let g = fontGlyph(ALIAS.has(cp) ? ALIAS.get(cp) : cp);
    if (!g) {
      const nfd = String.fromCodePoint(cp).normalize('NFD');
      const base = nfd.codePointAt(0);
      const bg = fontGlyph(base);
      const mark = nfd.length > 1 ? nfd.codePointAt(1) : 0;
      if (bg && E_WITH[mark] && fontGlyph(0x65) && fontGlyph(E_WITH[mark])) {
        // the Minitel draws the G2 accent over any lower-case letter: compose it
        const e = fontGlyph(0x65), ea = fontGlyph(E_WITH[mark]);
        g = bg.slice();
        let lastRow = -1;
        for (let i = 0; i < 80; i++) if (ea[i] && !e[i]) lastRow = Math.floor(i / 8);
        if (base === 0x69) for (let i = 0; i <= lastRow * 8 + 7; i++) g[i] = 0;   // dotless i
        for (let i = 0; i < 80; i++) if (ea[i] && !e[i]) g[i] = 1;
      } else if (bg) g = bg;
      else if (cp <= 0x20) g = EMPTY;
      else g = fontGlyph(0x3F) || EMPTY;
    }
    glyphs.set(key, g);
    return g;
  }

  // G1 mosaic: bits 0..4 and 6 = TL, TR, ML, MR, BL, BR; rows 0-2, 3-6, 7-9
  const MOS_Y = [[0, 3], [3, 7], [7, 10]];
  const MOS_BITS = [1, 2, 4, 8, 16, 64];

  // dots: Float32Array [240 * (cols * cw)] of phosphor levels 0..1
  function renderDots(g, blinkOn) {
    const cols = g.cols, cw = cols === 80 ? 6 : 8;
    const W = cols * cw, H = M.ROWS * CELL_H;
    const D = new Float32Array(W * H);
    for (let r = 1; r <= M.ROWS; r++) {
      for (let c = 1; c <= cols; c++) {
        const i = M.idx(g, r, c);
        const ch = g.ch[i];
        if (ch === M.COVER) continue;
        const a = g.at[i];
        let fg = cols === 80 ? 1.0 : GREY[g.fg[i] & 7];
        let bg = cols === 40 && (a & M.A_MOSAIC) ? GREY[g.bg[i] & 7] : 0.0;   // mosaic background colour
        if ((a & M.A_BLINK) && !blinkOn) fg = bg;
        else if (a & M.A_INV) { const t = fg; fg = bg; bg = t; }
        const sy = (a & M.A_DBLH) ? 2 : 1, sx = (a & M.A_DBLW) ? 2 : 1;
        const y0 = (r - 1) * CELL_H - (sy === 2 ? CELL_H : 0);
        const x0 = (c - 1) * cw;
        const mosaic = !!(a & M.A_MOSAIC);
        let gl = null;
        if (!mosaic) gl = glyphFor(ch);
        for (let y = 0; y < CELL_H * sy; y++) {
          const yy = y0 + y;
          if (yy < 0 || yy >= H) continue;
          const gy = Math.floor(y / sy);
          for (let x = 0; x < cw * sx; x++) {
            const xx = x0 + x;
            if (xx >= W) break;
            const gx = Math.floor(x / sx);
            let on;
            if (mosaic) {
              const col = gx < cw / 2 ? 0 : 1;
              const band = gy < 3 ? 0 : gy < 7 ? 1 : 2;
              on = !!(ch & MOS_BITS[band * 2 + col]);
              if (on && (a & M.A_UL)) {   // disjoint: drop the right column and bottom row of each block
                const x1 = col === 0 ? cw / 2 : cw;
                if (gx === x1 - 1 || gy === MOS_Y[band][1] - 1) on = false;
              }
            } else {
              const fx = cw === 6 ? gx + 1 : gx;
              on = !!gl[gy * 8 + fx];
              if (a & M.A_BOLD && !on && gx > 0) on = !!gl[gy * 8 + fx - 1];
              if ((a & M.A_UL) && gy === CELL_H - 1) on = true;
            }
            D[yy * W + xx] = on ? fg : bg;
          }
        }
      }
    }
    return { D, W, H, cw };
  }

  // Draw dots onto a 2D context of a canvas sized w x h (each dot kx by ky pixels)
  const PHOSPHOR = [228, 236, 255];   // a slightly cool white phosphor
  function paint(ctx, dots, opts) {
    const { D, W, H } = dots;
    const cw = ctx.canvas.width, chh = ctx.canvas.height;
    const kx = cw / W, ky = chh / H;
    const img = ctx.createImageData(cw, chh);
    const p = img.data;
    const scan = opts && opts.crt;
    const xmap = new Int32Array(cw);
    for (let x = 0; x < cw; x++) xmap[x] = Math.min(W - 1, Math.floor((x + 0.5) / kx));
    for (let y = 0; y < chh; y++) {
      const fy = (y + 0.5) / ky;
      const dy = Math.min(H - 1, Math.floor(fy));
      // scan lines: the lower part of each dot row a little darker (only when dots are big enough)
      const shade = scan && ky >= 2 ? (fy - dy > 0.72 ? 0.62 : 1.0) : 1.0;
      const row = dy * W;
      for (let x = 0; x < cw; x++) {
        const v = D[row + xmap[x]] * shade;
        const o = (y * cw + x) * 4;
        p[o] = 6 + v * (PHOSPHOR[0] - 6);
        p[o + 1] = 7 + v * (PHOSPHOR[1] - 7);
        p[o + 2] = 9 + v * (PHOSPHOR[2] - 9);
        p[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  root.MinitelRender = {
    loadFont, renderDots, paint, glyphFor, GREY, COLOUR_NAMES, CELL_H, MOS_BITS, MOS_Y,
    get fontReady() { return fontReady; },
  };
})(typeof self !== 'undefined' ? self : this);
