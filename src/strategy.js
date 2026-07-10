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

// Da li je celija zapravo saigrac (blizu poznatog centra saigraca)?
// Igra ne zna za tim, pa saigrace prepoznajemo po poziciji da ih ne bismo
// tretirali kao pretnju/plen (i da hranilac ne bezi od svog kralja).
function isTeammate(e, teammates) {
  for (const t of teammates) {
    if (!t) continue;
    const d = Math.hypot(e.x - t.x, e.y - t.y);
    if (d < Math.max(e.size, t.size || 0) * 0.6 + 120) return true;
  }
  return false;
}

// Podeli okolne entitete na kategorije iz ugla "me".
// KLJUCNO: "edible" mora biti stvarno MANJE od mene, inace bot juri hranu
// koju ne moze da pojede. Pellet-e (isFood, mala masa) tolerisemo malo vece.
function scan(me, entities, cfg, teammates) {
  const threats = [];   // veci protivnici
  const edible = [];    // sve sto realno mogu da pojedem
  const teamEject = []; // izbacena masa (najvrednija hrana za kralja)
  const viruses = [];
  const eatCap = me.size * 0.9;       // plen/masa: moram biti veci
  const foodCap = me.size * 1.15;     // pellet: mala masa, moze i malo veci
  for (const e of entities) {
    if (e.isMine) continue;
    if (e.isVirus) { viruses.push(e); continue; }
    if (e.isEjected) { teamEject.push(e); if (e.size < eatCap) edible.push(e); continue; }
    if (isTeammate(e, teammates)) continue;      // ignorisi svoje botove
    if (e.isFood) { if (e.size < foodCap) edible.push(e); continue; }
    // igracka celija: veca = pretnja, dovoljno manja = plen (jestivo)
    if (e.size > me.size * cfg.threatRatio) threats.push(e);
    else if (e.size < eatCap) edible.push(e);
  }
  return { threats, edible, teamEject, viruses };
}

// Vektor bezanja od pretnji (i opasnih viruseva ako sam velik).
// Radijus opasnosti je RELATIVAN: skalira se sa velicinama celija.
function avoidVector(me, s, cfg) {
  let v = [0, 0];
  let danger = false;
  for (const t of s.threats) {
    const d = dist(me, t);
    const r = (me.size + t.size) * cfg.fleeFactor;   // relativni radijus opasnosti
    if (d < r) {
      const away = norm(sub(me, t));
      v = add(v, scale(away, (r - d) / r));
      danger = true;
    }
  }
  // Virus je opasan samo ako sam dovoljno veci od njega (podeli me).
  for (const vir of s.viruses) {
    if (me.size > vir.size * cfg.virusRatio) {
      const d = dist(me, vir);
      const r = (me.size + vir.size) * 1.5;
      if (d < r) {
        v = add(v, scale(norm(sub(me, vir)), (r - d) / r * 0.8));
        danger = true;
      }
    }
  }
  return { v, danger };
}

// Ka najblizoj hrani, sa HISTEREZOM: drzi prethodni cilj dok je razumno
// blizu, da bot ne bi menjao metu svaki tik i vrteo se u mestu.
function chooseFood(bot, me, list) {
  if (!list || !list.length) { bot._targetId = null; return null; }
  let best = null, bd = Infinity;
  for (const f of list) { const d = dist(me, f); if (d < bd) { bd = d; best = f; } }
  if (bot._targetId != null) {
    const old = list.find((e) => e.id === bot._targetId);
    if (old) { const od = dist(me, old); if (od < bd * 1.5) { best = old; bd = od; } }
  }
  bot._targetId = best.id;
  return norm(sub(best, me));
}

// Odluka za jednog bota. Vraca {dir:[x,y], feed, split, note}.
export function decide(bot, state, ctx) {
  const { cfg } = ctx;
  if (!state || !state.spawned || !state.me) {
    return { respawn: true, note: 'mrtav/cekam spawn' };
  }
  const me = state.me;
  const teammates = ctx.teamCenters.filter((c, i) => i !== bot.index && c);
  const s = scan(me, state.entities, cfg, teammates);
  const isKing = bot.index === ctx.kingIndex;

  // Bezanje ima prioritet nad svime.
  const avoid = avoidVector(me, s, cfg);
  if (avoid.danger) {
    return { dir: norm(avoid.v), feed: 0, note: 'bezim od pretnje' };
  }

  if (isKing) {
    // Kralj: sakupi timsku izbacenu masu (najvrednija hrana), pa bilo sta
    // jestivo (hrana/plen). Split-kill ako je plen blizu i znatno manji.
    if (s.teamEject.length) {
      const v = chooseFood(bot, me, s.teamEject);
      if (v) return { dir: v, feed: 0, note: 'kralj kupi masu' };
    }
    if (s.edible.length) {
      let best = null, bd = Infinity;
      for (const e of s.edible) { const d = dist(me, e); if (d < bd) { bd = d; best = e; } }
      const v = chooseFood(bot, me, s.edible);
      const doSplit = bd < (me.size + best.size) * 1.4 && me.size > best.size * 2.2;
      return { dir: v, split: doSplit, feed: 0, note: doSplit ? 'kralj split-lov' : 'kralj jede' };
    }
    // Nista u vidokrugu: idi ka centru mape.
    bot._targetId = null;
    const c = { x: (state.mapBounds.minx + state.mapBounds.maxx) / 2, y: (state.mapBounds.miny + state.mapBounds.maxy) / 2 };
    return { dir: norm(sub(c, me)), feed: 0, note: 'kralj trazi' };
  }

  // ---- HRANILAC ----
  const king = ctx.teamCenters[ctx.kingIndex];
  if (!king) {
    const fv = chooseFood(bot, me, s.edible);
    return { dir: fv || [1, 0], feed: 0, note: 'nema kralja, jedem' };
  }

  const toKing = sub(king, me);
  const dKing = len(toKing);
  const dirKing = norm(toKing);
  const kingSize = king.size || 0;

  // Dok sam premali da bih se split-ovao/isplatio, prvo rastem (jedem okolo).
  const readySize = Math.max(cfg.minSplitSize, kingSize * cfg.minFeedRatio);
  if (me.size < readySize) {
    const fv = chooseFood(bot, me, s.edible);
    return { dir: fv || dirKing, feed: 0, note: 'rastem pre feed-a' };
  }

  if (cfg.feedMode === 'kamikaze') {
    // KAMIKAZA: pridji kralju i SPLIT-uj se u njega (pola mase odleti, kralj
    // je odmah pojede - brz transfer), pa se zrtvuj i restartuj. Split-ujem
    // kad je razmak dovoljno mali da kralj uhvati odbaceni deo.
    const reach = (kingSize + me.size) * cfg.kamiReach;
    if (dKing < reach) {
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
    const fv = chooseFood(bot, me, s.edible);
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
