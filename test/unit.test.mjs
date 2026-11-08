// Brzi unit testovi (bez browsera, bez mreze):  npm test
//  - dekoder hook-a na STVARNIM agar.rs frejmovima (uhvacenim --sniff-om)
//  - kontrola: split/feed = tacno JEDAN pritisak tastera
//  - strategija: kljucni scenariji ponasanja
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, pickKing } from '../src/strategy.js';
import { buildConfig } from '../src/config.js';
import { pageScript } from '../src/browser.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = fs.readFileSync(path.join(ROOT, 'src/inject/agarhook.js'), 'utf8');

// ---------------------------------------------------------------------------
// Pokreni hook u izolovanom "browseru" (vm) sa laznim WebSocket-om i DOM-om.
// Sve se pravi UNUTAR vm realm-a (ArrayBuffer instanceof provera u hook-u).
function loadHook(opt = {}, src = null) {
  const ctx = vm.createContext({ console });
  ctx.__opt = opt;
  vm.runInContext(`
    var window = globalThis;
    window.__AGARAI_OPT = __opt;
    var setInterval = () => 0;
    var __bc = [];
    class BroadcastChannel { constructor(n) { this.n = n; this.sent = []; __bc.push(this); } postMessage(m) { this.sent.push(m); } }
    var performance = { now: () => Date.now() };
    class Blob {}
    class FakeEvent { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } }
    class MouseEvent extends FakeEvent {}
    class KeyboardEvent extends FakeEvent {}
    var __events = [];
    var __canvas = { dispatchEvent(ev) { __events.push(ev); return true; } };
    var document = { querySelector: (s) => (s === 'canvas' ? __canvas : null), body: __canvas };
    window.innerWidth = 1000; window.innerHeight = 720;
    window.dispatchEvent = (ev) => { __events.push(Object.assign({ via: 'window' }, ev)); };
    class FakeWS {
      constructor(url) { this.url = url; this.readyState = 1; this._l = {}; this.sent = []; FakeWS.last = this; }
      addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
      send(d) { this.sent.push(d); }
      __emit(hex) {
        const u = new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
        for (const f of (this._l.message || [])) f({ data: u.buffer });
      }
    }
    window.WebSocket = FakeWS;
  `, ctx);
  vm.runInContext(src || HOOK, ctx);
  const ws = vm.runInContext(`window.__AGARAI_WS = new window.WebSocket('wss://srv3.agar.rs:2087')`, ctx);
  return {
    feed: (hex) => { ctx.__h = hex; vm.runInContext('FakeWS.last.__emit(__h)', ctx); },
    state: () => JSON.parse(JSON.stringify(vm.runInContext('window.__AGARAI.getState()', ctx))),
    call: (code) => vm.runInContext(code, ctx),
    events: () => vm.runInContext('__events.map(e => e.type)', ctx),
    ws,
  };
}

// Pravi frejmovi uhvaceni sa srv3.agar.rs:2087 (MultiOgar-Edited 1.6.1)
const OP64 = '4000000000c0c3c2c000000000c0c3c2c000000000c0c3c24000000000c0c3c240';
const OP32 = '2039280300';
const OP16 = '100000f2f5020034db9cf6640033ff33010000101a03003ae6a001400007ffb6000000541a03002be62701310007ffb60000005c1a0300bde4c0fe310007ffb60000005d1a030079e66101310007ffb6000000611a03006ce54200310007ffb6000000f91e0300c1e56201300007ffb6000000fb1e0300a1e5d800300007ffb6000000fc1e03003ee5a500300007ffb6000000fe1e030015e5a8ff300007ffb6000000011f0300efe44dff300007ffb6000000041f0300e5e54801300007ffb6000000061f03008ae489fd300007ffb6000000081f030034e630f9300007ffb60000000c1f03003de5eaff300007ffb6000000101f0300a7e58400300007ffb6';
const OP16_NAMED = '10' + '0000' + '101a030025e6a401' + '4000' + '07ffb6' + '00' +
  '5b006a006f00760061006e0061006c006f006c003100300032005d006d0061006e00650061007400650072000000' + '00000000';
