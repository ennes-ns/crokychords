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

Replace-first editing (issue #53; supersedes the Insert | Replace toggle): the editor is for
exploring variations of a progression, so picking a chord **replaces** the selected one and adding
is a separate, explicit action.

- Rows of bars; bar width scales with meter; chords rendered as blocks spanning `beats`.
- **Selection model:** there is always one selected slot: a chord, or the **"+" slot**, a visible
  dashed block right after the last chord (`AppState.selected === null`). It is as wide as the
  chord a pick would add there, cut at the row end. Clicking a chord selects it; clicking the "+"
  slot or empty space after the last chord, `→`/`Tab` past the last chord, `Enter` and `Esc`
  select the "+" slot. `←`/`→` (and `Tab`/`Shift+Tab` while the grid has focus) walk the slots;
  at either end Tab moves the focus on as usual, so the grid is no keyboard trap. Opening a song
  and a new song start on the "+" slot.
- **Pick = replace:** a Next chord click or `1`–`7` (the diatonic triad of that degree) replaces
  the selected chord's token (length and position kept). On the "+" slot the same actions append
  a chord (length = the previous chord's length; the first chord of a song gets 4 beats or the
  rest of the bar) and the "+" slot stays selected, so `1 5 6 4` on an empty song builds four
  chords.
- **Explicit add:** `Insert` or `Ctrl/Cmd+Enter` inserts a copy of the selected chord after it and
  selects the copy, so the next pick replaces it (on the "+" slot: a copy of the last chord, or
  the tonic triad in an empty song). `Shift` turns a pick into an insert after the selected chord
  (`Shift+1`–`7`, Shift+click), which selects the new chord; on the "+" slot it appends as usual.
- `Backspace`/`Delete` removes the selected chord (the selection moves to the previous one); on
  the "+" slot it removes the last chord. `[` / `]` shorten/lengthen by one beat,
  `Shift+[`/`]` by a quarter beat. `Space` play/stop.
- Every edit is one undo step.
- Each block shows the token (e.g. `IV`) and the lead-sheet name (e.g. `F`) from `chordName`.
- Color per degree (7 fixed hues, same for all qualities), lighter when selected.
- Playhead line during playback; `chordAtBeat` drives highlighting.

## 4. Next chord panel

- Suggestions follow the selection: the context is the tokens **before** the selected slot (all
  tokens on the "+" slot), so a chord selected in the middle shows what fits there.
  `suggestNext(table, mode, context, { limit: 16 })`. When the table later supports it, the
  chord after the slot can be taken into account too.
- Show token, lead-sheet name, percentage, and a thin bar; header says which context was
  used ("after IV, I" / "any position" for the unigram row).
- Click → replace the selected chord, or add on the "+" slot (§3); Shift+click inserts after the
  selected chord instead. The hint line under the list says what a click does ("Click replaces
  chord 2 (V)…" / "Click adds a chord at the end…"). Hover → audition the chord for 600 ms
  through the synth (and MIDI out if enabled).
- Toggle "Popular" (unigram) vs "In context" (context); toggle "diatonic only" filter.

## 5. Chord editor

Edits the selected chord's `Chord` fields via `parseToken`/`formatToken`: degree (1–7),
accidental, quality, extension, sus, adds, alterations, inversion, applied (function
V/IV/vii° + target). Every change round-trips through the token so the grid always shows a
valid token. Invalid combinations are simply not offered (e.g. sus + quality).

## 6. Playback and MIDI

- Synth: one voice per note, `voiceChord` for pitches, gain envelope, master limiter-ish
  gain of 0.2. Start on user gesture; show a "click to enable audio" overlay otherwise.
- Scheduler: converts beats to seconds from `song.tempo`, loops the song (or the loop range,
  see `loop-v1.md`) when "Loop" is on, schedules note events ahead, updates `cursor` at every
  whole beat, chord start and loop end (a timer, not every frame); between those updates the
  playhead glides on its own as a composited Web Animation along the row. Play starts at the
  loop start when looping, else at beat 0.
- The AudioContext suspends about 3 s after Stop once no voice sounds (and at once when the tab
  is hidden and nothing plays); Play and auditions resume it first. A released voice stops at
  1.2 × its release (about −42 dB), not 2 ×.
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

## 9. Layout

Single-screen shell (issue #59). The whole editor fits one screen without page scrolling at
1920×1080, 1440×900 and 1366×768, in both themes. `views/shell.ts` builds the containers,
`styles.css` lays them out.

```
┌──────────────────────── toolbar (transport, key, MIDI, theme) ────────────────────────┐
├──────────────────────────────────────────────────────────────┬────────────────────────┤
│ stage: chord grid (≤ 50 % of the stage, then scrolls)        │ side (320 px):         │
│        melody lane (takes the rest, scrolls its rows)        │  Next chord (list      │
│                                                              │   scrolls, ≥ 240 px)   │
├──────────────────────────────────────────────────────────────┤  Chord editor          │
│ Band panel (collapsible, ≤ 42 % of the height, body scrolls; │  Saved progressions    │
│   the pattern editor opens inside it)                        │   (list scrolls)       │
└──────────────────────────────────────────────────────────────┴────────────────────────┘
```

- CSS grid inside a `100dvh` flex column: the toolbar row takes its natural height (it wraps on
  narrow screens), the workspace takes the rest. `html` and `body` get `overflow: hidden`; only
  the panels scroll (`overflow-y: auto`, `overscroll-behavior: contain`): grid rows, melody rows,
  the Band body, the suggestion list, the saves list.
- Side column: Next chord, the chord editor (fields in three columns) and the saved
  progressions. The chord editor keeps its full height while Next chord (min. 240 px) and the
  saves (min. 96 px) can still give way; only below that does the editor scroll. The editor
  sits with Next chord because both act on the selected chord, and the stage keeps its height
  for the melody lane.
- Band panel: below the stage, as wide as the stage. Its open/closed state is stored
  (`crokychords.bandOpen`); with nothing stored it starts open, except in compact mode.
- **Compact mode** under 960 px viewport height (`COMPACT_QUERY = (max-height: 959px)`; the shell
  sets `.shell.compact` and follows resizes): tighter gaps and padding (the toolbar stays at two
  rows on laptop widths), chord cells 48 px instead of 68 px with smaller text, melody rows 180 px
  instead of 210 px (12 px per pitch row), side-column minimums of 212 px (Next chord) and 88 px
  (saves), and the Band panel collapsed by default.
- Pixel theme: every size in the shell is a whole pixel value (melody rows 210 / 180 px over 15
  pitch rows), so the theme keeps its integer scaling.
- Fallback: on 1366×768 with a chord selected, Next chord sits at its minimum (about two
  suggestions visible, the list scrolls). Should even the minimums not fit, the chord editor, then
  the stage or side column, scrolls inside itself; the page still never does.
- Below 900 px width the old stacked layout applies and the page scrolls. Mobile and touch are
  out of scope (later issue).
