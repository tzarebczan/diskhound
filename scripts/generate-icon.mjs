/**
 * Generate DiskHound app icon as a 256x256 PNG using only Node.js built-ins.
 * No external dependencies needed.
 *
 * Run: node scripts/generate-icon.mjs
 * Output: build/icon.png
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const size = 512;
const pixels = Buffer.alloc(size * size * 4);

function setPixel(x, y, r, g, b, a = 255) {
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  const i = (y * size + x) * 4;
  pixels[i] = r;
  pixels[i + 1] = g;
  pixels[i + 2] = b;
  pixels[i + 3] = a;
}

function fillRect(x0, y0, w, h, r, g, b) {
  for (let y = Math.max(0, y0); y < Math.min(size, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(size, x0 + w); x++) {
      setPixel(x, y, r, g, b);
    }
  }
}

function fillRoundedRect(x0, y0, w, h, radius, r, g, b) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      // Check corners
      const dx = x < x0 + radius ? x - (x0 + radius) : x > x0 + w - radius - 1 ? x - (x0 + w - radius - 1) : 0;
      const dy = y < y0 + radius ? y - (y0 + radius) : y > y0 + h - radius - 1 ? y - (y0 + h - radius - 1) : 0;
      if (dx * dx + dy * dy <= radius * radius) {
        setPixel(x, y, r, g, b);
      } else if (dx === 0 || dy === 0) {
        setPixel(x, y, r, g, b);
      }
    }
  }
}

// Background: dark rounded square
fillRoundedRect(0, 0, size, size, 40, 14, 14, 20);

const pad = 22;
const area = size - pad * 2;
const gap = 3;

// Treemap blocks — the visual identity of DiskHound
const blocks = [
  // Large block top-left (the "big file" — amber, dominant)
  { x: 0, y: 0, w: 0.55, h: 0.6, r: 245, g: 158, b: 11 },
  // Medium block top-right
  { x: 0.56, y: 0, w: 0.44, h: 0.35, r: 217, g: 119, b: 6 },
  // Small blocks
  { x: 0.56, y: 0.36, w: 0.22, h: 0.24, r: 180, g: 83, b: 9 },
  { x: 0.79, y: 0.36, w: 0.21, h: 0.24, r: 146, g: 64, b: 14 },
  // Bottom row
  { x: 0, y: 0.61, w: 0.35, h: 0.39, r: 234, g: 88, b: 12 },
  { x: 0.36, y: 0.61, w: 0.3, h: 0.39, r: 194, g: 65, b: 12 },
  { x: 0.67, y: 0.61, w: 0.33, h: 0.19, r: 124, g: 58, b: 237 },
  { x: 0.67, y: 0.81, w: 0.33, h: 0.19, r: 13, g: 148, b: 136 },
];

for (const b of blocks) {
  const bx = Math.round(pad + b.x * area);
  const by = Math.round(pad + b.y * area);
  const bw = Math.round(b.w * area) - gap;
  const bh = Math.round(b.h * area) - gap;
  fillRoundedRect(bx, by, bw, bh, 4, b.r, b.g, b.b);

  // Subtle top highlight
  for (let x = bx + 4; x < bx + bw - 4; x++) {
    const i = (by * size + x) * 4;
    if (i >= 0 && i < pixels.length - 3) {
      pixels[i] = Math.min(255, pixels[i] + 20);
      pixels[i + 1] = Math.min(255, pixels[i + 1] + 20);
      pixels[i + 2] = Math.min(255, pixels[i + 2] + 20);
    }
  }
}

// Write PNG
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

// Filter byte (0) prepended to each row
const rawData = Buffer.alloc(size * (1 + size * 4));
for (let y = 0; y < size; y++) {
  rawData[y * (1 + size * 4)] = 0;
  pixels.copy(rawData, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
}
const compressed = deflateSync(rawData);

// CRC32
const crc32Table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crc32Table[i] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crc32Table[(c ^ buf[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
  return Buffer.concat([len, typeB, data, crcBuf]);
}

const png = Buffer.concat([
  signature,
  makeChunk("IHDR", ihdr),
  makeChunk("IDAT", compressed),
  makeChunk("IEND", Buffer.alloc(0)),
]);

mkdirSync("build", { recursive: true });
writeFileSync("build/icon.png", png);
console.log(`Generated build/icon.png (${size}x${size}, ${png.length} bytes)`);
