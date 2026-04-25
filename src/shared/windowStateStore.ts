import * as FS from "node:fs/promises";
import * as Path from "node:path";

import { app, type BrowserWindow, screen } from "electron";

/**
 * Persists the main window's geometry across restarts.
 *
 * ## What this stores
 *
 * - The "normal" (un-maximized, un-fullscreen) bounds: x, y, width,
 *   height. Captured continuously while the user resizes/moves the
 *   window in normal state.
 * - `isMaximized` — re-applied via `window.maximize()` on next launch.
 * - `isFullScreen` — re-applied via `window.setFullScreen(true)`.
 *
 * Maximize / fullscreen are tracked separately from bounds because
 * `getBounds()` returns the *inflated* rect while in those states;
 * we don't want to save the maximized rectangle as "the size to
 * restore to" — that would leave the user with a fullscreen-shaped
 * window after they un-maximize.
 *
 * ## Validation on restore
 *
 * If the user unplugs a second monitor between sessions, the saved
 * (x, y) might point off-screen on the current setup. We check
 * every saved rectangle against the current `screen.getAllDisplays()`
 * and require ≥100×100 px of overlap with at least one display's
 * work area. If that fails we drop x/y entirely so the window
 * manager centers the window on the primary display — better than
 * stranding it on a phantom monitor.
 *
 * ## Cross-platform
 *
 * - Windows: works exactly as designed. `getBounds()` returns
 *   content rect; restoring preserves the user's window placement.
 * - macOS: `maximize()` triggers Mac's zoom (fills available work
 *   area minus dock/menu bar). `setFullScreen(true)` opens a new
 *   Space, which works on relaunch but takes ~500 ms to animate
 *   in. Both honored.
 * - Linux: GNOME Mutter / KWin / Sway all honor x/y for normal
 *   state. Some niche WMs ignore position hints — saving them
 *   anyway is harmless.
 *
 * ## Persistence shape
 *
 * One JSON file at `userData/window-state.json`. Self-contained,
 * no schema migration logic — bad / missing fields fall through
 * to defaults rather than throwing, so old files from any prior
 * version still work.
 *
 * ## Save cadence
 *
 * Resize / move events fire every frame during a drag. We debounce
 * disk writes to ~400 ms after the last change so a slow drag
 * doesn't generate 60 writes per second. Maximize / fullscreen
 * transitions persist immediately because they're discrete events
 * (no debounce useful). On window close any pending debounce is
 * flushed synchronously so we never lose the final state.
 */

const FILE_NAME = "window-state.json";
const SAVE_DEBOUNCE_MS = 400;
/** Window must have at least this much overlap (in px) with some
 *  display's work area to be considered "on-screen" — protects
 *  against the unplugged-monitor case where the saved rect is
 *  entirely on a display that no longer exists. */
const MIN_VISIBLE_PX = 100;

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  bounds: WindowBounds;
  isMaximized: boolean;
  isFullScreen: boolean;
}

export interface WindowStateStore {
  /** Resolve the constructor options to pass to BrowserWindow.
   *  Returns x/y only when the saved position is verifiably on a
   *  current display; otherwise omits them so the WM centers the
   *  window on its default display. width/height are always
   *  populated (clamped to ≥ minWidth/minHeight). */
  resolveBounds(): { x?: number; y?: number; width: number; height: number };
  /** Whether to call window.maximize() after creation. */
  shouldRestoreMaximized(): boolean;
  /** Whether to call window.setFullScreen(true) after creation. */
  shouldRestoreFullScreen(): boolean;
  /** Attach listeners that capture future resize/move/maximize/
   *  fullscreen events. Call once, after the window exists. */
  track(window: BrowserWindow): void;
  /** Synchronously flush any pending debounced write. Call from
   *  app.on("before-quit") so we don't lose state if the user
   *  quits during the debounce window. */
  flush(): Promise<void>;
}

interface PersistedShape {
  bounds?: Partial<WindowBounds>;
  isMaximized?: boolean;
  isFullScreen?: boolean;
}

