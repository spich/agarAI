# agarAI — trobotni agar.rs teaming simulator

Alat koji iz tvoje komandne linije vodi **tri zasebna taba** (`tripleXa`,
`tripleXb`, `tripleXc`) kao tri odvojena igrača na [agar.rs](https://agar.rs/web/4).
Botovi se ponašaju kao tim: jedan je **kralj** (dominantni), a druga dva mu
**prilaze i dodaju masu** (izbacuju `W` u njega) da bi kralj brzo narastao i
dominirao igrom. Uz to, alat u realnom vremenu crta **sliku okruženja** (ASCII
mapu) spojenu iz svega što sva tri bota vide.

> Namena: automatizacija igre / botovanje u agar klonu. Koristi na svoju
> odgovornost i u skladu sa pravilima servera.

## Kako radi (ukratko)

Svaki tab ima **sopstveni mozak** (`src/strategy.js` ubačen u stranicu) koji
odlučuje na svaki paket od servera (~25×/s) i šalje komande **direktno u
socket** (agar.rs protokol). Tabovi tima dele pozicije preko
`BroadcastChannel`-a. Node samo pokreće tabove, prikazuje status i po potrebi
klikne Play. Rutine po prioritetu: **bekstvo** (≥2× mase) → **split-kill**
(plen dovoljno mali, u dometu, sa predviđanjem kretanja) → **lov** → kralj
**kupi masu / ide u susret hraniocu** → hranilac **se split-uje u kralja**
(razbijen uleti ceo; `--feedmode mixed` dodaje i W) → hrana.

## Kako radi (detaljno)

```
┌─ Node koordinator (tvoj komp) ─────────────────────────────┐
│  svakih ~120ms: čita stanje 3 bota → spaja mapu →          │
│  bira kralja → odlučuje (kralj/hranilac/beži) → šalje       │
│  komande → crta ASCII mapu                                  │
└───────────┬───────────────┬───────────────┬────────────────┘
            │               │               │
       ┌────▼────┐     ┌────▼────┐     ┌────▼────┐
       │  Tab A  │     │  Tab B  │     │  Tab C  │   (Chromium, Playwright)
       │ tripleXa│     │ tripleXb│     │ tripleXc│
       └────┬────┘     └────┬────┘     └────┬────┘
            │ hook           │ hook          │ hook
            ▼                ▼               ▼
     window.WebSocket zakačen → dekodira agar protokol →
     window.__AGARAI.getState() / .command()
```

- **Čitanje sveta:** u svaki tab se ubaci `src/inject/agarhook.js` koji zakači
  `WebSocket` igre i dekodira agar binarni protokol (klasični Ogar/vanilla
  format — opcode 16 update, 32 moja ćelija, 64 mapa). Izloži živo stanje:
  moja pozicija/masa + svi entiteti (hrana, virusi, protivnici, izbačena masa).
- **Kontrola:** komande se šalju kao sintetički miš/tastatura događaji
  (pravac = pozicija miša od centra ekrana; `W` = feed; `Space` = split). Ovo
  je najotpornije na konkretan klon. Alternativa `--control protocol` šalje
  pakete direktno preko socketa.
- **Strategija** (`src/strategy.js`): kralj kupi timsku izbačenu masu → lovi
  plen → jede hranu; hranioci prilaze kralju i izbacuju masu; svi beže od
  većih protivnika i (ako su veliki) viruseva.

## Instalacija

```bash
npm install
npx playwright install chromium   # skine browser (jednom)
```

## Pokretanje

```bash
# 1) PRVO proveri da li se okruženje ispravno čita na agar.rs (bez teaminga).
#    Otvoriće 3 taba; uđi sam u igru pa gledaj da li se mapa lepo crta:
node src/index.js --no-team --manual-join --capture

# 2) Kad mapa izgleda tačno — puni teaming:
node src/index.js --manual-join
```

`--manual-join` je najsigurniji start: ti sam uneseš nadimak i klikneš Play u
sva 3 taba, a bot preuzima čim uđeš. Kad podesiš selektore za agar.rs (vidi
dole), možeš i bez njega (auto-join).

## Najkorisnije opcije

| Opcija | Opis |
|---|---|
| `--url <URL>` | Klijent za igranje (default `https://agar.rs/web/4`) |
| `--nicks a,b,c` | Nadimci (default `tripleXa,tripleXb,tripleXc`) |
| `--king auto\|<idx>` | Ko je dominantni bot (default `auto` = najveći) |
| `--no-team` | Samo posmatraj i crtaj mapu, ne dodaji masu |
| `--manual-join` | Ti sam uđeš u igru; bot preuzima kad uđeš |
| `--headless` | Bez prozora |
| `--control input\|protocol` | Način slanja komandi (default `input`) |
| `--capture` | Snimi sirove WebSocket frejmove u `captures/` |
| `--chrome <putanja>` | Ručno zadaj Chrome binarni fajl |
| `--tick <ms>` | Interval petlje (default 120) |

### Štelovanje ponašanja

Pragovi pretnje su **po masi** (kao u igri), ne po veličini.

| Opcija | Default | Šta radi |
|---|---|---|
| `--brain page\|node` | page | Mozak u tabu (brzo) ili stari Node režim |
| `--feedmode` | kamikaze | `kamikaze` = split/uleti u kralja (merenje: najbolje); `mixed` = + W; `eject` |
| `--huntRange` / `--no-huntSplit` | 8 / uključen | Domet lova kralja (`veličina×ovo+300`) / split-kill |
| `--splitKillDist` / `--maxHuntCells` | 420 / 2 | Domet mog splita / ne split-uj ako sam već u više delova |
| `--huntLock` / `--huntGiveUp` | 900 / 2500 | Drži započet lov / odustani ako se ne približavam (ms) |
| `--ejectRange` | 650 | Hranilac pumpa W kad je kralj bliži od `(ja+kralj)+ovo` |
| `--maxTurn` | 180 (isklj.) | Ograničenje okretanja po odluci (merenje: slabi lov) |
| `--threatRatio` | 2.0 | Beži tek od protivnika sa ≥2× tvoje mase (može te split-ovati) |
| `--eaterRatio` / `--eaterAvoid` | 1.3 / 1.1 | 1.3–2× mase: ne beži, samo ga zaobiđi |
| `--splitReach` | 380 | Domet tuđeg splita — zona bekstva ga uvek pokriva |
| `--fleeFactor` | 2.0 | Veličina zone bekstva `(ja+on)×ovo` |
| `--threatBand` | 1.3 | Zona zaobilaženja oko pretnje (klizi oko nje, ne vraća se kroz nju) |
| `--fleeExit` / `--fleeLatch` | 1.15 / 300 | Bekstvo traje dok pretnja nije dalje od zone×ovo / bar ovoliko ms |
| `--virusAvoid` / `--virusPush` | 1.15 / 1.1 | Koliko blizu prolazi virusu / koliko jako skreće |
| `--kamiReach` / `--splitCd` | 1.7 / 1200 | Kad se split-uje u kralja / razmak između splitova |
| `--meetRange` | 3500 | Kralj ide u susret spremnom hraniocu do ove daljine |
| `--turnPenalty` | 1.5 | Prednost hrani ispred (manje okretanja); 0 = najbliža |
| `--foodScope` | 10 | Gleda hranu samo do `veličina×ovo` |
| `--jitterLog` | isključeno | Ispiši svaki nagli okret i koja ga odluka izaziva |

Pun spisak: `node src/index.js --help`.

## Testiranje

```bash
npm test          # brzi unit testovi (dekoder na pravim agar.rs frejmovima, kontrola, strategija)
npm run sim       # 60s simulacija: lokalni "agar.rs" + pravi alat + izveštaj
```

`npm run sim` podiže lokalni server koji govori **isti protokol kao agar.rs**
(MultiOgar-Edited), sa consent prozorom, Play dugmetom, hranom, virusima i 6 AI
protivnika, pa pokrene ovaj alat (3 taba, headless) i na kraju ispiše tabelu:
smrti (od tima / od neprijatelja), max masa kralja, prenos mase u timu, dupli
split-ovi, pucanja na virusu, nagli okreti po uzroku — i PASS/FAIL provere.
Snimci cele mape i log su u `sim-out/`.

```bash
node test/sim/run.mjs --seconds 90 --seed 2              # duže, ponovljiv svet
node test/sim/run.mjs -- --feedmode eject --threatRatio 2.5   # podešavanja alatu posle --
node test/sim/run.mjs --tool /drugi/checkout/src/index.js     # poredi drugu verziju
```

Ako Playwright ne nađe svoj browser: `AGARAI_CHROME=/putanja/do/chrome npm run sim`.

## Mapa okruženja (primer)

```
+--------------------------------------------------+
|               .B+ .         o   @                |
|            V                                     |
+--------------------------------------------------+
kralj=@A  masa[ @A:400  B:16  C:mrtav ]  tik=1
legenda: @kralj A/B/C tim  X veći  o manji  V virus  . hrana  + izbačena masa
```

## Ako mapa nije tačna (prilagođavanje protokola)

agar.rs je klon — ako mu se binarni format malo razlikuje, pozicije/entiteti
na mapi će izgledati kao smeće. Alat to **sam prepoznaje** i ispiše upozorenje
("dekodirane pozicije izgledaju netačno"). Tada:

1. Pokreni sa `--capture`, uđi u igru na par sekundi, pa Ctrl+C.
2. Alat snimi `captures/tab0-*.json` — beleži i **dolazne** (server→klijent)
   i **odlazne** (klijent→server) frejmove sa opcode-om, dužinom i hexom, plus
   WebSocket URL. Odlazni frejmovi otkrivaju njihove move/split/eject opcode-e.
3. Prilagodi offsete u `decodeUpdate()` unutar `src/inject/agarhook.js`
   (glavne varijacije među klonovima: `int16` vs `int32` za x/y, i redosled
   boje/imena u odnosu na flag bajt). Sve je na jednom mestu i komentarisano.

> Igra u iframe-u? Podržano — hook se ubacuje u sve frame-ove, a koordinator
> automatski nađe onaj u kom je socket igre.

Ako mi pošalješ `captures/tab0-*.json`, mogu da ti podesim dekoder tačno za
agar.rs (i dolazni format i klijent→server opcode-e za `--control protocol`).

Selektori za auto-join (polje za nadimak, Play dugme) se podešavaju kroz
`--nickSelector` / `--playSelector` u `src/config.js`.

## Struktura

```
src/
  index.js            CLI ulaz
  config.js           sva podešavanja + CLI flagovi
  browser.js          Playwright: 3 taba, ulazak u igru, ubacivanje hooka
  coordinator.js      glavna petlja: čitaj → odluči → komanduj → crtaj
  strategy.js         kralj / hranilac / bekstvo logika
  map.js              spajanje sveta + ASCII mapa
  inject/agarhook.js  IZVRŠAVA SE U STRANICI: WS hook + dekoder + kontrola
test/
  unit.test.mjs       unit testovi (npm test)
  sim/server.mjs      lokalni "agar.rs" server (isti protokol) + metrike
  sim/client.html     klijent simulatora (consent, Play, renderer)
  sim/run.mjs         end-to-end simulacija + izveštaj (npm run sim)
```
