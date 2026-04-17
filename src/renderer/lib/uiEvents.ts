import type { AppSettings } from "../../shared/contracts";

export const SETTINGS_UPDATED_EVENT = "diskhound:settings-updated";

export function dispatchSettingsUpdated(settings: AppSettings): void {
  window.dispatchEvent(
    new CustomEvent<AppSettings>(SETTINGS_UPDATED_EVENT, {
      detail: settings,
    }),
  );
}
