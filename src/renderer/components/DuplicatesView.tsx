import { useMemo, useState } from "preact/hooks";

import type {
  DuplicateAnalysis,
  DuplicateGroup,
  DuplicateScanProgress,
  ScanSnapshot,
} from "../../shared/contracts";
import { formatBytes, formatElapsed, humanAge } from "../lib/format";
import { useConfirmPermanentDelete, usePathActions } from "../lib/hooks";
import { nativeApi } from "../nativeApi";
import { FileIcon } from "./FileIcon";
import { toast } from "./Toasts";

interface Props {
  snapshot: ScanSnapshot;
  /** The most recent completed analysis for the current root, or null. */
  analysis: DuplicateAnalysis | null;
  /** Live progress for the current root's in-flight scan, or null. */
  progress: DuplicateScanProgress | null;
  /** True when a duplicate scan is currently running for the current root. */
  isScanning: boolean;
  /** Clear the persisted analysis for a given root — fires when the user
   *  starts a new scan and we want to blank the previous results. */
  onClearAnalysis: (rootPath: string) => void;
}

type SortMode = "wasted" | "copies" | "size";

export function DuplicatesView({ snapshot, analysis, progress, isScanning, onClearAnalysis }: Props) {
  const rootPath = snapshot.rootPath;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // Multi-selection for bulk actions — the set contains absolute paths
  // so it stays stable across re-sorts and group re-rendering. Cleared
  // on every sort/rescan/drive switch so selections never silently
  // outlive the groups they came from.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const { busy, runAction, handleEasyMove } = usePathActions();
  const [sortMode, setSortMode] = useState<SortMode>("wasted");
  const confirmDelete = useConfirmPermanentDelete();
  // Optional narrower scope — lets the user scan a subfolder of the
  // current disk snapshot rather than the whole root. Null = use
  // snapshot.rootPath as-is (the typical case).
  const [scopeOverride, setScopeOverride] = useState<string | null>(null);
  const effectiveScope = scopeOverride ?? rootPath ?? "";

  const startScan = () => {
    if (!effectiveScope) return;
    // Clear any prior analysis for this root so the UI switches cleanly
    // into scanning mode. Expanded/dismissed sets are local so they reset
    // whenever we start fresh too.
    if (rootPath) onClearAnalysis(rootPath);
    setDismissed(new Set());
    setExpanded(new Set());
    setSelectedPaths(new Set());
    void nativeApi.startDuplicateScan(effectiveScope);
  };

  const togglePathSelected = (path: string) => {
    setSelectedPaths((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  };

  const setGroupSelected = (group: DuplicateGroup, on: boolean) => {
    setSelectedPaths((s) => {
      const n = new Set(s);
      for (const f of group.files) {
        if (on) n.add(f.path);
        else n.delete(f.path);
      }
      return n;
    });
  };

  const clearSelection = () => setSelectedPaths(new Set());

  const pickNarrowerScope = async () => {
    const picked = await nativeApi.pickMoveDestination();
    if (picked) setScopeOverride(picked);
  };

  const resetScope = () => setScopeOverride(null);

  const cancelScan = () => {
    // Cancel this root's scan only — other drives' duplicate scans
    // keep running. Matches the parallel-scans model we use for
    // regular disk scans.
    if (rootPath) {
      void nativeApi.cancelDuplicateScan(rootPath);
    }
  };

  const toggleExpand = (hash: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(hash)) n.delete(hash); else n.add(hash);
      return n;
    });
  };

  const keepOne = async (group: DuplicateGroup, which: "newest" | "oldest") => {
    const sorted = [...group.files].sort((a, b) =>
      which === "newest" ? b.modifiedAt - a.modifiedAt : a.modifiedAt - b.modifiedAt,
    );
    const toTrash = sorted.slice(1);
    let ok = 0;
    for (const f of toTrash) {
      const r = await runAction(f.path, () => nativeApi.trashPath(f.path));
      if (r.ok) ok++;
    }
    if (ok > 0) {
      toast("success", `Trashed ${ok} duplicate${ok === 1 ? "" : "s"}`);
      setDismissed((d) => { const n = new Set(d); n.add(group.hash); return n; });
    }
  };

  const visibleGroups = useMemo(() => {
    if (!analysis) return [];
    const groups = analysis.groups.filter((g) => !dismissed.has(g.hash));
    switch (sortMode) {
      case "copies":
        return [...groups].sort((a, b) => b.files.length - a.files.length);
      case "size":
        return [...groups].sort((a, b) => b.size - a.size);
      case "wasted":
      default:
        return [...groups].sort(
          (a, b) => (b.files.length - 1) * b.size - (a.files.length - 1) * a.size,
        );
    }
  }, [analysis, dismissed, sortMode]);

  const visibleWasted = useMemo(
    () => visibleGroups.reduce((sum, g) => sum + (g.files.length - 1) * g.size, 0),
    [visibleGroups],
  );

  /**
   * Select every duplicate EXCEPT the one we want to keep — the common
   * case ("trash all the extras, keep one copy per group"). `which`
   * controls which copy to keep. Runs across visibleGroups so dismissed
   * groups don't get re-selected.
   */
  const selectAllExcept = (which: "newest" | "oldest") => {
    setSelectedPaths(() => {
      const next = new Set<string>();
      for (const group of visibleGroups) {
        const sorted = [...group.files].sort((a, b) =>
          which === "newest" ? b.modifiedAt - a.modifiedAt : a.modifiedAt - b.modifiedAt,
        );
        // sorted[0] = the one we keep; slice(1) goes into the selection.
        for (const f of sorted.slice(1)) next.add(f.path);
      }
      return next;
    });
  };

  /**
   * Map of path → file size for the current analysis. Rebuilt whenever
   * the analysis changes; used to compute the "X bytes" total in the
   * bulk-actions toolbar without having to scan groups each render.
   */
  const pathSizeMap = useMemo(() => {
    const map = new Map<string, number>();
    if (!analysis) return map;
    for (const g of analysis.groups) {
      for (const f of g.files) map.set(f.path, g.size);
    }
    return map;
  }, [analysis]);

  const selectionBytes = useMemo(() => {
    let total = 0;
    for (const p of selectedPaths) total += pathSizeMap.get(p) ?? 0;
    return total;
  }, [selectedPaths, pathSizeMap]);

  /**
   * Path → hash map so bulk actions can walk the selection and decide
   * whether a given group is fully cleared (and should be marked
   * dismissed). Using a separate map keeps the per-render work bounded.
   */
  const pathToHash = useMemo(() => {
    const map = new Map<string, string>();
    if (!analysis) return map;
    for (const g of analysis.groups) {
      for (const f of g.files) map.set(f.path, g.hash);
    }
    return map;
  }, [analysis]);

  const bulkTrash = async () => {
    if (selectedPaths.size === 0) return;
    const paths = Array.from(selectedPaths);
    let ok = 0;
    let fail = 0;
    for (const p of paths) {
      const r = await runAction(p, () => nativeApi.trashPath(p));
      if (r.ok) ok++;
      else fail++;
    }
    // Any group that had every file trashed is effectively resolved —
    // dismiss it so it drops out of the visible list.
    if (ok > 0) {
      setDismissed((d) => {
        const n = new Set(d);
        const hashToRemaining = new Map<string, number>();
        if (analysis) {
          for (const g of analysis.groups) {
            const remaining = g.files.filter((f) => !selectedPaths.has(f.path) || !paths.includes(f.path)).length;
            hashToRemaining.set(g.hash, remaining);
          }
        }
        for (const [hash, remaining] of hashToRemaining) {
          if (remaining <= 1) n.add(hash);
        }
        return n;
      });
      setSelectedPaths(new Set());
      toast(
        fail === 0 ? "success" : "warning",
        `Trashed ${ok} duplicate${ok === 1 ? "" : "s"}`,
        fail > 0 ? `${fail} failed — see Easy Move / file permissions.` : undefined,
      );
    } else if (fail > 0) {
      toast("error", `Couldn't trash ${fail} file${fail === 1 ? "" : "s"}`);
    }
  };

  const bulkMove = async () => {
    if (selectedPaths.size === 0) return;
    const dest = await nativeApi.pickMoveDestination();
    if (!dest) return;
    const paths = Array.from(selectedPaths);
    let ok = 0;
    let fail = 0;
    for (const p of paths) {
      const r = await runAction(p, () => nativeApi.easyMove(p, dest));
      if (r.ok) ok++;
      else fail++;
    }
    if (ok > 0) {
      setSelectedPaths(new Set());
      toast(
        fail === 0 ? "success" : "warning",
        `Moved ${ok} file${ok === 1 ? "" : "s"}`,
        fail > 0 ? `${fail} failed — the originals are still in place.` : undefined,
      );
    } else if (fail > 0) {
      toast("error", `Couldn't move ${fail} file${fail === 1 ? "" : "s"}`);
    }
    // Mark used `pathToHash` so TS doesn't complain about the unused
    // binding on builds that don't exercise the dismiss path here.
    void pathToHash;
  };

  if (!rootPath) {
    return (
      <div className="duplicates-view">
        <div className="empty-view"><span>Run a scan first to detect duplicates</span></div>
      </div>
    );
  }

  return (
    <div className="duplicates-view">
      {/* ── Header ── */}
      <div className="duplicates-header">
        <div className="duplicates-header-text">
          {analysis && !isScanning ? (
            <>
              <div className="duplicates-title-row">
                <span className="duplicates-title">
                  {visibleGroups.length} duplicate group{visibleGroups.length !== 1 ? "s" : ""}
                </span>
                <span className="duplicates-subtitle">
                  {formatBytes(visibleWasted)} reclaimable
                </span>
              </div>
              <div className="duplicates-scope" title={analysis.rootPath}>
                in <code>{analysis.rootPath}</code>
              </div>
            </>
          ) : isScanning ? (
            <>
              <div className="duplicates-title-row">
                <span className="duplicates-title">Scanning for duplicates</span>
              </div>
              <div className="duplicates-scope" title={effectiveScope}>
                in <code>{effectiveScope || "—"}</code>
              </div>
            </>
          ) : (
            <>
              <div className="duplicates-title-row">
                <span className="duplicates-title">Duplicate detection</span>
              </div>
              <div className="duplicates-scope">
                Will scan <code title={effectiveScope}>{effectiveScope || "nothing yet"}</code>
                {scopeOverride && (
                  <button
                    className="duplicates-scope-reset"
                    onClick={resetScope}
                    title={`Reset to current scan root: ${rootPath}`}
                  >
                    reset to scan root
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        <div className="duplicates-header-actions">
          {!isScanning && (
            <button
              className="scan-btn"
              onClick={() => void pickNarrowerScope()}
              title="Pick a subfolder to scan instead of the full scan root"
            >
              Change scope
            </button>
          )}
          {isScanning ? (
            <button className="scan-btn scan-btn-stop" onClick={cancelScan}>Cancel</button>
          ) : (
            <button
              className="scan-btn scan-btn-primary"
              onClick={startScan}
              disabled={!effectiveScope}
            >
              {analysis ? "Rescan" : "Scan for Duplicates"}
            </button>
          )}
        </div>
      </div>

      {/* ── Progress ── */}
      {isScanning && progress && (
        <div className="duplicates-progress">
          <div className="duplicates-progress-bar">
            <div className="duplicates-progress-fill" />
          </div>
          <div className="duplicates-progress-text">
            <span>
              {progress.status === "walking"
                ? `Cataloging files... ${progress.filesWalked.toLocaleString()} scanned`
                : `Comparing... ${progress.filesHashed.toLocaleString()} hashed`}
            </span>
            <span>
              {progress.candidateGroups.toLocaleString()} candidate groups
              {progress.groupsConfirmed > 0 && `, ${progress.groupsConfirmed} confirmed`}
            </span>
          </div>
        </div>
      )}

      {/* ── Sort bar ── */}
      {analysis && !isScanning && visibleGroups.length > 0 && (
        <div className="duplicates-sort-bar">
          <div className="chip-group">
            <button className={`chip ${sortMode === "wasted" ? "active" : ""}`} onClick={() => setSortMode("wasted")}>
              By wasted space
            </button>
            <button className={`chip ${sortMode === "copies" ? "active" : ""}`} onClick={() => setSortMode("copies")}>
              By copies
            </button>
            <button className={`chip ${sortMode === "size" ? "active" : ""}`} onClick={() => setSortMode("size")}>
              By file size
            </button>
          </div>
          <div className="duplicates-select-helpers">
            <button
              className="chip"
              onClick={() => selectAllExcept("newest")}
              title="Select every duplicate except the newest copy in each group"
            >
              Select all, keep newest
            </button>
            <button
              className="chip"
              onClick={() => selectAllExcept("oldest")}
              title="Select every duplicate except the oldest copy in each group"
            >
              Select all, keep oldest
            </button>
          </div>
        </div>
      )}

      {/* ── Results ── */}
      <div className="duplicates-list-scroll">
        {!analysis && !isScanning && (
          <div className="duplicates-empty">
            <div className="duplicates-empty-icon">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
                <rect x="3" y="3" width="8" height="18" rx="1" />
                <rect x="13" y="3" width="8" height="18" rx="1" />
                <path d="M7 8H7.01M17 8H17.01M7 12H7.01M17 12H17.01" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
            <div className="duplicates-empty-text">Find duplicate files</div>
            <div className="duplicates-empty-scope">
              Scope: <code>{effectiveScope || "—"}</code>
              <span className="duplicates-empty-scope-hint">
                {scopeOverride
                  ? "narrowed from scan root"
                  : "current scan root — change above"}
              </span>
            </div>
          </div>
        )}

        {analysis && !isScanning && visibleGroups.length === 0 && (
          <div className="duplicates-empty">
            <div className="duplicates-empty-text">
              {dismissed.size > 0 ? "All groups handled" : "No duplicates found"}
            </div>
            <div className="duplicates-empty-hint">
              {dismissed.size > 0
                ? `${dismissed.size} group${dismissed.size !== 1 ? "s" : ""} resolved.`
                : `Scanned ${analysis.filesWalked.toLocaleString()} files in ${formatElapsed(analysis.elapsedMs)}.`}
            </div>
          </div>
        )}

        {visibleGroups.map((group) => (
          <GroupCard
            key={group.hash}
            group={group}
            isExpanded={expanded.has(group.hash)}
            busy={busy}
            confirmDelete={confirmDelete}
            selectedPaths={selectedPaths}
            onToggle={() => toggleExpand(group.hash)}
            onKeepNewest={() => void keepOne(group, "newest")}
            onKeepOldest={() => void keepOne(group, "oldest")}
            onReveal={(p) => void runAction(p, () => nativeApi.revealPath(p))}
            onOpen={(p) => void runAction(p, () => nativeApi.openPath(p))}
            onTrash={(p) => void runAction(p, () => nativeApi.trashPath(p))}
            onDelete={(p) => void runAction(p, () => nativeApi.permanentlyDeletePath(p))}
            onMove={(p) => void handleEasyMove(p)}
            onToggleFileSelected={togglePathSelected}
            onToggleGroupSelected={setGroupSelected}
          />
        ))}
      </div>

      {/* ── Bulk action bar ── floats at the bottom whenever anything
           is selected. Stays out of the way otherwise so the normal
           single-file flow is uncluttered. */}
      {selectedPaths.size > 0 && (
        <div className="duplicates-bulk-bar" role="region" aria-label="Bulk actions">
          <div className="duplicates-bulk-summary">
            <span className="duplicates-bulk-count">
              {selectedPaths.size} selected
            </span>
            <span className="duplicates-bulk-bytes">
              {formatBytes(selectionBytes)} would be freed
            </span>
          </div>
          <div className="duplicates-bulk-actions">
            <button className="action-btn" onClick={clearSelection}>
              Deselect all
            </button>
            <button
              className="action-btn"
              onClick={() => void bulkMove()}
              title="Move the selected files to another folder (originals stay linked until you easy-move-back)"
            >
              Move…
            </button>
            <button
              className="action-btn warn"
              onClick={() => void bulkTrash()}
            >
              Trash {selectedPaths.size} file{selectedPaths.size === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Group card ─────────────────────────────────────────────

function GroupCard({ group, isExpanded, busy, confirmDelete, selectedPaths, onToggle, onKeepNewest, onKeepOldest, onReveal, onOpen, onTrash, onDelete, onMove, onToggleFileSelected, onToggleGroupSelected }: {
  group: DuplicateGroup;
  isExpanded: boolean;
  busy: Set<string>;
  confirmDelete: boolean;
  selectedPaths: Set<string>;
  onToggle: () => void;
  onKeepNewest: () => void;
  onKeepOldest: () => void;
  onReveal: (path: string) => void;
  onOpen: (path: string) => void;
  onTrash: (path: string) => void;
  onDelete: (path: string) => void;
  onMove: (path: string) => void;
  onToggleFileSelected: (path: string) => void;
  onToggleGroupSelected: (group: DuplicateGroup, on: boolean) => void;
}) {
  const wasted = (group.files.length - 1) * group.size;
  const name = group.files[0]?.name ?? "unknown";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";

  // Tri-state header checkbox: unchecked / indeterminate / checked based
  // on how many of this group's files are currently selected.
  const selectedInGroup = group.files.reduce(
    (n, f) => (selectedPaths.has(f.path) ? n + 1 : n),
    0,
  );
  const allGroupSelected = selectedInGroup === group.files.length;
  const someGroupSelected = selectedInGroup > 0 && !allGroupSelected;

  return (
    <div className={`duplicate-group ${isExpanded ? "expanded" : ""}`}>
      <div className="duplicate-group-header" onClick={onToggle}>
        <label
          className="duplicate-group-checkbox"
          onClick={(e) => e.stopPropagation()}
          title={allGroupSelected ? "Unselect every copy in this group" : "Select every copy in this group"}
        >
          <input
            type="checkbox"
            checked={allGroupSelected}
            ref={(el) => {
              if (el) el.indeterminate = someGroupSelected;
            }}
            onChange={(e) => onToggleGroupSelected(group, (e.target as HTMLInputElement).checked)}
          />
        </label>
        <div className="duplicate-group-icon">
          <FileIcon
            path={group.files[0]?.path ?? name}
            className="duplicate-group-icon-img"
            fallback={
              <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.5">
                <path d="M3 1.5H8.5L11 4V12.5H3V1.5Z" />
                <path d="M8.5 1.5V4H11" />
              </svg>
            }
          />
        </div>
        <div className="duplicate-group-info">
          <span className="duplicate-group-name">{name}</span>
          {ext && <span className="duplicate-group-ext">{ext}</span>}
        </div>
        <span className="duplicate-copies-badge">{group.files.length} copies</span>
        <span className="duplicate-group-size">{formatBytes(group.size)} each</span>
        <span className="duplicate-wasted">{formatBytes(wasted)} wasted</span>
        <div className="duplicate-group-actions" onClick={(e) => e.stopPropagation()}>
          <button className="action-btn warn" onClick={onKeepNewest} title="Keep the newest copy, trash the rest">
            Keep newest
          </button>
        </div>
        <svg
          className="duplicate-group-chevron"
          width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5"
          style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
        >
          <path d="M3.5 2L7 5L3.5 8" />
        </svg>
      </div>

      {isExpanded && (
        <div className="duplicate-group-files">
          <div className="duplicate-files-toolbar">
            <button className="action-btn" onClick={onKeepNewest}>Keep newest</button>
            <button className="action-btn" onClick={onKeepOldest}>Keep oldest</button>
          </div>
          {group.files
            .slice()
            .sort((a, b) => b.modifiedAt - a.modifiedAt)
            .map((file, idx) => {
              const isBusy = busy.has(file.path);
              const isSelected = selectedPaths.has(file.path);
              return (
                <div
                  key={file.path}
                  className={`duplicate-file-row ${isSelected ? "selected" : ""}`}
                >
                  <label
                    className="duplicate-file-checkbox"
                    title={isSelected ? "Deselect this copy" : "Select this copy for bulk trash/move"}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggleFileSelected(file.path)}
                    />
                  </label>
                  <FileIcon path={file.path} className="duplicate-file-icon-img" />
                  <div className="duplicate-file-info">
                    <span className="duplicate-file-path">{file.path}</span>
                    <span className="duplicate-file-meta">
                      {humanAge(file.modifiedAt)}
                      {idx === 0 && <span className="duplicate-newest-badge">newest</span>}
                    </span>
                  </div>
                  <div className="duplicate-file-actions">
                    <button className="action-btn" disabled={isBusy} onClick={() => onReveal(file.path)}>Reveal</button>
                    <button className="action-btn" disabled={isBusy} onClick={() => onOpen(file.path)}>Open</button>
                    <button className="action-btn warn" disabled={isBusy} onClick={() => onTrash(file.path)}>Trash</button>
                    <button
                      className="action-btn danger"
                      disabled={isBusy}
                      title="Permanently delete this copy (skips trash)"
                      onClick={() => {
                        if (confirmDelete && !confirm(`Permanently delete this copy?\n${file.path}`)) return;
                        onDelete(file.path);
                      }}
                    >
                      Del
                    </button>
                    <button className="action-btn" disabled={isBusy} onClick={() => onMove(file.path)}>Move</button>
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
