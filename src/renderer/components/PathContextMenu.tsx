import { useEffect, useRef, useState } from "preact/hooks";

import {
  basenameForPath,
  parentFolderOfPath,
} from "../../shared/pathProtection";
import { useExcludedFolderProtection } from "../lib/hooks";
import { toast } from "./Toasts";

export function PathContextMenu({
  x,
  y,
  path,
  isDirectory,
  onClose,
}: {
  x: number;
  y: number;
  path: string;
  isDirectory: boolean;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const { findProtectedFolder, addExcludedFolder } = useExcludedFolderProtection();
  const folderToProtect = isDirectory ? path : parentFolderOfPath(path);
  const protectedBy = findProtectedFolder(path);

  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = x + rect.width > window.innerWidth ? x - rect.width : x;
    const ny = y + rect.height > window.innerHeight ? y - rect.height : y;
    setPos({ x: Math.max(0, nx), y: Math.max(0, ny) });
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      className="treemap-ctx-menu path-ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <div className="treemap-ctx-header">
        <div className="treemap-ctx-filename">{basenameForPath(path)}</div>
      </div>
      <div className="treemap-ctx-path">{path}</div>
      {protectedBy && (
        <div className="path-ctx-protected">
          Protected by {protectedBy}
        </div>
      )}
      <div className="treemap-ctx-divider" />
      <button
        className="treemap-ctx-item"
        onClick={() => {
          onClose();
          void navigator.clipboard.writeText(path).then(
            () => toast("success", "Path copied", path),
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
      <button
        className="treemap-ctx-item"
        disabled={!folderToProtect || Boolean(protectedBy)}
        title={
          protectedBy
            ? `Already protected by ${protectedBy}`
            : folderToProtect
              ? `Protect ${folderToProtect}`
              : "No parent folder available"
        }
        onClick={() => {
          if (!folderToProtect) return;
          onClose();
          void addExcludedFolder(folderToProtect);
        }}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M7 1.5L11.5 3.5V6.5C11.5 9.35 9.7 11.5 7 12.5C4.3 11.5 2.5 9.35 2.5 6.5V3.5L7 1.5Z" />
          <path d="M5 7L6.4 8.4L9.2 5.5" />
        </svg>
        {isDirectory ? "Protect this folder" : "Protect parent folder"}
      </button>
    </div>
  );
}
