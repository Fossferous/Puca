"""
Makes the files in this folder: small real pictures and videos that carry
metadata a phone, a camera or an editor would, with the made-up values of
../photoMetadata.ts (SECRETCAM-Corp, PhoneModelX-9000, SECRETXMP-creator-jane,
SECRETCOMMENT-hello, SECRETIPTC-caption, 2026:10:23 14:05:09, and a GPS fix at
47 deg 36' 22.3" N, 122 deg 19' 59.2" W, a public place). Nothing here is
anyone's data. Read by e2e/photo-metadata-real-browser.mjs (the real decoders,
before and after) and src/tests/fileMetadata.test.ts.

Run from frontend/ with Python 3, Pillow (with AVIF) and ffmpeg (libx264,
libvpx-vp9) on PATH; the outputs are committed, so this only reruns on purpose:

    python src/tests/fixtures/metadata/make-fixtures.py

FFmpeg's own version string (an "encoder" tag) also lands in the videos: it is
metadata too, and the tests count it as such.
"""
import io
import os
import struct
import subprocess
import sys

from PIL import Image, TiffImagePlugin

HERE = os.path.dirname(os.path.abspath(__file__))
MAKE, MODEL = 'SECRETCAM-Corp', 'PhoneModelX-9000'
DATE = '2026:10:23 14:05:09'
XMP = ('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
       '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>SECRETXMP-creator-jane</dc:creator>'
       '</rdf:Description></rdf:RDF></x:xmpmeta>')
COMMENT = 'SECRETCOMMENT-hello'
ISO6709 = '+47.6062-122.3321/'


def picture(w=64, h=48, shift=0):
    im = Image.new('RGB', (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = ((x * 4 + shift) & 255, (y * 5) & 255, ((x * y) >> 2) & 255)
    return im


def exif():
    e = Image.Exif()
    e[0x010F] = MAKE
    e[0x0110] = MODEL
    e[0x0132] = DATE
    e[0x0131] = 'SECRETCAM-Firmware'
    gps = e.get_ifd(0x8825)
    gps[1] = 'N'
    gps[2] = (47.0, 36.0, 22.3)
    gps[3] = 'W'
    gps[4] = (122.0, 19.0, 59.2)
    return e


def out(name):
    return os.path.join(HERE, name)


def rel(name):
    return name


# ---- GIF: two frames, looping, with a comment; then an XMP application
# extension and a plain text extension put in by hand (Pillow writes neither).
frames = [picture(16, 12, 0).quantize(16), picture(16, 12, 90).quantize(16)]
buf = io.BytesIO()
frames[0].save(buf, 'GIF', save_all=True, append_images=frames[1:], duration=[120, 80], loop=0, comment=COMMENT.encode())
gif = bytearray(buf.getvalue())
# After the logical screen and global colour table.
packed = gif[10]
at = 13 + (3 * (1 << ((packed & 7) + 1)) if packed & 0x80 else 0)
xmp = XMP.encode()
magic = bytes([1]) + bytes(range(255, -1, -1)) + b'\x00'  # XMP's "magic trailer", 258 bytes
app = b'\x21\xFF\x0BXMP DataXMP' + xmp + magic
text = b'\x21\x01\x0C' + bytes(12) + bytes([len(COMMENT)]) + COMMENT.encode() + b'\x00'
gif[at:at] = app + text
open(out('animated.gif'), 'wb').write(gif)

# ---- TIFF: uncompressed, with the text tags, XMP, and EXIF + GPS directories.
im = picture()
info = TiffImagePlugin.ImageFileDirectory_v2()
info[270] = 'SECRETCOMMENT-hello description'
info[271] = MAKE
info[272] = MODEL
info[305] = 'SECRETCAM-Software'
info[306] = DATE
info[315] = 'SECRETXMP-creator-jane'
info[700] = xmp
info.tagtype[700] = 7
im.save(out('photo.tif'), 'TIFF', tiffinfo=info, exif=exif(), compression='raw')

# ---- AVIF: Exif (camera, time, GPS) and XMP items beside the picture.
picture().save(out('photo.avif'), 'AVIF', exif=exif().tobytes(), xmp=xmp, quality=90)


def ff(*args):
    # In this folder, with names relative to it: no path of the machine that made them gets in.
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *args], check=True, cwd=HERE)


src = ['-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=10', '-t', '0.5', '-pix_fmt', 'yuv420p']
tags = ['-metadata', f'title={COMMENT}', '-metadata', f'location={ISO6709}', '-metadata', f'make={MAKE}',
        '-metadata', f'model={MODEL}', '-metadata', 'creation_time=2026-10-23T14:05:09Z', '-metadata', 'comment=SECRETIPTC-caption']
# Android-style: udta with ©xyz and the rest.
ff(*src, '-c:v', 'libx264', '-preset', 'ultrafast', *tags, rel('video.mp4'))
# iPhone-style: moov/meta with mdta keys (and udta).
ff(*src, '-c:v', 'libx264', '-preset', 'ultrafast', *tags, '-metadata', f'com.apple.quicktime.location.ISO6709={ISO6709}',
   '-metadata', f'com.apple.quicktime.make={MAKE}', '-movflags', '+use_metadata_tags', '-f', 'mov', rel('video.mov'))
# WebM: Tags, the segment's Title and DateUTC, a track Name.
ff(*src, '-c:v', 'libvpx-vp9', '-b:v', '100k', '-deadline', 'realtime', *tags, '-metadata:s:v:0', f'title={MODEL}', rel('video.webm'))
# MKV: the same, a CRC-32 in each element, and an attached file.
open(out('note.txt'), 'w').write('SECRETXMP-creator-jane attached this note')
ff(*src, '-c:v', 'libx264', '-preset', 'ultrafast', *tags, '-metadata:s:v:0', f'title={MODEL}', '-attach', 'note.txt',
   '-metadata:s:t', 'mimetype=text/plain', rel('video.mkv'))
os.remove(out('note.txt'))
print('made', sorted(f for f in os.listdir(HERE) if not f.endswith('.py')))
