// minipavi.html (a Vidéotex service on the Minitel from the browser) against a mock node that
// answers as UITaskTerm.cpp does ('O' 'M' 'D' 'X', pushes K / M / X), with a slow Minitel
// queue and a BLE drop in the middle; first with a mock service (every byte value, in order,
// once), then with the real MiniPavi (wss://go.minipavi.fr:8181, skipped with OFFLINE=1).
// The page is served from http://mtl.test: the service sees a foreign Origin, as on the site.
//   NODE_PATH=<dir with playwright> node test/vtx-mock-test.js
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const DIR = path.join(__dirname, '..');
const ORIGIN = 'http://mtl.test';

function mockNode() {
  const NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const st = { opened: 0, closed: 0, flags: [], data: [], gen: 7, cols: 80, accPerReq: 40, dCount: 0,
    dropAtD: 0, drops: 0, reconnects: 0, wrongGen: 0, mReq: 0 };
  window.__node = st;
  let notify = null, gone = null, pseq = 0, connected = false;
  const deliver = (bytes) => { if (connected && notify) notify({ target: { value: new DataView(Uint8Array.from(bytes).buffer) } }); };
  const push = (sub, payload) => { pseq = (pseq + 1) & 0xFF; deliver([0xF0, sub, pseq, ...payload]); };
  st.key = (s) => push(0x4B, [...new TextEncoder().encode(s)]);
  st.fin = () => push(0x58, []);
  const handle = (f) => {
    const sub = f[1], seq = f[2], p = [...f.slice(3)];
    const reply = (...fields) => setTimeout(() => deliver([0x70, sub, seq, ...fields]), 3);
    switch (String.fromCharCode(sub)) {
      case 'O': st.opened++; st.flags = p; reply(0, st.cols, 25, st.gen); break;
      case 'M':
        st.mReq++;
        reply(0);
        setTimeout(() => { st.cols = p[0]; st.gen = (st.gen + 1) & 0xFF; push(0x4D, [st.cols, 25, st.gen]); }, 60);
        break;
      case 'D': {
        st.dCount++;
        if (st.dropAtD && st.dCount === st.dropAtD) {   // the link goes, this frame with it
          st.drops++;
          connected = false; dev.gatt.connected = false;
          setTimeout(() => gone && gone(), 5);
          return;
        }
        if (p[0] !== st.gen) { st.wrongGen++; reply(1, 0, 0, 0); break; }
        const acc = Math.min(p.length - 1, st.accPerReq);
        st.data.push(...p.slice(1, 1 + acc));
        reply(0, acc, 0, 2);
        break;
      }
      case 'X': st.closed++; reply(0); break;
      default: deliver([0x01]);
    }
  };
  const chr = (uuid) => ({
    uuid,
    addEventListener: (t, fn) => { if (t === 'characteristicvaluechanged') notify = fn; },
    startNotifications: async () => {},
    writeValueWithoutResponse: async (v) => { if (!connected) throw new Error('GATT gone'); handle(Uint8Array.from(v)); },
  });
  const rx = chr('6e400002-b5a3-f393-e0a9-e50e24dcca9e'), tx = chr('6e400003-b5a3-f393-e0a9-e50e24dcca9e');
  const server = { getPrimaryService: async (u) => { if (u !== NUS) throw new Error('no service'); return { getCharacteristic: async (c) => (c === rx.uuid ? rx : tx) }; } };
  const dev = {
    name: 'MeshCore-mock', id: 'mock',
    addEventListener: (t, fn) => { if (t === 'gattserverdisconnected') gone = fn; },
    gatt: {
      connected: false,
      connect: async () => { if (st.drops) st.reconnects++; await new Promise((r) => setTimeout(r, 30)); connected = true; dev.gatt.connected = true; return server; },
      disconnect: () => { connected = false; dev.gatt.connected = false; if (gone) gone(); },
    },
  };
  Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async () => dev } });
}

// a service: every byte value 0..255 (as characters of text frames, the way MiniPavi sends)
function mockService() {
  const N = 3000;
  const svc = { sent: [], N, closeAfter: false };
  window.__svc = svc;
  window.WebSocket = class {
    constructor(url) {
      this.url = url; this.readyState = 0; svc.ws = this;
      setTimeout(() => {
        this.readyState = 1; this.onopen && this.onopen({});
        let i = 0;
        const step = () => {
          const n = Math.min(N - i, 97 + (i % 300));
          let s = '';
          for (let k = 0; k < n; k++) s += String.fromCharCode((i + k) & 0xFF);
          i += n;
          this.onmessage && this.onmessage({ data: s });
          if (i < N) setTimeout(step, 15);
          else if (svc.closeAfter) setTimeout(() => this._close(1000), 50);
        };
        step();
      }, 20);
    }
    send(s) { svc.sent.push(s); }
    close() { this._close(1000); }
    _close(code) { if (this.readyState === 3) return; this.readyState = 3; this.onclose && this.onclose({ code }); }
  };
  window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1; window.WebSocket.CLOSED = 3;
}