export async function createWindowStateStore(opts: {
  defaults: { width: number; height: number };
  minWidth: number;
  minHeight: number;
}): Promise<WindowStateStore> {
  const { defaults, minWidth, minHeight } = opts;
  const dir = app.getPath("userData");
  const filePath = Path.join(dir, FILE_NAME);

  // ── Initial state from disk (or defaults) ─────────────────
  let bounds: WindowBounds = {
    x: Number.NaN, // sentinel: "no saved position"
    y: Number.NaN,
    width: defaults.width,
    height: defaults.height,
  };
  let isMaximized = false;
  let isFullScreen = false;

  try {
    const raw = await FS.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedShape;
    if (parsed.bounds) {
      const w = parsed.bounds.width;
      const h = parsed.bounds.height;
      const x = parsed.bounds.x;
      const y = parsed.bounds.y;
      if (typeof w === "number" && Number.isFinite(w) && w >= minWidth) {
        bounds.width = Math.round(w);
      }
      if (typeof h === "number" && Number.isFinite(h) && h >= minHeight) {
        bounds.height = Math.round(h);
      }
      if (typeof x === "number" && Number.isFinite(x)) bounds.x = Math.round(x);
      if (typeof y === "number" && Number.isFinite(y)) bounds.y = Math.round(y);
    }
    if (parsed.isMaximized === true) isMaximized = true;
    if (parsed.isFullScreen === true) isFullScreen = true;
  } catch {
    // No file or bad JSON — first launch or corruption. Defaults are fine.
  }

  // Track the most recent "normal" (non-maximized, non-fullscreen)
  // bounds. This is what we persist as the geometry to restore to.
  const normalBounds: WindowBounds = { ...bounds };

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const persistNow = async (): Promise<void> => {
    saveTimer = null;
    try {
      await FS.mkdir(dir, { recursive: true });
      const payload: PersistedShape = {
        bounds: { ...normalBounds },
        isMaximized,
        isFullScreen,
      };
      await FS.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
    } catch {
      // Persistence failure is non-fatal. The user just loses one
      // session's worth of geometry; we'll succeed next time.
    }
  };

  const schedulePersist = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void persistNow();
    }, SAVE_DEBOUNCE_MS);
  };

  return {
    resolveBounds: () => {
      const out: { x?: number; y?: number; width: number; height: number } = {
        width: bounds.width,
        height: bounds.height,
      };
      if (Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
        if (boundsAreOnSomeDisplay(bounds)) {
          out.x = bounds.x;
          out.y = bounds.y;
        }
        // else: unplugged monitor case — drop position, keep size.
      }
      return out;
    },

    shouldRestoreMaximized: () => isMaximized,
    shouldRestoreFullScreen: () => isFullScreen,

    track: (window: BrowserWindow) => {
      const captureNormal = () => {
        // Only capture geometry when the window is in its "normal"
        // (non-maximized / non-fullscreen / non-minimized) state.
        // getBounds() during maximize returns the inflated rect, and
        // we don't want to overwrite the un-maximized geometry with
        // the maximize rect — that'd defeat the whole point of
        // tracking maximize separately.
        if (
          window.isDestroyed() ||
          window.isMaximized() ||
          window.isFullScreen() ||
          window.isMinimized()
        ) {
          return;
        }
        const b = window.getBounds();
        normalBounds.x = b.x;
        normalBounds.y = b.y;
        normalBounds.width = b.width;
        normalBounds.height = b.height;
        schedulePersist();
      };

      window.on("resize", captureNormal);
      window.on("move", captureNormal);

      window.on("maximize", () => {
        isMaximized = true;
        schedulePersist();
      });
      window.on("unmaximize", () => {
        isMaximized = false;
        // After un-maximizing, getBounds() returns the restored
        // (normal) rect — capture it so we have an accurate normal
        // size even if the user hasn't moved/resized post-restore.
        captureNormal();
        schedulePersist();
      });
      window.on("enter-full-screen", () => {
        isFullScreen = true;
        schedulePersist();
      });
      window.on("leave-full-screen", () => {
        isFullScreen = false;
        captureNormal();
        schedulePersist();
      });

      // Final flush on close — covers the path where the user quits
      // before the debounce timer fires. We can't await here (close
      // is synchronous from Electron's POV) so we fire-and-forget;
      // the flush() method on the store handles the awaitable
      // version called from app.before-quit.
      window.on("close", () => {
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
          void persistNow();
        }
      });
    },

    flush: async () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      await persistNow();
    },
  };
}

/**
 * True if the rectangle has ≥ MIN_VISIBLE_PX of overlap with at
 * least one display's work area. "Work area" excludes the OS task
 * bar / dock / menu bar, so a window whose top edge sits exactly
 * under the menu bar is correctly flagged as off-screen.
 */
function boundsAreOnSomeDisplay(b: WindowBounds): boolean {
  const displays = screen.getAllDisplays();
  for (const d of displays) {
    const wa = d.workArea;
    const xOverlap = Math.max(
      0,
      Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x),
    );
    const yOverlap = Math.max(
      0,
      Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y),
    );
    if (xOverlap >= MIN_VISIBLE_PX && yOverlap >= MIN_VISIBLE_PX) return true;
  }
  return false;
}
