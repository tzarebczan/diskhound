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

/**
 * Block layouts for the treemap-style icon, tiered by render size.
 *
 * Why tiered: at 16-24 px each block in the original 8-block layout
 * was 2-3 actual pixels, and with anti-aliasing on the rounded
 * corners those pixels blended into the dark background — the icon
 * read as a featureless dark square in the GNOME top bar (the user
 * literally described it as "some black thing"). The fix is to drop
 * complexity at small sizes so the remaining elements stay bold and
 * legible, and only escalate to the full 8-block treemap at 64+ px
 * where each block has room to breathe.
 *
 * Coordinate system: x/y/w/h are fractions of the inner content area
 * (after subtracting `pad` from each side), so a single layout works
 * across all sizes — the renderer scales them up.
 *
 * Color palette is the DiskHound treemap colors (orange / red /
 * purple / blue / teal / green) so the icon visually matches the
 * Overview treemap at a glance.
 */
const BLOCKS_TINY = [
  // ≤ 24 px: a single bold orange tile fills nearly the whole canvas.
  // Recognisable as "DiskHound orange" against the GNOME top-bar
  // background even when downscaled to 16 px.
  { x: 0, y: 0, w: 1.0, h: 1.0, r: 245, g: 158, b: 11 },
];
const BLOCKS_SMALL = [
  // 32-48 px: 2x2 grid of four big blocks. Enough resolution to
  // hint at the treemap concept without dissolving into noise. The
  // dominant orange (top-left) preserves brand identity at sidebar
  // sizes.
  { x: 0,    y: 0,    w: 0.55, h: 0.55, r: 245, g: 158, b: 11 }, // orange
  { x: 0.55, y: 0,    w: 0.45, h: 0.55, r: 234, g: 120, b: 8  }, // dark orange
  { x: 0,    y: 0.55, w: 0.55, h: 0.45, r: 239, g: 68,  b: 68 }, // red
  { x: 0.55, y: 0.55, w: 0.45, h: 0.45, r: 59,  g: 130, b: 246 }, // blue
];
const BLOCKS_MEDIUM = [
  // 64 px: 5 blocks. Drops the smallest two blocks from the full
  // layout — enough complexity to read as a treemap, not so much
  // that adjacent blocks merge.
  { x: 0,    y: 0,    w: 0.60, h: 0.62, r: 245, g: 158, b: 11 },
  { x: 0.62, y: 0,    w: 0.38, h: 0.40, r: 234, g: 120, b: 8  },
  { x: 0.62, y: 0.42, w: 0.38, h: 0.20, r: 220, g: 90,  b: 12 },
  { x: 0,    y: 0.64, w: 0.45, h: 0.36, r: 239, g: 68,  b: 68 },
  { x: 0.47, y: 0.64, w: 0.53, h: 0.36, r: 59,  g: 130, b: 246 },
];
const BLOCKS_FULL = [
  // 128+ px: full 8-block treemap. Detail is welcome at this size
  // and matches DiskHound's actual treemap rendering.
  { x: 0,    y: 0,    w: 0.54, h: 0.58, r: 245, g: 158, b: 11  },
  { x: 0.56, y: 0,    w: 0.44, h: 0.34, r: 234, g: 120, b: 8   },
  { x: 0.56, y: 0.36, w: 0.21, h: 0.22, r: 220, g: 90,  b: 12  },
  { x: 0.79, y: 0.36, w: 0.21, h: 0.22, r: 180, g: 70,  b: 10  },
  { x: 0,    y: 0.60, w: 0.34, h: 0.40, r: 239, g: 68,  b: 68  },
  { x: 0.36, y: 0.60, w: 0.28, h: 0.40, r: 168, g: 85,  b: 247 },
  { x: 0.66, y: 0.60, w: 0.34, h: 0.19, r: 59,  g: 130, b: 246 },
  { x: 0.66, y: 0.81, w: 0.34, h: 0.19, r: 16,  g: 185, b: 129 },
];

function pickBlocks(size) {
  if (size <= 24) return BLOCKS_TINY;
  if (size <= 48) return BLOCKS_SMALL;
  if (size <= 96) return BLOCKS_MEDIUM;
  return BLOCKS_FULL;
}

/**
 * Padding/gap profile: bigger at small sizes so the dark frame is
 * visually obvious (gives the icon a recognisable silhouette
 * against light dock backgrounds), smaller at large sizes where
 * blocks already have plenty of room.
 *
 * The old generator used pad = 7.8% across the board, which at
 * 16 px collapsed to a 1 px frame — invisible on most themes and
 * indistinguishable from "no border at all". At 14% the frame is
 * a clear 2-3 px line at small sizes, and gap is generous enough
 * that adjacent blocks don't fuse during downscale.
 */
function paddingFor(size) {
  if (size <= 24) return Math.max(2, Math.round(size * 0.14));
  if (size <= 48) return Math.max(2, Math.round(size * 0.10));
  return Math.max(3, Math.round(size * 0.08));
}

function gapFor(size) {
  // Minimum 2 px so anti-aliasing on adjacent block edges doesn't
  // blur into a single mass at small sizes. Scales up modestly so
  // 512 px doesn't get gaps that look like negative space.
  if (size <= 32) return 2;
  if (size <= 64) return 3;
  return Math.max(3, Math.round(size * 0.018));
}

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);

  // Background: dark rounded square. Slightly larger corner radius
  // than the previous 14% — gives the icon a softer, more "tile"-
  // like silhouette in the GNOME dock where neighbours (Firefox,
  // Settings) all have round-ish silhouettes.
  fillRoundedRect(pixels, size, 0, 0, size, size, Math.round(size * 0.18), 10, 10, 18);

  const pad = paddingFor(size);
  const area = size - pad * 2;
  const gap = gapFor(size);
  const blocks = pickBlocks(size);
  const blockRadius = Math.max(2, Math.round(size * 0.045));

  for (const b of blocks) {
    const bx = Math.round(pad + b.x * area);
    const by = Math.round(pad + b.y * area);
    const bw = Math.max(1, Math.round(b.w * area) - gap);
    const bh = Math.max(1, Math.round(b.h * area) - gap);

    fillRoundedRect(pixels, size, bx, by, bw, bh, blockRadius, b.r, b.g, b.b);

    // Highlight + shadow are subtle 3D cues that read as "pressed
    // tile" at large sizes but become noise at small sizes — skip
    // them below 64 px where every pixel of the block matters for
    // legibility.
    if (size < 64) continue;

    const highlightRows = Math.max(1, Math.round(size * 0.006));
    for (let row = 0; row < highlightRows; row++) {
      for (let x = bx + blockRadius + 2; x < bx + bw - blockRadius - 2; x++) {
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
      for (let x = bx + blockRadius + 2; x < bx + bw - blockRadius - 2; x++) {
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