// moja celija id 0x00032839 = 206393 na (100,-50) size 80, ime "tripleXa"
const nameHex = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0') + '00').join('') + '0000';
const le16 = (n) => { const b = Buffer.alloc(2); b.writeInt16LE(n); return b.toString('hex'); };
const OP16_ME = '10' + '0000' + '39280300' + le16(100) + le16(-50) + '5000' + 'ff0000' + '00' + nameHex('tripleXa') + '00000000' + '00000000';

test('dekoder: stvarni agar.rs frejmovi -> tacne pozicije, virus, hrana, ime', () => {
  const h = loadHook();
  h.feed(OP64); h.feed(OP32); h.feed(OP16); h.feed(OP16_NAMED);
  const st = h.state();
  assert.equal(st.mapBounds.maxx, 9607.5);
  const b = st.mapBounds;
  assert.ok(st.entities.length >= 15);
  for (const e of st.entities) {
    assert.ok(e.x >= b.minx && e.x <= b.maxx && e.y >= b.miny && e.y <= b.maxy, `van granica: ${JSON.stringify(e)}`);
  }
  const v = st.entities.filter((e) => e.isVirus);
  assert.equal(v.length, 1);
  assert.equal(v[0].size, 100);
  assert.ok(st.entities.some((e) => e.name === '[jovanalol102]maneater'));
  assert.ok(st.entities.filter((e) => e.isFood).length >= 10);
});

test('dekoder: ime se pamti - sledeci update iste celije stize sa praznim imenom (pravi agar.rs)', () => {
  const h = loadHook();
  h.feed(OP64);
  h.feed(OP16_NAMED);                                  // celija 0x31a10 ulazi u vidokrug SA imenom
  h.feed(OP16);                                        // stvarni sledeci frejm: ista celija, ime prazno
  const c = h.state().entities.find((e) => e.id === 0x00031a10);
  assert.ok(c, 'celija postoji');
  assert.equal(c.name, '[jovanalol102]maneater');
  assert.equal(c.isFood, false, 'imenovan igrac nije hrana');
});

test('dekoder: moja celija (op32 + op16) -> spawned, me na tacnoj poziciji', () => {
  const h = loadHook();
  h.feed(OP64); h.feed(OP32); h.feed(OP16_ME);
  const st = h.state();
  assert.equal(st.spawned, true);
  assert.equal(Math.round(st.me.x), 100);
  assert.equal(Math.round(st.me.y), -50);
  assert.equal(st.me.cellCount, 1);
  assert.equal(st.me.maxCell, 80);
});

test('dekoder: op18 (ClearAll pri respawnu) brise stare celije - nema duhova', () => {
  const h = loadHook();
  h.feed(OP64); h.feed(OP32); h.feed(OP16); h.feed(OP16_ME);
  assert.ok(h.state().entities.length > 10);
  h.feed('12');
  const st = h.state();
  assert.equal(st.entities.length, 0);
  assert.equal(st.spawned, false);
});

test('kontrola: split i feed su TACNO jedan keydown (ranije dupli)', () => {
  const h = loadHook({ control: 'input' });
  h.call('window.__AGARAI.split()');
  let ev = h.events();
  assert.equal(ev.filter((t) => t === 'keydown').length, 1, 'split mora biti 1 keydown');
  h.call('__events.length = 0; window.__AGARAI.feed()');
  ev = h.events();
  assert.equal(ev.filter((t) => t === 'keydown').length, 1, 'feed mora biti 1 keydown');
});

test('kontrola: --control protocol salje tacne agar.rs pakete', () => {
  const h = loadHook({ control: 'protocol' });
  h.feed(OP64); h.feed(OP32); h.feed(OP16_ME);
  h.call('window.__AGARAI.split(); window.__AGARAI.feed(); window.__AGARAI.move(1, 0, 1)');
  const sent = JSON.parse(h.call('JSON.stringify(FakeWS.last.sent.map(b => Array.from(new Uint8Array(b))))'));
  assert.deepEqual(sent[0], [17]);
  assert.deepEqual(sent[1], [21]);
  assert.equal(sent[2].length, 21);       // op16 + f64 + f64 + u32
  assert.equal(sent[2][0], 16);
});

