import zlib, struct

def png_chunk(tag, data):
    c = struct.pack('>I', len(data)) + tag + data
    crc = zlib.crc32(tag + data) % (1 << 32)
    c += struct.pack('>I', crc)
    return c

S = 1024
rows = []
for y in range(S):
    row = b'\x00'
    for x in range(S):
        r = 180
        dx = min(x, S - 1 - x); dy = min(y, S - 1 - y)
        inside = (dx >= r or dy >= r) or ((r - dx) ** 2 + (r - dy) ** 2 <= r * r)
        if not inside:
            row += b'\x00\x00\x00\x00'
        else:
            g = 0x84 - int(y / S * 20)
            row += bytes([0x0A, g, 0xFF, 255])
    rows.append(row)
raw = b''.join(rows)
png = (b'\x89PNG\r\n\x1a\n'
       + png_chunk(b'IHDR', struct.pack('>IIBBBBB', S, S, 8, 6, 0, 0, 0))
       + png_chunk(b'IDAT', zlib.compress(raw, 9))
       + png_chunk(b'IEND', b''))
open('icons/icon-source.png', 'wb').write(png)
print("icon-source.png written", len(png), "bytes")
