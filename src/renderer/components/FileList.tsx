import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { PathActionResult, ScanFileRecord, ScanSnapshot } from "../../shared/contracts";
import { formatBytes, humanAge, relativePath } from "../lib/format";
import { useBusySet, useSafeDeleteOnly } from "../lib/hooks";
import { nativeApi } from "../nativeApi";
import { FileIcon } from "./FileIcon";
import { toast } from "./Toasts";

type QuickFilter = "all" | "video" | "archives" | "installers" | "images" | "audio" | "documents";
type SortField = "size" | "name" | "ext" | "age";
type SortDir = "asc" | "desc";

const QUICK_FILTERS: { id: QuickFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "video", label: "Video" },
  { id: "archives", label: "Archives" },
  { id: "installers", label: "Installers" },
  { id: "images", label: "Images" },
  { id: "audio", label: "Audio" },
  { id: "documents", label: "Docs" },
];

const FILTER_EXTS: Record<Exclude<QuickFilter, "all">, Set<string>> = {
  video: new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm", ".wmv"]),
  archives: new Set([".7z", ".bz2", ".gz", ".iso", ".rar", ".tar", ".xz", ".zip"]),
  installers: new Set([".appx", ".dmg", ".exe", ".iso", ".msi", ".msix", ".pkg"]),
  images: new Set([".gif", ".heic", ".jpeg", ".jpg", ".png", ".psd", ".raw", ".svg", ".webp"]),
  audio: new Set([".aac", ".flac", ".m4a", ".mp3", ".wav", ".wma"]),
  documents: new Set([".csv", ".doc", ".docx", ".pdf", ".ppt", ".pptx", ".txt", ".xls", ".xlsx"]),
};

interface Props {
  snapshot: ScanSnapshot;
  initialFilter?: string;
}

function compareFn(field: SortField, dir: SortDir) {
  const m = dir === "asc" ? 1 : -1;
  return (a: ScanFileRecord, b: ScanFileRecord): number => {
    switch (field) {
      case "size": return (a.size - b.size) * m;
      case "name": return a.name.localeCompare(b.name) * m;
      case "ext": return a.extension.localeCompare(b.extension) * m;
      case "age": return (a.modifiedAt - b.modifiedAt) * m;
    }
  };
}

