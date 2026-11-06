// Generates the toolbar/store icons (rounded square, loop ring, record dot) as PNGs
// without image dependencies. Run: npm run icons
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [79, 70, 229]; // indigo-600
const FG = [255, 255, 255];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Coverage of the shape at a point in unit coordinates: 0 none, 1 bg, 2 fg. */
function sample(x, y) {
  const r = 0.22; // corner radius
  const dx = Math.max(r - x, 0, x - (1 - r)), dy = Math.max(r - y, 0, y - (1 - r));
  if (dx * dx + dy * dy > r * r) return 0;
  const cx = x - 0.5, cy = y - 0.5, d = Math.hypot(cx, cy);
  const angle = Math.atan2(cy, cx);
  const ring = d > 0.27 && d < 0.35 && !(angle > -1.35 && angle < -0.75); // ring with a gap
  return ring || d < 0.13 ? 2 : 1;
}

/**
 * `pad` is transparent padding per side in pixels: the 128 px icon doubles as the Chrome Web Store
 * icon, whose artwork should be 96×96 with 16 px of transparent padding.
 */
function png(size, pad = 0) {
  const art = size - 2 * pad;
  const ss = 4, raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let a = 0, fg = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const u = (x - pad + (sx + 0.5) / ss) / art, v = (y - pad + (sy + 0.5) / ss) / art;
        const s = u < 0 || u > 1 || v < 0 || v > 1 ? 0 : sample(u, v);
        if (s) a++;
        if (s === 2) fg++;
      }
      const t = a ? fg / a : 0, o = y * (size * 4 + 1) + 1 + x * 4;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(BG[i] * (1 - t) + FG[i] * t);
      raw[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icons', { recursive: true });
for (const s of [16, 32, 48]) writeFileSync(`public/icons/icon${s}.png`, png(s));
writeFileSync('public/icons/icon128.png', png(128, 16));
console.log('icons written');
