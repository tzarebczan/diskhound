import * as FS from "node:fs/promises";
import * as Path from "node:path";

import { app } from "electron";

import { defaultSettings, type AppSettings } from "./contracts";

const SETTINGS_FILE_NAME = "settings.json";

export interface SettingsStore {
  get: () => AppSettings;
  set: (next: AppSettings) => Promise<void>;
  update: (transform: (current: AppSettings) => AppSettings) => Promise<AppSettings>;
}

export async function createSettingsStore(): Promise<SettingsStore> {
  const settingsDir = app.getPath("userData");
  const settingsPath = Path.join(settingsDir, SETTINGS_FILE_NAME);

  let current = defaultSettings();

  try {
    const raw = await FS.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    current = mergeSettings(current, parsed);
  } catch {
    // No existing settings file - use defaults
  }

  const persist = async (settings: AppSettings) => {
    await FS.mkdir(settingsDir, { recursive: true });
    await FS.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  };

  return {
    get: () => current,
    set: async (next) => {
      current = next;
      await persist(current);
    },
    update: async (transform) => {
      current = transform(current);
      await persist(current);
      return current;
    },
  };
}

function mergeSettings(defaults: AppSettings, partial: Partial<AppSettings>): AppSettings {
  return {
    general: { ...defaults.general, ...partial.general },
    scanning: { ...defaults.scanning, ...partial.scanning },
    monitoring: { ...defaults.monitoring, ...partial.monitoring },
    notifications: { ...defaults.notifications, ...partial.notifications },
    cleanup: { ...defaults.cleanup, ...partial.cleanup },
    recentScans: partial.recentScans ?? defaults.recentScans,
  };
}
