/**
 * Generate DiskHound app icon as a 512x512 PNG using only Node.js built-ins.
 * Run: node scripts/generate-icon.mjs
 * Output: build/icon.png
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const size = 512;
const pixels = Buffer.alloc(size * size * 4);

function blendPixel(x, y, r, g, b, a) {
  if (x < 0 || x >= size || y < 0 || y >= size || a <= 0) return;
  const i = (y * size + x) * 4;
  if (a >= 255) {
    pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = 255;
    return;
  }
  // Alpha blend over existing pixel
  const af = a / 255;
  const inv = 1 - af;
  pixels[i]     = Math.round(r * af + pixels[i]     * inv);
  pixels[i + 1] = Math.round(g * af + pixels[i + 1] * inv);
  pixels[i + 2] = Math.round(b * af + pixels[i + 2] * inv);
  pixels[i + 3] = Math.min(255, Math.round(a + pixels[i + 3] * inv));
}

function fillRoundedRect(x0, y0, w, h, radius, r, g, b) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || x >= size || y < 0 || y >= size) continue;

      // Signed distance from the rounded rect edge (negative = inside)
      const dx = x < x0 + radius ? x - (x0 + radius)
               : x > x0 + w - radius - 1 ? x - (x0 + w - radius - 1)
               : 0;
      const dy = y < y0 + radius ? y - (y0 + radius)
               : y > y0 + h - radius - 1 ? y - (y0 + h - radius - 1)
               : 0;

      if (dx === 0 || dy === 0) {
        // Not in a corner region — fully inside
        blendPixel(x, y, r, g, b, 255);
      } else {
        // Corner — use distance for anti-aliasing
        const dist = Math.sqrt(dx * dx + dy * dy) - radius;
        if (dist < -1) {
          blendPixel(x, y, r, g, b, 255); // fully inside
        } else if (dist < 1) {
          // Edge pixel — blend based on coverage (smooth AA)
          const alpha = Math.round(255 * Math.max(0, Math.min(1, 0.5 - dist * 0.5)));
          blendPixel(x, y, r, g, b, alpha);
        }
        // dist >= 1: fully outside, skip
      }
    }
  }
}

// Background: dark rounded square
fillRoundedRect(0, 0, size, size, 72, 10, 10, 18);

const pad = 40;
const area = size - pad * 2;
const gap = 10; // wider gaps for clear block separation

// Treemap blocks — wider spacing, brighter colors, more contrast
const blocks = [
  // Large block top-left (amber — the "big file")
  { x: 0, y: 0, w: 0.54, h: 0.58, r: 245, g: 158, b: 11 },
  // Medium block top-right
  { x: 0.56, y: 0, w: 0.44, h: 0.34, r: 234, g: 120, b: 8 },
  // Two small blocks mid-right
  { x: 0.56, y: 0.36, w: 0.21, h: 0.22, r: 220, g: 90, b: 12 },
  { x: 0.79, y: 0.36, w: 0.21, h: 0.22, r: 180, g: 70, b: 10 },
  // Bottom row — varied colors for visual interest
  { x: 0, y: 0.60, w: 0.34, h: 0.40, r: 239, g: 68, b: 68 },   // red
  { x: 0.36, y: 0.60, w: 0.28, h: 0.40, r: 168, g: 85, b: 247 }, // purple
  { x: 0.66, y: 0.60, w: 0.34, h: 0.19, r: 59, g: 130, b: 246 }, // blue
  { x: 0.66, y: 0.81, w: 0.34, h: 0.19, r: 16, g: 185, b: 129 }, // green
];

for (const b of blocks) {
  const bx = Math.round(pad + b.x * area);
  const by = Math.round(pad + b.y * area);
  const bw = Math.round(b.w * area) - gap;
  const bh = Math.round(b.h * area) - gap;
  const radius = 18;

  fillRoundedRect(bx, by, bw, bh, radius, b.r, b.g, b.b);

  // Top highlight — brighter top edge for depth
  for (let row = 0; row < 3; row++) {
    for (let x = bx + radius + 2; x < bx + bw - radius - 2; x++) {
      const i = ((by + row) * size + x) * 4;
      if (i >= 0 && i < pixels.length - 3) {
        pixels[i] = Math.min(255, pixels[i] + 35 - row * 10);
        pixels[i + 1] = Math.min(255, pixels[i + 1] + 35 - row * 10);
        pixels[i + 2] = Math.min(255, pixels[i + 2] + 35 - row * 10);
      }
    }
  }

  // Bottom shadow — darker bottom edge
  for (let row = 0; row < 2; row++) {
    for (let x = bx + radius + 2; x < bx + bw - radius - 2; x++) {
      const yy = by + bh - 1 - row;
      const i = (yy * size + x) * 4;
      if (i >= 0 && i < pixels.length - 3) {
        pixels[i] = Math.max(0, pixels[i] - 25 + row * 10);
        pixels[i + 1] = Math.max(0, pixels[i + 1] - 25 + row * 10);
        pixels[i + 2] = Math.max(0, pixels[i + 2] - 25 + row * 10);
      }
    }
  }
}

// Write PNG
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const rawData = Buffer.alloc(size * (1 + size * 4));
for (let y = 0; y < size; y++) {
  rawData[y * (1 + size * 4)] = 0;
  pixels.copy(rawData, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
}
const compressed = deflateSync(rawData);

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
