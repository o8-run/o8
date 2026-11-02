#!/usr/bin/env python3
"""Rebuild transparent o8 identity exports from traced, editable vector path data.

Usage: python brand/o8-mark/generate.py
Requires cairosvg for PNG generation; SVGs only require Python 3 stdlib.
"""
from __future__ import annotations
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parent
DATA=json.loads((ROOT/'o8-source.json').read_text())

def build_svg(paths, color, viewbox, title):
    d='\n'.join(f'  <path d="{p}"/>' for p in paths)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}" fill="{color}" fill-rule="evenodd" aria-label="{title}">\n'
            f'  <title>{title}</title>\n{d}\n</svg>\n')

(ROOT/'o8-mark.svg').write_text(build_svg(DATA['mark_paths'],'#000000','0 0 1000 1000','o8 striped circle mark'),encoding='utf8')
(ROOT/'o8-mark-white.svg').write_text(build_svg(DATA['mark_paths'],'#FFFFFF','0 0 1000 1000','o8 striped circle mark, white'),encoding='utf8')
(ROOT/'o8-lockup.svg').write_text(build_svg(DATA['mark_paths']+DATA['wordmark_paths'],'#000000','0 0 1000 1690','o8 striped circle lockup with outlined o8 wordmark'),encoding='utf8')
try:
    import cairosvg
except ImportError:
    print('SVG files written; install cairosvg to regenerate PNG')
else:
    cairosvg.svg2png(url=str(ROOT/'o8-mark.svg'),write_to=str(ROOT/'o8-mark-2048.png'),output_width=2048,output_height=2048)
    try:
        from PIL import Image
    except ImportError:
        pass
    else:
        png_path=ROOT/'o8-mark-2048.png'
        alpha=Image.open(png_path).getchannel('A')
        indexed=alpha.point(lambda x: min(255,round(x/8))).convert('P')
        indexed.putpalette([0,0,0]*256)
        indexed.info['transparency']=bytes([min(255,i*8) for i in range(256)])
        indexed.save(png_path,optimize=True,compress_level=9)
    print('SVGs and transparent 2048 PNG regenerated')
