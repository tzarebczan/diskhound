import { useEffect, useState } from "preact/hooks";

import type { DiskSpaceInfo, RecentScan } from "../../shared/contracts";
import { formatBytes, relativeTime } from "../lib/format";
import { nativeApi } from "../nativeApi";

interface Props {
  onScanDrive: (drivePath: string) => void;
  onScanFolder: (folderPath: string) => void;
}

export function DiskPicker({ onScanDrive, onScanFolder }: Props) {
  const [drives, setDrives] = useState<DiskSpaceInfo[]>([]);
  const [recents, setRecents] = useState<RecentScan[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [d, r] = await Promise.all([
        nativeApi.getDiskSpace(),
        nativeApi.getRecentScans(),
      ]);
      if (!cancelled) {
        setDrives((d as DiskSpaceInfo[] | null) ?? []);
        setRecents((r as RecentScan[] | null) ?? []);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const browseFolder = async () => {
    const picked = await nativeApi.pickRootPath();
    if (picked) onScanFolder(picked);
  };

  return (
    <div className="picker-backdrop">
      <div className="picker-card">
        {/* Brand header */}
        <div className="picker-header">
          <div className="picker-logo">
            <svg width="28" height="28" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.2" />
              <rect x="3.5" y="3.5" width="4.5" height="4.5" fill="currentColor" opacity="0.85" />
              <rect x="8.5" y="3.5" width="4" height="9" fill="currentColor" opacity="0.5" />
              <rect x="3.5" y="8.5" width="4.5" height="4" fill="currentColor" opacity="0.3" />
            </svg>
            <span>DiskHound</span>
          </div>
          <p className="picker-subtitle">Pick a drive to scan, or choose a specific folder.</p>
        </div>

        {/* Drive cards */}
        <div className="picker-section-label">Drives</div>
        <div className="picker-drives">
          {loading ? (
            <div className="picker-loading">Detecting drives...</div>
          ) : drives.length === 0 ? (
            <div className="picker-loading">No drives detected</div>
          ) : (
            drives.map((d) => (
              <DriveCard
                key={d.drive}
                drive={d}
                onScan={() => {
                  // Build drive root: "C:" → "C:\" on Windows, "/" stays "/"
                  const root = d.drive.endsWith("\\") || d.drive.endsWith("/")
                    ? d.drive
                    : d.drive.includes(":")
                      ? `${d.drive}\\`
                      : d.drive;
                  onScanDrive(root);
                }}
              />
            ))
          )}
        </div>

        {/* Folder browser */}
        <div className="picker-divider">
          <span>or scan a specific folder</span>
        </div>
        <button className="picker-browse-btn" onClick={() => void browseFolder()}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M1.5 3.5V11.5C1.5 12.05 1.95 12.5 2.5 12.5H11.5C12.05 12.5 12.5 12.05 12.5 11.5V5.5C12.5 4.95 12.05 4.5 11.5 4.5H7L5.5 2.5H2.5C1.95 2.5 1.5 2.95 1.5 3.5Z" />
          </svg>
          Browse for folder...
        </button>

        {/* Recent scans */}
        {recents.length > 0 && (
          <>
            <div className="picker-section-label" style={{ marginTop: 16 }}>Recent Scans</div>
            <div className="picker-recents">
              {recents.slice(0, 5).map((r) => (
                <RecentRow
                  key={r.path}
                  recent={r}
                  onRescan={() => onScanDrive(r.path)}
                />
              ))}
            </div>
          </>
        )}

        {/* Footer spacing */}
        <div style={{ height: 4 }} />
      </div>
    </div>
  );
}

function DriveCard({ drive, onScan }: { drive: DiskSpaceInfo; onScan: () => void }) {
  const pct = drive.usedPercent;
  const level = pct > 90 ? "critical" : pct > 75 ? "warn" : "ok";

  const driveLabel = drive.drive.includes(":")
    ? drive.drive.replace(":", "")
    : drive.drive;

  return (
    <button className="drive-card" onClick={onScan}>
      <div className="drive-card-icon">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <rect x="2" y="4" width="18" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
          <rect x="4" y="14" width="14" height="2" rx="0.5" fill="currentColor" opacity="0.15" />
          <circle cx="16" cy="15" r="1" fill="currentColor" opacity="0.5" />
        </svg>
      </div>

      <div className="drive-card-info">
        <div className="drive-card-name">{driveLabel}:</div>
        <div className="drive-card-bar">
          <div className={`drive-card-fill ${level}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="drive-card-stats">
          <span>{formatBytes(drive.usedBytes)} used</span>
          <span className="drive-card-free">{formatBytes(drive.freeBytes)} free</span>
          <span>{formatBytes(drive.totalBytes)} total</span>
        </div>
      </div>

      <div className="drive-card-action">
        <span className="drive-card-scan-label">Scan</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4.5 2.5L8.5 6L4.5 9.5" />
        </svg>
      </div>
    </button>
  );
}

function RecentRow({ recent, onRescan }: { recent: RecentScan; onRescan: () => void }) {
  const age = relativeTime(recent.scannedAt);

  return (
    <button className="recent-row" onClick={onRescan}>
      <div>
        <div className="recent-path">{recent.path}</div>
        <div className="recent-meta">
          <span>{formatBytes(recent.bytesFound)}</span>
          <span>&middot;</span>
          <span>{recent.filesFound.toLocaleString()} files</span>
          <span>&middot;</span>
          <span>{age}</span>
        </div>
      </div>
      <svg className="recent-arrow" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3">
        <path d="M3.5 2L7 5L3.5 8" />
      </svg>
    </button>
  );
}

