// The editor draws with the website's web font (site/assets/fonts/minitel40.woff2) when it is
// served over HTTP, and falls back to the embedded Minitel.ttf from a local file. This test
// serves the repository and the built site, checks which font each one loads, and compares the
// dots of every character the font draws (plus composed accents and aliases) between the web
// font and the embedded TTF: they must be identical.
//   NODE_PATH=<dir with playwright> node test/font-test.js
// (the site must be built first: python3 -I site/build.py)
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const REPO = path.join(__dirname, '..', '..', '..');
const DIST = path.join(REPO, 'site', 'dist');

function serve(dir, port) {
  const p = spawn('python3', ['-m', 'http.server', String(port), '-b', '127.0.0.1', '-d', dir], { stdio: 'ignore' });
  return new Promise(ok => setTimeout(() => ok(p), 700));
}

let fails = 0;
function check(ok, what) {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) fails++;
}

async function dotsOf(page) {
  return page.evaluate(() => {
    const R = window.MinitelRender;
    const cps = [];
    for (let c = 0x20; c < 0x7F; c++) cps.push(c);
    for (let c = 0xA0; c <= 0xFF; c++) cps.push(c);
    cps.push(0x152, 0x153, 0x2019, 0x2190, 0x2191, 0x2192, 0x2193, 0x2212, 0x2014, 0x2500, 0x2502, 0x201C, 0x2022);
    const out = {};
    for (const c of cps) out[c] = Array.from(R.glyphFor(c)).join('');
    return out;
  });
}

(async () => {
  const servers = [await serve(REPO, 8731), await serve(DIST, 8732)];
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    // the repository, served over HTTP
    await page.goto('http://127.0.0.1:8731/tools/slide-designer/index.html');
    await page.waitForFunction(() => window.MinitelRender && window.MinitelRender.fontReady);
    let src = await page.evaluate(() => window.MinitelRender.fontSource);
    check(src === '../../site/assets/fonts/minitel40.woff2', 'repository: the site web font (' + src + ')');
    const web = await dotsOf(page);
    await page.evaluate(() => window.MinitelRender.loadFont({ embedded: true }));
    src = await page.evaluate(() => window.MinitelRender.fontSource);
    check(src.startsWith('Minitel.ttf'), 'embedded font loaded on demand (' + src + ')');
    const ttf = await dotsOf(page);
    const diff = Object.keys(web).filter(c => web[c] !== ttf[c]);
    check(diff.length === 0, `${Object.keys(web).length} characters, web font = embedded TTF dot for dot` +
      (diff.length ? ': differ ' + diff.map(c => 'U+' + Number(c).toString(16)).join(' ') : ''));
    const drawn = Object.values(web).filter(g => g.includes('1')).length;
    check(drawn > 150, `${drawn} characters drawn (not blank)`);

    // the published site: editeur/ beside assets/
    await page.goto('http://127.0.0.1:8732/editeur/index.html');
    await page.waitForFunction(() => window.MinitelRender && window.MinitelRender.fontReady);
    src = await page.evaluate(() => window.MinitelRender.fontSource);
    check(src === '../assets/fonts/minitel40.woff2', 'site: its own web font (' + src + ')');
    const site = await dotsOf(page);
    check(Object.keys(site).every(c => site[c] === web[c]), 'site = repository, dot for dot');
    check(await page.evaluate(() => !window.MINITEL_TTF_B64), 'site: the embedded font is not loaded');

    // a local file: the embedded font
    await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
    await page.waitForFunction(() => window.MinitelRender && window.MinitelRender.fontReady);
    src = await page.evaluate(() => window.MinitelRender.fontSource);
    check(src.startsWith('Minitel.ttf'), 'local file: embedded font (' + src + ')');
    check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally {
    await browser.close();
    servers.forEach(p => p.kill());
  }
  console.log(fails ? `${fails} FAILED` : 'all font checks passed');
  process.exit(fails ? 1 : 0);
})();
