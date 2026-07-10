// Glavna petlja: cita stanje sva tri bota, spaja u jednu mapu, bira
// kralja, odlucuje po botu i salje komande. Takodje crta mapu okruzenja.

import { decide, pickKing } from './strategy.js';
import { mergeWorld, renderMap, drawScreen } from './map.js';
import { sleep } from './browser.js';

export async function runCoordinator(fleet, cfg, log) {
  const { bots } = fleet;
  let tick = 0;
  let running = true;
  const stop = () => { running = false; };

  while (running) {
    tick++;
    // 1) Skupi stanje svih botova paralelno.
    const states = await Promise.all(bots.map((b) =>
      b.page.evaluate(() => window.__AGARAI && window.__AGARAI.getState())
        .catch(() => null)
    ));
    states.forEach((st, i) => { bots[i].lastState = st; });

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
        await b.page.evaluate((c) => window.__AGARAI && window.__AGARAI.command(c), cmd)
          .catch(() => {});
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
