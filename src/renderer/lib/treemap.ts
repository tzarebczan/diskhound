import type { ScanFileRecord } from "../../shared/contracts";

export interface TreemapRect {
  x: number;
  y: number;
  w: number;
  h: number;
  file: ScanFileRecord;
  color: string;
}

export interface TreemapFeaturedItem {
  file: ScanFileRecord;
  share: number;
}

export type TreemapAreaMode = "compressed" | "exact";

export interface TreemapComposition {
  featuredFiles: TreemapFeaturedItem[];
  mapFiles: ScanFileRecord[];
  trackedBytes: number;
  remainingBytes: number;
}

// Extension → color mapping (HSL-based, dark palette)
// Comprehensive color map — every common file type gets a distinct category color
const EXT_COLORS: Record<string, string> = {
  // Video — warm orange
  ".mp4": "#c2410c", ".mkv": "#c2410c", ".avi": "#c2410c", ".mov": "#c2410c",
  ".wmv": "#c2410c", ".webm": "#c2410c", ".m4v": "#c2410c", ".flv": "#c2410c",
  ".ts": "#c2410c",
  // Audio — purple
  ".mp3": "#7c3aed", ".flac": "#7c3aed", ".wav": "#7c3aed",
  ".aac": "#7c3aed", ".m4a": "#7c3aed", ".wma": "#7c3aed", ".ogg": "#7c3aed",
  // Images — teal
  ".jpg": "#0d9488", ".jpeg": "#0d9488", ".png": "#0d9488",
  ".gif": "#0d9488", ".webp": "#0d9488", ".svg": "#0d9488",
  ".psd": "#0d9488", ".raw": "#0d9488", ".heic": "#0d9488", ".bmp": "#0d9488",
  ".tif": "#0d9488", ".tiff": "#0d9488", ".ico": "#0d9488",
  // Archives — dark amber
  ".zip": "#b45309", ".rar": "#b45309", ".7z": "#b45309",
  ".tar": "#b45309", ".gz": "#b45309", ".bz2": "#b45309", ".xz": "#b45309",
  ".zst": "#b45309",
  // Disk images — burnt sienna
  ".iso": "#92400e", ".img": "#92400e", ".vhd": "#92400e", ".vhdx": "#92400e",
  ".vmdk": "#92400e", ".wim": "#92400e",
  // Executables & binaries — red
  ".exe": "#dc2626", ".msi": "#dc2626", ".msix": "#dc2626", ".appx": "#dc2626",
  // System libraries — dusty rose
  ".dll": "#9f1239", ".sys": "#9f1239", ".drv": "#9f1239", ".ocx": "#9f1239",
  // Windows system files — slate blue
  ".dat": "#4f46e5", ".cat": "#4f46e5", ".mum": "#4f46e5", ".manifest": "#4f46e5",
  ".mui": "#4f46e5", ".nls": "#4f46e5", ".inf": "#4f46e5",
  // Windows caches & indexes — cool gray
  ".cab": "#6366f1", ".msp": "#6366f1", ".msu": "#6366f1",
  ".efi": "#6366f1", ".etl": "#6366f1",
  // Database & data files — cyan
  ".db": "#0891b2", ".sqlite": "#0891b2", ".mdb": "#0891b2",
  ".ldf": "#0891b2", ".mdf": "#0891b2", ".bak": "#0891b2",
  // Documents — ocean blue
  ".pdf": "#0369a1", ".doc": "#0369a1", ".docx": "#0369a1",
  ".xls": "#0369a1", ".xlsx": "#0369a1", ".ppt": "#0369a1", ".pptx": "#0369a1",
  ".rtf": "#0369a1", ".odt": "#0369a1",
  // Code — varied
  ".js": "#a16207", ".jsx": "#a16207", ".mjs": "#a16207",
  ".tsx": "#1d4ed8", ".py": "#15803d", ".rs": "#9a3412",
  ".go": "#0891b2", ".java": "#b91c1c", ".cs": "#6d28d9", ".cpp": "#0369a1",
  ".c": "#0369a1", ".h": "#0369a1",
  // Config & data — warm gray
  ".json": "#78716c", ".xml": "#78716c", ".yaml": "#78716c", ".yml": "#78716c",
  ".toml": "#78716c", ".ini": "#78716c", ".cfg": "#78716c", ".conf": "#78716c",
  ".reg": "#78716c",
  // Logs & temp — cool dark
  ".log": "#57534e", ".tmp": "#57534e", ".temp": "#57534e",
  // Fonts — plum
  ".ttf": "#a21caf", ".otf": "#a21caf", ".woff": "#a21caf", ".woff2": "#a21caf",
  // Virtual memory / swap — distinct indigo (note: .sys already mapped above under system libraries)
  ".pagefile": "#4338ca", ".hiberfil": "#4338ca",
};
const DEFAULT_COLOR = "#475569";
const PRIMARY_DOMINANT_SHARE = 0.38;
const SECONDARY_DOMINANT_SHARE = 0.16;
const MAX_FEATURED_FILES = 2;

export function colorForExtension(ext: string): string {
  return EXT_COLORS[ext.toLowerCase()] ?? DEFAULT_COLOR;
}

