import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

import type { ScanFileRecord, ScanSnapshot } from "../../shared/contracts";
import { formatBytes, formatCount } from "../lib/format";
import { usePathActions } from "../lib/hooks";
import { nativeApi } from "../nativeApi";
import { FileIcon } from "./FileIcon";

interface Props {
  snapshot: ScanSnapshot;
}

/**
 * A direct-child folder under the currently-browsed path, with an
 * aggregate size + file count rolled up from the persisted index.
 * Lighter than DirectoryHotspot because we don't need depth metadata
 * at this level.
 */
interface FolderChild {
  path: string;
  size: number;
  fileCount: number;
}

// Render caps — the persisted index can yield thousands of direct
// children on a huge folder, and Preact keeled over at ~4 GB RAM in
// the wild when rendering them all at once. We surface the top-N
// and show a footer explaining how many were trimmed.
const MAX_DIRS_RENDERED = 200;
const MAX_FILES_RENDERED = 200;

// ── Path helpers ────────────────────────────────────────────

const SEP = /[\\/]/;

/** Get display name for a path — "C:\" for roots, last segment otherwise. */
function displayName(fullPath: string, rootPath: string | null): string {
  if (fullPath === rootPath) {
    if (/^[A-Za-z]:[\\/]?$/.test(fullPath)) {
      return fullPath.charAt(0) + ":\\";
    }
    return fullPath;
  }
  const parts = fullPath.split(SEP).filter(Boolean);
  return parts[parts.length - 1] || fullPath;
}

function parentPath(p: string): string | null {
  if (/^[A-Za-z]:[\\/]?$/.test(p)) return null;
  if (p === "/") return null;
  const trimmed = p.replace(/[\\/]+$/, "");
  const lastSep = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (lastSep <= 0) return null;
  const parent = trimmed.slice(0, lastSep);
  if (/^[A-Za-z]:$/.test(parent)) return parent + "\\";
  return parent;
}

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
    if (p && !currentPath.startsWith(p)) break;
  }
  return crumbs;
}

// ── Component ───────────────────────────────────────────────

