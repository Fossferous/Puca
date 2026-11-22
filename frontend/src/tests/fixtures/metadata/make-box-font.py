"""
Makes box-font.ttf in this folder: a tiny TrueType font, made here from
nothing, whose few letters are solid shapes (A a square, B a triangle, C a
bar, space blank), so a drawing that uses it looks plainly different when the
font does not load. Read by src/tests/svgMetadata.test.ts and
e2e/photo-metadata-real-browser.mjs, which embed it in an SVG as a data: URL
the way Excalidraw embeds its fonts, and check it survives the cleaning.

Its names say only what it is. Run from frontend/ with Python 3 and fontTools;
the output is committed, so this only reruns on purpose:

    python src/tests/fixtures/metadata/make-box-font.py
"""
import os

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

HERE = os.path.dirname(os.path.abspath(__file__))
UPM = 1000


def shape(points):
    pen = TTGlyphPen(None)
    if points:
        pen.moveTo(points[0])
        for p in points[1:]:
            pen.lineTo(p)
        pen.closePath()
    return pen.glyph()


def main():
    order = ['.notdef', 'space', 'A', 'B', 'C']
    glyphs = {
        '.notdef': shape([]),
        'space': shape([]),
        'A': shape([(50, 0), (50, 700), (750, 700), (750, 0)]),
        'B': shape([(50, 0), (400, 700), (750, 0)]),
        'C': shape([(50, 300), (50, 400), (750, 400), (750, 300)]),
    }
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0x20: 'space', 0x41: 'A', 0x42: 'B', 0x43: 'C'})
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({g: (800, 50) for g in order})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({'familyName': 'Box', 'styleName': 'Regular'})
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    fb.setupPost()
    # A fixed creation time, so a rerun makes the same bytes.
    fb.font['head'].created = fb.font['head'].modified = 0
    fb.font.recalcTimestamp = False
    out = os.path.join(HERE, 'box-font.ttf')
    fb.save(out)
    print(os.path.basename(out), os.path.getsize(out), 'bytes')


if __name__ == '__main__':
    main()
