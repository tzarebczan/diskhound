import { useEffect, useState } from "preact/hooks";

import type { EasyMoveRecord } from "../../shared/contracts";
import { formatBytes, relativeTime } from "../lib/format";
import { nativeApi } from "../nativeApi";
import { toast } from "./Toasts";

export function EasyMoveView() {
  const [records, setRecords] = useState<EasyMoveRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const refresh = async () => {
    const r = await nativeApi.getEasyMoves();
    if (r) setRecords(r);
    setLoading(false);
  };

  useEffect(() => { void refresh(); }, []);

  const moveBack = async (record: EasyMoveRecord) => {
    setBusy((b) => { const n = new Set(b); n.add(record.id); return n; });
    const result = await nativeApi.easyMoveBack(record.id);
    setBusy((b) => { const n = new Set(b); n.delete(record.id); return n; });
    if (result?.ok) {
      toast("success", "Restored", result.message);
      void refresh();
    } else {
      toast("error", "Restore failed", result?.message ?? "Unknown error");
    }
  };

  if (loading) return null;

  return (
    <div className="easymove-view">
      <div className="easymove-header">
        <div>
          <div className="easymove-title">Easy Move</div>
          <div className="easymove-desc">
            Files and folders moved to other drives with symlinks in their place.
            Move them back any time if there's enough space.
          </div>
        </div>
        {records.length > 0 && (
          <div className="easymove-summary">
            <span className="easymove-summary-count">{records.length}</span>
            <span className="easymove-summary-label">
              {records.length === 1 ? "item" : "items"} linked
            </span>
          </div>
        )}
      </div>

      {records.length === 0 ? (
        <div className="easymove-empty">
          <div className="easymove-empty-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
              <path d="M14 2H6C4.9 2 4 2.9 4 4V20C4 21.1 4.9 22 6 22H18C19.1 22 20 21.1 20 20V8L14 2Z" />
              <path d="M14 2V8H20" />
              <path d="M8 13H16M12 9V17" />
            </svg>
          </div>
          <div className="easymove-empty-text">No items moved yet</div>
          <div className="easymove-empty-hint">
            Use "Easy Move" on any file or folder to move it to another drive while keeping a symlink in its original location.
          </div>
        </div>
      ) : (
        <div className="easymove-list">
          {records.map((r) => (
            <EasyMoveRow
              key={r.id}
              record={r}
              isBusy={busy.has(r.id)}
              onMoveBack={() => void moveBack(r)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EasyMoveRow({ record, isBusy, onMoveBack }: {
  record: EasyMoveRecord;
  isBusy: boolean;
  onMoveBack: () => void;
}) {
  const age = relativeTime(record.movedAt);
  const name = record.originalPath.split(/[\\/]/).pop() ?? record.originalPath;

  return (
    <div className="easymove-row">
      <div className="easymove-row-icon">
        {record.isDirectory ? (
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <path d="M2 4V13C2 13.55 2.45 14 3 14H13C13.55 14 14 13.55 14 13V6C14 5.45 13.55 5 13 5H8L6.5 3H3C2.45 3 2 3.45 2 4Z" fill="currentColor" opacity="0.2" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.1">
            <path d="M3 1.5H8.5L11 4V12.5H3V1.5Z" />
            <path d="M8.5 1.5V4H11" />
          </svg>
        )}
      </div>
      <div className="easymove-row-info">
        <div className="easymove-row-name">{name}</div>
        <div className="easymove-row-paths">
          <span className="easymove-row-from">{record.originalPath}</span>
          <svg width="12" height="10" viewBox="0 0 12 10" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.4">
            <path d="M2 5H10M7.5 2.5L10 5L7.5 7.5" />
          </svg>
          <span className="easymove-row-to">{record.movedToPath}</span>
        </div>
      </div>
      <div className="easymove-row-meta">
        {record.size > 0 && <span className="easymove-row-size">{formatBytes(record.size)}</span>}
        <span className="easymove-row-age">{age}</span>
      </div>
      <div className="easymove-row-actions">
        <span className={`easymove-row-status ${record.stranded ? "stranded" : ""}`}>
          {record.stranded ? "stranded" : "linked"}
        </span>
        <button
          className="action-btn warn"
          disabled={isBusy}
          onClick={onMoveBack}
        >
          {isBusy ? "Moving..." : "Move back"}
        </button>
      </div>
    </div>
  );
}