// ---------------------------------------------------------------------------
// Strategija
process.argv = process.argv.slice(0, 2);                 // bez CLI flagova -> default podesavanja
const CFG = { ...buildConfig(), fleeLatchMs: 450 };
const MB = { minx: -9607, miny: -9607, maxx: 9607, maxy: 9607 };
const NICKS = ['tripleXa', 'tripleXb', 'tripleXc'];
const meAt = (x, y, size, cells = 1) => ({ x, y, size, mass: size * size / 100, maxCell: size, cellCount: cells });
const st = (me, ents) => ({ spawned: true, me, mapBounds: MB, entities: [{ id: 1, x: me.x, y: me.y, size: me.size, isMine: true }, ...ents] });
const ctx = (over) => ({ cfg: CFG, kingIndex: 0, teamNicks: NICKS, now: 1000, ...over });

test('strategija: ne juri hranu vecu od sebe', () => {
  const me = meAt(0, 0, 30);
  const d = decide({ index: 0 }, st(me, [
    { id: 2, x: 50, y: 0, size: 90, isFood: true },     // 3x veca "hrana" - NE
    { id: 3, x: -200, y: 0, size: 12, isFood: true },   // prava hrana - DA
  ]), ctx({ teamCenters: [me, null, null] }));
  assert.ok(d.dir[0] < -0.9, `treba levo ka maloj hrani, dobio ${d.dir}`);
});

test('strategija: bezi tek od >=2x MASE; 1.5x mase samo blago zaobilazi', () => {
  const me = meAt(0, 0, 200);                              // masa 400
  // 1.5x mase (size 245): ne bezi, ali ne ide ni pravo u njega
  const a = decide({ index: 0 }, st(me, [{ id: 2, x: 400, y: 0, size: 245, name: 'X' },
    { id: 3, x: 600, y: 0, size: 12, isFood: true }]), ctx({ teamCenters: [me, null, null] }));
  assert.ok(!/bezim/.test(a.note), a.note);
  assert.ok(a.dir[0] < 0.99, 'treba da skrene od 1.5x protivnika');
  // 2.6x mase (size 323): bezi
  const b = decide({ index: 0 }, st(me, [{ id: 2, x: 400, y: 0, size: 323, name: 'BIG' }]), ctx({ teamCenters: [me, null, null] }));
  assert.ok(/bezim|BEG split/.test(b.note), b.note);
  assert.ok(b.dir[0] < 0);
});

test('strategija: hrana ispred ima prednost nad malo blizom iza (anti-jitter)', () => {
  const me = meAt(0, 0, 60);
  const bot = { index: 0, _heading: [1, 0] };
  const d = decide(bot, st(me, [{ id: 2, x: -100, y: 0, size: 10, isFood: true }, { id: 3, x: 130, y: 0, size: 10, isFood: true }]),
    ctx({ teamCenters: [me, null, null] }));
  assert.ok(d.dir[0] > 0.9, `treba napred, dobio ${d.dir}`);
});

test('strategija: kralj ide u susret spremnom hraniocu', () => {
  const me = meAt(0, 0, 200);
  const mate = meAt(2000, 0, 70);
  const d = decide({ index: 0 }, st(me, [{ id: 6, x: -150, y: 0, size: 12, isFood: true }]),
    ctx({ teamCenters: [me, mate, null] }));
  assert.equal(d.note, 'kralj ide po masu');
  assert.ok(d.dir[0] > 0.9);
});

test('strategija: hranilac NE bezi od split-delova svog kralja (prepoznaje po imenu)', () => {
  const king = meAt(0, 0, 400, 4);
  const me = meAt(1500, 0, 120);
  // delovi kralja daleko od njegovog centroida, veci od 2x hranioca
  const d = decide({ index: 1 }, st(me, [
    { id: 7, x: 1200, y: 0, size: 300, name: 'tripleXa' },
    { id: 8, x: 1300, y: 300, size: 260, name: 'tripleXa' },
  ]), ctx({ teamCenters: [king, me, null] }));
  assert.ok(!/bezim/.test(d.note), `ne sme bezati od kralja: ${d.note}`);
});

test('strategija: tudji igrac sa imenom se NE maskira kao saigrac', () => {
  const king = meAt(0, 0, 500);
  const me = meAt(300, 0, 100);
  const d = decide({ index: 1 }, st(me, [{ id: 9, x: 450, y: 0, size: 260, name: 'ENEMY' }]),
    ctx({ teamCenters: [king, me, null] }));
  assert.ok(/bezim|BEG split/.test(d.note), d.note);
});

