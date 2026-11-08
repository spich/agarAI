// Lokalni "mini agar.rs" server za testiranje botova.
// Govori ISTI protokol kao srv*.agar.rs (MultiOgar-Edited, protokol 4),
// rekonstruisan iz --sniff hexa:
//   server->klijent: 64 granica (4x f64), 18 ClearAll, 32 AddNode (u32),
//     16 Update: u16 eatCount {u32 hunter,u32 prey} | nodes {u32 id,i16 x,i16 y,
//     u16 size,u8 r,g,b,u8 flags,utf16z ime} | u32 0 | u32 removeCount {u32 id}
//   klijent->server: 254/255 handshake, 0 nick(utf16), 1 spectate,
//     16 mis (f64 x, f64 y, u32), 17 split, 21 eject (W)
// Fizika je pojednostavljena (po uzoru na MultiOgar): brzina ~ size^-0.439,
// jedenje pri 1.3x masi, split/eject sa "boost"-om, virus te razbije ako si
// veci, sopstvene celije se spajaju posle merge vremena.
// Server meri ponasanje svakog bota (metrike) za izvestaj.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sizeOf = (mass) => Math.sqrt(mass * 100);
// Seed-ovan RNG: isti --seed = isti pocetni svet (fer poredjenje verzija).
let RAND = Math.random;
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = (a, b) => a + RAND() * (b - a);

