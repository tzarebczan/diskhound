import * as FS from "node:fs/promises";
import * as Path from "node:path";

import { app } from "electron";

import { normalizeAppSettings, defaultSettings, type AppSettings } from "./contracts";

const SETTINGS_FILE_NAME = "settings.json";

export type SettingsListener = (settings: AppSettings) => void;

export interface SettingsStore {
  get: () => AppSettings;
  set: (next: AppSettings) => Promise<void>;
  update: (transform: (current: AppSettings) => AppSettings) => Promise<AppSettings>;
  /**
   * Subscribe to post-persist change notifications. Fires after
   * every successful `set` / `update`, with the normalized
   * settings as they're now stored. main.ts wires this to a
   * `BrowserWindow.webContents.send` broadcast so all renderer
   * windows (main app + system widget) get push notifications
   * instead of polling. Returns an unsubscribe handle.
   *
   * Listener exceptions are swallowed so one bad subscriber
   * can't take the others (or the calling write path) down.
   */
  subscribe: (listener: SettingsListener) => () => void;
}

export async function createSettingsStore(): Promise<SettingsStore> {
  const settingsDir = app.getPath("userData");
  const settingsPath = Path.join(settingsDir, SETTINGS_FILE_NAME);

  let current = defaultSettings();

  try {
    const raw = await FS.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    current = normalizeAppSettings(mergeSettings(current, parsed));
  } catch {
    // No existing settings file - use defaults
  }

  const persist = async (settings: AppSettings) => {
    await FS.mkdir(settingsDir, { recursive: true });
    await FS.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  };

  const listeners = new Set<SettingsListener>();
  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener(current);
      } catch {
        // Best effort — keep other subscribers alive.
      }
    }
  };

  return {
    get: () => current,
    set: async (next) => {
      current = normalizeAppSettings(next);
      await persist(current);
      notify();
    },
    update: async (transform) => {
      current = normalizeAppSettings(transform(current));
      await persist(current);
      notify();
      return current;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
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
    affinityRules: partial.affinityRules ?? defaults.affinityRules,
  };
}
