import { useEffect, useState } from "preact/hooks";

import { defaultSettings, type AppSettings } from "../../shared/contracts";
import { nativeApi } from "../nativeApi";
import { toast } from "./Toasts";

export function SettingsView() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void nativeApi.getSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
  }, []);

  const save = async (next: AppSettings) => {
    setSettings(next);
    try {
      await nativeApi.updateSettings(next);
    } catch {
      toast("error", "Failed to save settings");
    }
  };

  if (!loaded) return null;

  return (
    <div className="settings-view">
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
            void save(next).then(() => {
              // Apply theme immediately
              const root = document.documentElement;
              root.classList.remove("light", "dark");
              const resolved = v === "light" ? "light"
                : v === "system" && window.matchMedia("(prefers-color-scheme: light)").matches ? "light"
                : "dark";
              if (resolved === "light") root.classList.add("light");
              nativeApi.applyTheme(resolved as "dark" | "light");
            });
          }}
        />
        <ToggleRow
          label="Minimize to tray"
          desc="Keep DiskHound running in the system tray when closed"
          value={settings.general.minimizeToTray}
          onChange={(v) => void save({ ...settings, general: { ...settings.general, minimizeToTray: v } })}
        />
        <ToggleRow
          label="Start minimized"
          desc="Launch hidden in the system tray"
          value={settings.general.startMinimized}
          onChange={(v) => void save({ ...settings, general: { ...settings.general, startMinimized: v } })}
        />
        <ToggleRow
          label="Launch on startup"
          desc="Start DiskHound when you log in"
          value={settings.general.launchOnStartup}
          onChange={(v) => void save({ ...settings, general: { ...settings.general, launchOnStartup: v } })}
        />
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
          onChange={(v) => void save({ ...settings, scanning: { ...settings.scanning, topFileLimit: v } })}
        />
        <NumberRow
          label="Top directories to track"
          value={settings.scanning.topDirectoryLimit}
          onChange={(v) => void save({ ...settings, scanning: { ...settings.scanning, topDirectoryLimit: v } })}
        />
      </div>

      {/* ── Monitoring ── */}
      <div className="settings-section">
        <div className="settings-section-title">Background Monitoring</div>
        <ToggleRow
          label="Enable disk monitoring"
          desc="Periodically check free space and alert on changes"
          value={settings.monitoring.enabled}
          onChange={(v) => void save({ ...settings, monitoring: { ...settings.monitoring, enabled: v } })}
        />
        <NumberRow
          label="Check interval (minutes)"
          value={settings.monitoring.checkIntervalMinutes}
          onChange={(v) => void save({ ...settings, monitoring: { ...settings.monitoring, checkIntervalMinutes: v } })}
        />
        <NumberRow
          label="Alert threshold (GB)"
          value={Math.round(settings.monitoring.alertThresholdBytes / (1024 ** 3))}
          onChange={(v) => void save({ ...settings, monitoring: { ...settings.monitoring, alertThresholdBytes: v * 1024 ** 3 } })}
        />
        <NumberRow
          label="Alert threshold (%)"
          value={settings.monitoring.alertThresholdPercent}
          onChange={(v) => void save({ ...settings, monitoring: { ...settings.monitoring, alertThresholdPercent: v } })}
        />
        <NumberRow
          label="Full re-scan interval (hours)"
          value={settings.monitoring.fullScanIntervalHours}
          onChange={(v) => void save({ ...settings, monitoring: { ...settings.monitoring, fullScanIntervalHours: v } })}
        />
        <ToggleRow
          label="Only scan when idle"
          desc="Wait for system idle before background scans"
          value={settings.monitoring.requireIdle}
          onChange={(v) => void save({ ...settings, monitoring: { ...settings.monitoring, requireIdle: v } })}
        />
        <NumberRow
          label="Idle threshold (minutes)"
          value={settings.monitoring.idleMinutes}
          onChange={(v) => void save({ ...settings, monitoring: { ...settings.monitoring, idleMinutes: v } })}
        />
      </div>

      {/* ── Notifications ── */}
      <div className="settings-section">
        <div className="settings-section-title">Notifications</div>
        <ToggleRow label="Scan complete" value={settings.notifications.scanComplete}
          desc="Show a notification when a scan finishes"
          onChange={(v) => void save({ ...settings, notifications: { ...settings.notifications, scanComplete: v } })} />
        <ToggleRow label="Delta alerts" desc="Notify when free space changes significantly" value={settings.notifications.deltaAlerts}
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
          onChange={(v) => void save({ ...settings, cleanup: { ...settings.cleanup, oldFileThresholdDays: v } })} />
        <ToggleRow label="Always use Trash (never permanent delete)"
          desc="Safer default for cleanup actions"
          value={settings.cleanup.safeDeleteToTrash}
          onChange={(v) => void save({ ...settings, cleanup: { ...settings.cleanup, safeDeleteToTrash: v } })} />
      </div>
    </div>
  );
}

function ToggleRow({ label, desc, value, onChange }: {
  label: string; desc?: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="setting-row">
      <div>
        <div className="setting-label">{label}</div>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      <label className="toggle">
        <input type="checkbox" checked={value} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
        <div className="toggle-track" />
        <div className="toggle-thumb" />
      </label>
    </div>
  );
}

function NumberRow({ label, value, onChange }: {
  label: string; value: number; onChange: (v: number) => void;
}) {
  return (
    <div className="setting-row">
      <div className="setting-label">{label}</div>
      <input
        className="setting-input"
        type="number"
        value={value}
        onChange={(e) => {
          const v = parseInt((e.target as HTMLInputElement).value, 10);
          if (!isNaN(v)) onChange(v);
        }}
      />
    </div>
  );
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
