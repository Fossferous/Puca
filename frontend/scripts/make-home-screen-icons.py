#!/usr/bin/env python3
"""Regenerate the home-screen icons in frontend/public/ from public/favicon.png.

    python frontend/scripts/make-home-screen-icons.py

WHY THESE ARE GENERATED, NOT HAND-EXPORTED. iPhone fills any transparency in an
apple-touch-icon with black and rounds the corners itself, so the transparent
512 px favicon came out as the mark floating on a black tile. These are OPAQUE
squares in the app's own dark background (the default theme's --bg-primary,
the same colour as theme_color in manifest.webmanifest) with the mark drawn
from the 512 px source, never upscaled from the 32 px favicon.

  apple-touch-icon.png   180x180  full-bleed square; iOS applies its own mask
  icon-192.png           192x192  purpose "any"
  icon-512.png           512x512  purpose "any"
  icon-maskable-512.png  512x512  purpose "maskable": the whole mark sits
                                  inside the central 80% circle (the W3C
                                  safe zone), so any launcher mask keeps all
                                  of it

src/tests/webAppManifest.test.ts decodes each file's PNG header and fails if a
size or the opacity drifts from what the manifest declares.
"""
import math
import os
import sys

from PIL import Image

BG = (0x18, 0x19, 0x1C, 255)  # --bg-primary in src/styles/theme.css (default theme)
HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, "..", "public")

src = Image.open(os.path.join(PUBLIC, "favicon.png")).convert("RGBA")
if src.size != (512, 512):
    sys.exit(f"favicon.png must be 512x512 to be the source, it is {src.size}")

# Crop to the mark's own box and find its farthest pixel from the box centre,
# so each icon can be scaled by a radius rather than by a guess.
box = src.getchannel("A").getbbox()
mark = src.crop(box)
cx, cy = (mark.width - 1) / 2, (mark.height - 1) / 2
alpha = mark.getchannel("A").load()
radius = 0.0
for y in range(mark.height):
    for x in range(mark.width):
        if alpha[x, y] > 8:
            radius = max(radius, math.hypot(x - cx, y - cy))


def render(size: int, reach: float) -> Image.Image:
    """The mark centred on an opaque square; its farthest pixel lands at
    `reach` x size from the centre."""
    scale = (reach * size) / radius
    w, h = max(1, round(mark.width * scale)), max(1, round(mark.height * scale))
    scaled = mark.resize((w, h), Image.LANCZOS)
    tile = Image.new("RGBA", (size, size), BG)
    tile.alpha_composite(scaled, ((size - w) // 2, (size - h) // 2))
    return tile.convert("RGB")  # no alpha channel at all: nothing to fill black


for name, size, reach in [
    ("apple-touch-icon.png", 180, 0.40),
    ("icon-192.png", 192, 0.40),
    ("icon-512.png", 512, 0.40),
    ("icon-maskable-512.png", 512, 0.36),  # < 0.40: inside the safe-zone circle
]:
    render(size, reach).save(os.path.join(PUBLIC, name), optimize=True)
    print(f"wrote public/{name} ({size}x{size})")
