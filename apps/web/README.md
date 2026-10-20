# @crokychords/web

The Croky Chords editor: pick a key and tempo, build a chord progression in a grid, get
data-driven suggestions for the next chord, play it back, export a MIDI file, or send it
live to a DAW over Web MIDI. Vite + TypeScript, plain DOM (no UI or CSS framework); all music
logic comes from [`@crokychords/core`](../../packages/core/README.md).

## Run

```bash
pnpm install                            # once, at the repo root
pnpm dev                                # http://localhost:5173 (fetches the SoundFonts once)
pnpm --filter @crokychords/web build    # → apps/web/dist
pnpm --filter @crokychords/web preview  # serve the build on :4173
pnpm --filter @crokychords/web test     # vitest + jsdom (audio tests render offline, silently)
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
font (Departure Mono, SIL OFL 1.1) is bundled in `public/fonts/` with its licence. See [`docs/specs/themes-v1.md`](../../docs/specs/themes-v1.md), also for adding a theme.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `1` – `7` | Replace the selected chord with the diatonic triad of that degree (`ii`, `vii°`, `III` in minor, ...; keeps its length and position); on the "+" slot add it at the end |
| `Shift+1` – `Shift+7` | Insert that triad after the selected chord instead |
| `Insert`, `Ctrl/Cmd+Enter` | Insert a copy of the selected chord after it and select the copy (on the "+" slot: a copy of the last chord) |
| `←` / `→` | Select the previous / next chord (and hear it); `→` past the last chord selects the "+" slot |
| `Tab` / `Shift+Tab` | Same as `→` / `←` while the grid has focus (Tab leaves the grid at either end) |
| `Enter` | Select the "+" slot |
| `Backspace` / `Delete` | Remove the selected chord (on the "+" slot: the last chord) |
| `[` / `]` | Shorten / lengthen the selected chord by one beat |
| `Shift+[` / `Shift+]` | ... by a quarter beat |
| `Space` | Play / stop, from the start (the loop start when looping); works in selects and on buttons too, not while typing in the title or BPM |
| `Shift+Space` | Play from the selected chord |
| `L` | Loop on / off |
| `Alt+[` / `Alt+]` | Set the loop start / end at the selected chord |
| `Esc` | Select the "+" slot (or leave a text field) |
| `M` | Mute / unmute the selected track (Band panel) |
| `K` | Breakcore on / off |
| `Shift+K` | Breakcore intensity 25 → 50 → 75 → 100 % |
| `Ctrl/Cmd+Z` | Undo (50 steps, song edits only, including track edits) |
| `Ctrl/Cmd+Shift+Z`, `Ctrl+Y` | Redo |
| `Ctrl/Cmd+K` | Open / close the assistant |

Loop points: click a bar number to loop that bar, drag over the bar numbers to loop several,
Shift+click a bar number to extend the loop to it. The range is shaded in the grid; the toolbar
shows it next to the Loop checkbox, with × to clear it (then Loop loops the whole song). The loop
is kept per saved progression on this device. See `docs/specs/loop-v1.md`.

Editing is replace-first: there is always one selected slot, a chord or the dashed **"+" slot**
after the last chord. Picking a chord (a Next chord click, `1`–`7`, a Fire palette pad) replaces
the selected chord and keeps its length and position, so you can try variations in place; on the
"+" slot it adds a chord at the end (as long as the previous one) and the "+" slot stays
selected, so typing `1 5 6 4` on a new song builds four chords. Adding in the middle is explicit:
`Insert` / `Ctrl+Enter`, or hold `Shift` while picking. Every edit is one undo step.

Mouse: click a chord to select it; click the "+" slot (or empty space after the last chord) to
select it; drag the right edge of the selected chord to resize it (snaps to beats, hold `Shift`
for quarter beats). In the Next chord panel, hover a chord to hear it and click to pick it;
Shift+click inserts it after the selected chord instead. The line under the list says what a
click does. **In context** suggests from the chords before the selected slot (the whole song on the
"+" slot); **Popular** shows the most common chords of the mode. The chord editor
below the grid changes degree, accidental, quality, extension, sus, adds, alterations, inversion
and applied (secondary) function; only combinations with a valid token are offered.

## Assistant and the command API

The speech-bubble button in the toolbar (or `Ctrl/Cmd+K`) opens the **assistant** over the side
column. Type a request ("make the second half darker", "suggest a bridge", "what is this
progression called?"); the answer is one sentence plus a proposal shown as a diff: added chords
marked `+`, replaced ones `old → new`, removed ones struck through, and a line for every other
change (key, tempo, melody, band). **Apply** makes the whole proposal one undo step; **Discard**
drops it. Nothing changes without a click. The assistant runs on the server (`POST
/api/assistant`), so it only works in the online version with the server's key set; otherwise
the panel says it is unavailable and the rest of the app is unaffected.

The same edits are available to scripts and agents as `window.croky` (`getSong()`,
`applyCommands([...])`, `suggestions()`, `exportMidi()`, ...). See
[`docs/howto/agents.md`](../../docs/howto/agents.md) and
[`docs/specs/assistant-v1.md`](../../docs/specs/assistant-v1.md).

## Melody lane

Chords and melody are one timeline: every row of chord blocks has its own melody strip directly
beneath it, for the same bars, with one playhead running through both. The melody is a single
voice written as scale degrees of the song's key (so it follows a key or mode change). Each strip
is a small piano roll from degree 5 an octave down to degree 5 an octave up; the tonic rows are
shaded. "7 rows" folds it to one row per degree (every octave on its degree's row, other octaves
marked with a dotted edge); short screens always fold it. Each note has the colour of its
degree, the same as a chord on that degree (a `5` is the colour of `V`); a sharp is one step
lighter, a flat one step darker. Under each chord, the rows of its root, third, fifth and seventh
are faintly tinted (the root a little stronger), so a note on a tinted row is a chord tone and one
on a plain row a passing tone. The bar above the timeline switches the chord-tone tint (`H`, remembered on this
device), switches the grid between 1/8 and 1/16 notes, mutes the melody and picks its MIDI
channel (default 4). The melody plays through its instrument (the preset's choice, Lead by
default; see the melody row of the Band panel), goes out over Web MIDI on its channel and is
exported as a `Melody` track. See [`docs/specs/melody-v1.md`](../../docs/specs/melody-v1.md).

Mouse: click empty space to add a note of that row's degree (drag right for its length), drag a
note to move it, drag its right edge to resize it, double-click it to delete it.

Keyboard: `N` switches the editing keys between the chords and the melody (clicking either half
of a row does too); the half the keys act on is marked on the left of every row. In the melody:

| Key | Action |
|-----|--------|
| `1` – `7` | Place that degree at the cursor and move the cursor past it |
| `←` / `→` | Move the cursor one grid step |
| `Shift+←` / `Shift+→` | Move the note under the cursor one grid step |
| `↑` / `↓` | Note one scale step up / down |
| `+` / `-` | Octave up / down (the note under the cursor and new notes) |
| `[` / `]` | Note one grid step shorter / longer (without a note: the length of new notes) |
| `B` / `S` | Toggle flat / sharp |
| `Backspace` / `Delete` | Delete the note under the cursor |
| `G` | Grid 1/8 ↔ 1/16 |
| `H` | Chord-tone tint on / off |
| `Home` | Cursor to the start |
| `Esc` | Back to the chord grid |

`Space`, undo/redo, `M`, `L`, `Alt+[`/`Alt+]`, `Enter`, `Insert` and `Shift+1`…`7` keep their
chord-grid meaning in both lanes.

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
| Pattern | Rhythm preset, grouped by role, each with a one-line description (sustain, pop ballad, house piano, waltz 3/4, walking bass, alberti, ...), then the song's own presets. A pattern that is not a preset shows as a read-only *Custom* label |
| Oct | Octave of the lowest voiced note (C4 = 4), -1..9 |
| Ch | MIDI channel 1–16 |
| Velocity, Gate | Note velocity 1–127 and the sounding fraction of each step (10–100 %) |
| Transp. | Transpose in semitones, -24..24 |
| Instrument | The browser sound of this track: a SoundFont instrument, a synth or a sampler slot (see below). `…` while its samples load, `!` when they could not be loaded, `∅` for a sampler slot without a sample; `∿` opens the Sampler panel of a track that plays a slot |
| ✎ | Open the pattern editor under the row (below) |
| ▲ ▼ ✕ | Reorder, remove (undo brings it back) |

Under the tracks sits the **Melody** row with the same columns: mute and MIDI channel (the same
song fields as in the bar above the timeline), an octave shift −2..+2 and a velocity for the
browser sound, and its instrument. The octave shift and velocity are listening settings like the
instrument: they change neither the song nor Web MIDI out nor the exported file.

**+ Add track** adds a track of the chosen role with that role's defaults on the next free
channel. Click a row to select it: `M` mutes it and Next chord auditions (hover a
suggestion, arrow keys, the chord editor) play through it, with its pattern, octave and
channel; without a selection they use the first unmuted track. The toolbar shows the channel
map next to the MIDI-out control (`Chords ch1 · Bass ch2 · Arp ch3`, muted tracks struck
through). Track edits are part of the song, so undo/redo and the saved song include them;
songs saved by older versions get the default band when they are loaded.

### Pattern editor

✎ on a track row opens a step grid for its pattern under the row (one at a time; ✎ again, ✕ or
`Esc` closes it). Columns are 1/16 notes, 1–4 beats long (**Length**); rows are what a step
plays: **Chord** (all tones), **Top**, **Tone 1…8** (chord tones counted from the bottom of the
voicing; on a triad: root, 3rd, 5th, then the same an octave up), **Octave** (the bass note an
octave up), **Fifth**, **Root** and **Bass**.

- Click an empty cell to add a step, drag right to make it longer; drag from a step to change its
  end; click a step to remove it.
- Shift+click toggles a step's accent: accented steps play at the track velocity, normal ones at
  75 % of it (solid vs. light cells).
- **Strum** fills a rolled chord on every beat, **Down–up** the chord on every eighth (accented on
  the beat), **Clear** empties the grid. **Hold last note** holds the last step to the chord end.
- Any edit makes the track's pattern *Custom*. **Save as preset** stores it in the song under the
  name you type (or its current name), so every track can pick it from **Song presets** in the
  pattern select; **Delete preset** removes it again (tracks keep the pattern as *Custom*).

Every gesture is one undo step. Song presets are saved and synced with the song (song schema 4,
`docs/specs/pattern-editor-v1.md`).

### Browser sound: presets, instruments and drums

Playback in the browser uses two kinds of instruments: **SoundFont** instruments (samples from
the FluidR3_GM General MIDI SoundFont, loaded on demand; see
[`docs/specs/soundfonts-v1.md`](../../docs/specs/soundfonts-v1.md)) and **synth** instruments
synthesised with Web Audio. The **Sound** select at the top of the Band panel picks a preset,
which gives every track an instrument by its role; after that each track (and the melody) can
get its own in its **Instrument** column. While a track has its own choice the preset reads
"Band (custom)"; **Reset** gives every track the preset's instruments again.

| Preset | Chords | Bass | Arp | Pad | Custom | Melody | Drums |
|--------|--------|------|-----|-----|--------|--------|-------|
| Piano | piano | piano | piano | piano | piano | lead | none |
| **Band** (default) | Acoustic Grand Piano | Acoustic Bass | Electric Piano 1 | String Ensemble 1 | Acoustic Grand Piano | lead | straight |
| Pad | pad | bass | piano | pad | pad | lead | none |
| Chamber | Harpsichord | Pizzicato Strings | Flute | String Ensemble 1 | Harpsichord | Clarinet | none |
| Electric | Electric Piano 1 | Synth Bass 1 | Acoustic Guitar (nylon) | Church Organ | Electric Piano 1 | lead | half-time |

SoundFont instruments: Acoustic Grand Piano, Bright Acoustic Piano, Electric Piano 1,
Harpsichord, Vibraphone, Church Organ, Acoustic Guitar (nylon), Acoustic Bass, Electric Bass
(finger), Synth Bass 1, Pizzicato Strings, String Ensemble 1, Choir Aahs, Clarinet, Flute. An
instrument loads when it is chosen (or first played); until then its track plays the closest
synth instrument, so there is always sound. Loaded samples stay in the browser's cache, so a
second visit does not download them again. Every third note is sampled; the notes between play
the nearest sample, retuned. At most 32 sample notes sound at once (the oldest fades first).

The samples are not in git: `node tools/soundfonts/fetch.mjs` downloads them into
`public/soundfonts/` and checks every file against `tools/soundfonts/manifest.json` (`pnpm dev`
does this on its first start; `--check` only verifies). Without them the app plays the synth
stand-ins.

- **Piano:** three slightly detuned sines on the fundamental plus slightly stretched
  (inharmonic) partials, a short hammer-noise click, a fast first decay into a long tail (low
  notes ring longer, brighter low notes, duller high notes), harder notes louder and brighter, a
  short damper on release. Notes are panned by pitch (low left, high right) and share a small
  room. At most 24 piano voices sound at once; the oldest is cut short first. The Band preset
  uses a slightly darker, drier piano (`brightness`, `room` per preset).
- **Pad:** two detuned saws with a slow attack, behind a lowpass that opens slowly.
- **Bass:** plucked, filtered triangle with a sub sine an octave down.
- **Drums:** synthesised kick, snare and hi-hat. The **Drums** select picks a pattern (None,
  Straight, Half-time, Ballad); choosing a preset resets it to the preset's default. Bars
  follow the song's meter and restart when the song loops.

Everything goes through a gentle compressor and a master gain, with enough headroom that a full
band does not clip. Hovering a suggestion or moving through the chords plays the selected track
with its instrument. The sound settings are a listening preference: they are saved in
`localStorage` (`crokychords.sound`), are not part of undo, and change nothing about Web MIDI
out (drums are never sent or exported). The exported `.mid` file carries one General MIDI
Program Change per track for its current instrument, so a GM player picks a matching sound.

To listen to the piano without opening the app, render I–V–vi–IV offline to a WAV file (nothing
is played while rendering):

```bash
PIANO_WAV=/tmp/piano.wav pnpm --filter @crokychords/web exec vitest run test/pianoOffline.test.ts
SOUNDFONT_WAV=/tmp/presets pnpm --filter @crokychords/web exec vitest run test/soundfontOffline.test.ts
```

The second line writes an 8-bar example per preset (`/tmp/presets/<preset>.wav`).

### Sampler: your own samples

The instrument select also lists eight **sampler slots** (group *Sampler*). Pick one, or
**Sampler… ✎**, and the **Sampler panel** opens under the track's row (one at a time; `∿` on the
row, ✕ or `Esc` closes it). Drop an audio file on the panel or use *Load sample…* (wav, ogg,
flac or mp3, at most 10 MB, 10 ms–30 s after decoding). The file is kept in this browser
(IndexedDB) and never uploaded; *Remove* deletes it. Loading never plays anything.

- **Waveform:** drag `S`/`E` to trim, and with the loop on the two `L` markers to set the loop.
- **Pitch:** the root note is detected when the file loads (*Detect* runs it again on the trim;
  type a note number to correct it), *Tune* ±50 cents, *Keytrack* 100 % follows the keys,
  0 % plays every key at the same pitch (drums, textures), *Reverse*.
- **Loop:** loops while the note is held and plays on to the sample end after the release.
  *Forward* with a crossfade (no click at the loop point) or *Ping-pong*.
- **Envelope** (attack, decay, sustain, release), **Filter** (lowpass, highpass or bandpass,
  cutoff, resonance, *Env*: how far the cutoff follows the envelope), **Level** (gain, pan,
  how much the velocity changes level and cutoff).
- The keys under the controls audition the slot while held. *GM* is the General MIDI program the
  `.mid` export writes for tracks that play this slot; the slot name shows in the selects.

Slots are browser sound settings like the instruments (`crokychords.sound`), never part of the
song or undo. A slot without a decoded sample plays the piano stand-in. Loud settings (high
gain, strong resonance) can exceed full scale; the master protection below catches that. Spec:
`docs/specs/sampler-v1.md`.

### Master volume and protection

The **master row** under the Sound row sets the output volume (0–100 %, default 80 %, which
plays at the normal level; 100 % is about +4 dB) and an optional protection stage at the very
end of the chain: **Off** (default), **Limiter** (holds peaks under −0.3 dBFS) or **Soft clip**
(tanh saturation, never above full scale). Both are saved locally (`crokychords.master`), never
in the song or MIDI. Volume is mouse only.

### Breakcore

The **Breakcore** button in the transport (or `K`) plays a fast, chopped amen-style break under
the progression; its pixel lamp is grey when off, blinks while the break loads, is green when it
plays and red when the break could not be loaded (hover it for the reason). The break is a real
drum-break sample (a CC0 re-made amen-style break, see `docs/DATA.md`, "Samples"), cut into 16
slices that are re-timed to the song tempo, so it follows any BPM, tempo changes and loop points.
The slider sets the **intensity** (0 % plays the break straight, 100 % chops every bar with beat
repeats, 1/16 and 1/32 stutters, reversed, pitched and shuffled slices; `Shift+K` steps through
25/50/75/100 %), **×2** doubles the speed. The **Break** select plays the bundled break or your
own: *Use my own break…* takes an audio file (two bars of 4/4, 0.5–20 s, at most 8 MB), which
is kept in this browser (IndexedDB) and never uploaded. While Breakcore is on the master
protection is at least the limiter. Intensity, speed and the chosen break are saved locally
(`crokychords.breakcore`); nothing of it goes to the song, Web MIDI or the `.mid` export. Spec:
`docs/specs/breakcore-v1.md`.

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

## Akai Fire controller

Click **Connect Fire** in the toolbar with an Akai Fire plugged in (Chrome, Edge or Opera). The
browser asks to "control and reprogram your MIDI devices": that is SysEx, which the Fire needs for
its pad colours. The request is separate from **Enable MIDI out**, so MIDI out to a DAW keeps
working on its own port. Plugging the Fire in later, or again, re-attaches it; closing the tab or
clicking **Fire connected** turns every LED off. Layout and protocol: `docs/specs/akai-fire-v1.md`.

The Fire has two pick modes, toggled with **BANK** (the knob-mode button top left): *Replace*
(BANK LED 1, the default) replaces the selected chord like a Next chord click; *Add* (LED 2)
inserts after it like a Shift+click, and its suggestions are the ones that follow the selected
chord. On the "+" slot both modes append. The OLED shows the mode, bar:beat, play/stop and loop,
the selected chord (Roman numeral and letter name) and three suggestions around the SELECT cursor
with their percentages; while a knob is touched it shows that knob's value in big digits.

| Control | Effect |
|---|---|
| Rows 1-3 | timeline: one pad per beat, four bars per row, in the degree colours; tap = select (and listen), tap again = deselect |
| BANK | toggle Replace / Add |
| Row 4, pads 1-7 | pick the diatonic triad I..vii° (Replace: replace the selected chord; Add: insert after it; SHIFT: the other one) |
| Row 4, pads 9-16 | the top eight suggestions (brightness = probability); tap to pick, as above |
| Hold a chord + tap another pad | the chord ends on that beat |
| ALT + tap a chord | remove it |
| Tap the dim pad after the last chord | append the top suggestion |
| SELECT turn / press | move the suggestion cursor / pick it per the mode (SHIFT+turn: move the selection; SHIFT+press: listen) |
| VOLUME | selected chord length ±1 beat (SHIFT: ±¼); one undo step per touch |
| PAN | inversion of the selected chord (root, /1, /2, /3 on sevenths); one undo step per touch |
| FILTER | variant of the selected chord (triad, 7, maj7, 9, maj9, sus2, sus4, add9; ø7/°7 on diminished); one undo step per touch |
| RESONANCE | tempo ±1 BPM (SHIFT: ±5) |
| PLAY / STOP / REC | play/stop, stop, loop on/off |
| PATTERN | undo (SHIFT: redo) |
| PATTERN UP / DOWN | scroll the timeline by four bars (SHIFT: start/end); follows the playhead |
| GRID ◀ ▶ | previous/next chord |
| BROWSER | In context / Popular (SHIFT: diatonic only) |
| SOLO 1-4 | mute/unmute track 1-4 (row LED green = audible, red = muted; SHIFT: select the track) |

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
