// Centralna konfiguracija. Menja se preko CLI flagova, env varijabli
// ili direktno u ovom fajlu. Sve sto je specificno za konkretan klon
// (agar.rs) drzi se ovde da bi adaptacija bila lak jedan-fajl posao.

function argMap(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key.startsWith('no-')) { out[key.slice(3)] = false; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; }
    else { out[key] = next; i++; }
  }
  return out;
}

const A = argMap(process.argv.slice(2));

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

export function buildConfig() {
  const cfg = {
    // Cilj - klijent za igranje. Svaki tab otvara ovaj URL.
    url: A.url || process.env.AGARAI_URL || 'https://agar.rs/web/4',

    // Koliko botova (tabova). Podrazumevano 3.
    count: num(A.count, 3),
    nicks: (A.nicks ? String(A.nicks).split(',') : ['tripleXa', 'tripleXb', 'tripleXc']),

    // Prikaz prozora. Bez headless podrazumevano da mozes da gledas 3 taba.
    headless: A.headless === true,
    slowmo: num(A.slowmo, 0),
    // Putanja do Chrome/Chromium binarnog fajla (ako Playwright ne moze
    // sam da skine browser). Prazno = Playwright bira sam.
    chromePath: A.chrome || process.env.AGARAI_CHROME || '',

    // Ulazak u igru. Ako nije uspeo auto-join preko selektora,
    // program ceka da ti rucno klikne s Play u svakom tabu.
    manualJoin: A.manualJoin === true || A['manual-join'] === true,
    autoJoinTimeoutMs: num(A.joinTimeout, 20000),
    nickSelector: A.nickSelector || 'input',              // polje za nadimak
    playSelector: A.playSelector || 'button',             // dugme za Play (fallback: prvo dugme)

    // Petlja odlucivanja.
    tickMs: num(A.tick, 120),

    // Teaming: da li botovi salju masu jedan drugom.
    team: A.team !== false,           // --no-team iskljucuje (samo posmatranje/mapa)
    // Ko je kralj: 'auto' (najveci) ili indeks 0..n-1.
    king: A.king === undefined ? 'auto' : (A.king === 'auto' ? 'auto' : num(A.king, 0)),

    // Parametri strategije. RELATIVNI su (u odnosu na velicinu celije), da
    // bi radili na bilo kojoj skali klona (agar.rs koristi vece brojeve).
    threatRatio: num(A.threatRatio, 2.0),  // pretnja tek ako je >2x (moze split-lov); manji te ne stize
    virusRatio: num(A.virusRatio, 1.0),    // izbegavaj virus samo ako sam veci od njega * ovo
    virusAvoid: num(A.virusAvoid, 1.15),   // tesan radijus oko virusa = me.size*ovo (+ pola virusa)
    virusPush: num(A.virusPush, 1.1),      // jacina blagog skretanja oko virusa (prolazi blizu)
    fleeFactor: num(A.fleeFactor, 2.25),   // beži ako je pretnja bliza od (moja+njegova velicina)*ovo
    feedFactor: num(A.feedFactor, 9),      // spoljna granica zone hranjenja = kralj.velicina * ovo
    safeFactor: num(A.safeFactor, 1.25),   // bezbedna distanca od kralja = kralj.velicina * ovo + margin
    minFeedRatio: num(A.minFeedRatio, 0.15),// hranilac manji od kralja*ovo prvo raste, pa hrani
    ejectPerTick: num(A.eject, 2),         // koliko W impulsa po tiku (eject rezim)
    // Nacin hranjenja: 'kamikaze' (split u kralja, brzo, pa restart) ili
    // 'eject' (sporo izbacivanje mase sa bezbedne distance).
    feedMode: A.feedmode || 'kamikaze',
    minSplitSize: num(A.minSplitSize, 45), // ispod ove velicine hranilac ne split-uje (prvo raste)
    kamiReach: num(A.kamiReach, 1.7),      // split kad je razmak < (kralj+ja velicine)*ovo
    splitCooldownMs: num(A.splitCd, 1600), // razmak izmedju split-ova (da se ne izmnozi u 16 delova)
    fleeLatchMs: num(A.fleeLatch, 450),    // koliko ostaje u bekstvu posle detekcije pretnje (anti-jitter)
    kingSplit: A.kingSplit === true,       // da li kralj sme da se split-uje u lovu (default NE - masa na hrpi)
    kingFeedback: A.kingFeedback !== false,// kralj dobaci malo mase sitnom suigracu (rotacija)
    foodScope: num(A.foodScope, 10),       // gledaj samo hranu blizu (me.size*ovo) - anti-jitter

    // Kontrola: 'input' (sinteticki mis/tastatura, najotpornije)
    //           'protocol' (salji pakete direktno preko socketa)
    control: A.control || 'input',
    moveRadius: num(A.moveRadius, 320),    // koliko daleko od centra ekrana stavljamo mis (px)

    // Mapa okruzenja u terminalu.
    map: A.map !== false,
    mapWidth: num(A.mapWidth, 60),
    mapHeight: num(A.mapHeight, 24),
    mapSpan: num(A.mapSpan, 4000),         // koliko sveta (u jedinicama) mapa pokriva oko tima

    // Debug: snimi sirove WS frejmove za analizu protokola.
    capture: A.capture === true,
    captureDir: A.captureDir || 'captures',
    debug: A.debug === true,
    // Dijagnostika: ispisi jednom razlozeno stanje sveta (velicine hrane,
    // igraca, granice mape) da bi se pragovi fino nastelovali.
    diag: A.diag === true,
    // Sniff: ispisi hex paketa uzivo u terminal (za rekonstrukciju protokola).
    sniff: A.sniff === true,
  };
  // Diag/sniff ispisuju tekst koji bi mapa obrisala -> ugasi mapu.
  if (cfg.diag || cfg.sniff) cfg.map = false;
  return cfg;
}

export const HELP = `
agarai - trobotni agar.rs teaming simulator

Koriscenje:
  node src/index.js [opcije]

Najkorisnije opcije:
  --url <URL>          Klijent za igranje (default: https://agar.rs/web/4)
  --count <n>          Broj botova/tabova (default 3)
  --nicks a,b,c        Nadimci (default tripleXa,tripleXb,tripleXc)
  --headless           Bez prozora (default: prikazuje tabove)
  --chrome <putanja>   Rucno zadaj Chrome/Chromium binarni fajl
  --manual-join        Ti sam klikni Play u svakom tabu; bot preuzima kad udjes
  --king auto|<idx>    Ko je dominantni bot (default auto = najveci)
  --no-team            Ne dodaji masu, samo posmatraj i crtaj mapu
  --map / --no-map     Uljuci/iskljuci ASCII mapu okruzenja (default ukljuceno)
  --control input|protocol   Nacin slanja komandi (default input)
  --capture            Snimi sirove WebSocket frejmove u captures/ (za analizu protokola)
  --debug              Vise logova
  --tick <ms>          Interval petlje odlucivanja (default 120)

Primeri:
  # Prvo proveri da li se okruzenje ispravno cita (bez teaminga):
  node src/index.js --no-team --capture

  # Puni teaming, ti sam udjes u igru u sva 3 taba:
  node src/index.js --manual-join
`;
