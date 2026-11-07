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

    // Gde radi mozak: 'page' (default) = u svakom tabu, na svaki paket od
    // servera (~25x/s), komande direktno u socket; 'node' = stari rezim
    // (Node odlucuje svakih --tick ms preko CDP-a - sporo).
    brain: A.brain || 'page',
    brainMs: num(A.brainMs, 35),           // najmanji razmak izmedju dve odluke u stranici
    statusMs: num(A.statusMs, 500),        // koliko cesto Node cita status (samo prikaz)
    respawnDelayMs: num(A.respawnDelay, 700),

    // Parametri strategije - pragovi su PO MASI i relativni na velicinu.
    // BEKSTVO
    threatRatio: num(A.threatRatio, 2.0),  // bezi tek od >=2x mase (moze split-lov)
    fleeFactor: num(A.fleeFactor, 2.0),    // zona bekstva (ja+on)*ovo ...
    splitReach: num(A.splitReach, 380),    // ... ali bar (ja+on)+domet tudjeg splita
    threatBand: num(A.threatBand, 1.3),    // zona zaobilazenja ispred zone bekstva
    fleeExit: num(A.fleeExit, 1.15),       // bekstvo traje dok pretnja nije dalje od zone*ovo
    fleeLatchMs: num(A.fleeLatch, 300),    // minimalno trajanje bekstva
    eaterRatio: num(A.eaterRatio, 1.3),    // >1.3x mase moze da te pojede dodirom -> zaobidji
    eaterAvoid: num(A.eaterAvoid, 1.1),
    virusRatio: num(A.virusRatio, 1.0),    // izbegavaj virus samo ako sam veci od njega * ovo
    virusAvoid: num(A.virusAvoid, 1.15),   // tesan radijus oko virusa = me.size*ovo (+ pola virusa)
    virusPush: num(A.virusPush, 1.1),
    // LOV
    huntRange: num(A.huntRange, 8),        // kralj juri plen do mySz*ovo+300
    feederHuntRange: num(A.feederHuntRange, 2.5), // hranioci jure plen samo ovako blizu
    huntSplit: A.huntSplit !== false,      // split-kill ukljucen (--no-huntSplit iskljucuje)
    splitKillDist: num(A.splitKillDist, 420), // domet mog splita od ivice
    maxHuntCells: num(A.maxHuntCells, 2),  // ne split-uj u lovu ako sam vec u vise od ovoliko delova
    leadMs: num(A.leadMs, 200),            // predvidjanje kretanja plena
    huntLockMs: num(A.huntLock, 900),      // zapocet lov traje bar ovoliko (anti-jitter)
    maxKillSplits: num(A.maxKillSplits, 4),// split-kill do quad splita (x2..x4)
    splitMinPreyFrac: num(A.splitMinPreyFrac, 0.02), // plen vredi split-a ako ima bar ovaj deo moje mase
    huntHoldMs: num(A.huntHold, 250),      // razbijen nosilac zadrzava krunu dok lovi (+ovoliko) - kratko, bez praznog hoda
    commitMs: num(A.commit, 450),          // obicna odluka vazi bar ovoliko (odlucnost)
    escortGap: num(A.escortGap, 180),      // pratnja: razmak od nosioca
    escortAngle: num(A.escortAngle, 140),  // pratnja: ugao iza-levo/iza-desno od smera nosioca
    escortTol: num(A.escortTol, 300),      // pratnja: koliko sme da odstupi od mesta da bi jela
    escortFood: num(A.escortFood, 450),    // pratnja: jede hranu ovoliko oko svog mesta
    huntGiveUpMs: num(A.huntGiveUp, 2500), // odustani od plena ako mu se ovoliko ne priblizavam
    maxTurnDeg: num(A.maxTurn, 180),       // glatko upravljanje: max okret po odluci (180 = iskljuceno; merenje: ogranicenje slabi lov)
    fleeTurnDeg: num(A.fleeTurn, 180),     // ... u bekstvu
    // TIM / HRANJENJE
    feedMode: A.feedmode || 'kamikaze',    // kamikaze = split/uleti u kralja (merenje: najbolje); mixed = + W; eject
    ejectPerTick: num(A.eject, 1),         // W po odluci (odluka ~25x/s)
    ejectRange: num(A.ejectRange, 650),    // pumpaj W kad je kralj blize od (ja+kralj)+ovo
    minEjectSize: num(A.minEjectSize, 60), // ispod ove velicine ne moze W
    minSplitSize: num(A.minSplitSize, 60), // ispod ove velicine ne moze split
    kamiReach: num(A.kamiReach, 1.7),      // split u kralja kad je razmak < (kralj+ja)*ovo
    splitCooldownMs: num(A.splitCd, 1200),
    meetRange: num(A.meetRange, 3500),     // kralj ide u susret saigracu koji mu daje masu
    // DAVANJE MASE: ko je razbijen odmah predaje primaocu (ne ceka spajanje);
    // podrazumevano hranioci daju SVE pa se respawn-uju (najbrzi rast kralja).
    // --pingpong: davalac zadrzi ostatak dovoljan da odmah primi nazad.
    pingPong: A.pingpong === undefined ? 'auto' : A.pingpong,   // auto | --pingpong | --no-pingpong
    pingPongAt: num(A.pingPongAt, 200),    // auto: ping-pong kad neko iz tima ima bar ovoliko mase (~2 kruga 'daj sve')
    giveMinExcess: num(A.giveMinExcess, 30), // daje kad ima bar ovoliko VISKA iznad ostatka
    keepMass: num(A.keepMass, 60),         // ping-pong: ostatak bar ovoliki - da moze da jede krupnu hranu
    keepFrac: num(A.keepFrac, 0.1),        // ... ili ovoliki deo mase sa kojom je poceo da daje
    giveRestMs: num(A.giveRest, 1500),     // pauza posle davanja pre sledeceg
    giveSplitCdMs: num(A.giveSplitCd, 120),// razmak izmedju split-ova dok daje (sitni delovi)
    giveFirstSplitCdMs: num(A.giveFirstSplitCd, 300),
    recvMinFrac: num(A.recvMinFrac, 0.1),  // ceo saigrac prima razbijenog ako ima bar ovaj deo njegove mase
    huntNeedPartner: A.huntNeedPartner !== false, // (--pingpong) kralj split-uje samo kad je partner pored
    partnerRange: num(A.partnerRange, 1600),
    stayRange: num(A.stayRange, 900),      // dok skuplja, drzi se ovoliko blizu primaoca
    // SPLIT ZA KRETANJE: split daje trzaj napred, a manji delovi su brzi
    escapeSplit: A.escapeSplit === true,   // beg splitom kad je pretnja na korak (--escapeSplit; sim: nestabilno)
    escapeGap: num(A.escapeGap, 0.8),      // "na korak" = razmak ivica < mySz*ovo + 40
    escapeMaxCells: num(A.escapeMaxCells, 4),
    escapeSplitCdMs: num(A.escapeSplitCd, 700),
    travelSplit: A.travelSplit === true,   // davalac split-uje ka primaocu da stigne brze (--travelSplit; sim: skodi)
    travelSplitMin: num(A.travelSplitMin, 1200), // samo kad je primalac dalje od ovoga
    travelMaxCells: num(A.travelMaxCells, 4),
    travelSplitCdMs: num(A.travelSplitCd, 600),
    travelSafe: num(A.travelSafe, 900),    // nema pretnji blize od ovoga
    splitFly: num(A.splitFly, 650),        // koliko daleko leti split (provera puta)
    virusPop: A.virusPop !== false,        // davalac se namerno razbije o virus blizu primaoca (--no-virusPop)
    popNearRecv: num(A.popNearRecv, 700),  // virus mora biti ovoliko blizu primaoca
    popRange: num(A.popRange, 1500),       // ... i ovoliko blizu mene
    kingFeedback: A.kingFeedback !== false,
    feedbackCdMs: num(A.feedbackCd, 350),
    safeFactor: num(A.safeFactor, 1.25),   // samo za --feedmode eject
    minFeedRatio: num(A.minFeedRatio, 0.15),
    // HRANA
    turnPenalty: num(A.turnPenalty, 1.5),  // prednost hrani ispred (anti-jitter)
    foodScope: num(A.foodScope, 10),

    // Kontrola: 'protocol' (paketi direktno u socket - default uz --brain page)
    //           'input' (sinteticki mis/tastatura)
    control: A.control || ((A.brain || 'page') === 'page' ? 'protocol' : 'input'),
    moveRadius: num(A.moveRadius, 320),    // samo za 'input': udaljenost misa od centra (px)

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
    // Ispisi svaki nagli okret (>100 stepeni) i koja ga promena odluke izaziva.
    jitterLog: A.jitterLog === true,
    // Dijagnostika: iskljuci BroadcastChannel (tim samo preko Node rezervnog kanala).
    noBroadcast: A.noBroadcast === true,
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
  --brain page|node    Gde odlucuje bot: page (default) = u svakom tabu ~25x/s,
                       komande direktno u socket; node = stari, spori rezim
  --feedmode kamikaze|mixed|eject   Prebacivanje mase (default kamikaze: split/uleti u kralja)
  --no-huntSplit       Iskljuci split-kill lov
  --pingpong / --no-pingpong   Forsiraj ping-pong (zadrzi ostatak) / uvek daj sve; default auto:
                       prvo 'daj sve' dok kralj ne dobije --pingPongAt mase, onda ping-pong
  --no-virusPop        Ne koristi virus za brzo razbijanje pri davanju
  --escapeSplit        Beg splitom kad je pretnja na korak (iskljuceno po defaultu)
  --travelSplit        Brze kretanje splitom ka primaocu (iskljuceno po defaultu)
  --control input|protocol   Nacin slanja komandi (default protocol uz --brain page)
  --capture            Snimi sirove WebSocket frejmove u captures/ (za analizu protokola)
  --debug              Vise logova
  --tick <ms>          Interval petlje u --brain node rezimu (default 120)

Primeri:
  # Prvo proveri da li se okruzenje ispravno cita (bez teaminga):
  node src/index.js --no-team --capture

  # Puni teaming (auto pristanak + Play, mozak u tabovima):
  node src/index.js
`;
