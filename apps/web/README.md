# @crokychords/web

The Croky Chords editor: pick a key and tempo, build a chord progression in a grid, get
data-driven suggestions for the next chord, play it back, export a MIDI file, or send it
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

Cloud sync of saved progressions (`docs/specs/sync-v1.md`) is off unless the build sets
`VITE_SYNC=on`; the API base defaults to same-origin `/api` and can be changed with
`VITE_SYNC_API`. A small status next to **+ New** shows synced / syncing / offline / error /
sign in.

## Themes

The **Theme** select at the end of the toolbar switches between **Default** and **Pixel** (the
README banner as a UI: pixel fonts, square corners, chunky borders, the brand palette). The
choice is stored in `localStorage` as `crokychords.theme`. Themes are design tokens (CSS custom
properties) in `src/themes/`, one file per theme; `styles.css` uses only the tokens. Pixel's
fonts (Departure Mono, Pixelify Sans; SIL OFL 1.1) are bundled in `public/fonts/` with their
licences. See [`docs/specs/themes-v1.md`](../../docs/specs/themes-v1.md), also for adding a theme.

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
| `M` | Mute / unmute the selected track (Band panel) |
| `Ctrl/Cmd+Z` | Undo (50 steps, song edits only, including track edits) |
| `Ctrl/Cmd+Shift+Z`, `Ctrl+Y` | Redo |

Mouse: click a chord to select it; drag the right edge of the selected chord to resize it (snaps
to beats, hold `Shift` for quarter beats); click empty space after the last chord to append the
top suggestion. In the Next chord panel, hover a chord to hear it and click to insert it after
the selection. **In context** suggests from the chords up to the selection (or the whole song when
nothing is selected); **Popular** shows the most common chords of the mode. The chord editor
below the grid changes degree, accidental, quality, extension, sus, adds, alterations, inversion
and applied (secondary) function; only combinations with a valid token are offered.

## Band / tracks

The **Band** panel under the chord editor (click its title to collapse it; the app remembers
the state in `localStorage` as `crokychords.bandOpen`) lists the layers that play the
progression. A new song starts with three: **Chords** (channel 1, sustained), **Bass**
(channel 2, quarter notes) and **Arp** (channel 3, eighth-note arpeggio, muted). Every row has:

| Control | What it does |
|---------|--------------|
| Mute | Silences the track in playback, auditions fall back to another track, export skips it |
| Name | Track name (also the track name in the exported MIDI file) |
| Role | chords, bass, arp, pad or custom: picks the browser timbre. Changing it does **not** touch the other fields; click **apply defaults** to take the role's octave, pattern and velocity |
| Pattern | Rhythm preset, grouped by role (sustain, half notes, pop ballad, bass root–fifth, arp up 1/16, ...). A pattern that is not a preset shows as a read-only *Custom* label |
| Oct | Octave of the lowest voiced note (C4 = 4), -1..9 |
| Ch | MIDI channel 1–16 |
| Velocity, Gate | Note velocity 1–127 and the sounding fraction of each step (10–100 %) |
| Transp. | Transpose in semitones, -24..24 |
| ▲ ▼ ✕ | Reorder, remove (undo brings it back) |

**+ Add track** adds a track of the chosen role with that role's defaults on the next free
channel. Click a row to select it: `M` mutes it and Next chord auditions (hover a
suggestion, arrow keys, the chord editor) play through it, with its pattern, octave and
channel; without a selection they use the first unmuted track. The toolbar shows the channel
map next to the MIDI-out control (`Chords ch1 · Bass ch2 · Arp ch3`, muted tracks struck
through). Track edits are part of the song, so undo/redo and the saved song include them;
songs saved by older versions get the default band when they are loaded.

### Browser sound: presets and drums

Playback in the browser uses built-in instruments synthesised with Web Audio (no sample
files). The **Sound** select at the top of the Band panel picks a preset, which decides the
instrument for every track role:

| Preset | Chords | Bass | Arp | Pad | Custom | Drums |
|--------|--------|------|-----|-----|--------|-------|
| Piano | piano | piano | piano | piano | piano | none |
| **Band** (default) | piano | bass | piano | pad | piano | straight |
| Pad | pad | bass | piano | pad | pad | none |

- **Piano:** fast attack, decays naturally even while held, brighter at the start of a note;
  low notes ring longer.
- **Pad:** two detuned saws with a slow attack, behind a lowpass that opens slowly.
- **Bass:** plucked, filtered triangle with a sub sine an octave down.
- **Drums:** synthesised kick, snare and hi-hat. The **Drums** select picks a pattern (None,
  Straight, Half-time, Ballad); choosing a preset resets it to the preset's default. Bars
  follow the song's meter and restart when the song loops.

Everything goes through a gentle compressor and a master gain, with enough headroom that a full
band does not clip. Hovering a suggestion or moving through the chords plays the selected track
with the current preset. The sound settings are a listening preference: they are saved in
`localStorage` (`crokychords.sound`), are not part of undo, and change nothing about Web MIDI
out or the exported `.mid` file (drums are never sent or exported).

## Sending MIDI to a DAW

Click **Enable MIDI out** in the toolbar, then pick an output port. Every track sends on its own
MIDI channel (the **Ch** column) with its own velocity, with the same timing as the built-in
synth. **Stop** sends note-offs, All Sound Off (CC 120) and All Notes Off (CC 123) on every
channel in use; moving, muting or removing a track during playback does the same on its old
channel. To record in a DAW you need a virtual MIDI port that the browser writes to and the
DAW reads from:

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

### One instrument per channel

Because each track has its own channel, the DAW can give every layer its own instrument from
the one virtual port:

- **Bitwig Studio:** add the virtual port once as a *Generic MIDI Keyboard* controller
  (*Settings* → *Controllers*). Then create one instrument track per Croky track and, in each
  track's input chooser, pick that controller and the matching channel (*Ch. 2* for the bass);
  arm or monitor the tracks you want to hear.
- **Ableton Live:** on each MIDI track set *MIDI From* to the virtual port and the channel
  selector below it to *Ch. N*; set *Monitor* to *In* (or arm the tracks) to play along.
- **Reaper:** arm each track, right-click the record-arm button → *Input: MIDI* → the virtual
  port → *Channel N* (instead of *All channels*), and turn record monitoring on.

Make sure the DAW's own MIDI-thru or omni settings do not also send every channel to every
track. Muted tracks send nothing.

**Export MIDI** downloads a Standard MIDI File (`<title>.mid`, format 1): a conductor track
with tempo, meter and key signature, then one track per unmuted layer with its name, a MIDI
channel prefix and its notes on its channel. Most DAWs import it as one MIDI track per
layer.

## Suggestion data (`ngrams.json`)

Out of the box the panel uses the small hand-written seed table from `@crokychords/core`
(major and minor only; other modes fall back to their diatonic triads). For real statistics,
build a table with `packages/data` (see its README) and drop it in:

```bash
cp packages/data/out/ngrams-chordonomicon.json apps/web/public/data/ngrams.json
```

Reload the app: the toolbar badge switches from *seed only* to *loaded* and shows the table's
name and the section count for the current mode; a selector lets you switch back to the seed.
If the file is invalid the badge says *error* (hover it for the reason) and the seed stays
active. `apps/web/public/data/*.json` is git-ignored and `vite build` does not copy `public/`,
so a table never ends up in a commit or a build (see `docs/DATA.md`).
