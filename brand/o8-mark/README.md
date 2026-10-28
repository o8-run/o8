# o8 striped-circle mark

These files are a flat, editable **vector reconstruction** of the striped-circle "o8" emblem in the reference image supplied on October 28, 2026 (`IMG_8924.jpeg`). The supplied image was a rendered metallic silver app-icon presentation on a dark textured background, **not** an original editable vector design. Its background, square app tile, grid, metallic shading, and bevel effects are intentionally excluded. Shapes were extracted and simplified into seven independent, closed vector contours, preserving the negative-space circular cutouts and the curved band geometry. They are visually faithful approximations, not the lost original source curves.

## Palette

- `o8-mark.svg`, `o8-lockup.svg`: `#000000` black fill; **transparent** background.
- `o8-mark-white.svg`: `#FFFFFF` white fill; **transparent** background.
- `o8-mark-2048.png`: RGBA black mark on transparent, **2048 × 2048** pixels.

## Wordmark and font

`o8-lockup.svg` contains the wordmark as **outlined paths**, traced directly from the supplied image. There are **no fonts or text nodes in the SVG**. The name of the actual font used to produce the reference image is **unknown**; these outlines are a custom tracing of the letterforms and are not attributed to a named commercial font. The lockup preserves the generous vertical spacing of the reference composition.

## Sources and regeneration

- `o8-source.json` is the editable geometry source: seven emblem paths plus five letter contour paths (outer o, its counter, outer 8, and two counters), and the reference image SHA-256. This is an independently created working file, not an export from the original generation session.
- `generate.py` reproduces the three SVGs using only Python's standard library, and the 2048px PNG when `cairosvg` is available (with optional `Pillow` palette optimization).
- Run `python3 brand/o8-mark/generate.py` from the repository root. ImageMagick, Figma, and Illustrator are not required.
- The reference JPEG is not committed: it includes composited UI, which is not part of the standalone brand assets.

The trademark and brand usage context remain with o8. These are source-of-truth files for the **reconstructed** mark only; use them as a starting point for further refinement, and retain this provenance when passing the work to other agents.