test('ping-pong: mali naspram velikog kralja daje SVE (ostatak ne bi mogao da primi nazad)', () => {
  const king = meAt(0, 0, 500);                        // masa 2500
  const me = meAt(900, 0, 120);                        // masa 144 < 6% od 2644 -> keep 0
  const bot = { index: 1 };
  const P1 = { ...CFG, pingPong: false };              // faza 1: daj sve
  const c = (now, m = me) => decide(bot, st(m, []), ctx({ cfg: P1, teamCenters: [king, m, null], now }));
  const d1 = c(1000);
  assert.equal(d1.split, true);
  assert.equal(d1.note, 'DAJEM masu (split)');
  const d2 = c(1100);                                  // cooldown -> ulece
  assert.ok(!d2.split);
  assert.equal(d2.note, 'DAJEM masu');
  const frag = { ...meAt(900, 0, 120, 4), maxCell: 60 };   // sitni delovi -> samo ubacuje
  const d3 = c(2000, frag);
  assert.ok(!d3.split);
  assert.equal(d3.note, 'DAJEM masu');
  const tiny = meAt(900, 0, 50);                       // i mrvica ide u kralja (ne sedi beskorisno)
  assert.equal(c(3000, tiny).note, 'DAJEM masu');
});

test('--pingpong: uporedivi botovi - davalac zadrzi ostatak dovoljan da primi nazad', () => {
  const king = meAt(0, 0, 300);                        // masa 900
  const me = meAt(700, 0, 250);                        // masa 625 -> keep ~175
  const bot = { index: 1 };
  const c = (now, m) => decide(bot, st(m, []), ctx({ cfg: { ...CFG, pingPong: true }, teamCenters: [king, m, null], now }));
  const d1 = c(1000, me);
  assert.equal(d1.note, 'DAJEM masu (split)');
  assert.equal(bot._giving, true);
  const rest = meAt(700, 0, 100);                      // masa 100 <= ostatak ~105 -> staje
  const d2 = c(2000, rest);
  assert.equal(bot._giving, false);
  assert.ok(/skupljam|pratnja/.test(d2.note), d2.note);
});

test('ping-pong: ogroman davalac se namerno razbije o virus pored malog primaoca', () => {
  const king = meAt(0, 0, 100);                        // mali primalac
  const me = meAt(800, 0, 400);                        // ogroman davalac
  const d = decide({ index: 1 }, st(me, [{ id: 9, x: 150, y: 0, size: 100, isVirus: true }]),
    ctx({ teamCenters: [king, me, null] }));
  assert.equal(d.note, 'DAJEM: razbijam se o virus');
  assert.deepEqual(d.aim, { x: 150, y: 0 });
  assert.ok(d.dir[0] < -0.999, 'ide pravo u virus, bez izbegavanja');
});

test('ping-pong: razbijen kralj odmah predaje krunu celom saigracu (ako moze da primi)', () => {
  const frag = { x: 0, y: 0, size: 500, maxCell: 400, cellCount: 4, mass: 2500 };
  const small = { x: 300, y: 0, size: 100, maxCell: 100, cellCount: 1, mass: 100 };   // 4% - premalo
  assert.equal(pickKing({ king: 'auto', recvMinFrac: 0.06 }, [frag, small, null], 0), 0);
  const ok = { ...small, size: 141, maxCell: 141, mass: 200 };                        // 8% - moze
  assert.equal(pickKing({ king: 'auto', recvMinFrac: 0.06 }, [frag, ok, null], 0), 1);
});

test('strategija: kralj usisava delove razbijenog saigraca, a celog ne dira', () => {
  const me = meAt(0, 0, 400);
  const fragMate = meAt(600, 0, 150, 3);
  const pieces = [{ id: 5, x: 600, y: 0, size: 90, name: 'tripleXb' }];
  const d = decide({ index: 0 }, st(me, [...pieces, { id: 6, x: -100, y: 0, size: 12, isFood: true }]),
    ctx({ teamCenters: [me, fragMate, null] }));
  assert.equal(d.note, 'kralj kupi masu');
  assert.ok(d.dir[0] > 0.9);
  const wholeMate = meAt(600, 0, 150, 1);
  const d2 = decide({ index: 0 }, st(me, [{ id: 5, x: 600, y: 0, size: 150, name: 'tripleXb' }, { id: 6, x: -100, y: 0, size: 12, isFood: true }]),
    ctx({ teamCenters: [me, wholeMate, null] }));
  assert.notEqual(d2.note, 'kralj kupi masu');
});

