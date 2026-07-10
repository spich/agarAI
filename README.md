# agarAI — trobotni agar.rs teaming simulator

Alat koji iz tvoje komandne linije vodi **tri zasebna taba** (`tripleXa`,
`tripleXb`, `tripleXc`) kao tri odvojena igrača na [agar.rs](https://agar.rs/web/4).
Botovi se ponašaju kao tim: jedan je **kralj** (dominantni), a druga dva mu
**prilaze i dodaju masu** (izbacuju `W` u njega) da bi kralj brzo narastao i
dominirao igrom. Uz to, alat u realnom vremenu crta **sliku okruženja** (ASCII
mapu) spojenu iz svega što sva tri bota vide.

> Namena: automatizacija igre / botovanje u agar klonu. Koristi na svoju
> odgovornost i u skladu sa pravilima servera.

## Kako radi

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

Pun spisak: `node src/index.js --help`.

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
na mapi će izgledati kao smeće. Tada:

1. Pokreni sa `--capture`, uđi u igru na par sekundi, pa Ctrl+C.
2. Pogledaj `captures/tab0-*.json` — prvih 64 bajta svakog frejma u hexu.
3. Prilagodi offsete u `decodeUpdate()` unutar `src/inject/agarhook.js`
   (glavne varijacije među klonovima: `int16` vs `int32` za x/y, i redosled
   boje/imena u odnosu na flag bajt). Sve je na jednom mestu i komentarisano.

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
```
