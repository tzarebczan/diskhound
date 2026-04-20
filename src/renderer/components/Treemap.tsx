import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import type { PathActionResult, ScanFileRecord } from "../../shared/contracts";
import { formatBytes, humanAge } from "../lib/format";
import { useSafeDeleteOnly } from "../lib/hooks";
import { nativeApi } from "../nativeApi";
import { toast } from "./Toasts";
import {
  buildTreemapLayout,
  type TreemapAreaMode,
  type TreemapFolderRect,
  type TreemapLayout,
  type TreemapRect,
} from "../lib/treemap";

interface Props {
  files: ScanFileRecord[];
  areaMode?: TreemapAreaMode;
  /** Flat squarified by size (default) vs. hierarchical by folder. */
  layout?: TreemapLayout;
  /** Draw subtle folder boundary strokes (Tree layout only). */
  showFolderOutlines?: boolean;
  onFileClick?: (file: ScanFileRecord) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  file: ScanFileRecord;
}

// 0 = edge-to-edge (WinDirStat style). The cushion shading provides visual
// separation without needing a gap between rects.
const GAP = 0;

export function Treemap({
  files,
  areaMode = "compressed",
  layout = "size",
  showFolderOutlines = true,
  onFileClick,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rectsRef = useRef<TreemapRect[]>([]);
  const foldersRef = useRef<TreemapFolderRect[]>([]);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    file: ScanFileRecord;
    folder?: TreemapFolderRect;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setDims({ w: Math.floor(width), h: Math.floor(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Close context menu on click anywhere
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [contextMenu]);

  // Render treemap
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || dims.w === 0 || dims.h === 0) return;

    const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;

    canvas.width = dims.w * dpr;
    canvas.height = dims.h * dpr;
    canvas.style.width = `${dims.w}px`;
    canvas.style.height = `${dims.h}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, dims.w, dims.h);

    const { leaves: rects, folders } = buildTreemapLayout(files, dims.w, dims.h, areaMode, layout);
    rectsRef.current = rects;
    foldersRef.current = folders;

    for (const r of rects) {
      const x = r.x + GAP;
      const y = r.y + GAP;
      const w = Math.max(r.w - GAP * 2, 0);
      const h = Math.max(r.h - GAP * 2, 0);

      if (w < 1 || h < 1) continue;

      // Fill with category color
      ctx.fillStyle = r.color;
      ctx.fillRect(x, y, w, h);

      // Cushion shading: radial gradient from top-left gives each rect a
      // "puffy" 3D look (à la WinDirStat). Skip for very small rects where
      // the gradient cost isn't worth it.
      if (w >= 6 && h >= 6) {
        const radius = Math.max(w, h) * 0.9;
        const grad = ctx.createRadialGradient(
          x + w * 0.25, y + h * 0.2, 0,
          x + w * 0.25, y + h * 0.2, radius,
        );
        grad.addColorStop(0, "rgba(255,255,255,0.28)");
        grad.addColorStop(0.5, "rgba(255,255,255,0.04)");
        grad.addColorStop(1, "rgba(0,0,0,0.30)");
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, w, h);
      } else {
        // Flat bevel fallback for tiny rects
        ctx.fillStyle = "rgba(255,255,255,0.08)";
        ctx.fillRect(x, y, w, 1);
        ctx.fillStyle = "rgba(0,0,0,0.15)";
        ctx.fillRect(x, y + h - 1, w, 1);
      }

      // Labels — render file name + size with text shadow for readability
      const pad = 4;
      const maxLabelW = w - pad * 2;

      if (w > 36 && h > 16 && maxLabelW > 20) {
        const fontSize = Math.min(12, Math.max(8, Math.min(w / 10, h / 3)));
        ctx.font = `500 ${fontSize}px "JetBrains Mono", monospace`;
        ctx.textBaseline = "top";

        // Truncate name to fit
        const name = r.file.name;
        let label = name;
        let measured = ctx.measureText(label).width;
        if (measured > maxLabelW) {
          const charW = measured / label.length;
          const maxChars = Math.floor(maxLabelW / charW) - 1;
          label = maxChars > 2 ? name.slice(0, maxChars) + "\u2026" : "";
        }

        if (label) {
          // Dark shadow behind text for contrast
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillText(label, x + pad + 1, y + pad + 1, maxLabelW);
          ctx.fillStyle = "rgba(255,255,255,0.9)";
          ctx.fillText(label, x + pad, y + pad, maxLabelW);
        }

        // Size label on second line if room
        if (h > fontSize + pad * 2 + 10) {
          const sizeFont = Math.min(10, Math.max(7, fontSize - 2));
          ctx.font = `400 ${sizeFont}px "JetBrains Mono", monospace`;
          const sizeLabel = formatBytes(r.file.size);
          ctx.fillStyle = "rgba(0,0,0,0.4)";
          ctx.fillText(sizeLabel, x + pad + 1, y + pad + fontSize + 2 + 1, maxLabelW);
          ctx.fillStyle = "rgba(255,255,255,0.6)";
          ctx.fillText(sizeLabel, x + pad, y + pad + fontSize + 2, maxLabelW);
        }
      }
    }

    // Folder delineation pass (Tree layout only). Drawn AFTER leaves so
    // the strokes appear on top of every file. We filter to "meaningful"
    // folders — those covering ≥0.5% of the canvas and containing 2+
    // children — to avoid outlining every tiny leaf-dir, which becomes
    // noise. Depth modulates width + alpha so the top-level structure
    // pops without drowning out the inner detail.
    if (layout === "tree" && showFolderOutlines && foldersRef.current.length > 0) {
      const minArea = dims.w * dims.h * 0.005;
      // Draw shallower folders last (over deeper) so their thicker strokes
      // sit on top of the thinner inner lines.
      const sortedFolders = foldersRef.current
        .filter((f) => f.w * f.h >= minArea && f.depth <= 4)
        .sort((a, b) => b.depth - a.depth);

      for (const f of sortedFolders) {
        // Depth 1: 1.6px @ 0.55, depth 2: 1.1px @ 0.4, depth 3: 0.75px @ 0.25,
        // depth 4+: skipped. Values tuned empirically — enough to see
        // structure, not enough to look busy.
        const depthFactor = Math.max(0, 5 - f.depth);
        const lineWidth = 0.4 + depthFactor * 0.3;
        const alpha = 0.1 + depthFactor * 0.11;
        ctx.strokeStyle = `rgba(0, 0, 0, ${alpha})`;
        ctx.lineWidth = lineWidth;
        // Inset by half the stroke so the line stays inside the folder,
        // not straddling its boundary and bleeding into the neighbor.
        const inset = lineWidth / 2;
        ctx.strokeRect(
          f.x + inset,
          f.y + inset,
          Math.max(0, f.w - lineWidth),
          Math.max(0, f.h - lineWidth),
        );
      }
    }
  }, [files, dims, areaMode, layout, showFolderOutlines]);

  const hitTest = useCallback((e: MouseEvent): ScanFileRecord | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = rectsRef.current.find(
      (r) => mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h,
    );
    return hit?.file ?? null;
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const file = hitTest(e);
    if (file) {
      // Keep tooltip at a fixed offset from cursor, clamped to viewport
      const tx = Math.min(e.clientX + 14, window.innerWidth - 380);
      const ty = Math.min(e.clientY + 14, window.innerHeight - 80);

      // Tree-layout bonus: show the deepest folder containing this file
      // so the tooltip says "in folder <name> — X GB · N files". Only
      // meaningful in Tree mode; in Size mode adjacent files are
      // unrelated so the context is misleading.
      let folder: TreemapFolderRect | undefined;
      if (layout === "tree" && foldersRef.current.length > 0) {
        const canvas = canvasRef.current;
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          let bestArea = Infinity;
          for (const f of foldersRef.current) {
            if (mx >= f.x && mx <= f.x + f.w && my >= f.y && my <= f.y + f.h) {
              const area = f.w * f.h;
              if (area < bestArea) {
                bestArea = area;
                folder = f;
              }
            }
          }
        }
      }

      setTooltip({ x: tx, y: ty, file, folder });
    } else {
      setTooltip(null);
    }
  }, [hitTest, layout]);

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  const handleClick = useCallback((e: MouseEvent) => {
    if (!onFileClick) return;
    const file = hitTest(e);
    if (file) onFileClick(file);
  }, [onFileClick, hitTest]);

  const handleContextMenu = useCallback((e: MouseEvent) => {
    const file = hitTest(e);
    if (file) {
      e.preventDefault();
      e.stopPropagation();
      setTooltip(null);
      setContextMenu({ x: e.clientX, y: e.clientY, file });
    }
  }, [hitTest]);

  if (files.length === 0) {
    return (
      <div className="treemap-container" ref={containerRef}>
        <div className="treemap-empty">
          <div className="treemap-empty-icon">&#x25A6;</div>
          <div>Run a scan to see the treemap</div>
        </div>
      </div>
    );
  }

  return (
    <div className="treemap-container" ref={containerRef}>
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        style={{ cursor: tooltip ? "pointer" : "default" }}
      />

      {/* ── Tooltip ── */}
      {tooltip && !contextMenu && (
        <div
          className="treemap-tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <span className="treemap-tooltip-size">{formatBytes(tooltip.file.size)}</span>
          <span className="treemap-tooltip-name">{tooltip.file.name}</span>
          <div className="treemap-tooltip-path">{tooltip.file.path}</div>
          <div className="treemap-tooltip-meta">Modified {humanAge(tooltip.file.modifiedAt)}</div>
          {tooltip.folder && (
            <div className="treemap-tooltip-folder">
              <span className="treemap-tooltip-folder-label">in folder</span>
              <span className="treemap-tooltip-folder-name">{tooltip.folder.name}</span>
              <span className="treemap-tooltip-folder-stats">
                {formatBytes(tooltip.folder.totalSize)} · {tooltip.folder.fileCount.toLocaleString()} files
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── Context Menu ── */}
      {contextMenu && (
        <TreemapContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          file={contextMenu.file}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

function TreemapContextMenu({ x, y, file, onClose }: {
  x: number;
  y: number;
  file: ScanFileRecord;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const safeDeleteOnly = useSafeDeleteOnly();

  // Adjust position so menu doesn't overflow viewport
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = x + rect.width > window.innerWidth ? x - rect.width : x;
    const ny = y + rect.height > window.innerHeight ? y - rect.height : y;
    setPos({ x: Math.max(0, nx), y: Math.max(0, ny) });
  }, [x, y]);

  const doAction = async (action: () => Promise<PathActionResult | unknown>, label: string) => {
    onClose();
    try {
      const result = await action();
      // Surface structured IPC failures (PathActionResult with ok: false)
      if (result && typeof result === "object" && "ok" in result && !(result as PathActionResult).ok) {
        toast("error", `${label} failed`, (result as PathActionResult).message);
      }
    } catch {
      toast("error", `Failed: ${label}`);
    }
  };

  return (
    <div
      ref={menuRef}
      className="treemap-ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="treemap-ctx-header">
        <div className="treemap-ctx-filename">{file.name}</div>
        <div className="treemap-ctx-filesize">{formatBytes(file.size)}</div>
      </div>
      <div className="treemap-ctx-path">{file.path}</div>
      <div className="treemap-ctx-divider" />
      <button
        className="treemap-ctx-item"
        onClick={() => void doAction(() => nativeApi.revealPath(file.path), "Reveal")}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M1.5 3.5V11.5C1.5 12.05 1.95 12.5 2.5 12.5H11.5C12.05 12.5 12.5 12.05 12.5 11.5V5.5C12.5 4.95 12.05 4.5 11.5 4.5H7L5.5 2.5H2.5C1.95 2.5 1.5 2.95 1.5 3.5Z" />
        </svg>
        Open in Explorer
      </button>
      <button
        className="treemap-ctx-item"
        onClick={() => void doAction(() => nativeApi.openPath(file.path), "Open")}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M3 1.5H11C11.55 1.5 12 1.95 12 2.5V11.5C12 12.05 11.55 12.5 11 12.5H3C2.45 12.5 2 12.05 2 11.5V2.5C2 1.95 2.45 1.5 3 1.5Z" />
          <path d="M5 7H9M7 5V9" />
        </svg>
        Open file
      </button>
      <button
        className="treemap-ctx-item"
        onClick={() => {
          onClose();
          void navigator.clipboard.writeText(file.path).then(
            () => toast("success", "Path copied", file.path),
            () => toast("error", "Couldn't copy path"),
          );
        }}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
          <rect x="4" y="4" width="8" height="9" rx="1" />
          <path d="M4 4V3C4 2.45 4.45 2 5 2H9C9.55 2 10 2.45 10 3V4" />
        </svg>
        Copy path
      </button>
      <div className="treemap-ctx-divider" />
      <button
        className="treemap-ctx-item"
        onClick={() => {
          onClose();
          void (async () => {
            const dest = await nativeApi.pickMoveDestination();
            if (!dest) return;
            const result = await nativeApi.easyMove(file.path, dest);
            if (result?.ok) {
              toast("success", "Moved & linked", result.message);
            } else {
              toast("error", "Easy Move failed", result?.message ?? "Unknown error");
            }
          })();
        }}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M2 7H10M7.5 4.5L10 7L7.5 9.5" />
          <path d="M12 3V11" strokeDasharray="1.5 1.5" />
        </svg>
        Easy Move (symlink)
      </button>
      <div className="treemap-ctx-divider" />
      <button
        className="treemap-ctx-item treemap-ctx-warn"
        onClick={() => void doAction(() => nativeApi.trashPath(file.path), "Trash")}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M2.5 4.5H11.5L10.5 12.5H3.5L2.5 4.5Z" />
          <path d="M1.5 4.5H12.5" />
          <path d="M5 2.5H9" />
        </svg>
        Move to Recycle Bin
      </button>
      {!safeDeleteOnly && (
        <button
          className="treemap-ctx-item treemap-ctx-danger"
          onClick={() => {
            if (!confirm(`Permanently delete ${file.name}?\n\nThis cannot be undone.`)) return;
            void doAction(() => nativeApi.permanentlyDeletePath(file.path), "Delete");
          }}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" />
          </svg>
          Delete permanently
        </button>
      )}
    </div>
  );
}