export function buildTreemapComposition(
  files: ScanFileRecord[],
): TreemapComposition {
  const sorted = [...files].sort((a, b) => b.size - a.size);
  const trackedBytes = files.reduce((sum, file) => sum + file.size, 0);

  if (sorted.length === 0 || trackedBytes <= 0) {
    return {
      featuredFiles: [],
      mapFiles: sorted,
      trackedBytes,
      remainingBytes: trackedBytes,
    };
  }

  const featuredFiles: TreemapFeaturedItem[] = [];

  for (let index = 0; index < Math.min(sorted.length, MAX_FEATURED_FILES); index++) {
    const file = sorted[index];
    if (!file) continue;

    const share = file.size / trackedBytes;
    const minShare = index === 0 ? PRIMARY_DOMINANT_SHARE : SECONDARY_DOMINANT_SHARE;

    if (share < minShare) {
      break;
    }

    featuredFiles.push({ file, share });
  }

  if (featuredFiles.length === 0 || sorted.length - featuredFiles.length < 2) {
    return {
      featuredFiles: [],
      mapFiles: sorted,
      trackedBytes,
      remainingBytes: trackedBytes,
    };
  }

  const mapFiles = sorted.slice(featuredFiles.length);
  const remainingBytes = Math.max(
    0,
    trackedBytes - featuredFiles.reduce((sum, item) => sum + item.file.size, 0),
  );

  return {
    featuredFiles,
    mapFiles,
    trackedBytes,
    remainingBytes,
  };
}

export function buildTreemapRects(
  files: ScanFileRecord[],
  width: number,
  height: number,
  areaMode: TreemapAreaMode = "compressed",
): TreemapRect[] {
  if (files.length === 0 || width <= 0 || height <= 0) return [];

  // Square-root compression: reduces the visual dominance of very large files
  // while preserving relative ordering. A 48GB file vs 100MB goes from 480:1
  // to ~22:1 — still clearly larger, but doesn't eat the entire canvas.
  const sorted = [...files].sort((a, b) => b.size - a.size);
  const weighted = sorted.map((file) => ({
    file,
    weight: areaMode === "exact" ? file.size : Math.sqrt(file.size),
  }));
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight === 0) return [];

  const rects: TreemapRect[] = [];
  squarify(weighted, { x: 0, y: 0, w: width, h: height }, totalWeight, rects);
  return rects;
}

interface WeightedFile {
  file: ScanFileRecord;
  weight: number;
}

interface Rect { x: number; y: number; w: number; h: number; }

function squarify(
  items: WeightedFile[],
  bounds: Rect,
  totalWeight: number,
  out: TreemapRect[],
): void {
  if (items.length === 0 || bounds.w <= 0 || bounds.h <= 0) return;

  if (items.length === 1) {
    out.push({
      ...bounds,
      file: items[0]!.file,
      color: colorForExtension(items[0]!.file.extension),
    });
    return;
  }

  const isWide = bounds.w >= bounds.h;
  const sideLen = isWide ? bounds.h : bounds.w;
  const totalArea = bounds.w * bounds.h;

  let rowItems: WeightedFile[] = [];
  let rowWeight = 0;
  let bestAspect = Infinity;
  let splitIndex = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const nextRowWeight = rowWeight + item.weight;
    const nextRowLen = (nextRowWeight / totalWeight) * (isWide ? bounds.w : bounds.h);

    // Calculate worst aspect ratio for row with this item
    const nextItems = [...rowItems, item];
    let worstAspect = 0;
    for (const ri of nextItems) {
      const itemLen = sideLen > 0 && nextRowLen > 0
        ? (ri.weight / totalWeight) * totalArea / nextRowLen
        : 1;
      const aspect = Math.max(nextRowLen / itemLen, itemLen / nextRowLen);
      worstAspect = Math.max(worstAspect, aspect);
    }

    if (worstAspect <= bestAspect || rowItems.length === 0) {
      bestAspect = worstAspect;
      rowItems = nextItems;
      rowWeight = nextRowWeight;
      splitIndex = i + 1;
    } else {
      break;
    }
  }

  // Layout the row
  const rowFraction = rowWeight / totalWeight;
  const rowLen = isWide
    ? bounds.w * rowFraction
    : bounds.h * rowFraction;

  let offset = 0;
  for (const item of rowItems) {
    const itemFraction = rowWeight > 0 ? item.weight / rowWeight : 1 / rowItems.length;
    const itemLen = sideLen * itemFraction;

    const rect: Rect = isWide
      ? { x: bounds.x, y: bounds.y + offset, w: rowLen, h: itemLen }
      : { x: bounds.x + offset, y: bounds.y, w: itemLen, h: rowLen };

    out.push({
      ...rect,
      file: item.file,
      color: colorForExtension(item.file.extension),
    });
    offset += itemLen;
  }

  // Recurse on remaining items
  const remaining = items.slice(splitIndex);
  if (remaining.length > 0) {
    const newBounds: Rect = isWide
      ? { x: bounds.x + rowLen, y: bounds.y, w: bounds.w - rowLen, h: bounds.h }
      : { x: bounds.x, y: bounds.y + rowLen, w: bounds.w, h: bounds.h - rowLen };

    squarify(remaining, newBounds, totalWeight - rowWeight, out);
  }
}
