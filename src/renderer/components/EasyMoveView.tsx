import { useEffect, useState } from "preact/hooks";

import type {
  EasyMoveRecord,
  EasyMoveVerification,
} from "../../shared/contracts";
import { formatBytes, relativeTime } from "../lib/format";
import { nativeApi } from "../nativeApi";
import { toast } from "./Toasts";

export function EasyMoveView() {
  const [records, setRecords] = useState<EasyMoveRecord[]>([]);
  const [verifications, setVerifications] = useState<Map<string, EasyMoveVerification>>(new Map());
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const refresh = async () => {
    const r = await nativeApi.getEasyMoves();
    if (r) setRecords(r);
    setLoading(false);
  };

  /**
   * Run lstat on every record's source + dest so the UI can badge
   * broken links, missing destinations, etc. Kicked off
   * automatically when the tab mounts; user can re-run any time
   * via the Verify button. Cheap — typically <100 ms for 20
   * records.
   */
  const verify = async () => {
    setVerifying(true);
    const results = await nativeApi.verifyEasyMoves().catch(() => null);
    setVerifying(false);
    if (!results) {
      toast("error", "Couldn't verify Easy Moves");
      return;
    }
    const next = new Map<string, EasyMoveVerification>();
    for (const v of results) next.set(v.id, v);
    setVerifications(next);
    // Summarise in a toast when there's anything broken — silent
    // "all-ok" path keeps the UI quiet on the common case.
    const broken = results.filter((r) => r.status !== "ok").length;
    if (broken > 0) {
      toast(
        "warning",
        `${broken} of ${results.length} Easy Moves need attention`,
        "See the status badges below.",
      );
    }
  };

  useEffect(() => {
    void (async () => {
      await refresh();
      await verify();
    })();
  }, []);

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
            <button
              className="action-btn"
              onClick={() => void verify()}
              disabled={verifying}
              title="Re-check every move's link + destination on disk"
            >
              {verifying ? "Verifying…" : "Verify"}
            </button>
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
              verification={verifications.get(r.id) ?? null}
              isBusy={busy.has(r.id)}
              onMoveBack={() => void moveBack(r)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EasyMoveRow({ record, verification, isBusy, onMoveBack }: {
  record: EasyMoveRecord;
  verification: EasyMoveVerification | null;
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
        <EasyMoveStatusBadge record={record} verification={verification} />
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

/**
 * Status badge for an Easy Move record. Combines:
 *   - The stranded flag from the record itself (set when link
 *     creation failed and rollback also failed — file is at dest
 *     with no link home).
 *   - The live verification result from lstat (set by the Verify
 *     button or auto-run on tab mount).
 *
 * Status priority (most-broken first):
 *   stranded → both-missing → dest-missing → link-missing
 *   source-file → ok (default when no verification available).
 */
function EasyMoveStatusBadge({
  record,
  verification,
}: {
  record: EasyMoveRecord;
  verification: EasyMoveVerification | null;
}) {
  if (record.stranded) {
    return (
      <span
        className="easymove-row-status stranded"
        title="Link creation failed AND rollback failed. The file is at the destination but the source has no link. Use 'Move back' to restore it."
      >
        stranded
      </span>
    );
  }
  if (!verification) {
    return <span className="easymove-row-status">linked</span>;
  }
  switch (verification.status) {
    case "both-missing":
      return (
        <span
          className="easymove-row-status stranded"
          title="Both the source link AND the destination file are gone. This record is orphaned — delete it via 'Move back' to clean up."
        >
          both missing
        </span>
      );
    case "dest-missing":
      return (
        <span
          className="easymove-row-status stranded"
          title="The destination file is gone — the link at source points nowhere. You may need to restore the dest from backup."
        >
          dest missing
        </span>
      );
    case "link-missing":
      return (
        <span
          className="easymove-row-status stranded"
          title="The destination file exists but there's no link at the original location. Use 'Move back' to restore it, or recreate the link manually."
        >
          link broken
        </span>
      );
    case "source-file":
      return (
        <span
          className="easymove-row-status stranded"
          title="The source exists as a regular file AND the destination also exists — DiskHound's record thinks it's linked but it isn't. Investigate before 'Move back'."
        >
          double file
        </span>
      );
    case "inaccessible":
      return (
        <span
          className="easymove-row-status"
          title="One or both ends of this move are in an ACL-locked directory (typical for C:\\ProgramData\\Microsoft\\Windows\\Virtual Hard Disks\\ and other TrustedInstaller-owned paths). Relaunch DiskHound as admin and hit Verify to confirm the link. Most likely it's fine — Windows just won't show it to non-elevated shells."
        >
          needs admin to verify
        </span>
      );
    case "ok":
      return (
        <span
          className="easymove-row-status"
          title={`Verified: source is a ${verification.sourceIsLink ? "symlink/junction" : "file"}, destination is ${formatBytes(verification.destSize)}.`}
        >
          verified
        </span>
      );
  }
}

