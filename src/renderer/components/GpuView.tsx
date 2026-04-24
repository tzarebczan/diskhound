import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { GpuAdapter, GpuProcessInfo, GpuSnapshot } from "../../shared/contracts";
import { formatBytes } from "../lib/format";
import { nativeApi } from "../nativeApi";
import { ProcessIcon } from "./ProcessIcon";
import { toast } from "./Toasts";

/**
 * GPU tab — an overview panel (per-adapter utilisation + VRAM + engines)
 * on top of a per-process table. Sampled on the same cadence as the
 * memory view; Get-Counter is the slow bit (~500-1500 ms cold) so we
 * render the cached snapshot instantly on mount then kick off a fresh
 * sample in the background.
 *
 * Empty-state behaviour:
 *   - No adapters + no processes + `unavailable` flag → show a neutral
 *     "GPU stats aren't available on this machine" card.
 *   - Network error / timeout → show the error with a "Retry" button.
 *   - Zero active GPU work → show adapters with 0% + a friendly
 *     "nothing is using the GPU right now" line.
 */

const REFRESH_MS = 5_000;

interface Props {
  refreshMs?: number;
}

interface ContextMenuState {
  x: number;
  y: number;
  proc: GpuProcessInfo;
}

export function GpuView({ refreshMs = REFRESH_MS }: Props) {
  const [snapshot, setSnapshot] = useState<GpuSnapshot | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Dismiss context menu on Esc or click anywhere outside it. The menu
  // itself stops click propagation so this fires only on misses.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  // Paint cached instantly, then kick off a fresh sample. Same pattern
  // as MemoryView so the tab switch is never blank.
  useEffect(() => {
    void nativeApi.getCachedGpuSnapshot().then((cached) => {
      if (!mountedRef.current) return;
      if (cached) {
        setSnapshot(cached);
        setLoading(false);
      }
    });
    const refresh = () => {
      void nativeApi.getGpuSnapshot().then((snap) => {
        if (!mountedRef.current) return;
        setSnapshot(snap);
        setLoading(false);
      });
    };
    refresh();
    const id = window.setInterval(refresh, refreshMs);
    return () => window.clearInterval(id);
  }, [refreshMs]);

  const processes = useMemo(() => {
    if (!snapshot) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return snapshot.processes;
    return snapshot.processes.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        String(p.pid) === q ||
        (p.exePath?.toLowerCase().includes(q) ?? false),
    );
  }, [snapshot, filter]);

  if (loading) {
    return (
      <div className="gpu-view">
        <div className="gpu-view-empty">
          <div className="gpu-view-empty-spinner" aria-hidden="true" />
          <div>Sampling GPU…</div>
          <div className="gpu-view-empty-sub">First read takes ~1 second.</div>
        </div>
      </div>
    );
  }

  if (!snapshot || snapshot.unavailable) {
    return (
      <div className="gpu-view">
        <div className="gpu-view-empty">
          <div className="gpu-view-empty-icon">◇</div>
          <div>GPU stats aren't available on this machine.</div>
          <div className="gpu-view-empty-sub">
            {snapshot?.errorMessage
              ? `Sampler error: ${snapshot.errorMessage}`
              : "Windows exposes GPU counters only when a WDDM 2.0+ driver is installed. VMs and some older integrated GPUs won't show usage here."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="gpu-view">
      {/* Overview — one card per adapter */}
      <div className="gpu-overview">
        {snapshot.adapters.map((a) => (
          <GpuAdapterCard key={a.id} adapter={a} />
        ))}
      </div>

      {/* Per-process header + filter */}
      <div className="gpu-process-header">
        <div className="gpu-process-title">
          Processes using the GPU
          <span className="gpu-process-count">
            · {snapshot.processes.length}
          </span>
        </div>
        <input
          className="filter-input"
          placeholder="Filter processes…"
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        />
      </div>

      {/* Process table */}
      <div className="gpu-process-scroll">
        {processes.length === 0 ? (
          <div className="empty-view">
            <span>
              {filter
                ? "No processes match the filter"
                : "Nothing is using the GPU right now."}
            </span>
          </div>
        ) : (
          <>
            <div className="gpu-process-col-header">
              <div className="gpu-process-col-icon" />
              <div className="gpu-process-col-name">Process</div>
              <div className="gpu-process-col-util">GPU</div>
              <div className="gpu-process-col-mem">VRAM</div>
              <div className="gpu-process-col-shared">Shared</div>
              <div className="gpu-process-col-engines">Engines</div>
              <div className="gpu-process-col-pid">PID</div>
            </div>
            {processes.map((p) => (
              <GpuProcessRow
                key={p.pid}
                proc={p}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  setContextMenu({
                    x: (ev as MouseEvent).clientX,
                    y: (ev as MouseEvent).clientY,
                    proc: p,
                  });
                }}
              />
            ))}
          </>
        )}
      </div>

      <div className="gpu-view-footer">
        Sampled in {snapshot.sampleElapsedMs} ms
        {snapshot.errorMessage && (
          <span
            className="gpu-view-footer-error"
            title={snapshot.errorMessage}
          >
            {/* Error messages from execFile can be very long — they
                include the full PowerShell script text on timeout.
                Summarise to a terse category and put the full text in
                a hover tooltip so users can copy it if needed. */}
            · {summarizeGpuError(snapshot.errorMessage)}
          </span>
        )}
      </div>

      {contextMenu && (
        <GpuProcessContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          proc={contextMenu.proc}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

// ── Adapter card ────────────────────────────────────────────────────────

function GpuAdapterCard({ adapter }: { adapter: GpuAdapter }) {
  const vramTotal = adapter.dedicatedBytesTotal;
  const vramUsed = adapter.dedicatedBytesUsed;
  const vramPct =
    vramTotal && vramTotal > 0
      ? Math.min(100, (vramUsed / vramTotal) * 100)
      : null;
  const util = Math.min(100, adapter.utilizationPercent);
  const utilClass = util > 80 ? "high" : util > 40 ? "mid" : "low";
  return (
    <div className="gpu-adapter-card">
      <div className="gpu-adapter-header">
        <div className="gpu-adapter-name" title={adapter.id}>
          {adapter.name}
        </div>
        {adapter.driverVersion && (
          <div className="gpu-adapter-driver">
            driver {adapter.driverVersion}
          </div>
        )}
      </div>
      <div className="gpu-adapter-stats">
        {/* Utilisation */}
        <div className="gpu-stat">
          <div className="gpu-stat-label">Utilisation</div>
          <div className="gpu-stat-value-row">
            <span className={`gpu-stat-value ${utilClass}`}>
              {util.toFixed(0)}%
            </span>
          </div>
          <div className="gpu-stat-bar">
            <div
              className={`gpu-stat-bar-fill ${utilClass}`}
              style={{ width: `${util}%` }}
            />
          </div>
        </div>
        {/* Dedicated VRAM */}
        <div className="gpu-stat">
          <div className="gpu-stat-label">Dedicated VRAM</div>
          <div className="gpu-stat-value-row">
            <span className="gpu-stat-value">{formatBytes(vramUsed)}</span>
            {vramTotal && (
              <span className="gpu-stat-value-sub">
                / {formatBytes(vramTotal)}
              </span>
            )}
          </div>
          {vramPct !== null && (
            <div className="gpu-stat-bar">
              <div
                className="gpu-stat-bar-fill"
                style={{ width: `${vramPct}%` }}
              />
            </div>
          )}
        </div>
        {/* Shared */}
        <div className="gpu-stat">
          <div className="gpu-stat-label">Shared memory</div>
          <div className="gpu-stat-value-row">
            <span className="gpu-stat-value">
              {formatBytes(adapter.sharedBytesUsed)}
            </span>
          </div>
        </div>
      </div>
      {/* Engine breakdown */}
      {Object.keys(adapter.enginePercent).length > 0 && (
        <div className="gpu-adapter-engines">
          {Object.entries(adapter.enginePercent)
            .sort((a, b) => b[1] - a[1])
            .map(([engine, pct]) => (
              <EngineChip key={engine} label={engine} percent={pct} />
            ))}
        </div>
      )}
    </div>
  );
}

// ── Process row ─────────────────────────────────────────────────────────

function GpuProcessRow({
  proc,
  onContextMenu,
}: {
  proc: GpuProcessInfo;
  onContextMenu: (ev: Event) => void;
}) {
  const util = Math.min(100, proc.utilizationPercent);
  const utilClass = util > 60 ? "high" : util > 20 ? "mid" : "low";
  // Pick the top-2 engines for the row-level summary; rest shown on hover.
  const topEngines = Object.entries(proc.enginePercent)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);
  const allEngines = Object.entries(proc.enginePercent)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v.toFixed(0)}%`)
    .join(" · ");
  return (
    <div
      className="gpu-process-row"
      onContextMenu={onContextMenu as any}
      title={`${proc.name} · PID ${proc.pid}${proc.exePath ? "\n" + proc.exePath : ""}${allEngines ? "\n\nEngines: " + allEngines : ""}\n\nRight-click for actions`}
    >
      <div className="gpu-process-col-icon">
        <ProcessIcon
          exePath={proc.exePath ?? null}
          className="gpu-process-icon-img"
        />
      </div>
      <div className="gpu-process-col-name">{proc.name}</div>
      <div className="gpu-process-col-util">
        <span className={`gpu-process-util-value ${utilClass}`}>
          {util.toFixed(0)}%
        </span>
        <div className="gpu-process-util-bar">
          <div
            className={`gpu-process-util-bar-fill ${utilClass}`}
            style={{ width: `${util}%` }}
          />
        </div>
      </div>
      <div className="gpu-process-col-mem">
        {proc.dedicatedBytes > 0 ? formatBytes(proc.dedicatedBytes) : "—"}
      </div>
      <div className="gpu-process-col-shared">
        {proc.sharedBytes > 0 ? formatBytes(proc.sharedBytes) : "—"}
      </div>
      <div className="gpu-process-col-engines">
        {topEngines.length === 0
          ? "—"
          : topEngines.map(([label, pct]) => (
              <EngineChip key={label} label={label} percent={pct} compact />
            ))}
      </div>
      <div className="gpu-process-col-pid">{proc.pid}</div>
    </div>
  );
}

// ── Engine chip ─────────────────────────────────────────────────────────

function EngineChip({
  label,
  percent,
  compact,
}: {
  label: string;
  percent: number;
  compact?: boolean;
}) {
  const pct = Math.min(100, percent);
  const cls = pct > 60 ? "hot" : pct > 20 ? "warm" : "cool";
  return (
    <span
      className={`gpu-engine-chip ${cls} ${compact ? "compact" : ""}`}
      title={`${label} · ${percent.toFixed(1)}%`}
    >
      <span className="gpu-engine-chip-label">{label}</span>
      <span className="gpu-engine-chip-value">{pct.toFixed(0)}%</span>
    </span>
  );
}

// ── Error summarisation ─────────────────────────────────────────────────
//
// execFile error messages include the full command line on failure —
// for our GPU sampler that's the entire PowerShell script, which
// flooded the footer with "Command failed: powershell.exe -NoProfile
// -NonInteractive -Command $ErrorActionPreference = ..." and buried
// the actually-useful bit. This extracts just the cause, keeping the
// full message in the hover tooltip.

function summarizeGpuError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("etimedout") || lower.includes("timed out")) {
    return "timeout — Get-Counter took too long (typically a slow WMI provider)";
  }
  if (lower.includes("unexpected token") || lower.includes("json")) {
    return "couldn't parse PowerShell output";
  }
  if (lower.includes("command failed")) {
    return "PowerShell error — hover for details";
  }
  // Fallback: trim to a manageable length.
  return raw.length > 120 ? raw.slice(0, 120) + "…" : raw;
}

// ── Context menu ────────────────────────────────────────────────────────
//
// Deliberately a subset of the Processes-tab menu: Reveal, Copy path,
// End / Force kill. CPU-affinity + rule pinning live in the Processes
// tab to avoid duplicating a complex UI — hover copy points users
// there. The kill actions share the same IPC (nativeApi.killProcess)
// as the List / Treemap / Heatmap views.

function GpuProcessContextMenu({
  x,
  y,
  proc,
  onClose,
}: {
  x: number;
  y: number;
  proc: GpuProcessInfo;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = x + rect.width > window.innerWidth ? x - rect.width : x;
    const ny = y + rect.height > window.innerHeight ? y - rect.height : y;
    setPos({ x: Math.max(4, nx), y: Math.max(4, ny) });
  }, [x, y]);

  const act = (fn: () => void) => {
    onClose();
    fn();
  };

  const kill = async (hard: boolean) => {
    setBusy(true);
    const res = await nativeApi.killProcess(proc.pid, hard ? "hard" : "soft");
    setBusy(false);
    if (res.ok) {
      toast(
        "success",
        hard ? "Process killed" : "Termination requested",
        `PID ${proc.pid} · ${proc.name}`,
      );
    } else {
      toast("error", "Couldn't end process", res.message);
    }
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="process-ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      role="menu"
    >
      <div className="process-ctx-header">
        <div className="process-ctx-name">{proc.name}</div>
        <div className="process-ctx-meta">
          PID {proc.pid} · {proc.utilizationPercent.toFixed(0)}% GPU
          {proc.dedicatedBytes > 0 && ` · ${formatBytes(proc.dedicatedBytes)} VRAM`}
        </div>
      </div>
      {proc.exePath && (
        <>
          <button
            className="process-ctx-item"
            role="menuitem"
            onClick={() => act(() => void nativeApi.revealPath(proc.exePath!))}
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
              <path d="M1.5 3.5V11.5C1.5 12.05 1.95 12.5 2.5 12.5H11.5C12.05 12.5 12.5 12.05 12.5 11.5V5.5C12.5 4.95 12.05 4.5 11.5 4.5H7L5.5 2.5H2.5C1.95 2.5 1.5 2.95 1.5 3.5Z" />
            </svg>
            Reveal executable
          </button>
          <button
            className="process-ctx-item"
            role="menuitem"
            onClick={() =>
              act(() => {
                void navigator.clipboard.writeText(proc.exePath!).then(
                  () => toast("success", "Path copied", proc.exePath!),
                  () => toast("error", "Couldn't copy path"),
                );
              })
            }
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
              <rect x="4" y="4" width="8" height="9" rx="1" />
              <path d="M4 4V3C4 2.45 4.45 2 5 2H9C9.55 2 10 2.45 10 3V4" />
            </svg>
            Copy path
          </button>
          <div className="process-ctx-divider" />
        </>
      )}
      <button
        className="process-ctx-item"
        role="menuitem"
        title="Set CPU affinity or pin a persistent rule — opens the Processes tab where these actions live."
        onClick={() =>
          act(() => {
            toast(
              "info",
              "CPU affinity lives in Processes",
              `Right-click ${proc.name} in the Processes tab for Set-affinity / Pin-rule.`,
            );
          })
        }
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
          <rect x="2" y="2" width="4" height="4" />
          <rect x="8" y="2" width="4" height="4" />
          <rect x="2" y="8" width="4" height="4" />
          <rect x="8" y="8" width="4" height="4" />
        </svg>
        CPU affinity… (via Processes tab)
      </button>
      <div className="process-ctx-divider" />
      <button
        className="process-ctx-item process-ctx-warn"
        role="menuitem"
        disabled={busy}
        onClick={() => void kill(false)}
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
          <circle cx="7" cy="7" r="5.5" />
          <path d="M7 4V7.5" />
        </svg>
        End (graceful)
      </button>
      <button
        className="process-ctx-item process-ctx-danger"
        role="menuitem"
        disabled={busy}
        onClick={() => void kill(true)}
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
          <path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" />
        </svg>
        Force kill
      </button>
    </div>
  );
}
