"""Croky Chords on the Akai Fire: a stand-alone prototype of the v1 mapping in docs/specs/akai-fire-v1.md.

Rows 1-3 are the timeline (one pad per beat, four 4/4 bars per row, like the editor's grid);
row 4 is the palette (pads 1-7 = diatonic triads I..vii°, pads 9-16 = next-chord suggestions).
The progression starts as I-V-vi-IV twice. No audio: this only exercises the controller.

    uv run --no-project --with mido --with python-rtmidi --with pillow python tools/fire/demo.py
    ... demo.py --seconds 120     stop by itself after two minutes
    ... demo.py --monitor         only print raw events (pads stay dark)
"""

from __future__ import annotations

import argparse
import os
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # `python -I` drops the script dir
import fire as F  # noqa: E402

DEGREE_HUES = {1: 0, 2: 30, 3: 52, 4: 125, 5: 190, 6: 228, 7: 280}  # same as apps/web music.ts
DIATONIC = ["I", "ii", "iii", "IV", "V", "vi", "vii°"]
ROMAN = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6, "VII": 7}
BAR = 4  # beats per bar (4/4)
TIMELINE_ROWS = 3
ROW_BEATS = BAR * 4

# A tiny stand-in for the n-gram table: follower percentages after the previous chord.
NEXT = {
    "I": [("IV", 31), ("V", 28), ("vi", 18), ("ii", 9), ("iii", 5), ("bVII", 4), ("V/vi", 3), ("I", 2)],
    "ii": [("V", 46), ("IV", 14), ("I", 12), ("vi", 10), ("iii", 7), ("V7", 6), ("ii", 3), ("bVII", 2)],
    "iii": [("vi", 38), ("IV", 30), ("ii", 10), ("I", 9), ("V", 7), ("iii", 3), ("V/vi", 2), ("bVII", 1)],
    "IV": [("I", 34), ("V", 31), ("vi", 12), ("ii", 8), ("iv", 6), ("IV", 4), ("iii", 3), ("bVII", 2)],
    "V": [("I", 41), ("vi", 27), ("IV", 16), ("ii", 5), ("iii", 4), ("V", 3), ("bVI", 2), ("V/V", 2)],
    "vi": [("IV", 39), ("V", 21), ("ii", 14), ("I", 11), ("iii", 8), ("vi", 4), ("bVII", 2), ("V/V", 1)],
}
POPULAR = [("I", 24), ("V", 20), ("IV", 19), ("vi", 15), ("ii", 8), ("iii", 5), ("bVII", 4), ("vii°", 2)]


def degree(token: str) -> int | None:
    t = token.split("/")[-1] if "/" in token and not token.split("/")[-1].isdigit() else token
    t = t.lstrip("b#")
    letters = "".join(ch for ch in t if ch.upper() in "IV").upper()
    return ROMAN.get(letters)


def suggestions(chords: list[list], selected: int | None) -> list[tuple[str, int]]:
    if not chords:
        return POPULAR
    prev = chords[selected if selected is not None else -1][0]
    return NEXT.get(prev, POPULAR)


