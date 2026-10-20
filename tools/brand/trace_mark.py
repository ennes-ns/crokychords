"""Flat-shape vector Croky, traced from the letter-grid pixel master (master/croky-64.txt + palette.json
in the croky asset repository). Each colour layer is upscaled, blurred, thresholded and traced with
potrace; the eye and the hooked beak are drawn as geometry over the master pixels.
usage: trace_mark.py GRID PALETTE_JSON OUT_FRAGMENT [only,layers] [OUTLINE_COLOUR]  (output in 64x64 units)"""
import sys, json, subprocess, tempfile, os, re
import numpy as np
from PIL import Image, ImageFilter

grid = [l.rstrip("\n") for l in open(sys.argv[1]) if l.strip()]
pal = json.load(open(sys.argv[2]))
H, W = len(grid), max(len(l) for l in grid)
A = np.array([list(l.ljust(W, ".")) for l in grid])
PAD = 4
A = np.pad(A, PAD, constant_values=".")
H, W = H + 2 * PAD, W + 2 * PAD
UP = 24

YY, XX = np.mgrid[0:H, 0:W] - PAD
def mask(letters, where=None):
    m = np.isin(A, list(letters))
    if where is not None:
        m &= where
    return m

def trace(m, blur, thr):
    img = Image.fromarray((m * 255).astype(np.uint8)).resize((W * UP, H * UP), Image.NEAREST)
    img = img.filter(ImageFilter.GaussianBlur(blur * UP))
    b = (np.array(img) >= thr * 255)
    with tempfile.TemporaryDirectory() as td:
        p = os.path.join(td, "m.pbm")
        Image.fromarray(((~b) * 255).astype(np.uint8)).convert("1").save(p)
        svg = subprocess.run(["potrace", "-s", "-a", "1.25", "-O", "0.6", "-t", "40", "-u", "10", "-o", "-", p],
                             capture_output=True, text=True, check=True).stdout
    ds = re.findall(r'<path d="([^"]+)"', svg, re.S)
    return " ".join(" ".join(d.split()) for d in ds)

# potrace with -u 10: coords are 10x pixels, y flipped: transform translate(0,H*UP) scale(.1,-.1)
s = 1 / UP
T = f'transform="matrix({0.1*s:.6f} 0 0 {-0.1*s:.6f} {-PAD} {H - PAD})"'
inner = "GgLCcYORrBbWPSsF"
OB, OT = 0.8, 0.5
OUTLINE = sys.argv[5] if len(sys.argv) > 5 else pal["outline"]
OW = 1.6  # outline stroke width in pixel units (on top of the 1-px K edge)
layers = [
    # (name, letters, colour, blur, threshold)
    ("outline", "K" + inner, OUTLINE, OB, OT, None),
    ("body", "GgLCcYORrBb", pal["green"], 1.0, 0.5, None),
    ("yellow", "YORrCc", pal["yellow"], 0.8, 0.5, None),
    ("orange", "ORr", pal["orange"], 0.9, 0.56, None),
    ("red", "Rr", pal["red"], 0.8, 0.5, None),
    ("cream", "Cc", pal["cream"], 1.0, 0.5, None),
    ("cap", "Bb", pal["cap"], 0.7, 0.5, None),
    ("cere", "W", pal["eye_white"], 0.5, 0.5, XX >= 54),
    ("feet", "F", pal["feet"], 0.45, 0.5, None),
]
only = set(sys.argv[4].split(",")) if len(sys.argv) > 4 and sys.argv[4] else None
out = ['<g id="croky">']
for name, letters, col, blur, thr, where in layers:
    if only and name not in only:
        continue
    d = trace(mask(letters, where), blur, thr)
    stroke = f' stroke="{OUTLINE}" stroke-width="{OW * UP * 10:.0f}" stroke-linejoin="round"' if name == "outline" else ""
    out.append(f'  <path id="{name}" fill="{col}" fill-rule="evenodd"{stroke} {T} d="{d}"/>')
# hooked upper beak, drawn over the master's S/s pixels (cols 53-62, rows 15-26)
beak = "M53.6 17.4 C56.2 15.9 60.4 15.8 62.2 17.6 C63.6 19.6 62.9 23.6 59.9 26.6 C59.5 24.6 58.3 23.0 56.0 22.3 C54.4 21.8 53.4 20.2 53.6 17.4 Z"
out.append(f'  <path id="beak" fill="{pal["beak"]}" d="{beak}"/>')
out.append(f'  <path id="beak-under" fill="{pal["beak_dark"]}" d="M53.9 19.6 C54.6 21.4 56.4 22.4 58.0 23.3 C59.0 24.0 59.6 25.2 59.9 26.6 C59.3 25.6 58.2 24.9 56.6 24.4 C55.0 23.8 54.0 22.2 53.9 19.6 Z"/>')
ex, ey = 49.5, 12.9
out.append(f'  <circle id="eye-ring" cx="{ex}" cy="{ey}" r="5.4" fill="{OUTLINE}"/>')
out.append(f'  <circle id="eye" cx="{ex}" cy="{ey}" r="4.3" fill="{pal["eye_white"]}"/>')
out.append(f'  <circle id="pupil" cx="{ex}" cy="{ey-0.3}" r="2.5" fill="{pal["pupil"]}"/>')
out.append(f'  <circle id="glint" cx="{ex+0.9}" cy="{ey-1.2}" r="0.75" fill="{pal["eye_white"]}"/>')
out.append("</g>")
open(sys.argv[3], "w").write("\n".join(out) + "\n")
