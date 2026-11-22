// Upload and read-back flow against a mock MeshCore device (navigator.bluetooth replaced in the page),
// which answers the custom CLI frames as UITaskSaver.cpp does: C0 'C' <cmd> in,
// 70 'C' <more> <text> out (long replies split over several notifications).
//   NODE_PATH=<dir with playwright> node test/ble-mock-test.js [screenshot dir]
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const M = require(path.join(__dirname, '..', 'minitel.js'));

const shots = process.argv[2] || path.join(__dirname, '.build');
fs.mkdirSync(shots, { recursive: true });
const url = 'file://' + path.join(__dirname, '..', 'index.html');

function mockDevice() {
  const NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const st = { slides: {}, up: null, frames: [], maxFrame: 0, maxCmd: 0, splash: 600, off: 3600, hist: 40 };
  window.__mock = st;
  let notify = null;
  // one notification; st.dup = true delivers each one twice back to back, as BlueZ over D-Bus did
  const fire = (bytes) => {
    if (!notify) return;
    const one = () => notify({ target: { value: new DataView(Uint8Array.from(bytes).buffer) } });
    one();
    if (st.dup) one();
  };
  const raw = (bytes, delay) => setTimeout(() => fire(bytes), delay);
  window.__mockPush = (bytes) => fire(bytes);
  // the terminal channel (preview): mode, generation, what the Minitel received per mode
  st.term = { open: false, cols: 80, gen: 7, switching: false, recv: { 40: [], 80: [] }, dGens: [], dCount: 0, stalls: 0, stalled: false, maxD: 0, xReq: 0, opens: 0, notReady: false };
  const send = (text) => {
    const b = new TextEncoder().encode(text);
    const parts = [];
    for (let i = 0; i < b.length; i += 40) parts.push(b.subarray(i, i + 40));
    parts.forEach((p, k) => {
      const f = new Uint8Array(p.length + 3);
      f[0] = 0x70; f[1] = 0x43; f[2] = k < parts.length - 1 ? 1 : 0;
      f.set(p, 3);
      setTimeout(() => {
        // a stray push frame first, which the client must ignore
        if (k === 0) fire([0x83, 1, 2]);
        fire(f);
      }, 5 + k);
    });
  };
  const cli = (c) => {
    st.frames.push(c);
    const out = [];
    const ok = () => out.push('  OK');
    let m;
    if (c === 'slide list') {
      for (let n = 1; n <= 8; n++) for (const v of [40, 80]) if (st.slides[n + '.' + v]) out.push(`  ${n} ${v} ${st.slides[n + '.' + v].length}`);
      out.push('  free 1800 KB of 1984'); ok();
    } else if ((m = c.match(/^slide begin (\d+) (40|80) (\d+)$/))) {
      if (+m[3] > 12288) out.push('  ERR usage'); else { st.up = { n: +m[1], v: +m[2], size: +m[3], got: [] }; ok(); }
    } else if ((m = c.match(/^slide data ([0-9A-F]+)$/))) {
      const b = m[1].match(/../g).map(h => parseInt(h, 16));
      if (!st.up || b.length > 80 || st.up.got.length + b.length > st.up.size) out.push('  ERR data'); else { st.up.got.push(...b); ok(); }
    } else if (c === 'slide end') {
      if (!st.up) out.push('  ERR no slide begun');
      else if (st.up.got.length !== st.up.size) out.push(`  ERR size ${st.up.got.length} of ${st.up.size}`);
      else { st.slides[st.up.n + '.' + st.up.v] = st.up.got; st.up = null; ok(); }
    } else if ((m = c.match(/^slide read (\d+) (40|80)(?: (\d+))?(?: (\d+))?$/))) {
      // as UITaskSaver.cpp: count 1-240 (default 240), clamped to the end; lower-case hex
      const d = st.slides[m[1] + '.' + m[2]];
      if (!d) out.push('  ERR no such slide');
      else {
        let off = Math.min(+(m[3] || 0), d.length);
        const cnt = Math.min(Math.min(240, +(m[4] || 240)), d.length - off);
        st.reads = (st.reads || 0) + 1;
        out.push(`  size ${d.length} offset ${off} data ` + d.slice(off, off + cnt).map(x => x.toString(16).padStart(2, '0')).join(''));
        ok();
      }
    } else if ((m = c.match(/^slide del (\d+|all)(?: (40|80))?$/))) {
      for (const k of Object.keys(st.slides)) {
        const [n, v] = k.split('.');
        if ((m[1] === 'all' || m[1] === n) && (!m[2] || m[2] === v)) delete st.slides[k];
      }
      ok();
    } else if ((m = c.match(/^slide show (\d+)$/))) {
      if (!st.slides[m[1] + '.40'] && !st.slides[m[1] + '.80']) out.push('  ERR no such slide');
      else if (!st.slides[m[1] + '.40']) out.push(`  ERR slide ${m[1]} has no 40 col version (the Minitel's mode)`);
      else ok();
    } else if (c === 'saver' || (m = c.match(/^saver (\S+) (\S+)$/))) {
      const sec = (t) => { const x = t.match(/^(\d+)(s|m|h)?$/); return x ? +x[1] * ({ s: 1, m: 60, h: 3600 }[x[2] || 'm']) : NaN; };
      if (m) { st.splash = sec(m[1]); st.off = sec(m[2]); }
      out.push(`  saver splash ${st.splash} s, off ${st.off} s`); ok();
    } else if ((m = c.match(/^hist keep(?: (\d+))?$/))) {
      if (m[1]) st.hist = +m[1];
      out.push(`  hist keep ${st.hist} per conversation; 12 files, 3456 bytes`); ok();
    } else out.push('  ERR usage');
    send(out.join('\r\n') + '\r\n');
  };
  const tx = { addEventListener: (t, f) => { notify = f; }, startNotifications: async () => {} };
  const rx = {
    writeValueWithoutResponse: async (buf) => {
      const f = new Uint8Array(buf.buffer || buf);
      st.maxFrame = Math.max(st.maxFrame, f.length);
      if (f[0] !== 0xC0) { raw([1], 5); return; }
      const T = st.term, body = f.subarray(2), sub = String.fromCharCode(f[1]);
      if (sub === 'O') {   // open: the node clears the screen
        if (T.notReady) { raw([0x70, 0x4F, 1, 0, 0, 0], 5); return; }
        T.open = true; T.opens++;
        raw([0x70, 0x4F, 0, T.cols, 24, T.gen], 5);
        return;
      }
      if (sub === 'M') {   // switch mode: reply, then the push with the new generation
        const v = body[0];
        raw([0x70, 0x4D, 0], 5);
        T.switching = true;
        setTimeout(() => { T.cols = v; T.gen = (T.gen + 1) & 0xFF; T.switching = false; fire([0xF0, 0x4D, v, 24, T.gen]); }, 60);
        return;
      }
      if (sub === 'D') {   // screen bytes: all, or 0 when the queue is full (every 4th frame, once)
        const gen = body[0], data = Array.from(body.subarray(1));
        T.maxD = Math.max(T.maxD, data.length);
        if (gen !== T.gen || T.switching || !T.open) { raw([0x70, 0x44, 1, 0, 0, 0], 5); return; }
        if (++T.dCount % 4 === 0 && !T.stalled) { T.stalled = true; T.stalls++; raw([0x70, 0x44, 0, 0, 0, 0], 5); return; }
        T.stalled = false;
        T.recv[T.cols].push(...data);
        T.dGens.push(gen);
        raw([0x70, 0x44, 0, data.length, 0x00, 0x04], 5);
        return;
      }
      if (sub === 'X') { T.open = false; T.xReq++; raw([0x70, 0x58, 0], 5); return; }
      if (sub !== 'C') { raw([1], 5); return; }
      const c = new TextDecoder().decode(f.subarray(2));
      st.maxCmd = Math.max(st.maxCmd, c.length);
      cli(c);
    },
  };
  const svc = { getCharacteristic: async (u) => (u.startsWith('6e400002') ? rx : tx) };
  const dev = {
    name: 'MeshCore-Mock', id: 'mock', addEventListener() {},
    gatt: { connected: false, async connect() { this.connected = true; return { getPrimaryService: async (u) => { if (u !== NUS) throw new Error('svc'); return svc; } }; }, disconnect() { this.connected = false; } },
  };
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice: async (o) => { st.request = o; return dev; } } });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());
  await page.addInitScript(mockDevice);
  await page.goto(url);
  await page.waitForFunction(() => window.MinitelRender && window.MinitelRender.fontReady);
  let fails = 0;
  const check = (name, ok, extra) => { if (!ok) { fails++; console.log('FAIL', name, extra || ''); } else console.log('ok  ', name); };

  // a slide with a large 40 col version (several data chunks) and an 80 col one
  const g40 = M.newGrid(40);
  for (let r = 2; r <= 23; r++) for (let c = 1; c <= 40; c++) { const i = M.idx(g40, r, c); g40.ch[i] = 0x20 | ((r * 7 + c * 13) & 0x5F); g40.at[i] = M.A_MOSAIC; g40.fg[i] = (r + c) & 7; }
  M.normalize(g40);
  const g80 = M.decodeText('Bonjour à tous — 80 colonnes', 80);
  const proj = { format: 'minitel-slide-designer', version: 1, name: 'Mock', slides: [{ name: 'Big', slot: null, v40: M.gridToJSON(g40), v80: M.gridToJSON(g80) }] };
  const projPath = path.join(shots, 'mock-project.json');
  fs.writeFileSync(projPath, JSON.stringify(proj));
  await page.setInputFiles('#fileProject', projPath);
  await page.waitForTimeout(300);

  await page.click('.tabs [data-tab="minitel"]');
  await page.click('#bleConnect');
  await page.waitForFunction(() => /Connected/.test(document.querySelector('#bleState').textContent));
  await page.waitForTimeout(300);
  const req = await page.evaluate(() => window.__mock.request);
  check('requestDevice filter', req.filters[0].namePrefix === 'MeshCore' && req.optionalServices[0] === '6e400001-b5a3-f393-e0a9-e50e24dcca9e');
  check('saver read on connect', (await page.inputValue('#svSplash')) === '10m' && (await page.inputValue('#svOff')) === '1h');
  check('hist read on connect', (await page.inputValue('#histKeep')) === '40');

  await page.selectOption('#upSlot', '3');
  await page.selectOption('#upVer', 'both');
  await page.click('#upGo');
  await page.waitForFunction(() => /Uploaded|failed/.test(document.querySelector('#upText').textContent), null, { timeout: 30000 });
  const upText = await page.textContent('#upText');
  check('upload finished', /Uploaded to slot 3/.test(upText), upText);
  const st = await page.evaluate(() => window.__mock);
  const want40 = Array.from(M.encodeSlide(g40)), want80 = Array.from(M.encodeSlide(g80));
  check('device got the exact 40 col bytes', JSON.stringify(st.slides['3.40']) === JSON.stringify(want40), `${(st.slides['3.40'] || []).length} vs ${want40.length}`);
  check('device got the exact 80 col bytes', JSON.stringify(st.slides['3.80']) === JSON.stringify(want80));
  check('frames <= 172 bytes, commands < 160 chars', st.maxFrame <= 172 && st.maxCmd < 160, `${st.maxFrame} / ${st.maxCmd}`);
  const dataCmds = st.frames.filter(f => f.startsWith('slide data')).length;
  check('70-byte chunks', dataCmds === Math.ceil(want40.length / 70) + Math.ceil(want80.length / 70), dataCmds);
  const row3 = await page.$$eval('#slotRows tr:nth-child(3) td', (t) => t.map(x => x.textContent));
  check('slot table shows slot 3', /KB|B/.test(row3[1]) && /B/.test(row3[2]), JSON.stringify(row3));
  await page.screenshot({ path: path.join(shots, 'designer-ble-mock.png') });

  // read-back round trip: a new blank slide, Load slot 3 (both versions) into it
  const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  await page.click('#slideAdd');
  await page.waitForTimeout(100);
  await page.click('#slotRows tr:nth-child(3) td.acts button:nth-child(2)');
  await page.waitForFunction(() => /Loaded slot 3|failed/.test(document.querySelector('#ldText').textContent), null, { timeout: 30000 });
  check('load finished', /Loaded slot 3/.test(await page.textContent('#ldText')), await page.textContent('#ldText'));
  const reads = await page.evaluate(() => window.__mock.reads);
  check('240-byte read steps', reads === Math.ceil(want40.length / 240) + Math.ceil(want80.length / 240), reads);
  await page.waitForTimeout(600);
  let sv = await page.evaluate(() => JSON.parse(localStorage.getItem('minitel-slide-designer.v1')));
  check('loaded into the new slide', sv.slides.length === 2 && sv.slides[1].slot === 3);
  const l40 = M.gridFromJSON(sv.slides[1].v40), l80 = M.gridFromJSON(sv.slides[1].v80);
  check('loaded 40 col: same screen', sameJSON(M.gridToJSON(l40), M.gridToJSON(g40)));
  check('loaded 40 col: same bytes', sameJSON(Array.from(M.encodeSlide(l40)), want40));
  check('loaded 80 col: same screen', sameJSON(M.gridToJSON(l80), M.gridToJSON(g80)));
  check('loaded 80 col: same bytes', sameJSON(Array.from(M.encodeSlide(l80)), want80));
  // per-version load over an edited version: confirm, then undo brings the edit back
  await page.click('#verTabs button[data-v="40"]');
  const box = await page.locator('#screen').boundingBox();
  await page.mouse.click(box.x + 5, box.y + 5);
  await page.keyboard.type('EDIT');
  await page.click('.tabs [data-tab="minitel"]');
  await page.click('#slotRows tr:nth-child(3) td.v button:first-of-type');
  await page.waitForFunction(() => /Loaded slot 3/.test(document.querySelector('#ldText').textContent) && !document.querySelector('#slotRefresh').disabled);
  await page.waitForTimeout(600);
  sv = await page.evaluate(() => JSON.parse(localStorage.getItem('minitel-slide-designer.v1')));
  check('per-version load replaces the edit', sameJSON(sv.slides[1].v40, M.gridToJSON(g40)));
  await page.click('.tabs [data-tab="design"]');
  await page.click('#actUndo');
  await page.waitForTimeout(600);
  sv = await page.evaluate(() => JSON.parse(localStorage.getItem('minitel-slide-designer.v1')));
  check('undo restores the edit', sv.slides[1].v40.rows[0].t.startsWith('EDIT'), sv.slides[1].v40.rows[0].t.slice(0, 6));
  await page.click('.tabs [data-tab="minitel"]');
  // load all slots into a new project
  await page.click('#slotLoadAll');
  await page.waitForFunction(() => /new project|failed/.test(document.querySelector('#ldText').textContent), null, { timeout: 30000 });
  await page.waitForTimeout(600);
  sv = await page.evaluate(() => JSON.parse(localStorage.getItem('minitel-slide-designer.v1')));
  check('load all: new project', sv.slides.length === 1 && sv.slides[0].name === 'Slot 3' && sv.slides[0].slot === 3
    && sameJSON(sv.slides[0].v40, M.gridToJSON(g40)) && sameJSON(sv.slides[0].v80, M.gridToJSON(g80)), JSON.stringify(sv.slides.map(x => x.name)));
  await page.screenshot({ path: path.join(shots, 'designer-ble-load.png') });

  // show: ok, and an error text for a slot with no 40 col version
  await page.click('#slotRows tr:nth-child(3) td.acts button:first-child');
  await page.waitForTimeout(200);
  check('show ok', /Slot 3 is on the Minitel/.test(await page.textContent('#stMsg')));
  // delete the 40 col version, then show gives the firmware's error
  await page.click('#slotRows tr:nth-child(3) td.v button[title^="Delete"]');
  await page.waitForTimeout(300);
  const st2 = await page.evaluate(() => window.__mock.slides);
  check('del 40 only', !st2['3.40'] && !!st2['3.80']);
  await page.click('#slotRows tr:nth-child(3) td.acts button:first-child');
  await page.waitForTimeout(200);
  const msg = await page.textContent('#stMsg');
  check('show error displayed', /has no 40 col version/.test(msg), msg);

  // settings
  await page.fill('#svSplash', '30s');
  await page.fill('#svOff', '2h');
  await page.click('#svSet');
  await page.waitForTimeout(300);
  const st3 = await page.evaluate(() => window.__mock);
  check('saver set', st3.splash === 30 && st3.off === 7200, `${st3.splash} ${st3.off}`);
  await page.fill('#histKeep', '80');
  await page.click('#histSet');
  await page.waitForTimeout(200);
  check('hist keep set', (await page.evaluate(() => window.__mock.hist)) === 80);

  // console
  await page.fill('#conCmd', 'slide list');
  await page.press('#conCmd', 'Enter');
  await page.waitForTimeout(200);
  check('console log', /3 80/.test(await page.textContent('#log')));

  // ---- preview on the Minitel (terminal channel), every notification delivered twice ----
  const term = () => page.evaluate(() => window.__mock.term);
  const pvText = () => page.textContent('#pvText');
  const waitText = (re, t = 15000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#pvText').textContent), re.source, { timeout: t });
  await page.evaluate(() => { const m = window.__mock; m.dup = true; m.term.cols = 80; m.term.recv = { 40: [], 80: [] }; m.term.dGens = []; });
  await page.selectOption('#pvVer', 'both');
  const gen0 = (await term()).gen;
  await page.click('#pvGo');
  await waitText(/Showing 40 col/);
  let T = await term();
  check('preview: switched to 40 col with a new gen', T.cols === 40 && T.gen === ((gen0 + 1) & 255) && T.dGens.every(g => g === T.gen), `${gen0} -> ${T.gen} ${JSON.stringify([...new Set(T.dGens)])}`);
  check('preview: 40 col bytes = encoded', JSON.stringify(T.recv[40]) === JSON.stringify(want40), `${T.recv[40].length} vs ${want40.length}`);
  check('preview: chunks <= 150 bytes, full queue resent', T.maxD <= 150 && T.stalls > 0, `${T.maxD} / ${T.stalls} stalls`);
  check('preview: Next enabled while waiting', !(await page.isDisabled('#pvNext')));
  await page.evaluate(() => window.__mockPush([0xF0, 0x4B, 0x41]));   // a key (delivered twice: one must count)
  await waitText(/Showing 80 col/);
  await page.waitForTimeout(400);
  T = await term();
  check('preview: one key = one step (duplicate dropped)', /Showing 80 col/.test(await pvText()), await pvText());
  check('preview: 80 col bytes = encoded, after a second switch', JSON.stringify(T.recv[80]) === JSON.stringify(want80) && T.cols === 80 && T.gen === ((gen0 + 2) & 255));
  await page.evaluate(() => window.__mockPush([0xF0, 0x4B, 0x0D]));
  await waitText(/Preview over/);
  T = await term();
  check('preview: closed with X after the last key', T.xReq === 1 && !T.open, `${T.xReq}`);
  check('preview: Preview enabled again', !(await page.isDisabled('#pvGo')));

  // Next button, then Stop
  await page.evaluate(() => { window.__mock.term.recv = { 40: [], 80: [] }; });
  await page.click('#pvGo');
  await waitText(/Showing 40 col/);
  await page.click('#pvNext');
  await waitText(/Showing 80 col/);
  await page.click('#pvStop');
  await waitText(/Preview stopped/);
  T = await term();
  check('preview: Next then Stop sends X', T.xReq === 2 && !T.open && JSON.stringify(T.recv[80]) === JSON.stringify(want80), `${T.xReq}`);

  // CONNEXION/FIN on the Minitel: the session is over, no X
  await page.click('#pvGo');
  await waitText(/Showing 40 col/);
  await page.evaluate(() => window.__mockPush([0xF0, 0x58, 1]));
  await waitText(/Ended on the Minitel/);
  T = await term();
  check('preview: CONNEXION/FIN ends it without X', T.xReq === 2, `${T.xReq}`);

  // this version only, Minitel not ready
  await page.selectOption('#pvVer', 'cur');
  await page.evaluate(() => { window.__mock.term.notReady = true; });
  await page.click('#pvGo');
  await waitText(/not ready/);
  check('preview: not-ready status reported', /not ready/.test(await pvText()));
  await page.evaluate(() => { window.__mock.term.notReady = false; });

  // the CLI still right with doubled notifications
  const nFrames = (await page.evaluate(() => window.__mock.frames.length));
  await page.click('#slotRefresh');
  await page.waitForTimeout(300);
  const fr = await page.evaluate(() => window.__mock.frames);
  check('CLI with doubled notifications', fr.length === nFrames + 1 && /80 col|B/.test(await page.textContent('#slotRows tr:nth-child(3)')));
  // a multi-frame reply with every frame doubled: the read-back must still be exact
  await page.click('#slotRows tr:nth-child(3) td.v button[title^="Load the 80"]');
  await page.waitForFunction(() => /Loaded slot 3|failed/.test(document.querySelector('#ldText').textContent) && !document.querySelector('#slotRefresh').disabled);
  await page.waitForTimeout(600);
  const svd = await page.evaluate(() => JSON.parse(localStorage.getItem('minitel-slide-designer.v1')));
  check('read-back exact with doubled notifications', /Loaded slot 3/.test(await page.textContent('#ldText')) && JSON.stringify(svd.slides[0].v80) === JSON.stringify(M.gridToJSON(g80)), await page.textContent('#ldText'));
  await page.fill('#conCmd', 'slide list');
  await page.press('#conCmd', 'Enter');
  await page.waitForTimeout(300);
  const logTxt = await page.textContent('#log');
  const lastList = logTxt.slice(logTxt.lastIndexOf('> slide list'));
  check('CLI reply not doubled', (lastList.match(/ 3 80 /g) || []).length === 1, lastList);
  const stored = await page.evaluate(() => window.__mock.frames.filter(f => f.startsWith('slide begin')).length);
  check('preview stored nothing (2 slide begin, both from the upload)', stored === 2, stored);
  await page.screenshot({ path: path.join(shots, 'designer-preview.png') });

  check('no console errors', errors.length === 0, errors.join('\n'));
  await browser.close();
  console.log(fails ? `${fails} failure(s)` : 'BLE mock test passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
