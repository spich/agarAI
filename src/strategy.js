// Odlucivanje po botu. Kralj raste i lovi; hranioci mu prilaze i
// izbacuju masu. Svi beze od vecih protivnika i (ako su veliki) viruseva.
//
// Vazno: svaki bot "vidi" samo svoj vidokrug. Poziciju kralja delimo
// preko koordinatora (ctx.teamCenters) - svaki bot pouzdano zna svoj
// centar, pa hranioci mogu da krenu ka kralju i pre nego sto ga vide.

function sub(a, b) { return [a.x - b.x, a.y - b.y]; }
function len(v) { return Math.hypot(v[0], v[1]) || 1e-6; }
function norm(v) { const l = len(v); return [v[0] / l, v[1] / l]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function scale(v, s) { return [v[0] * s, v[1] * s]; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }

// Kom saigracu pripada celija? Vraca indeks bota ili -1.
// Primarno po IMENU (agar.rs salje ime uz svaku igracku celiju, pa i uz
// split-delove), jer su delovi split-ovanog kralja daleko od njegovog
// centroida pa ih pozicija ne prepoznaje -> hranilac je bezao od kralja.
// Neimenovane celije (pellet-i, izbacena masa) nisu saigraci.
// Pozicija je samo rezerva kad nadimci nisu poznati.
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

// Podeli okolne entitete na kategorije iz ugla "me".
// KLJUCNO: "edible" mora biti stvarno MANJE od mene, inace bot juri hranu
// koju ne moze da pojede. Pellet-e (isFood, mala masa) tolerisemo malo vece.
// Pragovi su po MASI (masa ~ size^2), jer tako radi igra:
//  - pojesti te moze ko ima >1.3x tvoje mase (dodirom)
//  - split-om te moze uloviti ko ima >~2x tvoje mase (pola mase mu i dalje
//    pojede tebe) -> to je prava pretnja (cfg.threatRatio, po masi)
// Gledamo NAJVECU svoju celiju (maxCell): ona jede, a razbijen bot je ranjiv.
function scan(me, entities, cfg, ctx, selfIndex, isKing) {
  const threats = [];   // ko god moze da me pojede (>eaterRatio mase)
  const edible = [];    // sve sto realno mogu da pojedem
  const teamEject = []; // izbacena masa / delovi saigraca (najvrednije za kralja)
  const viruses = [];
  const mySz = me.maxCell || me.size;
  const eatCap = mySz * 0.87;         // plen: treba mi ~1.3x mase (size 1.14x)
  const foodCap = mySz * 1.15;        // pellet: mala masa, moze i malo veci
  const eaterSz = mySz * Math.sqrt(cfg.eaterRatio || 1.3);
  for (const e of entities) {
    if (e.isMine) continue;
    if (e.isVirus) { viruses.push(e); continue; }
    const tm = teammateOf(e, ctx, selfIndex);
    if (tm >= 0) {
      // Kralj aktivno usisava delove saigraca koji se vec razbio (kamikaza)
      // -> masa se brze skuplja na hrpu. Celog saigraca ne dira.
      const t = ctx.teamCenters && ctx.teamCenters[tm];
      if (isKing && t && t.cellCount > 1 && e.size < eatCap) { teamEject.push(e); edible.push(e); }
      continue;
    }
    if (e.isEjected) { teamEject.push(e); if (e.size < eatCap) edible.push(e); continue; }
    if (e.isFood) { if (e.size < foodCap) edible.push(e); continue; }
    // tudja igracka celija: veca = (moguca) pretnja, dovoljno manja = plen
    if (e.size > eaterSz) threats.push(e);
    else if (e.size < eatCap) edible.push(e);
  }
  return { threats, edible, teamEject, viruses };
}

// Dva nivoa opasnosti + virusi:
//  - "splitter" (>= threatRatio mase): pravo bekstvo (+latch)
//  - "eater" (1.3x..threatRatio mase): sporiji je od mene, samo ga ne diraj
//    -> blago odbijanje (kao virus), bez bekstva
//  - virus: tesno zaobilazenje, samo ako sam veci od njega
function avoidVector(me, s, cfg) {
  let v = [0, 0];
  let threat = false;
  let near = false;               // pretnja jos u zoni izlaza (histereza po daljini)
  let nearVec = [0, 0];
  const soft = [];                // meke prepreke, svaka POSEBNO: {u: smer ka njoj, k: jacina 0..1}
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
      // Zona bekstva mora pokriti i DOMET SPLITA (split leti priblizno istu
      // daljinu bez obzira na velicinu), ne samo zbir velicina.
      const r = Math.max((mySz + t.size) * cfg.fleeFactor, mySz + t.size + (cfg.splitReach || 0));
      const band = cfg.threatBand || 1.6;
      if (d < r) { v = add(v, scale(norm(sub(me, t)), (r - d) / r)); threat = true; }
      if (d < r * (cfg.fleeExit || 1.25)) { near = true; nearVec = add(nearVec, norm(sub(me, t))); }
      if (d >= r && d < r * band) {
        // Zona ZAOBILAZENJA ispred zone bekstva: blago odbijanje (+ tangenta u
        // decide) -> putanja ide u luku oko pretnje, a ne pravo nazad kroz nju
        // posle bekstva (to je bila petlja napred-nazad).
        addSoft(t, (r * band - d) / (r * (band - 1)));
      }
    } else {
      const r = (mySz + t.size) * (cfg.eaterAvoid || 1.4);
      if (d < r) addSoft(t, (r - d) / r);
    }
  }
  for (const g of s.viruses) {
    if (mySz > g.size * cfg.virusRatio) {              // samo ako me virus moze podeliti
      const d = dist(me, g);
      const r = mySz * cfg.virusAvoid + g.size * 0.5;  // tesno oko virusa
      if (d < r) {
        // Strmo: ~0 na ivici zone, PUNA snaga kad se priblizimo tacki pucanja
        // (centar virusa ulazi u mene). Tako prolazi blizu, ali ne dodiruje.
        const popD = mySz - g.size * 0.4;
        addSoft(g, Math.min(1, (r - d) / Math.max(30, r - popD)) * 1.5);
      }
    }
  }
  return { v, threat, near, nearVec, soft };
}

