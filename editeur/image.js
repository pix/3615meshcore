// Images to Minitel slides: a port of tools/mtl/image.go (greyGrid, ImageVideotex,
// ImageMixte), so that the designer and `mtl slide encode` draw the same picture for the
// same options. Same arithmetic in the same order (float64 both sides) for identical results.
//
// 40 col: 80 x 72 blocks (G1 mosaics, 2 x 3 per cell) in the 8 grey levels; each cell gets
// the (ink, background) pair that draws its six blocks best, with a slight bias towards the
// previous cell's pair (an attribute costs bytes). 80 col: characters by brightness from
// " .:-=+*#%@", inverse blanks for the brightest.
//
// pixels: {w, h, data: RGBA bytes (non-premultiplied)}; opts: {dither, contrast, gamma}
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./minitel.js'));
  else root.MinitelImage = factory(root.Minitel);
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';

  // the picture as w x h values 0..1, fitted (letterboxed, black) in a boxW:boxH box
  function greyGrid(px, w, h, boxW, boxH, o) {
    const iw = px.w, ih = px.h, d = px.data;
    const scale = Math.min(boxW / iw, boxH / ih);   // box units per image pixel
    const offX = (boxW - iw * scale) / 2, offY = (boxH - ih * scale) / 2;
    const cw = boxW / w, ch = boxH / h;
    const g = [];
    let lo = 1.0, hi = 0.0;
    const S = 4;
    for (let y = 0; y < h; y++) {
      const row = new Float64Array(w);
      g.push(row);
      for (let x = 0; x < w; x++) {
        const x0 = (x * cw - offX) / scale, x1 = ((x + 1) * cw - offX) / scale;
        const y0 = (y * ch - offY) / scale, y1 = ((y + 1) * ch - offY) / scale;
        let sum = 0.0, n = 0.0;
        for (let sy = 0; sy < S; sy++) {
          for (let sx = 0; sx < S; sx++) {
            const pxx = x0 + (x1 - x0) * (sx + 0.5) / S;
            const pyy = y0 + (y1 - y0) * (sy + 0.5) / S;
            n++;
            if (pxx < 0 || pyy < 0 || pxx >= iw || pyy >= ih) continue;   // letterbox: black
            const i = (Math.trunc(pyy) * iw + Math.trunc(pxx)) * 4;
            const a = d[i + 3] / 255;
            sum += a * (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
          }
        }
        const v = sum / n;
        row[x] = v;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    for (const row of g) {
      for (let x = 0; x < row.length; x++) {
        let v = row[x];
        if (o.contrast && hi > lo) v = (v - lo) / (hi - lo);
        if (o.gamma > 0 && o.gamma !== 1) v = Math.pow(v, 1 / o.gamma);
        row[x] = v;
      }
    }
    return g;
  }

  // the Minitel colour codes by brightness (black, blue, red, magenta, green, cyan, yellow, white)
  const GREY_CODES = [0, 4, 1, 5, 2, 6, 3, 7];
  const level = (i) => i / 7;
  const BIT_OF = [1, 2, 4, 8, 16, 64];   // TL, TR, ML, MR, BL, BR

  // 40 col: rows[24][40] of {ch: G1 code, fg: grey level index 0-7, bg: grey level index 0-7}
  function videotexCells(px, o) {
    const W = 80, H = 72;
    const g = greyGrid(px, W, H, 320, 240, o);
    const rows = [];
    for (let row = 0; row < 24; row++) {
      const cells = [];
      let pf = 7, pb = 0;   // after a move: white ink, black background
      for (let col = 0; col < 40; col++) {
        const v = new Float64Array(6);
        for (let k = 0; k < 6; k++) v[k] = g[row * 3 + (k >> 1)][col * 2 + k % 2];
        let best = Infinity, bf = 7, bb = 0;
        for (let f = 0; f < 8; f++) {
          for (let bg = 0; bg <= f; bg++) {
            let e = 0.0;
            for (let k = 0; k < 6; k++) {
              const df = v[k] - level(f), db = v[k] - level(bg);
              e += Math.min(df * df, db * db);
            }
            if (f !== pf) e += 0.004;   // an attribute costs 2 bytes: a slight bias to keep them
            if (bg !== pb) e += 0.004;
            if (e < best) { best = e; bf = f; bb = bg; }
          }
        }
        let bits = 0;
        for (let k = 0; k < 6; k++) {
          const df = v[k] - level(bf), db = v[k] - level(bb);
          const on = df * df < db * db;
          if (on) bits |= BIT_OF[k];
          if (o.dither) {   // this block's error to its right and lower neighbours not decided yet
            const q = on ? level(bf) : level(bb);
            const e = v[k] - q;
            const x = col * 2 + k % 2, y = row * 3 + (k >> 1);
            const spread = (dx, dy, wt) => {
              const xx = x + dx, yy = y + dy;
              if (xx < 0 || xx >= W || yy >= H || (Math.trunc(yy / 3) === row && Math.trunc(xx / 2) === col) ||
                  (Math.trunc(yy / 3) === row && Math.trunc(xx / 2) < col)) return;
              g[yy][xx] = Math.max(0, Math.min(1, g[yy][xx] + e * wt));
            };
            spread(1, 0, 7.0 / 16);
            spread(-1, 1, 3.0 / 16);
            spread(0, 1, 5.0 / 16);
            spread(1, 1, 1.0 / 16);
          }
        }
        if (bits === 0) bf = pf;            // a plain background: keep the ink as it is
        else if (bits === 0x5F) bb = pb;    // a full block: keep the background as it is
        cells.push({ ch: 0x20 | bits, fg: bf, bg: bb });
        pf = bf; pb = bb;
      }
      rows.push(cells);
    }
    return rows;
  }

  // mtl's own byte writer for those cells (ImageVideotex): used to check the port
  function videotexBytes(rows) {
    const out = [0x0C, 0x14];
    for (let row = 0; row < 24; row++) {
      const cells = rows[row];
      let last = row === 23 ? 38 : 39;
      while (last >= 0 && cells[last].ch === 0x20 && cells[last].bg === 0) last--;
      if (last < 0) continue;
      out.push(0x1F, 0x41 + row, 0x41, 0x0E);
      let fg = 7, bg = 0;
      for (let c = 0; c <= last; c++) {
        const cl = cells[c];
        if (cl.fg !== fg) { out.push(0x1B, 0x40 + GREY_CODES[cl.fg]); fg = cl.fg; }
        if (cl.bg !== bg) { out.push(0x1B, 0x50 + GREY_CODES[cl.bg]); bg = cl.bg; }
        out.push(cl.ch);
        let run = 0;
        const same = (a, b) => a.ch === b.ch && a.fg === b.fg && a.bg === b.bg;
        while (c + run < last && same(cells[c + run + 1], cl)) run++;
        while (run > 2) {
          const n = run > 63 ? 63 : run;
          out.push(0x12, 0x40 + n);
          c += n;
          run -= n;
        }
      }
    }
    out.push(0x0F);
    return Uint8Array.from(out);
  }

  // 80 col: rows[24] of {chars: string of 80, inv: bool[80]}
  const RAMP = ' .:-=+*#%@';
  function mixteCells(px, o) {
    const W = 80, H = 24;
    const g = greyGrid(px, W, H, 480, 240, o);
    const rows = [];
    for (let y = 0; y < H; y++) {
      let chars = '';
      const inv = new Array(W).fill(false);
      for (let x = 0; x < W; x++) {
        const v = g[y][x];
        if (o.dither) {
          const q = Math.round(v * RAMP.length) / RAMP.length;
          const e = v - q;
          if (x + 1 < W) g[y][x + 1] = Math.max(0, Math.min(1, g[y][x + 1] + e * 7 / 16));
          if (y + 1 < H) g[y + 1][x] = Math.max(0, Math.min(1, g[y + 1][x] + e * 5 / 16));
        }
        let c = ' ';
        if (v > 0.9) inv[x] = true;
        else {
          let i = Math.trunc(v * RAMP.length);
          if (i >= RAMP.length) i = RAMP.length - 1;
          c = RAMP[i];
        }
        chars += c;
      }
      rows.push({ chars, inv });
    }
    return rows;
  }

  // mtl's own byte writer (ImageMixte)
  function mixteBytes(rows) {
    const out = [];
    const s = (t) => { for (const ch of t) out.push(ch.charCodeAt(0)); };
    s('\x0f\x1b[0m\x1b[2J\x1b[H');
    const W = 80, H = 24;
    for (let y = 0; y < H; y++) {
      const { chars, inv } = rows[y];
      let last = -1;
      for (let x = 0; x < W; x++) if (chars[x] !== ' ' || inv[x]) last = x;
      if (y === H - 1 && last === W - 1) last = W - 2;
      if (last < 0) continue;
      s('\x1b[' + (y + 1) + ';1H');
      let on = false;
      for (let x = 0; x <= last; x++) {
        if (inv[x] !== on) { s(inv[x] ? '\x1b[7m' : '\x1b[0m'); on = inv[x]; }
        out.push(chars.charCodeAt(x));
      }
      if (on) s('\x1b[0m');
    }
    return Uint8Array.from(out);
  }

  // ---- into the editor's model ----------------------------------------------------------------
  function toGrid40(rows) {
    const g = M.newGrid(40);
    for (let r = 0; r < 24; r++) {
      let last = 39;   // a black tail stays plain blanks (mtl does not send it either)
      while (last >= 0 && rows[r][last].ch === 0x20 && rows[r][last].bg === 0) last--;
      for (let c = 0; c <= last; c++) {
        const cl = rows[r][c], i = M.idx(g, r + 1, c + 1);
        g.ch[i] = cl.ch;
        g.at[i] = M.A_MOSAIC;
        g.fg[i] = GREY_CODES[cl.fg];
        g.bg[i] = GREY_CODES[cl.bg];
      }
    }
    return M.normalize(g);
  }
  function toGrid80(rows) {
    const g = M.newGrid(80);
    for (let r = 0; r < 24; r++) {
      for (let c = 0; c < 80; c++) {
        const i = M.idx(g, r + 1, c + 1);
        g.ch[i] = rows[r].chars.charCodeAt(c);
        g.at[i] = rows[r].inv[c] ? M.A_INV : 0;
      }
    }
    return M.normalize(g);
  }

  function convert(px, cols, o) {
    return cols === 80 ? toGrid80(mixteCells(px, o)) : toGrid40(videotexCells(px, o));
  }

  return { greyGrid, videotexCells, videotexBytes, mixteCells, mixteBytes, toGrid40, toGrid80, convert, GREY_CODES, RAMP };
});
