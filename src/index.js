#!/usr/bin/env node
// CLI ulaz. Pokreni: node src/index.js [opcije]  (vidi --help)

import fs from 'fs';
import path from 'path';
import { buildConfig, HELP } from './config.js';
import { launchFleet, waitSpawn, botDumpCaptures } from './browser.js';
import { runCoordinator } from './coordinator.js';

function log(...a) { console.log('[agarai]', ...a); }

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  const cfg = buildConfig();
  log('konfiguracija:', JSON.stringify({
    url: cfg.url, count: cfg.count, nicks: cfg.nicks, headless: cfg.headless,
    team: cfg.team, king: cfg.king, control: cfg.control, capture: cfg.capture,
    manualJoin: cfg.manualJoin,
  }));

  const fleet = await launchFleet(cfg, log);

  // Sacekaj spawn (paralelno). Ako ne uspe, nastavljamo svejedno -
  // mozes rucno da udjes u igru, mapa/koordinator ce preuzeti kad ozivi.
  await Promise.all(fleet.bots.map((b) => waitSpawn(b, cfg, log)));
  const spawned = fleet.bots.filter((b) => b.spawned).length;
  log(`spawn: ${spawned}/${fleet.bots.length} botova u igri`);
  if (spawned === 0 && !cfg.manualJoin) {
    log('Nijedan bot nije usao automatski. Verovatno selektori UI-a ne odgovaraju agar.rs.');
    log('Resenje: pokreni sa --manual-join i klikni Play u svakom tabu; koordinator preuzima kad udjes.');
  }

  // Cist izlaz + snimanje capture-a na Ctrl+C.
  let stopping = false;
  const cleanup = async () => {
    if (stopping) return; stopping = true;
    log('gasim...');
    if (cfg.capture) await dumpCaptures(fleet, cfg, log);
    await fleet.browser.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await runCoordinator(fleet, cfg, log);
}

async function dumpCaptures(fleet, cfg, log) {
  try {
    fs.mkdirSync(cfg.captureDir, { recursive: true });
    for (const b of fleet.bots) {
      const caps = await botDumpCaptures(b);
      const file = path.join(cfg.captureDir, `tab${b.index}-${b.nick}.json`);
      fs.writeFileSync(file, JSON.stringify(caps || [], null, 2));
      log(`snimljen capture: ${file} (${(caps || []).length} frejmova)`);
    }
    log('Analiziraj hex frejmove (prvih 64 bajta) da prilagodis dekoder u src/inject/agarhook.js ako mapa nije tacna.');
  } catch (e) {
    log('capture greska:', e.message);
  }
}

main().catch((e) => { console.error('[agarai] fatalna greska:', e); process.exit(1); });
