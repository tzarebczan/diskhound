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

/**
 * Layout strategy for the treemap.
 * - `size`: classic squarified layout where every file is placed by area,
 *   ordered globally by size. Largest-first, scattered across the canvas.
 * - `tree`: WinDirStat-style hierarchical layout. Files are recursively
 *   grouped inside their directory's rectangle so siblings cluster
 *   physically. Better for understanding structure ("what's eating my
 *   Downloads folder") at the cost of less obvious size ranking.
 */
export type TreemapLayout = "size" | "tree";

/**
 * A single directory's placement on the treemap canvas, captured during
 * `tree` layout. Used to (a) draw subtle boundary strokes that make the
 * folder hierarchy visible and (b) surface folder context on hover.
 */
export interface TreemapFolderRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Slash-separated logical path (not including the synthetic root). */
  path: string;
  /** Display name — last component of `path`. */
  name: string;
  /** Sum of all leaf file sizes under this folder. */
  totalSize: number;
  /** Total leaf count under this folder. */
  fileCount: number;
  /** 1 for direct children of the (collapsed) root, incrementing inward. */
  depth: number;
}

/**
 * Result of the unified `buildTreemapLayout`. Folder rects are only
 * populated when `layout === "tree"`; Size mode returns an empty array.
 */
export interface TreemapLayoutResult {
  leaves: TreemapRect[];
  folders: TreemapFolderRect[];
}

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

/**
 * Colorblind-friendly extension mapping. Every category uses one of
 * the Okabe-Ito safe colors so users with deuteranopia / protanopia
 * can still tell video apart from images apart from executables, etc.
 * Swapped in when the user enables Color-blind mode in Settings —
 * App.tsx flips `colorBlindPalette` via setColorBlindPalette(true).
 *
 * Category assignments intentionally don't overlap with each other
 * in perceived hue under any of the three common color-vision types.
 */
