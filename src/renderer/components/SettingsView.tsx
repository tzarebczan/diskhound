import { useEffect, useState } from "preact/hooks";

import {
  defaultSettings,
  normalizeAppSettings,
  type AppSettings,
  type DiskDelta,
  type MonitoringSnapshot,
  type UpdateStatus,
} from "../../shared/contracts";
import { formatBytes } from "../lib/format";
import { nativeApi } from "../nativeApi";
import { dispatchSettingsUpdated } from "../lib/uiEvents";
import { toast } from "./Toasts";

export function SettingsView() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings());
  const [monitoringSnapshot, setMonitoringSnapshot] = useState<MonitoringSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void nativeApi.getSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    const refreshMonitoring = async () => {
      const snapshot = await nativeApi.getMonitoringSnapshot();
      if (!cancelled && snapshot) {
        setMonitoringSnapshot(snapshot);
      }
    };

    void refreshMonitoring();
    const intervalId = window.setInterval(() => {
      void refreshMonitoring();
    }, 15_000);
    const unsubscribe = nativeApi.onDiskDelta(() => {
      void refreshMonitoring();
    });

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      unsubscribe();
    };
  }, []);

  const save = async (next: AppSettings) => {
    const normalized = normalizeAppSettings(next);
    setSettings(normalized);
    try {
      await nativeApi.updateSettings(normalized);
      dispatchSettingsUpdated(normalized);
    } catch {
      toast("error", "Failed to save settings");
    }
  };

  if (!loaded) return null;

  return (
    <div className="settings-view">
      <div className="settings-view-inner">
      {/* ── General ── */}
      <div className="settings-section">
        <div className="settings-section-title">General</div>
        <SelectRow
          label="Theme"
          value={settings.general.theme}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
            { value: "system", label: "System" },
          ]}
          onChange={(v) => {
            const next = { ...settings, general: { ...settings.general, theme: v as "dark" | "light" | "system" } };
            void save(next);
          }}
        />
        <ToggleRow
          label="Minimize to tray"
          desc="Keep DiskHound running in the system tray when closed"
          value={settings.general.minimizeToTray}
          onChange={(v) => void save({
            ...settings,
            general: {
              ...settings.general,
              minimizeToTray: v,
              startMinimized: v ? settings.general.startMinimized : false,
            },
          })}
        />
        <ToggleRow
          label="Start minimized"
          desc={settings.general.minimizeToTray
            ? "Launch hidden in the system tray"
            : "Requires 'Minimize to tray'"}
          value={settings.general.minimizeToTray && settings.general.startMinimized}
          disabled={!settings.general.minimizeToTray}
          onChange={(v) => void save({ ...settings, general: { ...settings.general, startMinimized: v } })}
        />
        <ToggleRow
          label="Launch on startup"
          desc="Start DiskHound when you log in"
          value={settings.general.launchOnStartup}
          onChange={(v) => void save({ ...settings, general: { ...settings.general, launchOnStartup: v } })}
        />
        <ToggleRow
          label="Auto-update"
          desc="Check for and download updates in the background"
          value={settings.general.autoUpdate}
          onChange={(v) => void save({ ...settings, general: { ...settings.general, autoUpdate: v } })}
        />
        <UpdateRow />
      </div>

      {/* ── Scanning ── */}
      <div className="settings-section">
        <div className="settings-section-title">Scanning</div>
        <TextRow
          label="Default scan path"
          value={settings.scanning.defaultRootPath}
          wide
          placeholder="C:\Users\..."
          onChange={(v) => void save({ ...settings, scanning: { ...settings.scanning, defaultRootPath: v } })}
        />
        <NumberRow
          label="Top files to track"
          value={settings.scanning.topFileLimit}
          min={25}
          max={5000}
          onChange={(v) => void save({ ...settings, scanning: { ...settings.scanning, topFileLimit: v } })}
        />
        <NumberRow
          label="Top directories to track"
          value={settings.scanning.topDirectoryLimit}
          min={25}
          max={10000}
          onChange={(v) => void save({ ...settings, scanning: { ...settings.scanning, topDirectoryLimit: v } })}
        />
      </div>

      {/* ── Monitoring ── */}
      <div className="settings-section">
        <div className="settings-section-title">Drive Monitoring</div>
        <div className="settings-section-note">
          Polls free space and can schedule a full rescan. It does not yet track per-file changes in real time.
        </div>
        <MonitoringStatusPanel
          snapshot={monitoringSnapshot}
          enabled={settings.monitoring.enabled}
          defaultRootPath={settings.scanning.defaultRootPath}
        />
        <ToggleRow
          label="Enable drive monitoring"
          desc="Poll free space in the background and alert on meaningful drops"
          value={settings.monitoring.enabled}
          onChange={(v) => void save({ ...settings, monitoring: { ...settings.monitoring, enabled: v } })}
        />
        <RunNowRow defaultRootPath={settings.scanning.defaultRootPath} />
        <NumberRow
          label="Check interval (minutes)"
          value={settings.monitoring.checkIntervalMinutes}
          min={1}
          max={1440}
          onChange={(v) => void save({ ...settings, monitoring: { ...settings.monitoring, checkIntervalMinutes: v } })}
        />
        <NumberRow
          label="Alert threshold (GB)"
          value={Math.round(settings.monitoring.alertThresholdBytes / (1024 ** 3))}
          min={0}
          max={51200}
          onChange={(v) => void save({ ...settings, monitoring: { ...settings.monitoring, alertThresholdBytes: v * 1024 ** 3 } })}
        />
        <NumberRow
          label="Alert threshold (%)"
          value={settings.monitoring.alertThresholdPercent}
          min={1}
          max={100}
          onChange={(v) => void save({ ...settings, monitoring: { ...settings.monitoring, alertThresholdPercent: v } })}
        />
        <NumberRow
          label="Full re-scan interval (hours)"
          value={settings.monitoring.fullScanIntervalHours}
          min={0}
          max={720}
          desc="Set 0 to disable. Uses the default scan path above."
          onChange={(v) => void save({ ...settings, monitoring: { ...settings.monitoring, fullScanIntervalHours: v } })}
        />
        <ToggleRow
          label="Only scan when idle"
          desc="Applies to scheduled full rescans, not free-space polling"
          value={settings.monitoring.requireIdle}
          onChange={(v) => void save({ ...settings, monitoring: { ...settings.monitoring, requireIdle: v } })}
        />
        <NumberRow
          label="Idle threshold (minutes)"
          value={settings.monitoring.idleMinutes}
          min={1}
          max={240}
          desc="Only used when idle-only rescans are enabled"
          onChange={(v) => void save({ ...settings, monitoring: { ...settings.monitoring, idleMinutes: v } })}
        />
      </div>

      {/* ── Notifications ── */}
      <div className="settings-section">
        <div className="settings-section-title">Notifications</div>
        <ToggleRow label="Scan complete" value={settings.notifications.scanComplete}
          desc="Show a notification when a scan finishes"
          onChange={(v) => void save({ ...settings, notifications: { ...settings.notifications, scanComplete: v } })} />
        <ToggleRow label="Delta alerts" desc="Notify on significant free-space drops and scheduled rescan size changes" value={settings.notifications.deltaAlerts}
          onChange={(v) => void save({ ...settings, notifications: { ...settings.notifications, deltaAlerts: v } })} />
      </div>

      {/* ── Cleanup ── */}
      <div className="settings-section">
        <div className="settings-section-title">Cleanup Detection</div>
        <ToggleRow label="Detect temp files" value={settings.cleanup.autoDetectTempFiles}
          onChange={(v) => void save({ ...settings, cleanup: { ...settings.cleanup, autoDetectTempFiles: v } })} />
        <ToggleRow label="Detect build caches" value={settings.cleanup.autoDetectCaches}
          onChange={(v) => void save({ ...settings, cleanup: { ...settings.cleanup, autoDetectCaches: v } })} />
        <ToggleRow label="Detect old downloads" value={settings.cleanup.autoDetectOldDownloads}
          onChange={(v) => void save({ ...settings, cleanup: { ...settings.cleanup, autoDetectOldDownloads: v } })} />
        <NumberRow label="Old file threshold (days)" value={settings.cleanup.oldFileThresholdDays}
          min={1}
          max={3650}
          onChange={(v) => void save({ ...settings, cleanup: { ...settings.cleanup, oldFileThresholdDays: v } })} />
        <ToggleRow label="Always use Trash (never permanent delete)"
          desc="Safer default for cleanup actions"
          value={settings.cleanup.safeDeleteToTrash}
          onChange={(v) => void save({ ...settings, cleanup: { ...settings.cleanup, safeDeleteToTrash: v } })} />
      </div>
      </div>
    </div>
  );
}

