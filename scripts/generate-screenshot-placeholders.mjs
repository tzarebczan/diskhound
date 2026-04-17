/**
 * Generate dark placeholder PNGs for the README screenshot slots.
 * Each is a simple dark panel with the filename centered so the README
 * doesn't show broken-image icons before real screenshots are captured.
 *
 * Run: node scripts/generate-screenshot-placeholders.mjs
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const PLACEHOLDERS = [
  { name: "overview",   width: 1600, height: 900, label: "Overview" },
  { name: "duplicates", width: 1400, height: 780, label: "Duplicates" },
  { name: "changes",    width: 1400, height: 780, label: "Changes" },
  { name: "folders",    width: 1400, height: 780, label: "Folders" },
  { name: "settings",   width: 1400, height: 780, label: "Settings" },
];

// Pixel font — 5x7 per glyph, packed as uppercase bitmaps
const GLYPHS = {
  A: ["01110","10001","10001","11111","10001","10001","10001"],
  B: ["11110","10001","10001","11110","10001","10001","11110"],
  C: ["01111","10000","10000","10000","10000","10000","01111"],
  D: ["11110","10001","10001","10001","10001","10001","11110"],
  E: ["11111","10000","10000","11110","10000","10000","11111"],
  F: ["11111","10000","10000","11110","10000","10000","10000"],
  G: ["01111","10000","10000","10011","10001","10001","01111"],
  H: ["10001","10001","10001","11111","10001","10001","10001"],
  I: ["01110","00100","00100","00100","00100","00100","01110"],
  L: ["10000","10000","10000","10000","10000","10000","11111"],
  N: ["10001","11001","10101","10011","10001","10001","10001"],
  O: ["01110","10001","10001","10001","10001","10001","01110"],
  P: ["11110","10001","10001","11110","10000","10000","10000"],
  R: ["11110","10001","10001","11110","10100","10010","10001"],
  S: ["01111","10000","10000","01110","00001","00001","11110"],
  T: ["11111","00100","00100","00100","00100","00100","00100"],
  U: ["10001","10001","10001","10001","10001","10001","01110"],
  V: ["10001","10001","10001","10001","10001","01010","00100"],
  X: ["10001","10001","01010","00100","01010","10001","10001"],
  " ": ["00000","00000","00000","00000","00000","00000","00000"],
};

function buildPng(width, height, label) {
  const pixels = Buffer.alloc(width * height * 4);

  // Dark background (#0e0e14)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = 14;
    pixels[i * 4 + 1] = 14;
    pixels[i * 4 + 2] = 20;
    pixels[i * 4 + 3] = 255;
  }

  // Subtle diagonal gradient accent
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (x + y) / (width + height);
      const i = (y * width + x) * 4;
      pixels[i] = Math.min(255, 14 + Math.floor(t * 8));
      pixels[i + 1] = Math.min(255, 14 + Math.floor(t * 8));
      pixels[i + 2] = Math.min(255, 20 + Math.floor(t * 12));
    }
  }

  // Draw label in amber, scaled up
  const text = label.toUpperCase();
  const scale = Math.max(6, Math.floor(height / 20));
  const charW = 5 * scale;
  const charH = 7 * scale;
  const gap = scale;
  const totalW = text.length * (charW + gap) - gap;
  const startX = Math.floor((width - totalW) / 2);
  const startY = Math.floor((height - charH) / 2);

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const glyph = GLYPHS[ch] ?? GLYPHS[" "];
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] === "1") {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const px = startX + i * (charW + gap) + gx * scale + dx;
              const py = startY + gy * scale + dy;
              if (px < 0 || px >= width || py < 0 || py >= height) continue;
              const pi = (py * width + px) * 4;
              // Amber #f59e0b
              pixels[pi] = 245;
              pixels[pi + 1] = 158;
              pixels[pi + 2] = 11;
            }
          }
        }
      }
    }
  }

  // Subtitle text area — simpler approach: just a hint bar at bottom
  const barY = height - Math.floor(height / 10);
  const barH = 3;
  for (let y = barY; y < barY + barH && y < height; y++) {
    for (let x = Math.floor(width * 0.3); x < Math.floor(width * 0.7); x++) {
      const i = (y * width + x) * 4;
      pixels[i] = 71; pixels[i + 1] = 85; pixels[i + 2] = 105;
    }
  }

  return encodePng(pixels, width, height);
}

function encodePng(pixels, width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0;
    pixels.copy(rawData, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
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

mkdirSync("docs/screenshots", { recursive: true });
for (const p of PLACEHOLDERS) {
  const png = buildPng(p.width, p.height, p.label);
  writeFileSync(`docs/screenshots/${p.name}.png`, png);
  console.log(`Generated docs/screenshots/${p.name}.png (${p.width}x${p.height}, ${png.length} bytes)`);
}
