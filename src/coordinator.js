// Glavna petlja: cita stanje sva tri bota, spaja u jednu mapu, bira
// kralja, odlucuje po botu i salje komande. Takodje crta mapu okruzenja.

import { decide, pickKing } from './strategy.js';
import { mergeWorld, renderMap, drawScreen } from './map.js';
import { sleep, botGetState, botCommand, botRejoin, botStatus } from './browser.js';

// Heuristika: da li dekodirano stanje izgleda ispravno (pozicije unutar
// granica mape). Ako ne, protokol agar.rs verovatno odstupa od dekodera.
function looksSane(st) {
  if (!st || !st.me || !st.mapBounds) return null;
  const b = st.mapBounds;
  const pad = 2000;
  const inb = (p) => p.x > b.minx - pad && p.x < b.maxx + pad && p.y > b.miny - pad && p.y < b.maxy + pad;
  if (!inb(st.me)) return false;
  const ents = st.entities.slice(0, 40);
  if (!ents.length) return true;
  const good = ents.filter(inb).length / ents.length;
  return good > 0.6;
}

// Jednokratni dijagnosticki ispis razlozenog stanja (za stelovanje pragova).
function printDiag(states, log) {
  for (let i = 0; i < states.length; i++) {
    const st = states[i];
    if (!st || !st.spawned || !st.me) continue;
    const ents = st.entities;
    const sizes = ents.map((e) => e.size).sort((a, b) => a - b);
    const med = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
    const food = ents.filter((e) => e.isFood).length;
    const virus = ents.filter((e) => e.isVirus).length;
    const eject = ents.filter((e) => e.isEjected).length;
    const named = ents.filter((e) => e.name).length;
    const small = ents.filter((e) => !e.isVirus && !e.name).slice(0, 5)
      .map((e) => `${e.size}@(${Math.round(e.x)},${Math.round(e.y)})`);
    log('===== DIAG (tab ' + i + ') =====');
    log(`  mapBounds: ${JSON.stringify(st.mapBounds)}`);
    log(`  me: size=${Math.round(st.me.size)} mass=${Math.round(st.me.mass)} @(${Math.round(st.me.x)},${Math.round(st.me.y)})`);
    log(`  entities=${ents.length}  velicine[min/med/max]=${sizes[0]||0}/${med}/${sizes[sizes.length-1]||0}`);
    log(`  flag-klasifikacija: isFood=${food} isVirus=${virus} isEjected=${eject} named=${named}`);
    log(`  uzorak sitnih (size@xy): ${small.join('  ')}`);
    log('=============================');
    return true;
  }
  return false;
}

// --brain page (default): mozak je u stranicama; Node samo nadgleda,
// crta mapu/status i, ako respawn iz stranice ne uspe, klikne Play.
async function runMonitor(fleet, cfg, log) {
  const { bots } = fleet;
  let tick = 0;
  for (;;) {
    tick++;
    const now = Date.now();
    const sts = await Promise.all(bots.map((b) => botStatus(b)));
    sts.forEach((s, i) => {
      const b = bots[i];
      if (s && s.spawned) { b._deadSince = 0; return; }
      if (!b._deadSince) b._deadSince = now;
      // stranica sama salje nick posle smrti; ako posle 5s i dalje nismo u
      // igri (npr. klon trazi klik u meniju), klikni Play kao rezervu
      if (now - b._deadSince > 5000 && (!b._lastRejoin || now - b._lastRejoin > 4000)) {
        b._lastRejoin = now;
        botRejoin(b, cfg).catch(() => {});
      }
    });
    // tabovi moraju da se vide (tim=N); ako ne, igraju svaki za sebe
    const aliveN = sts.filter((s) => s && s.spawned).length;
    const blind = sts.some((s) => s && s.spawned && aliveN > 1 && s.teamSeen < aliveN - 1);
    if (blind) { if (!fleet._blindSince) fleet._blindSince = now; } else fleet._blindSince = 0;
    if (fleet._blindSince && now - fleet._blindSince > 3000 && (!fleet._blindWarn || now - fleet._blindWarn > 10000)) {
      fleet._blindWarn = now;
      log('UPOZORENJE: tabovi se ne vide (tim=' + sts.map((s) => (s ? s.teamSeen : '-')).join('/') + ') - igraju svaki za sebe. Javi mi ovo.');
    }
    const line = sts.map((s, i) => {
      const nick = bots[i].nick;
      if (!s) return `${nick}: (nema statusa)`;
      const crown = s.king === i ? '@' : '';
      return `${crown}${nick}: ${s.spawned ? `${s.mass} (${s.cells}d)` : 'mrtav'} [${s.note}] ${s.dps}/s tim=${s.teamSeen}`;
    }).join('  |  ');
    if (cfg.map && tick % 2 === 0) {
      const states = await Promise.all(bots.map((b) => botGetState(b)));
      const world = mergeWorld(states);
      const k = (sts.find((s) => s && s.spawned) || {}).king ?? 0;
      drawScreen(renderMap(world, cfg, { kingIndex: k, kingCenter: world.teamCenters[k] || null, tick, notes: line }));
    } else if (!cfg.map && tick % 4 === 0) {
      log(line);
    }
    // za simulator/dijagnostiku: masinski citljiv status
    if (cfg.jitterLog && tick % 4 === 0) {
      sts.forEach((s, i) => { if (s) log(`STAT ${bots[i].nick} ${JSON.stringify({ note: s.note, flips: s.flips, rapid: s.rapidFlips, causes: s.flipCauses, dps: s.dps })}`); });
    }
    await sleep(cfg.statusMs || 500);
  }
}

