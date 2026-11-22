// Web Bluetooth link to the 3615 MESHCORE companion (MeshCore BLE companion, Nordic UART).
// Custom CLI command: write C0 'C' <ASCII>; the reply is one or more notifications
// 70 'C' <more 0|1> <text>, concatenated until more == 0. 01 ... = unknown command
// (firmware without the Minitel extensions). Binary requests (terminal channel, used by
// the preview): C0 <sub> <bytes> -> one reply 70 <sub> <bytes>; pushes F0 <sub> <bytes>.
// One request at a time; a reply is matched by its sub byte.
(function (root) {
  'use strict';
  const NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';   // we write
  const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';   // it notifies
  const MAX_FRAME = 172;

  class MeshCoreLink {
    constructor() {
      this.device = null;
      this.rx = null;
      this.tx = null;
      this.pending = null;     // {resolve, reject, sub, text, timer}
      this.pushes = [];        // F0 frames nobody waited for yet
      this.waiters = [];
      this._prev = null;
      this._prevAt = 0;
      this.chain = Promise.resolve();
      this.onstate = () => {};
      this.onlog = () => {};
      this._onNotify = this._onNotify.bind(this);
      this._onGone = this._onGone.bind(this);
    }
    static supported() { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); }
    get connected() { return !!(this.device && this.device.gatt && this.device.gatt.connected && this.rx); }
    get name() { return this.device ? this.device.name || this.device.id : ''; }

    async connect() {
      const dev = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'MeshCore' }], optionalServices: [NUS] });
      this.device = dev;
      dev.addEventListener('gattserverdisconnected', this._onGone);
      this.onstate('connecting');
      try {
        const server = await dev.gatt.connect();
        const svc = await server.getPrimaryService(NUS);
        this.rx = await svc.getCharacteristic(NUS_RX);
        this.tx = await svc.getCharacteristic(NUS_TX);
        this.tx.addEventListener('characteristicvaluechanged', this._onNotify);
        try {
          await this.tx.startNotifications();
        } catch (e) {
          throw new Error(`notifications refused (${e.message}). Not paired? Pair first, with the PIN shown on the Minitel.`);
        }
      } catch (e) {
        this.disconnect();
        throw e;
      }
      this.onstate('connected');
    }

    disconnect() {
      const d = this.device;
      this.rx = this.tx = null;
      if (d && d.gatt && d.gatt.connected) d.gatt.disconnect();
      this._fail(new Error('disconnected'));
      this._dropWaiters();
      this.onstate('disconnected');
    }

    _onGone() {
      this.rx = this.tx = null;
      this._dropWaiters();
      this._fail(new Error('the device disconnected'));
      this.onstate('disconnected');
    }

    _dropWaiters() {
      for (const w of this.waiters.splice(0)) w.fail(new Error('the device disconnected'));
      this.pushes.length = 0;
    }

    _fail(err) {
      const p = this.pending;
      if (!p) return;
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(err);
    }

    _arm(p) {
      clearTimeout(p.timer);
      p.timer = setTimeout(() => this._fail(new Error('no reply (timeout)')), p.timeout);
    }

    _onNotify(ev) {
      const v = ev.target.value;
      const f = new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
      if (f.length < 1) return;
      // BlueZ over D-Bus can deliver the same notification twice, back to back (mtl saw
      // it): a frame identical to the previous one within 5 ms is that copy. The node never
      // sends two identical frames so close (one reply per request, keys tens of ms apart).
      const now = performance.now();
      const prev = this._prev;
      this._prev = f;
      const prevAt = this._prevAt;
      this._prevAt = now;
      if (prev && now - prevAt < 5 && prev.length === f.length && prev.every((b, i) => b === f[i])) return;
      if (f[0] === 0xF0) { this._push(f); return; }
      const p = this.pending;
      if (!p) return;
      if (f[0] === 0x01) {
        this._fail(new Error('the node does not know this command (firmware too old, without the Minitel extensions?)'));
        return;
      }
      if (f[0] !== 0x70 || f.length < 2 || f[1] !== p.sub) return;   // not this request's reply
      if (p.sub !== 0x43) {   // binary sub: one frame, the bytes after the sub
        this.pending = null;
        clearTimeout(p.timer);
        p.resolve(f.subarray(2));
        return;
      }
      if (f.length < 3) return;
      p.text += new TextDecoder().decode(f.subarray(3));
      if (f[2] === 0) {
        this.pending = null;
        clearTimeout(p.timer);
        p.resolve(p.text);
      } else this._arm(p);
    }

    // pushes (F0 <sub> ...): queued until a waiter takes them
    _push(f) {
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i];
        const r = w.fn(f);
        if (r !== undefined) { this.waiters.splice(i, 1); w.done(r); return; }
      }
      if (this.waiters.length) return;   // someone waits for another push: this one is dropped
      this.pushes.push(f);
      if (this.pushes.length > 64) this.pushes.shift();
    }
    clearPushes() { this.pushes.length = 0; }
    // the first push for which fn returns a value (undefined: not this one, dropped);
    // rejects on timeout (ms, 0 = none) or when signal aborts
    waitPush(fn, timeout, signal) {
      return new Promise((resolve, reject) => {
        while (this.pushes.length) {
          const r = fn(this.pushes.shift());
          if (r !== undefined) { resolve(r); return; }
        }
        let timer = 0;
        const w = {
          fn,
          done: (r) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); resolve(r); },
          fail: (err) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); reject(err); },
        };
        const drop = (err) => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(err);
        };
        const onAbort = () => drop(signal.reason || new Error('aborted'));
        if (signal) {
          if (signal.aborted) { reject(signal.reason || new Error('aborted')); return; }
          signal.addEventListener('abort', onAbort);
        }
        if (timeout) timer = setTimeout(() => drop(new Error('timeout')), timeout);
        this.waiters.push(w);
      });
    }

    _write(sub, body, timeout) {
      if (!this.connected) return Promise.reject(new Error('not connected'));
      if (body.length + 2 > MAX_FRAME) return Promise.reject(new Error('frame too long'));
      const frame = new Uint8Array(body.length + 2);
      frame[0] = 0xC0; frame[1] = sub;
      frame.set(body, 2);
      return new Promise((resolve, reject) => {
        const p = { resolve, reject, sub, text: '', timer: 0, timeout };
        this.pending = p;
        this._arm(p);
        const w = this.rx.writeValueWithoutResponse ? this.rx.writeValueWithoutResponse(frame) : this.rx.writeValue(frame);
        w.catch((e) => { if (this.pending === p) this._fail(e); });
      });
    }
    _queue(run) {
      const r = this.chain.then(run, run);
      this.chain = r.catch(() => {});
      return r;
    }

    // one binary request C0 <sub> <payload> -> the reply's bytes after 70 <sub>
    request(sub, payload, timeout = 3000) {
      const s = typeof sub === 'string' ? sub.charCodeAt(0) : sub;
      return this._queue(() => this._write(s, Uint8Array.from(payload || []), timeout));
    }

    // one CLI command -> {ok, text, lines, err}
    cli(cmd, timeout = 5000) {
      return this._queue(async () => {
        const text = await this._write(0x43, new TextEncoder().encode(cmd), timeout);
        const lines = text.split(/\r?\n/).map(s => s.replace(/\s+$/, '')).filter(s => s.trim() !== '');
        const lastLine = lines.length ? lines[lines.length - 1].trim() : '';
        const ok = lastLine === 'OK';
        const errLine = lines.find(l => l.trim().startsWith('ERR'));
        const res = { ok, text, lines, err: ok ? '' : (errLine ? errLine.trim() : (lastLine || 'no OK in the reply')) };
        this.onlog(cmd, res);
        return res;
      });
    }
  }

  root.MeshCoreLink = MeshCoreLink;
})(typeof self !== 'undefined' ? self : this);