const EXT_COLORS_COLORBLIND: Record<string, string> = {
  // Video — vermillion (distinctive orange-red)
  ".mp4": "#d55e00", ".mkv": "#d55e00", ".avi": "#d55e00", ".mov": "#d55e00",
  ".wmv": "#d55e00", ".webm": "#d55e00", ".m4v": "#d55e00", ".flv": "#d55e00",
  ".ts": "#d55e00",
  // Audio — reddish purple
  ".mp3": "#cc79a7", ".flac": "#cc79a7", ".wav": "#cc79a7",
  ".aac": "#cc79a7", ".m4a": "#cc79a7", ".wma": "#cc79a7", ".ogg": "#cc79a7",
  // Images — bluish green
  ".jpg": "#009e73", ".jpeg": "#009e73", ".png": "#009e73",
  ".gif": "#009e73", ".webp": "#009e73", ".svg": "#009e73",
  ".psd": "#009e73", ".raw": "#009e73", ".heic": "#009e73", ".bmp": "#009e73",
  ".tif": "#009e73", ".tiff": "#009e73", ".ico": "#009e73",
  // Archives — orange
  ".zip": "#e69f00", ".rar": "#e69f00", ".7z": "#e69f00",
  ".tar": "#e69f00", ".gz": "#e69f00", ".bz2": "#e69f00", ".xz": "#e69f00",
  ".zst": "#e69f00",
  // Disk images — dark orange
  ".iso": "#b8760b", ".img": "#b8760b", ".vhd": "#b8760b", ".vhdx": "#b8760b",
  ".vmdk": "#b8760b", ".wim": "#b8760b",
  // Executables & binaries — vermillion (shared with video — OK because extensions differ in context)
  ".exe": "#a74200", ".msi": "#a74200", ".msix": "#a74200", ".appx": "#a74200",
  // System libraries — reddish purple dark
  ".dll": "#8a4668", ".sys": "#8a4668", ".drv": "#8a4668", ".ocx": "#8a4668",
  // Windows system files — blue
  ".dat": "#0072b2", ".cat": "#0072b2", ".mum": "#0072b2", ".manifest": "#0072b2",
  ".mui": "#0072b2", ".nls": "#0072b2", ".inf": "#0072b2",
  // Windows caches & indexes — dark blue
  ".cab": "#003f73", ".msp": "#003f73", ".msu": "#003f73",
  ".efi": "#003f73", ".etl": "#003f73",
  // Database & data files — sky blue
  ".db": "#56b4e9", ".sqlite": "#56b4e9", ".mdb": "#56b4e9",
  ".ldf": "#56b4e9", ".mdf": "#56b4e9", ".bak": "#56b4e9",
  // Documents — blue (shared w/ .dat — different contexts)
  ".pdf": "#0072b2", ".doc": "#0072b2", ".docx": "#0072b2",
  ".xls": "#0072b2", ".xlsx": "#0072b2", ".ppt": "#0072b2", ".pptx": "#0072b2",
  ".rtf": "#0072b2", ".odt": "#0072b2",
  // Code — yellow (distinct from bluish-green and orange)
  ".js": "#f0e442", ".jsx": "#f0e442", ".mjs": "#f0e442",
  ".tsx": "#0072b2", ".py": "#009e73", ".rs": "#d55e00",
  ".go": "#56b4e9", ".java": "#d55e00", ".cs": "#cc79a7", ".cpp": "#0072b2",
  ".c": "#0072b2", ".h": "#0072b2",
  // Config & data — neutral gray (same as default)
  ".json": "#78716c", ".xml": "#78716c", ".yaml": "#78716c", ".yml": "#78716c",
  ".toml": "#78716c", ".ini": "#78716c", ".cfg": "#78716c", ".conf": "#78716c",
  ".reg": "#78716c",
  // Logs & temp — dark gray
  ".log": "#57534e", ".tmp": "#57534e", ".temp": "#57534e",
  // Fonts — reddish purple
  ".ttf": "#cc79a7", ".otf": "#cc79a7", ".woff": "#cc79a7", ".woff2": "#cc79a7",
  // Virtual memory / swap — dark blue
  ".pagefile": "#003f73", ".hiberfil": "#003f73",
};

/**
 * Module-scoped flag that toggles between the default extension
 * palette and the Okabe-Ito colorblind palette. Flipped at app start
 * from persisted settings and whenever the user toggles the setting.
 */
let colorBlindPalette = false;

export function setColorBlindPalette(on: boolean): void {
  colorBlindPalette = on;
}

export function colorForExtension(ext: string): string {
  const table = colorBlindPalette ? EXT_COLORS_COLORBLIND : EXT_COLORS;
  return table[ext.toLowerCase()] ?? DEFAULT_COLOR;
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
  layout: TreemapLayout = "size",
): TreemapRect[] {
  return buildTreemapLayout(files, width, height, areaMode, layout).leaves;
}

/**
 * Preferred entry point — returns leaf rects (always) and folder rects
 * (only in Tree layout). The renderer uses folder rects to draw boundary
 * strokes and to surface folder context on hover.
 */
export function buildTreemapLayout(
  files: ScanFileRecord[],
  width: number,
  height: number,
  areaMode: TreemapAreaMode = "compressed",
  layout: TreemapLayout = "size",
): TreemapLayoutResult {
  if (files.length === 0 || width <= 0 || height <= 0) {
    return { leaves: [], folders: [] };
  }

  if (layout === "tree") {
    return buildTreeLayout(files, width, height, areaMode);
  }

  // Square-root compression: reduces the visual dominance of very large files
  // while preserving relative ordering. A 48GB file vs 100MB goes from 480:1
  // to ~22:1 — still clearly larger, but doesn't eat the entire canvas.
  const sorted = [...files].sort((a, b) => b.size - a.size);
  const weighted = sorted.map((file) => ({
    file,
    weight: areaMode === "exact" ? file.size : Math.sqrt(file.size),
  }));
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight === 0) return { leaves: [], folders: [] };

  const rects: TreemapRect[] = [];
  squarify(weighted, { x: 0, y: 0, w: width, h: height }, totalWeight, rects);
  return { leaves: rects, folders: [] };
}

