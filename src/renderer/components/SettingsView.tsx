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
          label="Launch on startup"
          desc="Start DiskHound when you log in to your computer"
          value={settings.general.launchOnStartup}
          onChange={(v) => void save({ ...settings, general: { ...settings.general, launchOnStartup: v } })}
        />
        <ToggleRow
          label="Start minimized on OS login"
          desc={
            !settings.general.minimizeToTray
              ? "Requires 'Minimize to tray'"
              : !settings.general.launchOnStartup
                ? "Requires 'Launch on startup'"
                : "When DiskHound auto-launches at OS login, hide in the tray instead of showing the window. Manual launches, post-install, and post-update restarts always show the window."
          }
          value={
            settings.general.minimizeToTray &&
            settings.general.launchOnStartup &&
            settings.general.startMinimized
          }
          disabled={
            !settings.general.minimizeToTray ||
            !settings.general.launchOnStartup
          }
          onChange={(v) => void save({ ...settings, general: { ...settings.general, startMinimized: v } })}
        />
        <ToggleRow
          label="Auto-update"
          desc="Check for and download updates in the background"
          value={settings.general.autoUpdate}
          onChange={(v) => void save({ ...settings, general: { ...settings.general, autoUpdate: v } })}
        />
        <ToggleRow
          label="Color-blind friendly palette"
          desc="Swaps red/green-heavy color cues for an Okabe-Ito palette (orange, sky blue, bluish-green, yellow). Affects treemap colors, folder subtree bars, Changes tab deltas, and status indicators."
          value={settings.general.colorBlindMode}
          onChange={(v) => void save({ ...settings, general: { ...settings.general, colorBlindMode: v } })}
        />
        <UpdateRow />
        <CrashLogRow />
      </div>

      {/* "Default scan path" is no longer user-editable — it auto-populates
       * from the most recent manual scan (see main.ts defaultRootPath seed
       * logic). One less knob to tune; the app reopens to the last-
       * scanned root automatically on launch. */}

      {/* ── Performance / Elevation ── */}
      <PerformanceSection />

      {/* ── Monitoring ── */}
      <div className="settings-section">
        <div className="settings-section-title">Drive Monitoring</div>
        <div className="settings-section-note">
          Polls free space and can schedule a full rescan. It does not yet track per-file changes in real time.
        </div>
        <MonitoringStatusPanel
          snapshot={monitoringSnapshot}
          enabled={settings.monitoring.enabled}
          excludedDrives={settings.monitoring.excludedDrives}
          onToggleDrive={(drive) => {
            const upper = drive.toUpperCase();
            const current = settings.monitoring.excludedDrives;
            const isCurrentlyExcluded = current.some((d) => d.toUpperCase() === upper);
            const next = isCurrentlyExcluded
              ? current.filter((d) => d.toUpperCase() !== upper)
              : [...current, drive];
            void save({
              ...settings,
              monitoring: { ...settings.monitoring, excludedDrives: next },
            });
          }}
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
          label="Full re-scan interval (minutes)"
          value={settings.monitoring.fullScanIntervalMinutes}
          min={0}
          max={30 * 24 * 60}
          desc="How often to rescan the default path. Set 0 to disable. Fresh scans populate the Changes tab."
          onChange={(v) => void save({ ...settings, monitoring: { ...settings.monitoring, fullScanIntervalMinutes: v } })}
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

/**
 * Fast-scan (MFT) elevation controls. Three states:
 *
 *   1. Not elevated, no scheduled task registered → show "Enable fast
 *      scans" primary CTA (relaunch-as-admin) + secondary
 *      "Always run as admin" (scheduled task, one UAC prompt now,
 *      zero UAC prompts forever after).
 *
 *   2. Elevated, no scheduled task → show success status + offer the
 *      "always elevated" opt-in. (User is elevated this session;
 *      scheduled task makes it permanent.)
 *
 *   3. Scheduled task registered → show success + "Disable" button.
 *      Whether we're currently elevated in THIS process doesn't
 *      matter UX-wise at this point — user has committed.
 */
