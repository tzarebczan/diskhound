import { useEffect, useMemo, useState } from "preact/hooks";

import type {
  DuplicateAnalysis,
  DuplicateGroup,
  DuplicateScanProgress,
  ScanSnapshot,
} from "../../shared/contracts";
import { formatBytes, humanAge } from "../lib/format";
import { usePathActions, useSafeDeleteOnly } from "../lib/hooks";
import { nativeApi } from "../nativeApi";
import { FileIcon } from "./FileIcon";
import { toast } from "./Toasts";

interface Props {
  snapshot: ScanSnapshot;
}

type SortMode = "wasted" | "copies" | "size";

export function DuplicatesView({ snapshot }: Props) {
  const rootPath = snapshot.rootPath;
  const [progress, setProgress] = useState<DuplicateScanProgress | null>(null);
  const [analysis, setAnalysis] = useState<DuplicateAnalysis | null>(null);
  const [scanning, setScanning] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const { busy, runAction, handleEasyMove } = usePathActions();
  const [sortMode, setSortMode] = useState<SortMode>("wasted");
  const safeDeleteOnly = useSafeDeleteOnly();

  useEffect(() => {
    const unsubProgress = nativeApi.onDuplicateProgress((p) => {
      setProgress(p);
      if (p.status === "walking" || p.status === "hashing") {
        setScanning(true);
      } else {
        setScanning(false);
      }
    });
    const unsubResult = nativeApi.onDuplicateResult((r) => {
      setAnalysis(r);
      setScanning(false);
      setProgress(null);
    });
    return () => { unsubProgress(); unsubResult(); };
  }, []);

  const startScan = () => {
    if (!rootPath) return;
    setAnalysis(null);
    setDismissed(new Set());
    setExpanded(new Set());
    setScanning(true);
    void nativeApi.startDuplicateScan(rootPath);
  };

  const cancelScan = () => {
    void nativeApi.cancelDuplicateScan();
    setScanning(false);
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
        <div>
          {analysis && !scanning ? (
            <>
              <span className="duplicates-title">
                {visibleGroups.length} duplicate group{visibleGroups.length !== 1 ? "s" : ""}
              </span>
              <span className="duplicates-subtitle">
                {formatBytes(visibleWasted)} reclaimable
              </span>
            </>
          ) : scanning ? (
            <span className="duplicates-title">Scanning for duplicates...</span>
          ) : (
            <span className="duplicates-title">Duplicate Detection</span>
          )}
        </div>
        <div className="duplicates-header-actions">
          {scanning ? (
            <button className="scan-btn scan-btn-stop" onClick={cancelScan}>Cancel</button>
          ) : (
            <button className="scan-btn scan-btn-primary" onClick={startScan}>
              {analysis ? "Rescan" : "Scan for Duplicates"}
            </button>
          )}
        </div>
      </div>

      {/* ── Progress ── */}
      {scanning && progress && (
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
      {analysis && !scanning && visibleGroups.length > 0 && (
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
        </div>
      )}

      {/* ── Results ── */}
      <div className="duplicates-list-scroll">
        {!analysis && !scanning && (
          <div className="duplicates-empty">
            <div className="duplicates-empty-icon">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
                <rect x="3" y="3" width="8" height="18" rx="1" />
                <rect x="13" y="3" width="8" height="18" rx="1" />
                <path d="M7 8H7.01M17 8H17.01M7 12H7.01M17 12H17.01" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
            <div className="duplicates-empty-text">Find duplicate files</div>
            <div className="duplicates-empty-hint">
              Scan your drive to find identical files taking up extra space.
              Files are compared by content (SHA-256 hash), not just name.
            </div>
          </div>
        )}

        {analysis && !scanning && visibleGroups.length === 0 && (
          <div className="duplicates-empty">
            <div className="duplicates-empty-text">
              {dismissed.size > 0 ? "All groups handled" : "No duplicates found"}
            </div>
            <div className="duplicates-empty-hint">
              {dismissed.size > 0
                ? `${dismissed.size} group${dismissed.size !== 1 ? "s" : ""} resolved.`
                : `Scanned ${analysis.filesWalked.toLocaleString()} files in ${(analysis.elapsedMs / 1000).toFixed(1)}s.`}
            </div>
          </div>
        )}

        {visibleGroups.map((group) => (
          <GroupCard
            key={group.hash}
            group={group}
            isExpanded={expanded.has(group.hash)}
            busy={busy}
            safeDeleteOnly={safeDeleteOnly}
            onToggle={() => toggleExpand(group.hash)}
            onKeepNewest={() => void keepOne(group, "newest")}
            onKeepOldest={() => void keepOne(group, "oldest")}
            onReveal={(p) => void runAction(p, () => nativeApi.revealPath(p))}
            onOpen={(p) => void runAction(p, () => nativeApi.openPath(p))}
            onTrash={(p) => void runAction(p, () => nativeApi.trashPath(p))}
            onDelete={(p) => void runAction(p, () => nativeApi.permanentlyDeletePath(p))}
            onMove={(p) => void handleEasyMove(p)}
          />
        ))}
      </div>
    </div>
  );
}

// ── Group card ─────────────────────────────────────────────

function GroupCard({ group, isExpanded, busy, safeDeleteOnly, onToggle, onKeepNewest, onKeepOldest, onReveal, onOpen, onTrash, onDelete, onMove }: {
  group: DuplicateGroup;
  isExpanded: boolean;
  busy: Set<string>;
  safeDeleteOnly: boolean;
  onToggle: () => void;
  onKeepNewest: () => void;
  onKeepOldest: () => void;
  onReveal: (path: string) => void;
  onOpen: (path: string) => void;
  onTrash: (path: string) => void;
  onDelete: (path: string) => void;
  onMove: (path: string) => void;
}) {
  const wasted = (group.files.length - 1) * group.size;
  const name = group.files[0]?.name ?? "unknown";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";

  return (
    <div className={`duplicate-group ${isExpanded ? "expanded" : ""}`}>
      <div className="duplicate-group-header" onClick={onToggle}>
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
              return (
                <div key={file.path} className="duplicate-file-row">
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
                    {!safeDeleteOnly && (
                      <button className="action-btn danger" disabled={isBusy} onClick={() => {
                        if (confirm(`Permanently delete this copy?\n${file.path}`)) onDelete(file.path);
                      }}>Del</button>
                    )}
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