// ── Tree layout (WinDirStat-style folder grouping) ─────────────────────────

const PATH_SEP = /[\\/]+/;

interface TreeNode {
  /** Display name for this node — last component of its path. */
  name: string;
  /** Logical path from the pruned tree root (slash-separated). Empty for the root. */
  path: string;
  /** Sum of all leaf file sizes under this node. */
  totalSize: number;
  /** Total leaf count under this node. */
  fileCount: number;
  /** True when this node represents a single file. */
  isFile: boolean;
  /** Set when isFile=true — the original file record. */
  file?: ScanFileRecord;
  /** Child nodes keyed by name for fast lookup during construction. */
  children: Map<string, TreeNode>;
}

/**
 * Build a hierarchical layout where files cluster inside their directory's
 * rectangle. Recursively squarifies — each directory gets an area
 * proportional to its total size, then its children fill that area.
 *
 * Note: we always use square-root compression here (not the raw size)
 * because at the directory level a single huge subtree can still dominate
 * the parent's area. The compression keeps small folders visible.
 */
function buildTreeLayout(
  files: ScanFileRecord[],
  width: number,
  height: number,
  _areaMode: TreemapAreaMode,
): TreemapLayoutResult {
  if (files.length === 0) return { leaves: [], folders: [] };

  const root = buildTree(files);
  const leaves: TreemapRect[] = [];
  const folders: TreemapFolderRect[] = [];
  squarifyTree(root, { x: 0, y: 0, w: width, h: height }, 0, leaves, folders);
  return { leaves, folders };
}

function buildTree(files: ScanFileRecord[]): TreeNode {
  const root: TreeNode = {
    name: "<root>",
    path: "",
    totalSize: 0,
    fileCount: 0,
    isFile: false,
    children: new Map(),
  };

  for (const file of files) {
    const components = file.parentPath.split(PATH_SEP).filter(Boolean);
    let current = root;
    let cumulativePath = "";

    // Walk down (or create) directory nodes corresponding to the file's
    // parent path. We bubble totalSize/fileCount up at the end in a
    // single pass.
    for (const comp of components) {
      cumulativePath = cumulativePath ? `${cumulativePath}/${comp}` : comp;
      let child = current.children.get(comp);
      if (!child) {
        child = {
          name: comp,
          path: cumulativePath,
          totalSize: 0,
          fileCount: 0,
          isFile: false,
          children: new Map(),
        };
        current.children.set(comp, child);
      }
      current = child;
    }

    // Drop the file as a leaf under its parent dir. Use a unique key in
    // case two files in the same dir have identical names (shouldn't
    // happen on disk but defend anyway).
    const leafKey = current.children.has(file.name)
      ? `${file.name}\u0000${file.path}`
      : file.name;
    current.children.set(leafKey, {
      name: file.name,
      path: file.path,
      totalSize: file.size,
      fileCount: 1,
      isFile: true,
      file,
      children: new Map(),
    });
  }

  // Bubble totalSize + fileCount bottom-up.
  computeAggregates(root);

  // Collapse single-child chains at the top — if every file is in
  // C:\Users\foo\... we don't want three nested rectangles for C:, Users,
  // foo before the meaningful content. Walk down through any node that
  // has exactly one non-file child until we hit a branch point.
  //
  // The pruned node becomes the logical root: its path is used as the
  // base for relative folder paths shown to the user.
  let pruned: TreeNode = root;
  while (pruned.children.size === 1) {
    const onlyChild = pruned.children.values().next().value!;
    if (onlyChild.isFile) break;
    pruned = onlyChild;
  }
  return pruned;
}

function computeAggregates(node: TreeNode): { size: number; count: number } {
  if (node.isFile) return { size: node.totalSize, count: 1 };
  let size = 0;
  let count = 0;
  for (const child of node.children.values()) {
    const sub = computeAggregates(child);
    size += sub.size;
    count += sub.count;
  }
  node.totalSize = size;
  node.fileCount = count;
  return { size, count };
}

