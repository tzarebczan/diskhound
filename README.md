<p align="center">
  <img src="build/icon.png" alt="DiskHound" width="128" height="128" />
</p>

<h1 align="center">DiskHound</h1>

<p align="center">
  <strong>Fast, cross-platform disk space analyzer.</strong><br>
  Find what's eating your drive, track changes over time, detect duplicates, and reclaim space.
</p>

<p align="center">
  <a href="https://github.com/tzarebczan/diskhound/actions/workflows/ci.yml"><img src="https://github.com/tzarebczan/diskhound/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/tzarebczan/diskhound/releases/latest"><img src="https://img.shields.io/github/v/release/tzarebczan/diskhound?color=f59e0b" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/tzarebczan/diskhound" alt="MIT License" /></a>
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/022ad2fe-120a-47fa-bb3c-72a98d47a93c" alt="DiskHound Overview" width="85%" />
</p>

---

## Why DiskHound

WinDirStat was the gold standard for a decade. DiskHound is what it would be today: a native Rust scanner, an instant-load treemap, real scan history with time-range diffs, duplicate detection, and safe file operations — all wrapped in a modern dark-mode UI.

## Features

- 🦀 **Native Rust scanner** — reads the NTFS Master File Table directly on Windows drives (with admin), dropping cold scans on a 7 M-file drive from ~20 minutes to **under 90 seconds**. Falls back cleanly to `FindFirstFileExW` without admin. On Linux/macOS, a Rayon-parallel `jwalk` traversal skips virtual filesystems (`/proc`, `/sys`, `/dev`, `/run`, `/snap`, Docker overlayfs) and scales across CPU cores.
- 🗺️ **Interactive treemap** — squarified layout with 70+ file type colors. Two layouts: "Size" (largest-first, globally ordered) and "Tree" (WinDirStat-style — files cluster inside their parent directory's rectangle, with subtle depth-modulated folder outlines). Right-click any rectangle for reveal/open/trash/move actions.
- ⚡ **Incremental monitoring** — after the first full scan, DiskHound tracks disk changes via the NTFS USN journal (Windows) and an mtime-based smart rescan (cross-platform). Repeat scans on a mostly-idle drive are 10–50× faster than a full walk — typical hourly checks complete in seconds, populating the Changes tab automatically.
- 📈 **Scan history & diffing** — every scan is persisted. Compare any two snapshots with quick-select pills (1h / 6h / 1d / 1w / 1M / 3M). Browse the full per-file diff from the persistent index. History entries show an icon indicating whether they came from a fast delta scan or a full walk.
- 🔍 **Duplicate detection** — SHA-256 content hashing with two-pass optimization (4KB prefix rejection, then full hash). Concurrent I/O. "Keep newest" / "Keep oldest" bulk actions.
- 🔗 **Easy Move** — move a large file to another drive, leave a symlink or junction in its place. Fully reversible. Tracks every move so you can put files back with one click. Offers a one-UAC-prompt elevated retry for protected Windows paths.
- 📁 **Folder explorer** — drill into directories with breadcrumb navigation and proportional size bars.
- 🛎️ **Drive monitoring** — periodic free-space polling with delta alerts when space drops meaningfully. Rolling history of drive-level events is persisted.
- ⚙️ **Processes viewer** — real-time memory + CPU sampling for every process, with icons pulled from each executable. **Four views**: List, Treemap, scrolling CPU Heatmap (time on X, processes on Y, amber intensity = CPU share), and Affinity Rules (Process-Lasso-style pin-persistent CPU masks by exe name or path). Kill processes with soft/hard signals.
- 🎮 **GPU viewer** — per-process GPU utilisation + VRAM pulled from Windows `\GPU Engine(*)` / `\GPU Process Memory(*)` performance counters. Adapter overview (3D / Compute / Decode / Encode / Copy engine chips) + process table with engine-chip drill-down. Filters out phantom Microsoft Basic Display Adapter entries.
- 🔐 **One-UAC fast-scan mode** — Settings → Performance → "Always run as admin" registers a Scheduled Task bound to the current user's SID, so the normal shortcut auto-elevates with **zero UAC prompts** on every subsequent launch.
- 🌓 **Dark & light themes** — with system preference detection. Toggle from the status bar.
- ⌨️ **Keyboard navigation** — arrow keys in the file list, Enter to open, Delete to trash, Ctrl+F to search.
- 🔄 **Auto-update** — via `electron-updater` with GitHub Releases. UAC elevation supported for system-wide installs.

## Install

Download the latest release for your platform from [**Releases**](https://github.com/tzarebczan/diskhound/releases/latest):

| Platform | Artifact |
|---|---|
| Windows | `DiskHound-<version>-Setup.exe` (NSIS installer) |
| macOS | `DiskHound-<version>-x64.dmg` / `-arm64.dmg` |
| Linux | `DiskHound-<version>-x86_64.AppImage` (recommended — built-in auto-update) or `DiskHound-<version>-x64.tar.gz` (extract-and-run tree) |

## Screenshots

<table>
  <tr>
    <td align="center">
      <img src="docs/screenshots/duplicates.png" alt="Duplicates" width="100%" /><br>
      <sub><b>Duplicates</b> — find identical files by content hash</sub>
    </td>
    <td align="center">
      <img src="https://github.com/user-attachments/assets/5f090f34-0d77-4853-bcee-4ea5e00aefbf" alt="Changes" width="100%" /><br>
      <sub><b>Changes</b> — diff any two scans with time-range presets</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="https://github.com/user-attachments/assets/44146204-18c3-427a-aaa7-c59b9d01d840" alt="Folders" width="100%" /><br>
      <sub><b>Folders</b> — drill into directories with size breakdowns</sub>
    </td>
    <td align="center">
      <img src="https://github.com/user-attachments/assets/a5eabf32-3308-4e73-a925-4aea5a436c03" alt="Settings" width="100%" /><br>
      <sub><b>Settings</b> — theme, scanning, monitoring, cleanup</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="docs/screenshots/processes-treemap.png" alt="Processes" width="100%" /><br>
      <sub><b>Processes</b> — memory treemap with real exe icons; right-click any rect for reveal / kill actions</sub>
    </td>
    <td align="center">
      <img src="docs/screenshots/processes-heatmap.png" alt="CPU Heatmap" width="100%" /><br>
      <sub><b>CPU Heatmap</b> — scrolling waterfall where the right edge is NOW; sparklines call out recent CPU activity</sub>
    </td>
  </tr>
</table>

## Development

**Requirements:** [Bun](https://bun.sh/) 1.3+, [Rust](https://rustup.rs/) (stable), Node.js 20+ (bundled with Electron).

```bash
# Clone and install
git clone https://github.com/tzarebczan/diskhound
cd diskhound
bun install

# Build the native Rust scanner
bun run build:native

# Start in development mode (hot-reload renderer + Electron)
bun run dev
```

### Scripts

| Command | Description |
|---|---|
| `bun run dev` | Dev server with hot-reload |
| `bun run build` | Build renderer + Electron main process |
| `bun run build:native` | Build the Rust native scanner (release) |
| `bun run start` | Launch the built production app |
| `bun run dist` | Build everything and create the installer |
| `bun run test` | Run Vitest test suite (44 tests) |
| `bun run typecheck` | TypeScript type checking |

### Architecture

```
src/
├── main.ts              Electron main process, IPC handlers
├── preload.ts           Context bridge (IPC → renderer)
├── nativeScanner.ts     Spawn and manage the Rust binary
├── scan/scanWorker.ts   JS fallback scanner (worker thread)
├── shared/
│   ├── contracts.ts     All TypeScript types and IPC interface
│   ├── scanDiff.ts      Snapshot diff algorithm (top-N)
│   ├── scanIndex.ts     Full per-file index + real diff engine
│   ├── scanHistory.ts   File-backed scan history store
│   ├── duplicates.ts    Duplicate detection engine
│   ├── easyMoveStore.ts Easy Move persistence and rollback
│   ├── diskMonitor.ts   Background disk space monitoring
│   └── pathUtils.ts     Shared path normalization
└── renderer/
    ├── App.tsx          App shell, tabs, header
    ├── components/      All view components
    └── lib/             Shared utilities, hooks, treemap algorithm

native/diskhound-native-scanner/
└── src/main.rs          Rust scanner (Win32 APIs + jwalk)
```

## How it works

**The scanner** writes two outputs for every completed scan:
1. A JSON snapshot with top-N largest files, hottest directories, and aggregate totals.
2. A gzipped NDJSON index containing every file's path, size, and mtime, plus directory mtime entries so the next scan can skip unchanged subtrees.

**The diff engine** uses the snapshot for the "biggest changes" overview, and the full index for "browse every change." Both are streamed and capped for memory safety. Aggregate totals (net bytes changed, file count delta) are always exact since they come from complete scan counters.

**Incremental monitoring** has two tiers:
1. **USN journal (Windows)** — after a full scan anchors a cursor, subsequent monitoring ticks read only the NTFS change journal since that cursor. Creates/modifies/deletes are applied to a working copy of the index, a fresh snapshot is built from the updated index, and it's saved to history with an `⚡ fast` engine tag. Near-instant.
2. **Mtime-based smart rescan (cross-platform)** — during a full walk, directories whose mtime matches the previous scan's baseline inherit their files from the baseline instead of being re-enumerated. Covers the case where USN is unavailable or the volume isn't NTFS.

**Easy Move** uses platform-appropriate links: directory junctions on Windows (no admin), symlinks on macOS/Linux. Every move is journaled so it's fully reversible. Failed rollbacks are recorded as "stranded" with explicit recovery in the UI.

**Process sampling** uses PowerShell `Get-Process` on Windows (fast, returns executable paths for icon resolution) with a fallback to basic `tasklist` if PowerShell is unavailable. macOS/Linux use `ps -axo pid,rss,%cpu,comm`. Results are cached in the main process so tab-switching is instant — a fresh sample fires in the background.

## Contributing

Issues and PRs welcome. Please run `bun run typecheck && bun run test` before opening a PR.

## License

[MIT](LICENSE) © 2026 Thomas Zarebczan
