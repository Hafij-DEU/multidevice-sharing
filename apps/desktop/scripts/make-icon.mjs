// Renders the MeshDrop icon (three linked nodes on a blue rounded square) to PNG, no dependencies.
// Usage: node scripts/make-icon.mjs <size> <out.png>
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const size = Number(process.argv[2] ?? 512);
const out = process.argv[3] ?? 'build/icon.png';
const SS = 4; // supersampling per axis

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

// Shapes in unit coordinates (0..1).
const nodes = [[0.5, 0.27], [0.27, 0.68], [0.73, 0.68]];
const R = 0.095;
const LINE = 0.035;
const inRoundRect = (x, y) => {
  const r = 0.22, m = 0.04;
  const cx = Math.min(Math.max(x, m + r), 1 - m - r);
  const cy = Math.min(Math.max(y, m + r), 1 - m - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= m && x <= 1 - m && y >= m && y <= 1 - m;
};
const segDist = (px, py, [ax, ay], [bx, by]) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
function sample(x, y) {
  if (!inRoundRect(x, y)) return [0, 0, 0, 0];
  const white = nodes.some(([nx, ny]) => Math.hypot(x - nx, y - ny) <= R) ||
    [[0, 1], [1, 2], [2, 0]].some(([a, b]) => segDist(x, y, nodes[a], nodes[b]) <= LINE / 2);
  if (white) return [255, 255, 255, 255];
  const t = (x + y) / 2; // diagonal gradient
  return [Math.round(37 + 22 * t), Math.round(99 + 31 * t), Math.round(235 - 10 * t), 255];
}

const raw = Buffer.alloc((size * 4 + 1) * size);
for (let py = 0; py < size; py++) {
  raw[py * (size * 4 + 1)] = 0;
  for (let px = 0; px < size; px++) {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const s = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
      acc[0] += s[0] * s[3]; acc[1] += s[1] * s[3]; acc[2] += s[2] * s[3]; acc[3] += s[3];
    }
    const o = py * (size * 4 + 1) + 1 + px * 4;
    const a = acc[3];
    raw[o] = a ? Math.round(acc[0] / a) : 0;
    raw[o + 1] = a ? Math.round(acc[1] / a) : 0;
    raw[o + 2] = a ? Math.round(acc[2] / a) : 0;
    raw[o + 3] = Math.round(a / (SS * SS));
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
console.log(`wrote ${out} (${size}x${size})`);
