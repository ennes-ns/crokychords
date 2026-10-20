# Spec: loop points (v1)

Status: **implemented** (issue #47). Extends `web-v1.md` §6 (Playback and MIDI).

## Goal

Playback can loop a range of the song instead of the whole song. Play always starts from the
beginning (of the loop when looping), and Space is play/stop wherever the focus is, except while
typing.

## Model

- `AppState.loopRange: { start, end } | null` in beats (`start` inclusive, `end` exclusive,
  `0 <= start < end`), next to the existing `AppState.loop` flag. The Loop checkbox loops the
  range when one is set, else the whole song. A range that lies (partly) past the song end is
  clipped to the song; nothing of it left inside the song loops the whole song (`loopBounds`).
- The loop is **UI state, not part of the song**: no core schema bump, no undo. It is persisted
  per saved progression in `localStorage` under `crokychords.loop.<record id>`:

  ```json
  { "schema_version": 1, "enabled": true, "startBeat": 4, "endBeat": 12 }
  ```

  `startBeat`/`endBeat` are both null when no range is set. Entries that do not parse are ignored.
  Being per device, the loop does not sync between devices.
- Opening a progression (`Store.load`) clears the range; `bindLoopPersistence` (loop.ts) then
  applies the stored loop of the opened record. A record without a stored loop (a new song on its
  first save, a conflict copy) takes the current loop. Every change is written at once.
- If the loop moves into the song schema later (`song.loop`), this entry is the migration source.

## Setting the loop

- **Mouse:** click a bar number to loop that bar; drag over the bar numbers to loop the bars
  dragged over; Shift+click a bar number to extend the range to that bar (a bar before the start
  moves the start, any other bar sets the end). The toolbar shows the range (`bars 2–3`, or
  `bar.beat` positions off the bar lines) and a × button that clears it.
- **Keyboard:** `L` toggles looping. `Alt+[` sets the loop start at the selected chord's start
  (the end stays if it is later, else it becomes the song end); `Alt+]` sets the loop end at the
  selected chord's end (the start stays if it is earlier, else it becomes 0). `[`/`]` alone keep
  resizing the selected chord, so the loop keys take Alt (matched by physical key, as Alt changes
  the character on some layouts).
- Setting a range turns looping on.
- **Grid:** the range is shaded in the tracks and its bar numbers are highlighted; dimmer when
  looping is off.

## Playback

- Play (`Space`, the Play button) starts at the loop start when looping (beat 0 for the whole
  song), else at beat 0. `Shift+Space` plays from the selected chord.
- The scheduler keeps a growing timeline: pass 0 plays the song from the start position up to the
  loop end, pass k >= 1 plays the range shifted by k range lengths, so the jump back has no gap.
  Notes that run past the loop end are cut there. At every wrap the sinks get
  `loopWrap(time)`; the Web MIDI sink sends note-offs for what it played and All Notes Off (CC 123)
  on the song's channels, timestamped at the wrap, before the next pass's note-ons.
- Changing the loop or the range while playing applies at once; when the playhead is past the new
  loop end it jumps to the loop start. Turning looping off plays on to the song end.

## Space

Space is play/stop on the page and on every control (selects, checkboxes, buttons), except where
it types: text inputs (the song title), number inputs (BPM), text areas, contentEditable. The
keyup of a Space that played/stopped is swallowed so a focused button or checkbox does not also
react. Auto-repeat is ignored.
