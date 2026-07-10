// Pokrece Chromium, otvara po jedan tab za svakog bota, ubacuje hook
// i uvodi ga u igru. Vraca listu "bot" objekata sa referencom na page.

import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, 'inject', 'agarhook.js');

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

  // Opcije koje hook cita iz stranice.
  await context.addInitScript({
    content: `window.__AGARAI_OPT = ${JSON.stringify({
      capture: cfg.capture,
      moveRadius: cfg.moveRadius,
      control: cfg.control,
      debug: cfg.debug,
    })};`,
  });
  // Sam hook - ubacuje se pre ucitavanja svake stranice.
  await context.addInitScript({ path: HOOK_PATH });

  const bots = [];
  for (let i = 0; i < cfg.count; i++) {
    const page = await context.newPage();
    const nick = cfg.nicks[i] || `bot${i + 1}`;
    if (cfg.debug) {
      page.on('console', (m) => log(`[tab${i} console] ${m.text()}`));
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

async function joinGame(bot, cfg, log) {
  const { page, index, nick } = bot;

  if (cfg.manualJoin) {
    log(`[tab${index}] MANUAL-JOIN: udji sam u igru u ovom tabu (unesi "${nick}" i klikni Play).`);
    return;
  }

  // Pokusaj auto-join: unesi nadimak, klikni play. Selektori su podesivi
  // jer se UI razlikuje po klonu; ako ne uspe, padamo na cekanje spawna.
  try {
    const nickEl = await page.$(cfg.nickSelector);
    if (nickEl) {
      await nickEl.click({ timeout: 2000 }).catch(() => {});
      await nickEl.fill('').catch(() => {});
      await nickEl.type(nick, { delay: 30 }).catch(() => {});
      log(`[tab${index}] uneo nadimak "${nick}"`);
    } else {
      log(`[tab${index}] polje za nadimak nije nadjeno (${cfg.nickSelector}) - preskacem`);
    }

    // Nadji "Play" dugme: prvo probaj tekstualno, pa selektor.
    let clicked = false;
    for (const sel of ['text=/play/i', 'text=/igraj/i', 'text=/start/i', cfg.playSelector]) {
      const el = await page.$(sel).catch(() => null);
      if (el) {
        await el.click({ timeout: 2000 }).catch(() => {});
        clicked = true;
        log(`[tab${index}] kliknuo Play (${sel})`);
        break;
      }
    }
    if (!clicked) {
      // Poslednja opcija: Enter na polju/telu.
      await page.keyboard.press('Enter').catch(() => {});
      log(`[tab${index}] Play dugme nije nadjeno - probao Enter`);
    }
  } catch (e) {
    log(`[tab${index}] auto-join greska: ${e.message}`);
  }
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

// Izvuci snimljene frejmove (iz frame-a sa socketom).
export async function botDumpCaptures(bot) {
  const f = await pickFrame(bot);
  return f.evaluate(() => window.__AGARAI && window.__AGARAI._dumpCaptures()).catch(() => []);
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