function RunNowRow({ defaultRootPath }: { defaultRootPath: string }) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    const r = await nativeApi.runScheduledScanNow();
    setBusy(false);
    if (r?.ok) toast("success", "Scheduled rescan started", r.message);
    else toast("warning", "Couldn't start scheduled rescan", r?.message ?? "Unknown error");
  };

  const hasPath = Boolean(defaultRootPath);

  return (
    <div className="setting-row">
      <div>
        <div className="setting-label">Run a scheduled scan now</div>
        <div className="setting-desc">
          {hasPath
            ? `Triggers an immediate scan of ${defaultRootPath} as if the interval had elapsed.`
            : "Set a default scan path above, or run a manual scan once — DiskHound auto-fills this after the first scan."}
        </div>
      </div>
      <button
        className="action-btn"
        disabled={busy || !hasPath}
        onClick={() => void run()}
      >
        {busy ? "Starting..." : "Run now"}
      </button>
    </div>
  );
}

function UpdateRow() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    return nativeApi.onUpdateStatus(setStatus);
  }, []);

  const check = async () => {
    setChecking(true);
    await nativeApi.checkForUpdates();
    setChecking(false);
  };

  let statusText = "Never checked";
  if (status) {
    switch (status.phase) {
      case "checking":      statusText = "Checking..."; break;
      case "available":     statusText = `Update available: v${status.availableVersion}`; break;
      case "downloading":   statusText = `Downloading... ${status.downloadPercent ?? 0}%`; break;
      case "downloaded":    statusText = `Ready to install: v${status.availableVersion}`; break;
      case "up-to-date":    statusText = `Up to date (v${status.currentVersion})`; break;
      case "error":         statusText = `Error: ${status.errorMessage ?? "unknown"}`; break;
    }
  }

  const canInstall = status?.phase === "downloaded";

  return (
    <div className="setting-row">
      <div>
        <div className="setting-label">Update status</div>
        <div className="setting-desc">{statusText}</div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {canInstall ? (
          <button className="action-btn warn" onClick={() => nativeApi.quitAndInstall()}>
            Restart & install
          </button>
        ) : (
          <button className="action-btn" disabled={checking} onClick={() => void check()}>
            {checking ? "Checking..." : "Check now"}
          </button>
        )}
      </div>
    </div>
  );
}

