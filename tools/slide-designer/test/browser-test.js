// Headless Chromium smoke test of the designer page (needs the `playwright` module:
//   NODE_PATH=<dir with playwright> node test/browser-test.js [screenshot dir]).
// Loads index.html from file://, fails on any console error / page error, then types,
// draws mosaics, converts 40 -> 80, imports a .vdt and checks the shown byte sizes
// against minitel.js.
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const M = require(path.join(__dirname, '..', 'minitel.js'));
const MI = require(path.join(__dirname, '..', 'image.js'));
const decodePNG = require('./png.js');
const SAMPLE = path.join(__dirname, '..', '..', 'mtl', 'samples', 'relais-iso.png');

const shots = process.argv[2] || path.join(__dirname, '.build');
fs.mkdirSync(shots, { recursive: true });
const url = 'file://' + path.join(__dirname, '..', 'index.html');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(url);
  await page.waitForFunction(() => window.MinitelRender && window.MinitelRender.fontReady);
  await page.waitForTimeout(300);
  let fails = 0;
  const check = (name, ok, extra) => { if (!ok) { fails++; console.log('FAIL', name, extra || ''); } else console.log('ok  ', name); };

  // font raster sanity: 'A' has dots, space none, é differs from e
  const glyphs = await page.evaluate(() => {
    const R = window.MinitelRender;
    const n = (cp) => R.glyphFor(cp).reduce((a, b) => a + b, 0);
    return { A: n(0x41), sp: n(0x20), e: n(0x65), eacute: n(0xE9), aacute: n(0xE1), a: n(0x61), bar: n(0x2500) };
  });
  check('font glyphs rasterised', glyphs.A > 10 && glyphs.sp === 0 && glyphs.eacute > glyphs.e && glyphs.aacute > glyphs.a && glyphs.bar > 0, JSON.stringify(glyphs));

  // type text
  const scr = page.locator('#screen');
  const box = await scr.boundingBox();
  const cell = (r, c, cols = 40) => ({ x: box.x + (c - 0.5) * box.width / cols, y: box.y + (r - 0.5) * box.height / 24 });
  let p = cell(3, 5);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.type('Bonjour été');
  await page.click('#penToggles [data-pen="inv"]');
  p = cell(5, 5);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.type('INVERSE');
  await page.click('#penToggles [data-pen="inv"]');
  await page.click('#sizeSeg [data-size="3"]');
  p = cell(9, 3);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.type('3615');
  await page.click('#sizeSeg [data-size="0"]');
  // colour 4 and mosaic drawing
  await page.click('#swatches [data-fg="4"]');
  await page.click('#toolSeg [data-tool="draw"]');
  const a = cell(14, 4), b = cell(18, 30);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();
  await page.click('#toolSeg [data-tool="text"]');
  await page.click('#swatches [data-fg="7"]');

  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('minitel-slide-designer.v1') || 'null'));
  await page.waitForTimeout(600);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('minitel-slide-designer.v1')));
  check('autosave in localStorage', saved && saved.slides && saved.slides[0].v40, st ? '' : '(first read before debounce)');
  const g40 = M.gridFromJSON(saved.slides[0].v40);
  const row3 = String.fromCodePoint(...g40.ch.slice(2 * 40 + 4, 2 * 40 + 15));
  check('typed text in the grid', row3 === 'Bonjour été', row3);
  const bytes40 = M.encodeSlide(g40);
  const shown = await page.textContent('#meterText');
  check('byte size shown = minitel.js', shown.replace(/,/g, '').startsWith(String(bytes40.length) + ' /'), `${shown} vs ${bytes40.length}`);
  let mos = 0;
  for (let i = 0; i < g40.at.length; i++) if (g40.at[i] & M.A_MOSAIC) mos++;
  check('mosaic cells drawn', mos > 10, mos);
  check('double size cells', g40.at[M.idx(g40, 9, 3)] === (M.A_DBLH | M.A_DBLW) && g40.ch[M.idx(g40, 9, 4)] === 0);
  await page.screenshot({ path: path.join(shots, 'designer-40.png') });

  // blink preview toggle and grid
  await page.check('#optGrid');
  await page.check('#optBlink');
  await page.waitForTimeout(1100);
  await page.uncheck('#optBlink');

  // 40 -> 80
  await page.click('#conv4080');
  await page.waitForTimeout(200);
  const v80 = await page.evaluate(() => JSON.parse(localStorage.getItem('minitel-slide-designer.v1') || 'null'));
  await page.waitForTimeout(600);
  const saved2 = await page.evaluate(() => JSON.parse(localStorage.getItem('minitel-slide-designer.v1')));
  check('80 col version created', !!saved2.slides[0].v80, v80 ? '' : '');
  const g80 = M.gridFromJSON(saved2.slides[0].v80);
  const r3 = String.fromCodePoint(...g80.ch.slice(2 * 80 + 24, 2 * 80 + 35));
  check('converted text centred', r3 === 'Bonjour été', r3);
  p = cell(20, 10, 80);
  await page.mouse.click(p.x, p.y);
  await page.click('#penToggles [data-pen="bold"]');
  await page.keyboard.type('Gras ê');
  await page.screenshot({ path: path.join(shots, 'designer-80.png') });

  // import a .vdt into the 40 col version
  const vg = M.newGrid(40);
  const put = (r, c, s, a = 0, fg = 7) => Array.from(s).forEach((ch, k) => { const i = M.idx(vg, r, c + k); vg.ch[i] = ch.codePointAt(0); vg.at[i] = a; vg.fg[i] = fg; });
  put(2, 2, 'IMPORTÉ ç à', M.A_INV);
  put(4, 2, 'gris', 0, 2);
  for (let c = 1; c <= 40; c++) { const i = M.idx(vg, 6, c); vg.ch[i] = 0x7F; vg.at[i] = M.A_MOSAIC; vg.fg[i] = 3; }
  M.normalize(vg);
  const vdt = M.encodeSlide(vg);
  const vdtPath = path.join(shots, 'import-test.vdt');
  fs.writeFileSync(vdtPath, vdt);
  await page.setInputFiles('#fileImport', vdtPath);
  await page.waitForTimeout(900);
  const saved3 = await page.evaluate(() => JSON.parse(localStorage.getItem('minitel-slide-designer.v1')));
  const back = M.gridFromJSON(saved3.slides[0].v40);
  check('vdt import = encoded grid', Buffer.from(M.encodeSlide(back)).equals(Buffer.from(vdt)));
  await page.screenshot({ path: path.join(shots, 'designer-import.png') });

  // image import: the dialog's result = image.js run in Node on the same file (both versions)
  if (fs.existsSync(SAMPLE)) {
    const px = decodePNG(fs.readFileSync(SAMPLE));
    const same = (a, b) => ['ch', 'at', 'fg', 'bg'].every(f => a[f].length === b[f].length && a[f].every((x, i) => x === b[f][i]));
    const grids = async () => { await page.waitForTimeout(600); const p = await page.evaluate(() => JSON.parse(localStorage.getItem('minitel-slide-designer.v1'))); return p.slides[0]; };
    await page.click('.tabs [data-tab="design"]');
    await page.setInputFiles('#fileImage', SAMPLE);
    await page.waitForSelector('#imgDlg[open]');
    await page.click('#imgTarget [data-t="both"]');
    await page.waitForTimeout(300);
    const want40 = MI.convert(px, 40, { gamma: 1 }), want80 = MI.convert(px, 80, { gamma: 1 });
    const szText = await page.textContent('#imgSz40');
    check('image dialog: size shown', szText.replace(/,/g, '').startsWith(String(M.encodeSlide(want40).length)), szText);
    await page.screenshot({ path: path.join(shots, 'designer-image-dialog.png') });
    await page.click('#imgApply');
    let sl = await grids();
    check('image import 40 col = image.js (Node)', same(M.gridFromJSON(sl.v40), want40));
    check('image import 80 col = image.js (Node)', same(M.gridFromJSON(sl.v80), want80));
    check('image import keeps background colours', !!sl.v40.rows.some(r => r.b));
    await page.screenshot({ path: path.join(shots, 'designer-image.png') });
    // options: dither, contrast, gamma 1.6, 40 col only, through drag and drop on the screen
    const b64 = fs.readFileSync(SAMPLE).toString('base64');
    await page.evaluate((b) => {
      const bin = Uint8Array.from(atob(b), c => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bin], 'relais-iso.png', { type: 'image/png' }));
      const wrap = document.querySelector('#screenWrap');
      wrap.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      wrap.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, b64);
    await page.waitForSelector('#imgDlg[open]');
    await page.click('#imgTarget [data-t="40"]');
    await page.check('#imgDither');
    await page.check('#imgContrast');
    await page.fill('#imgGamma', '1.6');
    await page.dispatchEvent('#imgGamma', 'input');
    await page.waitForTimeout(300);
    await page.click('#imgApply');
    sl = await grids();
    check('dropped image, dither + contrast + gamma 1.6 = image.js', same(M.gridFromJSON(sl.v40), MI.convert(px, 40, { dither: true, contrast: true, gamma: 1.6 })));
    check('80 col version untouched', same(M.gridFromJSON(sl.v80), want80));
    // undo brings the previous 40 col picture back
    await page.click('#actUndo');
    sl = await grids();
    check('undo after image import', same(M.gridFromJSON(sl.v40), want40));
    // the renderer draws mosaic backgrounds
    const dots = await page.evaluate(() => {
      const g = Minitel.newGrid(40), i = Minitel.idx(g, 2, 1);
      g.ch[i] = 0x21; g.at[i] = Minitel.A_MOSAIC; g.fg[i] = 7; g.bg[i] = 2;   // top-left block white, rest green
      const d = MinitelRender.renderDots(g, true);
      return [d.D[10 * d.W + 0], d.D[(10 + 9) * d.W + 7]];
    });
    check('renderer: mosaic ink and background levels', dots[0] === 1 && Math.abs(dots[1] - 0.65) < 1e-6, JSON.stringify(dots));
  } else console.log('(no sample image: image import not tested)');

  // Minitel tab renders (no device here)
  await page.click('.tabs [data-tab="minitel"]');
  await page.screenshot({ path: path.join(shots, 'designer-minitel-tab.png') });

  // reload: the project comes back from localStorage
  await page.reload();
  await page.waitForFunction(() => window.MinitelRender && window.MinitelRender.fontReady);
  const names = await page.$$eval('#slideList li', (l) => l.length);
  check('reload restores the project', names === 1);

  check('no console errors / warnings', errors.length === 0, '\n  ' + errors.join('\n  '));
  await browser.close();
  console.log(fails ? `${fails} failure(s)` : 'browser test passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
