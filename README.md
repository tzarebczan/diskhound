# DiskHound

Fast, cross-platform disk space analyzer. Find what's eating your drive, track changes over time, detect duplicates, and reclaim space.

Built with Electron, Preact, and a native Rust filesystem scanner.

## Features

- **Native Rust scanner** — walks the filesystem using Win32 `FindFirstFileExW` APIs on Windows, `jwalk` on macOS/Linux. Scans 100K+ files in seconds.
- **Treemap visualization** — squarified treemap with 70+ file type colors, sqrt-compressed sizing, and interactive right-click actions.
- **Scan history & diffing** — persists every scan. Compare any two snapshots to see what grew, shrank, appeared, or disappeared. Quick-select pills for 1h/6h/1d/1w/1M/3M time ranges.
- **Duplicate detection** — SHA-256 content hashing with two-pass optimization (4KB prefix rejection, then full hash). Concurrent I/O for throughput.
- **Easy Move** — move large files to another drive and leave a symlink/junction in place. Fully reversible.
- **Folder explorer** — drill into directories with breadcrumb navigation, size bars, and proportional breakdown.
- **Background monitoring** — periodic disk space checks with delta alerts when free space drops.
- **Dark & light themes** — full theme support with system preference detection.

## Quick Start

```bash
# Install dependencies
bun install

# Build the native scanner
bun run build:native

# Start in development mode (hot-reload)
bun run dev

# Or build and run the production app
bun run build
bun run start
```

## Requirements

- [Bun](https://bun.sh/) 1.3+
- [Rust](https://rustup.rs/) (for the native scanner)
- Node.js 20+ (bundled with Electron)

## Scripts

| Command | Description |
|---|---|
| `bun run dev` | Start dev server with hot-reload |
| `bun run build` | Build renderer + Electron main process |
| `bun run build:native` | Build the Rust native scanner (release) |
| `bun run start` | Launch the built production app |
| `bun run dist` | Build everything and create installer |
| `bun run test` | Run tests with Vitest |
| `bun run typecheck` | TypeScript type checking |

## Architecture

```
src/
  main.ts              Electron main process, IPC handlers
  preload.ts           Context bridge (IPC to renderer)
  nativeScanner.ts     Spawn and manage the Rust binary
  scan/scanWorker.ts   JS fallback scanner (worker thread)
  shared/
    contracts.ts       All TypeScript types and IPC interface
    scanDiff.ts        Snapshot diff algorithm
    scanHistory.ts     File-backed scan history store
    duplicates.ts      Duplicate detection engine
    easyMoveStore.ts   Easy Move persistence and rollback
    diskMonitor.ts     Background disk space monitoring
    pathUtils.ts       Shared path normalization
  renderer/
    App.tsx            App shell, tabs, header
    components/        All view components
    lib/               Shared utilities, hooks, treemap algorithm

native/diskhound-native-scanner/
  src/main.rs          Rust scanner (Win32 APIs + jwalk)
```

## License

MIT
