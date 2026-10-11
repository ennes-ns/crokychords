# @crokychords/web

The Croky Chords editor: pick a key and tempo, build a chord progression in a grid, get
Magic-Chords-style suggestions for the next chord, play it back, export a MIDI file, or send it
live to a DAW over Web MIDI. Vite + TypeScript, plain DOM (no UI or CSS framework); all music
logic comes from [`@crokychords/core`](../../packages/core/README.md).

## Run

```bash
pnpm install                            # once, at the repo root
pnpm dev                                # http://localhost:5173
pnpm --filter @crokychords/web build    # → apps/web/dist
pnpm --filter @crokychords/web preview  # serve the build on :4173
pnpm --filter @crokychords/web test     # vitest + jsdom
```

The song is saved in `localStorage` (`crokychords.song`) on every change; **New** starts an
empty song in the same key (undoable). Audio starts after the first click or key press
(browsers block sound before a user gesture). Web MIDI works in Chrome, Edge and Opera, and in
Firefox after its site-permission prompt; Safari has no Web MIDI.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `1` – `7` | Add the diatonic triad of that degree after the selection (`ii`, `vii°`, `III` in minor, ...) |
| `←` / `→` | Select the previous / next chord (and hear it) |
| `Backspace` / `Delete` | Remove the selected chord |
| `[` / `]` | Shorten / lengthen the selected chord by one beat |
| `Shift+[` / `Shift+]` | ... by a quarter beat |
| `Space` | Play / stop (from the selected chord, or from the start) |
| `Esc` | Deselect (or leave a text field) |
| `Ctrl/Cmd+Z` | Undo (50 steps, song edits only) |
| `Ctrl/Cmd+Shift+Z`, `Ctrl+Y` | Redo |

Mouse: click a chord to select it; drag the right edge of the selected chord to resize it (snaps
to beats, hold `Shift` for quarter beats); click empty space after the last chord to append the
top suggestion. In the Magic Chords panel, hover a chord to hear it and click to insert it after
the selection. **Magic** suggests from the chords up to the selection (or the whole song when
nothing is selected); **Popular** shows the most common chords of the mode. The chord editor
below the grid changes degree, accidental, quality, extension, sus, adds, alterations, inversion
and applied (secondary) function; only combinations with a valid token are offered.

## Sending MIDI to a DAW

Click **Enable MIDI out** in the toolbar, then pick an output port. Playback and auditions are
sent on channel 1 with the same timing as the built-in synth; **Stop** sends note-offs and
All Notes Off (CC 123). To record in a DAW you need a virtual MIDI port that the browser writes
to and the DAW reads from:

- **Windows:** install [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html) and add
  a port. Select it in Croky Chords and enable it as a MIDI input in the DAW.
- **macOS:** open *Audio MIDI Setup* → *Window* → *Show MIDI Studio*, double-click **IAC
  Driver**, tick *Device is online* (add a bus if there is none). Select *IAC Driver Bus 1* in
  Croky Chords and as the input of a MIDI track in the DAW.
- **Linux (ALSA):** `sudo modprobe snd-virmidi` creates *Virtual Raw MIDI* ports; select one in
  Croky Chords and the matching port in the DAW. Alternatively route with `aconnect`: `aconnect
  -l` lists clients, `aconnect 14:0 128:0` connects *Midi Through* (which the browser sees) to
  the DAW's input port. With PipeWire or JACK, `qpwgraph` / `qjackctl` can draw the same
  connection. Reload the page after creating ports if they do not show up.

**Export MIDI** downloads a Standard MIDI File (`<title>.mid`, format 0, tempo, meter and key
signature included) that any DAW can import.

## Suggestion data (`ngrams.json`)

Out of the box the panel uses the small hand-written seed table from `@crokychords/core`
(major and minor only; other modes fall back to their diatonic triads). For real statistics,
build a table with `packages/data` (see its README) and drop it in:

```bash
cp packages/data/out/ngrams-hooktheory.json apps/web/public/data/ngrams.json
```

Reload the app: the toolbar badge switches from *seed only* to *loaded* and shows the table's
name and the section count for the current mode; a selector lets you switch back to the seed.
If the file is invalid the badge says *error* (hover it for the reason) and the seed stays
active. `apps/web/public/data/*.json` is git-ignored and `vite build` does not copy `public/`,
so a table never ends up in a commit or a build. Hooktheory data is for personal use only (see
`docs/DATA.md`).