export async function runCoordinator(fleet, cfg, log) {
  if (cfg.brain === 'page' && cfg.team) return runMonitor(fleet, cfg, log);
  const { bots } = fleet;
  let tick = 0;
  let running = true;
  let protocolWarned = false;
  let diagDone = false;
  let prevKing = null;
  const stop = () => { running = false; };

  while (running) {
    tick++;
    // 1) Skupi stanje svih botova paralelno (kroz pravi frame, iframe-safe).
    const states = await Promise.all(bots.map((b) => botGetState(b)));
    states.forEach((st, i) => { bots[i].lastState = st; });

    // Jednokratni --diag ispis.
    if (cfg.diag && !diagDone) {
      diagDone = printDiag(states, log);
    }

    // Jednokratna dijagnostika protokola.
    if (!protocolWarned) {
      for (const st of states) {
        const sane = looksSane(st);
        if (sane === false) {
          protocolWarned = true;
          log('UPOZORENJE: dekodirane pozicije izgledaju netacno - protokol agar.rs verovatno odstupa.');
          log('  Pokreni: node src/index.js --no-team --capture, udji u igru par sekundi, Ctrl+C,');
          log('  pa mi posalji captures/tab0-*.json da prilagodim dekoder u src/inject/agarhook.js.');
          break;
        }
        if (sane === true) { protocolWarned = true; log('protokol OK: dekodiranje izgleda ispravno.'); break; }
      }
    }

    // 2) Spoji svet i izaberi kralja (uz histerezu preko prethodnog).
    const world = mergeWorld(states);
    const kingIndex = pickKing(cfg, world.teamCenters, prevKing);
    prevKing = kingIndex;
    const kingCenter = world.teamCenters[kingIndex] || null;
    const ctx = {
      cfg, kingIndex, teamCenters: world.teamCenters, now: Date.now(),
      teamNicks: bots.map((b) => b.nick),          // saigrace prepoznajemo po imenu
    };

    // 3) Odluci i posalji komandu svakom botu (osim ako je --no-team,
    //    onda samo posmatramo i crtamo mapu).
    const notes = [];
    if (cfg.team) {
      const now = Date.now();
      await Promise.all(bots.map(async (b, i) => {
        const st = states[i];
        // Mrtav / nije jos u igri -> pokusaj respawn (usporeno da ne spamuje).
        if (!st || !st.spawned) {
          b._prevAlive = false;                       // posle respawna nov pravac nije jitter
          if (!b._lastRejoin || now - b._lastRejoin > 2500) {
            b._lastRejoin = now;
            notes.push(`${b.nick}:RESPAWN`);
            await botRejoin(b, cfg).catch(() => {});
          } else {
            notes.push(`${b.nick}:cekam spawn`);
          }
          return;
        }
        const cmd = decide(b, st, ctx);
        notes.push(`${b.nick}:${cmd.note || '-'}`);
        // --jitterLog: zabelezi svaki okret > 100 stepeni i koja ga promena odluke izaziva
        if (cfg.jitterLog && cmd.dir && b._prevDir && b._prevAlive) {
          const c = cmd.dir[0] * b._prevDir[0] + cmd.dir[1] * b._prevDir[1];
          if (c < -0.17) {
            const dt = b._lastFlipAt ? now - b._lastFlipAt : 99999;
            b._lastFlipAt = now;
            log(`JITTER ${b.nick}: ${b._prevNote} -> ${cmd.note} | dt=${dt}`);
          }
        }
        b._prevDir = cmd.dir || b._prevDir; b._prevNote = cmd.note; b._prevAlive = true;
        await botCommand(b, cmd);
      }));
    } else {
      states.forEach((st, i) => notes.push(`${bots[i].nick}:${st && st.spawned ? 'ziv' : 'cekam'}`));
    }

    // 4) Nacrtaj mapu.
    if (cfg.map) {
      const text = renderMap(world, cfg, { kingIndex, kingCenter, tick, notes: notes.join('  ') });
      drawScreen(text);
    } else if (tick % 20 === 0) {
      log(`tik ${tick}  kralj=${kingIndex}  ${notes.join('  ')}`);
    }

    await sleep(cfg.tickMs);
  }
  return stop;
}