function squarifyTree(
  node: TreeNode,
  bounds: Rect,
  depth: number,
  leaves: TreemapRect[],
  folders: TreemapFolderRect[],
): void {
  if (bounds.w < 1 || bounds.h < 1 || node.totalSize <= 0) return;

  if (node.isFile && node.file) {
    leaves.push({
      ...bounds,
      file: node.file,
      color: colorForExtension(node.file.extension),
    });
    return;
  }

  // Record this folder's bounds — except for the synthetic pruned root
  // at depth 0, which covers the whole canvas and isn't useful to outline.
  if (depth > 0 && node.name !== "<root>") {
    folders.push({
      x: bounds.x,
      y: bounds.y,
      w: bounds.w,
      h: bounds.h,
      path: node.path,
      name: node.name,
      totalSize: node.totalSize,
      fileCount: node.fileCount,
      depth,
    });
  }

  const children = Array.from(node.children.values()).filter(
    (c) => c.totalSize > 0,
  );
  if (children.length === 0) return;

  // Use the same sqrt-compression at every level so deeply-nested big files
  // don't completely swallow their containing folder.
  const sorted = children.slice().sort((a, b) => b.totalSize - a.totalSize);
  const weighted: Weighted<TreeNode>[] = sorted.map((child) => ({
    item: child,
    weight: Math.sqrt(child.totalSize),
  }));
  const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
  if (totalWeight === 0) return;

  const childPlacements: Array<{ item: TreeNode; bounds: Rect }> = [];
  squarifyGeneric(weighted, bounds, totalWeight, childPlacements);

  for (const { item, bounds: childBounds } of childPlacements) {
    squarifyTree(item, childBounds, depth + 1, leaves, folders);
  }
}

// ── Generic squarify (used by both flat and tree layouts) ──────────────────

interface Weighted<T> {
  item: T;
  weight: number;
}

function squarifyGeneric<T>(
  items: Weighted<T>[],
  bounds: Rect,
  totalWeight: number,
  out: Array<{ item: T; bounds: Rect }>,
): void {
  if (items.length === 0 || bounds.w <= 0 || bounds.h <= 0) return;

  if (items.length === 1) {
    out.push({ item: items[0]!.item, bounds });
    return;
  }

  const isWide = bounds.w >= bounds.h;
  const sideLen = isWide ? bounds.h : bounds.w;
  const totalArea = bounds.w * bounds.h;

  let rowItems: Weighted<T>[] = [];
  let rowWeight = 0;
  let bestAspect = Infinity;
  let splitIndex = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const nextRowWeight = rowWeight + item.weight;
    const nextRowLen = (nextRowWeight / totalWeight) * (isWide ? bounds.w : bounds.h);

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

  const rowFraction = rowWeight / totalWeight;
  const rowLen = isWide ? bounds.w * rowFraction : bounds.h * rowFraction;

  let offset = 0;
  for (const item of rowItems) {
    const itemFraction = rowWeight > 0 ? item.weight / rowWeight : 1 / rowItems.length;
    const itemLen = sideLen * itemFraction;

    const itemBounds: Rect = isWide
      ? { x: bounds.x, y: bounds.y + offset, w: rowLen, h: itemLen }
      : { x: bounds.x + offset, y: bounds.y, w: itemLen, h: rowLen };

    out.push({ item: item.item, bounds: itemBounds });
    offset += itemLen;
  }

  const remaining = items.slice(splitIndex);
  if (remaining.length > 0) {
    const newBounds: Rect = isWide
      ? { x: bounds.x + rowLen, y: bounds.y, w: bounds.w - rowLen, h: bounds.h }
      : { x: bounds.x, y: bounds.y + rowLen, w: bounds.w, h: bounds.h - rowLen };
    squarifyGeneric(remaining, newBounds, totalWeight - rowWeight, out);
  }
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