test('lov: kralj split-ubija mali plen u dometu, nisani ispred plena', () => {
  const me = meAt(0, 0, 300);
  const bot = { index: 0 };
  const d = decide(bot, st(me, [{ id: 2, x: 500, y: 0, size: 120, vx: 0, vy: 0.5, name: 'plen' }]), ctx({ teamCenters: [me, null, null] }));
  assert.equal(d.split, true);
  assert.equal(d.note, 'SPLIT-KILL');
  assert.ok(d.aim.y > 50, 'mora nisaniti gde ce plen biti');
  // odmah posle: cooldown -> juri bez splita
  const d2 = decide(bot, st(me, [{ id: 2, x: 500, y: 0, size: 120, name: 'plen' }]), ctx({ teamCenters: [me, null, null], now: 1100 }));
  assert.ok(!d2.split);
  assert.equal(d2.note, 'kralj lovi');
});

test('lov: nema split-kill na prevelik plen (pola mene ga ne bi pojelo) - samo juri', () => {
  const me = meAt(0, 0, 400);
  const d = decide({ index: 0 }, st(me, [{ id: 2, x: 600, y: 0, size: 300, name: 'plen' }]), ctx({ teamCenters: [me, null, null] }));
  assert.ok(!d.split);
  assert.equal(d.note, 'kralj lovi');
});

test('lov: nema split-kill kad je velika pretnja u blizini', () => {
  const me = meAt(0, 0, 300);
  const d = decide({ index: 0 }, st(me, [
    { id: 2, x: 500, y: 0, size: 120, name: 'plen' },
    { id: 3, x: -1300, y: 0, size: 480, name: 'BIG' },
  ]), ctx({ teamCenters: [me, null, null] }));
  assert.ok(!d.split, d.note);
});

test('tim (--feedmode mixed): hranilac na putu ka kralju pumpa W u njega (aim = kralj)', () => {
  const king = meAt(0, 0, 300);
  const me = meAt(950, 0, 100);        // reach=(300+100)*1.7=680 < 950 < 300+100+650=1050
  const d = decide({ index: 1 }, st(me, []), ctx({ cfg: { ...CFG, feedMode: 'mixed', pingPong: false }, teamCenters: [king, me, null] }));
  assert.equal(d.note, 'DAJEM masu (W)');
  assert.ok(d.feed >= 1);
  assert.deepEqual(d.aim, { x: 0, y: 0 });
});

test('--pingpong: posle davanja (pauza) uporedivi bot skuplja uz kralja, ne ulece', () => {
  const king = meAt(0, 0, 300);
  const me = meAt(700, 0, 250);
  const bot = { index: 1, _giveDoneAt: 900 };          // upravo dao -> pauza
  const d = decide(bot, st(me, []), ctx({ cfg: { ...CFG, pingPong: true }, teamCenters: [king, me, null], now: 1000 }));
  assert.ok(/pratnja/.test(d.note), d.note);
});

test('strategija: flee-latch drzi bekstvo kratko posle nestanka pretnje', () => {
  const king = meAt(8000, 8000, 500);
  const me = meAt(0, 0, 100);
  const bot = { index: 1 };
  const T = [{ id: 2, x: 300, y: 0, size: 300, name: 'BIG' }];
  assert.ok(/bezim od pretnje|BEG split/.test(decide(bot, st(me, T), ctx({ teamCenters: [king, me, null], now: 1000 })).note));
  assert.equal(decide(bot, st(me, []), ctx({ teamCenters: [king, me, null], now: 1200 })).note, 'bezim (inercija)');
  assert.notEqual(decide(bot, st(me, []), ctx({ teamCenters: [king, me, null], now: 1600 })).note, 'bezim (inercija)');
});

