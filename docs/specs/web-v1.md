# Spec: `@crokychords/web` v1

Status: draft (2026-09-07), to be implemented after `@crokychords/core` v1 is merged.
Owner: main session. Implementer: Opus agent. Deliverable: one PR on branch `feat/web-v1`.

`apps/web` is a Vite + TypeScript single-page app, **no UI framework** (plain DOM with small
helper functions), no CSS framework. It is the Croky Chords editor: pick a key and tempo,
build a chord progression in a grid, get data-driven suggestions for the next chord,
play it back, export MIDI, send live MIDI to a DAW.

Depends on: `@crokychords/core` (workspace). Read `docs/specs/core-v1.md` for its API and
`packages/data/README.md` for the `ngrams.json` schema.

## 1. Layout and stack

```
apps/web/
├── package.json         name @crokychords/web, private, scripts dev/build/preview/typecheck/test
├── index.html
├── vite.config.ts
├── tsconfig.json        extends ../../tsconfig.base.json
├── public/data/         (empty; user drops ngrams.json here, see §7)
├── src/
│   ├── main.ts          boot: state store, mount views, wire keyboard
│   ├── state.ts         single Store with subscribe/update, undo/redo (50 steps)
│   ├── views/
│   │   ├── toolbar.ts   key/mode/tempo/meter, play/stop, export, MIDI out, table status
│   │   ├── grid.ts      chord grid (bars × beats), selection, add/remove/resize
│   │   ├── suggest.ts   Next chord panel
│   │   └── chordEditor.ts  properties of the selected chord (quality, extension, sus/add, inversion, applied)
│   ├── audio/
│   │   ├── synth.ts     Web Audio poly synth (2 detuned saw/tri oscillators + lowpass + ADSR)
│   │   └── scheduler.ts lookahead scheduler (Chris Wilson pattern: setInterval 25 ms, lookahead 100 ms)
│   ├── midi/
│   │   ├── webmidi.ts   Web MIDI output device list, note on/off, all-notes-off, clock optional
│   │   └── download.ts  Blob download of songToMidi()
│   ├── data/tables.ts   load seed + optional /data/ngrams.json, expose active table
│   └── styles.css
└── test/                vitest with jsdom for state and pure view helpers
```

## 2. State

```ts
interface AppState {
  song: Song;                      // from core
  selected: number | null;         // chord index
  cursor: number;                  // beat position of playhead
  playing: boolean;
  midiOut: string | null;          // Web MIDI output id
  table: 'seed' | 'ngrams';        // which suggestion table is active
  tableStatus: 'loading' | 'seed-only' | 'loaded' | 'error';
}
```

Persistence: `localStorage['crokychords.song']` holds `serializeSong(song)`; save on every
change (debounced 250 ms), load on boot, "New" resets. Undo/redo on `song` only.

## 3. Grid

- Rows of bars; bar width scales with meter; chords rendered as blocks spanning `beats`.
- Click empty space at a beat → adds the selected suggestion or `I` with 4 beats (or the
  remaining space in the bar, whichever is smaller). Keyboard `1`–`7` adds the diatonic
  triad of that degree after the selection. `Backspace` removes the
  selected chord. `[` / `]` shorten/lengthen by one beat, `Shift+[`/`]` by a quarter beat.
  `←`/`→` move selection, `Space` play/stop, `Esc` deselect.
- Each block shows the token (e.g. `IV`) and the lead-sheet name (e.g. `F`) from `chordName`.
- Color per degree (7 fixed hues, same for all qualities), lighter when selected.
- Playhead line during playback; `chordAtBeat` drives highlighting.

## 4. Next chord panel

- Context = tokens before the selection (or all tokens when nothing is selected),
  `suggestNext(table, mode, context, { limit: 16 })`.
- Show token, lead-sheet name, percentage, and a thin bar; header says which context was
  used ("after IV, I" / "any position" for the unigram row).
- Click → insert after the selection (4 beats or remaining bar). Hover → audition the chord
  for 600 ms through the synth (and MIDI out if enabled).
- Toggle "Popular" (unigram) vs "In context" (context); toggle "diatonic only" filter.

## 5. Chord editor

Edits the selected chord's `Chord` fields via `parseToken`/`formatToken`: degree (1–7),
accidental, quality, extension, sus, adds, alterations, inversion, applied (function
V/IV/vii° + target). Every change round-trips through the token so the grid always shows a
valid token. Invalid combinations are simply not offered (e.g. sus + quality).

## 6. Playback and MIDI

- Synth: one voice per note, `voiceChord` for pitches, gain envelope, master limiter-ish
  gain of 0.2. Start on user gesture; show a "click to enable audio" overlay otherwise.
- Scheduler: converts beats to seconds from `song.tempo`, loops the song when "Loop" is on,
  schedules note events ahead, updates `cursor` via `requestAnimationFrame`.
- Web MIDI: `navigator.requestMIDIAccess()` on demand; output select in the toolbar; when
  set, the scheduler also sends note on/off with the same timing (`output.send(data, time)`
  with DOMHighResTimeStamp). All-notes-off on stop. Works today with a virtual port
  (loopMIDI, IAC, or `aconnect`/ALSA virtual MIDI on Linux) so a DAW can record the
  progression; document that in the app's README.
- Export: `songToMidi(song)` → Blob → `<a download="<title>.mid">`.

## 7. Suggestion tables

- `seedTable` from core always loads first (status `seed-only`).
- Then `fetch('/data/ngrams.json')`; if 200 and `parseNgramTable` succeeds, switch to it
  (status `loaded`), else stay on seed. The file is git-ignored under `apps/web/public/data/`
  and the README tells the user to copy `packages/data/out/ngrams-chordonomicon.json` there.
  Never bundle real data into the build.
- The toolbar shows the table name and section count from `source`/`modes[mode].sections`.

## 8. Tests and done

- vitest (jsdom): state store undo/redo, grid helpers (beat ↔ pixel, insert with bar
  clipping), suggestion-context derivation, table loading fallback (mock fetch).
- `pnpm check` green at the root; `pnpm dev` starts on port 5173; `pnpm build` produces
  `apps/web/dist`.
- `apps/web/README.md`: run, keyboard shortcuts, MIDI routing to a DAW on Linux/macOS/Windows,
  how to drop in `ngrams.json`.
