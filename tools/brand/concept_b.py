"""concept_b.py GRID PALETTE_JSON OUT_SVG  -- pixel Croky on a perch of chord blocks, bitmap wordmark.
Everything sits on one grid of U=5 px cells (320 x 88 cells)."""
import os, sys, colorsys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # `python3 -I` drops the script dir
from croky_pixels import LEG, load_palette, runs

grid_path, pal_path, out = sys.argv[1:4]
U = 5
GW, GH = 320, 88
pal = load_palette(pal_path)


def hsl(h, s, l):
    r, g, b = colorsys.hls_to_rgb(h / 360, l / 100, s / 100)
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))

# ---- bitmap wordmark: cap height 15, x-height 11, descender 4, stroke 3 -------------------------
G = {
"C": """
.##########
###########
###########
###........
###........
###........
###........
###........
###........
###........
###........
###........
###########
###########
.##########""",
"h": """
###........
###........
###........
###........
###.######.
###########
###########
###.....###
###.....###
###.....###
###.....###
###.....###
###.....###
###.....###
###.....###""",
"o": """
.#########.
###########
###########
###.....###
###.....###
###.....###
###.....###
###.....###
###########
###########
.#########.""",
"r": """
###.#####
#########
#########
###......
###......
###......
###......
###......
###......
###......
###......""",
"k": """
###.......
###.......
###.......
###.......
###....###
###...###.
###..###..
###.###...
######....
#######...
###.###...
###..###..
###...###.
###....###
###....###""",
"y": """
###.....###
###.....###
###.....###
###.....###
###.....###
###.....###
###.....###
###.....###
###########
###########
.##########
........###
###########
##########.
.########..""",
"d": """
........###
........###
........###
........###
.##########
###########
###########
###.....###
###.....###
###.....###
###.....###
###.....###
###########
###########
.##########""",
"s": """
.#########
##########
##########
###.......
#########.
##########
.#########
.......###
##########
##########
#########.""",
}
CAP, XH = 15, 11
def glyph(ch):
    rows = [r for r in G[ch].strip("\n").split("\n")]
    w = max(len(r) for r in rows)
    rows = [r.ljust(w, ".") for r in rows]
    # top of glyph relative to baseline (baseline = row after last body row)
    top = -CAP if ch in "Chkd" else -XH
    return rows, w, top

def word(text, x, base, track=2, space=6):
    cells = []
    for ch in text:
        if ch == " ":
            x += space - track
            continue
        rows, w, top = glyph(ch)
        for yy, r in enumerate(rows):
            for xx, c in enumerate(r):
                if c == "#":
                    cells.append((x + xx, base + top + yy))
        x += w + track
    return cells, x - track

def cells_to_d(cells):
    s = set(cells)
    d = []
    for (x, y) in sorted(s, key=lambda p: (p[1], p[0])):
        if (x - 1, y) in s:
            continue
        x2 = x
        while (x2 + 1, y) in s:
            x2 += 1
        d.append(f"M{x} {y}h{x2 - x + 1}v1h{-(x2 - x + 1)}z")
    return "".join(d)

# ---- small numerals (5 rows, stroke 1) ------------------------------------------------------
N = {"I": ["#", "#", "#", "#", "#"],
     "V": ["#...#", "#...#", ".#.#.", ".#.#.", "..#.."],
     "v": ["...", "...", "#.#", "#.#", ".#."],
     "i": ["#", ".", "#", "#", "#"]}
def numeral(text, x, y):
    cells = []
    for ch in text:
        rows = N[ch]
        for yy, r in enumerate(rows):
            for xx, c in enumerate(r):
                if c == "#":
                    cells.append((x + xx, y + yy))
        x += len(rows[0]) + 1
    return cells

# ---- layout -------------------------------------------------------------------------------
PERCH_TOP, PERCH_H = 64, 12
BX, BW, GAP = 17, 70, 2
blocks = [("I", 0, "C"), ("V", 190, "G"), ("vi", 228, "Am"), ("IV", 125, "F")]
grid = [l.rstrip("\n") for l in open(grid_path) if l.strip()]
BIRD_X, BIRD_Y = BX + 2, PERCH_TOP - 53        # claws (row 52) touch the perch; tail outline overlaps its top edge

parts = []
for i, (num, hue, _name) in enumerate(blocks):
    x = BX + i * (BW + GAP)
    fill, edge, ink = hsl(hue, 45, 26), hsl(hue, 45, 38), hsl(hue, 30, 85)
    # block with a 1-cell border and notched (pixel-rounded) corners
    y0, y1, x1 = PERCH_TOP, PERCH_TOP + PERCH_H, x + BW
    parts.append(f'<path fill="{edge}" d="M{x + 1} {y0}h{BW - 2}v1h1v{PERCH_H - 2}h-1v1h{-(BW - 2)}v-1h-1v{-(PERCH_H - 2)}h1z"/>')
    parts.append(f'<rect x="{x + 1}" y="{y0 + 1}" width="{BW - 2}" height="{PERCH_H - 2}" fill="{fill}"/>')
    parts.append(f'<path fill="{ink}" d="{cells_to_d(numeral(num, x + 3, y0 + 3))}"/>')

bird = runs(grid, BIRD_X, BIRD_Y, lambda c: pal[LEG[c]] if c in LEG else None)
for col, ds in bird.items():
    parts.append(f'<path fill="{col}" d="{"".join(ds)}"/>')

# wordmark: left edge on block V's numeral column, cap height centred on the bird
WX = BX + (BW + GAP) + 3
BASE = 45
c1, end1 = word("Croky", WX, BASE)
c2, end2 = word("Chords", end1 + 7, BASE)
parts.append(f'<path fill="#f2e5bc" d="{cells_to_d(c1 + c2)}"/>')

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {GW * U} {GH * U}" width="{GW * U}" height="{GH * U}" role="img" aria-label="Croky Chords" shape-rendering="crispEdges">
  <!-- Concept B: pixel Croky on a perch of chord blocks (I V vi IV), bitmap wordmark.
       One grid of 5 px cells. Generated by tools/brand/concept_b.py; see docs/BRAND.md, "README banner". -->
  <rect width="{GW * U}" height="{GH * U}" fill="#121212"/>
  <g transform="scale({U})">
    {chr(10).join("    " + p for p in parts).lstrip()}
  </g>
</svg>
'''
open(out, "w").write(svg)
print("wordmark ends at cell", end2)
