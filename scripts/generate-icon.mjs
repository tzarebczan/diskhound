/**
 * Generate DiskHound app icons using only Node.js built-ins.
 * Run: node scripts/generate-icon.mjs
 * Output:
 *   - build/icon.png
 *   - build/icons/<size>x<size>.png
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

function blendPixel(pixels, size, x, y, r, g, b, a) {
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

function fillRoundedRect(pixels, size, x0, y0, w, h, radius, r, g, b) {
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
        blendPixel(pixels, size, x, y, r, g, b, 255);
      } else {
        // Corner — use distance for anti-aliasing
        const dist = Math.sqrt(dx * dx + dy * dy) - radius;
        if (dist < -1) {
          blendPixel(pixels, size, x, y, r, g, b, 255); // fully inside
        } else if (dist < 1) {
          // Edge pixel — blend based on coverage (smooth AA)
          const alpha = Math.round(255 * Math.max(0, Math.min(1, 0.5 - dist * 0.5)));
          blendPixel(pixels, size, x, y, r, g, b, alpha);
        }
        // dist >= 1: fully outside, skip
      }
    }
  }
}

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);

  // Background: dark rounded square
  fillRoundedRect(pixels, size, 0, 0, size, size, Math.round(size * 0.14), 10, 10, 18);

  const pad = Math.round(size * 0.078);
  const area = size - pad * 2;
  const gap = Math.max(2, Math.round(size * 0.02));

  const blocks = [
    { x: 0, y: 0, w: 0.54, h: 0.58, r: 245, g: 158, b: 11 },
    { x: 0.56, y: 0, w: 0.44, h: 0.34, r: 234, g: 120, b: 8 },
    { x: 0.56, y: 0.36, w: 0.21, h: 0.22, r: 220, g: 90, b: 12 },
    { x: 0.79, y: 0.36, w: 0.21, h: 0.22, r: 180, g: 70, b: 10 },
    { x: 0, y: 0.60, w: 0.34, h: 0.40, r: 239, g: 68, b: 68 },
    { x: 0.36, y: 0.60, w: 0.28, h: 0.40, r: 168, g: 85, b: 247 },
    { x: 0.66, y: 0.60, w: 0.34, h: 0.19, r: 59, g: 130, b: 246 },
    { x: 0.66, y: 0.81, w: 0.34, h: 0.19, r: 16, g: 185, b: 129 },
  ];

  for (const b of blocks) {
    const bx = Math.round(pad + b.x * area);
    const by = Math.round(pad + b.y * area);
    const bw = Math.max(1, Math.round(b.w * area) - gap);
    const bh = Math.max(1, Math.round(b.h * area) - gap);
    const radius = Math.max(4, Math.round(size * 0.035));

    fillRoundedRect(pixels, size, bx, by, bw, bh, radius, b.r, b.g, b.b);

    const highlightRows = Math.max(1, Math.round(size * 0.006));
    for (let row = 0; row < highlightRows; row++) {
      for (let x = bx + radius + 2; x < bx + bw - radius - 2; x++) {
        const i = ((by + row) * size + x) * 4;
        if (i >= 0 && i < pixels.length - 3) {
          const delta = Math.max(8, Math.round(size * 0.07) - row * Math.max(3, Math.round(size * 0.02)));
          pixels[i] = Math.min(255, pixels[i] + delta);
          pixels[i + 1] = Math.min(255, pixels[i + 1] + delta);
          pixels[i + 2] = Math.min(255, pixels[i + 2] + delta);
        }
      }
    }

    const shadowRows = Math.max(1, Math.round(size * 0.004));
    for (let row = 0; row < shadowRows; row++) {
      for (let x = bx + radius + 2; x < bx + bw - radius - 2; x++) {
        const yy = by + bh - 1 - row;
        const i = (yy * size + x) * 4;
        if (i >= 0 && i < pixels.length - 3) {
          const delta = Math.max(6, Math.round(size * 0.05) - row * Math.max(2, Math.round(size * 0.02)));
          pixels[i] = Math.max(0, pixels[i] - delta);
          pixels[i + 1] = Math.max(0, pixels[i + 1] - delta);
          pixels[i + 2] = Math.max(0, pixels[i + 2] - delta);
        }
      }
    }
  }

  return pixels;
}

function encodePng(size, pixels) {
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

  return Buffer.concat([
    signature,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", compressed),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("build", { recursive: true });
mkdirSync("build/icons", { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
for (const size of sizes) {
  const png = encodePng(size, renderIcon(size));
  const iconPath = size === 512 ? "build/icon.png" : `build/icons/${size}x${size}.png`;
  writeFileSync(iconPath, png);
  console.log(`Generated ${iconPath} (${size}x${size}, ${png.length} bytes)`);
}

writeFileSync("build/icons/512x512.png", encodePng(512, renderIcon(512)));