// Ka najblizoj hrani, sa HISTEREZOM i SCOPE-om: gledaj samo hranu u dometu
// (me.size*foodScope) i drzi prethodni cilj dok je razumno blizu -> bot ne
// menja metu svaki tik i ne vrti se u mestu.
// Dodatno: prednost hrani ISPRED (kazna za okretanje), da posle svakog
// pojedenog pellet-a ne okrece 180 stepeni ka onom iza sebe (jitter).
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
    const c = (h[0] * (f.x - me.x) + h[1] * (f.y - me.y)) / d;   // cos ugla
    return d * (1 + turnPen * (1 - c) / 2);                      // iza = do (1+turnPen)x dalje
  };
  let best = null, bs = Infinity;
  for (const f of pool) { const sc = score(f); if (sc < bs) { bs = sc; best = f; } }
  if (bot._targetId != null) {
    const old = pool.find((e) => e.id === bot._targetId);
    if (old && score(old) < bs * 1.5) best = old;
  }
  bot._targetId = best.id;
  return norm(sub(best, me));
}

// Odluka za jednog bota. Vraca {dir:[x,y], feed, split, note}.
// Javna odluka: pozovi jezgro pa primeni BLAGO zaobilazenje virusa na
// pravac (osim kad bezimo/ne krecemo se) - da bot prodje blizu virusa
// umesto da pravi siroki obilazak.
export function decide(bot, state, ctx) {
  const res = decideCore(bot, state, ctx);
  // Ne diraj pravac kad nisanimo (split/feed idu tacno u pravcu misa).
  // I TOKOM BEKSTVA zaobilazi viruse - inace begunac uleti pravo u virus,
  // razbije se i pojedu ga.
  if (res && res.dir && bot._soft && bot._soft.length && !res.split && !res.feed) {
    let nd = [res.dir[0], res.dir[1]];
    // Najjace prepreke prve. Za svaku: ukloni komponentu kretanja KA njoj i
    // zameni je tangentom -> bot KLIZI oko prepreke (orbitira) umesto da se
    // spiralno uvlaci u nju; plus blago guranje napolje kad je tik uz nju.
    for (const { u, k } of [...bot._soft].sort((a, b) => b.k - a.k)) {
      const inward = nd[0] * u[0] + nd[1] * u[1];
      if (inward > 0) {
        let t = [-u[1], u[0]];
        if (t[0] * nd[0] + t[1] * nd[1] < 0) t = [u[1], -u[0]];
        nd = [nd[0] - u[0] * inward * k + t[0] * inward * k, nd[1] - u[1] * inward * k + t[1] * inward * k];
      }
      nd = [nd[0] - u[0] * k * 0.3, nd[1] - u[1] * k * 0.3];
    }
    res.dir = norm(nd);
  }
  if (res && res.dir) bot._heading = res.dir;      // za izbor hrane "ispred sebe"
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

  // Bezanje ima prioritet. LATCH protiv jittera: kad se pretnja pojavi,
  // ostani u bekstvu jos fleeLatchMs i posle nego sto nakratko izadje iz
  // dometa - da se ne prebacujes akcija/ne-akcija svaki tik.
  const avoid = avoidVector(me, s, cfg);
  bot._soft = avoid.soft;                               // meko zaobilazenje se primenjuje u decide()
  if (avoid.threat) { bot._fleeUntil = now + cfg.fleeLatchMs; bot._fleeVec = avoid.v; bot._fleeing = true; }
  // Histereza: ko je vec u bekstvu, nastavlja dok pretnja nije OSETNO dalje
  // (fleeExit), a ne cim izadje iz zone - inace ga progonitelj odmah sustigne
  // i nastaje petlja bezim <-> jurim.
  const stillNear = bot._fleeing && avoid.near;
  if (avoid.threat || stillNear || (bot._fleeUntil && now < bot._fleeUntil)) {
    const v = avoid.threat ? avoid.v : (stillNear ? avoid.nearVec : (bot._fleeVec || [1, 0]));
    return { dir: norm(v), speed: 1, feed: 0, _flee: true, note: avoid.threat ? 'bezim od pretnje' : 'bezim (inercija)' };
  }
  bot._fleeing = false;

  if (isKing) {
    // Kralj drzi masu NA HRPI: ne split-uje se (osim ako --kingSplit).
    // Prvo dobaci malo mase sitnom suigracu (rotacija), pa kupi masu/hranu.
    // Dobacivanje: samo saigracu koji je PREMALI da bi se uopste split-ovao
    // (svaki W gubi ~28% mase, pa dobacivanje vecem pa vracanje = gubitak).
    if (cfg.kingFeedback && me.size > 120 && now >= (bot._fbUntil || 0)) {
      let t = null, td = Infinity;
      for (const tm of teammates) {
        if ((tm.cellCount || 1) === 1 && (tm.maxCell || tm.size) < cfg.minSplitSize) {
          const d = dist(me, tm); if (d < td) { td = d; t = tm; }
        }
      }
      if (t && td < me.size * 4) {
        bot._fbUntil = now + (cfg.feedbackCdMs || 350);
        return { dir: norm(sub(t, me)), speed: 0.5, feed: 1, note: 'kralj dobacuje suigracu' };
      }
    }
    if (s.teamEject.length) {
      const v = chooseFood(bot, me, s.teamEject, cfg);
      if (v) return { dir: v, feed: 0, note: 'kralj kupi masu' };
    }
    // Idi U SUSRET saigracu koji je spreman da se ubaci (ili se vec razbio):
    // iste smo brzine, pa bi ga hranilac inace jurio u nedogled.
    {
      const ready = Math.max(cfg.minSplitSize, me.size * cfg.minFeedRatio);
      const ok = (tm) => tm && ((tm.cellCount || 1) > 1 || tm.size >= ready);
      let ti = -1, td = Infinity;
      ctx.teamCenters.forEach((tm, i) => {
        if (i === bot.index || !ok(tm)) return;
        const d = dist(me, tm); if (d < td) { td = d; ti = i; }
      });
      // histereza: drzi istog hranioca dok drugi nije OSETNO blizi
      const prev = bot._meetIdx;
      if (prev != null && prev !== ti && ok(ctx.teamCenters[prev])) {
        const pd = dist(me, ctx.teamCenters[prev]);
        if (pd < td * 1.6) { ti = prev; td = pd; }
      }
      if (ti >= 0 && td < (cfg.meetRange || 3500) && td > me.size * 0.8) {
        bot._meetIdx = ti;
        bot._targetId = null;
        return { dir: norm(sub(ctx.teamCenters[ti], me)), note: 'kralj ide po masu' };
      }
      bot._meetIdx = null;
    }
    if (s.edible.length) {
      let best = null, bd = Infinity;
      for (const e of s.edible) { const d = dist(me, e); if (d < bd) { bd = d; best = e; } }
      const v = chooseFood(bot, me, s.edible, cfg);
      const doSplit = cfg.kingSplit && bd < (me.size + best.size) * 1.4 && me.size > best.size * 2.2;
      return { dir: v, split: doSplit, feed: 0, note: doSplit ? 'kralj split-lov' : 'kralj jede' };
    }
    bot._targetId = null;
    const c = { x: (state.mapBounds.minx + state.mapBounds.maxx) / 2, y: (state.mapBounds.miny + state.mapBounds.maxy) / 2 };
    return { dir: norm(sub(c, me)), feed: 0, note: 'kralj trazi' };
  }

  // ---- HRANILAC ----
  const king = ctx.teamCenters[ctx.kingIndex];
  if (!king) {
    const fv = chooseFood(bot, me, s.edible, cfg);
    return { dir: fv || [1, 0], feed: 0, note: 'nema kralja, jedem' };
  }

  const toKing = sub(king, me);
  const dKing = len(toKing);
  const dirKing = norm(toKing);
  const kingSize = king.size || 0;

  // Dok sam premali da bih se split-ovao/isplatio, prvo rastem (jedem okolo).
  const readySize = Math.max(cfg.minSplitSize, kingSize * cfg.minFeedRatio);
  if (me.cellCount <= 1 && me.size < readySize) {
    const fv = chooseFood(bot, me, s.edible, cfg);
    return { dir: fv || dirKing, feed: 0, note: 'rastem pre feed-a' };
  }

  if (cfg.feedMode === 'kamikaze') {
    // Ako sam vec fragmentisan (vise segmenata) - NE split-uj vise (da se ne
    // izmnozim u 16 delova); samo se ceo utrci u kralja da me pojede (masa
    // ostaje na hrpi kod kralja).
    if (me.cellCount > 1) {
      return { dir: dirKing, speed: 1, note: 'ubacujem se u kralja' };
    }
    // Ceo sam: pridji i SPLIT-uj se JEDNOM u kralja (cooldown protiv mnozenja).
    const reach = (kingSize + me.size) * cfg.kamiReach;
    if (dKing < reach && now >= (bot._splitUntil || 0)) {
      bot._splitUntil = now + cfg.splitCooldownMs;
      return { dir: dirKing, speed: 1, split: true, note: 'KAMIKAZA split u kralja' };
    }
    return { dir: dirKing, speed: 1, note: 'jurim kralja (kamikaza)' };
  }

  // ---- EJECT rezim (alternativa): hrani W-om sa bezbedne distance ----
  const safeDist = kingSize * cfg.safeFactor + Math.max(40, me.size);
  const feedOuter = kingSize * cfg.feedFactor;
  if (dKing < safeDist * 0.9) {
    return { dir: norm(scale(dirKing, -1)), speed: 1, feed: 0, note: 'odmicem od kralja' };
  }
  if (dKing > feedOuter) {
    const fv = chooseFood(bot, me, s.edible, cfg);
    const blended = fv ? norm(add(scale(dirKing, 0.85), scale(fv, 0.25))) : dirKing;
    return { dir: blended, feed: 0, note: 'idem ka kralju' };
  }
  return { dir: dirKing, speed: 0.28, feed: cfg.ejectPerTick, note: 'HRANIM kralja' };
}

// Izbor kralja. Auto = bot sa najvecim POJEDINACNIM blobom (maxCell), ne
// ukupnom masom - da fragmentisan bot (posle split-a) ne ostane kralj dok
// mu se masa ne spoji. Histereza da se kruna ne prebacuje svaki tik.
export function pickKing(cfg, teamCenters, prevKing) {
  if (cfg.king !== 'auto') {
    const k = Number(cfg.king);
    return Number.isFinite(k) ? k : 0;
  }
  const val = (c) => (c ? (c.maxCell || c.size || 0) : -1);
  let best = 0, bv = -1;
  for (let i = 0; i < teamCenters.length; i++) {
    const v = val(teamCenters[i]);
    if (v > bv) { bv = v; best = i; }
  }
  // Zadrzi trenutnog kralja ako je i dalje blizu najboljeg (izbegni treperenje).
  if (prevKing != null && teamCenters[prevKing] && val(teamCenters[prevKing]) >= bv * 0.85) {
    return prevKing;
  }
  return best;
}