function ToggleRow({ label, desc, value, onChange, disabled = false }: {
  label: string; desc?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <div className={`setting-row ${disabled ? "setting-row-disabled" : ""}`}>
      <div>
        <div className="setting-label">{label}</div>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      <label className="toggle">
        <input
          type="checkbox"
          checked={value}
          disabled={disabled}
          onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
        />
        <div className="toggle-track" />
        <div className="toggle-thumb" />
      </label>
    </div>
  );
}

function NumberRow({ label, value, onChange, desc, min, max }: {
  label: string; value: number; onChange: (v: number) => void; desc?: string; min?: number; max?: number;
}) {
  return (
    <div className="setting-row">
      <div>
        <div className="setting-label">{label}</div>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      <input
        className="setting-input"
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const v = parseInt((e.target as HTMLInputElement).value, 10);
          if (!isNaN(v)) {
            const next = Math.min(max ?? v, Math.max(min ?? v, v));
            onChange(next);
          }
        }}
      />
    </div>
  );
}

function MonitoringStatusPanel({
  snapshot,
  enabled,
  defaultRootPath,
}: {
  snapshot: MonitoringSnapshot | null;
  enabled: boolean;
  defaultRootPath: string;
}) {
  return (
    <div className="monitoring-card">
      <div className="monitoring-card-header">
        <div>
          <div className="monitoring-card-title">Current Status</div>
          <div className="monitoring-card-subtitle">
            {enabled ? "Background polling is active." : "Background polling is paused."}
          </div>
        </div>
        <div className={`monitoring-badge ${enabled ? "enabled" : "paused"}`}>
          {enabled ? "On" : "Off"}
        </div>
      </div>

      <div className="monitoring-meta-grid">
        <MonitoringMeta
          label="Last check"
          value={snapshot?.lastCheckedAt ? formatMonitoringTime(snapshot.lastCheckedAt) : "Not checked yet"}
        />
        <MonitoringMeta
          label="Last full scan"
          value={snapshot?.lastFullScanAt ? formatMonitoringTime(snapshot.lastFullScanAt) : "No full scan yet"}
        />
        <MonitoringMeta
          label="Scheduled root"
          value={defaultRootPath || "Not set"}
          mono
        />
      </div>

      <div className="monitoring-drive-list">
        {snapshot?.drives?.length ? (
          snapshot.drives.map((drive) => (
            <div key={drive.drive} className="monitoring-drive-row">
              <div className="monitoring-drive-head">
                <span className="monitoring-drive-name">{drive.drive}</span>
                <span className="monitoring-drive-free">{formatBytes(drive.freeBytes)} free</span>
              </div>
              <div className="monitoring-drive-bar">
                <div
                  className={`monitoring-drive-fill ${drive.usedPercent > 90 ? "high" : drive.usedPercent > 70 ? "mid" : "low"}`}
                  style={{ width: `${Math.min(100, Math.max(0, drive.usedPercent))}%` }}
                />
              </div>
            </div>
          ))
        ) : (
          <div className="monitoring-empty">No drive snapshot yet.</div>
        )}
      </div>

      <div className="monitoring-delta-list">
        <div className="monitoring-delta-title">Latest free-space changes</div>
        {snapshot?.deltas?.length ? (
          snapshot.deltas.slice(0, 4).map((delta) => (
            <MonitoringDeltaRow key={`${delta.drive}-${delta.measuredAt}`} delta={delta} />
          ))
        ) : (
          <div className="monitoring-empty">No recent free-space change above 1 MB.</div>
        )}
      </div>
    </div>
  );
}