test('strategija: virus skretanje ne kvari nisan kod split-a', () => {
  const king = meAt(0, 0, 500);
  const me = meAt(900, 0, 200);
  const d = decide({ index: 1 }, st(me, [{ id: 9, x: 800, y: 60, size: 100, isVirus: true }]),
    ctx({ teamCenters: [king, me, null], now: 1000 }));
  assert.equal(d.split, true);
  assert.ok(Math.abs(d.dir[1]) < 1e-9 && d.dir[0] < -0.999, `nisan mora biti tacno u kralja: ${d.dir}`);
});

test('pickKing: najveci CEO blob + histereza', () => {
  const tc = [{ maxCell: 500, size: 520 }, { maxCell: 300, size: 600 }, null];
  assert.equal(pickKing({ king: 'auto' }, tc, null), 0);
  assert.equal(pickKing({ king: 'auto' }, [{ maxCell: 500 }, { maxCell: 460 }, null], 1), 1);
  assert.equal(pickKing({ king: 'auto' }, [{ maxCell: 500 }, { maxCell: 300 }, null], 1), 0);
});

test('mozak u stranici: sam odlucuje na update, salje paket direktno, filtrira klijentov mis', () => {
  const cfg = { ...buildConfig(), count: 3 };
  const h = loadHook({}, pageScript(cfg, 0));
  h.feed(OP64); h.feed(OP32);
  h.feed(OP16_ME);                                   // update -> mozak odlucuje odmah
  const sent = () => JSON.parse(h.call('JSON.stringify(FakeWS.last.sent.map(b => Array.from(new Uint8Array(b))))'));
  const moves = sent().filter((a) => a[0] === 16 && a.length === 21);
  assert.ok(moves.length >= 1, 'mozak mora poslati mis (op16, f64) bez Node-a');
  // klijent pokusa da posalje SVOJ mis -> mora biti odbacen dok mozak vozi
  const before = sent().length;
  h.call('(() => { const b = new ArrayBuffer(21); new DataView(b).setUint8(0, 16); FakeWS.last.__clientSend = true; window.__AGARAI_WS.send(b); })()');
  assert.equal(sent().length, before, 'klijentov op16 mora biti filtriran');
  // tim kanal: objavio sam svoju poziciju
  const posts = JSON.parse(h.call('JSON.stringify(__bc[0].sent)'));
  assert.ok(posts.some((m) => m.i === 0 && Math.round(m.x) === 100));
  const stt = JSON.parse(h.call('JSON.stringify(window.__AGARAI.status())'));
  assert.equal(stt.brain, true);
  assert.equal(stt.spawned, true);
});

test('--pingpong: kralj split-ubija samo kad je partner pored da pokupi delove', () => {
  const me = meAt(0, 0, 300);                                      // masa 900
  const prey = [{ id: 2, x: 500, y: 0, size: 120, name: 'plen' }];
  const PP = { ...CFG, pingPong: true };
  const far = meAt(5000, 0, 120);                                  // daleko -> nema partnera
  assert.ok(!decide({ index: 0 }, st(me, prey), ctx({ cfg: PP, teamCenters: [me, far, null] })).split);
  const near = meAt(-600, 0, 120);                                 // ceo, 16% mase, blizu -> partner
  const d = decide({ index: 0 }, st(me, prey), ctx({ cfg: PP, teamCenters: [me, near, null] }));
  assert.equal(d.note, 'SPLIT-KILL');
  const giving = { ...near, giving: true };                        // upravo mi daje -> ne razbijam se
  assert.ok(!decide({ index: 0 }, st(me, prey), ctx({ cfg: PP, teamCenters: [me, giving, null] })).split);
  // faza "daj sve" (--no-pingpong): kralj lovi slobodno i bez partnera
  assert.equal(decide({ index: 0 }, st(me, prey), ctx({ cfg: { ...CFG, pingPong: false }, teamCenters: [me, far, null] })).note, 'SPLIT-KILL');
});

test('faze: dok je tim mali - daj sve; kad kralj naraste - ping-pong sa ostatkom za krupnu hranu', () => {
  const small = meAt(0, 0, 100);                       // kralj 100 mase < pingPongAt 200
  const me = meAt(500, 0, 110);                        // 121 mase
  const b1 = { index: 1 };
  decide(b1, st(me, []), ctx({ teamCenters: [small, me, null] }));
  assert.equal(b1._giving, true);
  assert.equal(b1._keep, 0, 'faza 1: daje sve');
  const big = meAt(0, 0, 200);                         // kralj 400 mase >= 200 -> ping-pong
  const me2 = meAt(800, 0, 140);                       // 196 mase
  const b2 = { index: 1 };
  decide(b2, st(me2, []), ctx({ teamCenters: [big, me2, null] }));
  assert.equal(b2._giving, true);
  assert.ok(b2._keep >= 60, `faza 2: zadrzi ostatak za krupnu hranu, keep=${b2._keep}`);
});

