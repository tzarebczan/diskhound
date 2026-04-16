import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

import type { DirectoryHotspot, ScanFileRecord, ScanSnapshot } from "../../shared/contracts";
import { formatBytes, formatCount } from "../lib/format";
import { usePathActions } from "../lib/hooks";
import { nativeApi } from "../nativeApi";

interface Props {
  snapshot: ScanSnapshot;
}

// ── Path helpers ────────────────────────────────────────────

const SEP = /[\\/]/;

/** Get display name for a path — "C:\" for roots, last segment otherwise */
function displayName(fullPath: string, rootPath: string | null): string {
  if (fullPath === rootPath) {
    // Show drive root nicely: "C:" or "C:\" → "C:\"
    if (/^[A-Za-z]:[\\/]?$/.test(fullPath)) {
      return fullPath.charAt(0) + ":\\";
    }
    return fullPath;
  }
  const parts = fullPath.split(SEP).filter(Boolean);
  return parts[parts.length - 1] || fullPath;
}

/** Get the parent path */
function parentPath(p: string): string | null {
  // Drive root — no parent
  if (/^[A-Za-z]:[\\/]?$/.test(p)) return null;
  if (p === "/") return null;

  const trimmed = p.replace(/[\\/]+$/, "");
  const lastSep = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (lastSep <= 0) return null;

  const parent = trimmed.slice(0, lastSep);
  // If we'd end up at "C:", normalize to "C:\"
  if (/^[A-Za-z]:$/.test(parent)) return parent + "\\";
  return parent;
}

/** Build breadcrumb segments from root to current */
function buildBreadcrumbs(currentPath: string, rootPath: string): { label: string; path: string }[] {
  const crumbs: { label: string; path: string }[] = [];
  let p: string | null = currentPath;

  while (p) {
    const label = p === rootPath
      ? ((/^[A-Za-z]:[\\/]?$/.test(p)) ? p.charAt(0) + ":\\" : p)
      : displayName(p, rootPath);
    crumbs.unshift({ label, path: p });
    if (p === rootPath) break;
    p = parentPath(p);
    // Safety: don't go above root
    if (p && !currentPath.startsWith(p)) break;
  }

  return crumbs;
}

