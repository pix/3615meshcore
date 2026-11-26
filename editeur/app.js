// 3615 MESHCORE slide designer: the editor UI.
(function () {
  'use strict';
  const M = window.Minitel, R = window.MinitelRender, MI = window.MinitelImage;
  const $ = (s) => document.querySelector(s);
  const STORE_KEY = 'minitel-slide-designer.v1';
  const PREFS_KEY = 'minitel-slide-designer.prefs';
  let CW = 960, CH = 720;   // canvas pixels (set to the displayed size x devicePixelRatio by fitScreen)

  // ---- project ---------------------------------------------------------------------------
  let project = null;
  let cur = 0;          // current slide index
  let mode = 40;        // version shown
  const uid = () => Math.random().toString(36).slice(2, 10);
  const newSlide = (name) => ({ id: uid(), name, slot: null, v40: M.newGrid(40), v80: null });

  function freshProject() {
    return { name: 'My slides', slides: [newSlide('Slide 1')] };
  }
  function projectToJSON() {
    return {
      format: 'minitel-slide-designer', version: 1, name: project.name,
      slides: project.slides.map(s => ({ name: s.name, slot: s.slot, v40: s.v40 ? M.gridToJSON(s.v40) : null, v80: s.v80 ? M.gridToJSON(s.v80) : null })),
    };
  }
  function projectFromJSON(o) {
    if (!o || !Array.isArray(o.slides)) throw new Error('not a slide designer project');
    const p = {
      name: typeof o.name === 'string' ? o.name : 'Slides',
      slides: o.slides.map((s, i) => ({
        id: uid(),
        name: typeof s.name === 'string' ? s.name : `Slide ${i + 1}`,
        slot: Number.isInteger(s.slot) && s.slot >= 1 && s.slot <= M.SLIDES ? s.slot : null,
        v40: s.v40 ? M.gridFromJSON(Object.assign({}, s.v40, { cols: 40 })) : null,
        v80: s.v80 ? M.gridFromJSON(Object.assign({}, s.v80, { cols: 80 })) : null,
      })),
    };
    if (!p.slides.length) p.slides.push(newSlide('Slide 1'));
    return p;
  }

  const slide = () => project.slides[cur];
  const grid = () => slide()['v' + mode];
  const wide = () => mode === 80;

  // ---- editor state ------------------------------------------------------------------------
  const ed = {
    r: 1, c: 1, homeCol: 1,
    sel: null, anchor: null,
    tool: 'text',
    pen: { inv: false, blink: false, dblh: false, dblw: false, fg: 7, bgc: 0, bold: false, ul: false, disjoint: false },
    hover: null,      // {r, c, X, Y}
    lastType: 0,
    clip: null,       // {w, h, ch, at, fg, text}
  };
  const prefs = { crt: true, grid: false, blink: false };

  // ---- undo -------------------------------------------------------------------------------
  const history = new Map();
  function hist() {
    const k = slide().id + ':' + mode;
    if (!history.has(k)) history.set(k, { undo: [], redo: [] });
    return history.get(k);
  }
  function beginEdit(coalesce) {
    const g = grid();
    const now = Date.now();
    if (coalesce && now - ed.lastType < 1500) { ed.lastType = now; return; }
    ed.lastType = coalesce ? now : 0;
    const h = hist();
    h.undo.push(g ? M.cloneGrid(g) : null);
    if (h.undo.length > 200) h.undo.shift();
    h.redo.length = 0;
  }
  function undo(redo) {
    const h = hist();
    const from = redo ? h.redo : h.undo, to = redo ? h.undo : h.redo;
    if (!from.length) return;
    const g = grid();
    to.push(g ? M.cloneGrid(g) : null);
    slide()['v' + mode] = from.pop();
    ed.lastType = 0;
    applyMode();
    changed();
  }

  // ---- canvas -----------------------------------------------------------------------------
  const crt = $('#crt'), ov = $('#overlay');
  const cctx = crt.getContext('2d'), octx = ov.getContext('2d');
  let blinkOn = true, frameQueued = false;
  function invalidate() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(() => { frameQueued = false; draw(); });
  }
  function draw() {
    const g = grid();
    const empty = $('#empty');
    if (!g) {
      cctx.fillStyle = '#050607'; cctx.fillRect(0, 0, CW, CH);
      octx.clearRect(0, 0, CW, CH);
      empty.hidden = false;
      const other = mode === 40 ? 80 : 40;
      $('#emptyText').textContent = `This slide has no ${mode} col version: the Minitel skips it in ${mode === 40 ? 'Vidéotex (40 col)' : 'Mixte (80 col)'} mode.`;
      $('#emptyConv').disabled = !slide()['v' + other];
      $('#emptyConv').textContent = `Convert from the ${other} col version`;
      return;
    }
    empty.hidden = true;
    if (R.fontReady) R.paint(cctx, R.renderDots(g, prefs.blink ? blinkOn : true), { crt: prefs.crt });
    crt.classList.toggle('crt', prefs.crt);
    drawOverlay(g);
  }
  function cellW() { return CW / (mode === 80 ? 80 : 40); }
  let CELL_PX_H = CH / 24;
  function drawOverlay(g) {
    octx.clearRect(0, 0, CW, CH);
    const cw = cellW();
    if (prefs.grid) {
      octx.strokeStyle = 'rgba(140, 170, 255, 0.10)';
      octx.lineWidth = 1;
      octx.beginPath();
      for (let c = 1; c < g.cols; c++) { const x = Math.round(c * cw) + 0.5; octx.moveTo(x, 0); octx.lineTo(x, CH); }
      for (let r = 1; r < 24; r++) { const y = r * CELL_PX_H + 0.5; octx.moveTo(0, y); octx.lineTo(CW, y); }
      octx.stroke();
    }
    if (ed.sel) {
      const s = ed.sel;
      const x = (s.c0 - 1) * cw, y = (s.r0 - 1) * CELL_PX_H;
      const w = (s.c1 - s.c0 + 1) * cw, h = (s.r1 - s.r0 + 1) * CELL_PX_H;
      octx.fillStyle = 'rgba(240, 166, 64, 0.16)';
      octx.fillRect(x, y, w, h);
      octx.strokeStyle = 'rgba(240, 166, 64, 0.9)';
      octx.setLineDash([6, 4]);
      octx.lineWidth = 2;
      octx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      octx.setLineDash([]);
    }
    // hover sextant (draw / erase)
    if (ed.hover && (ed.tool === 'draw' || ed.tool === 'erase') && mode === 40) {
      const { X, Y } = ed.hover;
      const x0 = Math.floor(X / 2) * cw + (X % 2) * cw / 2;
      const yb = R.MOS_Y[Y % 3];
      const y0 = Math.floor(Y / 3) * CELL_PX_H + yb[0] * 3;
      octx.strokeStyle = ed.tool === 'erase' ? 'rgba(226, 104, 91, 0.9)' : 'rgba(240, 166, 64, 0.9)';
      octx.lineWidth = 1.5;
      octx.strokeRect(x0 + 0.75, y0 + 0.75, cw / 2 - 1.5, (yb[1] - yb[0]) * 3 - 1.5);
    }
    // cursor: the footprint of the next character
    const focused = document.activeElement === kbd;
    const w = (mode === 40 && ed.pen.dblw) ? 2 : 1;
    const tall = mode === 40 && ed.pen.dblh && ed.r > 1;
    const x = (ed.c - 1) * cw, y = (ed.r - (tall ? 2 : 1)) * CELL_PX_H;
    octx.strokeStyle = focused ? '#f0a640' : 'rgba(240, 166, 64, 0.45)';
    octx.lineWidth = 2;
    if (!focused) octx.setLineDash([4, 3]);
    octx.strokeRect(x + 1, y + 1, Math.min(w, g.cols - ed.c + 1) * cw - 2, (tall ? 2 : 1) * CELL_PX_H - 2);
    octx.setLineDash([]);
    if (focused && ed.tool === 'text') {
      octx.fillStyle = 'rgba(240, 166, 64, 0.9)';
      octx.fillRect(x + 2, y + (tall ? 2 : 1) * CELL_PX_H - 4, Math.min(w, g.cols - ed.c + 1) * cw - 4, 2);
    }
  }

  function fitScreen() {
    const wrap = $('#screenWrap'), bez = $('#bezel'), scr = $('#screen');
    const pad = 36 + 44;   // wrap padding + bezel padding
    const aw = wrap.clientWidth - pad, ah = wrap.clientHeight - pad;
    let w = Math.max(200, Math.min(aw, ah * 4 / 3));
    w = Math.floor(w);
    const h = Math.floor(w * 3 / 4);
    scr.style.width = w + 'px';
    scr.style.height = h + 'px';
    bez.style.display = 'block';
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (pw !== CW || ph !== CH) {
      CW = crt.width = ov.width = pw;
      CH = crt.height = ov.height = ph;
      CELL_PX_H = CH / 24;
      draw();
    }
  }

  // ---- cells -----------------------------------------------------------------------------------
  function clearCell(g, r, c) {
    if (r < 1 || r > 24 || c < 1 || c > g.cols) return;
    const i = M.idx(g, r, c);
    if (g.ch[i] === M.COVER && c > 1) M.setBlank(g, i - 1);
    else if ((g.at[i] & M.A_DBLW) && c < g.cols && g.ch[i + 1] === M.COVER) M.setBlank(g, i + 1);
    M.setBlank(g, i);
  }
  function penAttr() {
    const p = ed.pen;
    if (wide()) return (p.inv ? M.A_INV : 0) | (p.blink ? M.A_BLINK : 0) | (p.bold ? M.A_BOLD : 0) | (p.ul ? M.A_UL : 0);
    return (p.inv ? M.A_INV : 0) | (p.blink ? M.A_BLINK : 0) | (p.dblh ? M.A_DBLH : 0) | (p.dblw ? M.A_DBLW : 0);
  }
  function mosaicAttr() { return M.A_MOSAIC | (ed.pen.disjoint ? M.A_UL : 0) | (ed.pen.blink ? M.A_BLINK : 0); }

  // write one character with attributes a; returns the columns it takes (0: no room)
  function writeChar(g, r, c, cp, a, fg) {
    const lim = M.rowLimit(g, r);
    if (r === 1) a &= ~M.A_DBLH;
    const w = (a & M.A_DBLW) ? 2 : 1;
    if (c < 1 || c + w - 1 > lim) return 0;
    for (let k = 0; k < w; k++) clearCell(g, r, c + k);
    const i = M.idx(g, r, c);
    g.ch[i] = cp; g.at[i] = a; g.fg[i] = wide() ? 7 : fg;
    if (w === 2) { g.ch[i + 1] = M.COVER; g.at[i + 1] = a; g.fg[i + 1] = g.fg[i]; }
    if (a & M.A_DBLH) for (let k = 0; k < w; k++) clearCell(g, r - 1, c + k);   // covered by the top half
    return w;
  }

  function ownerCol(g, r, c) {
    return c > 1 && g.ch[M.idx(g, r, c)] === M.COVER ? c - 1 : c;
  }

  // ---- edits -------------------------------------------------------------------------------------
  function changed() {
    const g = grid();
    if (g) M.normalize(g);
    invalidate();
    updateSizes();
    updateStatus();
    scheduleSave();
    scheduleThumb(cur);
  }

  function moveCursor(r, c, keepSel) {
    const g = grid();
    if (!g) return;
    ed.r = Math.max(1, Math.min(24, r));
    ed.c = Math.max(1, Math.min(M.rowLimit(g, ed.r), c));
    if (!keepSel) { ed.sel = null; ed.anchor = null; }
    invalidate();
    updateStatus();
  }

  function typeChar(cp) {
    const g = grid();
    if (!g) return;
    const f = M.foldChar(cp, wide());
    if (f == null) return;
    if (mode === 40 && ed.pen.dblh && ed.r === 1) setMsg('Double height cannot go on row 1: written normal height', 'err');
    beginEdit(true);
    const w = writeChar(g, ed.r, ed.c, f, penAttr(), ed.pen.fg);
    if (!w) { setMsg('No room for a double-width character here', 'err'); return; }
    ed.sel = null;
    let c = ed.c + w, r = ed.r;
    if (c > M.rowLimit(g, r)) { c = ed.homeCol; r = Math.min(24, r + lineStep()); }
    ed.r = r; ed.c = Math.min(c, M.rowLimit(g, r));
    if (f !== cp && cp > 0x7F) setMsg(`${String.fromCodePoint(cp)} is not on the Minitel in ${mode} col: written as ${String.fromCodePoint(f)}`);
    changed();
  }
  const lineStep = () => (mode === 40 && ed.pen.dblh) ? 2 : 1;

  function selRect() {
    const g = grid();
    if (ed.sel) return ed.sel;
    return { r0: 1, c0: 1, r1: 24, c1: g.cols };
  }
  function forRect(fn) {
    const g = grid(), s = selRect();
    for (let r = s.r0; r <= s.r1; r++) for (let c = s.c0; c <= s.c1; c++) if (c <= M.rowLimit(g, r)) fn(g, r, c);
  }
  function actClear() {
    if (!grid()) return;
    beginEdit();
    forRect((g, r, c) => clearCell(g, r, c));
    changed();
  }
  function actFill() {
    const g = grid();
    if (!g) return;
    const v = $('#fillChar').value;
    const cp = M.foldChar(v ? v.codePointAt(0) : 32, wide());
    if (cp == null) return;
    beginEdit();
    const s = selRect(), a = penAttr();
    const w = (a & M.A_DBLW) ? 2 : 1;
    for (let r = s.r0; r <= s.r1; r += ((a & M.A_DBLH) && s.r1 > s.r0 ? 2 : 1)) {
      const rr = (a & M.A_DBLH) && s.r1 > s.r0 ? Math.min(r + 1, s.r1) : r;
      for (let c = s.c0; c + w - 1 <= s.c1; c += w) writeChar(g, rr, c, cp, a, ed.pen.fg);
    }
    changed();
  }
  function actFillMosaic() {
    if (!grid() || mode !== 40) return;
    beginEdit();
    forRect((g, r, c) => { clearCell(g, r, c); const i = M.idx(g, r, c); g.ch[i] = 0x7F; g.at[i] = mosaicAttr(); g.fg[i] = ed.pen.fg; g.bg[i] = ed.pen.bgc; });
    changed();
  }
  function paintCell(g, r, c) {
    c = ownerCol(g, r, c);
    const i = M.idx(g, r, c);
    const p = ed.pen;
    if (wide()) {
      g.at[i] = (g.at[i] & ~(M.A_INV | M.A_BLINK | M.A_BOLD | M.A_UL)) | penAttr();
      return;
    }
    if (g.at[i] & M.A_MOSAIC) { g.at[i] = mosaicAttr(); g.fg[i] = p.fg; g.bg[i] = p.bgc; return; }
    g.at[i] = (g.at[i] & ~(M.A_INV | M.A_BLINK)) | (p.inv ? M.A_INV : 0) | (p.blink ? M.A_BLINK : 0);
    g.fg[i] = p.fg;
    if (g.at[i] & M.A_DBLW && c < g.cols) { g.at[i + 1] = g.at[i]; g.fg[i + 1] = g.fg[i]; }
  }
  function actApply() {
    if (!grid()) return;
    beginEdit();
    forRect(paintCell);
    changed();
  }

  // mosaic sextants: X 0..79, Y 0..71
  function sextant(g, X, Y, on) {
    const r = Math.floor(Y / 3) + 1, c = Math.floor(X / 2) + 1;
    if (r < 1 || r > 24 || c < 1 || c > M.rowLimit(g, r)) return;
    const bit = R.MOS_BITS[(Y % 3) * 2 + (X % 2)];
    const i = M.idx(g, r, c);
    if (!(g.at[i] & M.A_MOSAIC)) {
      if (!on) return;
      clearCell(g, r, c);
      g.ch[i] = 0x20;
      g.bg[i] = ed.pen.bgc;   // a new mosaic cell: the pen's background (an existing one keeps its own)
    }
    if (on) {
      g.ch[i] |= bit;
      g.at[i] = mosaicAttr();
      g.fg[i] = ed.pen.fg;
    } else {
      g.ch[i] &= ~bit;
      if ((g.ch[i] & 0x5F) === 0 && !g.bg[i]) M.setBlank(g, i);
    }
  }
  function sextantLine(g, a, b, on) {
    let x0 = a.X, y0 = a.Y;
    const x1 = b.X, y1 = b.Y;
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      sextant(g, x0, y0, on);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  // ---- clipboard ---------------------------------------------------------------------------------
  function rectText(g, s) {
    const lines = [];
    for (let r = s.r0; r <= s.r1; r++) {
      let t = '';
      for (let c = s.c0; c <= s.c1; c++) {
        const i = M.idx(g, r, c);
        const ch = g.ch[i];
        if (ch === M.COVER) continue;
        t += (g.at[i] & M.A_MOSAIC) ? (ch === 0x20 ? ' ' : '█') : String.fromCodePoint(ch === M.BAR ? 0x2500 : ch);
      }
      lines.push(t.replace(/\s+$/, ''));
    }
    return lines.join('\n');
  }
  function copySel(cut) {
    const g = grid();
    if (!g) return;
    const s = selRect();
    const w = s.c1 - s.c0 + 1, h = s.r1 - s.r0 + 1;
    const clip = { w, h, ch: [], at: [], fg: [], bg: [], cols: g.cols };
    for (let r = s.r0; r <= s.r1; r++) for (let c = s.c0; c <= s.c1; c++) {
      const i = M.idx(g, r, c);
      clip.ch.push(g.ch[i]); clip.at.push(g.at[i]); clip.fg.push(g.fg[i]); clip.bg.push(g.bg[i]);
    }
    clip.text = rectText(g, s);
    ed.clip = clip;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(clip.text).catch(() => {});
    if (cut) actClear();
    setMsg(`${cut ? 'Cut' : 'Copied'} ${w}×${h} cells`);
  }
  function pasteCells() {
    const g = grid(), k = ed.clip;
    if (!g || !k) return;
    beginEdit();
    for (let y = 0; y < k.h; y++) for (let x = 0; x < k.w; x++) {
      const r = ed.r + y, c = ed.c + x;
      if (r > 24 || c > M.rowLimit(g, r)) continue;
      const j = y * k.w + x, i = M.idx(g, r, c);
      g.ch[i] = k.ch[j]; g.at[i] = k.at[j]; g.fg[i] = k.fg[j]; g.bg[i] = k.bg[j];
      if (k.cols !== g.cols && k.ch[j] === M.COVER) g.ch[i] = 0x20;
    }
    changed();
  }
  function pasteText(text) {
    const g = grid();
    if (!g) return;
    beginEdit();
    const a = penAttr();
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    lines.forEach((line, y) => {
      const r = ed.r + y * lineStep();
      if (r > 24) return;
      let c = ed.c;
      for (const ch of line) {
        const cp = M.foldChar(ch.codePointAt(0), wide());
        if (cp == null) continue;
        const w = writeChar(g, r, c, cp, a, ed.pen.fg);
        if (!w) break;
        c += w;
      }
    });
    changed();
  }

  // ---- keyboard -----------------------------------------------------------------------------------
  const screen = $('#screen');
  const kbd = $('#kbd');   // hidden textarea: takes the keys, and text from IMEs / compose keys
  const focusScreen = () => kbd.focus({ preventScroll: true });
  const flushKbd = () => {
    const v = kbd.value;
    kbd.value = '';
    if (!v || !grid()) return;
    for (const ch of v.replace(/\r?\n/g, '')) typeChar(ch.codePointAt(0));
  };
  kbd.addEventListener('input', (e) => { if (!e.isComposing) flushKbd(); });
  kbd.addEventListener('compositionend', flushKbd);
  kbd.addEventListener('keydown', (e) => {
    const g = grid();
    const k = e.key;
    if (e.ctrlKey || e.metaKey) {
      const l = k.toLowerCase();
      if (l === 'z' && !e.shiftKey) { undo(false); e.preventDefault(); }
      else if (l === 'y' || (l === 'z' && e.shiftKey)) { undo(true); e.preventDefault(); }
      else if (l === 'c') { copySel(false); e.preventDefault(); }
      else if (l === 'x') { copySel(true); e.preventDefault(); }
      else if (l === 'a' && g) { ed.sel = { r0: 1, c0: 1, r1: 24, c1: g.cols }; invalidate(); updateEditTarget(); e.preventDefault(); }
      else if (l === 's') { saveProjectFile(); e.preventDefault(); }
      return;   // Ctrl+V: the paste event
    }
    if (!g) return;
    const extend = e.shiftKey && k.startsWith('Arrow');
    if (extend && !ed.anchor) ed.anchor = { r: ed.r, c: ed.c };
    let handled = true;
    switch (k) {
      case 'ArrowLeft': moveCursor(ed.r, ownerCol(g, ed.r, Math.max(1, ed.c - 1)), extend); break;
      case 'ArrowRight': {
        let c = ed.c + 1;
        if (c <= g.cols && g.ch[M.idx(g, ed.r, Math.min(c, g.cols))] === M.COVER) c++;
        moveCursor(ed.r, c, extend);
        break;
      }
      case 'ArrowUp': moveCursor(ed.r - 1, ed.c, extend); break;
      case 'ArrowDown': moveCursor(ed.r + 1, ed.c, extend); break;
      case 'Home': moveCursor(ed.r, 1); ed.homeCol = 1; break;
      case 'End': {
        let last = 0;
        for (let c = 1; c <= M.rowLimit(g, ed.r); c++) if (!M.isBlank(g, M.idx(g, ed.r, c))) last = c;
        moveCursor(ed.r, last + 1);
        break;
      }
      case 'Enter': moveCursor(Math.min(24, ed.r + lineStep()), ed.homeCol); break;
      case 'Escape': ed.sel = null; ed.anchor = null; invalidate(); updateEditTarget(); break;
      case 'Backspace':
        if (ed.sel) { actClear(); break; }
        {
          const w = (mode === 40 && ed.pen.dblw) ? 2 : 1;
          let c = ed.c - w, r = ed.r;
          if (c < 1) { if (r === 1) break; r -= 1; c = M.rowLimit(g, r) - w + 1; }
          c = ownerCol(g, r, c);
          beginEdit(true);
          for (let x = 0; x < w; x++) clearCell(g, r, c + x);
          ed.r = r; ed.c = c;
          changed();
        }
        break;
      case 'Delete':
        if (ed.sel) { actClear(); break; }
        beginEdit(true);
        clearCell(g, ed.r, ed.c);
        changed();
        break;
      case 'Tab': moveCursor(ed.r, ed.c + 1); break;
      default: handled = false;
    }
    if (extend) {
      ed.sel = { r0: Math.min(ed.anchor.r, ed.r), c0: Math.min(ed.anchor.c, ed.c), r1: Math.max(ed.anchor.r, ed.r), c1: Math.max(ed.anchor.c, ed.c) };
      invalidate();
      updateEditTarget();
    }
    if (handled) { e.preventDefault(); return; }
    if (e.isComposing || k === 'Process' || k === 'Dead') return;   // the input event brings the text
    if ([...k].length === 1 && !e.altKey) {
      typeChar(k.codePointAt(0));
      e.preventDefault();
    }
  });
  kbd.addEventListener('paste', (e) => {
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    e.preventDefault();
    if (ed.clip && (!text || text === ed.clip.text)) pasteCells();
    else if (text) pasteText(text);
  });
  kbd.addEventListener('focus', invalidate);
  kbd.addEventListener('blur', invalidate);

  // ---- mouse --------------------------------------------------------------------------------------
  function hit(e) {
    const g = grid();
    const rect = ov.getBoundingClientRect();
    const x = (e.clientX - rect.left) * CW / rect.width, y = (e.clientY - rect.top) * CH / rect.height;
    const cols = g ? g.cols : 40;
    const cw = CW / cols;
    const c = Math.max(1, Math.min(cols, Math.floor(x / cw) + 1)), r = Math.max(1, Math.min(24, Math.floor(y / CELL_PX_H) + 1));
    const dotX = Math.floor((x - (c - 1) * cw) / (cw / (cols === 80 ? 6 : 8)));
    const dotY = Math.floor((y - (r - 1) * CELL_PX_H) / 3);
    const sx = dotX < (cols === 80 ? 3 : 4) ? 0 : 1;
    const sy = dotY < 3 ? 0 : dotY < 7 ? 1 : 2;
    return { r, c, X: (c - 1) * 2 + sx, Y: (r - 1) * 3 + sy };
  }
  let drag = null;
  screen.addEventListener('contextmenu', (e) => e.preventDefault());
  screen.addEventListener('pointerdown', (e) => {
    const g = grid();
    if (!g) return;
    e.preventDefault();
    focusScreen();
    const h = hit(e);
    screen.setPointerCapture(e.pointerId);
    const t = ed.tool;
    if (t === 'text') {
      const c = ownerCol(g, h.r, h.c);
      if (e.shiftKey) {
        if (!ed.anchor) ed.anchor = { r: ed.r, c: ed.c };
      } else {
        ed.anchor = { r: h.r, c };
        ed.sel = null;
        ed.r = h.r; ed.c = Math.min(c, M.rowLimit(g, h.r)); ed.homeCol = ed.c;
      }
      drag = { kind: 'select' };
      if (e.shiftKey) extendSel(h);
    } else if (t === 'draw' || t === 'erase') {
      if (mode !== 40) { setMsg('Mosaic drawing is 40 col only (Vidéotex)', 'err'); return; }
      const on = t === 'draw' && e.button !== 2;
      beginEdit();
      sextant(g, h.X, h.Y, on);
      drag = { kind: 'mosaic', on, last: h };
      ed.r = h.r; ed.c = Math.min(h.c, M.rowLimit(g, h.r));
      changed();
    } else if (t === 'paint') {
      beginEdit();
      paintCell(g, h.r, h.c);
      drag = { kind: 'paint' };
      changed();
    } else if (t === 'pick') {
      pickFrom(g, h.r, h.c);
    }
    invalidate();
    updateStatus();
    updateEditTarget();
  });
  function extendSel(h) {
    const a = ed.anchor;
    if (!a) return;
    if (a.r === h.r && a.c === h.c) ed.sel = null;
    else ed.sel = { r0: Math.min(a.r, h.r), c0: Math.min(a.c, h.c), r1: Math.max(a.r, h.r), c1: Math.max(a.c, h.c) };
    updateEditTarget();
  }
  screen.addEventListener('pointermove', (e) => {
    const g = grid();
    if (!g) return;
    const h = hit(e);
    const prev = ed.hover;
    ed.hover = h;
    if (drag && drag.kind === 'select') extendSel(h);
    else if (drag && drag.kind === 'mosaic') {
      sextantLine(g, drag.last, h, drag.on);
      drag.last = h;
      changed();
    } else if (drag && drag.kind === 'paint') {
      paintCell(g, h.r, h.c);
      changed();
    }
    if (!prev || prev.X !== h.X || prev.Y !== h.Y || drag) { invalidate(); updateStatus(); }
  });
  const endDrag = () => { drag = null; };
  screen.addEventListener('pointerup', endDrag);
  screen.addEventListener('pointercancel', endDrag);
  screen.addEventListener('pointerleave', () => { if (!drag) { ed.hover = null; invalidate(); updateStatus(); } });

  function pickFrom(g, r, c) {
    c = ownerCol(g, r, c);
    const i = M.idx(g, r, c), a = g.at[i], p = ed.pen;
    p.inv = !!(a & M.A_INV); p.blink = !!(a & M.A_BLINK);
    if (wide()) { p.bold = !!(a & M.A_BOLD); p.ul = !!(a & M.A_UL); }
    else {
      p.fg = g.fg[i];
      if (a & M.A_MOSAIC) { p.disjoint = !!(a & M.A_UL); p.bgc = g.bg[i]; }
      else { p.dblh = !!(a & M.A_DBLH); p.dblw = !!(a & M.A_DBLW); }
    }
    updatePenUI();
    setMsg('Pen taken from the cell');
  }

  // ---- status -----------------------------------------------------------------------------------
  let msgTimer = 0;
  function setMsg(text, kind) {
    const el = $('#stMsg');
    el.textContent = text;
    el.className = kind || '';
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { el.textContent = ''; }, 6000);
  }
  function describeCell(g, r, c) {
    const oc = ownerCol(g, r, c);
    const i = M.idx(g, r, oc), a = g.at[i], ch = g.ch[i];
    const parts = [];
    if (a & M.A_MOSAIC) parts.push('mosaic');
    else if (ch === 0x20) parts.push('blank');
    else parts.push(`'${String.fromCodePoint(ch === M.BAR ? 0x2500 : ch)}'`);
    if (a & M.A_INV) parts.push('inverse');
    if (a & M.A_BLINK) parts.push('blink');
    if (a & M.A_BOLD) parts.push('bold');
    if ((a & M.A_UL) && !(a & M.A_MOSAIC)) parts.push('underline');
    if ((a & M.A_UL) && (a & M.A_MOSAIC)) parts.push('disjoint');
    const sz = (a & M.A_DBLH ? 1 : 0) + (a & M.A_DBLW ? 2 : 0);
    if (sz) parts.push(['', 'double height', 'double width', 'double size'][sz]);
    if (g.cols === 40 && (a & M.A_MOSAIC || ch !== 0x20 || a & M.A_INV) && g.fg[i] !== 7) parts.push(`colour ${g.fg[i]} (${R.COLOUR_NAMES[g.fg[i]]})`);
    if (g.cols === 40 && (a & M.A_MOSAIC) && g.bg[i]) parts.push(`background ${g.bg[i]} (${R.COLOUR_NAMES[g.bg[i]]})`);
    if (g.cols === 40 && r < 24 && (g.at[M.idx(g, r + 1, c)] & M.A_DBLH)) parts.push('— under the top half of the double-height row below');
    if (r === 24 && c === g.cols) parts.push('— never written (would scroll)');
    return parts.join(', ');
  }
  function updateStatus() {
    const g = grid();
    if (!g) { $('#stPos').textContent = ''; $('#stCell').textContent = ''; return; }
    const h = ed.hover;
    $('#stPos').textContent = `row ${String(ed.r).padStart(2)} col ${String(ed.c).padStart(2)}` + (h ? `  ·  ↖ ${h.r},${h.c}` : '');
    $('#stCell').textContent = h ? describeCell(g, h.r, h.c) : describeCell(g, ed.r, ed.c);
  }
  function updateEditTarget() {
    $('#editTarget').textContent = ed.sel ? `· selection ${ed.sel.c1 - ed.sel.c0 + 1}×${ed.sel.r1 - ed.sel.r0 + 1}` : '· whole screen';
  }

  // ---- sizes -------------------------------------------------------------------------------------
  const fmtKB = (n) => n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
  function sizeOf(s, v) { const g = s['v' + v]; return g ? M.encodeSlide(g).length : 0; }
  function updateSizes() {
    const s = slide();
    for (const v of [40, 80]) {
      const btn = document.querySelector(`#verTabs button[data-v="${v}"]`);
      const has = !!s['v' + v];
      btn.classList.toggle('missing', !has);
      btn.classList.toggle('on', v === mode);
      $('#sz' + v).textContent = has ? fmtKB(sizeOf(s, v)) : 'none';
    }
    const n = grid() ? sizeOf(s, mode) : 0;
    const f = $('#meterFill');
    f.style.width = Math.min(100, n / M.SLIDE_MAX * 100) + '%';
    f.className = n > M.SLIDE_MAX ? 'over' : n > M.SLIDE_MAX * 0.8 ? 'warn' : '';
    $('#meterText').textContent = grid() ? `${n.toLocaleString('en')} / ${M.SLIDE_MAX.toLocaleString('en')} B` : '';
    updateSlideMeta(cur);
  }

  // ---- slide list ----------------------------------------------------------------------------------
  function renderSlideList() {
    const ul = $('#slideList');
    ul.innerHTML = '';
    project.slides.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = i === cur ? 'on' : '';
      li.dataset.i = i;
      const cv = document.createElement('canvas');
      cv.width = 320; cv.height = 240;
      li.appendChild(cv);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = '<span class="nm"></span>';
      meta.querySelector('.nm').textContent = `${i + 1}. ${s.name}`;
      li.appendChild(meta);
      const vers = document.createElement('div');
      vers.className = 'vers';
      li.appendChild(vers);
      li.addEventListener('click', () => selectSlide(i));
      ul.appendChild(li);
      updateSlideMeta(i);
      drawThumb(i);
    });
  }
  function updateSlideMeta(i) {
    const li = document.querySelector(`#slideList li[data-i="${i}"]`);
    if (!li) return;
    const s = project.slides[i];
    li.querySelector('.nm').textContent = `${i + 1}. ${s.name}`;
    const vers = li.querySelector('.vers');
    vers.innerHTML = '';
    for (const v of [40, 80]) {
      const b = document.createElement('span');
      const n = sizeOf(s, v);
      b.className = 'badge' + (s['v' + v] ? ' has' : '') + (n > M.SLIDE_MAX ? ' over' : '');
      b.textContent = s['v' + v] ? `${v} · ${fmtKB(n)}` : `${v} · —`;
      vers.appendChild(b);
    }
    if (s.slot) {
      const b = document.createElement('span');
      b.className = 'badge slot';
      b.title = 'Last uploaded to this slot';
      b.textContent = `slot ${s.slot}`;
      vers.appendChild(b);
    }
  }
  function drawThumb(i) {
    const li = document.querySelector(`#slideList li[data-i="${i}"]`);
    if (!li || !R.fontReady) return;
    const s = project.slides[i];
    const v = i === cur && s['v' + mode] ? mode : s.v40 ? 40 : 80;
    const g = s['v' + v];
    const ctx = li.querySelector('canvas').getContext('2d');
    if (!g) { ctx.fillStyle = '#050607'; ctx.fillRect(0, 0, 320, 240); return; }
    R.paint(ctx, R.renderDots(g, true), { crt: false });
  }
  let thumbTimer = 0;
  function scheduleThumb(i) {
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => drawThumb(i), 250);
  }

  function selectSlide(i) {
    cur = Math.max(0, Math.min(project.slides.length - 1, i));
    const s = slide();
    if (!s['v' + mode] && s['v' + (mode === 40 ? 80 : 40)]) mode = mode === 40 ? 80 : 40;
    ed.sel = null; ed.anchor = null;
    document.querySelectorAll('#slideList li').forEach((li) => li.classList.toggle('on', +li.dataset.i === cur));
    $('#slideName').value = s.name;
    $('#upSlot').value = String(s.slot || Math.min(cur + 1, M.SLIDES));
    applyMode();
  }
  function applyMode() {
    document.body.classList.toggle('m40', mode === 40);
    document.body.classList.toggle('m80', mode === 80);
    const g = grid();
    if (g) { ed.c = Math.min(ed.c, M.rowLimit(g, ed.r)); ed.homeCol = Math.min(ed.homeCol, g.cols); }
    $('#upVer').value = slide().v40 && slide().v80 ? 'both' : String(slide().v40 ? 40 : 80);
    $('#verDel').disabled = !g;
    $('#conv4080').disabled = !slide().v40;
    $('#conv8040').disabled = !slide().v80;
    if (ed.tool !== 'text' && ed.tool !== 'paint' && ed.tool !== 'pick' && mode === 80) setTool('text');
    buildCharPalette();
    updatePreviewChoice();
    updatePenUI();
    updateSizes();
    updateStatus();
    updateEditTarget();
    invalidate();
    scheduleThumb(cur);
  }

  // ---- pen / tools UI ------------------------------------------------------------------------------
  const TOOL_HINTS = {
    text: 'Click to place the cursor and type. Drag to select a block.',
    draw: 'Draw mosaic pixels (2×3 per cell) in the pen colour. Right button erases.',
    erase: 'Erase mosaic pixels.',
    paint: 'Paint the pen attributes onto cells (not the size).',
    pick: 'Click a cell to take its attributes into the pen.',
  };
  function setTool(t) {
    if ((t === 'draw' || t === 'erase') && mode === 80) { setMsg('Mosaic drawing is 40 col only', 'err'); return; }
    ed.tool = t;
    document.querySelectorAll('#toolSeg button').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    document.querySelectorAll('#toolSeg button[data-tool="draw"], #toolSeg button[data-tool="erase"]').forEach(b => { b.disabled = mode === 80; });
    $('#toolHint').textContent = TOOL_HINTS[t];
    screen.className = 'screen tool-' + t;
    invalidate();
  }
  function updatePenUI() {
    const p = ed.pen;
    document.querySelectorAll('#penToggles .tog').forEach(b => b.classList.toggle('on', !!p[b.dataset.pen]));
    const sz = (p.dblh ? 1 : 0) + (p.dblw ? 2 : 0);
    document.querySelectorAll('#sizeSeg button').forEach(b => b.classList.toggle('on', +b.dataset.size === sz));
    document.querySelectorAll('#swatches button').forEach(b => b.classList.toggle('on', +b.dataset.fg === p.fg));
    document.querySelectorAll('#bgSwatches button').forEach(b => b.classList.toggle('on', +b.dataset.bgc === p.bgc));
    document.querySelectorAll('#toolSeg button[data-tool="draw"], #toolSeg button[data-tool="erase"]').forEach(b => { b.disabled = mode === 80; });
    invalidate();
  }
  function buildSwatches() {
    buildSwatchRow($('#swatches'), 'fg');
    buildSwatchRow($('#bgSwatches'), 'bgc');
  }
  function buildSwatchRow(box, key) {
    [0, 4, 1, 5, 2, 6, 3, 7].forEach((i) => {   // by grey level, dark to light
      const b = document.createElement('button');
      const v = Math.round(R.GREY[i] * 225 + 8);
      b.style.background = `rgb(${v - 4}, ${v}, ${Math.min(255, v + 10)})`;
      b.style.color = R.GREY[i] > 0.5 ? '#111' : '#ddd';
      b.style.borderColor = '#3a4150';
      b.textContent = i;
      b.dataset[key] = i;
      b.title = `${i} ${R.COLOUR_NAMES[i]} — grey ${Math.round(R.GREY[i] * 100)} %` + (key === 'fg' && i === 0 ? ' (visible only inverse)' : '');
      b.addEventListener('click', () => { ed.pen[key] = i; updatePenUI(); focusScreen(); });
      box.appendChild(b);
    });
  }
  const CHARS40 = 'é è ê ë à â ä ù û ü ç î ï ô ö á í ó ú ì ò £ § ° ± ¼ ½ ¾ ß ÷ ← ↑ → ↓ œ Œ ─'.split(' ');
  const CHARS80 = 'à é è ù ç £ § °'.split(' ');
  function buildCharPalette() {
    const box = $('#charPalette');
    box.innerHTML = '';
    for (const ch of (mode === 40 ? CHARS40 : CHARS80)) {
      const b = document.createElement('button');
      b.textContent = ch;
      b.title = ch === '─' ? 'Vidéotex G0 0x60: long bar' : `Insert ${ch}`;
      b.addEventListener('click', () => { typeChar(ch.codePointAt(0)); focusScreen(); });
      box.appendChild(b);
    }
  }

  // ---- persistence -------------------------------------------------------------------------------
  let saveTimer = 0;
  function scheduleSave() {
    clearTimeout(saveTimer);
    $('#saveState').textContent = 'editing…';
    saveTimer = setTimeout(saveLocal, 400);
  }
  function saveLocal() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(projectToJSON()));
      $('#saveState').textContent = 'saved in this browser';
    } catch (e) {
      $('#saveState').textContent = 'autosave failed: ' + e.message;
    }
  }
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* private mode */ }
  }
  const slug = (s) => (s || 'slides').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'slides';
  function download(name, data, type) {
    const blob = new Blob([data], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function saveProjectFile() {
    download(slug(project.name) + '.json', JSON.stringify(projectToJSON(), null, 1), 'application/json');
    setMsg('Project saved as ' + slug(project.name) + '.json', 'ok');
  }
  function loadProject(p) {
    project = p;
    history.clear();
    cur = 0;
    mode = project.slides[0].v40 ? 40 : 80;
    $('#projName').value = project.name;
    renderSlideList();
    selectSlide(0);
    saveLocal();
  }

  function isBlankGrid(g) {
    for (let i = 0; i < g.ch.length; i++) if (!M.isBlank(g, i)) return false;
    return true;
  }

  // ---- import / export ----------------------------------------------------------------------------
  async function importFile(file) {
    if (isImageFile(file)) { await openImage(file); return; }
    const buf = new Uint8Array(await file.arrayBuffer());
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    let kind = ext === 'vdt' ? 'vdt' : M.sniff(buf);
    if (ext === 'json') { setMsg('Use Open… for a project file', 'err'); return; }
    let target, g;
    if (kind === 'vdt') { target = 40; g = M.decodeVideotex(buf); }
    else if (kind === 'mixte') { target = 80; g = M.decodeMixte(buf); }
    else {
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { text = new TextDecoder('windows-1252').decode(buf); }
      target = mode;
      g = M.decodeText(text, target);
    }
    const s = slide();
    const old = s['v' + target];
    if (old && !isBlankGrid(old) && !confirm(`Replace the ${target} col version of "${s.name}" with ${file.name}?`)) return;
    mode = target;
    beginEdit();
    s['v' + target] = g;
    applyMode();
    changed();
    setMsg(`Imported ${file.name} (${kind === 'vdt' ? 'Vidéotex' : kind === 'mixte' ? 'Mixte' : 'text'}) into the ${target} col version`, 'ok');
  }
  function exportCurrent() {
    const g = grid();
    if (!g) return;
    const bytes = M.encodeSlide(g);
    const name = `${slug(slide().name)}-${mode}.${mode === 40 ? 'vdt' : 'bin'}`;
    download(name, bytes, 'application/octet-stream');
    setMsg(`Exported ${name} (${bytes.length} bytes)` + (bytes.length > M.SLIDE_MAX ? ' — over the 12288-byte limit!' : ''), bytes.length > M.SLIDE_MAX ? 'err' : 'ok');
  }

  // ---- image import (image.js: the port of mtl's image.go) ------------------------------------------
  const IMG_MAX_PX = 16e6;
  let img = null;   // {px, name, target, grids: {40, 80}}
  const isImageFile = (f) => /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name);
  async function openImage(file) {
    let bmp;
    try {
      // no colour management, no premultiplication: the file's own pixel values, as Go reads them
      bmp = await createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    } catch (e) { setMsg(`Cannot read ${file.name} as a picture`, 'err'); return; }
    const W0 = bmp.width, H0 = bmp.height;
    let w = W0, h = H0, note = '';
    if (w * h > IMG_MAX_PX) {   // very large photos: scaled down first (then not exactly mtl's result)
      const k = Math.sqrt(IMG_MAX_PX / (w * h));
      w = Math.max(1, Math.floor(w * k)); h = Math.max(1, Math.floor(h * k));
      note = `Large picture: scaled to ${w}×${h} before conversion (mtl would sample the original).`;
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h);
    bmp.close && bmp.close();
    img = { px: { w, h, data: d.data }, name: file.name, target: img ? img.target : String(mode), grids: {} };
    $('#imgName').textContent = `· ${file.name} (${W0}×${H0})`;
    $('#imgNote').textContent = note;
    $('#imgDlg').showModal();
    updateImage();
  }
  function imageOpts() {
    return { dither: $('#imgDither').checked, contrast: $('#imgContrast').checked, gamma: parseFloat($('#imgGamma').value) || 1 };
  }
  let imgQueued = false;
  function updateImage() {
    if (!img || imgQueued) return;
    imgQueued = true;
    requestAnimationFrame(() => {
      imgQueued = false;
      const o = imageOpts();
      $('#imgGammaV').textContent = o.gamma.toFixed(2);
      document.querySelectorAll('#imgTarget button').forEach(b => b.classList.toggle('on', b.dataset.t === img.target));
      for (const v of [40, 80]) {
        const show = img.target === 'both' || img.target === String(v);
        $('#imgFig' + v).hidden = !show;
        if (!show) { delete img.grids[v]; continue; }
        const g = MI.convert(img.px, v, o);
        img.grids[v] = g;
        if (R.fontReady) R.paint($('#imgCv' + v).getContext('2d'), R.renderDots(g, true), { crt: false });
        const n = M.encodeSlide(g).length;
        const sz = $('#imgSz' + v);
        sz.textContent = `${n.toLocaleString('en')} bytes` + (n > M.SLIDE_MAX ? ' — over the 12288-byte limit' : '');
        sz.classList.toggle('over', n > M.SLIDE_MAX);
      }
    });
  }
  function applyImage() {
    if (!img) return;
    const s = slide();
    const vers = img.target === 'both' ? [40, 80] : [+img.target];
    const replaced = vers.filter(v => s['v' + v] && !isBlankGrid(s['v' + v]));
    if (replaced.length && !confirm(`Replace the ${replaced.join(' and ')} col version of "${s.name}" with the picture?`)) return;
    for (const v of vers) {
      mode = v;
      beginEdit();
      s['v' + v] = M.cloneGrid(img.grids[v]);
    }
    mode = vers[0];
    $('#imgDlg').close();
    applyMode();
    changed();
    setMsg(`Imported ${img.name} into the ${vers.join(' and ')} col version`, 'ok');
  }

  // ---- conversions -------------------------------------------------------------------------------
  function convert(to) {
    const s = slide();
    const from = to === 80 ? 40 : 80;
    const src = s['v' + from];
    if (!src) return;
    const place = $('#convPlace').value;
    const old = s['v' + to];
    if (old && !isBlankGrid(old) && !confirm(`Replace the ${to} col version with a conversion of the ${from} col one?`)) return;
    mode = to;
    beginEdit();
    s['v' + to] = to === 80
      ? M.convert40to80(src, place === 'left' ? 0 : place === 'right' ? 40 : 20)
      : M.convert80to40(src, place === 'left' ? 1 : place === 'right' ? 41 : 21);
    applyMode();
    changed();
    setMsg(to === 80 ? 'Converted: double size became bold, mosaics became blanks / bars, colours dropped'
      : 'Converted: bold and underline dropped, accents kept', 'ok');
  }

  // ---- BLE --------------------------------------------------------------------------------------
  const link = new window.MeshCoreLink();
  let busy = false;
  const logEl = $('#log');
  function log(text, cls) {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text + '\n';
    logEl.appendChild(span);
    while (logEl.childNodes.length > 400) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }
  link.onlog = (cmd, res) => {
    if (cmd.startsWith('slide data')) return;
    log('> ' + cmd, 'cmd');
    log(res.lines.join('\n'), res.ok ? '' : 'err');
  };
  async function cli(cmd) {
    try {
      return await link.cli(cmd);
    } catch (e) {
      log('> ' + cmd, 'cmd');
      log(e.message, 'err');
      throw e;
    }
  }
  function updateBle(state) {
    const on = link.connected;
    $('#bleDot').className = 'dot' + (on ? (busy ? ' busy' : ' on') : '');
    $('#bleState').textContent = !window.MeshCoreLink.supported()
      ? 'Web Bluetooth is not available in this browser (Chrome / Chromium; on Linux see the flag below)'
      : state === 'connecting' ? 'Connecting…' : on ? `Connected to ${link.name}` : 'Not connected';
    $('#bleConnect').textContent = on ? 'Disconnect' : 'Connect';
    const dis = !on || busy;
    ['#upGo', '#slotRefresh', '#slotLoadAll', '#slotDelAll', '#svRead', '#svSet', '#histRead', '#histSet', '#pvGo'].forEach(s => { $(s).disabled = dis; });
    $('#pvQuick').disabled = busy;
    $('#pvNext').disabled = !pv || !pv.waiting || pv.last;
    $('#pvStop').disabled = !pv;
    document.querySelectorAll('#slotRows button').forEach(b => { b.disabled = dis; });
    $('#conForm button').disabled = !on;
  }
  link.onstate = (s) => { updateBle(s); if (s === 'disconnected') renderSlots(null); };

  async function connect() {
    if (link.connected) { link.disconnect(); return; }
    if (!window.MeshCoreLink.supported()) return;
    try {
      await link.connect();
      setMsg('Connected to ' + link.name, 'ok');
      await refreshSlots();
      await readSaver(true);
      await readHist(true);
    } catch (e) {
      if (e && e.name === 'NotFoundError') return;   // chooser cancelled
      log(e.message || String(e), 'err');
      setMsg(e.message || String(e), 'err');
      updateBle();
    }
  }

  let slots = null;   // {list: {n: {40: bytes, 80: bytes}}, free, total}
  function renderSlots(data) {
    slots = data;
    const tb = $('#slotRows');
    tb.innerHTML = '';
    for (let n = 1; n <= M.SLIDES; n++) {
      const tr = document.createElement('tr');
      const e = data && data.list[n] || {};
      const td = (t, cls) => { const d = document.createElement('td'); if (cls) d.className = cls; d.textContent = t; tr.appendChild(d); return d; };
      td(String(n));
      for (const v of [40, 80]) {
        const d = td(data ? (e[v] ? fmtKB(e[v]) : '—') : '?', 'v');
        if (e[v]) {
          const ld = document.createElement('button');
          ld.className = 'x small';
          ld.textContent = '⤓';
          ld.title = `Load the ${v} col version of slot ${n} into the current slide`;
          ld.addEventListener('click', () => loadSlot(n, [v]));
          d.appendChild(ld);
          const x = document.createElement('button');
          x.className = 'x small';
          x.textContent = '×';
          x.title = `Delete the ${v} col version of slot ${n}`;
          x.addEventListener('click', () => delSlot(n, v));
          d.appendChild(x);
        }
      }
      const acts = td('', 'acts');
      if (e[40] || e[80]) {
        const show = document.createElement('button');
        show.textContent = 'Show';
        show.title = 'Show it on the Minitel now (if its mode has a version)';
        show.addEventListener('click', () => showSlot(n));
        const load = document.createElement('button');
        const both = [40, 80].filter(v => e[v]);
        load.textContent = 'Load';
        load.title = `Load ${both.length > 1 ? 'both versions' : 'the ' + both[0] + ' col version'} of slot ${n} into the current slide`;
        load.addEventListener('click', () => loadSlot(n, both));
        const del = document.createElement('button');
        del.textContent = 'Delete';
        del.className = 'danger';
        del.addEventListener('click', () => delSlot(n, 0));
        acts.append(show, load, del);
      }
      tb.appendChild(tr);
    }
    $('#slotFree').textContent = data && data.total ? `· ${data.free} KB free of ${data.total}` : '';
    updateBle();
  }
  async function refreshSlots() {
    const r = await cli('slide list');
    if (!r.ok) { setMsg('slide list: ' + r.err, 'err'); return; }
    const data = { list: {}, free: 0, total: 0 };
    for (const l of r.lines) {
      let m = l.match(/^\s*(\d+)\s+(40|80)\s+(\d+)\s*$/);
      if (m) { (data.list[+m[1]] = data.list[+m[1]] || {})[+m[2]] = +m[3]; continue; }
      m = l.match(/free\s+(\d+)\s+KB\s+of\s+(\d+)/i);
      if (m) { data.free = +m[1]; data.total = +m[2]; }
    }
    renderSlots(data);
  }
  async function withBusy(fn) {
    if (busy) return;
    busy = true;
    updateBle();
    try { await fn(); } catch (e) { setMsg(e.message || String(e), 'err'); } finally { busy = false; updateBle(); }
  }
  function delSlot(n, v) {
    const what = v ? `the ${v} col version of slot ${n}` : `slot ${n}`;
    if (!confirm(`Delete ${what} on the Minitel?`)) return;
    withBusy(async () => {
      const r = await cli(`slide del ${n}` + (v ? ' ' + v : ''));
      setMsg(r.ok ? `Deleted ${what}` : r.err, r.ok ? 'ok' : 'err');
      await refreshSlots();
    });
  }
  function showSlot(n) {
    withBusy(async () => {
      const r = await cli(`slide show ${n}`);
      setMsg(r.ok ? `Slot ${n} is on the Minitel` : r.err.replace(/^ERR\s*/, ''), r.ok ? 'ok' : 'err');
    });
  }

  // ---- read-back: slide read <n> <40|80> <offset> -> "  size <s> offset <o> data <hex>", OK
  const READ_STEP = 240;
  async function readVersion(n, v, progress) {
    const out = [];
    let size = -1, off = 0;
    do {
      const r = await cli(`slide read ${n} ${v} ${off}`);
      if (!r.ok) throw new Error(`slide read ${n} ${v}: ${r.err}`);
      const m = r.text.match(/size\s+(\d+)\s+offset\s+(\d+)\s+data\s*([0-9A-Fa-f]*)/);
      if (!m) throw new Error(`slide read ${n} ${v}: unexpected reply`);
      if (+m[2] !== off || m[3].length % 2) throw new Error(`slide read ${n} ${v}: bad chunk at ${off}`);
      size = +m[1];
      const hex = m[3];
      if (hex.length / 2 !== Math.min(READ_STEP, Math.max(0, size - off))) throw new Error(`slide read ${n} ${v}: ${hex.length / 2} bytes at ${off} of ${size} (a lost or doubled notification?)`);
      for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
      off += hex.length / 2;
      progress(off, size);
    } while (off < size);
    return Uint8Array.from(out);
  }
  const decodeVersion = (v, bytes) => (v === 40 ? M.decodeVideotex(bytes) : M.decodeMixte(bytes));

  // read versions of slots with a progress bar: jobs [{n, v}] -> Map 'n.v' -> bytes
  async function readJobs(jobs) {
    const prog = $('#ldProg'), fill = $('#ldFill'), txt = $('#ldText');
    const total = jobs.reduce((a, j) => a + (slots.list[j.n][j.v] || 0), 0) || 1;
    let before = 0;
    const res = new Map();
    prog.hidden = false;
    fill.style.width = '0%';
    try {
      for (const j of jobs) {
        const bytes = await readVersion(j.n, j.v, (got, size) => {
          fill.style.width = Math.min(100, (before + got) / total * 100).toFixed(1) + '%';
          txt.textContent = `Reading slot ${j.n}, ${j.v} col: ${got} / ${size} bytes`;
        });
        before += bytes.length;
        res.set(j.n + '.' + j.v, bytes);
      }
    } catch (e) {
      txt.textContent = 'Load failed: ' + (e.message || e);
      throw e;
    }
    return res;
  }

  function loadSlot(n, vers) {
    const s = slide();
    const replaced = vers.filter(v => s['v' + v] && !isBlankGrid(s['v' + v]));
    if (replaced.length && !confirm(`Replace the ${replaced.join(' and ')} col version of "${s.name}" with slot ${n}? (Undo brings the current one back.)`)) return;
    withBusy(async () => {
      const res = await readJobs(vers.map(v => ({ n, v })));
      const target = project.slides.indexOf(s);
      if (target < 0) throw new Error('the slide was deleted meanwhile');
      for (const v of vers) {
        if (cur !== target) selectSlide(target);
        mode = v;
        beginEdit();
        s['v' + v] = decodeVersion(v, res.get(n + '.' + v));
      }
      s.slot = n;
      applyMode();
      changed();
      updateSlideMeta(cur);
      const bytes = vers.reduce((a, v) => a + res.get(n + '.' + v).length, 0);
      $('#ldText').textContent = `Loaded slot ${n} (${vers.join(' + ')} col, ${bytes} bytes) into "${s.name}".`;
      setMsg(`Loaded slot ${n}`, 'ok');
    });
  }

  function loadAllSlots() {
    const ns = Object.keys(slots ? slots.list : {}).map(Number).filter(n => slots.list[n][40] || slots.list[n][80]).sort((a, b) => a - b);
    if (!ns.length) { setMsg('No slides stored on the Minitel', 'err'); return; }
    if (!confirm(`Read ${ns.length} slot(s) into a new project? The current project is replaced (save it as a file first if you want to keep it).`)) return;
    withBusy(async () => {
      const jobs = [];
      for (const n of ns) for (const v of [40, 80]) if (slots.list[n][v]) jobs.push({ n, v });
      const res = await readJobs(jobs);
      const p = { name: `From ${link.name || 'the Minitel'}`, slides: [] };
      for (const n of ns) {
        const sl = { id: uid(), name: `Slot ${n}`, slot: n, v40: null, v80: null };
        for (const v of [40, 80]) if (res.has(n + '.' + v)) sl['v' + v] = decodeVersion(v, res.get(n + '.' + v));
        p.slides.push(sl);
      }
      loadProject(p);
      $('#ldText').textContent = `Loaded ${jobs.length} version(s) from ${ns.length} slot(s) into a new project.`;
      setMsg('Slots loaded into a new project', 'ok');
    });
  }

  // ---- preview: the terminal channel (as mtl slide preview), nothing stored ---------------------
  // C0 'O' -> O <status> <cols> <rows> <gen>; C0 'M' <cols> -> M <status>, then push F0 'M'
  // <cols> <rows> <gen>; C0 'D' <gen> <bytes> -> D <status> <accepted> <free lo> <free hi>;
  // C0 'X' -> X 0. Pushes: F0 'K' <key bytes>, F0 'X' <reason> (CONNEXION/FIN: session over).
  const PV_CHUNK = 150;
  const SUB = (c) => c.charCodeAt(0);
  let pv = null;   // {ctl: AbortController, waiting, last, ended}
  const sleep = (ms, signal) => new Promise((res, rej) => {
    if (signal && signal.aborted) { rej(signal.reason); return; }
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true });
  });
  // a request that Stop does not wait for (its reply, if any, is dropped by seq later)
  const abortable = (promise, signal) => new Promise((res, rej) => {
    if (signal.aborted) { rej(signal.reason); return; }
    signal.addEventListener('abort', () => rej(signal.reason), { once: true });
    promise.then(res, rej);
  });
  class Ended extends Error {}

  async function pvOpen() {
    let err;
    for (let i = 0; i < 3; i++) {
      try { return await abortable(link.request('O', [], 3000), pv.ctl.signal); } catch (e) {
        if (pv.ctl.signal.aborted) throw e;
        err = e;
        if (!link.connected || /does not know/.test(e.message)) break;
      }
      await sleep(1000, pv.ctl.signal);
    }
    throw new Error('no answer to open: ' + (err && err.message));
  }
  // the end of the session pushed by the Minitel, else the value fn finds
  const endOr = (fn) => (p) => {
    if (p.length >= 2 && p[1] === SUB('X')) { if (pv) pv.endReason = p[2]; return 'ended'; }
    return fn(p);
  };
  const END_REASONS = { 1: 'CONNEXION/FIN on the Minitel', 2: 'the Minitel left the page', 3: 'the PC did not come back in time' };
  class LinkLost extends Error {}
  async function pvSend(gen, bytes, label) {
    const fill = $('#pvFill');
    let off = 0, stalls = 0;
    while (off < bytes.length) {
      if (pv.ctl.signal.aborted) throw pv.ctl.signal.reason;
      const part = bytes.subarray(off, off + PV_CHUNK);
      const r = await link.request('D', [gen, ...part], 3000);
      if (r.length < 4 || r[0] !== 0) throw new Error('the Minitel changed modes during the preview');
      const acc = r[1];
      if (acc > part.length) throw new Error('BLE replies out of step: preview stopped');
      if (acc === 0) {   // the Minitel's queue is full: the same chunk again in a moment
        if (++stalls > 500) throw new Error('the Minitel takes no more bytes');
        await sleep(60, pv.ctl.signal);
        continue;
      }
      stalls = 0;
      off += acc;
      fill.style.width = (off / bytes.length * 100).toFixed(1) + '%';
      $('#pvText').textContent = `Sending ${label}: ${off} / ${bytes.length} bytes`;
    }
  }
  function pvState(text) { $('#pvText').textContent = text; }

  async function preview() {
    if (pv || !link.connected) return;
    const s = slide();
    const want = $('#pvVer').value === 'both' ? [40, 80].filter(v => s['v' + v]) : [mode];
    const items = want.filter(v => s['v' + v]).map(v => ({ v, bytes: M.encodeSlide(s['v' + v]) }));   // a snapshot of the editor
    if (!items.length) { setMsg('Nothing to preview: this slide has no version here', 'err'); return; }
    pv = { ctl: new AbortController(), waiting: false, last: false, ended: false };
    busy = true;
    updateBle();
    $('#pvProg').hidden = false;
    $('#pvFill').style.width = '0%';
    link.clearPushes();
    let closeIt = false, outcome = '';
    try {
      pvState('Opening the terminal channel…');
      const o = await pvOpen();
      if (o.length < 4 || o[0] !== 0) throw new Error('the Minitel is not ready (switched on, and on the 3615 MESHCORE pages?)');
      closeIt = true;
      let cur = o[1], gen = o[3];
      for (let i = 0; i < items.length; i++) {
        const { v, bytes } = items[i];
        if (v !== cur) {   // the slide's mode first
          pvState(`Switching the Minitel to ${v} col…`);
          await link.request('M', [v], 3000);
          const g = await link.waitPush(endOr((p) => (p.length >= 5 && p[1] === SUB('M') && p[2] === v ? p[4] : undefined)), 8000, pv.ctl.signal)
            .catch((e) => { throw e.message === 'timeout' ? new Error(`the Minitel did not switch to ${v} col`) : e; });
          if (g === 'ended') throw new Ended();
          gen = g;
          cur = v;
        }
        await pvSend(gen, bytes, `${v} col`);
        pv.last = i === items.length - 1;
        pv.waiting = true;
        updateBle();
        pvState(pv.last
          ? `Showing ${v} col (${bytes.length} bytes). A key on the Minitel, or Stop, ends the preview.`
          : `Showing ${v} col (${bytes.length} bytes). Press a key on the Minitel, or Next, for the ${items[i + 1].v} col version.`);
        const next = new AbortController();
        pv.next = next;
        const key = await Promise.race([   // (the button listeners first: they must win over the waiter's abort)
          new Promise((res) => next.signal.addEventListener('abort', () => res(next.signal.reason === 'next' ? 'next' : 'stop'), { once: true })),
          new Promise((res) => pv.ctl.signal.addEventListener('abort', () => res('stop'), { once: true })),
          link.waitPush(endOr((p) => (p.length >= 2 && p[1] === SUB('K') ? 'key' : undefined)), 0, next.signal),
        ]).catch(() => (link.connected ? 'stop' : 'lost'));
        next.abort('done');
        pv.waiting = false;
        updateBle();
        if (key === 'ended') throw new Ended();
        if (key === 'lost') throw new LinkLost();
        if (key === 'stop') { outcome = 'Preview stopped.'; break; }
      }
      if (!outcome) outcome = 'Preview over.';
    } catch (e) {
      if (e instanceof Ended) { closeIt = false; outcome = `Ended on the Minitel (${END_REASONS[pv.endReason] || 'reason ' + pv.endReason}).`; }
      else if (e instanceof LinkLost || !link.connected) { outcome = 'The Bluetooth link was lost.'; setMsg(outcome, 'err'); }
      else if (pv.ctl.signal.aborted) outcome = 'Preview stopped.';
      else { outcome = 'Preview failed: ' + (e.message || e); setMsg(outcome, 'err'); }
    } finally {
      // close: the session ends now; without an answer (or a link) the Minitel takes its
      // pages back by itself 20 s after it lost the PC
      let closed = false;
      if (closeIt && link.connected) {
        pvState(outcome + ' Closing…');
        try { await link.request('X', [], 2000); closed = true; } catch (e) { /* below */ }
      }
      pvState(outcome + (!closeIt ? '' : closed ? ' The Minitel has its page back.' : ' No answer to close: the Minitel takes its pages back within 20 s.'));
      $('#pvProg').hidden = true;
      pv = null;
      busy = false;
      updateBle();
    }
  }
  function previewNext() { if (pv && pv.next) pv.next.abort('next'); }
  function previewStop() {
    if (!pv) return;
    pvState('Stopping…');
    if (pv.next) pv.next.abort('stop');
    pv.ctl.abort(new Error('stopped'));
  }
  function updatePreviewChoice() {
    const s = slide();
    const o = $('#pvVer').options;
    o[0].textContent = `this version (${mode} col)`;
    o[1].disabled = !(s.v40 && s.v80);
    if (o[1].disabled && $('#pvVer').value === 'both') $('#pvVer').value = 'cur';
  }

  const toHex = (b) => Array.from(b, v => v.toString(16).toUpperCase().padStart(2, '0')).join('');
  const CHUNK = 70;   // bytes per "slide data" (140 hex digits; the command stays under 160 chars)
  async function upload() {
    const s = slide();
    const slot = +$('#upSlot').value;
    const which = $('#upVer').value;
    const vers = which === 'both' ? [40, 80] : [+which];
    for (const v of vers) {
      if (!s['v' + v]) { setMsg(`This slide has no ${v} col version`, 'err'); return; }
      const n = M.encodeSlide(s['v' + v]).length;
      if (n > M.SLIDE_MAX) { setMsg(`The ${v} col version is ${n} bytes: over the 12288-byte limit`, 'err'); return; }
    }
    const blanks = vers.filter(v => isBlankGrid(s['v' + v]));
    if (blanks.length && !confirm(`The ${blanks.join(' and ')} col version is blank. Upload anyway?`)) return;
    const existing = slots && slots.list[slot] ? vers.filter(v => slots.list[slot][v]) : [];
    if (existing.length && !confirm(`Slot ${slot} already has a ${existing.join(' and ')} col version: replace it?`)) return;
    await withBusy(async () => {
      const prog = $('#upProg'), fill = $('#upFill'), txt = $('#upText');
      prog.hidden = false;
      fill.style.width = '0%';
      const data = vers.map(v => ({ v, bytes: M.encodeSlide(s['v' + v]) }));
      const total = data.reduce((a, d) => a + d.bytes.length, 0);
      let done = 0;
      const t0 = performance.now();
      try {
        for (const { v, bytes } of data) {
          txt.textContent = `Slot ${slot}, ${v} col: ${bytes.length} bytes…`;
          let r = await cli(`slide begin ${slot} ${v} ${bytes.length}`);
          if (!r.ok) throw new Error(`slide begin: ${r.err}`);
          for (let off = 0; off < bytes.length; off += CHUNK) {
            const part = bytes.subarray(off, off + CHUNK);
            r = await cli('slide data ' + toHex(part));
            if (!r.ok) throw new Error(`slide data at byte ${off}: ${r.err}`);
            done += part.length;
            fill.style.width = (done / total * 100).toFixed(1) + '%';
            txt.textContent = `Slot ${slot}, ${v} col: ${off + part.length} / ${bytes.length} bytes`;
          }
          r = await cli('slide end');
          if (!r.ok) throw new Error(`slide end: ${r.err}`);
        }
        s.slot = slot;
        updateSlideMeta(cur);
        scheduleSave();
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        txt.textContent = `Uploaded to slot ${slot} (${vers.join(' + ')} col, ${total} bytes, ${secs} s).`;
        setMsg(`Uploaded to slot ${slot}`, 'ok');
      } catch (e) {
        txt.textContent = 'Upload failed: ' + (e.message || e);
        throw e;
      } finally {
        try { await refreshSlots(); } catch (e) { /* reported */ }
      }
    });
  }

  function fmtDelay(s) {
    if (!s) return '0';
    if (s % 3600 === 0) return s / 3600 + 'h';
    if (s % 60 === 0) return s / 60 + 'm';
    return s + 's';
  }
  async function readSaver(quiet) {
    const r = await cli('saver');
    const m = r.text.match(/saver splash (\d+) s, off (\d+) s/);
    if (m) { $('#svSplash').value = fmtDelay(+m[1]); $('#svOff').value = fmtDelay(+m[2]); }
    else if (!quiet) setMsg('saver: ' + r.err, 'err');
  }
  async function readHist(quiet) {
    const r = await cli('hist keep');
    const m = r.text.match(/hist keep (\d+)/);
    if (m) $('#histKeep').value = m[1];
    else if (!quiet) setMsg('hist keep: ' + (r.err || 'no answer'), 'err');
  }
  const DELAY_RE = /^\s*\d+\s*(s|m|min|h)?\s*$/i;

  // ---- wiring ----------------------------------------------------------------------------------
  function wire() {
    $('#btnHelp').addEventListener('click', () => $('#help').showModal());
    $('#btnNew').addEventListener('click', () => {
      if (!confirm('Start a new project? The current one stays only if you saved it as a file.')) return;
      loadProject(freshProject());
    });
    $('#btnOpen').addEventListener('click', () => $('#fileProject').click());
    $('#btnSave').addEventListener('click', saveProjectFile);
    $('#fileProject').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try { loadProject(projectFromJSON(JSON.parse(await f.text()))); setMsg('Opened ' + f.name, 'ok'); }
      catch (err) { setMsg('Cannot open ' + f.name + ': ' + err.message, 'err'); }
    });
    $('#projName').addEventListener('input', (e) => { project.name = e.target.value; scheduleSave(); });
    $('#slideName').addEventListener('input', (e) => { slide().name = e.target.value; updateSlideMeta(cur); scheduleSave(); });

    $('#slideAdd').addEventListener('click', () => {
      project.slides.splice(cur + 1, 0, newSlide(`Slide ${project.slides.length + 1}`));
      renderSlideList(); selectSlide(cur + 1); scheduleSave();
    });
    $('#slideDup').addEventListener('click', () => {
      const s = slide();
      const d = { id: uid(), name: s.name + ' (copy)', slot: null, v40: s.v40 && M.cloneGrid(s.v40), v80: s.v80 && M.cloneGrid(s.v80) };
      project.slides.splice(cur + 1, 0, d);
      renderSlideList(); selectSlide(cur + 1); scheduleSave();
    });
    $('#slideDel').addEventListener('click', () => {
      if (!confirm(`Delete "${slide().name}" from the project?`)) return;
      project.slides.splice(cur, 1);
      if (!project.slides.length) project.slides.push(newSlide('Slide 1'));
      renderSlideList(); selectSlide(Math.min(cur, project.slides.length - 1)); scheduleSave();
    });
    const moveSlide = (d) => {
      const j = cur + d;
      if (j < 0 || j >= project.slides.length) return;
      const a = project.slides;
      [a[cur], a[j]] = [a[j], a[cur]];
      cur = j;
      renderSlideList(); selectSlide(j); scheduleSave();
    };
    $('#slideUp').addEventListener('click', () => moveSlide(-1));
    $('#slideDown').addEventListener('click', () => moveSlide(1));

    document.querySelectorAll('#verTabs button').forEach(b => b.addEventListener('click', () => { mode = +b.dataset.v; ed.sel = null; applyMode(); }));
    $('#emptyBlank').addEventListener('click', () => { beginEdit(); slide()['v' + mode] = M.newGrid(mode); applyMode(); changed(); focusScreen(); });
    $('#emptyConv').addEventListener('click', () => convert(mode));
    $('#conv4080').addEventListener('click', () => convert(80));
    $('#conv8040').addEventListener('click', () => convert(40));
    $('#verDel').addEventListener('click', () => {
      if (!grid() || !confirm(`Remove the ${mode} col version of "${slide().name}"? The Minitel will skip this slide in ${mode} col mode.`)) return;
      beginEdit();
      slide()['v' + mode] = null;
      applyMode(); scheduleSave(); scheduleThumb(cur);
    });

    const opt = (id, key) => {
      const el = $(id);
      el.checked = prefs[key];
      el.addEventListener('change', () => { prefs[key] = el.checked; savePrefs(); invalidate(); focusScreen(); });
    };
    opt('#optBlink', 'blink'); opt('#optGrid', 'grid'); opt('#optCrt', 'crt');
    setInterval(() => { if (prefs.blink) { blinkOn = !blinkOn; invalidate(); } else blinkOn = true; }, 500);

    document.querySelectorAll('#toolSeg button').forEach(b => b.addEventListener('click', () => { setTool(b.dataset.tool); focusScreen(); }));
    document.querySelectorAll('#penToggles .tog').forEach(b => b.addEventListener('click', () => { ed.pen[b.dataset.pen] = !ed.pen[b.dataset.pen]; updatePenUI(); focusScreen(); }));
    document.querySelectorAll('#sizeSeg button').forEach(b => b.addEventListener('click', () => {
      const v = +b.dataset.size;
      ed.pen.dblh = !!(v & 1); ed.pen.dblw = !!(v & 2);
      updatePenUI(); focusScreen();
    }));
    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
      $('#tab-design').hidden = b.dataset.tab !== 'design';
      $('#tab-minitel').hidden = b.dataset.tab !== 'minitel';
    }));

    $('#actFill').addEventListener('click', () => { actFill(); focusScreen(); });
    $('#actFillMos').addEventListener('click', () => { actFillMosaic(); focusScreen(); });
    $('#actAttr').addEventListener('click', () => { actApply(); focusScreen(); });
    $('#actClear').addEventListener('click', () => { actClear(); focusScreen(); });
    $('#actUndo').addEventListener('click', () => undo(false));
    $('#actRedo').addEventListener('click', () => undo(true));
    $('#actImport').addEventListener('click', () => $('#fileImport').click());
    $('#fileImport').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) { try { await importFile(f); } catch (err) { setMsg('Import failed: ' + err.message, 'err'); } }
    });
    $('#actExport').addEventListener('click', exportCurrent);
    $('#actImage').addEventListener('click', () => $('#fileImage').click());
    $('#fileImage').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) await openImage(f);
    });
    document.querySelectorAll('#imgTarget button').forEach(b => b.addEventListener('click', () => { img.target = b.dataset.t; updateImage(); }));
    ['#imgDither', '#imgContrast', '#imgGamma'].forEach(id => $(id).addEventListener('input', updateImage));
    $('#imgGamma').addEventListener('dblclick', () => { $('#imgGamma').value = '1'; updateImage(); });
    $('#imgCancel').addEventListener('click', () => $('#imgDlg').close());
    $('#imgApply').addEventListener('click', applyImage);
    // drop a picture (or a .vdt / text / Mixte file) on the screen
    const wrap = $('#screenWrap');
    wrap.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      wrap.classList.add('drop');
    });
    wrap.addEventListener('dragleave', (e) => { if (e.target === wrap || !wrap.contains(e.relatedTarget)) wrap.classList.remove('drop'); });
    wrap.addEventListener('drop', async (e) => {
      e.preventDefault();
      wrap.classList.remove('drop');
      const f = e.dataTransfer.files[0];
      if (!f) return;
      try { await importFile(f); } catch (err) { setMsg('Import failed: ' + err.message, 'err'); }
    });

    // BLE
    for (let n = 1; n <= M.SLIDES; n++) $('#upSlot').add(new Option(String(n), String(n)));
    if (!window.MeshCoreLink.supported()) {
      $('#bleConnect').disabled = true;
    }
    $('#bleConnect').addEventListener('click', connect);
    $('#upGo').addEventListener('click', upload);
    $('#slotRefresh').addEventListener('click', () => withBusy(refreshSlots));
    $('#slotLoadAll').addEventListener('click', loadAllSlots);
    $('#pvGo').addEventListener('click', preview);
    $('#pvNext').addEventListener('click', previewNext);
    $('#pvStop').addEventListener('click', previewStop);
    $('#pvQuick').addEventListener('click', () => {
      document.querySelector('.tabs button[data-tab="minitel"]').click();
      if (!link.connected) { setMsg('Connect to the Minitel first (Minitel tab)', 'err'); return; }
      preview();
    });
    $('#slotDelAll').addEventListener('click', () => {
      if (!confirm('Delete every slide stored on the Minitel?')) return;
      withBusy(async () => { const r = await cli('slide del all'); setMsg(r.ok ? 'All slides deleted' : r.err, r.ok ? 'ok' : 'err'); await refreshSlots(); });
    });
    $('#svRead').addEventListener('click', () => withBusy(() => readSaver(false)));
    $('#svSet').addEventListener('click', () => {
      const a = $('#svSplash').value.trim(), b = $('#svOff').value.trim();
      if (!DELAY_RE.test(a) || !DELAY_RE.test(b)) { setMsg('Delays: a number with s, m or h (a bare number = minutes); 0 = never', 'err'); return; }
      withBusy(async () => {
        const r = await cli(`saver ${a.replace(/\s+/g, '')} ${b.replace(/\s+/g, '')}`);
        setMsg(r.ok ? 'Screen saver set' : r.err, r.ok ? 'ok' : 'err');
        if (r.ok) await readSaver(true);
      });
    });
    $('#histRead').addEventListener('click', () => withBusy(() => readHist(false)));
    $('#histSet').addEventListener('click', () => {
      const n = parseInt($('#histKeep').value, 10);
      if (!(n >= 10 && n <= 160)) { setMsg('Messages kept: 10 to 160', 'err'); return; }
      withBusy(async () => { const r = await cli(`hist keep ${n}`); setMsg(r.ok ? 'History limit set' : r.err, r.ok ? 'ok' : 'err'); });
    });
    $('#conForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const cmd = $('#conCmd').value.trim();
      if (!cmd || !link.connected) return;
      if (new TextEncoder().encode(cmd).length > 160) { setMsg('Command too long', 'err'); return; }
      $('#conCmd').value = '';
      link.cli(cmd).catch((err) => { log('> ' + cmd, 'cmd'); log(err.message, 'err'); });
    });

    new ResizeObserver(fitScreen).observe($('#screenWrap'));
    window.addEventListener('beforeunload', saveLocal);
  }

  // ---- start ---------------------------------------------------------------------------------------
  async function start() {
    try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch (e) { /* none */ }
    let p = null;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) p = projectFromJSON(JSON.parse(raw));
    } catch (e) { p = null; }
    project = p || freshProject();
    buildSwatches();
    wire();
    $('#projName').value = project.name;
    renderSlideList();
    selectSlide(0);
    setTool('text');
    renderSlots(null);
    updateBle();
    fitScreen();
    try {
      await R.loadFont();
    } catch (e) {
      setMsg('Could not load the Minitel font: ' + e.message, 'err');
    }
    project.slides.forEach((_, i) => drawThumb(i));
    invalidate();
    $('#saveState').textContent = p ? 'restored from this browser' : '';
    focusScreen();
  }
  start();
})();
