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
 * Block layouts for the treemap-style icon.
 *
 * Why two tiers (and not more): at 16-24 px the full 8-block layout
 * dissolves into noise — each block is 2-3 px and the anti-aliased
 * corners blend into the dark frame, so GNOME's top-bar renderer
 * either gets a featureless blob (early bug: black) or, when the
 * theme applies its top-bar saturation/recolor, a near-white square
 * (later bug). At 32 px and up there's room for the full 8-block
 * treemap to breathe, and that's the design DiskHound has had since
 * v0.5.3 — the user explicitly preferred it ("nicer and higher def")
 * over the simpler 4/5-block fallbacks the previous version
 * substituted at medium sizes. So now the 8-block layout owns
 * everything ≥ 32 px, and only 16/24 fall back to a 2x2.
 *
 * Coordinate system: x/y/w/h are fractions of the inner content area
 * (after subtracting `pad` from each side). One layout, scales to
 * every size we ship.
 *
 * Color palette mirrors the DiskHound treemap (orange / red /
 * purple / blue / teal / green) so the app icon and the in-app
 * Overview look like the same family.
 */
const BLOCKS_TINY = [
  // ≤ 24 px: 2×2 grid of four bold tiles. Single-tile orange (the
  // 0.5.5 attempt) read as a flat color which Yaru-style themes
  // re-tinted to white in the GNOME top bar — four distinct colors
  // are detail the theme can't desaturate to "background".
  { x: 0,    y: 0,    w: 0.52, h: 0.52, r: 245, g: 158, b: 11  }, // orange
  { x: 0.52, y: 0,    w: 0.48, h: 0.52, r: 234, g: 120, b: 8   }, // dark orange
  { x: 0,    y: 0.52, w: 0.52, h: 0.48, r: 239, g: 68,  b: 68  }, // red
  { x: 0.52, y: 0.52, w: 0.48, h: 0.48, r: 59,  g: 130, b: 246 }, // blue
];
const BLOCKS_FULL = [
  // ≥ 32 px: the v0.5.3 8-block treemap. The same set the in-app
  // Overview tab paints, so the dock icon, the title-bar icon, and
  // the renderer's treemap all share a visual signature.
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
  // Cutoff is 32: below it, 8 blocks of ≤2 px each become noise;
  // at it, blocks are ~3-4 px which is visible.
  return size < 32 ? BLOCKS_TINY : BLOCKS_FULL;
}

/**
 * Padding/gap profile.
 *
 * At ≤24 px we lean on a thicker frame (12-14% of canvas) so the
 * dark border is a real silhouette element — without it, a 2x2 of
 * bright tiles looks like 4 floating chips. At ≥32 px we use the
 * original v0.5.3 7.8% padding so the 8 blocks fill the canvas
 * the way the user remembers from earlier builds.
 *
 * The old generator used 7.8% across the board, which at 16 px
 * collapsed to a 1 px frame — effectively invisible — and was one
 * of the reasons the small icons rendered as featureless blobs.
 */
function paddingFor(size) {
  if (size <= 24) return Math.max(2, Math.round(size * 0.13));
  return Math.max(3, Math.round(size * 0.078));
}

function gapFor(size) {
  // Minimum 2 px so anti-aliasing on adjacent block edges doesn't
  // blur into a single mass at small sizes. Scales modestly with
  // size so the 512 PNG doesn't get gaps that look like negative
  // space at large dock sizes. Original v0.5.3 used a flat
  // max(2, round(size*0.02)) which produced 2 px gaps everywhere
  // up to 100 px — keep that behavior at the upper end.
  if (size <= 24) return 2;
  return Math.max(2, Math.round(size * 0.02));
}

/**
 * Internal supersample factor. We render every icon at SS× its
 * target dimensions then box-filter average down to the requested
 * size. Reasons:
 *
 *   - The hand-rolled `fillRoundedRect` AA produces a 1-px gradient
 *     at the rounded corners. At small final sizes (16-32 px) that
 *     gradient is wider than the corner itself, so corners look
 *     stair-stepped instead of smooth. Supersampling moves the AA
 *     into the source pixels where it has room to be subtle.
 *
 *   - Block edges (radius ~4-5 px native) similarly suffer at sizes
 *     where 1 px ≈ 6% of the block. Rendering at 3× and
 *     downsampling produces dramatically smoother edges that the
 *     user described as "higher-res" in the previous round.
 *
 * 3× is the sweet spot — 4× doubles the work for marginal visual
 * gain, 2× isn't enough to fix the 16-32 px corner aliasing.
 */
const SUPERSAMPLE = 3;