export function FileList({ snapshot, initialFilter }: Props) {
  const [filterText, setFilterText] = useState(initialFilter ?? "");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const { busy, markBusy, clearBusy } = useBusySet();
  const [sortField, setSortField] = useState<SortField>("size");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const safeDeleteOnly = useSafeDeleteOnly();
  const [focusIndex, setFocusIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  // Ref for keyboard handler to access latest visibleFiles without dependency cycle
  const visibleFilesRef = useRef<ScanFileRecord[]>([]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "name" || field === "ext" ? "asc" : "desc");
    }
  };

  const visibleFiles = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    const filtered = snapshot.largestFiles
      .filter((f) => !dismissed.has(f.path))
      .filter((f) => quickFilter === "all" || FILTER_EXTS[quickFilter]?.has(f.extension))
      .filter((f) => !query || `${f.path} ${f.extension}`.toLowerCase().includes(query));
    return [...filtered].sort(compareFn(sortField, sortDir));
  }, [snapshot.largestFiles, filterText, quickFilter, dismissed, sortField, sortDir]);

  visibleFilesRef.current = visibleFiles;

  const selectedVisible = useMemo(
    () => visibleFiles.filter((f) => selected.has(f.path)).length,
    [visibleFiles, selected],
  );

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!listRef.current?.contains(document.activeElement) && document.activeElement?.tagName !== "BODY") return;
      const files = visibleFilesRef.current;
      const len = files.length;
      if (len === 0) return;

      switch (e.key) {
        case "ArrowDown":
        case "j":
          e.preventDefault();
          setFocusIndex((i) => Math.min(i + 1, len - 1));
          break;
        case "ArrowUp":
        case "k":
          e.preventDefault();
          setFocusIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter": {
          e.preventDefault();
          setFocusIndex((i) => { const f = files[i]; if (f) void nativeApi.openPath(f.path); return i; });
          break;
        }
        case "Delete": {
          e.preventDefault();
          setFocusIndex((i) => {
            const f = files[i];
            if (f) void nativeApi.trashPath(f.path).then((r) => {
              if (r.ok) { markDismissed([f.path]); toast("success", r.message); }
            });
            return i;
          });
          break;
        }
        case " ": {
          e.preventDefault();
          setFocusIndex((i) => { const f = files[i]; if (f) toggleSelected(f.path); return i; });
          break;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Scroll focused row into view
  useEffect(() => {
    if (focusIndex < 0) return;
    const row = listRef.current?.querySelector(`[data-index="${focusIndex}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [focusIndex]);

  const toggleSelected = (path: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const paths = visibleFiles.map((f) => f.path);
    const allSelected = paths.every((p) => selected.has(p));
    setSelected((s) => {
      const next = new Set(s);
      for (const p of paths) { allSelected ? next.delete(p) : next.add(p); }
      return next;
    });
  };

  const markDismissed = (paths: string[]) => {
    setDismissed((d) => { const next = new Set(d); paths.forEach((p) => next.add(p)); return next; });
    setSelected((s) => { const next = new Set(s); paths.forEach((p) => next.delete(p)); return next; });
  };

  const runAction = async (
    path: string,
    action: () => Promise<PathActionResult>,
    opts?: { dismiss?: boolean },
  ) => {
    markBusy(path);
    const result = await action();
    clearBusy(path);
    if (result.ok && opts?.dismiss) {
      markDismissed([path]);
      toast("success", result.message);
    } else if (!result.ok) {
      toast("error", "Action failed", result.message);
    }
  };

  const bulkAction = async (
    label: "trash" | "delete",
    action: (p: string) => Promise<PathActionResult>,
  ) => {
    const targets = visibleFiles.filter((f) => selected.has(f.path));
    if (targets.length === 0) return;
    if (label === "delete" && !confirm(`Permanently delete ${targets.length} file(s)?`)) return;

    const ok: string[] = [];
    for (const f of targets) {
      markBusy(f.path);
      const r = await action(f.path);
      clearBusy(f.path);
      if (r.ok) ok.push(f.path);
    }
    if (ok.length > 0) {
      markDismissed(ok);
      toast("success", `${label === "trash" ? "Trashed" : "Deleted"} ${ok.length} file(s)`);
    }
  };

  return (
    <div className="file-view">
      <div className="file-toolbar">
        <input
          className="filter-input"
          value={filterText}
          onInput={(e) => setFilterText((e.target as HTMLInputElement).value)}
          placeholder="Filter by path or extension..."
        />
        <div className="chip-group">
          {QUICK_FILTERS.map((f) => (
            <button
              key={f.id}
              className={`chip ${quickFilter === f.id ? "active" : ""}`}
              onClick={() => setQuickFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bulk-bar">
        <span className="bulk-bar-count">{selectedVisible}/{visibleFiles.length}</span>
        <span>selected</span>
        <div className="bulk-spacer" />
        <button className="bulk-btn" onClick={toggleSelectAll}>
          {selectedVisible === visibleFiles.length && visibleFiles.length > 0 ? "Clear all" : "Select all"}
        </button>
        <button
          className="bulk-btn warn"
          disabled={selectedVisible === 0}
          onClick={() => void bulkAction("trash", nativeApi.trashPath)}
        >
          Trash selected
        </button>
        {!safeDeleteOnly && (
          <button
            className="bulk-btn danger"
            disabled={selectedVisible === 0}
            onClick={() => void bulkAction("delete", nativeApi.permanentlyDeletePath)}
          >
            Delete selected
          </button>
        )}
      </div>

      {/* ── Column headers ── */}
      <div className="file-col-header">
        <div className="file-check" />
        <SortableHeader field="size" label="Size" current={sortField} dir={sortDir} onToggle={toggleSort} align="right" />
        <div className="file-row-icon-hdr" />
        <SortableHeader field="name" label="Name" current={sortField} dir={sortDir} onToggle={toggleSort} />
        <SortableHeader field="ext" label="Type" current={sortField} dir={sortDir} onToggle={toggleSort} align="center" />
        <SortableHeader field="age" label="Age" current={sortField} dir={sortDir} onToggle={toggleSort} align="right" />
        <div className="file-actions-hdr" />
      </div>

      <div className="file-list-scroll" ref={listRef} tabIndex={0}>
        {visibleFiles.length === 0 ? (
          <div className="empty-view">
            <span>No files match the current filter</span>
          </div>
        ) : (
          visibleFiles.map((file, idx) => (
            <FileRow
              key={file.path}
              file={file}
              index={idx}
              focused={focusIndex === idx}
              rootPath={snapshot.rootPath}
              selected={selected.has(file.path)}
              isBusy={busy.has(file.path)}
              safeDeleteOnly={safeDeleteOnly}
              onToggle={() => toggleSelected(file.path)}
              onReveal={() => void runAction(file.path, () => nativeApi.revealPath(file.path))}
              onOpen={() => void runAction(file.path, () => nativeApi.openPath(file.path))}
              onTrash={() => void runAction(file.path, () => nativeApi.trashPath(file.path), { dismiss: true })}
              onDelete={() => {
                if (!confirm(`Permanently delete ${file.name}?`)) return;
                void runAction(file.path, () => nativeApi.permanentlyDeletePath(file.path), { dismiss: true });
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SortableHeader({ field, label, current, dir, onToggle, align }: {
  field: SortField;
  label: string;
  current: SortField;
  dir: SortDir;
  onToggle: (field: SortField) => void;
  align?: "left" | "center" | "right";
}) {
  const isActive = current === field;
  return (
    <button
      className={`file-col-btn ${isActive ? "active" : ""}`}
      style={align ? { textAlign: align, justifyContent: align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start" } : undefined}
      onClick={() => onToggle(field)}
    >
      {label}
      {isActive && (
        <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" style={{ marginLeft: 3 }}>
          {dir === "desc"
            ? <path d="M4 6L1 2.5H7Z" />
            : <path d="M4 2L1 5.5H7Z" />}
        </svg>
      )}
    </button>
  );
}

function FileRow(props: {
  file: ScanFileRecord;
  index: number;
  focused: boolean;
  rootPath: string | null;
  selected: boolean;
  isBusy: boolean;
  safeDeleteOnly: boolean;
  onToggle: () => void;
  onReveal: () => void;
  onOpen: () => void;
  onTrash: () => void;
  onDelete: () => void;
}) {
  const { file, index, focused, rootPath, selected, isBusy, safeDeleteOnly, onToggle, onReveal, onOpen, onTrash, onDelete } = props;

  return (
    <div className={`file-row ${selected ? "selected" : ""} ${focused ? "focused" : ""}`} data-index={index}>
      <div className="file-check">
        <input type="checkbox" checked={selected} onChange={onToggle} />
      </div>
      <div className="file-size">{formatBytes(file.size)}</div>
      <FileIcon path={file.path} className="file-row-icon" />
      <div className="file-info">
        <div className="file-name">{file.name}</div>
        <div className="file-path">{relativePath(file.path, rootPath)}</div>
      </div>
      <div className="file-ext">{file.extension}</div>
      <div className="file-age">{humanAge(file.modifiedAt)}</div>
      <div className="file-actions">
        <button className="action-btn" disabled={isBusy} onClick={onReveal}>Reveal</button>
        <button className="action-btn" disabled={isBusy} onClick={onOpen}>Open</button>
        <button className="action-btn warn" disabled={isBusy} onClick={onTrash}>Trash</button>
        {!safeDeleteOnly && (
          <button className="action-btn danger" disabled={isBusy} onClick={onDelete}>Del</button>
        )}
      </div>
    </div>
  );
}
