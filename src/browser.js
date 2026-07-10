// Pokrece Chromium, otvara po jedan tab za svakog bota, ubacuje hook
// i uvodi ga u igru. Vraca listu "bot" objekata sa referencom na page.

import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, 'inject', 'agarhook.js');
const HOOK_SRC = fs.readFileSync(HOOK_PATH, 'utf8');

export async function launchFleet(cfg, log) {
  // Jedan browser, vise tabova = vise "igraca". User-data dir da svaki
  // tab moze da ostane ulogovan/podesen ako klon to trazi.
  const launchOpts = {
    headless: cfg.headless,
    slowMo: cfg.slowmo,
    args: ['--disable-blink-features=AutomationControlled', '--mute-audio'],
  };
  if (cfg.chromePath) launchOpts.executablePath = cfg.chromePath;
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    viewport: { width: 1000, height: 720 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
  });

  // Opcije + hook u JEDNOM init skriptu (da OPT sigurno postoji pre hooka,
  // i u svakom frame-u ukljucujuci iframe klona).
  const opt = JSON.stringify({
    capture: cfg.capture,
    sniff: cfg.sniff,
    moveRadius: cfg.moveRadius,
    control: cfg.control,
    debug: cfg.debug,
  });
  await context.addInitScript({
    content: `window.__AGARAI_OPT = ${opt};\n${HOOK_SRC}`,
  });

  const bots = [];
  for (let i = 0; i < cfg.count; i++) {
    const page = await context.newPage();
    const nick = cfg.nicks[i] || `bot${i + 1}`;
    if (cfg.debug || cfg.sniff) {
      page.on('console', (m) => {
        const t = m.text();
        if (cfg.debug || t.startsWith('AGARAI')) log(`[tab${i}] ${t}`);
      });
    }
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded' }).catch((e) => {
      log(`[tab${i}] goto greska: ${e.message}`);
    });
    bots.push({ index: i, nick, page, spawned: false, lastState: null });
    log(`[tab${i}] otvoren "${nick}" -> ${cfg.url}`);
  }

  // Ulazak u igru.
  for (const bot of bots) {
    await joinGame(bot, cfg, log);
  }

  return { browser, context, bots };
}

// Tekst dugmadi za cookie/GDPR pristanak (agar.rs prikaze "Pristajem" i sl.).
const CONSENT_RX = [
  /svim.*pristaj/i, /pristaj/i, /prihva/i, /slaz|slaž/i, /saglas/i, /dozvoli/i,
  /accept all/i, /accept/i, /agree|consent/i, /^u redu$/i, /^ok$/i, /nastavi/i, /razumem|razumijem/i,
];
const PLAY_RX = [/^play$/i, /play/i, /igraj/i, /^start$/i, /start game/i, /kreni/i, /^go$/i];

// Klikni consent dugme u BILO KOM frame-u (CMP je cesto u iframe-u).
export async function dismissConsent(page, log) {
  for (const frame of page.frames()) {
    let els;
    try { els = await frame.$$('button, [role="button"], a, input[type="button"], input[type="submit"]'); }
    catch (_) { continue; }
    for (const el of els) {
      let txt = '';
      try {
        txt = (await el.innerText({ timeout: 150 })).trim();
        if (!txt) txt = (await el.getAttribute('value')) || '';
        txt = txt.trim();
      } catch (_) { continue; }
      if (!txt || txt.length > 40) continue;
      if (CONSENT_RX.some((r) => r.test(txt))) {
        const vis = await el.isVisible().catch(() => false);
        if (vis) {
          await el.click({ timeout: 1500 }).catch(() => {});
          if (log) log(`  consent: kliknuo "${txt}"`);
          return true;
        }
      }
    }
  }
  return false;
}

