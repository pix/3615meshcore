// Image import against mtl (tools/mtl/image.go): node test/image-test.js [path to the mtl binary]
// For each option set, `mtl slide encode` output must equal the port's bytes (same cells,
// same writer), the editor's cells must look the same as mtl's page decoded, and the
// editor's own encoding (the firmware's encoder) must decode back to those cells.
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const M = require(path.join(__dirname, '..', 'minitel.js'));
const MI = require(path.join(__dirname, '..', 'image.js'));
const decodePNG = require('./png.js');

const MTL_DIR = path.join(__dirname, '..', '..', 'mtl');
const mtl = process.argv[2] || path.join(MTL_DIR, 'mtl');
const sample = path.join(MTL_DIR, 'samples', 'relais-iso.png');
const build = path.join(__dirname, '.build');
fs.mkdirSync(build, { recursive: true });

let fails = 0, checks = 0;
const ok = (name, cond, extra) => { checks++; if (!cond) { fails++; console.log('FAIL', name, extra || ''); } else console.log('ok  ', name, extra || ''); };
const GREY = [0.0, 0.45, 0.65, 0.87, 0.30, 0.55, 0.75, 1.0];

// what each cell shows: per sextant grey (mosaics, blanks) or the character and its attributes
function look(g) {
  const out = [];
  for (let i = 0; i < g.ch.length; i++) {
    const a = g.at[i], ch = g.ch[i];
    if (a & M.A_MOSAIC) {
      const bits = [1, 2, 4, 8, 16, 64];
      out.push(bits.map(b => (ch & b ? GREY[g.fg[i]] : GREY[g.bg[i]])).join(','));
    } else if (ch === 0x20 && !(a & M.A_INV)) out.push('0,0,0,0,0,0');
    else out.push(`${ch}/${a}`);
  }
  return out;
}
function sameLook(a, b) {
  const la = look(a), lb = look(b);
  for (let i = 0; i < la.length; i++) if (la[i] !== lb[i]) return `cell ${i}: ${la[i]} vs ${lb[i]}`;
  return '';
}
function firstDiff(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `first difference at byte ${i} of ${a.length}/${b.length}`;
  return '';
}

const px = decodePNG(fs.readFileSync(sample));
console.log(`sample ${px.w}x${px.h}`);
const cases = [
  { cols: 40, flags: [], o: {} },
  { cols: 40, flags: ['-dither'], o: { dither: true } },
  { cols: 80, flags: [], o: {} },
  { cols: 80, flags: ['-dither'], o: { dither: true } },
  { cols: 40, flags: ['-contrast', '-gamma', '1.6'], o: { contrast: true, gamma: 1.6 } },
  { cols: 40, flags: ['-dither', '-gamma', '0.7'], o: { dither: true, gamma: 0.7 } },
  { cols: 80, flags: ['-dither', '-contrast', '-gamma', '0.7'], o: { dither: true, contrast: true, gamma: 0.7 } },
];
const haveMtl = fs.existsSync(mtl);
if (!haveMtl) console.log(`(no mtl binary at ${mtl}: only the editor round trips are checked)`);
for (const k of cases) {
  const name = `${k.cols} col ${k.flags.join(' ') || '(no options)'}`;
  const o = Object.assign({ gamma: 1 }, k.o);
  const portBytes = k.cols === 40 ? MI.videotexBytes(MI.videotexCells(px, o)) : MI.mixteBytes(MI.mixteCells(px, o));
  const grid = MI.convert(px, k.cols, o);
  const ours = M.encodeSlide(grid);
  if (haveMtl) {
    const out = path.join(build, `go-${k.cols}${k.flags.join('')}.bin`);
    execFileSync(mtl, ['slide', 'encode', '-cols', String(k.cols), ...k.flags, '-o', out, sample], { cwd: MTL_DIR });
    const goBytes = new Uint8Array(fs.readFileSync(out));
    ok(`${name}: port bytes = mtl bytes`, Buffer.from(portBytes).equals(Buffer.from(goBytes)), `(${goBytes.length} bytes) ${firstDiff(portBytes, goBytes)}`);
    const goGrid = k.cols === 40 ? M.decodeVideotex(goBytes) : M.decodeMixte(goBytes);
    const d = sameLook(grid, goGrid);
    ok(`${name}: editor cells look like mtl's page`, !d, d);
    console.log(`      editor encoding ${ours.length} bytes, mtl ${goBytes.length} bytes`);
  }
  const back = k.cols === 40 ? M.decodeVideotex(ours) : M.decodeMixte(ours);
  const d2 = sameLook(grid, back);
  ok(`${name}: editor encoding decodes back to the same screen`, !d2, d2);
  ok(`${name}: within the slide limit`, ours.length <= M.SLIDE_MAX, ours.length);
}
// background colours survive the project file and a .vdt export / import
{
  const g = MI.convert(px, 40, { gamma: 1 });
  ok('image uses background colours', g.bg.some(b => b));
  const j = M.gridFromJSON(JSON.parse(JSON.stringify(M.gridToJSON(g))));
  ok('background colours: JSON round trip', !sameLook(g, j) && g.bg.every((b, i) => b === j.bg[i]));
  const v = M.decodeVideotex(M.encodeSlide(g));
  ok('background colours: .vdt round trip (cells identical)', ['ch', 'at', 'fg', 'bg'].every(f => g[f].every((x, i) => x === v[f][i])));
}
console.log(`${checks - fails}/${checks} image checks passed`);
process.exit(fails ? 1 : 0);