const SM = { ...CFG, escapeSplit: true, travelSplit: true, pingPong: false };
test('split za kretanje (--escapeSplit): beg splitom kad je pretnja na korak, ali ne u virus', () => {
  const me = meAt(0, 0, 150);
  const T = [{ id: 2, x: 420, y: 0, size: 300, name: 'BIG' }];      // razmak ivica 420-300-150 = -30
  const bot = { index: 0 };
  const d = decide(bot, st(me, T), ctx({ cfg: SM, teamCenters: [me, null, null] }));
  assert.equal(d.note, 'BEG split');
  assert.equal(d.split, true);
  assert.ok(d.dir[0] < -0.99, 'split u smeru bekstva');
  // virus na putu bekstva, a moj deo posle splita bi na njemu pukao -> bez skoka
  const big = meAt(0, 0, 250);                                    // deo ~177 > virus*1.15
  const T2 = [{ id: 2, x: 600, y: 0, size: 450, name: 'BIG' }];
  const d2 = decide({ index: 0 }, st(big, [...T2, { id: 9, x: -400, y: 0, size: 100, isVirus: true }]), ctx({ cfg: SM, teamCenters: [big, null, null] }));
  assert.ok(!d2.split, d2.note);
  // bez virusa isti bot skace
  assert.equal(decide({ index: 0 }, st(big, T2), ctx({ cfg: SM, teamCenters: [big, null, null] })).note, 'BEG split');
  // pretnja jos daleko -> samo bezi, bez splita
  const d3 = decide({ index: 0 }, st(me, [{ id: 2, x: 800, y: 0, size: 300, name: 'BIG' }]), ctx({ cfg: SM, teamCenters: [me, null, null] }));
  assert.equal(d3.note, 'bezim od pretnje');
});

test('split za kretanje (--travelSplit): davalac daleko od primaoca split-uje ka njemu (brze stize)', () => {
  const king = meAt(0, 0, 300);
  const me = meAt(3000, 0, 100);                               // daleko, daje sve
  const d = decide({ index: 1 }, st(me, []), ctx({ cfg: SM, teamCenters: [king, me, null] }));
  assert.equal(d.note, 'BRZO ka kralju (split)');
  assert.ok(d.dir[0] < -0.99);
  // pretnja u blizini -> bez travel splita (razbijen bi bio lak plen)
  const d2 = decide({ index: 1 }, st(me, [{ id: 3, x: 3000, y: 900, size: 200, name: 'X' }]), ctx({ cfg: SM, teamCenters: [king, me, null] }));
  assert.notEqual(d2.note, 'BRZO ka kralju (split)');
});

test('lov: daleki mali plen -> double/triple/quad split (najmanji broj koji stize)', () => {
  const me = meAt(0, 0, 400);                                      // masa 1600
  const bot = { index: 0 };
  // plen 60 na 1300: 1 split ne stize, 2 stizu (prednji deo 1/4 mase jos jede plen)
  const d = decide(bot, st(me, [{ id: 2, x: 1300, y: 0, size: 60, name: 'plen' }]), ctx({ teamCenters: [me, null, null] }));
  assert.equal(d.note, 'SPLIT-KILL x2');
  assert.equal(d.split, true);
  // sledeci tik: drugi split odmah (burst), bez cekanja cooldown-a
  const d2 = decide(bot, st({ ...me, cellCount: 2 }, []), ctx({ teamCenters: [me, null, null], now: 1040 }));
  assert.equal(d2.split, true);
  assert.equal(d2.note, 'SPLIT-KILL x2');
  // jos dalje (2300) -> quad
  const d3 = decide({ index: 0 }, st(me, [{ id: 3, x: 2300, y: 0, size: 60, name: 'plen' }]), ctx({ teamCenters: [me, null, null] }));
  assert.equal(d3.note, 'SPLIT-KILL x4');
});

