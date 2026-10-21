"""Render the application's code-native W mark into desktop icon assets."""
import math
import struct
import zlib
from pathlib import Path

root = Path(__file__).resolve().parents[1]
assets = root / 'desktop' / 'assets'
assets.mkdir(exist_ok=True)


def png(size):
    def chunk(kind, payload):
        return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload) & 0xffffffff)
    data = bytearray()
    segments = [((190, 300), (285, 700)), ((285, 700), (390, 360)), ((390, 360), (495, 700)), ((495, 700), (590, 300)), ((660, 700), (820, 700))]
    def distance(x, y, a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        t = max(0, min(1, ((x-a[0])*dx + (y-a[1])*dy) / (dx*dx + dy*dy)))
        return math.hypot(x-a[0]-t*dx, y-a[1]-t*dy)
    for row in range(size):
        data.append(0)
        for column in range(size):
            x, y = (column+.5)*1024/size, (row+.5)*1024/size
            cx, cy = max(200, min(824, x)), max(200, min(824, y))
            visible = math.hypot(x-cx, y-cy) <= 190
            ink = any(distance(x,y,a,b) < 39 for a,b in segments) if visible else False
            data.extend((27, 42, 22, 255) if ink else (196, 238, 145, 255) if visible else (0,0,0,0))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR',struct.pack('>IIBBBBB', size,size,8,6,0,0,0)) + chunk(b'IDAT',zlib.compress(data,9)) + chunk(b'IEND',b'')

small = png(256)
large = png(1024)
(assets / 'icon.png').write_bytes(large)
(assets / 'icon.ico').write_bytes(struct.pack('<HHH',0,1,1) + struct.pack('<BBBBHHII',0,0,0,0,1,32,len(small),22) + small)
# Modern ICNS stores PNG chunks, so generation is portable and requires no
# platform image service or external rasterization dependency.
chunks = []
for kind, image in [(b'ic07', png(128)), (b'ic08', small), (b'ic09', png(512)), (b'ic10', large)]:
    chunks.append(kind + struct.pack('>I', len(image)+8) + image)
content = b''.join(chunks)
(assets / 'icon.icns').write_bytes(b'icns' + struct.pack('>I', len(content)+8) + content)