export function FolderList({ snapshot }: Props) {
  const rootPath = snapshot.rootPath ?? "";
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [children, setChildren] = useState<FolderChild[]>([]);
  const [looseFiles, setLooseFiles] = useState<ScanFileRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [showOtherFiles, setShowOtherFiles] = useState(false);
  const { busy, runAction, handleEasyMove } = usePathActions();

  // Reset navigation when the scan root changes (drive switch etc).
  useEffect(() => {
    if (rootPath) {
      setCurrentPath(rootPath);
      setShowOtherFiles(false);
    }
  }, [rootPath]);

  useEffect(() => {
    setShowOtherFiles(false);
  }, [currentPath]);

  // Fetch real children (size + count) from the persisted index every
  // time the user navigates. The IPC streams the gzipped NDJSON once
  // per call and rolls up — typically 1–3s on a drive-scale index,
  // but for most drill-ins it's a couple hundred KB and returns
  // instantly. We debounce by the currentPath dependency alone; the
  // IPC is idempotent so a stale request landing after a newer one
  // just gets ignored via the `cancelled` flag.
  useEffect(() => {
    if (!rootPath || !currentPath) {
      setChildren([]);
      setLooseFiles([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void nativeApi.getFolderChildren(rootPath, currentPath).then((res) => {
      if (cancelled) return;
      setChildren(res?.dirs ?? []);
      setLooseFiles(res?.files ?? []);
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setChildren([]);
      setLooseFiles([]);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [rootPath, currentPath]);

  // Child sizes are authoritative — no more inferring-with-0B or reading
  // from the snapshot's bounded top-N. Total of this folder = sum of
  // direct-child subtrees + loose-file totals (a very close approximation
  // of the folder's recursive size; off only by any loose files that
  // were outside the streaming top-N cap).
  const childrenTotal = useMemo(
    () => children.reduce((sum, c) => sum + c.size, 0),
    [children],
  );
  const looseTotal = useMemo(
    () => looseFiles.reduce((sum, f) => sum + f.size, 0),
    [looseFiles],
  );
  const folderTotal = childrenTotal + looseTotal;

  // Cap dirs rendered so we never ship thousands of rows into Preact.
  // Files are already returned top-N from the IPC.
  const dirsTruncated = children.length > MAX_DIRS_RENDERED;
  const dirsToRender = useMemo(
    () => dirsTruncated ? children.slice(0, MAX_DIRS_RENDERED) : children,
    [children, dirsTruncated],
  );

  const filesTruncated = looseFiles.length > MAX_FILES_RENDERED;
  const filesToRender = useMemo(
    () => filesTruncated ? looseFiles.slice(0, MAX_FILES_RENDERED) : looseFiles,
    [looseFiles, filesTruncated],
  );

  // Whether a directory is drillable — cheap heuristic: if we've seen any
  // child at all it's worth the click. The real test happens after the
  // next IPC call populates `children` with that folder's own kids.
  const hasChildren = useCallback(
    (_dirPath: string) => true,
    [],
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

  if (snapshot.status === "running") {
    return (
      <div className="folder-explorer">
        <div className="empty-view"><span>Scan in progress — folders available once it completes</span></div>
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
        {folderTotal > 0 && (
          <div className="folder-breadcrumb-size">
            <span className="folder-breadcrumb-total">{formatBytes(folderTotal)}</span>
            <span className="folder-breadcrumb-count">
              {formatCount(children.length + looseFiles.length)} items
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
        {loading && children.length === 0 && looseFiles.length === 0 ? (
          <div className="empty-view" style={{ paddingTop: 48 }}>
            <span>Loading folder contents…</span>
          </div>
        ) : children.length === 0 && looseFiles.length === 0 ? (
          <div className="empty-view" style={{ paddingTop: 48 }}>
            <span>This folder appears empty in the scan index</span>
          </div>
        ) : (
          <>
            {dirsToRender.map((child) => (
              <FolderRow
                key={child.path}
                dir={child}
                parentSize={folderTotal}
                rootPath={rootPath}
                canDrillIn={hasChildren(child.path)}
                isBusy={busy.has(child.path)}
                onNavigate={() => setCurrentPath(child.path)}
                onReveal={() => void runAction(child.path, () => nativeApi.revealPath(child.path))}
                onOpen={() => void runAction(child.path, () => nativeApi.openPath(child.path))}
                onEasyMove={() => void handleEasyMove(child.path)}
              />
            ))}
            {dirsTruncated && (
              <div className="folder-row folder-row-note">
                +{formatCount(children.length - MAX_DIRS_RENDERED)} more folders (showing top {MAX_DIRS_RENDERED} by size)
              </div>
            )}
            {looseFiles.length > 0 && (
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
                      {formatCount(looseFiles.length)} file{looseFiles.length === 1 ? "" : "s"} in this folder
                    </div>
                  </div>
                  <div className="folder-row-bar-col">
                    <div className="folder-row-bar">
                      <div
                        className="folder-row-bar-fill other"
                        style={{ width: `${folderTotal > 0 ? (looseTotal / folderTotal) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                  <div className="folder-row-size folder-row-size-other">{formatBytes(looseTotal)}</div>
                  <div className="folder-row-meta-col" />
                  <div className="folder-row-actions-col" />
                </div>
                {showOtherFiles && (
                  <div className="folder-loose-files">
                    {filesToRender.map((f) => (
                      <LooseFileRow
                        key={f.path}
                        file={f}
                        isBusy={busy.has(f.path)}
                        onReveal={() => void runAction(f.path, () => nativeApi.revealPath(f.path))}
                        onOpen={() => void runAction(f.path, () => nativeApi.openPath(f.path))}
                        onEasyMove={() => void handleEasyMove(f.path)}
                      />
                    ))}
                    {filesTruncated && (
                      <div className="folder-row folder-row-note">
                        +{formatCount(looseFiles.length - MAX_FILES_RENDERED)} more files (showing top {MAX_FILES_RENDERED} by size)
                      </div>
                    )}
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
  dir: FolderChild;
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
        <FileIcon
          path={dir.path}
          className="folder-row-icon-img"
          fallback={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M2 4V13C2 13.55 2.45 14 3 14H13C13.55 14 14 13.55 14 13V6C14 5.45 13.55 5 13 5H8L6.5 3H3C2.45 3 2 3.45 2 4Z"
                fill="currentColor" opacity="0.25" stroke="currentColor" strokeWidth="1"
              />
            </svg>
          }
        />
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
        <FileIcon
          path={file.path}
          className="loose-file-icon-img"
          fallback={
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.5">
              <path d="M3 1.5H8.5L11 4V12.5H3V1.5Z" />
              <path d="M8.5 1.5V4H11" />
            </svg>
          }
        />
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
