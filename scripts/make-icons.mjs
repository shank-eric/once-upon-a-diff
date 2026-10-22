/** Draws src/icons/icon{16,48,128}.png: a diff (green and red lines) with the story panel docked on the right. No dependencies. */
/* eslint-disable id-length -- pixel math: x, y, the r, g, b, a channels and the corners x0..y1 are the usual names */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/icons');

const CRC = new Int32Array(256).map((_, index) => {
  let crc = index;
  for (let k = 0; k < 8; k++) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc;
});
const crc32 = (buf) => {
  let crc = -1;
  for (const byte of buf) {
    crc = CRC[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// shapes in a 0..1 square: [x0, y0, x1, y1, radius, rgb]
const BLUE = [9, 105, 218],
  WHITE = [255, 255, 255],
  GREEN = [46, 160, 67],
  RED = [207, 34, 46],
  PALE = [214, 232, 255];
/** @type {Array<[number, number, number, number, number, number[]]>} [x0, y0, x1, y1, corner radius, rgb] */
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
/** @type {(x: number, y: number, shape: (typeof SHAPES)[number]) => boolean} */
const inside = (x, y, [x0, y0, x1, y1, r]) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) {
    return false;
  }
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

for (const size of [16, 48, 128]) {
  const buf = Buffer.alloc(size * size * 4);
  const samples = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size,
            y = (py + (sy + 0.5) / samples) / size;
          let col = null;
          for (const shape of SHAPES) {
            if (inside(x, y, shape)) {
              col = shape[5];
            }
          }
          if (col) {
            r += col[0];
            g += col[1];
            b += col[2];
            a++;
          }
        }
      }
      const i = (py * size + px) * 4;
      if (a) {
        buf[i] = r / a;
        buf[i + 1] = g / a;
        buf[i + 2] = b / a;
        buf[i + 3] = (255 * a) / (samples * samples);
      }
    }
  }
  writeFileSync(path.join(OUT, `icon${size}.png`), png(size, buf));
}
process.stderr.write(`Wrote icons to ${OUT}\n`);
