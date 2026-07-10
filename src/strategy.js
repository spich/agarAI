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

// Podeli okolne entitete na kategorije iz ugla "me".
function scan(me, entities, cfg) {
  const threats = [];   // veci protivnici
  const prey = [];      // manji protivnici koje mogu da pojedem
  const food = [];      // pellet-i + tudja izbacena masa
  const teamEject = []; // izbacena masa (nasa hrana kad je blizu)
  const viruses = [];
  for (const e of entities) {
    if (e.isMine) continue;
    if (e.isVirus) { viruses.push(e); continue; }
    if (e.isFood || e.isEjected) {
      food.push(e);
      if (e.isEjected) teamEject.push(e);
      continue;
    }
    // ostalo = tudja "igracka" celija
    if (e.size > me.size * cfg.threatRatio) threats.push(e);
    else if (e.size < me.size * 0.9) prey.push(e);
  }
  return { threats, prey, food, teamEject, viruses };
}

// Vektor bezanja od pretnji (i opasnih viruseva ako sam velik).
function avoidVector(me, s, cfg) {
  let v = [0, 0];
  let danger = false;
  for (const t of s.threats) {
    const d = dist(me, t);
    if (d < cfg.fleeRange) {
      const away = norm(sub(me, t));           // od pretnje ka meni
      v = add(v, scale(away, (cfg.fleeRange - d) / cfg.fleeRange));
      danger = true;
    }
  }
  // Virus je opasan samo ako sam dovoljno veci od njega (podeli me).
  for (const vir of s.viruses) {
    if (me.size > vir.size * cfg.virusRatio && me.size > 130) {
      const d = dist(me, vir);
      if (d < 220) {
        v = add(v, scale(norm(sub(me, vir)), (220 - d) / 220 * 0.8));
        danger = true;
      }
    }
  }
  return { v, danger };
}

// Ka najblizoj hrani (ili tezistu bliske grupe hrane).
function foodVector(me, food) {
  if (!food.length) return null;
  let best = null, bd = Infinity;
  for (const f of food) {
    const d = dist(me, f);
    if (d < bd) { bd = d; best = f; }
  }
  if (!best) return null;
  return norm(sub(best, me));
}

// Odluka za jednog bota. Vraca {dir:[x,y], feed, split, note}.
export function decide(bot, state, ctx) {
  const { cfg } = ctx;
  if (!state || !state.spawned || !state.me) {
    return { respawn: true, note: 'mrtav/cekam spawn' };
  }
  const me = state.me;
  const s = scan(me, state.entities, cfg);
  const isKing = bot.index === ctx.kingIndex;

  // Bezanje ima prioritet nad svime.
  const avoid = avoidVector(me, s, cfg);
  if (avoid.danger) {
    return { dir: norm(avoid.v), feed: 0, note: 'bezim od pretnje' };
  }

  if (isKing) {
    // Kralj: sakupi timsku izbacenu masu (najvrednija hrana), pa lovi
    // plen, pa obicnu hranu.
    if (s.teamEject.length) {
      const v = foodVector(me, s.teamEject);
      if (v) return { dir: v, feed: 0, note: 'kralj kupi masu' };
    }
    if (s.prey.length) {
      let best = null, bd = Infinity;
      for (const p of s.prey) { const d = dist(me, p); if (d < bd) { bd = d; best = p; } }
      const v = norm(sub(best, me));
      // Split-kill ako je plen blizu i znatno manji i ja sam dovoljno velik.
      const doSplit = bd < 260 && me.size > best.size * 1.6 && me.size > 90;
      return { dir: v, split: doSplit, feed: 0, note: 'kralj lovi plen' };
    }
    const fv = foodVector(me, s.food);
    if (fv) return { dir: fv, feed: 0, note: 'kralj jede hranu' };
    // Nista u vidokrugu: idi ka centru mape.
    const c = { x: (state.mapBounds.minx + state.mapBounds.maxx) / 2, y: (state.mapBounds.miny + state.mapBounds.maxy) / 2 };
    return { dir: norm(sub(c, me)), feed: 0, note: 'kralj trazi' };
  }

  // ---- HRANILAC ----
  const king = ctx.teamCenters[ctx.kingIndex];
  if (!king) {
    // Ne znamo gde je kralj (jos nije spawn-ovan): sam jedi hranu.
    const fv = foodVector(me, s.food);
    return { dir: fv || [1, 0], feed: 0, note: 'nema kralja, jedem' };
  }

  const toKing = sub(king, me);
  const dKing = len(toKing);
  const dirKing = norm(toKing);

  // Ako sam premali, prvo malo porastem (kupim hranu ka kralju).
  if (me.size < cfg.minFeedSize) {
    const fv = foodVector(me, s.food);
    // idi ka kralju ali skreni ka hrani usput
    const blended = fv ? norm(add(scale(dirKing, 0.6), scale(fv, 0.6))) : dirKing;
    return { dir: blended, feed: 0, note: 'rastem pre feed-a' };
  }

  if (dKing > cfg.feedRange) {
    // Daleko: putuj ka kralju (kupi hranu usput).
    const fv = foodVector(me, s.food);
    const blended = fv ? norm(add(scale(dirKing, 0.8), scale(fv, 0.3))) : dirKing;
    return { dir: blended, feed: 0, note: 'idem ka kralju' };
  }

  // Blizu kralja: nisani u njega i izbaci masu (W). Da bi masa otisla
  // kralju, pravac misa mora da gadja kralja.
  return { dir: dirKing, feed: cfg.ejectPerTick, note: 'HRANIM kralja' };
}

// Izbor kralja: konfigurisan indeks ili auto = najveca masa.
export function pickKing(cfg, teamCenters) {
  if (cfg.king !== 'auto') {
    const k = Number(cfg.king);
    return Number.isFinite(k) ? k : 0;
  }
  let best = 0, bm = -1;
  for (let i = 0; i < teamCenters.length; i++) {
    const c = teamCenters[i];
    const m = c ? c.mass : -1;
    if (m > bm) { bm = m; best = i; }
  }
  return best;
}