function PerformanceSection() {
  const [status, setStatus] = useState<
    { elevated: boolean; scheduledTaskRegistered: boolean } | null
  >(null);
  const [busy, setBusy] = useState<"relaunch" | "register" | "unregister" | "run" | null>(null);

  useEffect(() => {
    let cancelled = false;
    void nativeApi.getElevationStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => { cancelled = true; };
  }, []);

  if (!status) return null;

  const relaunch = async () => {
    setBusy("relaunch");
    const result = await nativeApi.relaunchAsAdmin();
    setBusy(null);
    if (!result.ok) toast("error", result.message ?? "Couldn't relaunch as admin");
  };
  const registerTask = async () => {
    setBusy("register");
    const result = await nativeApi.registerScheduledTask();
    setBusy(null);
    if (result.ok) {
      toast("success", "Fast scans enabled", "Future launches will skip the UAC prompt.");
      setStatus({ ...status, scheduledTaskRegistered: true });
    } else {
      toast("error", "Couldn't register scheduled task", "UAC may have been cancelled.");
    }
  };
  const unregisterTask = async () => {
    setBusy("unregister");
    const result = await nativeApi.unregisterScheduledTask();
    setBusy(null);
    if (result.ok) {
      toast("success", "Fast-scan auto-elevation disabled");
      setStatus({ ...status, scheduledTaskRegistered: false });
    } else {
      toast("error", "Couldn't unregister scheduled task");
    }
  };
  const runTaskNow = async () => {
    setBusy("run");
    const result = await nativeApi.runScheduledTask();
    setBusy(null);
    if (!result.ok) {
      // Surface the actual schtasks error instead of a generic toast.
      // Common cases we now communicate clearly:
      //   - "The system cannot find the file specified": task points
      //     at a stale exe path (app reinstalled to a different
      //     location). Tell the user to re-register.
      //   - "Access is denied": pre-0.4.4 task was created with
      //     Principal=Administrators group SID and the invoking user
      //     (even if in that group) can't run it. Disable+Enable
      //     re-registers with the current user's SID, fixing this.
      //   - Blank / exit 1: schtasks itself crashed; offer the
      //     "Unregister + re-register" recovery path.
      const lower = result.message?.toLowerCase() ?? "";
      const looksLikeStalePath =
        lower.includes("cannot find the file") ||
        lower.includes("cannot find the path");
      const looksLikeOldPrincipal = lower.includes("access is denied") || lower.includes("access denied");
      const needsReRegister = looksLikeStalePath || looksLikeOldPrincipal;
      toast(
        "error",
        "Couldn't launch via scheduled task",
        needsReRegister
          ? `${result.message} — try "Disable" then "Enable" to re-register the task.`
          : result.message,
      );
    }
  };

  const statusLabel = status.scheduledTaskRegistered
    ? "Fast scans enabled (auto-elevated on launch)"
    : status.elevated
      ? "Running elevated — MFT fast-scan path active"
      : "Using compatibility walker (10-20× slower)";
  const statusKind: "ok" | "warn" = status.scheduledTaskRegistered || status.elevated ? "ok" : "warn";

  return (
    <div className="settings-section">
      <div className="settings-section-title">Performance</div>
      <div className="settings-section-note">
        On NTFS drives (typical Windows system drives), DiskHound can read
        the Master File Table directly for 10-20× faster scans — but this
        requires admin. Without admin, scans use the compatibility walker:
        correct but slower.
      </div>
      <div className={`perf-status perf-status-${statusKind}`}>
        <span className="perf-status-dot" />
        <span>{statusLabel}</span>
      </div>

      <div className="perf-actions">
        {!status.elevated && !status.scheduledTaskRegistered && (
          <button
            className="action-btn primary"
            disabled={busy !== null}
            onClick={relaunch}
          >
            {busy === "relaunch" ? "Relaunching…" : "Relaunch as admin (this session)"}
          </button>
        )}

        {!status.scheduledTaskRegistered && (
          <button
            className="action-btn"
            disabled={busy !== null}
            onClick={registerTask}
            title="Creates a Scheduled Task so future launches run elevated without a UAC prompt"
          >
            {busy === "register" ? "Registering…" : "Always run as admin (no more UAC prompts)"}
          </button>
        )}

        {status.scheduledTaskRegistered && !status.elevated && (
          <button
            className="action-btn primary"
            disabled={busy !== null}
            onClick={runTaskNow}
            title="Launches DiskHound elevated via the registered scheduled task"
          >
            {busy === "run" ? "Launching…" : "Relaunch elevated now"}
          </button>
        )}

        {status.scheduledTaskRegistered && (
          <button
            className="action-btn warn"
            disabled={busy !== null}
            onClick={unregisterTask}
            title="Removes the Scheduled Task. Future launches will require UAC again."
          >
            {busy === "unregister" ? "Removing…" : "Disable auto-elevation"}
          </button>
        )}
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
  // Seeded from the persisted updater-state.json so "Last checked 4h ago"
  // survives restarts instead of falling back to "Never" every cold boot.
  const [persistedLastCheckedAt, setPersistedLastCheckedAt] = useState<number | null>(null);

  useEffect(() => {
    const unsub = nativeApi.onUpdateStatus((s) => {
      setStatus(s);
      if (typeof s.lastCheckedAt === "number") {
        setPersistedLastCheckedAt(s.lastCheckedAt);
      }
    });
    // Load the persisted last-checked timestamp on mount.
    void nativeApi.getUpdateState().then((state) => {
      if (state) setPersistedLastCheckedAt(state.lastCheckedAt);
    });
    return unsub;
  }, []);

  const check = async () => {
    setChecking(true);
    await nativeApi.checkForUpdates();
    setChecking(false);
  };

  const formatLastChecked = (ts: number): string => {
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`;
    return `${Math.floor(diff / (24 * 60 * 60_000))}d ago`;
  };

  let statusText = persistedLastCheckedAt
    ? `Last checked ${formatLastChecked(persistedLastCheckedAt)}`
    : "Never checked";
  if (status) {
    switch (status.phase) {
      case "checking":      statusText = "Checking..."; break;
      case "available":     statusText = `Update available: v${status.availableVersion}`; break;
      case "downloading":   statusText = `Downloading... ${status.downloadPercent ?? 0}%`; break;
      case "downloaded":    statusText = `Ready to install: v${status.availableVersion}`; break;
      case "up-to-date":
        statusText = `Up to date (v${status.currentVersion})${
          persistedLastCheckedAt ? ` · checked ${formatLastChecked(persistedLastCheckedAt)}` : ""
        }`;
        break;
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

/**
 * Inline viewer + "reveal" affordance for the crash.log file the main
 * process maintains under %APPDATA%/DiskHound. Users don't typically
 * open this; the button is here so when something goes wrong we can
 * say "click View crash log and send me the contents" without having
 * to explain where the file lives.
 */
function CrashLogRow() {
  const [expanded, setExpanded] = useState(false);
  const [log, setLog] = useState<{ path: string; sizeBytes: number; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (!expanded) {
      setLoading(true);
      const result = await nativeApi.getCrashLog();
      setLog(result);
      setLoading(false);
    }
    setExpanded((v) => !v);
  };

  const reveal = () => nativeApi.revealCrashLog();

  const hasText = Boolean(log?.text?.trim());

  return (
    <div className="setting-row setting-row-stack">
      <div className="setting-row-main">
        <div>
          <div className="setting-label">Crash log</div>
          <div className="setting-desc">
            {log
              ? log.sizeBytes === 0
                ? "Nothing logged — if something goes wrong, check back here."
                : `${(log.sizeBytes / 1024).toFixed(1)} KB on disk.`
              : "Main-process exceptions, worker failures, and renderer errors land in a single file you can share."}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="action-btn" onClick={() => void toggle()}>
            {expanded ? "Hide" : loading ? "Loading…" : "View"}
          </button>
          <button className="action-btn" onClick={reveal} title="Open the DiskHound data folder in Explorer / Finder">
            Open folder
          </button>
        </div>
      </div>
      {expanded && (
        <pre className="settings-crash-log-pane">
          {hasText ? log!.text : "No crash log entries yet."}
        </pre>
      )}
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
  excludedDrives,
  onToggleDrive,
}: {
  snapshot: MonitoringSnapshot | null;
  enabled: boolean;
  excludedDrives: string[];
  onToggleDrive: (drive: string) => void;
}) {
  const excludedSet = new Set(excludedDrives.map((d) => d.toUpperCase()));
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
      </div>

      <div className="monitoring-drive-list">
        {snapshot?.drives?.length ? (
          <>
            <div className="monitoring-drive-list-header">
              <span>Drives</span>
              <span className="monitoring-drive-list-hint">
                uncheck to exclude from alerts
              </span>
            </div>
            {snapshot.drives.map((drive) => {
              const isIncluded = !excludedSet.has(drive.drive.toUpperCase());
              return (
                <label
                  key={drive.drive}
                  className={`monitoring-drive-row ${!enabled ? "dimmed" : ""} ${!isIncluded ? "excluded" : ""}`}
                >
                  <input
                    type="checkbox"
                    className="monitoring-drive-toggle"
                    checked={isIncluded}
                    disabled={!enabled}
                    onChange={() => onToggleDrive(drive.drive)}
                    title={isIncluded ? `Exclude ${drive.drive} from alerts` : `Include ${drive.drive} in alerts`}
                  />
                  <div className="monitoring-drive-body">
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
                </label>
              );
            })}
          </>
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