function MonitoringMeta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="monitoring-meta">
      <div className="monitoring-meta-label">{label}</div>
      <div className={`monitoring-meta-value ${mono ? "mono" : ""}`}>{value}</div>
    </div>
  );
}

function MonitoringDeltaRow({ delta }: { delta: DiskDelta }) {
  const decreased = delta.deltaBytes < 0;
  return (
    <div className="monitoring-delta-row">
      <div className="monitoring-delta-drive">{delta.drive}</div>
      <div className={`monitoring-delta-value ${decreased ? "negative" : "positive"}`}>
        {decreased ? "-" : "+"}
        {formatBytes(Math.abs(delta.deltaBytes))}
      </div>
      <div className="monitoring-delta-time">{formatMonitoringTime(delta.measuredAt)}</div>
    </div>
  );
}

function formatMonitoringTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) {
    return "just now";
  }

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function TextRow({ label, value, onChange, placeholder, wide }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; wide?: boolean;
}) {
  return (
    <div className="setting-row">
      <div className="setting-label">{label}</div>
      <input
        className={`setting-input ${wide ? "setting-input-wide" : ""}`}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange((e.target as HTMLInputElement).value)}
      />
    </div>
  );
}

function SelectRow({ label, value, options, onChange }: {
  label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void;
}) {
  return (
    <div className="setting-row">
      <div className="setting-label">{label}</div>
      <select
        className="setting-input"
        value={value}
        onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}
