// A Vidéotex service (MiniPavi...) on the Minitel through the 3615 MESHCORE node, from the
// browser: the same session as "mtl vtx" (tools/mtl/vtx.go), with a WebSocket for the service.
//   'O' [1, speed/100]   open the terminal as a Vidéotex session, paced to that line speed
//   'M' [40]             40 columns (push M <cols> . <gen> when done)
//   'D' <gen> <bytes>    the service's bytes -> D <status> <accepted> <free lo> <free hi>
//   push 'K' <utf-8>     the Minitel's keys (function keys as SEP 13 41..48, accents in UTF-8)
//   push 'X'             CONNEXION/FIN: the session ended on the Minitel
//   'X'                  close
// WebSockets are not bound by the same-origin policy: the service sees this page's Origin and
// may refuse it, MiniPavi does not. An https page (Web Bluetooth needs one) can only open wss://.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const CHUNK = 150;          // service bytes per BLE frame (as mtl)
  const KEEPALIVE = 5000;     // the node ends a terminal nobody talks to
  const SUB = (c) => c.charCodeAt(0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const link = new MeshCoreLink();
  let session = null;

  // ---- log --------------------------------------------------------------------------------
  function log(msg, cls) {
    const el = $('log');
    const line = document.createElement('div');
    const t = new Date();
    line.textContent = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}  ${msg}`;
    if (cls) line.className = cls;
    el.appendChild(line);
    while (el.childNodes.length > 300) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }
  function setState(id, text, cls) {
    const el = $(id);
    el.textContent = text;
    el.className = 'state' + (cls ? ' ' + cls : '');
  }

  // ---- bytes ------------------------------------------------------------------------------
  // the node's key push (UTF-8) -> what the Minitel itself sends (accents as SS2 sequences)
  function keysToVideotex(bytes) {
    const out = [];
    for (const ch of new TextDecoder().decode(bytes)) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) { out.push(cp); continue; }
      const c = Minitel.foldChar(cp, false);
      if (c != null) out.push(...Minitel.encodeCell(c, false));
    }
    return out;
  }
  // a service message -> bytes (text frames carry the bytes as characters)
  function messageBytes(data) {
    if (typeof data !== 'string') return new Uint8Array(data);
    const out = new Uint8Array(data.length);
    let n = 0;
    for (let i = 0; i < data.length; i++) {
      const c = data.charCodeAt(i);
      if (c < 0x100) out[n++] = c;
    }
    return out.subarray(0, n);
  }
  function concat(a, b) {
    if (!a.length) return b;
    const o = new Uint8Array(a.length + b.length);
    o.set(a); o.set(b, a.length);
    return o;
  }

  // 'O', tried again while the node is still busy with a session just closed
  async function openTerm(speed) {
    let err;
    for (let i = 0; i < 3; i++) {
      try { return await link.request('O', [1, speed], 3000); } catch (e) { err = e; }
      await sleep(1000);
    }
    throw err;
  }

  // ---- a session ----------------------------------------------------------------------------
  class Session {
    constructor(url, speed) {
      this.url = url;
      this.speed = speed;
      this.pending = new Uint8Array(0);
      this.gen = 0;
      this.ready = false;
      this.stopped = false;
      this.wsOpen = false;
      this.wsClosed = false;
      this.relinking = null;
      this.lastReq = 0;
      this.abort = new AbortController();
      this.wakeFn = null;
      this.rx = 0;
      this.shown = 0;
    }

    wake() { if (this.wakeFn) { const f = this.wakeFn; this.wakeFn = null; f(); } }
    nap(ms) {
      return new Promise((r) => {
        const t = setTimeout(() => { this.wakeFn = null; r(); }, ms);
        this.wakeFn = () => { clearTimeout(t); r(); };
      });
    }

    async start() {
      link.clearPushes();
      const r = await openTerm(this.speed);
      if (r.length < 4 || r[0] !== 0) throw new Error("le Minitel n'est pas prêt (éteint ? pas trouvé par le nœud ?)");
      this.gen = r[3];
      this.opened = true;
      if (r[1] !== 40) await this.setCols();
      this.ready = true;
      this.lastReq = Date.now();
      await this.openWs();
      this.pushLoop();
      this.sendLoop();
    }

    async setCols() {
      await link.request('M', [40], 3000);
      this.gen = await link.waitPush((p) => (p.length >= 5 && p[1] === SUB('M') && p[2] === 40 ? p[4] : undefined), 8000);
    }

    openWs() {
      return new Promise((resolve, reject) => {
        let ws;
        try {
          ws = new WebSocket(this.url);
        } catch (e) {
          reject(new Error(location.protocol === 'https:' && this.url.startsWith('ws:')
            ? 'une page https ne peut pas ouvrir de ws:// (le navigateur le bloque) : seulement wss://'
            : `adresse refusée (${e.message})`));
          return;
        }
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        ws.onopen = () => { this.wsOpen = true; resolve(); };
        ws.onmessage = (ev) => {
          const b = messageBytes(ev.data);
          this.rx += b.length;
          this.pending = concat(this.pending, b);
          this.wake();
        };
        ws.onclose = (ev) => {
          const was = this.wsOpen;
          this.wsOpen = false;
          this.wsClosed = true;
          if (!was) reject(new Error(`le service ne répond pas ou refuse la connexion (code ${ev.code})`));
          this.wake();
        };
        ws.onerror = () => {};
      });
    }

    // the Minitel's pushes: keys to the service, mode changes, the end
    async pushLoop() {
      while (!this.stopped) {
        let p;
        try {
          p = await link.waitPush((f) => f, 0, this.abort.signal);
        } catch (e) {
          if (this.stopped) return;
          await this.relink();
          continue;
        }
        if (p.length < 2) continue;
        switch (p[1]) {
          case SUB('K'): {
            const k = keysToVideotex(p.subarray(2));
            if (this.wsOpen && k.length) this.ws.send(String.fromCharCode(...k));
            break;
          }
          case SUB('M'):
            if (p.length >= 5) {
              this.gen = p[4];
              this.pending = new Uint8Array(0);
              if (p[2] !== 40) {
                this.ready = false;
                link.request('M', [40], 3000).catch(() => {});
              } else this.ready = true;
              this.wake();
            }
            break;
          case SUB('X'):
            this.stop('Fin de session sur le Minitel (CONNEXION/FIN).', false);
            return;
        }
      }
    }

    // the service's bytes to the Minitel, as fast as the node takes them
    async sendLoop() {
      while (!this.stopped) {
        if (this.relinking) { await this.relinking; continue; }
        if (!this.ready || !this.pending.length) {
          if (this.wsClosed && !this.pending.length) {
            log('Le service a raccroché.');
            await sleep(2000);   // its last page, a moment
            this.stop('', true);
            return;
          }
          if (this.ready && Date.now() - this.lastReq > KEEPALIVE) {
            this.lastReq = Date.now();
            try { await link.request('D', [this.gen], 3000); } catch (e) { if (!this.stopped) await this.relink(); }
            continue;
          }
          await this.nap(250);
          continue;
        }
        const n = Math.min(CHUNK, this.pending.length);
        const chunk = this.pending.subarray(0, n);
        const frame = new Uint8Array(n + 1);
        frame[0] = this.gen;
        frame.set(chunk, 1);
        this.lastReq = Date.now();
        let r;
        try {
          r = await link.request('D', frame, 3000);
        } catch (e) {
          if (!this.stopped) await this.relink();
          continue;
        }
        if (r.length < 4 || r[0] !== 0) {   // switching modes: push M follows
          this.pending = new Uint8Array(0);
          continue;
        }
        const acc = Math.min(r[1], n);
        this.pending = this.pending.subarray(acc);
        this.shown += acc;
        showStats();
        if (acc === 0) await sleep(40);   // the Minitel's queue is full (it runs at 1200 baud)
      }
    }

    // the BLE link lost: the same device again, then open again (the node keeps the screen)
    relink() {
      if (this.relinking) return this.relinking;
      this.relinking = (async () => {
        log('Liaison Bluetooth perdue, reconnexion… (le service reste en ligne)', 'err');
        for (let attempt = 1; !this.stopped; attempt++) {
          try {
            await link.reconnect();
            const r = await openTerm(this.speed);
            if (r.length >= 4 && r[0] === 0) {
              this.gen = r[3];
              this.ready = true;
              this.lastReq = Date.now();
              if (r[1] !== 40) {
                this.ready = false;
                link.request('M', [40], 3000).catch(() => {});
              }
              log('Reconnecté.', 'ok');
              return;
            }
          } catch (e) {
            if (attempt === 1 || attempt % 10 === 0) log(`Toujours en train d'essayer (${e.message})`);
          }
          await sleep(2000);
        }
      })().finally(() => { this.relinking = null; });
      return this.relinking;
    }

    stop(reason, closeTerm) {
      if (this.stopped) return;
      this.stopped = true;
      this.abort.abort(new Error('stopped'));
      this.wake();
      if (this.ws && (this.wsOpen || this.ws.readyState === WebSocket.CONNECTING)) this.ws.close();
      if (closeTerm && this.opened && link.connected) link.request('X', [], 2000).catch(() => {});
      if (reason) log(reason);
      if (session === this) session = null;
      refresh();
    }
  }

  // ---- UI ---------------------------------------------------------------------------------
  function showStats() {
    const s = session;
    $('stats').textContent = s ? `${s.rx} octets reçus du service, ${s.shown} affichés${s.pending.length ? `, ${s.pending.length} en attente` : ''}` : '';
  }
  function refresh() {
    const on = link.connected;
    $('btnBle').disabled = on || !MeshCoreLink.supported();
    $('btnBleOff').disabled = !link.device || (!on && !session);
    $('btnCall').disabled = !on || !!session;
    $('btnHang').disabled = !session;
    $('url').disabled = $('preset').disabled = $('speed').disabled = !!session;
    if (session) setState('svcState', session.wsOpen ? 'en ligne' : 'appel…', session.wsOpen ? 'on' : '');
    else setState('svcState', 'raccroché');
    showStats();
  }

  link.onstate = (st) => {
    if (st === 'connected') { setState('bleState', 'connecté', 'on'); $('bleName').textContent = link.name; }
    else if (st === 'connecting') setState('bleState', 'connexion…');
    else setState('bleState', session ? 'perdu' : 'non connecté', session ? 'err' : '');
    refresh();
  };

  $('btnBle').onclick = async () => {
    try {
      await link.connect();
      log(`Connecté à ${link.name}.`, 'ok');
    } catch (e) {
      if (e.name !== 'NotFoundError') log(`Bluetooth : ${e.message}`, 'err');
    }
    refresh();
  };
  $('btnBleOff').onclick = () => {
    if (session) session.stop('Raccroché.', true);
    setTimeout(() => { link.disconnect(); refresh(); }, 300);
  };

  $('preset').onchange = () => {
    if ($('preset').value) $('url').value = $('preset').value;
    else { $('url').focus(); $('url').select(); }
  };
  $('url').oninput = () => {
    const v = $('url').value.trim();
    $('preset').value = [...$('preset').options].some((o) => o.value === v) ? v : '';
  };

  $('btnCall').onclick = async () => {
    const url = $('url').value.trim();
    if (!/^wss?:\/\//.test(url)) { log('Adresse : wss://hôte:port/…', 'err'); return; }
    const speed = +$('speed').value;
    try { localStorage.setItem('mtl.vtx', JSON.stringify({ url, speed })); } catch (e) { /* private mode */ }
    const s = new Session(url, speed);
    session = s;
    refresh();
    log(`Appel de ${url}…`);
    try {
      await s.start();
      log('En ligne : tapez sur le Minitel. CONNEXION/FIN raccroche.', 'ok');
    } catch (e) {
      log(`Échec : ${e.message}`, 'err');
      s.stop('', true);
    }
    refresh();
  };
  $('btnHang').onclick = () => { if (session) session.stop('Raccroché.', true); };

  window.addEventListener('beforeunload', () => { if (session) session.stop('', true); });

  // ---- start --------------------------------------------------------------------------------
  try {
    const saved = JSON.parse(localStorage.getItem('mtl.vtx') || 'null');
    if (saved && saved.url) { $('url').value = saved.url; $('url').oninput(); }
    if (saved && saved.speed) $('speed').value = String(saved.speed);
  } catch (e) { /* nothing saved */ }
  const q = new URLSearchParams(location.search).get('url');
  if (q) { $('url').value = q; $('url').oninput(); }
  if (!MeshCoreLink.supported()) $('noBle').hidden = false;
  refresh();
})();
