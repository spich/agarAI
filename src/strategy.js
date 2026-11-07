// =====================================================================
// strategy.js - MOZAK BOTA.
//
// Cist JavaScript bez import-a i bez Node API-ja, jer se isti kod koristi:
//   - U STRANICI (default, --brain page): ubacuje se u svaki tab i odlucuje
//     na svaki paket od servera (~25x/s), bez Node-a u petlji.
//   - u Node-u: unit testovi i stari rezim --brain node.
//
// Rutine (po prioritetu):
//   BEKSTVO      od >=2x mase (moze split-lov), sa inercijom i histerezom
//   SPLIT-KILL   plen dovoljno mali da ga pola moje mase pojede, u dometu
//   LOV          juri manje igrace (kralj agresivno, hranioci usput)
//   KRALJ        kupi izbacenu masu / delove saigraca, ide u susret hraniocu
//   HRANILAC     ide ka kralju i PUMPA W u njega, blizu se SPLIT-uje u
//                njega, razbijen uleti ceo (masa na hrpu kod kralja)
//   HRANA        ispred sebe (anti-jitter), u dometu
// Svaki pravac na kraju prolazi kroz meko zaobilazenje prepreka (virusi,
// pretnje) koje klizi oko njih umesto da se vraca kroz njih.
// =====================================================================

