// Glavna petlja: cita stanje sva tri bota, spaja u jednu mapu, bira
// kralja, odlucuje po botu i salje komande. Takodje crta mapu okruzenja.

import { decide, pickKing } from './strategy.js';
import { mergeWorld, renderMap, drawScreen } from './map.js';
import { sleep, botGetState, botCommand } from './browser.js';

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

export async function runCoordinator(fleet, cfg, log) {
  const { bots } = fleet;
  let tick = 0;
  let running = true;
  let protocolWarned = false;
  const stop = () => { running = false; };

  while (running) {
    tick++;
    // 1) Skupi stanje svih botova paralelno (kroz pravi frame, iframe-safe).
    const states = await Promise.all(bots.map((b) => botGetState(b)));
    states.forEach((st, i) => { bots[i].lastState = st; });

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

    // 2) Spoji svet i izaberi kralja.
    const world = mergeWorld(states);
    const kingIndex = pickKing(cfg, world.teamCenters);
    const kingCenter = world.teamCenters[kingIndex] || null;
    const ctx = { cfg, kingIndex, teamCenters: world.teamCenters };

    // 3) Odluci i posalji komandu svakom botu (osim ako je --no-team,
    //    onda samo posmatramo i crtamo mapu).
    const notes = [];
    if (cfg.team) {
      await Promise.all(bots.map(async (b, i) => {
        const cmd = decide(b, states[i], ctx);
        notes.push(`${b.nick}:${cmd.note || '-'}`);
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
