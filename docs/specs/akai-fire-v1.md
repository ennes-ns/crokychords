# Spec: Akai Fire controller v1

Status: v1 implemented (2026-10-20) in `apps/web/src/midi/fire/` (issue #41); v2 (Replace/Add
mode, OLED, PAN/FILTER) implemented (issue #62), see "v2 as built". Decisions in section 7.
Prototype in `tools/fire/`. Owner: main session.

## Goal

Build and edit a progression on an Akai Fire (4×16 RGB pads, 4 endless encoders plus a pushable
SELECT encoder, 128×64 OLED, transport and mode buttons) without touching the mouse. The pads mirror
the editor's chord grid in the editor's degree colours; the most common action, "add the next chord",
is one tap with one hand.

Non-goals for v1: melody lane, per-step pattern editing, recording live chord playing, Firefox/Safari.

## 1. Findings: the protocol

The Fire is a class-compliant USB MIDI device with one port (ALSA name `FL STUDIO FIRE Jack 1`). It
has no on-board modes: every LED and the OLED are drawn by the host, inputs are plain notes and CCs on
channel 1. Nothing is stored on the device, so nothing a host sends is persistent; unplugging resets it.
Verified on the device with `tools/fire/` (Linux, ALSA sequencer) on 2026-10-20.

### Inputs (channel 1)

| Control | Message | Notes |
|---|---|---|
| Pads | note on/off `0x36 + row*16 + col` (rows 0–3 top to bottom, cols 0–15) | velocity present but hard to control; ignore it |
| Encoders VOLUME, PAN, FILTER, RESONANCE | turn: CC `0x10`–`0x13`; touch: note `0x10`–`0x13` | relative, 7-bit two's complement: `0x01`–`0x3F` clockwise, `0x7F`–`0x40` counter-clockwise; one message per detent step, faster turns give repeated ±1 (observed) |
| SELECT encoder | turn: CC `0x76` (relative, as above); press: note `0x19` | |
| BANK (knob mode) | note `0x1A` | |
| PATTERN UP / DOWN | note `0x1F` / `0x20` | |
| BROWSER | note `0x21` | |
| GRID LEFT / RIGHT | note `0x22` / `0x23` | |
| SOLO 1–4 (row buttons) | note `0x24`–`0x27` | |
| STEP, NOTE, DRUM, PERFORM | note `0x2C`–`0x2F` | |
| SHIFT, ALT | note `0x30`, `0x31` | |
| PATTERN/SONG | note `0x32` | |
| PLAY, STOP, REC | note `0x33`, `0x34`, `0x35` | |

Buttons send note on (velocity `0x7F`) on press and note off on release, so SHIFT/ALT can be held as
modifiers and pads support hold-and-tap gestures.

### Outputs

- **Pads**: SysEx `F0 47 7F 43 65 hh ll [ii rr gg bb]… F7`. `47` Akai, `7F` all-call, `43` Fire,
  `65` write pads. `hh ll` = payload length as two 7-bit bytes (high = bits 7–13, low = bits 0–6).
  `ii` = pad index `row*16 + col` (0–63, top-left first), `rr gg bb` 0–127. Any subset of pads per
  message; all 64 pads = 256 payload bytes = one 264-byte message.
- **Button LEDs**: CC on the button's own number, value 0 off, 1 dull, 2 bright (single-colour
  buttons); dual-colour buttons (PLAY green/yellow, REC red/yellow, …) use 1–4 for dull/bright of the
  two colours.
- **Row LEDs** (the rectangles between SOLO buttons and pads): CC `0x28`–`0x2B`, 0 off, 1 dull red,
  2 dull green, 3 bright red, 4 bright green.
- **BANK LEDs** (CHANNEL, MIXER, USER 1, USER 2): CC `0x1B`, value `0x10 | mask` (bit 0 channel,
  1 mixer, 2 user 1, 3 user 2).
- **All LEDs off**: CC `0x7F` value 0.
- **OLED**: SysEx `F0 47 7F 43 0E hh ll 00 07 00 7F <1171 bytes> F7` (bands 0–7 of 8 rows, columns
  0–127, full frame = 1183 bytes). Pixels are packed seven per byte in a fixed shuffled order; the
  encoder in `tools/fire/fire.py` (`oled_sysex`, 20 lines) is the reference and ports directly to TS.
  Text needs a bitmap font on the host side (the device has none).

