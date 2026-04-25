import { spawn } from "node:child_process";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

/**
 * First-run Linux desktop integration.
 *
 * ## Why this is needed
 *
 * electron-builder embeds a `.desktop` file and icons *inside* the
 * AppImage / tar.gz — but GNOME Shell's dock and Activities overview
 * only look in `$XDG_DATA_DIRS/applications/` (typically
 * `/usr/share/applications` and `~/.local/share/applications`).
 * An AppImage that hasn't been registered with AppImageLauncher or
 * a similar integrator is therefore "anonymous" as far as the dock
 * is concerned: the running window gets grouped under a generic
 * Electron glyph (or nothing at all) instead of the DiskHound icon.
 *
 * Users reported this on Ubuntu 22.04/24.04: "the sidebar icon is
 * missing, the title bar icon is a weird black thing." Their screen
 * is exactly what you get when GNOME can't find a `.desktop` entry
 * with a matching `StartupWMClass` — the window falls back to its
 * `_NET_WM_ICON` property which, prior to the multi-rep NativeImage
 * fix, was a single 512×512 PNG that GNOME downscaled into soup.
 *
 * ## What this module does
 *
 * At first launch (and on every launch, idempotently — cheap enough
 * not to gate on a flag):
 *
 *   1. Copy the PNGs we ship in `resources/icons/` into
 *      `~/.local/share/icons/hicolor/<size>/apps/diskhound.png`.
 *      These are what the `.desktop` file's `Icon=diskhound` entry
 *      resolves against via the freedesktop icon-theme spec.
 *
 *   2. Write a `.desktop` file at
 *      `~/.local/share/applications/diskhound.desktop` with:
 *        - Exec= pointing at the currently-running binary
 *          (APPIMAGE env var if set, else process.execPath).
 *        - Icon=diskhound (matches the hicolor files above).
 *        - StartupWMClass=diskhound (matches the `class` switch we
 *          pass to Chromium via app.commandLine in main.ts).
 *
 *   3. Run `update-desktop-database` and `gtk-update-icon-cache` so
 *      GNOME notices the new entry without a log-out/log-in. Both
 *      are best-effort — if they fail (missing on headless systems,
 *      permission issues) we still leave the files in place for
 *      normal XDG lookup.
 *
 * ## Idempotence
 *
 * The `.desktop` file's Exec= encodes the current exe path. If the
 * user moves the AppImage or reinstalls to a different location the
 * path changes and we re-write. If nothing changed we skip the
 * write. The hicolor icon files are overwritten on every run — the
 * compare-before-write dance isn't worth the I/O cost for 8 small
 * PNGs.
 *
 * ## Non-goals
 *
 * - We do NOT register URL handlers (no `MimeType=x-scheme-handler/...`).
 * - We do NOT uninstall on update — the `.desktop` file and icons
 *   stay put, which is the correct behavior because the user may
 *   have launched DiskHound from the previous install and expects
 *   the dock entry to persist.
 * - We do NOT touch `/usr/share/` — this is strictly per-user
 *   integration, which needs no sudo and survives AppImage moves.
 */

/** Icon sizes we ship — must match scripts/generate-icon.mjs output.
 *  96 and 192 added in 0.5.7 because GNOME's dock at default scale
 *  picks an icon size in the 64-96 px range and upscales when no
 *  exact match exists; explicit 96.png removes the upscale step. */
const ICON_SIZES = [16, 24, 32, 48, 64, 96, 128, 192, 256, 512];

/** Match the WM class we set via app.commandLine.appendSwitch("class", ...) in main.ts. */
const APP_WM_CLASS = "diskhound";

/**
 * Integrate DiskHound into the user's XDG desktop directories.
 * Safe to call on every startup — writes are idempotent and the
 * file/subprocess operations are <100 ms on a warm filesystem.
 *
 * Returns nothing — errors are logged via the provided logger but
 * never thrown. A failed integration just means the sidebar icon
 * won't show up on the first run; it's not worth aborting app
 * startup over.
 */
