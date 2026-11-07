// =====================================================================
// agarhook.js  -  IZVRSAVA SE U STRANICI (browser context), pre svega
//
// Zakaci WebSocket igre, dekodira agar protokol (klasicni Ogar/vanilla
// format koji vecina .rs/privatnih klonova koristi) i izlozi:
//
//   window.__AGARAI = {
//     ready,                     // hook postavljen
//     getState(): {...},         // zivo stanje sveta iz ugla ovog taba
//     status(): {...},           // kratak status mozga (za Node monitor)
//     command(cmd),              // primeni komandu (stari --brain node rezim)
//     split(), feed(), respawn(), pause(bool),
//     _captures                  // sirovi frejmovi ako je capture ukljucen
//   }
//
// MOZAK U STRANICI (--brain page, default): na svaki paket od servera
// pokrene strategiju (window.__AGARAI_STRAT, isti kod kao src/strategy.js)
// i komande salje DIREKTNO u socket (agar.rs protokol). Tabovi tima dele
// pozicije preko BroadcastChannel-a. Node samo pokrene, prati i po potrebi
// klikne Play.
// =====================================================================

(function () {
  if (window.__AGARAI && window.__AGARAI.ready) return;

  // -------- podesavanja koja stranica dobija od Node-a (opciono) --------
  const OPT = (window.__AGARAI_OPT || {});
  const CAPTURE = !!OPT.capture;
  const SNIFF = !!OPT.sniff;                 // ispisuj hex paketa u konzolu uzivo
  const MOVE_RADIUS = OPT.moveRadius || 320;
  const CONTROL = OPT.control || 'input';
  const STRAT = window.__AGARAI_STRAT || null;
  const BRAIN = !!OPT.brain && !!STRAT;      // mozak radi u ovoj stranici
  const IDX = OPT.index | 0;
  const NICKS = OPT.nicks || [];
  const BCFG = OPT.cfg || {};

  // Sniffer: ispisi prvih par paketa svakog opcode-a direktno u konzolu
  // (Playwright to prosledi u terminal). Najpouzdaniji nacin da vidimo bajtove.
  const _sniffN = {};
  function sniff(dir, op, len, hex) {
    if (!SNIFF) return;
    const k = dir + op;
    if ((_sniffN[k] || 0) >= 4) return;
    _sniffN[k] = (_sniffN[k] || 0) + 1;
    try { console.log('AGARAI ' + dir + ' op' + op + ' len=' + len + ' ' + hex); } catch (_) {}
  }

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
    // MultiOgar-Edited (protokol 4): 0x20 = izbacena masa (0x10 = "agitated")
    cell.isEjected = !cell.isVirus && !!(cell.flags & 0x30);
    // hrana = male celije bez imena (nisu virus/moje). Prag je relativan na
    // ono sto na agar.rs vidimo (pellet-i ~64, virus ~100, igraci vece).
    cell.isFood = !cell.isVirus && !cell.isMine && !cell.isEjected &&
      cell.size > 0 && cell.size <= 96 && !cell.name;
  }

  // --------------------- DEKODER: opcode 16 (update sveta) --------------
  // FORMAT ZA agar.rs (MultiOgar-Edited 1.6.1), potvrdjen iz --sniff hexa:
  //   u8  op = 16
  //   u16 eatCount
  //   eatCount x { u32 hunterId, u32 eatenId }         -> eatenId se uklanja
  //   loop:
  //     u32 id;  if 0 -> kraj
  //     i16 x
  //     i16 y
  //     u16 size
  //     u8 r, u8 g, u8 b        (boja - UVEK, PRE flag-a)
  //     u8 flags                (0x01 virus, 0x10 izbacena masa)
  //     utf16 name \0           (UVEK prisutno; prazno = 0x0000)
  //   u32 removeCount
  //   removeCount x { u32 id }                          -> uklanja se
  function decodeUpdate(view) {
    let o = 1;
    const now = performance.now();
    try {
      const eatCount = view.getUint16(o, true); o += 2;
      for (let i = 0; i < eatCount; i++) {
        o += 4;                              // hunterId
        const eaten = view.getUint32(o, true); o += 4;
        cells.delete(eaten);
        ownedIds.delete(eaten);
      }
      // celije
      while (true) {
        const id = view.getUint32(o, true); o += 4;
        if (id === 0) break;
        const x = view.getInt16(o, true); o += 2;
        const y = view.getInt16(o, true); o += 2;
        const size = view.getUint16(o, true); o += 2;
        const r = view.getUint8(o); o += 1;
        const g = view.getUint8(o); o += 1;
        const b = view.getUint8(o); o += 1;
        const flags = view.getUint8(o); o += 1;
        const rr = readUTF16(view, o); o = rr.o;   // ime uvek prisutno (moze biti prazno)
        const name = rr.s;

        let cell = cells.get(id);
        if (!cell) { cell = { id, vx: 0, vy: 0 }; cells.set(id, cell); }
        else if (cell.t) {
          // brzina (jedinica/ms), uglacana - za predvidjanje kretanja plena
          const dt = now - cell.t;
          if (dt > 5 && dt < 500) {
            cell.vx = cell.vx * 0.5 + ((x - cell.x) / dt) * 0.5;
            cell.vy = cell.vy * 0.5 + ((y - cell.y) / dt) * 0.5;
          }
        }
        cell.x = x; cell.y = y; cell.size = size;
        cell.r = r; cell.g = g; cell.b = b; cell.flags = flags;
        cell.name = name;
        cell.isMine = ownedIds.has(id);
        cell.t = now;
        classify(cell);
      }
      const removeCount = view.getUint32(o, true); o += 4;
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
    if (CAPTURE || SNIFF) {
      const arr = new Uint8Array(buf);
      const hex = bytesToHex(arr.slice(0, 256));
      if (CAPTURE) {
        captures.push({ t: Date.now(), dir: 'in', op: arr[0], len: arr.length, hex });
        if (captures.length > 1000) captures.shift();
      }
      sniff('IN', arr[0], arr.length, hex);
    }
    const view = new DataView(buf);
    if (view.byteLength < 1) return;
    const op = view.getUint8(0);
    switch (op) {
      case 16: decodeUpdate(view); brainStep(); break;
      case 18: cells.clear(); ownedIds.clear(); break;   // ClearAll (respawn) - bez duhova
      case 20: ownedIds.clear(); break;                  // ClearOwned
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
    ws.addEventListener('open', () => {
      if (OPT.debug) console.log('[agarai] WS open', url);
      if (SNIFF) { try { console.log('AGARAI URL ' + String(url)); } catch (_) {} }
    });
    if (CAPTURE) captures.push({ t: Date.now(), dir: 'url', url: String(url) });
    // Omotac oko send-a: (1) dok mozak vozi, klijentov SOPSTVENI mis (op16)
    // se odbacuje - inace bi se nas i njegov cilj svadjali; (2) capture/sniff.
    const origSend = ws.send.bind(ws);
    ws.send = function (d) {
      try {
        let a = null;
        if (d instanceof ArrayBuffer) a = new Uint8Array(d);
        else if (d && d.buffer instanceof ArrayBuffer) a = new Uint8Array(d.buffer, d.byteOffset || 0, d.byteLength);
        if (a && a.length) {
          if (!ourSend && a[0] === 16 && brainDriving()) return;   // klijentov mis - mi vozimo
          if (CAPTURE || SNIFF) {
            const hex = bytesToHex(a.slice(0, 128));
            if (CAPTURE) {
              captures.push({ t: Date.now(), dir: 'out', op: a[0], len: a.length, hex });
              if (captures.length > 1000) captures.shift();
            }
            sniff('OUT', a[0], a.length, hex);
          }
        }
      } catch (_) {}
      return origSend(d);
    };
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

  // VAZNO: dogadjaj saljemo JEDNOM, na canvas, sa bubbles:true. On se sam
  // propagira canvas -> body -> document -> window, pa ga dobije svaki
  // listener klijenta. Ranije smo slali i na window i na document, pa je
  // klijent koji slusa na window dobijao 2 pritiska -> dupli split/eject.
  function dispatchMouse(cx, cy) {
    const ev = new MouseEvent('mousemove', {
      clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window,
    });
    canvas().dispatchEvent(ev);
  }

  function pressKey(key, code, keyCode) {
    const target = canvas();
    for (const type of ['keydown', 'keyup']) {
      const ev = new KeyboardEvent(type, { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true });
      target.dispatchEvent(ev);
    }
  }

  // ---- slanje preko protokola (opciono) ----
  function sendMoveProtocol(wx, wy) {
    if (!socket || socket.readyState !== 1) return;
    // agar.rs (MultiOgar) move = op16 + f64 x + f64 y + u32 0  (21 bajta)
    const b = new ArrayBuffer(21);
    const v = new DataView(b);
    v.setUint8(0, 16);
    v.setFloat64(1, wx, true);
    v.setFloat64(9, wy, true);
    v.setUint32(17, 0, true);
    rawSend(b);
  }
  function sendOp(op) {
    if (!socket || socket.readyState !== 1) return;
    const b = new ArrayBuffer(1);
    new DataView(b).setUint8(0, op);
    rawSend(b);
  }
  // nasi paketi prolaze kroz filter (ourSend) - klijentov mis ne
  let ourSend = false;
  function rawSend(b) {
    ourSend = true;
    try { socket.send(b); } catch (_) {}
    ourSend = false;
  }
  // respawn bez UI-ja: isti paket koji klijent salje na Play (op0 + UTF16 nick)
  function sendNick(nick) {
    if (!socket || socket.readyState !== 1) return;
    const b = new ArrayBuffer(1 + nick.length * 2);
    const v = new DataView(b);
    v.setUint8(0, 0);
    for (let i = 0; i < nick.length; i++) v.setUint16(1 + i * 2, nick.charCodeAt(i), true);
    rawSend(b);
  }

  // ---- javne akcije ----
  // speed (0..1): koliko daleko od centra stavljamo mis = koliko brzo idemo.
  // Izbacaj mase (W) ide u pravcu misa bez obzira na ovu udaljenost, pa
  // mali speed = sporo prilazenje uz izbacivanje ka cilju.
  function move(nx, ny, speed) {
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    const s = (typeof speed === 'number') ? Math.max(0.06, Math.min(1, speed)) : 1;
    if (CONTROL === 'protocol') {
      const me = myCenter();
      if (me) sendMoveProtocol(me.x + nx * 2000 * s, me.y + ny * 2000 * s);
    } else {
      const cx = window.innerWidth / 2 + nx * MOVE_RADIUS * s;
      const cy = window.innerHeight / 2 + ny * MOVE_RADIUS * s;
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
  let lastMaxId = null;
  function myCenter() {
    let sx = 0, sy = 0, sm = 0, n = 0, maxCell = 0, mx = 0, my = 0, maxId = null;
    for (const id of ownedIds) {
      const c = cells.get(id);
      if (!c) continue;
      const m = c.size * c.size;
      sx += c.x * m; sy += c.y * m; sm += m; n++;
      if (c.size > maxCell) { maxCell = c.size; mx = c.x; my = c.y; maxId = id; }
    }
    if (!n || sm === 0) return null;
    // histereza: dve skoro jednake polovine posle split-a ne smeju da se
    // smenjuju kao "najveci deo" svaki tik (hranioci bi skakali levo-desno)
    const prevMax = lastMaxId != null ? cells.get(lastMaxId) : null;
    if (prevMax && ownedIds.has(lastMaxId) && prevMax.size >= maxCell * 0.9) { mx = prevMax.x; my = prevMax.y; maxId = lastMaxId; }
    lastMaxId = maxId;
    // size = ukupni radijus, maxCell = najveci pojedinacni blob (za izbor kralja:
    // ceo bot > fragmentisan bot iste ukupne mase); mx,my = gde je taj blob
    // (razbijen kralj: hranilac nisani u njega, ne u prazan centroid).
    return { x: sx / sm, y: sy / sm, size: Math.sqrt(sm), mass: sm / 100, cellCount: n, maxCell, mx, my };
  }

  function getState() {
    const me = myCenter();
    const entities = [];
    for (const c of cells.values()) {
      entities.push({
        id: c.id, x: c.x, y: c.y, size: c.size, vx: c.vx || 0, vy: c.vy || 0,
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
    if (cmd.dir) move(cmd.dir[0], cmd.dir[1], cmd.speed);
    if (cmd.feed) { for (let i = 0; i < (cmd.feed | 0 || 1); i++) feed(); }
    if (cmd.split) split();
    if (cmd.respawn) respawn();
  }

  // ========================== MOZAK U STRANICI ==========================
  // Odlucuje na svaki update od servera (~25x/s). Nema Node-a u petlji.
  const team = NICKS.map(() => null);            // poslednja poruka od svakog saigraca
  let roles = null;                              // poslednja odluka vodje: { i, carrier, t }
  // Slanje timu: BroadcastChannel (brzo) + REZERVA preko Node-a (window.__agaraiOut,
  // izlozen iz Playwright-a) - radi i kad je igra u iframe-u/drugom origin-u
  // gde BroadcastChannel ne povezuje tabove.
  const lastOut = {};
  function cast(msg) {
    if (chan) { try { chan.postMessage(msg); } catch (_) {} }
    const k = msg.type || 'state';
    if (typeof window.__agaraiOut === 'function' && (!lastOut[k] || msg.t - lastOut[k] >= 100)) {
      lastOut[k] = msg.t;
      try { window.__agaraiOut(msg); } catch (_) {}
    }
  }
  function take(m) {
    if (!m || typeof m.i !== 'number' || m.i === IDX) return;
    if (m.type === 'roles') { if (!roles || m.t >= roles.t) roles = m; }
    else if (!team[m.i] || m.t >= team[m.i].t) team[m.i] = m;
  }
  let chan = null;
  if (BRAIN && !OPT.noBroadcast && typeof BroadcastChannel !== 'undefined') {
    try {
      chan = new BroadcastChannel('agarai-team');
      chan.onmessage = (e) => take(e.data);
    } catch (_) { chan = null; }
  }
  const bot = { index: IDX, nick: NICKS[IDX] || '' };
  let paused = false, prevKing = null, kingIdx = null, lastBrain = 0, lastCast = 0;
  let note = '-', steps = 0, firstStep = 0, deadSince = 0, lastNickSent = 0;
  let flips = 0, rapidFlips = 0, lastFlipAt = 0, prevDir = null, prevNote = '';
  const flipCauses = {};

  function brainDriving() { return BRAIN && !paused && CONTROL === 'protocol' && ownedIds.size > 0; }

  function teamCenters(me, nowMs) {
    return NICKS.map((_, i) => {
      if (i === IDX) return me;
      const m = team[i];
      if (!m || m.dead || nowMs - m.t > 1500) return null;
      return { x: m.x, y: m.y, size: m.size, maxCell: m.maxCell, cellCount: m.cellCount, mass: m.mass, mx: m.mx, my: m.my, giving: !!m.giving, hunting: !!m.hunting, hx: m.hx, hy: m.hy };
    });
  }

  function applyCmd(cmd, me) {
    if (CONTROL !== 'protocol') {
      // input rezim: pretvori aim u pravac pa kroz sinteticke dogadjaje
      if (cmd.aim && me) cmd.dir = [cmd.aim.x - me.x, cmd.aim.y - me.y];
      command(cmd);
      return;
    }
    let tx = null, ty = null;
    if (cmd.aim) { tx = cmd.aim.x; ty = cmd.aim.y; }
    else if (cmd.dir) {
      const s = typeof cmd.speed === 'number' ? Math.max(0.06, Math.min(1, cmd.speed)) : 1;
      tx = me.x + cmd.dir[0] * 900 * s; ty = me.y + cmd.dir[1] * 900 * s;
    }
    if (tx !== null) sendMoveProtocol(tx, ty);      // mis PRE split/W da bi isli u pravu stranu
    if (cmd.split) sendOp(17);
    for (let i = 0; i < (cmd.feed | 0); i++) sendOp(21);
  }

  function brainStep() {
    if (!BRAIN || paused) return;
    const t = performance.now();
    if (t - lastBrain < (BCFG.brainMs || 35)) return;
    lastBrain = t;
    if (!firstStep) firstStep = t;
    const nowMs = Date.now();
    const me = myCenter();
    if (t - lastCast > 60) {
      lastCast = t;
      try {
        cast(me ? { i: IDX, t: nowMs, x: me.x, y: me.y, size: me.size, maxCell: me.maxCell, cellCount: me.cellCount, mass: me.mass, mx: me.mx, my: me.my, giving: !!bot._giving, hunting: nowMs < (bot._huntingUntil || 0), hx: bot._heading ? bot._heading[0] : null, hy: bot._heading ? bot._heading[1] : null }
          : { i: IDX, t: nowMs, dead: true });
      } catch (_) {}
    }
    if (!me) {
      // mrtav: posle kratke pauze posalji nick (= klik na Play), ponavljaj retko
      if (!deadSince) deadSince = nowMs;
      note = 'mrtav - respawn';
      prevDir = null;
      if (nowMs - deadSince > (BCFG.respawnDelayMs || 700) && nowMs - lastNickSent > 2000 && bot.nick) {
        lastNickSent = nowMs;
        sendNick(bot.nick);
      }
      return;
    }
    deadSince = 0;
    const st = getState();
    const centers = teamCenters(st.me, nowMs);
    // VODJA TIMA = najmanji zivi indeks. Samo on bira nosioca i javlja ostalima,
    // da se uloge ne klackaju (svaki tab bi inace racunao za sebe).
    const alive = centers.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
    const leader = alive.length ? alive[0] : IDX;
    if (leader === IDX) {
      kingIdx = STRAT.pickKing(BCFG, centers, prevKing);
      cast({ type: 'roles', i: IDX, carrier: kingIdx, t: nowMs });
    } else if (roles && roles.i === leader && nowMs - roles.t < 600 && centers[roles.carrier]) {
      kingIdx = roles.carrier;
    } else {
      kingIdx = STRAT.pickKing(BCFG, centers, prevKing);   // vodja se ne cuje - sam
    }
    prevKing = kingIdx;
    // mesto u formaciji: pratnja sortirana po indeksu -> 0 = iza-levo, 1 = iza-desno
    const supports = alive.filter((i) => i !== kingIdx);
    const slot = supports.indexOf(IDX);
    const cmd = STRAT.decide(bot, st, { cfg: BCFG, kingIndex: kingIdx, teamCenters: centers, teamNicks: NICKS, now: nowMs, slot: slot >= 0 ? slot : 0 });
    note = cmd.note || '-';
    steps++;
    // GLATKO UPRAVLJANJE: ogranici brzinu okretanja smera. Kolebanje cilja
    // (plen vijuga, dve polovine kralja...) se tako izgubi, a namerni okret
    // od 180 stepeni traje ~0.25s. Nisan za split/W se ne dira (mora tacno);
    // bekstvo sme brze da okrene.
    if (cmd.dir && !cmd.split && !cmd.feed) {
      if (cmd.aim && st.me) cmd.dir = [cmd.aim.x - st.me.x, cmd.aim.y - st.me.y];
      const maxDeg = cmd._flee ? (BCFG.fleeTurnDeg || 70) : (BCFG.maxTurnDeg || 30);
      const sm = rotateToward(prevDir, cmd.dir, maxDeg);
      if (sm !== cmd.dir) cmd.aim = null;
      cmd.dir = sm;
    }
    if (cmd.dir) {
      const l = Math.hypot(cmd.dir[0], cmd.dir[1]) || 1;
      prevDir = [cmd.dir[0] / l, cmd.dir[1] / l];
      trackFlips(prevDir, nowMs);
    }
    prevNote = note;
    applyCmd(cmd, st.me);
  }

  // okreni smer a ka smeru b najvise za maxDeg stepeni
  function rotateToward(a, b, maxDeg) {
    if (!a) return b;
    const aa = Math.atan2(a[1], a[0]);
    const bb = Math.atan2(b[1], b[0]);
    let d = bb - aa;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const m = maxDeg * Math.PI / 180;
    if (Math.abs(d) <= m) return b;
    const r = aa + Math.sign(d) * m;
    return [Math.cos(r), Math.sin(r)];
  }

  // jitter statistika: smer sada vs pre ~300ms; okret > 100 stepeni je
  // dogadjaj, a "brz" je ako dodje < 1.5s posle prethodnog (cimanje).
  const dirHist = [];
  function trackFlips(dir, nowMs) {
    dirHist.push({ t: nowMs, d: dir, n: note });
    while (dirHist.length && nowMs - dirHist[0].t > 300) {
      const old = dirHist[0];
      if (nowMs - old.t < 300) break;
      dirHist.shift();
      if (nowMs - lastFlipAt < 300) continue;
      if (dir[0] * old.d[0] + dir[1] * old.d[1] < -0.17) {
        flips++;
        if (nowMs - lastFlipAt < 1500) {
          rapidFlips++;
          const k = old.n + ' -> ' + note;
          flipCauses[k] = (flipCauses[k] || 0) + 1;
        }
        lastFlipAt = nowMs;
        dirHist.length = 0;
        break;
      }
    }
  }
  // rezerva ako server neko vreme ne salje update (npr. posle smrti)
  if (BRAIN) setInterval(() => { if (performance.now() - lastBrain > 250) brainStep(); }, 250);

  function status() {
    const me = myCenter();
    const secs = firstStep ? (performance.now() - firstStep) / 1000 : 0;
    return {
      brain: BRAIN, paused, note, king: kingIdx, index: IDX, spawned: !!me,
      connected: !!socket,
      mass: me ? Math.round(me.mass) : 0, cells: me ? me.cellCount : 0,
      dps: secs > 1 ? Math.round(steps / secs) : 0,
      flips, rapidFlips, flipCauses,
      teamSeen: team.filter((m, i) => i !== IDX && m && Date.now() - m.t < 1500).length,
    };
  }

  Object.assign(window.__AGARAI, {
    ready: true,
    getState, command, move, split, feed, respawn, status,
    pause: (p) => { paused = !!p; },
    recv: (list) => { for (const m of list || []) take(m); },   // tim poruke preko Node-a
    _dumpCaptures: () => captures.slice(),
  });

  if (OPT.debug) console.log('[agarai] hook postavljen');
})();
