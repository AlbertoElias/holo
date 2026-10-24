# Reads a blend-probe screenshot. Boxes are x0,y0,x1,y1 in image pixels:
#   python3 -I blendread.py shot.png wall=... p25=... p50=... p75=...
# For each patch it compares the measured value (luma of the median pixel, 0-255) with the two predictions
# from the wall beside it: sRGB blending gives wall*(1-a); linear-light blending gives enc((1-a)*lin(wall)).
import sys
from PIL import Image

def lin(v): v /= 255; return v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4
def enc(l): v = 12.92 * l if l <= .0031308 else 1.055 * l ** (1 / 2.4) - .055; return 255 * v

img = Image.open(sys.argv[1]).convert('RGB')
boxes = dict(a.split('=') for a in sys.argv[2:])
def median(box):
    x0, y0, x1, y1 = map(int, box.split(','))
    px = sorted(sum(c) / 3 for c in img.crop((x0, y0, x1, y1)).getdata())
    return px[len(px) // 2]
wall = median(boxes['wall'])
print(f'wall {wall:.0f}')
votes = []
for k, a in (('p25', .25), ('p50', .5), ('p75', .75)):
    if k not in boxes: continue
    m = median(boxes[k]); s = wall * (1 - a); l = enc((1 - a) * lin(wall))
    v = 'sRGB' if abs(m - s) < abs(m - l) else 'linear'; votes.append(v)
    print(f'{k}: measured {m:.0f}, sRGB predicts {s:.0f}, linear predicts {l:.0f} -> {v}')
print('verdict:', max(set(votes), key=votes.count) if votes else 'none')