class Demo:
    def __init__(self, fire: F.Fire) -> None:
        self.f = fire
        self.chords: list[list] = [[t, 4] for t in ["I", "V", "vi", "IV"] * 2]  # [token, beats]
        self.history: list[list[list]] = []
        self.selected: int | None = None
        self.scroll = 0  # first visible timeline row
        self.cursor = 0  # highlighted suggestion (SELECT encoder)
        self.tempo = 120
        self.playing = False
        self.play_start = 0.0
        self.playhead: int | None = None
        self.shift = self.alt = False
        self.held: int | None = None  # chord index whose pad is held (for hold+tap resize)
        self.last_pads: list | None = None
        self.dirty_oled = True

    # --- model helpers ---------------------------------------------------------------------
    def starts(self) -> list[int]:
        out, b = [], 0
        for _, beats in self.chords:
            out.append(b)
            b += beats
        return out

    def total(self) -> int:
        return sum(b for _, b in self.chords)

    def chord_at(self, beat: int) -> int | None:
        for i, s in enumerate(self.starts()):
            if s <= beat < s + self.chords[i][1]:
                return i
        return None

    def save(self) -> None:
        self.history.append([c[:] for c in self.chords])
        self.history = self.history[-50:]

    def insert(self, token: str) -> None:
        self.save()
        at = (self.selected + 1) if self.selected is not None else len(self.chords)
        start = self.starts()[at] if at < len(self.chords) else self.total()
        beats = min(4, BAR - start % BAR) or BAR
        self.chords.insert(at, [token, beats])
        self.selected = at
        self.cursor = 0
        print(f"insert {token} ({beats} beats) at {at + 1}", flush=True)

    # --- rendering -------------------------------------------------------------------------
    def render_pads(self) -> None:
        pads = []
        starts = self.starts()
        total = self.total()
        for row in range(TIMELINE_ROWS):
            for col in range(F.COLS):
                beat = (self.scroll + row) * ROW_BEATS + col
                i = self.chord_at(beat)
                rgb = (0, 0, 0)
                if i is not None:
                    d = degree(self.chords[i][0])
                    hue = DEGREE_HUES.get(d or 1, 0)
                    first = beat == starts[i]
                    if i == self.selected:
                        rgb = F.hue_rgb(hue, 1.0, 0.45 if first else 0.6)
                    else:
                        rgb = F.hue_rgb(hue, 0.9 if first else 0.22)
                elif beat == total:
                    rgb = (14, 14, 14)  # append slot
                elif col % BAR == 0:
                    rgb = (2, 2, 2)  # empty bar start
                if beat == self.playhead:
                    rgb = (127, 127, 127)
                pads.append((row * F.COLS + col, *rgb))
        sugg = suggestions(self.chords, self.selected)
        base = TIMELINE_ROWS * F.COLS
        for col, token in enumerate(DIATONIC):
            pads.append((base + col, *F.hue_rgb(DEGREE_HUES[col + 1], 0.55)))
        pads.append((base + 7, 0, 0, 0))
        for k in range(8):
            token, pct = sugg[k]
            hue = DEGREE_HUES.get(degree(token) or 1, 0)
            light = 0.15 + 0.85 * min(1.0, pct / 40)
            rgb = F.hue_rgb(hue, 1.0, 0.3) if k == self.cursor else F.hue_rgb(hue, light)
            pads.append((base + 8 + k, *rgb))
        if pads != self.last_pads:
            self.f.pads(pads)
            self.last_pads = pads

    def render_oled(self) -> None:
        if not self.dirty_oled:
            return
        self.dirty_oled = False
        if self.selected is not None:
            tok, beats = self.chords[self.selected]
            head = f"{self.selected + 1}: {tok}  {beats}b  {self.tempo}bpm"
        else:
            head = f"Croky Chords  {self.tempo}bpm"
        sugg = suggestions(self.chords, self.selected)
        top = max(0, min(self.cursor - 1, len(sugg) - 4))
        lines = [(head, 12)] + [f"{k + 1}. {t:<6} {p:>3}%" for k, (t, p) in enumerate(sugg)][top : top + 4]
        self.f.oled(F.render_lines(lines, invert_rows=[self.cursor - top + 1]))

    def render_leds(self) -> None:
        self.f.cc(F.BTN_PLAY, 2 if self.playing else 1)
        self.f.cc(F.BTN_STOP, 1)
        self.f.cc(F.BTN_SHIFT, 2 if self.shift else 1)
        self.f.cc(F.BTN_ALT, 2 if self.alt else 1)
        self.f.cc(F.BTN_STEP, 2)
        rows = max(1, -(-self.total() // ROW_BEATS) + 1)
        for r, cc in enumerate(F.LED_ROW):
            self.f.cc(cc, 4 if r < TIMELINE_ROWS and self.scroll + r < rows else (2 if r == 3 else 0))

    def render(self) -> None:
        self.render_pads()
        self.render_oled()

    # --- input -----------------------------------------------------------------------------
    def on_pad(self, row: int, col: int, down: bool) -> None:
        if row == TIMELINE_ROWS:  # palette
            if not down:
                return
            token = DIATONIC[col] if col < 7 else (suggestions(self.chords, self.selected)[col - 8][0] if col >= 8 else None)
            if token is None:
                return
            if self.shift and self.selected is not None:
                self.save()
                self.chords[self.selected][0] = token
                print(f"replace {self.selected + 1} -> {token}", flush=True)
            else:
                self.insert(token)
            self.dirty_oled = True
            return
        beat = (self.scroll + row) * ROW_BEATS + col
        i = self.chord_at(beat)
        if not down:
            if self.held is not None and i == self.held:
                self.held = None
            return
        if self.held is not None and (i is None or i != self.held):
            s = self.starts()[self.held]
            if beat > s:  # hold a chord, tap a later pad: chord ends there
                self.save()
                self.chords[self.held][1] = beat - s + 1
                print(f"resize {self.held + 1} -> {beat - s + 1} beats", flush=True)
                self.dirty_oled = True
            return
        if i is None:
            if beat >= self.total():
                self.selected = None
                self.insert(suggestions(self.chords, None)[0][0])
                self.dirty_oled = True
            return
        if self.alt:
            self.save()
            del self.chords[i]
            self.selected = None if not self.chords else min(i, len(self.chords) - 1)
            print(f"remove {i + 1}", flush=True)
        else:
            self.selected = None if self.selected == i else i  # tap again to deselect
            self.held = i
            print(f"select {self.selected + 1 if self.selected is not None else '-'}", flush=True)
        self.cursor = 0
        self.dirty_oled = True

    def on_button(self, note: int, down: bool) -> None:
        if note == F.BTN_SHIFT:
            self.shift = down
        elif note == F.BTN_ALT:
            self.alt = down
        elif not down:
            return
        elif note == F.BTN_PLAY:
            self.playing = not self.playing
            self.play_start = time.monotonic()
            self.playhead = None if not self.playing else 0
        elif note == F.BTN_STOP:
            self.playing, self.playhead = False, None
        elif note in (F.BTN_GRID_LEFT, F.BTN_GRID_RIGHT) and self.chords:
            step = -1 if note == F.BTN_GRID_LEFT else 1
            cur = self.selected if self.selected is not None else (-1 if step > 0 else len(self.chords))
            self.selected = max(0, min(len(self.chords) - 1, cur + step))
            self.dirty_oled = True
        elif note in (F.BTN_PAT_UP, F.BTN_PAT_DOWN):
            self.scroll = max(0, self.scroll + (-1 if note == F.BTN_PAT_UP else 1))
        elif note == F.BTN_SELECT_PRESS:
            self.insert(suggestions(self.chords, self.selected)[self.cursor][0])
            self.dirty_oled = True
        elif note == F.BTN_PATTERN and self.history:
            self.chords = self.history.pop()
            self.selected = None
            self.dirty_oled = True
            print("undo", flush=True)
        self.render_leds()

    def on_turn(self, cc: int, delta: int) -> None:
        if cc == F.ENC_SELECT_TURN:
            if self.shift and self.chords:
                cur = self.selected if self.selected is not None else 0
                self.selected = max(0, min(len(self.chords) - 1, cur + (1 if delta > 0 else -1)))
            else:
                self.cursor = max(0, min(7, self.cursor + (1 if delta > 0 else -1)))
        elif cc == F.ENC_VOLUME and self.selected is not None:
            c = self.chords[self.selected]
            c[1] = max(1, min(16, c[1] + (1 if delta > 0 else -1)))
        elif cc == F.ENC_RESONANCE:
            self.tempo = max(40, min(240, self.tempo + delta))
        self.dirty_oled = True

    def tick(self) -> None:
        if self.playing and self.total() > 0:
            beat = int((time.monotonic() - self.play_start) * self.tempo / 60) % self.total()
            self.playhead = beat
            visible = beat // ROW_BEATS
            if not self.scroll <= visible < self.scroll + TIMELINE_ROWS:
                self.scroll = visible

    def intro(self) -> None:
        """A short sweep so you can see the controller is alive."""
        for step in range(F.COLS + 8):
            pads = []
            for r in range(F.ROWS):
                for c in range(F.COLS):
                    d = step - c - r
                    pads.append((r * F.COLS + c, *(F.hue_rgb(DEGREE_HUES[c % 7 + 1], 0.8) if 0 <= d < 4 else (0, 0, 0))))
            self.f.pads(pads)
            time.sleep(0.03)
        self.f.oled(F.render_lines([("Croky Chords", 16), "Akai Fire demo", "tap a pad to start"]))
        time.sleep(0.8)


def monitor(f: F.Fire, seconds: float) -> None:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        for m in f.inp.iter_pending():
            print(describe(m), flush=True)
        time.sleep(0.002)


def describe(m) -> str:  # noqa: ANN001
    if m.type in ("note_on", "note_off"):
        p = F.pad_from_note(m.note)
        what = f"pad row {p[0] + 1} col {p[1] + 1} velocity {m.velocity}" if p else F.BUTTON_NAMES.get(m.note, hex(m.note))
        return f"{'down' if m.type == 'note_on' else 'up  '} {what}"
    if m.type == "control_change":
        return f"turn {F.ENCODER_NAMES.get(m.control, hex(m.control))} {F.relative(m.value):+d}"
    return str(m)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seconds", type=float, default=float("inf"), help="stop after this many seconds")
    ap.add_argument("--monitor", action="store_true", help="only print raw events")
    args = ap.parse_args()
    f = F.Fire()
    try:
        if args.monitor:
            f.oled(F.render_lines([("Croky Chords", 16), "monitor: printing", "events"]))
            monitor(f, args.seconds)
            return
        d = Demo(f)
        d.intro()
        d.render_leds()
        d.render()
        end = time.monotonic() + args.seconds
        while time.monotonic() < end:
            for m in f.inp.iter_pending():
                print(describe(m), flush=True)
                if m.type in ("note_on", "note_off"):
                    down = m.type == "note_on" and m.velocity > 0
                    p = F.pad_from_note(m.note)
                    if p:
                        d.on_pad(p[0], p[1], down)
                    else:
                        d.on_button(m.note, down)
                elif m.type == "control_change":
                    d.on_turn(m.control, F.relative(m.value))
            d.tick()
            d.render()
            time.sleep(0.005)
    except KeyboardInterrupt:
        pass
    finally:
        f.close(["Croky Chords", "see you!"])


if __name__ == "__main__":
    main()