export async function startServer(opts = {}) {
  const C = {
    half: 3000,            // mapa je [-half, half]^2
    food: 260,             // agar.rs: hrana je krupna (size ~45-63) - kao novi igrac
    foodMass: [20, 40],
    viruses: 14,
    enemies: [900, 420, 160, 110, 70, 60],  // pocetne mase AI protivnika
    tickMs: 40,
    mergeSec: 9,           // vreme do spajanja sopstvenih celija
    startMass: 40,         // ~ size 63, kao novi igrac
    teamPrefix: 'tripleX',
    ...opts,
  };
  RAND = C.seed != null ? mulberry32(Number(C.seed)) : Math.random;

  let nextId = 1000;
  const nodes = new Map();            // id -> node
  const owners = new Set();           // svi igraci (klijenti + AI)
  const T0 = Date.now();
  const now = () => Date.now();

  // ------------------------------------------------------------ entiteti
  function addNode(n) { n.id = nextId++; n.born = now(); nodes.set(n.id, n); return n; }
  function randomPos(margin = 50) { return { x: rnd(-C.half + margin, C.half - margin), y: rnd(-C.half + margin, C.half - margin) }; }
  function spawnFood() {
    const p = randomPos();
    addNode({ type: 'food', ...p, mass: rnd(C.foodMass[0], C.foodMass[1]), color: [rnd(60, 255) | 0, rnd(60, 255) | 0, rnd(60, 255) | 0] });
  }
  function spawnVirus() {
    let p;
    for (let k = 0; k < 20; k++) {
      p = randomPos(300);
      let ok = true;
      for (const n of nodes.values()) if (n.type === 'player' && Math.hypot(n.x - p.x, n.y - p.y) < n.size + 200) { ok = false; break; }
      if (ok) break;
    }
    addNode({ type: 'virus', ...p, mass: 100, color: [51, 255, 51] });
  }
  for (let i = 0; i < C.food; i++) spawnFood();
  for (let i = 0; i < C.viruses; i++) spawnVirus();

  function makeOwner(name, isAI) {
    const o = {
      name, isAI, cells: new Set(), mouse: { x: 0, y: 0 }, lastCenter: { x: 0, y: 0 },
      color: [rnd(40, 255) | 0, rnd(40, 255) | 0, rnd(40, 255) | 0],
      isTeam: !isAI && name.startsWith(C.teamPrefix),
      stats: {
        spawns: 0, deaths: 0, deathsByTeam: 0, deathsByEnemy: 0, maxMass: 0, massSamples: [],
        splitCmds: 0, doubleSplits: 0, ejects: 0, virusPops: 0, foodEaten: 0,
        massFromTeam: 0, massToTeam: 0, enemyKills: 0, enemyMassEaten: 0, moveMsgs: 0, dirFlips: 0, aliveMs: 0,
        bigEnemyNearMs: 0, minDistBigEnemy: Infinity,
      },
      _lastSplitAt: 0, _lastDir: null, _splitCd: 0, _wander: null, _wanderUntil: 0, _respawnAt: 0,
    };
    owners.add(o);
    return o;
  }
  function spawnCell(o, mass) {
    let p;
    for (let k = 0; k < 30; k++) {            // ne spawnuj u usta velikom igracu
      p = randomPos(200);
      let ok = true;
      for (const n of nodes.values()) if (n.type === 'player' && n.mass > mass * 1.3 && Math.hypot(n.x - p.x, n.y - p.y) < n.size + 400) { ok = false; break; }
      if (ok) break;
    }
    const c = addNode({ type: 'player', ...p, mass, owner: o, color: o.color });
    o.cells.add(c.id);
    o.stats.spawns++;
    return c;
  }
  function totalMass(o) { let m = 0; for (const id of o.cells) m += nodes.get(id)?.mass || 0; return m; }
  function centerOf(o) {
    let sx = 0, sy = 0, sm = 0;
    for (const id of o.cells) { const c = nodes.get(id); if (!c) continue; sx += c.x * c.mass; sy += c.y * c.mass; sm += c.mass; }
    return sm ? { x: sx / sm, y: sy / sm, mass: sm } : null;
  }

  // AI protivnici
  const ais = C.enemies.map((m, i) => { const o = makeOwner(['Gazda', 'Pirana', 'Lovac', 'Mrvica', 'Zujo', 'Bobi'][i] || `AI${i}`, true); o._startMass = m; spawnCell(o, m); return o; });

  // ------------------------------------------------------------ akcije
  function doSplit(o, origin) {
    const list = [...o.cells].map((id) => nodes.get(id)).filter(Boolean);
    let did = 0;
    for (const c of list) {
      if (o.cells.size >= 16) break;
      if (c.mass < 36) continue;
      const half = c.mass / 2;
      c.mass = half;
      const a = Math.atan2(o.mouse.y - c.y, o.mouse.x - c.x);
      const n = addNode({ type: 'player', x: c.x, y: c.y, mass: half, owner: o, color: o.color });
      n.boost = { dx: Math.cos(a), dy: Math.sin(a), d: 780 };
      c.born = now();
      o.cells.add(n.id);
      sendOwned(o, n.id);
      did++;
    }
    if (did && origin === 'cmd') o.stats.splitCmds++;
    return did;
  }
  function doEject(o) {
    for (const id of o.cells) {
      const c = nodes.get(id);
      if (!c || c.mass < 35) continue;
      c.mass -= 18;
      const a = Math.atan2(o.mouse.y - c.y, o.mouse.x - c.x);
      const e = addNode({ type: 'eject', x: c.x + Math.cos(a) * c.size, y: c.y + Math.sin(a) * c.size, mass: 13, color: o.color, from: o });
      e.boost = { dx: Math.cos(a), dy: Math.sin(a), d: 700 };
      o.stats.ejects++;
    }
  }
  function popOnVirus(o, c) {
    const free = 16 - o.cells.size;
    const pieces = Math.min(free, 15);
    o.stats.virusPops++;
    if (pieces <= 0) return;
    const each = c.mass / (pieces + 1);
    c.mass = each;
    for (let i = 0; i < pieces; i++) {
      const a = (i / pieces) * Math.PI * 2;
      const n = addNode({ type: 'player', x: c.x, y: c.y, mass: each, owner: o, color: o.color });
      n.boost = { dx: Math.cos(a), dy: Math.sin(a), d: 420 };
      o.cells.add(n.id);
      sendOwned(o, n.id);
    }
    c.born = now();
  }

  // ------------------------------------------------------------ AI mozak
  function aiThink(o) {
    if (!o.cells.size) {
      if (!o._respawnAt) o._respawnAt = now() + 2500;
      if (now() >= o._respawnAt) { o._respawnAt = 0; spawnCell(o, o._startMass * rnd(0.6, 1.1)); }
      return;
    }
    let big = null;
    for (const id of o.cells) { const c = nodes.get(id); if (c && (!big || c.mass > big.mass)) big = c; }
    if (!big) return;
    let threat = null, td = Infinity, prey = null, pd = Infinity, food = null, fd = Infinity;
    for (const n of nodes.values()) {
      const d = Math.hypot(n.x - big.x, n.y - big.y);
      if (n.type === 'player' && n.owner !== o) {
        if (n.mass > big.mass * 1.3 && d < 650 && d < td) { threat = n; td = d; }
        else if (n.mass * 1.3 < big.mass && d < 800 && d < pd) { prey = n; pd = d; }
      } else if ((n.type === 'food' || n.type === 'eject') && d < 700 && d < fd) { food = n; fd = d; }
    }
    if (threat) {
      const a = Math.atan2(big.y - threat.y, big.x - threat.x);
      o.mouse = { x: big.x + Math.cos(a) * 800, y: big.y + Math.sin(a) * 800 };
    } else if (prey) {
      o.mouse = { x: prey.x, y: prey.y };
      if (prey.mass * 2.6 < big.mass && pd < 430 && now() > o._splitCd && o.cells.size < 4) { o._splitCd = now() + 6000; doSplit(o, 'ai'); }
    } else if (food) {
      o.mouse = { x: food.x, y: food.y };
    } else {
      if (!o._wander || now() > o._wanderUntil) { o._wander = randomPos(300); o._wanderUntil = now() + 4000; }
      o.mouse = o._wander;
    }
    // AI ne sme beskonacno da raste (da test ostane dinamican)
    for (const id of o.cells) { const c = nodes.get(id); if (c && c.mass > 1400) c.mass *= 0.999; }
  }

  // ------------------------------------------------------------ fizika
  function speedOf(size) { return 2.2 * Math.pow(size, -0.439) * 40; }   // jedinica po tiku (MultiOgar)
  function physics() {
    const t = now();
    for (const n of nodes.values()) n.size = sizeOf(n.mass);
    // kretanje igracih celija ka misu vlasnika
    for (const o of owners) {
      for (const id of o.cells) {
        const c = nodes.get(id);
        if (!c) continue;
        const dx = o.mouse.x - c.x, dy = o.mouse.y - c.y, d = Math.hypot(dx, dy);
        if (d > 1) { const s = Math.min(d, speedOf(c.size)); c.x += dx / d * s; c.y += dy / d * s; }
      }
    }
    // boost (split/eject/pop)
    for (const n of nodes.values()) {
      if (!n.boost) continue;
      const step = n.boost.d / 9;
      n.x += n.boost.dx * step; n.y += n.boost.dy * step;
      n.boost.d -= step;
      if (n.boost.d < 2) n.boost = null;
    }
    // sopstvene celije: guraj se dok ne istekne merge, onda spoji
    for (const o of owners) {
      const list = [...o.cells].map((id) => nodes.get(id)).filter(Boolean);
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (!nodes.has(a.id) || !nodes.has(b.id)) continue;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01;
        const mergeT = (C.mergeSec + 0.01 * (a.mass + b.mass)) * 1000;
        const canMerge = t - a.born > mergeT && t - b.born > mergeT;
        if (canMerge) {
          if (d < Math.max(a.size, b.size) - Math.min(a.size, b.size) * 0.35) {
            const [big, small] = a.mass >= b.mass ? [a, b] : [b, a];
            big.mass += small.mass; nodes.delete(small.id); o.cells.delete(small.id);
            pendingEats.push({ hunter: big.id, prey: small.id });
          }
        } else if (t - a.born > 600 && t - b.born > 600) {
          const ov = a.size + b.size - d;
          if (ov > 0) { const push = ov / 2; a.x -= dx / d * push * 0.5; a.y -= dy / d * push * 0.5; b.x += dx / d * push * 0.5; b.y += dy / d * push * 0.5; }
        }
      }
    }
    // granice mape
    for (const n of nodes.values()) {
      n.x = Math.max(-C.half, Math.min(C.half, n.x));
      n.y = Math.max(-C.half, Math.min(C.half, n.y));
    }
    // jedenje
    const players = [...nodes.values()].filter((n) => n.type === 'player');
    for (const a of players) {
      if (!nodes.has(a.id)) continue;
      for (const b of nodes.values()) {
        if (b === a || !nodes.has(a.id)) continue;
        if (b.type === 'player' && b.owner === a.owner) continue;
        if (b.type === 'eject' && b.from === a.owner && t - b.born < 600) continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > a.size) continue;
        if (b.type === 'virus') {
          if (a.mass > b.mass * 1.33 && d < a.size - b.size * 0.4) {
            a.mass += b.mass; nodes.delete(b.id); pendingEats.push({ hunter: a.id, prey: b.id });
            popOnVirus(a.owner, a); spawnVirus();
          }
          continue;
        }
        if (a.mass > b.mass * 1.3 && d < a.size - b.size * 0.4) {
          a.mass += b.mass;
          nodes.delete(b.id);
          pendingEats.push({ hunter: a.id, prey: b.id });
          const ao = a.owner;
          if (b.type === 'food') { ao.stats.foodEaten++; spawnFood(); }
          else if (b.type === 'eject') {
            if (b.from && b.from !== ao && b.from.isTeam && ao.isTeam) { ao.stats.massFromTeam += b.mass; b.from.stats.massToTeam += b.mass; }
          } else if (b.type === 'player') {
            const bo = b.owner;
            bo.cells.delete(b.id);
            if (bo.isTeam && ao.isTeam) { ao.stats.massFromTeam += b.mass; bo.stats.massToTeam += b.mass; }
            if (ao.isTeam && !bo.isTeam) ao.stats.enemyMassEaten += b.mass;
            if (!bo.cells.size) {
              bo.stats.deaths++;
              if (bo.isTeam && ao.isTeam) bo.stats.deathsByTeam++;
              else bo.stats.deathsByEnemy++;
              if (ao.isTeam && !bo.isTeam) ao.stats.enemyKills++;
            }
          }
        }
      }
    }
    // izbacena masa nestaje posle nekog vremena (da se ne nagomilava)
    for (const n of nodes.values()) if (n.type === 'eject' && t - n.born > 20000) { nodes.delete(n.id); }
    // lagani raspad velike mase
    for (const n of players) if (nodes.has(n.id) && n.mass > 150) n.mass *= 0.99996;
  }

  // ------------------------------------------------------------ mreza
  let pendingEats = [];
  const clients = new Set();

  function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
  function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
  function f64(n) { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b; }
  function i16(n) { const b = Buffer.alloc(2); b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(n)))); return b; }
  function utf16z(s) { const b = Buffer.alloc(s.length * 2 + 2); for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), i * 2); return b; }
  function send(ws, buf) { if (ws.readyState === 1) ws.send(buf); }
  function sendOwned(o, id) { if (o.ws) send(o.ws, Buffer.concat([Buffer.from([32]), u32(id)])); }
  function sendBorder(ws) { send(ws, Buffer.concat([Buffer.from([64]), f64(-C.half), f64(-C.half), f64(C.half), f64(C.half)])); }

  function viewOf(cl) {
    if (cl.spectator) return null;                       // ceo svet
    const o = cl.owner;
    const c = centerOf(o) || o.lastCenter;
    if (centerOf(o)) o.lastCenter = c;
    const total = Math.sqrt(totalMass(o) * 100) || 63;
    const scale = Math.pow(Math.min(64 / total, 1), 0.4);
    return { x: c.x, y: c.y, hw: 650 / scale, hh: 470 / scale };
  }
  // Kao pravi MultiOgar-Edited (potvrdjeno iz agar.rs sniff-a): ime se salje
  // SAMO kad celija prvi put udje u vidokrug klijenta; u svakom sledecem
  // update-u iste celije ime je prazno (0x0000).
  function nodeBytes(n, withName) {
    const flags = n.type === 'virus' ? 0x01 : (n.type === 'eject' ? 0x20 : 0);
    const name = withName && n.type === 'player' ? n.owner.name : '';
    return Buffer.concat([u32(n.id), i16(n.x), i16(n.y), u16(Math.round(n.size)), Buffer.from(n.color), Buffer.from([flags]), utf16z(name)]);
  }
  function sendUpdates(eats) {
    for (const cl of clients) {
      const v = viewOf(cl);
      const vis = new Set();
      const parts = [];
      for (const n of nodes.values()) {
        if (v && (Math.abs(n.x - v.x) > v.hw + n.size || Math.abs(n.y - v.y) > v.hh + n.size)) continue;
        vis.add(n.id); parts.push(nodeBytes(n, !cl.lastVis.has(n.id)));
      }
      const eatList = eats.filter((e) => cl.lastVis.has(e.prey) || vis.has(e.hunter));
      const eatenSet = new Set(eatList.map((e) => e.prey));
      const removes = [...cl.lastVis].filter((id) => !vis.has(id) && !eatenSet.has(id));
      const head = [Buffer.from([16]), u16(eatList.length)];
      for (const e of eatList) head.push(u32(e.hunter), u32(e.prey));
      const tail = [u32(0), u32(removes.length), ...removes.map(u32)];
      send(cl.ws, Buffer.concat([...head, ...parts, ...tail]));
      cl.lastVis = vis;
    }
  }

  function onClientMessage(cl, buf) {
    const op = buf[0];
    const o = cl.owner;
    if (op === 0) {                                      // nick / spawn
      let name = '';
      for (let i = 1; i + 1 < buf.length; i += 2) { const c = buf.readUInt16LE(i); if (!c) break; name += String.fromCharCode(c); }
      o.name = name || 'neimenovan';
      o.isTeam = o.name.startsWith(C.teamPrefix);
      if (!o.cells.size) {
        send(cl.ws, Buffer.from([18]));                // ClearAll kao pravi server
        cl.lastVis = new Set();
        sendBorder(cl.ws);
        const c = spawnCell(o, C.startMass);
        sendOwned(o, c.id);
      }
    } else if (op === 1) {
      cl.spectator = true;
    } else if (op === 16 && buf.length >= 17) {
      const x = buf.readDoubleLE(1), y = buf.readDoubleLE(9);
      o.mouse = { x, y };
      o.stats.moveMsgs++;
      // jitter: smer kretanja sada vs pre ~300ms; okret > 100 st. = dogadjaj
      const c = centerOf(o);
      if (c) {
        const dx = x - c.x, dy = y - c.y, L = Math.hypot(dx, dy);
        if (L > 40) {
          const t = now(), dir = [dx / L, dy / L];
          o._dh = o._dh || [];
          o._dh.push({ t, dir });
          while (o._dh.length && t - o._dh[0].t > 300) {
            const old = o._dh.shift();
            if (t - (o._lastFlip || 0) < 300) continue;
            if (dir[0] * old.dir[0] + dir[1] * old.dir[1] < -0.17) { o.stats.dirFlips++; o._lastFlip = t; o._dh.length = 0; break; }
          }
        }
      }
    } else if (op === 17) {
      const t = now();
      if (t - o._lastSplitAt < 35) o.stats.doubleSplits++;   // dva split-a u istom trenutku = dupli taster
      o._lastSplitAt = t;
      doSplit(o, 'cmd');
    } else if (op === 21) {
      doEject(o);
    }
  }

  // ------------------------------------------------------------ HTTP + WS
  const page = fs.readFileSync(path.join(HERE, 'client.html'));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    const cl = { ws, spectator: false, lastVis: new Set(), owner: makeOwner('', false) };
    cl.owner.ws = ws;
    clients.add(cl);
    sendBorder(ws);
    ws.on('message', (data) => onClientMessage(cl, Buffer.from(data)));
    ws.on('close', () => {
      clients.delete(cl);
      for (const id of cl.owner.cells) nodes.delete(id);
      cl.owner.cells.clear();
      cl.owner.ws = null;
    });
  });
  await new Promise((r) => server.listen(opts.port || 0, '127.0.0.1', r));
  const port = server.address().port;

  // ------------------------------------------------------------ petlja
  let lastSample = 0;
  const loop = setInterval(() => {
    for (const o of ais) aiThink(o);
    physics();
    const eats = pendingEats; pendingEats = [];
    sendUpdates(eats);
    const t = now();
    for (const o of owners) {
      if (o.isAI) continue;
      const m = totalMass(o);
      if (o.cells.size) o.stats.aliveMs += C.tickMs;
      o.stats.maxMass = Math.max(o.stats.maxMass, m);
      // blizina velike pretnje (>2x moje najvece celije)
      const c = centerOf(o);
      if (c) {
        let myBig = 0; for (const id of o.cells) myBig = Math.max(myBig, nodes.get(id)?.mass || 0);
        for (const ai of ais) for (const id of ai.cells) {
          const e = nodes.get(id); if (!e || e.mass < myBig * 2) continue;
          const d = Math.hypot(e.x - c.x, e.y - c.y) - e.size;
          o.stats.minDistBigEnemy = Math.min(o.stats.minDistBigEnemy, d);
          if (d < 300) o.stats.bigEnemyNearMs += C.tickMs;
        }
      }
    }
    if (t - lastSample > 1000) {
      lastSample = t;
      for (const o of owners) if (!o.isAI && o.isTeam) o.stats.massSamples.push([Math.round((t - T0) / 1000), Math.round(totalMass(o)), o.cells.size]);
    }
  }, C.tickMs);

  function metrics() {
    const team = [...owners].filter((o) => !o.isAI && o.isTeam).sort((a, b) => a.name.localeCompare(b.name));
    return {
      seconds: Math.round((now() - T0) / 1000),
      bots: team.map((o) => ({ name: o.name, mass: Math.round(totalMass(o)), cells: o.cells.size, ...o.stats })),
      enemies: ais.map((o) => ({ name: o.name, mass: Math.round(totalMass(o)) })),
    };
  }

  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    metrics,
    close: () => new Promise((r) => { clearInterval(loop); wss.close(); server.close(() => r()); for (const c of clients) c.ws.terminate(); }),
  };
}
