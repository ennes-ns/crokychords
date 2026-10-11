"""Smooth silhouette + detailed interior: outline from a heavily blurred alpha mask, interior regions clipped into it."""
import sys, re, math
from PIL import Image, ImageFilter
import numpy as np
sys.path.insert(0, '.')
src_png, interior_svg, out, blur, ch, eps, grow = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), int(sys.argv[5]), float(sys.argv[6]), float(sys.argv[7])
im = Image.open(src_png).convert('RGBA')
W, H = im.size
vb = W / 64.0
a = Image.fromarray(np.array(im)[..., 3])
a = a.resize((W*2, H*2), Image.NEAREST).filter(ImageFilter.GaussianBlur(blur))
mask = np.array(a) > (128 - grow)
# contour utilities copied from trace.py
import importlib.util
spec = importlib.util.spec_from_file_location('tr', str(__import__('pathlib').Path(__file__).with_name('trace_lib.py'))); tr = importlib.util.module_from_spec(spec); spec.loader.exec_module(tr)
polys = tr.contours(mask)
d = []
for poly in polys:
    area = abs(sum(poly[i][0]*poly[(i+1)%len(poly)][1] - poly[(i+1)%len(poly)][0]*poly[i][1] for i in range(len(poly))))/2
    if area < 200: continue
    poly = tr.rdp(poly + [poly[0]], eps=eps)[:-1]
    pts = tr.chaikin(poly, ch)
    d.append('M' + ' '.join(f'{x/2/vb:.2f},{y/2/vb:.2f}' for x, y in pts) + 'Z')
sil = ' '.join(d)
inner = re.search(r'<svg[^>]*>(.*)</svg>', open(interior_svg).read(), re.S).group(1).strip()
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><clipPath id="sil"><path d="{sil}"/></clipPath></defs>
<path d="{sil}" fill="#0c0f08" fill-rule="evenodd"/>
<g clip-path="url(#sil)">{inner}</g>
</svg>'''
open(out, 'w').write(svg)
print('silhouette polys', len(d), 'size', len(svg))
