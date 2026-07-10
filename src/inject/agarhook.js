// =====================================================================
// agarhook.js  -  IZVRSAVA SE U STRANICI (browser context), pre svega
//
// Zakaci WebSocket igre, dekodira agar protokol (klasicni Ogar/vanilla
// format koji vecina .rs/privatnih klonova koristi) i izlozi:
//
//   window.__AGARAI = {
//     ready,                     // hook postavljen
//     getState(): {...},         // zivo stanje sveta iz ugla ovog taba
//     command(cmd),              // primeni komandu iz koordinatora
//     split(), feed(), respawn(),
//     _captures                  // sirovi frejmovi ako je capture ukljucen
//   }
//
// Ovo je "klijent simulator": citamo svet iz dolaznih paketa, a komande
// (kretanje/split/feed) saljemo kao sinteticke input evente ili kao pakete.
// =====================================================================

(function () {
  if (window.__AGARAI && window.__AGARAI.ready) return;

  // -------- podesavanja koja stranica dobija od Node-a (opciono) --------
  const OPT = (window.__AGARAI_OPT || {});
  const CAPTURE = !!OPT.capture;
  const MOVE_RADIUS = OPT.moveRadius || 320;
  const CONTROL = OPT.control || 'input';

  // ----------------------------- stanje ----------------------------------
  const cells = new Map();       // id -> {id,x,y,size,r,g,b,flags,name,isVirus,isFood,isEjected,isMine,t}
  const ownedIds = new Set();    // moje celije (iz opcode 32)
  let mapBounds = { minx: 0, miny: 0, maxx: 14142, maxy: 14142 };
  let socket = null;             // aktivni WS ka serveru igre
  let lastMsgAt = 0;
  const captures = [];

  window.__AGARAI = window.__AGARAI || {};
  window.__AGARAI._captures = captures;

  // ------------------------- pomocni citaci -----------------------------
  function readUTF16(view, o) {
    let s = '';
    while (o + 1 < view.byteLength) {
      const c = view.getUint16(o, true); o += 2;
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return { s, o };
  }
  function readUTF8(view, o) {
    let s = '';
    while (o < view.byteLength) {
      const c = view.getUint8(o); o += 1;
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return { s, o };
  }

  // Klasifikacija celije po velicini/flagu.
  function classify(cell) {
    cell.isVirus = !!(cell.flags & 0x01);
    cell.isEjected = !!(cell.flags & 0x10);
    // hrana = sitni pellet-i bez imena, nisu virus ni moji
    cell.isFood = !cell.isVirus && !cell.isMine && cell.size > 0 && cell.size < 22 && !cell.name;
  }

  // --------------------- DEKODER: opcode 16 (update sveta) --------------
  // Format (MultiOgar / vanilla novije verzije, little-endian):
  //   u8  opcode = 16
  //   u16 eatCount
  //   eatCount x { u32 eaterId, u32 eatenId }        -> eatenId se uklanja
  //   loop:
  //     u32 id;  if id==0 -> kraj celija
  //     i32 x
  //     i32 y
  //     u16 size (radijus)
  //     u8  flags   (0x01 virus, 0x02 ext, 0x04 skin, 0x08 name, 0x10 ejected)
  //     [ako flags & 0x02: u8 extFlags + preskoci prema njemu]  (retko, tolerantno)
  //     u8 r, u8 g, u8 b
  //     [ako flags & 0x04: utf8 skin \0]
  //     [ako flags & 0x08: utf16 name \0]
  //   u16 removeCount
  //   removeCount x { u32 id }                        -> uklanja se
  function decodeUpdate(view) {
    let o = 1;
    const now = performance.now();
    try {
      const eatCount = view.getUint16(o, true); o += 2;
      for (let i = 0; i < eatCount; i++) {
        o += 4;                              // eaterId
        const eaten = view.getUint32(o, true); o += 4;
        cells.delete(eaten);
        ownedIds.delete(eaten);
      }
      // celije
      while (true) {
        const id = view.getUint32(o, true); o += 4;
        if (id === 0) break;
        const x = view.getInt32(o, true); o += 4;
        const y = view.getInt32(o, true); o += 4;
        const size = view.getUint16(o, true); o += 2;
        const flags = view.getUint8(o); o += 1;
        if (flags & 0x02) {                  // prosireni flag (tolerantno preskoci 4B)
          o += 4;
        }
        const r = view.getUint8(o); o += 1;
        const g = view.getUint8(o); o += 1;
        const b = view.getUint8(o); o += 1;
        let name = '';
        if (flags & 0x04) { const rr = readUTF8(view, o); o = rr.o; }        // skin (preskacemo sadrzaj)
        if (flags & 0x08) { const rr = readUTF16(view, o); o = rr.o; name = rr.s; }

        let cell = cells.get(id);
        if (!cell) { cell = { id }; cells.set(id, cell); }
        cell.x = x; cell.y = y; cell.size = size;
        cell.r = r; cell.g = g; cell.b = b; cell.flags = flags;
        if (name) cell.name = name;
        cell.isMine = ownedIds.has(id);
        cell.t = now;
        classify(cell);
      }
      const removeCount = view.getUint16(o, true); o += 2;
      for (let i = 0; i < removeCount; i++) {
        const id = view.getUint32(o, true); o += 4;
        cells.delete(id); ownedIds.delete(id);
      }
    } catch (e) {
      // Ako layout ne odgovara ovom klonu, ovde puca. Zato postoji --capture:
      // snimi frejmove pa prilagodi offsete u ovoj funkciji.
      if (OPT.debug) console.warn('[agarai] decodeUpdate greska:', e.message);
    }
  }

  // opcode 32: server mi dodeljuje novu (moju) celiju
  function decodeAddOwned(view) {
    const id = view.getUint32(1, true);
    ownedIds.add(id);
    const c = cells.get(id);
    if (c) c.isMine = true;
  }

  // opcode 64: velicina mape
  function decodeMapSize(view) {
    try {
      mapBounds = {
        minx: view.getFloat64(1, true),
        miny: view.getFloat64(9, true),
        maxx: view.getFloat64(17, true),
        maxy: view.getFloat64(25, true),
      };
    } catch (_) { /* neki serveri salju drugacije; ostaje default */ }
  }

  function onMessage(data) {
    lastMsgAt = performance.now();
    let buf = data;
    if (buf instanceof Blob) return;                 // ignorisemo blob varijantu
    if (!(buf instanceof ArrayBuffer)) {
      if (buf && buf.buffer) buf = buf.buffer; else return;
    }
    if (CAPTURE) {
      const arr = new Uint8Array(buf);
      captures.push({ t: Date.now(), dir: 'in', hex: bytesToHex(arr.slice(0, 64)), len: arr.length });
      if (captures.length > 500) captures.shift();
    }
    const view = new DataView(buf);
    if (view.byteLength < 1) return;
    const op = view.getUint8(0);
    switch (op) {
      case 16: decodeUpdate(view); break;
      case 32: decodeAddOwned(view); break;
      case 64: decodeMapSize(view); break;
      default: /* leaderboard/spectate/itd. nam nisu presudni */ break;
    }
  }

  function bytesToHex(a) {
    let s = '';
    for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0');
    return s;
  }

  // --------------------------- WS HOOK ----------------------------------
  const NativeWS = window.WebSocket;
  function HookedWS(url, protocols) {
    const ws = protocols ? new NativeWS(url, protocols) : new NativeWS(url);
    try { ws.binaryType = 'arraybuffer'; } catch (_) {}
    // Prihvatamo kao "socket igre" onaj koji salje binarne frejmove.
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') {
        if (!socket) socket = ws;             // prvi binarni socket = igra
        onMessage(ev.data);
      }
    });
    ws.addEventListener('open', () => { if (OPT.debug) console.log('[agarai] WS open', url); });
    return ws;
  }
  HookedWS.prototype = NativeWS.prototype;
  HookedWS.CONNECTING = NativeWS.CONNECTING;
  HookedWS.OPEN = NativeWS.OPEN;
  HookedWS.CLOSING = NativeWS.CLOSING;
  HookedWS.CLOSED = NativeWS.CLOSED;
  window.WebSocket = HookedWS;

  // ======================= KONTROLA (slanje) ============================
  // Poravnata s tim kako agar klijenti citaju ulaz: kretanje = pravac misa
  // od centra ekrana; feed = 'W'; split = 'Space'; respawn = klik/enter.

  const canvas = () => document.querySelector('canvas') || document.body;

  function dispatchMouse(cx, cy) {
    const el = canvas();
    for (const type of ['mousemove']) {
      const ev = new MouseEvent(type, {
        clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window,
      });
      el.dispatchEvent(ev);
      window.dispatchEvent(ev);
      document.dispatchEvent(ev);
    }
  }

  function pressKey(key, code, keyCode) {
    for (const type of ['keydown', 'keyup']) {
      const ev = new KeyboardEvent(type, { key, code, keyCode, which: keyCode, bubbles: true });
      window.dispatchEvent(ev);
      document.dispatchEvent(ev);
    }
  }

  // ---- slanje preko protokola (opciono) ----
  function sendMoveProtocol(wx, wy) {
    if (!socket || socket.readyState !== 1) return;
    const b = new ArrayBuffer(13);
    const v = new DataView(b);
    v.setUint8(0, 16);
    v.setInt32(1, wx | 0, true);
    v.setInt32(5, wy | 0, true);
    v.setUint32(9, 0, true);
    try { socket.send(b); } catch (_) {}
  }
  function sendOp(op) {
    if (!socket || socket.readyState !== 1) return;
    const b = new ArrayBuffer(1);
    new DataView(b).setUint8(0, op);
    try { socket.send(b); } catch (_) {}
  }

  // ---- javne akcije ----
  function move(nx, ny) {
    // nx,ny = normalizovan pravac (-1..1) u prostoru sveta (= ekran, y dole)
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    if (CONTROL === 'protocol') {
      const me = myCenter();
      if (me) sendMoveProtocol(me.x + nx * 2000, me.y + ny * 2000);
    } else {
      const cx = window.innerWidth / 2 + nx * MOVE_RADIUS;
      const cy = window.innerHeight / 2 + ny * MOVE_RADIUS;
      dispatchMouse(cx, cy);
    }
  }
  function split() {
    if (CONTROL === 'protocol') sendOp(17);
    else pressKey(' ', 'Space', 32);
  }
  function feed() {
    if (CONTROL === 'protocol') sendOp(21);
    else pressKey('w', 'KeyW', 87);
  }
  function respawn() {
    // Vecina klonova: Enter/klik na play ili razmak na ekranu smrti.
    pressKey('Enter', 'Enter', 13);
    const el = canvas();
    const ev = new MouseEvent('click', { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2, bubbles: true });
    el.dispatchEvent(ev);
  }

  // -------------------------- citanje stanja ----------------------------
  function myCenter() {
    let sx = 0, sy = 0, sm = 0, n = 0;
    for (const id of ownedIds) {
      const c = cells.get(id);
      if (!c) continue;
      const m = c.size * c.size;
      sx += c.x * m; sy += c.y * m; sm += m; n++;
    }
    if (!n || sm === 0) return null;
    return { x: sx / sm, y: sy / sm, size: Math.sqrt(sm), mass: sm / 100, cellCount: n };
  }

  function getState() {
    const me = myCenter();
    const entities = [];
    for (const c of cells.values()) {
      entities.push({
        id: c.id, x: c.x, y: c.y, size: c.size,
        isVirus: c.isVirus, isFood: c.isFood, isEjected: c.isEjected,
        isMine: ownedIds.has(c.id), name: c.name || '',
      });
    }
    return {
      connected: !!socket,
      spawned: !!me,
      me,                                   // {x,y,size,mass,cellCount} ili null
      entities,
      mapBounds,
      alive: (performance.now() - lastMsgAt) < 3000,
      capturesLen: captures.length,
    };
  }

  function command(cmd) {
    if (!cmd) return;
    if (cmd.dir) move(cmd.dir[0], cmd.dir[1]);
    if (cmd.feed) { for (let i = 0; i < (cmd.feed | 0 || 1); i++) feed(); }
    if (cmd.split) split();
    if (cmd.respawn) respawn();
  }

  Object.assign(window.__AGARAI, {
    ready: true,
    getState, command, move, split, feed, respawn,
    _dumpCaptures: () => captures.slice(),
  });

  if (OPT.debug) console.log('[agarai] hook postavljen');
})();
