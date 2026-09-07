# Recon: hoe Hookpad technisch in elkaar zit

Datum: 2026-09-07. Bron: Hookpad (https://hookpad.hooktheory.com/) bekeken via de
Claude-in-Chrome-extensie, niet ingelogd, plus de publieke JS-bundle. Alles hieronder is
**geverifieerd** tenzij gemarkeerd als *afgeleid*.

## 1. Frontend-stack

| Onderdeel | Bevinding |
|-----------|-----------|
| Build | Vite (één bundle `assets/index-<hash>.js`, ~9,3 MB, plus één CSS-bestand) |
| UI | React (root-element aanwezig; geen Angular of Vue) |
| State | Redux met redux-observable (RxJS "epics", bijv. `magicChordDataDownloadTrieEpic`) |
| Audio | Howler.js (`Howl`, `Howler`) voor samples, eigen `ToneBufferManager`, `audioCtx` (Web Audio) |
| Sneltoetsen | Mousetrap (`1`–`7` voegt akkoorden toe, `hjkl` verandert duur) |
| Mobiel | Capacitor + Ionic (`Capacitor`, `Ionic` globals): dezelfde codebase draait als app |
| Overig | YouTube iframe-API (sync met video), Google Analytics/GTM |
| MIDI | Web MIDI API (`navigator.requestMIDIAccess`) voor MIDI-in/out |

## 2. Magic Chords: volledig client-side

Dit is de belangrijkste vondst. Magic Chords doet **geen API-call per klik**. Bij het laden
van de editor wordt een voorberekende trie van akkoordprogressies van hun CDN gehaald en
in de browser gedeserialiseerd. Daarna zijn alle suggesties lokale lookups.

Assets (basis-URL `https://s3.amazonaws.com/cdn.hooktheory.com/assets/`, uit de
`constants`-map in de bundle):

| Constante | Pad | Rol |
|-----------|-----|-----|
| `MAGIC_CHORD_BIN_PATH` | `magic-chord-assets/CPTrieWK_pruned.htb.zip` | Chord-Progression-Trie ("WK" = *afgeleid*: with key/mode), gesnoeid, gezipt |
| `CHORD_TOKENS_BIN_PATH` | `magic-chord-assets/chord-token-library-static.htb` | Chord-token-bibliotheek |
| `MAGIC_BASS_BIN_PATH` | `magic-chord-assets/ChordBassData.htb` | Data voor "Bass Sets" / "By Bass" |
| `HARMONIZE_BY_SD_PATH` | `magic-chord-assets/sdObj.dat` | Harmoniseren op scale degree (melodie → akkoord), 41 KB, wordt bij page-load geladen (gezien in Network) |
| `SONG_METRICS_JSON_PATH` | `song-metrics-assets/coef.json` | Coëfficiënten voor "Metrics" |

Codepad in de bundle (namen zijn niet geminified):

- `MagicChord` object met velden `CPTrie`, `CPTrieHR`, `CHObj`, `CPBass`, `CTTrie`,
  `Top100Magic`; methoden `downloadCPTrieBinary(url)` (via `xhrZip`, pakt
  `CPTrieWK_pruned.htb` uit naar een ArrayBuffer), `deserializeCPTrieBinary(buf)` →
  `ChordProgressionTrie.deserialize(Uint8Array, false, progress, true)`,
  `initMagicChordEngine(url)`, `initHarmonizeBySdEngine()` →
  `ChordBassProcessor.makeChordBassObjectsFromTrends(this.CPTrie, 12, true)`.
- `.htb` = *afgeleid*: "HookTheory Binary", een eigen serialisatieformaat. Ook de
  instrumentbibliotheek (`library/v2/libv2-<versie>.htb`) en MIDI-patronen gebruiken het.
- Suggesties worden gematcht op `Serializer.chordSIND_str(chord)`: een 5-byte string die
  een akkoord codeert (zie §3).

**Wat de UI toont** (C majeur, lege progressie, tabblad *Magic*):
`I 68, IV 60, V 59, vi 51, ii 35, ii7 33, iii 31, vi7 29, V7 29, IVmaj7 28, …`
Tabblad *Popular* (context-onafhankelijk): `I 99, IV 86, V 83, vi 73, ii 51, iii 47, …`
De getallen zijn *afgeleid* een genormaliseerde score (top = ~100), geen percentage.
De tooltip zegt letterlijk: suggesties zijn gebaseerd op de akkoorden vóór **en na** de
cursor, d.w.z. de trie wordt in beide richtingen bevraagd (*afgeleid*: de `CPTrieHR`
is de omgekeerde/"reverse" variant).

**Andere tabbladen in de akkoordbalk:** Magic, Popular, Search (typ een akkoord), Tone Sets
(akkoorden met een bepaalde noot), Bass Sets (akkoorden per basnoot), Progressions
(hele progressies). Magic werkt zonder in te loggen.

**Aria** is een aparte, server-side AI-feature (`ml.hooktheory.com`, "Sheet Sage" voor
transcriptie); niet relevant voor ons.

## 3. Intern akkoordmodel

Uit `Serializer.chordSIND_str` / `Deserializer.chordSIND_str` (5 bytes, elk als één
char in een string). De bit-indeling is daarna **bevestigd** door
`ChordData.getChordDisplayName` op hooktheory.com/trends aan te roepen met testwaarden;
de decoder staat in `packages/data/crokychords_data/sind.py` met tests.

| Byte | Inhoud |
|------|--------|
| 1 | bits 0–2 `root` (scale degree 1–7, 0 = rest); bit 3 add11, bit 4 "6", bit 5 add9; bit 7 gezet = ander formaat |
| 2 | bits 6–7 `inversion` (0–3); bits 3–5 type-index in {5,7,9,11,13}; bits 0–2 `applied`: k = k-de akkoord van de majeurtoonladder op de doel-degree (5 = V/x, 4 = IV/x, 7 = vii°/x; 1 gedraagt zich als "geen") |
| 3 | alteraties: 1 ♭5, 2 ♯5, 4 ♭9, 8 ♯9, 16 ♯11, 32 ♭13 |
| 4 | bit 6 sus2, bit 7 sus4; lage 6 bits = geleende toonladder: 1–7 de modi (majeur, dorisch, frygisch, lydisch, mixolydisch, mineur, locrisch), 8 harmonisch mineur, 9 frygisch-dominant; 32–63 = de majeurtoonsoort met (waarde − 40) kruisen, gespeld vanaf dezelfde tonica-letter (kwintencirkel, 40 = 0 kruisen); bit 4 verandert de naam niet |
| 5 | omits / pedal / alternate; in de Trends-data altijd 0 |

Dit komt één-op-één overeen met het paneel *Chord Properties* rechts in de editor:
Type (Triad/7/9/11/13), Inversion (None/1st/2nd/3rd), Options (sus2, sus4, add9, add11,
add13, ♭5, ♯5, ♭9, ♯9, ♯11, ♭13, no3, no5), Secondary (V/, IV/, vii/), Borrow From.
Akkoorden zijn dus **relatief aan de toonsoort** (scale degree), precies zoals ons
token-formaat. Ons `chords.ts` moet minimaal root, type, inversion, applied en borrowed
dekken om Hookpad-data te kunnen mappen.

### 3a. hooktheory.com/trends

De publieke Trends-pagina laadt dezelfde trie (`CPTrieWK_pruned_lite.htb.zip`) en houdt
die als gewone JS-boom in het globale object `ChordData` (bron: `js/D3Trends/ChordData.js`,
ongeminified). Per toonladder een trie tot diepte 5: wortel `count` = aantal
sectie-analyses, `children` = map van 5-byte chord-id naar knoop met `count`,
`songCount`, `children`. Negen toonladders: major (41.974 secties), minor (29.677),
mixolydian, dorian, harmonicMinor, phrygian, lydian, phrygianDominant, locrian.
De percentages op de pagina zijn `count` van het kind gedeeld door de som van alle
kinderen; onze `ngrams.json` reproduceert ze exact (na C: G 19,2 %, F 16,4 %, Am 9,2 %).

## 4. Editor-model (geobserveerd)

- Twee lanes per regel: melodie (7 scale degrees per octaaf, "Smart Octave") en akkoorden.
- Duur in beats met presets 1/4, 1/2, 1, 2, 4 en "Add"; Split en Tie.
- Vier stemmen (voices), secties (Intro/Verse/Chorus), band-presets, lyrics.
- Export-menu bestaat (knop "Export"), niet uitgeprobeerd omdat het waarschijnlijk
  een account vereist. *Afgeleid* uit eerdere kennis: MIDI, MusicXML, PDF, WAV.

## 5. Consequenties voor Croky Chords

1. **Architectuur is bevestigd:** een lokale n-gram/trie over toonsoort-relatieve
   akkoordtokens, in de browser, zonder server. Precies het plan in `HANDOVER.md`.
2. **Data:** Hookpad's trie zelf is een proprietary binair bestand op hun CDN. We
   reverse-engineeren dat **niet** en hergebruiken het niet; het is hun database.
   Onze tabellen komen uit de officiële Hooktheory Trends-API (eigen account) en/of
   Chordonomicon (CC-BY-NC). Zie `DATA.md`.
3. **Bidirectionele suggesties** (akkoorden vóór én na de cursor) zijn een goede
   feature voor fase 2: bouw naast de forward-trie ook een reverse-trie.
4. **Scoreweergave:** Hookpad toont een genormaliseerde score, geen kans. Wij tonen
   percentages uit de n-gram-tabel; dat is transparanter.
5. **Akkoordmodel:** neem Hookpads velden over (root, type, inversion, applied,
   borrowed, sus/add/omit) zodat een latere import van Hookpad-bestanden mogelijk is.

## 6. Nog open

- Exportformaat (MIDI/MusicXML) bekijken met een ingelogd account.
- Bevestigen hoe `cp`-contexten van de Trends-API zich verhouden tot chord-IDs
  (de API geeft `chord_ID` en `chord_HTML`; mapping naar ons token-formaat komt in
  `packages/data`).