async function newPage(browser, withService) {
  const ctx = await browser.newContext();
  await ctx.route(ORIGIN + '/**', (route) => {
    const f = path.join(DIR, new URL(route.request().url()).pathname);
    if (!f.startsWith(DIR) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.addInitScript(mockNode);
  if (withService) await page.addInitScript(mockService);
  await page.goto(ORIGIN + '/minipavi.html');
  return { page, errors };
}

let fails = 0;
const check = (name, ok, extra) => { if (!ok) { fails++; console.log('FAIL', name, extra === undefined ? '' : extra); } else console.log('ok  ', name); };
const logText = (page) => page.$eval('#log', (e) => e.textContent);

(async () => {
  const browser = await chromium.launch();

  // ---- mock service: order, pacing, BLE drop, keys, the ends ----
  {
    const { page, errors } = await newPage(browser, true);
    await page.click('#btnBle');
    await page.waitForFunction(() => !document.getElementById('btnCall').disabled);
    await page.evaluate(() => { window.__node.dropAtD = 12; });
    await page.click('#btnCall');
    await page.waitForFunction(() => window.__node.data.length >= window.__svc.N, null, { timeout: 30000 });
    const st = await page.evaluate(() => ({ ...window.__node, key: 0, fin: 0 }));
    check('opened as a Vidéotex session at 1200 baud', st.flags[0] === 1 && st.flags[1] === 12, st.flags);
    check('switched to 40 columns', st.cols === 40 && st.mReq === 1, `${st.cols} ${st.mReq}`);
    check('BLE dropped and reconnected', st.drops === 1 && st.reconnects >= 1 && st.opened >= 2, `${st.drops} ${st.reconnects} ${st.opened}`);
    check('never the wrong generation', st.wrongGen === 0, st.wrongGen);
    let inOrder = st.data.length === 3000;
    for (let i = 0; inOrder && i < 3000; i++) if (st.data[i] !== (i & 0xFF)) inOrder = false;
    check('every service byte, in order, once', inOrder, st.data.length);

    await page.evaluate(() => { window.__node.key('MUSEE'); window.__node.key('\x13A'); window.__node.key('é'); });
    await page.waitForTimeout(200);
    const sent = await page.evaluate(() => window.__svc.sent.join(''));
    check('keys to the service, accents as SS2', sent === 'MUSEE\x13A\x19\x42e', JSON.stringify(sent));

    await page.evaluate(() => window.__node.fin());
    await page.waitForFunction(() => document.getElementById('svcState').textContent === 'raccroché');
    const end = await page.evaluate(() => ({ closed: window.__node.closed, ws: window.__svc.ws.readyState }));
    check('CONNEXION/FIN: service closed, no X sent back', end.ws === 3 && end.closed === 0, end);

    // the service hangs up: its last page shown, then X
    await page.evaluate(() => { window.__svc.closeAfter = true; window.__node.data.length = 0; window.__node.dropAtD = 0; });
    await page.click('#btnCall');
    await page.waitForFunction(() => window.__node.closed === 1, null, { timeout: 30000 });
    const n = await page.evaluate(() => window.__node.data.length);
    check('service hung up: whole page shown, then X', n === 3000, n);
    check('no page errors', errors.length === 0, errors);
    await page.screenshot({ path: path.join(__dirname, '.build', 'vtx-mock.png'), fullPage: true }).catch(() => {});
    console.log((await logText(page)).replace(/(\d\d:\d\d:\d\d)/g, '\n  $1'));
  }

  // ---- the real MiniPavi ----
  if (!process.env.OFFLINE) {
    const { page, errors } = await newPage(browser, false);
    await page.evaluate(() => { window.__node.cols = 40; window.__node.accPerReq = 150; });
    await page.click('#btnBle');
    await page.waitForFunction(() => !document.getElementById('btnCall').disabled);
    await page.click('#btnCall');
    try {
      await page.waitForFunction(() => window.__node.data.length > 300, null, { timeout: 15000 });
    } catch (e) { /* checked below */ }
    const home = await page.evaluate(() => String.fromCharCode(...window.__node.data));
    check('MiniPavi answered a page from a foreign origin', /MiniPAVI/.test(home), home.slice(0, 80));
    await page.evaluate(() => { window.__node.data.length = 0; window.__node.key('MUSEE'); window.__node.key('\x13A'); });
    try {
      await page.waitForFunction(() => String.fromCharCode(...window.__node.data).includes('Cnx en cours'), null, { timeout: 15000 });
    } catch (e) { /* checked below */ }
    const after = await page.evaluate(() => String.fromCharCode(...window.__node.data));
    check('MUSEE + ENVOI from the Minitel reached MiniPavi', after.includes('Cnx en cours'), JSON.stringify(after.slice(0, 80)));
    await page.click('#btnHang');
    await page.waitForTimeout(300);
    check('hang up sends X', (await page.evaluate(() => window.__node.closed)) === 1);
    check('no page errors (MiniPavi)', errors.length === 0, errors);
  }

  await browser.close();
  console.log(fails ? `${fails} FAILED` : 'all ok');
  process.exit(fails ? 1 : 0);
})();