function sub(a, b) { return [a.x - b.x, a.y - b.y]; }
function len(v) { return Math.hypot(v[0], v[1]) || 1e-6; }
function norm(v) { const l = len(v); return [v[0] / l, v[1] / l]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function scale(v, s) { return [v[0] * s, v[1] * s]; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

// FAZE: 1) "daj sve" - novi bot je mali kao krupna hrana na agar.rs i jedva
// je jede, pa odmah ubaci sve u prvog i respawn-uje se (2 kruga izgrade
// kralja); 2) PING-PONG svi sa svakim - kad je kralj narastao, svi imaju
// mase da jedu krupnu hranu i igrace, pa se ubacuju jedan u drugog i kruna
// rotira. --pingpong / --no-pingpong forsira fazu; default auto.
function pingPongActive(cfg, centers) {
  if (cfg.pingPong === true) return true;
  if (cfg.pingPong === false) return false;
  let mx = 0;
  for (const c of centers || []) if (c) mx = Math.max(mx, c.mass != null ? c.mass : (c.size * c.size) / 100);
  return mx >= (cfg.pingPongAt || 200);
}

// Kom saigracu pripada celija? Primarno po IMENU (agar.rs salje ime uz svaku
// igracku celiju, pa i uz split-delove). Neimenovano = nije saigrac.
function teammateOf(e, ctx, selfIndex) {
  const nicks = ctx.teamNicks || [];
  if (nicks.length) {
    if (!e.name) return -1;
    for (let i = 0; i < nicks.length; i++) {
      if (i !== selfIndex && nicks[i] && e.name.includes(nicks[i])) return i;
    }
    return -1;
  }
  const tc = ctx.teamCenters || [];
  for (let i = 0; i < tc.length; i++) {
    const t = tc[i];
    if (!t || i === selfIndex) continue;
    if (Math.hypot(e.x - t.x, e.y - t.y) < Math.max(e.size, t.size || 0) * 0.6 + 120) return i;
  }
  return -1;
}

// Pragovi su po MASI (masa ~ size^2). Gledamo najvecu svoju celiju.
function scan(me, entities, cfg, ctx, selfIndex, isKing) {
  const threats = [];   // ko moze da me pojede (>eaterRatio mase)
  const prey = [];      // tudji igraci koje mogu da pojedem
  const edible = [];    // sve jestivo (hrana, izbacena masa, plen)
  const teamEject = []; // izbacena masa / delovi razbijenog saigraca
  const viruses = [];
  const mySz = me.maxCell || me.size;
  const eatCap = mySz * 0.87;          // za jelo treba ~1.3x mase (size 1.14x)
  const foodCap = mySz * 0.9;          // agar.rs hrana je krupna (prava masa) -> moram biti veci
  const eaterSz = mySz * Math.sqrt(cfg.eaterRatio || 1.3);
  for (const e of entities) {
    if (e.isMine) continue;
    if (e.isVirus) { viruses.push(e); continue; }
    const tm = teammateOf(e, ctx, selfIndex);
    if (tm >= 0) {
      // Primalac (kralj) guta delove saigraca koji mu TRENUTNO daje masu;
      // ostatak koji saigrac zadrzava ne dira. Bez signala: razbijen saigrac.
      const t = ctx.teamCenters && ctx.teamCenters[tm];
      const giving = t && (t.giving != null ? t.giving : t.cellCount > 1);
      if (isKing && giving && e.size < eatCap) { teamEject.push(e); edible.push(e); }
      continue;
    }
    if (e.isEjected) { teamEject.push(e); if (e.size < eatCap) edible.push(e); continue; }
    if (e.isFood) { if (e.size < foodCap) edible.push(e); continue; }
    if (e.size > eaterSz) threats.push(e);
    else if (e.size < eatCap) { prey.push(e); edible.push(e); }
  }
  return { threats, prey, edible, teamEject, viruses };
}

// Opasnosti:
//  - splitter (>= threatRatio mase): bekstvo (+ zona zaobilazenja ispred)
//  - eater (1.3x..threatRatio): sporiji je od mene -> samo ga zaobidji
//  - virus: tesno zaobilazenje, samo ako sam veci od njega
function avoidVector(me, s, cfg) {
  let v = [0, 0];
  let threat = false;
  let near = false;
  let nearVec = [0, 0];
  const soft = [];
  const push = cfg.virusPush || 1.1;
  const addSoft = (o, strength) => {
    const k = Math.min(1, strength * push);
    if (k > 0.01) soft.push({ u: norm(sub(o, me)), k });
  };
  const mySz = me.maxCell || me.size;
  const myMass = mySz * mySz;
  for (const t of s.threats) {
    const d = dist(me, t);
    if (t.size * t.size >= myMass * cfg.threatRatio) {
      const r = Math.max((mySz + t.size) * cfg.fleeFactor, mySz + t.size + (cfg.splitReach || 0));
      const band = cfg.threatBand || 1.3;
      if (d < r) { v = add(v, scale(norm(sub(me, t)), (r - d) / r)); threat = true; }
      if (d < r * (cfg.fleeExit || 1.15)) { near = true; nearVec = add(nearVec, norm(sub(me, t))); }
      if (d >= r && d < r * band) addSoft(t, (r * band - d) / (r * (band - 1)));
    } else {
      const r = (mySz + t.size) * (cfg.eaterAvoid || 1.1);
      if (d < r) addSoft(t, (r - d) / r);
    }
  }
  for (const g of s.viruses) {
    if (mySz > g.size * cfg.virusRatio) {
      const d = dist(me, g);
      const r = mySz * cfg.virusAvoid + g.size * 0.5;
      if (d < r) {
        const popD = mySz - g.size * 0.4;
        addSoft(g, Math.min(1, (r - d) / Math.max(30, r - popD)) * 1.5);
      }
    }
  }
  return { v, threat, near, nearVec, soft };
}

// Hrana: u dometu, prednost onoj ISPRED (kazna za okretanje), histereza.
function chooseFood(bot, me, list, cfg) {
  if (!list || !list.length) { bot._targetId = null; return null; }
  const scope = me.size * ((cfg && cfg.foodScope) || 10);
  const near = list.filter((f) => dist(me, f) < scope);
  const pool = near.length ? near : list;
  const h = bot._heading;
  const turnPen = (cfg && cfg.turnPenalty != null) ? cfg.turnPenalty : 1.5;
  const score = (f) => {
    const d = dist(me, f);
    if (!h || d < 1) return d;
    const c = (h[0] * (f.x - me.x) + h[1] * (f.y - me.y)) / d;
    return d * (1 + turnPen * (1 - c) / 2);
  };
  let best = null, bs = Infinity;
  for (const f of pool) { const sc = score(f); if (sc < bs) { bs = sc; best = f; } }
  if (bot._targetId != null) {
    const old = pool.find((e) => e.id === bot._targetId);
    if (old && score(old) < bs * 1.5) best = old;
  }
  bot._targetId = best.id;
  // cilj vec u meni (jos nije progutan) -> nastavi pravo, bez okretanja
  if (h && dist(me, best) < (me.maxCell || me.size) * 0.85) return h;
  return norm(sub(best, me));
}

// Gde ce plen biti za ms milisekundi (brzina dolazi iz hook-a: vx, vy po ms).
function leadPoint(p, ms) { return { x: p.x + (p.vx || 0) * ms, y: p.y + (p.vy || 0) * ms }; }

// LOV: izaberi najisplativiji plen (masa / udaljenost) i proceni split-kill.
function pickPrey(bot, me, s, cfg, isKing, danger, now) {
  const mySz = me.maxCell || me.size;
  const range = isKing ? mySz * cfg.huntRange + 300 : mySz * (cfg.feederHuntRange || 2.5) + 150;
  // vrednost = masa/udaljenost, sa prednoscu plenu ISPRED (manje okretanja)
  const h = bot._heading;
  const turnPen = cfg.turnPenalty != null ? cfg.turnPenalty : 1.5;
  const val = (p) => {
    const d = dist(me, p);
    let v = (p.size * p.size) / (d + 150);
    if (h && d > 1) { const c = (h[0] * (p.x - me.x) + h[1] * (p.y - me.y)) / d; v /= 1 + turnPen * (1 - c) / 2; }
    return v;
  };
  bot._ignorePrey = bot._ignorePrey || {};
  // Manji plen je BRZI od mene - jurnjava dodirom na daljinu je uzaludna.
  // Na daljinu juri samo plen koji mogu da SPLIT-ubijem (prilazim do dometa
  // splita); ostali plen samo kad je vec blizu.
  const canHuntSplit = !!cfg.huntSplit && (me.cellCount || 1) <= (cfg.maxHuntCells || 2);
  const splitable = (p) => canHuntSplit && p.size < mySz * 0.62 && p.size > mySz * (cfg.splitMinPrey || 0.25);
  const nearRange = mySz * 1.8 + 100;
  let best = null, bv = -1;
  for (const p of s.prey) {
    if (dist(me, p) > (splitable(p) ? range : Math.min(range, nearRange))) continue;
    if ((bot._ignorePrey[p.id] || 0) > now) continue;         // od ovog sam odustao
    const v = val(p);
    if (v > bv) { bv = v; best = p; }
  }
  // ZAKLJUCAN LOV: zapoceti plen drzi dok je u prosirenom dometu i dok traje
  // zakljucavanje (ili dok je i dalje dobar izbor) - da kralj ne skace
  // izmedju lova i drugih ciljeva svaki put kad plen na trenutak izmakne.
  if (bot._preyId != null) {
    const old = s.prey.find((p) => p.id === bot._preyId);
    if (old && dist(me, old) < range * 1.5 && (now < (bot._huntUntil || 0) || val(old) > bv * 0.6)) best = old;
  }
  if (!best) {
    // PAMCENJE PLENA: plen na ivici vidokruga treperi unutra-napolje (server
    // ga izbaci iz update-a). Dok traje zakljucavanje, nastavi ka predvidjenoj
    // poziciji umesto da se okrenes ka necem drugom.
    const g = bot._preyLast;
    if (g && g.id === bot._preyId && now - g.t < (cfg.huntLockMs || 900)) {
      const dt = now - g.t + (cfg.leadMs || 200);
      const aim = { x: g.x + g.vx * dt, y: g.y + g.vy * dt };
      return { prey: g, d: dist(me, aim), aim, splitKill: false, close: false, ghost: true };
    }
    bot._preyId = null;
    return null;
  }
  if (best.id !== bot._preyId) {
    bot._huntUntil = now + (cfg.huntLockMs || 900);
    bot._huntSince = now; bot._huntBestD = dist(me, best);
  }
  // ODUSTAJANJE: manji plen je brzi od mene - ako se za huntGiveUpMs nisam
  // osetno priblizio (i nemam split-kill), pusti ga na neko vreme.
  {
    const d0 = dist(me, best);
    if (d0 < (bot._huntBestD || Infinity) * 0.9) { bot._huntBestD = d0; bot._huntSince = now; }
    if (now - (bot._huntSince || now) > (cfg.huntGiveUpMs || 2500)) {
      bot._ignorePrey[best.id] = now + 4000;
      bot._preyId = null; bot._preyLast = null;
      return null;
    }
  }
  bot._preyId = best.id;
  bot._preyLast = { id: best.id, x: best.x, y: best.y, vx: best.vx || 0, vy: best.vy || 0, size: best.size, t: now };
  const d = dist(me, best);
  let aim = leadPoint(best, cfg.leadMs || 200);
  // Plen je vec u meni (jos nije progutan): ne okreci se 180 stepeni svaki
  // tik nego nastavi pravo kroz njega dok ga ne pojedem.
  if (d < mySz * 0.85 && bot._heading) {
    aim = { x: me.x + bot._heading[0] * mySz * 1.5, y: me.y + bot._heading[1] * mySz * 1.5 };
  }
  // Split-kill: pola moje najvece celije mora pojesti plen (plen < mySz*0.62),
  // plen je u dometu leta splita, vredi ga (nije sitnis), nema pretnje u
  // blizini (inace bi mi razbijene delove pojeli) i nisam vec razbijen.
  const splitKill = !!cfg.huntSplit && !danger &&
    (me.cellCount || 1) <= (cfg.maxHuntCells || 2) &&
    best.size < mySz * 0.62 && best.size > mySz * (cfg.splitMinPrey || 0.25) &&
    d > mySz * 0.9 && d < mySz + (cfg.splitKillDist || 420);
  return { prey: best, d, aim, splitKill, close: d < mySz * 2.5 };
}

// Javna odluka: jezgro + meko zaobilazenje prepreka na kraju.
export function decide(bot, state, ctx) {
  const res = decideCore(bot, state, ctx);
  if (res && res.dir && bot._soft && bot._soft.length && !res.split && !res.feed && !res._noAvoid) {
    let nd = [res.dir[0], res.dir[1]];
    // Najjace prepreke prve: ukloni komponentu KA prepreci i zameni je
    // tangentom -> klizi oko nje umesto da se spiralno uvlaci u nju.
    for (const { u, k } of [...bot._soft].sort((a, b) => b.k - a.k)) {
      const inward = nd[0] * u[0] + nd[1] * u[1];
      if (inward > 0) {
        let t = [-u[1], u[0]];
        if (t[0] * nd[0] + t[1] * nd[1] < 0) t = [u[1], -u[0]];
        nd = [nd[0] - u[0] * inward * k + t[0] * inward * k, nd[1] - u[1] * inward * k + t[1] * inward * k];
      }
      nd = [nd[0] - u[0] * k * 0.3, nd[1] - u[1] * k * 0.3];
    }
    const before = res.dir;
    res.dir = norm(nd);
    // pravac se promenio -> tacna meta (aim) vise ne vazi, vozimo po pravcu
    if (res.aim && (Math.abs(before[0] - res.dir[0]) > 1e-3 || Math.abs(before[1] - res.dir[1]) > 1e-3)) res.aim = null;
  }
  if (res && res.dir) bot._heading = res.dir;
  return res;
}

function decideCore(bot, state, ctx) {
  const { cfg } = ctx;
  if (!state || !state.spawned || !state.me) {
    return { respawn: true, note: 'mrtav/cekam spawn' };
  }
  const me = state.me;
  const now = ctx.now || 0;
  const teammates = ctx.teamCenters.filter((c, i) => i !== bot.index && c);
  const isKing = bot.index === ctx.kingIndex;
  const s = scan(me, state.entities, cfg, ctx, bot.index, isKing);
  const mySz = me.maxCell || me.size;

  // ---------------- BEKSTVO ----------------
  const avoid = avoidVector(me, s, cfg);
  bot._soft = avoid.soft;
  if (avoid.threat) { bot._fleeUntil = now + cfg.fleeLatchMs; bot._fleeVec = avoid.v; bot._fleeing = true; }
  const stillNear = bot._fleeing && avoid.near;
  if (avoid.threat || stillNear || (bot._fleeUntil && now < bot._fleeUntil)) {
    const v = avoid.threat ? avoid.v : (stillNear ? avoid.nearVec : (bot._fleeVec || [1, 0]));
    return { dir: norm(v), speed: 1, feed: 0, _flee: true, note: avoid.threat ? 'bezim od pretnje' : 'bezim (inercija)' };
  }
  bot._fleeing = false;

  // ---------------- LOV / SPLIT-KILL ----------------
  // --pingpong: kralj sme da se razbije (split-kill) samo kad je PARTNER pored
  // da odmah pokupi njegove delove, i ne dok mu neko upravo daje masu - inace
  // se oba razbiju i masa se preliva tamo-amo. (Podrazumevano kralj lovi
  // slobodno: hranioci ionako dolaze sa svezom masom.)
  let noSplit = avoid.near || (avoid.soft.length > 0 && s.threats.length > 0);
  if (isKing && !noSplit && pingPongActive(cfg, ctx.teamCenters)) {
    const myMass = me.mass != null ? me.mass : (me.size * me.size) / 100;
    const receiving = teammates.some((t) => t.giving);
    const partner = teammates.some((t) => (t.cellCount || 1) === 1 &&
      (t.mass != null ? t.mass : (t.size * t.size) / 100) >= myMass * (cfg.recvMinFrac || 0.1) &&
      dist(me, t) < (cfg.partnerRange || 1600));
    if (receiving || (cfg.huntNeedPartner !== false && !partner && teammates.length)) noSplit = true;
  }
  const hunt = pickPrey(bot, me, s, cfg, isKing, noSplit, now);
  if (hunt) {
    if (hunt.splitKill && now >= (bot._splitUntil || 0)) {
      bot._splitUntil = now + cfg.splitCooldownMs;
      return { aim: hunt.aim, dir: norm(sub(hunt.aim, me)), split: true, note: 'SPLIT-KILL' };
    }
    if (isKing || hunt.close) {
      return { aim: hunt.aim, dir: norm(sub(hunt.aim, me)), note: isKing ? 'kralj lovi' : 'lovim usput' };
    }
  }

  // ---------------- KRALJ ----------------
  if (isKing) {
    // dobaci malo mase saigracu koji je premali da bi se uopste split-ovao
    if (cfg.kingFeedback && me.size > 120 && now >= (bot._fbUntil || 0)) {
      let t = null, td = Infinity;
      for (const tm of teammates) {
        if ((tm.cellCount || 1) === 1 && (tm.maxCell || tm.size) < cfg.minSplitSize * 0.8) {
          const d = dist(me, tm); if (d < td) { td = d; t = tm; }
        }
      }
      if (t && td < me.size * 4) {
        bot._fbUntil = now + (cfg.feedbackCdMs || 350);
        return { aim: { x: t.x, y: t.y }, dir: norm(sub(t, me)), speed: 0.5, feed: 1, note: 'kralj dobacuje suigracu' };
      }
    }
    if (s.teamEject.length) {
      const v = chooseFood(bot, me, s.teamEject, cfg);
      if (v) return { dir: v, note: 'kralj kupi masu' };
    }
    // u susret saigracu koji mi DAJE masu (u tabu znamo preko tim-kanala;
    // bez signala: razbijen ili dovoljno velik) - inace me ne bi stigao
    {
      const ready = Math.max(cfg.minSplitSize, me.size * cfg.minFeedRatio);
      const givingTo = (tm) => (tm.giving != null ? tm.giving : ((tm.cellCount || 1) > 1 || tm.size >= ready));
      let ti = -1, td = Infinity;
      ctx.teamCenters.forEach((tm, i) => {
        if (i === bot.index || !tm || !givingTo(tm)) return;
        const d = dist(me, tm); if (d < td) { td = d; ti = i; }
      });
      const prev = bot._meetIdx;
      if (prev != null && prev !== ti && ctx.teamCenters[prev] && givingTo(ctx.teamCenters[prev])) {
        const pd = dist(me, ctx.teamCenters[prev]);
        if (pd < td * 1.6) { ti = prev; td = pd; }
      }
      const minMeet = me.size * 1.2 + 150;
      if (ti >= 0 && td < (cfg.meetRange || 3500) && td > minMeet) {
        bot._meetIdx = ti;
        bot._targetId = null;
        // usput pokupi hranu ako je skoro na putu
        const fv = chooseFood(bot, me, s.edible, cfg);
        const tv = norm(sub(ctx.teamCenters[ti], me));
        const dir = fv && (fv[0] * tv[0] + fv[1] * tv[1]) > 0.8 ? norm(add(scale(tv, 0.7), scale(fv, 0.3))) : tv;
        return { dir, note: 'kralj ide po masu' };
      }
      bot._meetIdx = null;
    }
    const fv = chooseFood(bot, me, s.edible, cfg);
    if (fv) return { dir: fv, note: 'kralj jede' };
    bot._targetId = null;
    const c = { x: (state.mapBounds.minx + state.mapBounds.maxx) / 2, y: (state.mapBounds.miny + state.mapBounds.maxy) / 2 };
    return { dir: norm(sub(c, me)), note: 'kralj trazi' };
  }

  // ---------------- HRANILAC ----------------
  const king = ctx.teamCenters[ctx.kingIndex];
  if (!king) {
    const fv = chooseFood(bot, me, s.edible, cfg);
    return { dir: fv || [1, 0], note: 'nema kralja, jedem' };
  }
  // Nisani u kraljev NAJVECI deo (on jede), ne u centroid - kod razbijenog
  // kralja centroid je prazan prostor izmedju delova.
  const aimKing = king.mx != null ? { x: king.mx, y: king.my } : { x: king.x, y: king.y };
  const kingSize = king.maxCell || king.size || 0;
  const dKing = dist(me, aimKing);
  const dirKing = norm(sub(aimKing, me));
  const mode = cfg.feedMode || 'kamikaze';
  const cells = me.cellCount || 1;
  const fragmented = cells > 1;
  const canEject = me.size >= (cfg.minEjectSize || 60);
  const reach = (kingSize + mySz) * cfg.kamiReach;

  if (mode === 'eject') {
    // Samo W sa bezbedne distance (stari nacin)
    bot._giving = false;
    const safeDist = kingSize * cfg.safeFactor + Math.max(40, me.size);
    if (dKing < safeDist * 0.9) return { dir: norm(scale(dirKing, -1)), note: 'odmicem od kralja' };
    if (dKing < kingSize + me.size + cfg.ejectRange && canEject) return { aim: aimKing, dir: dirKing, speed: 0.3, feed: cfg.ejectPerTick, note: 'HRANIM (W)' };
  } else {
    // ===== PING-PONG: DAJEM masu primaocu (kralju) =====
    // Ko je razbijen (posle split-killa, virusa...) ne ceka spajanje nego
    // ODMAH predaje; ceo bot predaje kad skupi dovoljno. Daje "skoro sve":
    // split-uje se na delove koje primalac moze da proguta, a zadrzi mali
    // ostatak da ostane ziv u blizini za sledecu razmenu.
    // Ostatak ima smisla SAMO ako je dovoljan da odmah primi nazad: primalac
    // mora imati bar ~recvMinFrac mase davaoca (davalac se razbije na <=16
    // delova). Ako ne mogu toliko da zadrzim -> dam SVE (kamikaza; respawn
    // donosi novu masu), umesto da sedim mali i beskoristan.
    const kingMass = king.mass != null ? king.mass : (kingSize * kingSize) / 100;
    const recvNeed = (kingMass + me.mass) * (cfg.recvMinFrac || 0.06) * 1.15;
    // ostatak se odredi JEDNOM, na pocetku davanja (inace bi prag pratio masu
    // koja opada i davalac nikad ne bi stao)
    // Podrazumevano DAJ SVE: respawn donosi svezu masu, pa "dvojica ubace sve u
    // prvog, pojave se opet i opet ubace" najbrze hrani kralja (i merenjem).
    // --pingpong: zadrzi ostatak dovoljan da odmah primi nazad (kasna igra);
    // u ranoj igri (svi mali) ostatak nema smisla ni tada.
    const pp = pingPongActive(cfg, ctx.teamCenters);
    // ostatak: dovoljan da jedem krupnu hranu (keepMass) i da odmah primim nazad
    const keepWant = Math.max(cfg.keepMass || 60, recvNeed);
    const keepNow = pp && me.mass >= keepWant + (cfg.giveMinExcess || 30) ? keepWant : 0;
    const keep = bot._giving ? (bot._keep || 0) : keepNow;
    if (bot._giving && keep > 0 && me.mass <= keep) { bot._giving = false; bot._giveDoneAt = now; }
    const ready = fragmented || keep === 0 || me.mass - keep >= (cfg.giveMinExcess || 30);
    const rested = bot._giveDoneAt == null || now - bot._giveDoneAt > (cfg.giveRestMs || 1500);
    if (!bot._giving && ready && rested) {
      bot._giving = true;
      bot._keep = keepNow;
    }
    if (bot._giving) {
      // vec sam u primaocu a jos nisam progutan: nastavi pravo kroz njega
      if (dKing < kingSize * 0.8 && bot._heading) return { dir: bot._heading, note: 'DAJEM masu' };
      // VIRUS (cancer) TRIK: kad sam mnogo veci od primaoca, split-ovi samo
      // polove delove; uletanjem u virus BLIZU primaoca odmah se raspadnem na
      // do 16 sitnih komada koje on brzo pokupi.
      if (cfg.virusPop !== false && cells <= 2 && mySz >= kingSize * 0.87) {
        let vb = null, vs = Infinity;
        for (const g of s.viruses) {
          if (mySz <= g.size * 1.15) continue;                     // moram biti veci da me razbije
          const dr = dist(g, aimKing);
          if (dr > kingSize + (cfg.popNearRecv || 700)) continue;  // mora biti blizu primaoca
          const dg = dist(me, g);
          if (dg > (cfg.popRange || 1500)) continue;
          if (dg + dr < vs) { vs = dg + dr; vb = g; }
        }
        if (vb) return { aim: { x: vb.x, y: vb.y }, dir: norm(sub(vb, me)), _noAvoid: true, note: 'DAJEM: razbijam se o virus' };
      }
      // delovi moraju biti dovoljno mali da ih primalac proguta, i ne veci od
      // ostatka koji zadrzavam -> split-uj jos dok to ne vazi
      const tooBigForRecv = mySz >= kingSize * 0.87;
      const tooBig = tooBigForRecv || (keep > 0 && me.mass / cells > keep * 1.2) || cells === 1;
      if (dKing < reach && cells < 16 && mySz >= cfg.minSplitSize && tooBig && now >= (bot._splitUntil || 0)) {
        bot._splitUntil = now + (cells === 1 ? (cfg.giveFirstSplitCdMs || 300) : (cfg.giveSplitCdMs || 120));
        return { aim: aimKing, dir: dirKing, split: true, note: 'DAJEM masu (split)' };
      }
      // W gubi ~28% mase -> SAMO kad ni 16 delova ni virus ne naprave dovoljno
      // sitne komade za primaoca (ili ako je izricito --feedmode mixed)
      const wLastResort = tooBigForRecv && (cells >= 16 || mySz < cfg.minSplitSize * 1.4);
      if ((wLastResort || mode === 'mixed') && canEject && dKing < kingSize + me.size + cfg.ejectRange) {
        return { aim: aimKing, dir: dirKing, feed: cfg.ejectPerTick, note: 'DAJEM masu (W)' };
      }
      return { aim: aimKing, dir: dirKing, note: 'DAJEM masu' };
    }
  }

  // Ne dajem (skupljam): drzi se blizu primaoca i jedi sve sto moze (hrana,
  // sitniji igraci - lov je vec proveren gore), da bih brzo opet imao sta da dam.
  if (dKing > kingSize + (cfg.stayRange || 900)) {
    const fv = chooseFood(bot, me, s.edible, cfg);
    const blended = fv && (fv[0] * dirKing[0] + fv[1] * dirKing[1]) > 0.3 ? norm(add(scale(dirKing, 0.75), scale(fv, 0.35))) : dirKing;
    return { dir: blended, note: 'idem ka kralju' };
  }
  if (dKing < kingSize + mySz + 60) {
    // preblizu primaocu dok ne dajem - odmakni se da me ne proguta
    return { dir: norm(scale(dirKing, -1)), note: 'skupljam (odmicem)' };
  }
  const fv = chooseFood(bot, me, s.edible, cfg);
  return { dir: fv || dirKing, note: 'skupljam uz kralja' };
}

// Izbor kralja = PRIMAOCA mase.
//  - normalno: najveci pojedinacni blob (maxCell), uz histerezu
//  - PING-PONG: ako je najveci razbijen (posle split-killa, virusa), a postoji
//    CEO saigrac koji moze da proguta njegove delove (ima bar recvMinFrac
//    njegove mase - davalac se split-uje do 16 delova), kruna ODMAH prelazi na
//    celog. Razbijeni mu predaje skoro sve i niko ne ceka spajanje mase.
export function pickKing(cfg, teamCenters, prevKing) {
  if (cfg.king !== 'auto' && cfg.king != null) {
    const k = Number(cfg.king);
    return Number.isFinite(k) ? k : 0;
  }
  const val = (c) => (c ? (c.maxCell || c.size || 0) : -1);
  const whole = (c) => c && (c.cellCount || 1) === 1;
  const massOf = (c) => (c.mass != null ? c.mass : (c.size * c.size) / 100);
  let best = 0, bv = -1;
  for (let i = 0; i < teamCenters.length; i++) {
    const v = val(teamCenters[i]);
    if (v > bv) { bv = v; best = i; }
  }
  if (bv < 0) return prevKing != null ? prevKing : 0;
  const B = teamCenters[best];
  // trenutni kralj ostaje dok je ceo i blizu najboljeg (izbegni treperenje)
  const P = prevKing != null ? teamCenters[prevKing] : null;
  if (pingPongActive(cfg, teamCenters) && (!whole(B) || (P && !whole(P)))) {
    // najveci (ili trenutni kralj) je razbijen -> najveci CEO koji moze da primi
    const frag = whole(B) ? P : B;
    let w = -1, wv = -1;
    for (let i = 0; i < teamCenters.length; i++) {
      const c = teamCenters[i];
      if (!whole(c)) continue;
      if (massOf(c) < massOf(frag) * (cfg.recvMinFrac || 0.06)) continue;
      if (val(c) > wv) { wv = val(c); w = i; }
    }
    if (w >= 0) return w;
  }
  if (P && whole(P) && val(P) >= bv * 0.85) return prevKing;
  return best;
}