/** Find direct children of parentDir in the directory list */
function getDirectChildren(dirs: DirectoryHotspot[], parentDir: string): DirectoryHotspot[] {
  const prefix = parentDir.replace(/[\\/]+$/, "") + "\\";

  return dirs.filter((d) => {
    if (d.path === parentDir) return false;
    // Must start with parent + separator
    const normalized = d.path.replace(/\//g, "\\");
    const normalizedPrefix = prefix.replace(/\//g, "\\");
    if (!normalized.startsWith(normalizedPrefix)) return false;
    // Must be a direct child (no more separators in the remainder)
    const rest = normalized.slice(normalizedPrefix.length);
    return !rest.includes("\\");
  });
}

// ── Component ───────────────────────────────────────────────

export function FolderList({ snapshot }: Props) {
  const rootPath = snapshot.rootPath ?? "";
  const dirs = snapshot.hottestDirectories;
  const allFiles = snapshot.largestFiles;

  const [currentPath, setCurrentPath] = useState(rootPath);
  const { busy, runAction, handleEasyMove } = usePathActions();
  const [showOtherFiles, setShowOtherFiles] = useState(false);

  // Reset navigation when scan root changes
  useEffect(() => {
    if (rootPath) { setCurrentPath(rootPath); setShowOtherFiles(false); }
  }, [rootPath]);

  // Collapse "other" when navigating
  useEffect(() => {
    setShowOtherFiles(false);
  }, [currentPath]);

  // Find current directory's record
  const currentDir = useMemo(
    () => dirs.find((d) => d.path === currentPath),
    [dirs, currentPath],
  );

  // Direct children sorted by size
  const children = useMemo(
    () => getDirectChildren(dirs, currentPath).sort((a, b) => b.size - a.size),
    [dirs, currentPath],
  );

  // Calculate "other" — space not accounted for by listed children
  const childrenTotal = useMemo(
    () => children.reduce((sum, c) => sum + c.size, 0),
    [children],
  );
  const parentSize = currentDir?.size ?? 0;
  const otherSize = Math.max(0, parentSize - childrenTotal);

  // Files inside the current directory tree (from the global top-files sample).
  // This is a subset — only the largest files tracked by the scanner appear here.
  const looseFiles = useMemo(() => {
    const normalizedCurrent = currentPath.replace(/[\\/]+$/, "").replace(/\//g, "\\");
    const childPaths = new Set(children.map((c) => c.path.replace(/\//g, "\\")));
    return allFiles.filter((f) => {
      const normalizedParent = f.parentPath.replace(/[\\/]+$/, "").replace(/\//g, "\\");
      // Direct files in this directory
      if (normalizedParent === normalizedCurrent) return true;
      // Files deeper, but NOT inside a tracked child directory
      if (!normalizedParent.startsWith(normalizedCurrent + "\\")) return false;
      // Check if this file belongs to an already-listed child dir
      for (const cp of childPaths) {
        if (normalizedParent === cp || normalizedParent.startsWith(cp + "\\")) return false;
      }
      return true;
    }).sort((a, b) => b.size - a.size);
  }, [allFiles, currentPath, children]);

  // Check if a directory has children (for drill-in affordance)
  const hasChildren = useCallback(
    (dirPath: string) => dirs.some((d) => d.path !== dirPath && d.path.startsWith(dirPath.replace(/[\\/]+$/, "") + "\\")),
    [dirs],
  );

  const breadcrumbs = useMemo(
    () => buildBreadcrumbs(currentPath, rootPath),
    [currentPath, rootPath],
  );

  if (!rootPath) {
    return (
      <div className="folder-explorer">
        <div className="empty-view"><span>Run a scan to explore folders</span></div>
      </div>
    );
  }

  return (
    <div className="folder-explorer">
      {/* ── Breadcrumb bar ── */}
      <div className="folder-breadcrumb-bar">
        {currentPath !== rootPath && (
          <button
            className="folder-back-btn"
            onClick={() => {
              const p = parentPath(currentPath);
              if (p && currentPath !== rootPath) setCurrentPath(p);
            }}
            title="Go up"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8.5 3L4.5 7L8.5 11" />
            </svg>
          </button>
        )}
        <div className="folder-breadcrumbs">
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.path}>
              {i > 0 && <span className="folder-crumb-sep">&rsaquo;</span>}
              <button
                className={`folder-crumb ${crumb.path === currentPath ? "active" : ""}`}
                onClick={() => setCurrentPath(crumb.path)}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </div>
        <div className="folder-breadcrumb-spacer" />
        {currentDir && (
          <div className="folder-breadcrumb-size">
            <span className="folder-breadcrumb-total">{formatBytes(parentSize)}</span>
            <span className="folder-breadcrumb-count">
              {formatCount(currentDir.fileCount)} files
            </span>
          </div>
        )}
        <button
          className="folder-open-btn"
          onClick={() => void runAction(currentPath, () => nativeApi.openPath(currentPath))}
          title="Open in Explorer"
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M1.5 3.5V11.5C1.5 12.05 1.95 12.5 2.5 12.5H11.5C12.05 12.5 12.5 12.05 12.5 11.5V5.5C12.5 4.95 12.05 4.5 11.5 4.5H7L5.5 2.5H2.5C1.95 2.5 1.5 2.95 1.5 3.5Z" />
          </svg>
        </button>
      </div>

      {/* ── Directory list ── */}
      <div className="folder-list-scroll">
        {children.length === 0 && otherSize === 0 ? (
          <div className="empty-view" style={{ paddingTop: 48 }}>
            <span>No subdirectories tracked at this level</span>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              Try scanning with a higher directory limit in Settings
            </span>
          </div>
        ) : (
          <>
            {children.map((child) => (
              <FolderRow
                key={child.path}
                dir={child}
                parentSize={parentSize}
                rootPath={rootPath}
                canDrillIn={hasChildren(child.path)}
                isBusy={busy.has(child.path)}
                onNavigate={() => setCurrentPath(child.path)}
                onReveal={() => void runAction(child.path, () => nativeApi.revealPath(child.path))}
                onOpen={() => void runAction(child.path, () => nativeApi.openPath(child.path))}
                onEasyMove={() => void handleEasyMove(child.path)}
              />
            ))}
            {(otherSize > 0 || looseFiles.length > 0) && (
              <>
                <div
                  className="folder-row folder-row-other folder-row-clickable"
                  onClick={() => setShowOtherFiles(!showOtherFiles)}
                >
                  <div className="folder-row-icon folder-row-icon-other">
                    <svg
                      width="12" height="12" viewBox="0 0 12 12" fill="none"
                      stroke="currentColor" strokeWidth="1.5"
                      style={{
                        transition: "transform 0.15s",
                        transform: showOtherFiles ? "rotate(90deg)" : "rotate(0deg)",
                      }}
                    >
                      <path d="M4.5 2L8.5 6L4.5 10" />
                    </svg>
                  </div>
                  <div className="folder-row-info">
                    <div className="folder-row-name folder-row-name-other">
                      {looseFiles.length > 0
                        ? `${formatCount(looseFiles.length)} largest files here (not in subfolders above)`
                        : "Other files & untracked subfolders"}
                    </div>
                  </div>
                  <div className="folder-row-bar-col">
                    <div className="folder-row-bar">
                      <div
                        className="folder-row-bar-fill other"
                        style={{ width: `${parentSize > 0 ? (otherSize / parentSize) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                  <div className="folder-row-size folder-row-size-other">{formatBytes(otherSize)}</div>
                  <div className="folder-row-meta-col" />
                  <div className="folder-row-actions-col" />
                </div>
                {showOtherFiles && looseFiles.length > 0 && (
                  <div className="folder-loose-files">
                    {looseFiles.map((f) => (
                      <LooseFileRow
                        key={f.path}
                        file={f}
                        isBusy={busy.has(f.path)}
                        onReveal={() => void runAction(f.path, () => nativeApi.revealPath(f.path))}
                        onOpen={() => void runAction(f.path, () => nativeApi.openPath(f.path))}
                        onEasyMove={() => void handleEasyMove(f.path)}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Row component ───────────────────────────────────────────

function FolderRow(props: {
  dir: DirectoryHotspot;
  parentSize: number;
  rootPath: string;
  canDrillIn: boolean;
  isBusy: boolean;
  onNavigate: () => void;
  onReveal: () => void;
  onOpen: () => void;
  onEasyMove: () => void;
}) {
  const { dir, parentSize, rootPath, canDrillIn, isBusy, onNavigate, onReveal, onOpen, onEasyMove } = props;
  const pct = parentSize > 0 ? (dir.size / parentSize) * 100 : 0;
  const name = displayName(dir.path, rootPath);

  return (
    <div
      className={`folder-row ${canDrillIn ? "folder-row-clickable" : ""}`}
      onClick={canDrillIn ? onNavigate : undefined}
    >
      <div className="folder-row-icon">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path
            d="M2 4V13C2 13.55 2.45 14 3 14H13C13.55 14 14 13.55 14 13V6C14 5.45 13.55 5 13 5H8L6.5 3H3C2.45 3 2 3.45 2 4Z"
            fill="currentColor"
            opacity="0.25"
            stroke="currentColor"
            strokeWidth="1"
          />
        </svg>
      </div>
      <div className="folder-row-info">
        <div className="folder-row-name">
          {name}
          {canDrillIn && (
            <svg className="folder-row-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3">
              <path d="M3.5 2L7 5L3.5 8" />
            </svg>
          )}
        </div>
      </div>
      <div className="folder-row-bar-col">
        <div className="folder-row-bar">
          <div
            className={`folder-row-bar-fill ${pct > 50 ? "hot" : pct > 20 ? "warm" : "cool"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <div className="folder-row-size">{formatBytes(dir.size)}</div>
      <div className="folder-row-meta-col">
        <span className="folder-row-file-count">{formatCount(dir.fileCount)}</span>
        <span className="folder-row-pct">{pct.toFixed(1)}%</span>
      </div>
      <div className="folder-row-actions-col">
        <button
          className="action-btn"
          disabled={isBusy}
          onClick={(e) => { e.stopPropagation(); onEasyMove(); }}
        >
          Move
        </button>
        <button
          className="action-btn"
          disabled={isBusy}
          onClick={(e) => { e.stopPropagation(); onReveal(); }}
        >
          Reveal
        </button>
        <button
          className="action-btn"
          disabled={isBusy}
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
        >
          Open
        </button>
      </div>
    </div>
  );
}

// ── Loose file row (inside "Other" expansion) ──────────────

function LooseFileRow(props: {
  file: ScanFileRecord;
  isBusy: boolean;
  onReveal: () => void;
  onOpen: () => void;
  onEasyMove: () => void;
}) {
  const { file, isBusy, onReveal, onOpen, onEasyMove } = props;

  return (
    <div className="loose-file-row">
      <div className="loose-file-icon">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.5">
          <path d="M3 1.5H8.5L11 4V12.5H3V1.5Z" />
          <path d="M8.5 1.5V4H11" />
        </svg>
      </div>
      <div className="loose-file-info">
        <span className="loose-file-name">{file.name}</span>
        <span className="loose-file-ext">{file.extension}</span>
      </div>
      <div className="loose-file-size">{formatBytes(file.size)}</div>
      <div className="loose-file-actions">
        <button className="action-btn" disabled={isBusy} onClick={onEasyMove}>Move</button>
        <button className="action-btn" disabled={isBusy} onClick={onReveal}>Reveal</button>
        <button className="action-btn" disabled={isBusy} onClick={onOpen}>Open</button>
      </div>
    </div>
  );
}
