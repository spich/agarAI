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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = fs.readFileSync(path.join(ROOT, 'src/inject/agarhook.js'), 'utf8');

// ---------------------------------------------------------------------------
// Pokreni hook u izolovanom "browseru" (vm) sa laznim WebSocket-om i DOM-om.
// Sve se pravi UNUTAR vm realm-a (ArrayBuffer instanceof provera u hook-u).
function loadHook(opt = {}) {
  const ctx = vm.createContext({ console });
  ctx.__opt = opt;
  vm.runInContext(`
    var window = globalThis;
    window.__AGARAI_OPT = __opt;
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
  vm.runInContext(HOOK, ctx);
  const ws = vm.runInContext(`new window.WebSocket('wss://srv3.agar.rs:2087')`, ctx);
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
const CFG = {
  threatRatio: 2.0, virusRatio: 1.0, virusAvoid: 1.15, virusPush: 1.1, fleeFactor: 2.25,
  feedFactor: 9, safeFactor: 1.25, minFeedRatio: 0.15, minSplitSize: 45, kamiReach: 1.7,
  feedMode: 'kamikaze', ejectPerTick: 2, splitCooldownMs: 1600, fleeLatchMs: 450,
  kingSplit: false, kingFeedback: true, feedbackCdMs: 350, foodScope: 10,
};
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
  assert.equal(b.note, 'bezim od pretnje');
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
  assert.equal(d.note, 'bezim od pretnje');
});

test('strategija: kamikaza split JEDNOM pa cooldown; razbijen se ne split-uje vise', () => {
  const king = meAt(0, 0, 500);
  const me = meAt(900, 0, 120);
  const bot = { index: 1 };
  const c = (now, m = me) => decide(bot, st(m, []), ctx({ teamCenters: [king, m, null], now }));
  assert.equal(c(1000).split, true);
  assert.ok(!c(1100).split, 'cooldown');
  const frag = meAt(900, 0, 120, 4);
  const f = decide({ index: 1 }, st(frag, []), ctx({ teamCenters: [king, frag, null], now: 9000 }));
  assert.ok(!f.split);
  assert.equal(f.note, 'ubacujem se u kralja');
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

test('strategija: kralj se ne split-uje u lovu (masa na hrpi)', () => {
  const me = meAt(0, 0, 400);
  const d = decide({ index: 0 }, st(me, [{ id: 2, x: 200, y: 0, size: 100, name: 'plen' }]), ctx({ teamCenters: [me, null, null] }));
  assert.ok(!d.split);
});

test('strategija: flee-latch drzi bekstvo kratko posle nestanka pretnje', () => {
  const king = meAt(8000, 8000, 500);
  const me = meAt(0, 0, 100);
  const bot = { index: 1 };
  const T = [{ id: 2, x: 300, y: 0, size: 300, name: 'BIG' }];
  assert.equal(decide(bot, st(me, T), ctx({ teamCenters: [king, me, null], now: 1000 })).note, 'bezim od pretnje');
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
