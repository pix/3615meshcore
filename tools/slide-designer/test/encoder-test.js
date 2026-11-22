// Encoder / decoder tests. node test/encoder-test.js [path to the fw_harness binary]
// 1. hand-checked byte sequences (from the firmware's encoding rules);
// 2. random screens: every row span encoded by minitel.js and by the firmware's own
//    encodeSpan (compiled on the host, see fw_harness.cpp) must be identical;
// 3. decode(encode(screen)) == screen, for Vidéotex and Mixte.
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');
const M = require(path.join(__dirname, '..', 'minitel.js'));

let fails = 0, checks = 0;
const hex = (b) => Array.from(b, v => v.toString(16).toUpperCase().padStart(2, '0')).join('');
function eq(name, got, want) {
  checks++;
  if (got !== want) { fails++; console.log(`FAIL ${name}\n  got  ${got}\n  want ${want}`); }
}
function grid(cols, cells) {   // cells: [row, col, cp|string, attr, fg]
  const g = M.newGrid(cols);
  for (const [r, c, ch, a = 0, fg = 7] of cells) {
    const i = M.idx(g, r, c);
    g.ch[i] = typeof ch === 'string' ? ch.codePointAt(0) : ch;
    g.at[i] = a; g.fg[i] = fg;
  }
  return M.normalize(g);
}
const text = (cols, r, c, s, a = 0, fg = 7) => Array.from(s).map((ch, k) => [r, c + k, ch, a, fg]);
const slide = (g) => hex(M.encodeSlide(g));

// ---- 1. hand-checked -------------------------------------------------------------------------
const CLR40 = '0C14';
const CLR80 = '0F1B5B306D1B5B324A1B5B48';
eq('40 empty', slide(M.newGrid(40)), CLR40);
eq('80 empty', slide(M.newGrid(80)), CLR80);
eq('40 A', slide(grid(40, [[1, 1, 'A']])), CLR40 + '1F4141' + '41');
eq('40 e acute', slide(grid(40, [[2, 3, 'é']])), CLR40 + '1F4243' + '194265');
eq('40 c cedilla, a grave, u diaeresis', slide(grid(40, text(40, 1, 1, 'çàü'))), CLR40 + '1F4141' + '194B63' + '194161' + '194875');
eq('40 capital E acute folds', slide(grid(40, [[1, 1, 'É']])), CLR40 + '1F4141' + '45');
eq('40 pound, degree', slide(grid(40, text(40, 1, 1, '£°'))), CLR40 + '1F4141' + '1923' + '1930');
eq('40 inverse AB', slide(grid(40, text(40, 1, 1, 'AB', M.A_INV))), CLR40 + '1F4141' + '1B5D' + '4142' + '1B5C');
eq('40 blink', slide(grid(40, [[1, 1, 'Z', M.A_BLINK]])), CLR40 + '1F4141' + '1B48' + '5A' + '1B49');
eq('40 REP 10 x A', slide(grid(40, text(40, 1, 1, 'AAAAAAAAAA'))), CLR40 + '1F4141' + '41' + '1249');
eq('40 3 x A: no REP', slide(grid(40, text(40, 1, 1, 'AAA'))), CLR40 + '1F4141' + '414141');
eq('40 colour 3', slide(grid(40, [[1, 1, 'C', 0, 3]])), CLR40 + '1F4141' + '1B43' + '43' + '1B47');
eq('40 mosaic block', slide(grid(40, [[3, 1, 0x7F, M.A_MOSAIC]])), CLR40 + '1F4341' + '0E' + '7F' + '0F');
eq('40 mosaic disjoint', slide(grid(40, [[3, 1, 0x7F, M.A_MOSAIC | M.A_UL]])), CLR40 + '1F4341' + '0E1B5A' + '7F' + '1B590F');
eq('40 double size X', slide(grid(40, [[5, 1, 'X', M.A_DBLH | M.A_DBLW], [5, 2, 0, M.A_DBLH | M.A_DBLW]])), CLR40 + '1F4541' + '1B4F' + '58' + '1B4C');
eq('40 double height', slide(grid(40, [[5, 7, 'H', M.A_DBLH]])), CLR40 + '1F4547' + '1B4D' + '48' + '1B4C');
eq('40 double height on row 1 dropped', slide(grid(40, [[1, 1, 'H', M.A_DBLH]])), CLR40 + '1F4141' + '48');
eq('40 last cell of row 24 never written', slide(grid(40, [[24, 40, 'X']])), CLR40);
eq('40 row 24 col 39', slide(grid(40, [[24, 39, 'X']])), CLR40 + '1F5867' + '58');
eq('40 backquote', slide(grid(40, [[1, 1, '`']])), CLR40 + '1F4141' + '27');
eq('40 two rows', slide(grid(40, [[1, 2, 'a'], [3, 40, 'b']])), CLR40 + '1F4142' + '61' + '1F4368' + '62');
// mosaic background colour (ESC 0x50+c), after the ink; text after a coloured background: a new run
{
  const g = M.newGrid(40);
  const set = (c, ch, a, fg, bg) => { const i = M.idx(g, 2, c); g.ch[i] = ch; g.at[i] = a; g.fg[i] = fg; g.bg[i] = bg; };
  set(1, 0x7F, M.A_MOSAIC, 3, 0); set(2, 0x21, M.A_MOSAIC, 3, 4); set(3, 0x21, M.A_MOSAIC, 3, 4); set(4, 0x21, M.A_MOSAIC, 3, 4); set(5, 0x41, 0, 7, 0);
  M.normalize(g);
  eq('40 mosaic background', slide(g), CLR40 + '1F4241' + '0E1B43' + '7F' + '1B54' + '212121' + '0F1B471B50' + '1F4245' + '41');
  const g2 = M.newGrid(40);
  const i = M.idx(g2, 1, 1); g2.ch[i] = 0x41; g2.bg[i] = 3; M.normalize(g2);
  eq('text cells never keep a background', g2.bg[i], 0);
  const v = M.decodeVideotex(Uint8Array.from([0x0C, 0x1F, 0x41, 0x41, 0x0E, 0x1B, 0x52, 0x20, 0x23, 0x0F, 0x1B, 0x54, 0x20]));
  eq('vdt background decoded', [0, 1, 2].map(k => `${v.ch[k].toString(16)}/${v.at[k]}/${v.bg[k]}`).join(' '), '20/32/2 23/32/2 20/32/4');
}
eq('80 e acute', slide(grid(80, [[1, 1, 'é']])), CLR80 + '1B5B313B3148' + '0E7B0F');
eq('80 e circumflex folds', slide(grid(80, [[1, 1, 'ê']])), CLR80 + '1B5B313B3148' + '65');
eq('80 bold inverse', slide(grid(80, [[2, 5, 'x', M.A_BOLD | M.A_INV]])), CLR80 + '1B5B323B3548' + '1B5B316D' + '1B5B376D' + '78' + '1B5B306D');
eq('80 underline then plain', slide(grid(80, [[10, 70, 'u', M.A_UL], [10, 71, 'p']])), CLR80 + '1B5B31303B373048' + '1B5B346D' + '75' + '1B5B306D' + '70');
eq('80 last cell of row 24', slide(grid(80, [[24, 80, 'X']])), CLR80);
eq('80 gap > 8 splits', slide(grid(80, [[1, 1, 'a'], [1, 20, 'b']])), CLR80 + '1B5B313B3148' + '61' + '1B5B313B323048' + '62');
eq('80 gap of 8 inline', slide(grid(80, [[1, 1, 'a'], [1, 10, 'b']])), CLR80 + '1B5B313B3148' + '61' + '2020202020202020' + '62');