function renderIcon(targetSize) {
  // Render at supersampled size; downsample at the end. `designSize`
  // (the target) drives layout decisions (which block set, where
  // the highlight cutoff is); `canvas` is the actual pixel buffer
  // we paint into.
  const canvas = targetSize * SUPERSAMPLE;
  const pixels = Buffer.alloc(canvas * canvas * 4);

  // Background: dark rounded square. Slightly larger corner radius
  // than the previous 14% — gives the icon a softer, more "tile"-
  // like silhouette in the GNOME dock where neighbours (Firefox,
  // Settings) all have round-ish silhouettes.
  fillRoundedRect(pixels, canvas, 0, 0, canvas, canvas, Math.round(canvas * 0.18), 10, 10, 18);

  // padding/gap are picked using the TARGET size so the visual
  // weight matches what the user sees (a 16 px icon should look
  // like a 16 px icon, not "16 × the same fractional padding as
  // 256"). Then scale up to canvas pixels for actual painting.
  const pad = paddingFor(targetSize) * SUPERSAMPLE;
  const area = canvas - pad * 2;
  const gap = gapFor(targetSize) * SUPERSAMPLE;
  const blocks = pickBlocks(targetSize);
  const blockRadius = Math.max(2, Math.round(canvas * 0.045));
  // Use targetSize for the small-size highlight cutoff — the 3D
  // cues are noise at small target sizes regardless of how many
  // canvas pixels we actually painted into.
  const skipDepthCues = targetSize < 64;

  for (const b of blocks) {
    const bx = Math.round(pad + b.x * area);
    const by = Math.round(pad + b.y * area);
    const bw = Math.max(1, Math.round(b.w * area) - gap);
    const bh = Math.max(1, Math.round(b.h * area) - gap);

    fillRoundedRect(pixels, canvas, bx, by, bw, bh, blockRadius, b.r, b.g, b.b);

    if (skipDepthCues) continue;

    const highlightRows = Math.max(1, Math.round(canvas * 0.006));
    for (let row = 0; row < highlightRows; row++) {
      for (let x = bx + blockRadius + 2; x < bx + bw - blockRadius - 2; x++) {
        const i = ((by + row) * canvas + x) * 4;
        if (i >= 0 && i < pixels.length - 3) {
          const delta = Math.max(8, Math.round(canvas * 0.07) - row * Math.max(3, Math.round(canvas * 0.02)));
          pixels[i] = Math.min(255, pixels[i] + delta);
          pixels[i + 1] = Math.min(255, pixels[i + 1] + delta);
          pixels[i + 2] = Math.min(255, pixels[i + 2] + delta);
        }
      }
    }

    const shadowRows = Math.max(1, Math.round(canvas * 0.004));
    for (let row = 0; row < shadowRows; row++) {
      for (let x = bx + blockRadius + 2; x < bx + bw - blockRadius - 2; x++) {
        const yy = by + bh - 1 - row;
        const i = (yy * canvas + x) * 4;
        if (i >= 0 && i < pixels.length - 3) {
          const delta = Math.max(6, Math.round(canvas * 0.05) - row * Math.max(2, Math.round(canvas * 0.02)));
          pixels[i] = Math.max(0, pixels[i] - delta);
          pixels[i + 1] = Math.max(0, pixels[i + 1] - delta);
          pixels[i + 2] = Math.max(0, pixels[i + 2] - delta);
        }
      }
    }
  }

  // Box-filter downsample from canvas (= targetSize × SUPERSAMPLE)
  // to targetSize. Each output pixel is the unweighted average of
  // the SS×SS source pixels it corresponds to. Box filter is
  // crude vs. Lanczos but for our flat-color blocks with hard
  // edges it produces clean, slightly-softened edges without the
  // ringing artifacts a sharper filter would introduce.
  return downsampleBoxed(pixels, canvas, targetSize);
}

function downsampleBoxed(srcPixels, srcSize, dstSize) {
  if (srcSize === dstSize) return srcPixels;
  const ratio = srcSize / dstSize;
  const out = Buffer.alloc(dstSize * dstSize * 4);
  for (let dy = 0; dy < dstSize; dy++) {
    for (let dx = 0; dx < dstSize; dx++) {
      const sxStart = Math.floor(dx * ratio);
      const sxEnd = Math.min(srcSize, Math.floor((dx + 1) * ratio));
      const syStart = Math.floor(dy * ratio);
      const syEnd = Math.min(srcSize, Math.floor((dy + 1) * ratio));
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let sy = syStart; sy < syEnd; sy++) {
        for (let sx = sxStart; sx < sxEnd; sx++) {
          const si = (sy * srcSize + sx) * 4;
          r += srcPixels[si];
          g += srcPixels[si + 1];
          b += srcPixels[si + 2];
          a += srcPixels[si + 3];
          count += 1;
        }
      }
      const di = (dy * dstSize + dx) * 4;
      if (count > 0) {
        out[di]     = Math.round(r / count);
        out[di + 1] = Math.round(g / count);
        out[di + 2] = Math.round(b / count);
        out[di + 3] = Math.round(a / count);
      }
    }
  }
  return out;
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

// Standard freedesktop hicolor sizes plus 96 + 192. We include 96
// because the GNOME dock at default scale renders icons in the
// 64-96 px range — without an explicit 96 size, GNOME picks 64.png
// and upscales 1.5×, which is exactly the "low-res / jaggedy"
// rendering the user reported. 192 covers the same gap at HiDPI
// (200% scale → 128 logical = 256 physical, dock often picks the
// in-between).
const sizes = [16, 24, 32, 48, 64, 96, 128, 192, 256, 512];
for (const size of sizes) {
  const png = encodePng(size, renderIcon(size));
  const iconPath = size === 512 ? "build/icon.png" : `build/icons/${size}x${size}.png`;
  writeFileSync(iconPath, png);
  console.log(`Generated ${iconPath} (${size}x${size}, ${png.length} bytes)`);
}

writeFileSync("build/icons/512x512.png", encodePng(512, renderIcon(512)));