### Sources

- SEGGER blog, "Decoding the Akai Fire MIDI implementation", parts 1–3 (buttons, LEDs, OLED):
  https://blog.segger.com/decoding-the-akai-fire-part-1/ , `-part-2/`, `-part-3/`
- Chrome: "Access to MIDI devices now requires user permission":
  https://developer.chrome.com/blog/web-midi-permission-prompt
- W3C Web MIDI API: https://www.w3.org/TR/webmidi/
- Verified locally with `tools/fire/demo.py --monitor` (input table) and `demo.py` (pads, OLED, LEDs).

## 2. Integration options

| | (a) Web MIDI in the browser | (b) Local bridge (Python/Node ↔ WebSocket) | (c) Native plugin (ADR 0002) |
|---|---|---|---|
| Latency | sub-ms to the device; pad repaint in one SysEx | extra hop + WebSocket, still a few ms | best, but no browser UI |
| Setup friction | one click "Connect Fire" + one permission prompt (SysEx) | install and run a helper, keep it running | install plugin in a DAW |
| OLED / pads | yes (`sysex: true`) | yes | yes |
| Works on the online site | yes in Chrome/Edge/Opera on https; Firefox only with its site-permission add-on; no Safari | only with the helper installed locally; mixed-content rules for `ws://localhost` from an https page | n/a |
| Linux | Chrome uses the ALSA sequencer: port shared with other apps | same | same |
| Code | ~600 lines TS in `apps/web/src/midi/fire/`, testable with a fake port | a second program to ship and support | later, reuses the same protocol module |

**Recommendation: (a) Web MIDI in the browser for v1.** It needs nothing installed, works on the
online version, and the app already has a `MidiOut` wrapper whose `RequestMidiAccess` seam can take a
second request with `{ sysex: true }`. The Fire request must be separate and opt-in (a "Connect Fire"
action), so users without a Fire never see the stronger SysEx prompt. (b) is only worth it if Safari
support is demanded; (c) reuses the protocol module later.

## 3. Workflow and mapping

What a musician does most, in order: add the next chord (from the suggestions or a degree), select a
chord and change it, change its length, play/loop, undo. The common path must be right-hand only,
on the pads and the SELECT encoder; SHIFT/ALT are on the left for the less common edits.

### Variants considered