// ---- random screens -------------------------------------------------------------------------
function rng(seed) {
  let s = (seed * 2654435761 + 12345) >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const CHARS40 = 'ABCabc  xyz0123!?.é è à ç ù ê â î ô û ë ï ü ö £ § ° ± ß ÷ ¼ ½ ¾'.split('').map(c => c.codePointAt(0));
const CHARS80 = 'ABCabc  xyz0123!?.é è à ç ù £ § °'.split('').map(c => c.codePointAt(0));
function randomGrid(cols, seed, withColour) {
  const R = rng(seed + 1);
  const g = M.newGrid(cols);
  const pick = (a) => a[Math.floor(R() * a.length)];
  for (let r = 1; r <= 24; r++) {
    if (R() < 0.25) continue;
    let c = 1 + Math.floor(R() * cols / 2);
    while (c <= cols) {
      const kind = R();
      const len = 1 + Math.floor(R() * (R() < 0.2 ? 30 : 6));
      const run = R() < 0.3;
      let a = 0, fg = 7;
      if (R() < 0.2) a |= M.A_INV;
      if (R() < 0.15) a |= M.A_BLINK;
      if (cols === 80) { if (R() < 0.2) a |= M.A_BOLD; if (R() < 0.15) a |= M.A_UL; }
      else if (withColour && R() < 0.3) fg = Math.floor(R() * 8);
      if (cols === 40 && kind < 0.3) {   // mosaic run
        a = M.A_MOSAIC | (R() < 0.3 ? M.A_UL : 0) | (a & M.A_BLINK);
        let code = 0x20 | Math.floor(R() * 0x60);
        const bg = withColour && R() < 0.4 ? Math.floor(R() * 8) : 0;
        for (let k = 0; k < len && c <= cols; k++, c++) {
          const i = M.idx(g, r, c);
          g.ch[i] = code; g.at[i] = a; g.fg[i] = fg; g.bg[i] = bg;
          if (!run) code = (0x20 | Math.floor(R() * 0x60)) & 0x7F;
        }
      } else if (cols === 40 && kind < 0.45) {   // double width / size
        if (R() < 0.5 && r > 1) a |= M.A_DBLH;
        a |= M.A_DBLW;
        let ch = pick(CHARS40);
        for (let k = 0; k < len && c + 1 <= cols; k++, c += 2) {
          const i = M.idx(g, r, c);
          g.ch[i] = ch; g.at[i] = a; g.fg[i] = fg;
          g.ch[i + 1] = 0; g.at[i + 1] = a; g.fg[i + 1] = fg;
          if (!run) ch = pick(CHARS40);
        }
      } else {
        if (cols === 40 && r > 1 && R() < 0.1) a |= M.A_DBLH;
        let ch = pick(cols === 80 ? CHARS80 : CHARS40);
        for (let k = 0; k < len && c <= cols; k++, c++) {
          const i = M.idx(g, r, c);
          g.ch[i] = ch; g.at[i] = a; g.fg[i] = fg;
          if (!run) ch = pick(cols === 80 ? CHARS80 : CHARS40);
        }
      }
      c += Math.floor(R() * 12);
    }
  }
  return M.normalize(g);
}

// never the protocol commands
{
  let bad = 0;
  for (let t = 0; t < 200; t++) {
    const b = M.encodeSlide(randomGrid(t % 2 ? 80 : 40, t, true));
    for (let i = 0; i + 1 < b.length; i++) if (b[i] === 0x1B && [0x39, 0x3A, 0x3B, 0x63].includes(b[i + 1])) bad++;
    for (const v of b) if (v > 0x7F) bad++;
  }
  eq('no ESC 39/3A/3B/63, 7-bit only', bad, 0);
}

// ---- 2. against the firmware ------------------------------------------------------------------
const harness = process.argv[2];
if (harness) {
  let script = '';
  const expect = [];
  for (let t = 0; t < 400; t++) {
    const cols = t % 3 === 2 ? 80 : 40;
    const g = randomGrid(cols, 1000 + t, false);   // the firmware has no colour
    script += `W ${cols}\nL\n`;
    expect.push([`clear ${cols}`, hex(M.encodeClear(cols === 80))]);
    for (let r = 1; r <= 24; r++) for (let c = 1; c <= cols; c++) {
      const i = M.idx(g, r, c);
      if (g.ch[i] !== 0x20 || g.at[i]) script += `C ${r} ${c} ${g.ch[i]} ${g.at[i]}\n`;
    }
    for (let r = 1; r <= 24; r++) for (const [a, b] of M.rowSpans(g, r)) {
      script += `S ${r} ${a} ${b}\n`;
      expect.push([`screen ${t} (${cols}) row ${r} ${a}-${b}`, hex(M.encodeSpan(g, r, a, b))]);
    }
  }
  const out = execFileSync(harness, { input: script, maxBuffer: 64 << 20 }).toString().trim().split('\n');
  eq('firmware output count', out.length, expect.length);
  let spans = 0;
  expect.forEach(([name, want], k) => { eq('firmware ' + name, want, out[k] || ''); spans++; });
  console.log(`firmware comparison: ${spans} spans / clears over 400 random screens`);
} else {
  console.log('(no firmware harness given: skipping the comparison; use test/run-tests.sh)');
}

// ---- 3. round trips ---------------------------------------------------------------------------
function sameGrid(a, b) {
  for (let i = 0; i < a.ch.length; i++) if (a.ch[i] !== b.ch[i] || a.at[i] !== b.at[i] || a.fg[i] !== b.fg[i] || a.bg[i] !== b.bg[i]) return i;
  return -1;
}
for (let t = 0; t < 300; t++) {
  const cols = t % 2 ? 80 : 40;
  const g = randomGrid(cols, 5000 + t, true);
  const bytes = M.encodeSlide(g);
  checks++;
  if (bytes.length > M.SLIDE_MAX) console.log('note: random screen over the limit', bytes.length);
  const back = cols === 40 ? M.decodeVideotex(bytes) : M.decodeMixte(bytes);
  const d = sameGrid(g, back);
  if (d >= 0) {
    fails++;
    const r = Math.floor(d / cols) + 1, c = d % cols + 1;
    console.log(`FAIL round trip ${cols} screen ${t} at row ${r} col ${c}: ${g.ch[d]}/${g.at[d]}/${g.fg[d]}/${g.bg[d]} -> ${back.ch[d]}/${back.at[d]}/${back.fg[d]}/${back.bg[d]}`);
  }
  eq(`sniff ${cols}`, M.sniff(bytes), cols === 40 ? 'vdt' : 'mixte');
}
// JSON round trip
{
  const g = randomGrid(40, 77, true);
  checks++; if (!g.bg.some(b => b)) { fails++; console.log('FAIL json test grid has no background'); }
  eq('json round trip', sameGrid(g, M.gridFromJSON(JSON.parse(JSON.stringify(M.gridToJSON(g))))), -1);
}
// text import
{
  const g = M.decodeText('Héllo «x»\nÉtÉ', 40);
  eq('text import', String.fromCodePoint(...g.ch.slice(0, 9)) + '|' + String.fromCodePoint(...g.ch.slice(40, 43)), 'Héllo "x"|EtE');
}

console.log(`${checks - fails}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
