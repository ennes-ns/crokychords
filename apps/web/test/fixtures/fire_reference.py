"""Regenerates fire-reference.json: byte fixtures from the Python reference in tools/fire/fire.py.

    uv run --no-project python apps/web/test/fixtures/fire_reference.py

apps/web/test/fire.protocol.test.ts checks the TypeScript encoders against these bytes.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "..", "tools", "fire"))
import fire as F  # noqa: E402

HUES = [0, 30, 52, 125, 190, 228, 280]
LIGHTS = [1.0, 0.9, 0.6, 0.55, 0.45, 0.3, 0.22, 0.15, 0.5]
SATS = [1.0, 0.6, 0.45, 0.3]


def pattern(x: int, y: int) -> bool:
    return (x * 7 + y * 3) % 5 == 0 or x == y or y == 63 - x // 2


out = {
    "padsSingle": F.pads_sysex([(0, 127, 0, 0)]),
    "padsMixed": F.pads_sysex([(5, 1, 2, 3), (63, 127, 64, 0), (17, 0, 0, 127)]),
    "padsAllOff": F.pads_sysex((i, 0, 0, 0) for i in range(64)),
    "hueRgb": [
        {"hue": h, "light": l, "sat": s, "rgb": list(F.hue_rgb(h, l, s))}
        for h in HUES
        for l in LIGHTS
        for s in SATS
    ],
    "oledBlank": F.oled_sysex(F.blank()),
    "oledPattern": F.oled_sysex([[pattern(x, y) for x in range(F.OLED_W)] for y in range(F.OLED_H)]),
    "relative": {str(v): F.relative(v) for v in (1, 2, 63, 64, 65, 126, 127)},
    "padNotes": {f"{r},{c}": F.pad_note(r, c) for r in range(F.ROWS) for c in (0, 7, 15)},
}
with open(os.path.join(HERE, "fire-reference.json"), "w") as f:
    json.dump(out, f, separators=(",", ":"))
    f.write("\n")
