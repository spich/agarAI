// End-to-end simulacija: lokalni "agar.rs" + pravi alat (src/index.js) kao
// zaseban proces + spectator snimci + izvestaj sa metrikama i proverama.
//
//   npm run sim                         (60 s, podrazumevana podesavanja)
//   node test/sim/run.mjs --seconds 90  (duze)
//   node test/sim/run.mjs -- --feedmode eject --threatRatio 1.7   (argumenti alatu posle --)
//
// Na masinama gde Playwright ne nalazi svoj browser: AGARAI_CHROME=/putanja/do/chrome
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
const own = dd >= 0 ? argv.slice(0, dd) : argv;
const toolArgs = dd >= 0 ? argv.slice(dd + 1) : [];
const opt = (k, d) => { const i = own.indexOf('--' + k); return i >= 0 ? own[i + 1] : d; };
const SECONDS = Number(opt('seconds', 60));
const OUT = path.resolve(opt('out', path.join(ROOT, 'sim-out')));
const CHROME = process.env.AGARAI_CHROME || '';
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEED = opt('seed', null);
const server = await startServer(SEED != null ? { seed: SEED } : {});
console.log(`[sim] mock agar.rs na ${server.url}  (trajanje ${SECONDS}s, izlaz ${OUT})`);

// 1) Pravi alat, bas kao kod tebe: consent -> nick -> Play -> teaming.
const TOOL = path.resolve(opt('tool', path.join(ROOT, 'src/index.js')));   // druga verzija alata za poredjenje
const args = [TOOL, '--url', server.url, '--headless', '--no-map', '--jitterLog', ...toolArgs];
const jitter = {};                // "stara odluka -> nova odluka" -> broj naglih okreta
const rapid = {};                 // isto, ali samo okreti koji brzo slede jedan drugi (petlja)
let jitterAll = 0, rapidAll = 0;
const lastStat = {};              // poslednji status mozga iz stranice po botu
if (CHROME) args.push('--chrome', CHROME);
const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
const toolLog = fs.createWriteStream(path.join(OUT, 'tool.log'));
const notes = {};                 // brojac akcija iz "tik N ..." linija
child.stdout.on('data', (d) => {
  toolLog.write(d);
  for (const line of String(d).split('\n')) {
    if (/consent|auto-join|spawn:|UPOZORENJE|protokol OK|greska/i.test(line)) console.log('[alat]', line.replace(/^\[agarai\]\s*/, ''));
    const stat = line.match(/STAT (\S+) (\{.*\})\s*$/);
    if (stat) {
      try {
        const o = JSON.parse(stat[2]);
        lastStat[stat[1]] = o;
        notes[o.note] = (notes[o.note] || 0) + 1;
      } catch (_) {}
      continue;
    }
    const j = line.match(/JITTER (\S+): (.*) \| dt=(\d+)$/);
    if (j) {
      jitter[j[2]] = (jitter[j[2]] || 0) + 1;
      jitterAll++;
      if (Number(j[3]) < 1500) { rapid[j[2]] = (rapid[j[2]] || 0) + 1; rapidAll++; }   // okret <1.5s posle prethodnog = pravi jitter
      continue;
    }
    const m = line.match(/tik \d+\s+kralj=\d+\s+(.*)$/);
    if (m) for (const part of m[1].split(/\s{2,}/)) {
      const k = part.split(':').slice(1).join(':').trim();
      if (k) notes[k] = (notes[k] || 0) + 1;
    }
  }
});
child.stderr.on('data', (d) => { toolLog.write(d); process.stderr.write('[alat:err] ' + d); });

// 2) Spectator - snimci cele mape.
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const spec = await browser.newPage({ viewport: { width: 900, height: 900 } });
await spec.goto(server.url + '?spectate=1');
await spec.click('#agree').catch(() => {});
const shots = [];
const shotAt = [Math.min(15, SECONDS * 0.25), SECONDS * 0.55, SECONDS - 2].map((s) => Math.round(s));
const t0 = Date.now();
for (const s of shotAt) {
  const wait = t0 + s * 1000 - Date.now();
  if (wait > 0) await sleep(wait);
  const f = path.join(OUT, `spectator-${String(s).padStart(3, '0')}s.png`);
  await spec.screenshot({ path: f });
  shots.push(f);
  const m = server.metrics();
  console.log(`[sim] t=${s}s  ` + m.bots.map((b) => `${b.name}: masa ${b.mass} (${b.cells} del.)`).join('  |  '));
}
const rest = t0 + SECONDS * 1000 - Date.now();
if (rest > 0) await sleep(rest);

// 3) Zaustavi alat i skupi metrike.
const metrics = server.metrics();
child.kill('SIGINT');
await Promise.race([new Promise((r) => child.on('exit', r)), sleep(5000)]);
if (child.exitCode === null) child.kill('SIGKILL');
await browser.close();
await server.close();
toolLog.end();