// Unesi nadimak + klikni Play (trazi po tekstu i u frame-ovima).
async function fillNickAndPlay(page, nick, cfg, log) {
  const nickEl = await page.$(cfg.nickSelector).catch(() => null);
  if (nickEl) {
    await nickEl.click({ timeout: 1500 }).catch(() => {});
    await nickEl.fill(nick).catch(() => {});
  }
  for (const frame of page.frames()) {
    let els;
    try { els = await frame.$$('button, [role="button"], a, input[type="button"], input[type="submit"], div'); }
    catch (_) { continue; }
    for (const el of els) {
      let txt = '';
      try { txt = (await el.innerText({ timeout: 120 })).trim(); } catch (_) { continue; }
      if (!txt || txt.length > 24) continue;
      if (PLAY_RX.some((r) => r.test(txt))) {
        const vis = await el.isVisible().catch(() => false);
        if (vis) { await el.click({ timeout: 1500 }).catch(() => {}); if (log) log(`  play: "${txt}"`); return true; }
      }
    }
  }
  // Fallback: selektor iz configa, pa Enter/Space.
  const el = await page.$(cfg.playSelector).catch(() => null);
  if (el) { await el.click({ timeout: 1500 }).catch(() => {}); return true; }
  await page.keyboard.press('Enter').catch(() => {});
  await page.keyboard.press('Space').catch(() => {});
  return false;
}

async function joinGame(bot, cfg, log) {
  const { page, index, nick } = bot;

  // Prvo consent - moze da iskoci malo posle ucitavanja, pa probaj vise puta.
  for (let i = 0; i < 8; i++) {
    const done = await dismissConsent(page, i === 0 ? (t => log(`[tab${index}]${t}`)) : null);
    if (done) { log(`[tab${index}] consent prihvacen`); break; }
    await sleep(400);
  }

  if (cfg.manualJoin) {
    log(`[tab${index}] MANUAL-JOIN: consent je sredjen; ako treba, klikni Play sam.`);
    return;
  }
  await fillNickAndPlay(page, nick, cfg, (t) => log(`[tab${index}]${t}`));
  log(`[tab${index}] auto-join: nadimak "${nick}" + Play`);
}

// Respawn: kad bot umre, ponovo sredi consent (za svaki slucaj) i klikni Play.
export async function botRejoin(bot, cfg) {
  const { page, nick } = bot;
  await dismissConsent(page, null).catch(() => {});
  await fillNickAndPlay(page, nick, cfg, null).catch(() => {});
}

// Igra moze biti u iframe-u: nadji frame u kom je hook zakacio socket.
// Kesiramo ga po botu i re-biramo ako zakaze.
async function pickFrame(bot) {
  if (bot.frame) {
    const ok = await bot.frame.evaluate(() => !!(window.__AGARAI && window.__AGARAI.ready))
      .catch(() => false);
    if (ok) return bot.frame;
    bot.frame = null;
  }
  // Prvo probaj frame koji ima aktivan socket, pa bilo koji sa hookom.
  let fallback = null;
  for (const f of bot.page.frames()) {
    const st = await f.evaluate(() => window.__AGARAI && window.__AGARAI.getState()).catch(() => null);
    if (st && st.connected) { bot.frame = f; return f; }
    if (st && !fallback) fallback = f;
  }
  return fallback || bot.page.mainFrame();
}

// Procitaj stanje bota (kroz pravi frame).
export async function botGetState(bot) {
  const f = await pickFrame(bot);
  return f.evaluate(() => window.__AGARAI && window.__AGARAI.getState()).catch(() => null);
}

// Posalji komandu botu (kroz pravi frame).
export async function botCommand(bot, cmd) {
  const f = await pickFrame(bot);
  return f.evaluate((c) => window.__AGARAI && window.__AGARAI.command(c), cmd).catch(() => {});
}

// Izvuci snimljene frejmove iz SVIH frame-ova (socket moze biti u iframe-u).
export async function botDumpCaptures(bot) {
  const out = [];
  for (const f of bot.page.frames()) {
    const caps = await f.evaluate(
      () => (window.__AGARAI && window.__AGARAI._dumpCaptures) ? window.__AGARAI._dumpCaptures() : null
    ).catch(() => null);
    if (caps && caps.length) out.push(...caps);
  }
  return out;
}

// Ceka da bot dobije svoju celiju (spawned) do timeout-a.
export async function waitSpawn(bot, cfg, log) {
  const deadline = Date.now() + cfg.autoJoinTimeoutMs;
  while (Date.now() < deadline) {
    const st = await botGetState(bot);
    if (st && st.spawned) { bot.spawned = true; return true; }
    if (st && st.connected && cfg.debug) log(`[tab${bot.index}] povezan, cekam spawn...`);
    await sleep(400);
  }
  log(`[tab${bot.index}] nije spawn-ovan u roku (${cfg.autoJoinTimeoutMs}ms) - proveri selektore ili udji rucno (--manual-join)`);
  return false;
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