| Variant | Pads | Strength | Weakness |
|---|---|---|---|
| A. Full timeline | 64 pads = 16 bars, 1 pad per beat, 4 bars per row (exactly the editor's grid) | maximum overview, the maintainer's "one pad per beat" | choosing a chord needs the SELECT encoder or a modifier; no direct degree entry |
| B. Bar per row | 4 bars, one row per bar, 16 pads = 16 sixteenths | quarter-beat precision, good for a melody lane | only 4 bars visible; chords mostly sit on beats, so precision is wasted |
| **C. Timeline + palette** | rows 1–3 = 12 bars (1 pad per beat, 4 bars per row), row 4 = palette: 7 degree triads + 8 next-chord suggestions | one tap adds the next chord; the grid still mirrors the editor; suggestions visible as colours without the OLED | 12 instead of 16 bars per page (PATTERN UP/DOWN scrolls) |

**Pick: C.** It keeps the maintainer's beat grid, makes "add next chord" a single tap, and works
fully in v1 without the OLED (suggestions are coloured pads; the OLED adds names and percentages in
v2). Variant B's layout is reused for the melody lane in v2 (NOTE mode).

### Pads (STEP mode, default)

```
            col: 1   2   3   4 | 5   6   7   8 | 9  10  11  12 |13  14  15  16
 SOLO1 ▭ row 1: [I ][I ][I ][I ][V ][V ][V ][V ][vi][vi][vi][vi][IV][IV][IV][IV]   bars 1-4
 SOLO2 ▭ row 2: [I ][I ][I ][I ][V ][V ][V ][V ][vi][vi][vi][vi][IV][IV][IV][IV]   bars 5-8
 SOLO3 ▭ row 3: [+ ][  ][  ][  ][  ][  ][  ][  ][  ][  ][  ][  ][  ][  ][  ][  ]   bars 9-12
 SOLO4 ▭ row 4: [I ][ii][iii][IV][V ][vi][vii°][  ][s1][s2][s3][s4][s5][s6][s7][s8]
                 \______ degree triads ______/       \______ next-chord suggestions _____/
   1 pad = 1 beat (4/4). Chord pads in its degree hue: first beat bright, held beats dim,
   selected chord whitened, playhead white, "+" = append slot (dim white).
   Suggestions: hue = degree, brightness = probability; the SELECT cursor is whitened.
```

| Gesture | Effect |
|---|---|
| Tap a chord | select it and audition it; tap again to go back to the "+" slot (no chord selected) |
| Tap a palette pad | replace the selected chord's token (keep length); on the "+" slot append that chord (editor rule, `web-v1.md` §3) |
| SHIFT + palette pad | insert that chord after the selected chord and select it |
| Tap the append slot or any empty beat after the end | append the top suggestion (the "+" slot stays selected) |
| Hold a chord + tap a later pad | the chord ends on that beat (resize in one gesture) |
| ALT + tap a chord | remove it |

### Encoders and buttons

```
 ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 │ (VOLUME)  (PAN)   (FILTER)  (RESONANCE)   [OLED 128x64]  (SELECT)   [PAT UP]  [BROWSER]     │
 │  length  inversion  ext.      tempo        chord/sugg.    sugg./ins  [PAT DN]  ctx/popular  │
 │ [BANK] knob page                                         [GRID ◀] [GRID ▶] prev/next chord │
 │ [SOLO1-4] mute track 1-4   ▭ row LEDs = track mute state      4 x 16 pads (see above)      │
 │ [STEP] chords [NOTE] melody(v2) [DRUM] band(v2) [PERFORM] play chords live (v2)             │
 │ [SHIFT] fine/alt  [ALT] delete   [PATTERN] undo (SHIFT: redo)  [PLAY] [STOP] [REC] loop     │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Control | Plain | With SHIFT |
|---|---|---|
| SELECT turn | move the suggestion cursor (row 4 + panel highlight) | move the chord selection |
| SELECT press | pick the suggestion under the cursor (replace the selected chord; append on the "+" slot) | audition it only |
| VOLUME | selected chord length ±1 beat | ±¼ beat |
| PAN | inversion (root, /1, /2, /3) (v2) | — |
| FILTER | extension/quality variant of the selected chord (triad → 7 → maj7/ø7 … → sus2 → sus4 → add9), only canonical tokens the chord editor offers (v2) | applied chord V/x (later) |
| RESONANCE | tempo ±1 BPM | ±5 BPM |
| PLAY | play/pause | play from the selection |
| STOP | stop, playhead to 0 | all notes off |
| REC | loop on/off | — |
| GRID ◀ ▶ | previous/next chord | move the chord left/right |
| PATTERN UP/DOWN | scroll the timeline by one row (4 bars); auto-follows the playhead | jump to start/end |
| BROWSER | toggle In context / Popular | toggle diatonic only |
| PATTERN | undo | redo |
| SOLO 1–4 | mute/unmute band track 1–4 (row LED green = audible, red = muted) | select that track (auditions) |
| BANK | toggle the pick mode Replace / Add (v2; replaces the planned knob-page cycle, see v2 as built) | — |

Button LEDs: PLAY bright while playing, REC lit when looping, SHIFT/ALT bright while held, STEP lit
as the active mode, BANK LEDs show the pick mode (LED 1 Replace, LED 2 Add).

### OLED (v2)

Line 1: selected chord token, lead-sheet name, beats, tempo (`3: vi  Am  4b  120`). Lines 2–5: the
suggestion list around the cursor, `IV  F   39%`, cursor row inverted. While a knob is touched it shows
that parameter large (`Length 4 beats`). Redraw only on change and at most ~20 fps (v2: measured,
capped at 30 fps; see v2 as built).

## 4. Implementation notes (web)

- `apps/web/src/midi/fire/protocol.ts`: pure encoders/decoders (pads SysEx, OLED SysEx, LED CC,
  input decode to `FireEvent`), ported from `tools/fire/fire.py`; unit tests with byte fixtures.
- `apps/web/src/midi/fire/view.ts`: pure `renderPads(state, page) → Rgb[64]` and the gesture
  state machine `(state, event, held) → Action[]` calling the existing `Actions`
  (`insert`, `select`, `resizeSelected`, `setSelectedToken`, `removeSelected`, `togglePlay`, `undo`, …).
  Colours come from `degreeHue` in `music.ts` (convert HSL to 7-bit RGB; pads look best at full
  saturation, dim beats ~20 % brightness).
- `apps/web/src/midi/fire/connect.ts`: finds input+output whose name contains `FIRE`, requests
  `requestMIDIAccess({ sysex: true })` only on the user's "Connect Fire" click, subscribes to the store,
  diff-repaints only changed pads (one SysEx), clears everything on disconnect, page hide and
  `beforeunload`, and re-attaches on `statechange` (hot-plug).
- New state: `fire: { status, page, scroll, cursor }` outside the song (no undo). The suggestion cursor
  is shared with the Next chord panel so screen and pads agree.
- Playhead: repaint at most once per beat from the existing `cursor`; never block the audio scheduler.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Chrome asks "control and reprogram your MIDI devices" for SysEx, which sounds scary; since Chrome 124 even plain MIDI prompts | separate opt-in button with one sentence of explanation; if denied, fall back to inputs-only without pad colours (plain MIDI permission) and say so |
| "FL Studio mode" | none on the device: it is a plain MIDI controller, all behaviour is host-side. Its own DAW script only runs inside that DAW, which must not be open on the same port at the same time on Windows |
| Two apps on the port | Linux (ALSA sequencer) and macOS share ports: both apps receive input and both paint, last writer wins. Windows opens ports exclusively: a second app fails to open it. Show "Fire busy" and repaint fully on focus |
| Pad LED refresh | one 264-byte SysEx repaints all 64 pads; diff and coalesce to one message per animation frame, playhead at beat rate |
| OLED bandwidth | 1183 bytes per frame, ~59 frames/s at most (measured); redraw on change only, changed bands only, cap 30 fps |
| Browser tab in background | Web MIDI keeps working, but timers are throttled: repaint is event-driven, not timer-driven |
| Stale LEDs after closing the tab | send all-off + blank OLED on `pagehide`; the device keeps the last frame otherwise |

## 6. Phased plan

1. **v1 (issue "[task] web: Akai Fire controller v1", size L):** protocol module with tests, Connect
   Fire button, pad grid (variant C) with degree colours, playhead, selection, palette insert/replace,
   hold+tap resize, ALT delete, SELECT encoder suggestions (cursor shared with the panel), VOLUME
   length, RESONANCE tempo, transport, undo, scroll, SOLO mute, button LEDs.
2. **v2:** OLED (chord, suggestions with percentages, knob feedback), FILTER extensions and PAN
   inversions, Band knob page, PERFORM mode (pads play chords live through the selected track).
3. **v3:** NOTE mode melody lane (variant B layout: 4 bars × 16 sixteenths, pad = note start, hold+tap
   = note length, encoders = pitch/velocity), then the same protocol module in the native plugin.

### v1 as built (deviations from the plan above)

- Files: `protocol.ts` (encoders/decoder, golden-tested against `tools/fire/fire.py`),
  `view.ts` (pad colours), `controller.ts` (gestures, button LEDs), `connect.ts` (Web MIDI,
  repaint, hot-plug). The `fire` state slice holds `status`, `scroll` and `cursor`.
- The SELECT cursor lives in `fire.cursor`; the Next chord panel does not highlight it yet (v2).
- Encoder edits (VOLUME, RESONANCE) are previewed per detent and committed as one undo step when
  the knob is released (touch note off) or another control is used.
- Hold + tap also shortens: tapping a pad inside the held chord ends it there.
- Not in v1: PAN inversions, FILTER variants, GRID with SHIFT (move chord), BANK knob page, the
  inputs-only fallback when SysEx is denied (the button shows "SysEx denied" instead), OLED text
  beyond the static title.

### v2 as built (issue #62)

Files: `oled.ts` (model, drawing, band diffing), `font.ts` (generated), controller and connection
changes; tests in `fireOled.test.ts` with golden frames in `apps/web/test/fixtures/fire-oled/`.

**Replace / Add mode.** BANK (note `0x1A`) toggles `fire.mode` (outside the song, no undo). LED 1
of the four BANK LEDs (CC `0x1B`, value `0x11`) = Replace, the default; LED 2 (`0x12`) = Add.

| Pick (palette pad, SELECT press) | Replace | Add |
|---|---|---|
| chord selected | replace its token, keep its length (the web UI's click) | insert after it and select the new chord (the web UI's Shift+click) |
| "+" slot | append, "+" stays selected | same |
| with SHIFT | insert after (as v1) | replace |

In Add mode the palette suggestions and the OLED list are the ones for the slot after the selected
chord (context up to and including it), so successive picks build forward. The Next chord panel on
screen keeps showing the suggestions for the selected chord itself.

**OLED.** Drawn in the Pixel theme's font (Departure Mono at its native 11 px: a 7 x 11 cell,
18 characters per line), rasterised once by `tools/fire/oled_font.py` into `font.ts`. Layout:

```
 rows  0-9   [REPLACE] 3:1                ⟳ ▶      mode badge (inverted), bar:beat, loop, play/stop
 rows 11-30  vi (2x)                       Am      selected chord: Roman numeral big, letter name,
                                       4 beats     length; "+ / add / N chords" on the "+" slot
 rows 31-63  IV      F                    39%      three suggestions around the SELECT cursor,
             V       G                    21%      the cursor row inverted
             ii      Dm                   14%
```

While VOLUME, PAN, FILTER or RESONANCE is touched (touch note on until off), rows 11-63 show the
parameter name and its value in 3x digits (`Length 2.5 beats`, `Inversion 1st V7/1`,
`Chord V7 G7`, `Tempo 120 BPM`). bar:beat follows the playhead while playing and shows the
selected slot's start when stopped. The v1 splash title is gone: the status screen appears on
connect.

**Frame rate (measured).** `tools/fire/fire.py --oled-fps` on the device (Linux, ALSA sequencer,
2026-10-20): full 1183-byte frames for 10 s per rate, with the kernel's `Tx bytes` counter of the
port showing how far the device lags behind.

| Target | Sent | Largest backlog | Dropped |
|---|---|---|---|
| 10 fps | 100 frames | < 1 frame (the one in flight) | 0 |
| 20 fps | 200 | < 1 frame | 0 |
| 30 fps | 300 | 1 frame | 0 |
| 60 fps | 600 | 5 frames, growing | 1.6 frames' worth of bytes |
| as fast as it drains | 59 fps | 1 frame | 0 |

The Fire accepts about **59 full frames per second** (~70 KB/s of SysEx) and no more; at a steady
60 fps messages queue, and on Linux the ALSA sequencer drops a SysEx that does not fit the port's
4 KiB output buffer ("MIDI output buffer overrun") instead of waiting, so a backlog loses frames.
The web app caps OLED updates at **30 fps** (`OLED_MAX_FPS`), half the measured limit, which leaves
room for pad SysEx and LED messages on the same port; a change inside the interval is held and sent
when it ends, coalesced with later changes.

**Band diffing.** The OLED SysEx addresses a range of 8-row bands (`F0 47 7F 43 0E hh ll <first>
<last> 00 7F <data> F7`). The connection keeps the frame it last sent and sends one message per
run of changed bands (a single band is 159 bytes instead of 1183); the packing restarts at the
first band (`oled_bands_sysex` in `tools/fire/fire.py`, golden-tested). A beat change while playing
only rewrites band 0-1. The partial-band packing is derived from the full-frame encoder and has not
been checked by eye on the device yet (the SEGGER write-up only documents full frames). Check:
`tools/fire/fire.py --band-check` must show clean vertical bars in rows 8-15, 24-31 and 40-55 only;
if it shows scrambled dots, partial packing differs and full frames at 30 fps are the fallback.

**PAN / FILTER.** PAN steps the selected chord through the inversions the chord editor offers
(root, /1, /2, and /3 only on seventh chords), clamped at the ends. FILTER steps through the
triad, its sevenths and ninths (major: 7, maj7, 9, maj9; minor: 7, maj7, 9; diminished: ø7, °7;
augmented: 7, maj7), then sus2, sus4 and add9, keeping degree, accidental, applied target and
inversion; a token outside that list (an alteration, an 11th, …) stays first so turning back
returns to it. Both preview per detent (and audition when stopped) and commit one undo step when
the knob is released, like VOLUME.

## 7. Open questions for the maintainer

Decided 2026-10-20 (issue #41): variant C; SOLO buttons mute tracks; the OLED suggestion list is
v2 (v1 shows a static title); Web MIDI in the browser behind a "Connect Fire" button.


1. Variant C (12 bars + palette row) or variant A (16 bars, no palette)?
2. SOLO buttons for band mutes, or for jumping to rows/pages?
3. In v1 the OLED shows only a static "Croky Chords" splash; is moving the suggestion list to v1 worth
   the bitmap font work?