// 4) Izvestaj.
const bots = metrics.bots;
const pad = (s, n) => String(s).padEnd(n);
const num = (x) => (x === Infinity ? '-' : Math.round(x));
console.log(`\n================ REZULTAT SIMULACIJE (${metrics.seconds}s) ================`);
const cols = ['bot', 'spawn', 'smrti', 'od tima', 'od neprij.', 'max masa', 'kraj', 'split', 'DUPLI', 'eject', 'virus-pop', 'hrana', 'pojeo neprij.', 'primio od tima', 'dao timu', 'jitter/min'];
console.log(cols.map((c, i) => pad(c, i === 0 ? 10 : Math.max(6, c.length + 1))).join(''));
for (const b of bots) {
  const mins = Math.max(b.aliveMs / 60000, 1 / 60);
  const row = [b.name, b.spawns, b.deaths, b.deathsByTeam, b.deathsByEnemy, Math.round(b.maxMass), b.mass, b.splitCmds, b.doubleSplits, b.ejects, b.virusPops, b.foodEaten, Math.round(b.enemyMassEaten), Math.round(b.massFromTeam), Math.round(b.massToTeam), (b.dirFlips / mins).toFixed(1)];
  console.log(row.map((c, i) => pad(c, i === 0 ? 10 : Math.max(6, cols[i].length + 1))).join(''));
}
const teamMax = Math.max(0, ...bots.map((b) => b.maxMass));
const transfer = bots.reduce((a, b) => a + b.massFromTeam, 0);
const dbl = bots.reduce((a, b) => a + b.doubleSplits, 0);
const splits = bots.reduce((a, b) => a + b.splitCmds, 0);
const byEnemy = bots.reduce((a, b) => a + b.deathsByEnemy, 0);
const pops = bots.reduce((a, b) => a + b.virusPops, 0);
const food = bots.reduce((a, b) => a + b.foodEaten, 0);
const enemyEaten = bots.reduce((a, b) => a + b.enemyMassEaten, 0);
// mozak u stranici: brzi okreti i uzroci dolaze iz STAT linija
for (const o of Object.values(lastStat)) {
  rapidAll += o.rapid || 0; jitterAll += o.flips || 0;
  for (const [k, v] of Object.entries(o.causes || {})) rapid[k] = (rapid[k] || 0) + v;
}
const dps = Object.entries(lastStat).map(([n, o]) => `${n}=${o.dps}/s`).join(' ');
console.log(`\nprotivnici na kraju: ${metrics.enemies.map((e) => `${e.name}=${e.mass}`).join(' ')}`);
console.log('najcesce akcije iz alata:', Object.entries(notes).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} x${v}`).join(', '));
if (dps) console.log(`brzina odlucivanja (mozak u stranici): ${dps}`);
console.log(`nagli okreti (>100 st.): ukupno ${jitterAll}, od toga BRZIH (<1.5s, petlja) ${rapidAll}`);
console.log('  svi po uzroku:', Object.entries(jitter).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `[${k}] x${v}`).join(', ') || 'nema');
console.log('  brzi po uzroku:', Object.entries(rapid).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `[${k}] x${v}`).join(', ') || 'nema');

const checks = [
  ['svi botovi usli u igru (consent+Play+dekoder)', bots.length === 3 && bots.every((b) => b.spawns >= 1)],
  ['jedu hranu', food > 30],
  [`jedu druge igrace (${Math.round(enemyEaten)} mase)`, enemyEaten > 0],
  ['nema duplih split-ova (1 komanda = 1 split)', splits === 0 || dbl === 0],
  ['masa se prenosi unutar tima (kamikaza/hranjenje)', transfer > 0],
  [`kralj narastao (max ${Math.round(teamMax)} > 3x start)`, teamMax > 120],
  [`malo smrti od neprijatelja (${byEnemy})`, byEnemy <= 3 * Math.max(1, SECONDS / 60)],
  [`malo pucanja na virusu (${pops})`, pops <= 3 * Math.max(1, SECONDS / 60)],
  [`malo brzog jittera (${rapidAll} brzih okreta)`, rapidAll <= 10 * Math.max(1, SECONDS / 60)],
];
console.log('\nPROVERE:');
let ok = true;
for (const [name, pass] of checks) { console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) ok = false; }
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ metrics, notes, jitter, rapid, checks: checks.map(([n, p]) => ({ n, p })) }, null, 2));
console.log(`\nsnimci: ${shots.join(', ')}\nlog alata: ${path.join(OUT, 'tool.log')}\nizvestaj: ${path.join(OUT, 'report.json')}`);
process.exit(ok ? 0 : 1);