export async function integrateLinuxDesktop(params: {
  /** HOME directory — pass `os.homedir()` so tests can override. */
  homeDir: string;
  /** Directory with the multi-size PNGs (the one resolveIconsDir()
   *  returns in main.ts). Null → skip icon copy; we can still write
   *  the .desktop file, which resolves Icon= via the default theme
   *  fallback (gets a generic glyph but at least the window title
   *  + dock tooltip are correct). */
  iconsDir: string | null;
  /** Path to the running binary. Use process.env.APPIMAGE when the
   *  app is mounted via AppImage (process.execPath points at the
   *  inside-the-mount electron binary, which disappears when the
   *  AppImage unmounts), else process.execPath. */
  execPath: string;
  /** Crash-log writer from main.ts. Signature matches writeCrashLog. */
  logger?: (tag: string, message: string) => void;
}): Promise<void> {
  const { homeDir, iconsDir, execPath, logger } = params;
  const log = (tag: string, msg: string) => logger?.(tag, msg);

  if (process.platform !== "linux") return;

  try {
    const iconBaseDir = Path.join(homeDir, ".local", "share", "icons", "hicolor");
    const appDir = Path.join(homeDir, ".local", "share", "applications");
    const desktopPath = Path.join(appDir, `${APP_WM_CLASS}.desktop`);

    // 1. Icon files — one per size under hicolor/<size>/apps/
    let iconsWritten = 0;
    if (iconsDir) {
      for (const size of ICON_SIZES) {
        const source = Path.join(iconsDir, `${size}x${size}.png`);
        const destDir = Path.join(iconBaseDir, `${size}x${size}`, "apps");
        const dest = Path.join(destDir, `${APP_WM_CLASS}.png`);
        try {
          await FS.mkdir(destDir, { recursive: true });
          await FS.copyFile(source, dest);
          iconsWritten += 1;
        } catch (err) {
          log(
            "linux-integration",
            `failed to copy icon ${size}x${size}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // 2. .desktop file — only rewrite if content differs, so we don't
    //    bump the mtime on every launch (which triggers an unnecessary
    //    `update-desktop-database` indexing pass).
    const desktopBody = buildDesktopFile(execPath);
    let needWrite = true;
    try {
      const existing = await FS.readFile(desktopPath, "utf8");
      if (existing === desktopBody) {
        needWrite = false;
      }
    } catch {
      // File doesn't exist or can't be read — write it.
    }

    if (needWrite) {
      await FS.mkdir(appDir, { recursive: true });
      await FS.writeFile(desktopPath, desktopBody, "utf8");
      // .desktop files need the executable bit per the freedesktop
      // spec, or GNOME prompts "Untrusted application launcher" the
      // first time it's activated.
      await FS.chmod(desktopPath, 0o755).catch(() => {});
      log(
        "linux-integration",
        `wrote ${desktopPath} (exec=${execPath}, icons=${iconsWritten})`,
      );
    }

    // 3. Refresh caches so GNOME picks up the new entry without a
    //    re-login. Both commands are optional — on minimal images
    //    they're often absent. Ignore non-zero exit codes.
    if (needWrite) {
      runBestEffort("update-desktop-database", [appDir]);
    }
    if (iconsWritten > 0) {
      runBestEffort("gtk-update-icon-cache", ["-f", "-t", iconBaseDir]);
    }
  } catch (err) {
    log(
      "linux-integration",
      `unexpected failure: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function buildDesktopFile(execPath: string): string {
  // electron-builder 26's default .desktop has Exec=AppRun which
  // only works when the file is *inside* the AppImage. Our copy
  // lives in ~/.local/share/applications and needs the real path
  // to the AppImage (or tar.gz binary). %U supports passing
  // file/URL arguments — nothing in DiskHound consumes them today
  // but keeping the spec-compliant form costs nothing and future-
  // proofs drag-and-drop onto the dock icon.
  const quoted = escapeExecPath(execPath);
  // Keep the field order stable — identical bytes → no needless
  // rewrite on each launch. Values mirror the linux.desktop.entry
  // block in electron-builder.yml.
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=DiskHound",
    "Comment=Fast disk space analyzer — find and clean up large files",
    `Exec=${quoted} %U`,
    `Icon=${APP_WM_CLASS}`,
    "Terminal=false",
    "Categories=Utility;System;Filesystem;",
    "Keywords=disk;space;analyzer;duplicates;cleanup;treemap;",
    `StartupWMClass=${APP_WM_CLASS}`,
    "X-GNOME-WMClass=" + APP_WM_CLASS,
    "",
  ].join("\n");
}

/**
 * Escape a path for the Exec= line. freedesktop spec says paths
 * with spaces or special characters should be double-quoted; inside
 * double quotes, `\`, `"`, `$`, and `` ` `` must be escaped with a
 * backslash. Most AppImage paths are boring, but handle the
 * messy case cleanly so users who drop the AppImage in "~/My Stuff/"
 * still get a working launcher.
 */
function escapeExecPath(p: string): string {
  const needsQuotes = /[\s"'`$\\]/.test(p);
  if (!needsQuotes) return p;
  const escaped = p.replace(/([\\"`$])/g, "\\$1");
  return `"${escaped}"`;
}

/** Spawn a command, detach, and forget. Used for GNOME cache
 *  refreshes that we don't need to wait on and don't care if they
 *  fail (minimal Linux images often omit these tools). */
function runBestEffort(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => { /* swallow — tool missing is fine */ });
    child.unref();
  } catch {
    /* command not on PATH — not a bug */
  }
}
