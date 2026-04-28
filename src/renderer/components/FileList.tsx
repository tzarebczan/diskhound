import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { PathActionResult, ScanFileRecord, ScanSnapshot } from "../../shared/contracts";
import { formatBytes, formatCount, humanAge, relativePath } from "../lib/format";
import { usePathActions } from "../lib/hooks";
import { nativeApi } from "../nativeApi";
import { FileIcon } from "./FileIcon";
import { toast } from "./Toasts";

type QuickFilter = "all" | "video" | "archives" | "installers" | "images" | "audio" | "documents";
type SortField = "size" | "name" | "ext" | "age";
type SortDir = "asc" | "desc";

/**
 * Page size for the Largest Files list. Rendering ~50K rows of
 * Preact JSX in a single pass costs ~600 ms on mid-range hardware
 * and stutters during sort/filter changes (every keystroke
 * re-renders all rows). 1000 keeps interactivity snappy and is
 * still more than any realistic "find what to clean up" session
 * needs from a single page — when users do need more, the
 * Load-more button extends the limit without repaginating the
 * whole list.
 *
 * Filter / sort / quick-filter changes reset the page back to one
 * (see useEffect below) so the user isn't stuck on a stale tail
 * of the list after narrowing the view.
 */
const PAGE_SIZE = 1000;

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
  // We use our own local runAction below (so success+dismiss can also hide the row),
  // but pull the other helpers from the shared hook.
  const { busy, markBusy, clearBusy, handleEasyMove, handleEasyMoveBatch } = usePathActions();
  const [sortField, setSortField] = useState<SortField>("size");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [focusIndex, setFocusIndex] = useState(-1);
  /** How many rows of the filtered+sorted result to actually render.
   *  Starts at PAGE_SIZE; "Load more" bumps it by another PAGE_SIZE. */
  const [pageLimit, setPageLimit] = useState(PAGE_SIZE);
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

  // Full filtered+sorted list — used for the "Showing X of Y"
  // status, "Select all" semantics (selecting only the visible
  // page would be confusing), and the Load-more decision.
  const filteredFiles = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    const filtered = snapshot.largestFiles
      .filter((f) => !dismissed.has(f.path))
      .filter((f) => quickFilter === "all" || FILTER_EXTS[quickFilter]?.has(f.extension))
      .filter((f) => !query || `${f.path} ${f.extension}`.toLowerCase().includes(query));
    return [...filtered].sort(compareFn(sortField, sortDir));
  }, [snapshot.largestFiles, filterText, quickFilter, dismissed, sortField, sortDir]);

  // Paginated slice we actually render. Filter/sort changes reset
  // the page back to PAGE_SIZE in the effect below, so the user
  // isn't stuck on a stale tail of the list after narrowing the
  // view (e.g. picking the "Video" quick-filter dropping from 50K
  // to 200 results — they shouldn't have to scroll back through
  // a paginated 1K window to see the matches).
  const visibleFiles = useMemo(
    () => filteredFiles.slice(0, pageLimit),
    [filteredFiles, pageLimit],
  );

  // Reset pagination whenever the user narrows or re-orders the
  // list. Snapshot updates (new scan results) also reset, since
  // the underlying data shifted enough that the saved page index
  // would no longer line up with what the user expected to see.
  useEffect(() => {
    setPageLimit(PAGE_SIZE);
  }, [filterText, quickFilter, sortField, sortDir, snapshot.largestFiles]);

  visibleFilesRef.current = visibleFiles;
  const totalCount = filteredFiles.length;
  const hasMore = totalCount > visibleFiles.length;

  // Selection counts. We track two distinct numbers:
  //  - selectedVisible: how many checkboxes the user can currently
  //    see ticked. Drives the "X / N selected" label and the
  //    Select-All / Clear-All toggle.
  //  - selectedTotal: how many files across the entire filtered set
  //    are selected (covers paginated rows the user expanded into
  //    but later collapsed away). Drives the bulk-action targets
  //    so "Trash selected" / "Delete selected" act on every ticked
  //    row, not just the rendered page.
  const selectedVisible = useMemo(
    () => visibleFiles.filter((f) => selected.has(f.path)).length,
    [visibleFiles, selected],
  );
  const selectedTotal = useMemo(
    () => filteredFiles.filter((f) => selected.has(f.path)).length,
    [filteredFiles, selected],
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
    // Operate on the *visible* page — selecting all means "tick the
    // checkboxes I can see right now." If the user has 50K filtered
    // files and clicks "Select all" once, they should get the
    // current 1K page selected, not be silently signed up for a
    // 50K bulk delete. To select more they'd Load-more then click
    // again.
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
    // Bulk acts on every selected file, not just the currently-
    // rendered page. Otherwise scrolling to the next page would
    // silently drop earlier selections from the operation, which
    // is exactly the "I clicked select-all on page 1, then page 2,
    // then trash, but only page-2 got trashed" footgun we want to
    // avoid.
    const targets = filteredFiles.filter((f) => selected.has(f.path));
    if (targets.length === 0) return;
    if (label === "delete") {
      const msg =
        `Permanently delete ${targets.length} file(s)?\n\n` +
        `This SKIPS the trash and CANNOT be undone — the OS will free the bytes immediately.`;
      if (!confirm(msg)) return;
    }

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

  const bulkMove = async () => {
    const targets = filteredFiles.filter((f) => selected.has(f.path));
    if (targets.length === 0) return;
    const moved = await handleEasyMoveBatch(targets.map((f) => f.path));
    if (moved.length > 0) markDismissed(moved);
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
        {/* "X selected (of N matching)" — the parenthetical tells
         *  the user that bulk actions cover every selected row, not
         *  just the rendered page. Without it, paginating felt
         *  like the off-page selections were lost. */}
        <span className="bulk-bar-count">{selectedTotal}</span>
        <span>selected{totalCount > visibleFiles.length ? ` (of ${formatCount(totalCount)} matching)` : ""}</span>
        <div className="bulk-spacer" />
        <button className="bulk-btn" onClick={toggleSelectAll}>
          {selectedVisible === visibleFiles.length && visibleFiles.length > 0 ? "Clear page" : "Select page"}
        </button>
        <button
          className="bulk-btn"
          disabled={selectedTotal === 0}
          onClick={() => void bulkMove()}
          title="Move selected files to another location and leave a symlink so they still open from here"
        >
          Move selected
        </button>
        <button
          className="bulk-btn warn"
          disabled={selectedTotal === 0}
          onClick={() => void bulkAction("trash", nativeApi.trashPath)}
          title="Send to OS trash — recoverable until emptied"
        >
          Trash selected
        </button>
        <button
          className="bulk-btn danger"
          disabled={selectedTotal === 0}
          onClick={() => void bulkAction("delete", nativeApi.permanentlyDeletePath)}
          title="Permanently delete — skips trash, frees disk space immediately, cannot be undone"
        >
          Delete selected
        </button>
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
          <>
            {visibleFiles.map((file, idx) => (
              <FileRow
                key={file.path}
                file={file}
                index={idx}
                focused={focusIndex === idx}
                rootPath={snapshot.rootPath}
                selected={selected.has(file.path)}
                isBusy={busy.has(file.path)}
                onToggle={() => toggleSelected(file.path)}
                onReveal={() => void runAction(file.path, () => nativeApi.revealPath(file.path))}
                onOpen={() => void runAction(file.path, () => nativeApi.openPath(file.path))}
                onMove={() => void handleEasyMove(file.path)}
                onTrash={() => void runAction(file.path, () => nativeApi.trashPath(file.path), { dismiss: true })}
                onDelete={() => {
                  const msg =
                    `Permanently delete ${file.name}?\n\n` +
                    `This SKIPS the trash and CANNOT be undone — the OS will free the bytes immediately.`;
                  if (!confirm(msg)) return;
                  void runAction(file.path, () => nativeApi.permanentlyDeletePath(file.path), { dismiss: true });
                }}
              />
            ))}
            {/* Load-more footer. Shown only when there's another
             *  page of filtered results past the current limit.
             *  Bumps in PAGE_SIZE chunks so a click on a 50K-result
             *  filter doesn't lock the renderer for half a second
             *  trying to materialise everything. */}
            {hasMore && (
              <div className="file-list-loadmore">
                <span className="file-list-loadmore-status">
                  Showing {formatCount(visibleFiles.length)} of {formatCount(totalCount)}
                </span>
                <button
                  className="action-btn"
                  onClick={() => setPageLimit((n) => n + PAGE_SIZE)}
                >
                  Load {formatCount(Math.min(PAGE_SIZE, totalCount - visibleFiles.length))} more
                </button>
                <button
                  className="action-btn"
                  onClick={() => setPageLimit(totalCount)}
                  title="Render every matching file. May lag on very large result sets — prefer filtering or quick-filters first."
                >
                  Show all
                </button>
              </div>
            )}
          </>
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
  onToggle: () => void;
  onReveal: () => void;
  onOpen: () => void;
  onMove: () => void;
  onTrash: () => void;
  onDelete: () => void;
}) {
  const { file, index, focused, rootPath, selected, isBusy, onToggle, onReveal, onOpen, onMove, onTrash, onDelete } = props;

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
        <button
          className="action-btn"
          disabled={isBusy}
          onClick={onMove}
          title="Move this file to another location and leave a symlink so it still opens from here"
        >
          Move
        </button>
        <button className="action-btn" disabled={isBusy} onClick={onReveal}>Reveal</button>
        <button className="action-btn" disabled={isBusy} onClick={onOpen}>Open</button>
        <button
          className="action-btn warn"
          disabled={isBusy}
          onClick={onTrash}
          title="Send to OS trash (recoverable until emptied)"
        >
          Trash
        </button>
        {/* Permanent delete is now always available — the
         * cleanup.safeDeleteToTrash setting used to gate this button
         * but it created a confusing two-step (open Settings, flip
         * a toggle, come back, delete). Confirm dialog with strong
         * irreversibility wording remains the safety net. */}
        <button
          className="action-btn danger"
          disabled={isBusy}
          onClick={onDelete}
          title="Permanently delete (skips trash, cannot be undone)"
        >
          Del
        </button>
      </div>
    </div>
  );
}
