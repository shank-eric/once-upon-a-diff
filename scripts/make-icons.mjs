#!/usr/bin/env node
/** Draws src/icons/icon{16,48,128}.png: a diff (green and red lines) with the story panel docked on the right. No dependencies. */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/icons');

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// shapes in a 0..1 square: [x0, y0, x1, y1, radius, rgb]
const BLUE = [9, 105, 218], WHITE = [255, 255, 255], GREEN = [46, 160, 67], RED = [207, 34, 46], PALE = [214, 232, 255];
const SHAPES = [
  [0, 0, 1, 1, 0.2, BLUE],
  [0.12, 0.2, 0.52, 0.3, 0.04, GREEN],
  [0.12, 0.38, 0.44, 0.48, 0.04, RED],
  [0.12, 0.56, 0.52, 0.66, 0.04, PALE],
  [0.12, 0.74, 0.38, 0.84, 0.04, GREEN],
  [0.6, 0.12, 0.9, 0.88, 0.06, WHITE],
  [0.66, 0.24, 0.84, 0.3, 0.02, BLUE],
  [0.66, 0.38, 0.84, 0.43, 0.02, PALE],
  [0.66, 0.49, 0.8, 0.54, 0.02, PALE],
  [0.66, 0.6, 0.84, 0.65, 0.02, PALE],
];
const inside = (x, y, [x0, y0, x1, y1, r]) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

for (const size of [16, 48, 128]) {
  const buf = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size, y = (py + (sy + 0.5) / ss) / size;
          let col = null;
          for (const s of SHAPES) if (inside(x, y, s)) col = s[5];
          if (col) { r += col[0]; g += col[1]; b += col[2]; a++; }
        }
      }
      const i = (py * size + px) * 4;
      if (a) { buf[i] = r / a; buf[i + 1] = g / a; buf[i + 2] = b / a; buf[i + 3] = (255 * a) / (ss * ss); }
    }
  }
  writeFileSync(path.join(OUT, `icon${size}.png`), png(size, buf));
}
process.stderr.write(`Wrote icons to ${OUT}\n`);