test('nosilac: razbijen koji jos lovi zadrzava krunu; kad nema plena -> najblizi iz pratnje', () => {
  const frag = { x: 0, y: 0, size: 500, maxCell: 300, cellCount: 4, mass: 2500 };
  const near = { x: 400, y: 0, size: 200, maxCell: 200, cellCount: 1, mass: 400 };
  const far = { x: 3000, y: 0, size: 250, maxCell: 250, cellCount: 1, mass: 625 };
  const cfgA = { king: 'auto', recvMinFrac: 0.1, pingPong: true };
  assert.equal(pickKing(cfgA, [{ ...frag, hunting: true }, near, far], 0), 0, 'jos lovi -> ostaje nosilac');
  assert.equal(pickKing(cfgA, [frag, near, far], 0), 1, 'nema plena -> najblizi ceo iz pratnje');
});

test('pratnja: drzi mesto iza-levo/iza-desno od nosioca i jede hranu oko sebe', () => {
  const king = { ...meAt(0, 0, 300), hx: 1, hy: 0 };               // nosilac ide desno
  const me = meAt(-200, -900, 100);
  const d = decide({ index: 1, _giveDoneAt: 900 }, st(me, []), ctx({ cfg: { ...CFG, pingPong: true }, teamCenters: [king, me, null], slot: 0 }));
  assert.equal(d.note, 'pratnja (formacija)');
  assert.ok(d.aim.x < 0, 'mesto je IZA nosioca');
  // na svom mestu, hrana pored -> jede
  const R = 300 + 100 + 180, a = 140 * Math.PI / 180;
  const sx = Math.cos(a) * R, sy = Math.sin(a) * R;
  const me2 = meAt(sx, sy, 100);
  const d2 = decide({ index: 1, _giveDoneAt: 900 }, st(me2, [{ id: 5, x: sx + 80, y: sy, size: 40, isFood: true }]), ctx({ cfg: { ...CFG, pingPong: true }, teamCenters: [king, me2, null], slot: 0 }));
  assert.equal(d2.note, 'pratnja jede');
});

test('odlucnost: obicna odluka se drzi commitMs, bekstvo je prekida odmah', () => {
  const me = meAt(0, 0, 100);
  const bot = { index: 0 };
  const c = (now, ents) => decide(bot, st(me, ents), ctx({ teamCenters: [me, null, null], now }));
  const a = c(1000, [{ id: 5, x: 200, y: 0, size: 20, isFood: true }]);
  assert.equal(a.note, 'kralj jede');
  const b = c(1100, []);                                           // hrana nestala -> i dalje drzi nameru
  assert.equal(b.note, 'kralj jede');
  const f = c(1200, [{ id: 7, x: 260, y: 0, size: 300, name: 'BIG' }]);
  assert.ok(/bezim|BEG/.test(f.note), 'bekstvo prekida odmah');
});

test('faza 2: respawn-ovan mali bot se NE ubija u nosioca - ide do njega i postaje pratnja', () => {
  const king = { ...meAt(0, 0, 500), hx: 1, hy: 0 };               // nosilac 2500 mase -> faza 2
  const fresh = meAt(4000, 0, 63);                                 // tek respawn-ovan, daleko
  const b = { index: 1 };
  const d = decide(b, st(fresh, []), ctx({ teamCenters: [king, fresh, null] }));
  assert.equal(d.note, 'idem ka kralju');
  assert.ok(!b._giving, 'ne daje sve');
  const near = meAt(-700, 300, 63);                                // stigao blizu -> formacija
  const d2 = decide({ index: 1 }, st(near, []), ctx({ teamCenters: [king, near, null], slot: 0 }));
  assert.ok(/pratnja/.test(d2.note), d2.note);
});

test('faza 2: razbijen bot daje visak ODMAH, bez pauze', () => {
  const king = meAt(0, 0, 300);                                    // 900 mase
  const frag = { ...meAt(600, 0, 400, 4), maxCell: 200 };          // 1600 mase razbijen
  const b = { index: 1, _giveDoneAt: 990 };                        // upravo je dao (pauza bi blokirala)
  const d = decide(b, st(frag, []), ctx({ teamCenters: [king, frag, null], now: 1000 }));
  assert.equal(b._giving, true);
  assert.ok(/DAJEM/.test(d.note), d.note);
});
