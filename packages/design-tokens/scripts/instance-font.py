"""Pin a variable WOFF2 to fixed axis values and write a static TTF.

Usage: instance-font.py <in.woff2> <out.ttf> <axis=value>...
Prints the font's Unicode code points as a JSON array on stdout.
Needs fontTools and brotli (pip install fonttools brotli); used by bake-msdf.ts.
"""

import json
import sys

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

src, dst, *pins = sys.argv[1:]
location = {axis: float(value) for axis, value in (pin.split("=") for pin in pins)}

font = TTFont(src)
static = instancer.instantiateVariableFont(font, location, inplace=False)
static.flavor = None
static.save(dst)

print(json.dumps(sorted(static.getBestCmap().keys())))
