// ASCII "slika okruzenja": spaja ono sto sva tri bota vide u jednu mapu
// i crta je u terminalu. Ovo je taj "stvarati sliku okruzenja" deo.

const LABELS = 'ABCDEFGH';

// Spoji entitete svih botova (dedup po id) + centri tima.
export function mergeWorld(states) {
  const byId = new Map();
  const teamCenters = [];
  let bounds = null;
  for (const st of states) {
    teamCenters.push(st && st.me ? st.me : null);
    if (!st) continue;
    if (st.mapBounds) bounds = st.mapBounds;
    for (const e of st.entities) {
      // Preferiraj "svezije"/vece opise iste celije
      const prev = byId.get(e.id);
      if (!prev || e.size >= prev.size) byId.set(e.id, e);
    }
  }
  return { entities: [...byId.values()], teamCenters, bounds };
}

export function renderMap(world, cfg, meta) {
  const W = cfg.mapWidth, H = cfg.mapHeight;
  const grid = Array.from({ length: H }, () => new Array(W).fill(' '));

  // Centriraj oko tezista zivih botova (ili centra mape).
  const live = world.teamCenters.filter(Boolean);
  let cx, cy;
  if (live.length) {
    cx = live.reduce((a, c) => a + c.x, 0) / live.length;
    cy = live.reduce((a, c) => a + c.y, 0) / live.length;
  } else if (world.bounds) {
    cx = (world.bounds.minx + world.bounds.maxx) / 2;
    cy = (world.bounds.miny + world.bounds.maxy) / 2;
  } else { cx = 7071; cy = 7071; }

  const span = cfg.mapSpan;
  const x0 = cx - span / 2, y0 = cy - span / 2;
  const toCol = (x) => Math.floor(((x - x0) / span) * W);
  const toRow = (y) => Math.floor(((y - y0) / span) * H);

  const put = (x, y, ch) => {
    const c = toCol(x), r = toRow(y);
    if (c >= 0 && c < W && r >= 0 && r < H) grid[r][c] = ch;
  };

  const kingSize = meta.kingCenter ? meta.kingCenter.size : 0;

  // Slojevi (kasniji imaju prioritet): hrana < protivnici < virus < tim
  for (const e of world.entities) {
    if (e.isMine) continue;
    if (e.isFood || e.isEjected) put(e.x, e.y, e.isEjected ? '+' : '.');
  }
  for (const e of world.entities) {
    if (e.isMine || e.isFood || e.isEjected || e.isVirus) continue;
    put(e.x, e.y, e.size > kingSize * 1.1 ? 'X' : 'o');
  }
  for (const e of world.entities) {
    if (e.isVirus) put(e.x, e.y, 'V');
  }
  // Tim (kralj velikim slovom, hranioci njihovim slovom)
  world.teamCenters.forEach((c, i) => {
    if (!c) return;
    const ch = i === meta.kingIndex ? '@' : LABELS[i] || String(i);
    put(c.x, c.y, ch);
  });

  // Sastavi ispis s okvirom.
  const top = '+' + '-'.repeat(W) + '+';
  const lines = [top];
  for (let r = 0; r < H; r++) lines.push('|' + grid[r].join('') + '|');
  lines.push(top);

  // Statistika ispod.
  const stat = world.teamCenters.map((c, i) => {
    const tag = i === meta.kingIndex ? '@' + (LABELS[i] || i) : (LABELS[i] || i);
    if (!c) return `${tag}:mrtav`;
    return `${tag}:${Math.round(c.mass)}`;
  }).join('  ');

  lines.push(`kralj=@${LABELS[meta.kingIndex] || meta.kingIndex}  masa[ ${stat} ]  tik=${meta.tick}`);
  lines.push('legenda: @kralj A/B/C tim  X veci  o manji  V virus  . hrana  + izbacena masa');
  if (meta.notes) lines.push('akcije: ' + meta.notes);
  return lines.join('\n');
}

// Ocisti terminal i ispisi (jednostavan "live" prikaz).
export function drawScreen(text) {
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(text + '\n');
}
