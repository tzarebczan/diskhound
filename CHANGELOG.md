# Changelog

## 0.5.4 — 2026-04-24

Second Linux polish pass. A screenshot from an Ubuntu VM showed
DiskHound running with no sidebar icon and a black glyph in the
title bar — neither of which 0.5.3's icon work fully fixed. Also
a platform audit because most testing had been Windows-only.

### Linux sidebar + title-bar icons

Root cause was two issues layered together:

- **Single-size window icon.** `BrowserWindow.icon` was a 512×512
  PNG. GNOME downscales that into a smudge at the 16 / 24 px sizes
  it needs for the title bar, and some WMs read the icon *after*
  the window is realized (the constructor option is too early).
  Fixed by loading the full 16/24/32/48/64/128/256/512 set into a
  multi-rep `NativeImage` and calling `win.setIcon()` post-
  creation so the `_NET_WM_ICON` atom ends up with every size the
  WM might ask for.
- **No XDG `.desktop` file.** AppImage embeds a launcher *inside*
  the mount, which GNOME's dock can't see. Without AppImageLauncher
  the dock shows a generic Electron glyph (or nothing) because
  there's no `StartupWMClass` match on the XDG search path. Fixed
  with a first-run (and every-run, idempotently) self-integration
  step that writes `~/.local/share/applications/diskhound.desktop`
  with `Exec=` pointing at `$APPIMAGE` (or the tar.gz binary) and
  drops the hicolor PNGs into
  `~/.local/share/icons/hicolor/<size>/apps/diskhound.png`. Runs
  `update-desktop-database` + `gtk-update-icon-cache` best-effort
  so users don't have to log out / back in.

`build/icons/*.png` is now shipped as `resources/icons/` in the
packaged app so the runtime has real pixels to copy.

### Platform audit — hide Windows-only UI

Much of DiskHound is built around the Windows MFT fast-scan path
(UAC, Scheduled Task elevation, Get-Counter GPU sampling,
`SetProcessAffinityMask`). On Linux/Mac those handlers stub out,
but the UI still showed the buttons — users saw "Running elevated
— MFT fast-scan path active" on Ubuntu because `isElevated()`
returns `true` as a non-Windows stub, and the scheduled-task
buttons tried to invoke `schtasks.exe`.

- **`nativeApi.platform`** — new static string (`"win32" | "darwin"
  | "linux"`) set at preload time. Replaces the UA-sniffing in
  `resolvePlatformClass` / `rootKey` throughout the renderer.
- **Settings → Performance section** is now Windows-only.
- **Processes → GPU + Affinity Rules tabs** are now Windows-only,
  along with the per-process "Set CPU affinity…" / "Pin CPU
  affinity rule…" context-menu items.
- **Scan-root input placeholder** switches between `C:\Users\…`,
  `/Users/…`, `/home/…` per platform instead of always showing
  the Windows form.
- **Kill-error toast** now maps POSIX `EPERM` / "operation not
  permitted" to a `sudo`-flavored remediation message. Mac and
  Linux get slightly different phrasing (Activity Monitor vs.
  terminal `sudo kill`).
- **GPU empty-state copy** no longer blames WDDM when the user is
  on macOS/Linux.

### Minor

- **Admin banner** now has an explicit `platform === "win32"`
  guard. It was implicitly Windows-only because the non-Windows
  `isElevated()` stub returns `true`, but one refactor of that
  stub would have brought the banner back to Linux without
  notice.
- **ChangesView copy** no longer mentions NTFS / Windows change
  journal on Linux/Mac, where DiskHound falls back to scheduled
  rescans exclusively.

## 0.5.3 — 2026-04-24

Two-part Linux pass following 0.5.2's first drive/filesystem fix.

### Native scanner on Linux + macOS

Previously the Rust scanner was Windows-gated and non-Windows fell
through to the slower JS walker. Flipped that:

- **Native scanner now enabled everywhere.** Non-Windows sessions
  spawn the same `diskhound-native-scanner` binary (built via
  cargo for x64 Linux / universal macOS in CI).
- **Thread pool sizing.** Rayon pool is now
  `num_cpus::get().clamp(4, 16)` instead of the prior `[2, 8]` —
  high-core NVMe boxes were bottlenecked by the old clamp.
- **Baseline-driven progress.** `expected_total_files` populates
  from the previous scan's per-directory totals during indexing,
  so the progress-% UI has a live denominator from the start of a
  rescan instead of stalling at "counting…".

### Accurate disk usage on Unix (sparse files)

Both the Rust scanner and the JS fallback now report
`stat.blocks * 512` instead of nominal file length on non-Windows.
This is what `du` reports — accounts for sparse files
(ext4 / btrfs / APFS holes) and filesystem-level compression.
Fixes inflated totals on systems with sparse VM images or
compressed APFS volumes.

### Linux integration (first pass)

- **Taskbar grouping fix.** The X11 `WM_CLASS` now matches the
  `StartupWMClass=diskhound` in the embedded `.desktop` file
  (`app.commandLine.appendSwitch("class", "diskhound")`).
- **Multi-size icons.** `scripts/generate-icon.mjs` now emits
  16/24/32/48/64/128/256/512 PNGs into `build/icons/`, and
  electron-builder packages them into the AppImage.

### Auto-updates: "manual" phase for tar.gz builds

`electron-updater` only works with AppImage on Linux. Prior
builds errored out when the tar.gz user's update check ran. Now
non-AppImage Linux builds surface a "Update available — download
from GitHub" toast that links straight to the release page.

### CI / workflow

- `scripts/sync-version-from-tag.mjs` patches `package.json`'s
  version from the git tag at release time, so the CHANGELOG is
  the authoritative version source.

### UX polish

- `platform-windows` / `platform-macos` / `platform-linux` root
  classes for OS-specific CSS tweaks (Windows title-bar overlay
  padding, etc.).
- Header drag regions refined so the window remains draggable
  around buttons and drive pills.

## 0.5.2 — 2026-04-24

Linux support pass. A user screenshot on Ubuntu 24.04 flagged four
issues that had been lurking behind the Windows-first development:

### Drive list no longer shows tmpfs / cgroup / proc mounts

`getUnixDiskSpace()` was parsing `df -P -k` output with NO
filesystem-type filter, so the drive picker showed:
- `/run` (tmpfs)
- `/dev/shm` (tmpfs)
- `/run/lock` (tmpfs)
- `/run/user/1000` (tmpfs)

none of which are user-scannable storage. Fix: `df -P -k -T`
(adds fs-type column), allow-list of real filesystems (ext2/3/4,
btrfs, xfs, zfs, ntfs3, exfat, f2fs, nfs, cifs, etc.), drop
everything else.

### Linux scanner: virtual FS prune + parallel walk

- **`process_read_dir` prune**: `/proc`, `/sys`, `/dev`, `/run`,
  `/snap`, `/var/lib/docker/overlay2`, `/var/lib/containers/storage/overlay`
  are now skipped BEFORE jwalk descends into them. Scanning `/` no
  longer dives into kernel-generated text files in `/proc` or
  squashfs loopback mounts under `/snap`.
- **Rayon-parallel walk**: jwalk now runs with
  `Parallelism::RayonNewPool(n)` where n = `DISKHOUND_PARALLEL_THREADS`
  (env override) or `num_cpus::get().clamp(2, 8)`. Prior Linux
  scanner was serial — noticeable on NVMe-backed filesystems where
  the I/O layer can service 8+ concurrent `readdir` calls.
- `[diskhound-native-scanner] linux:` log lines now record walk
  start (with thread count) and end (files/dirs/skipped counters)
  so crash.log entries have the same diagnostic density as Windows.

### tar.gz build target alongside AppImage

electron-builder now produces both `DiskHound-<ver>-x86_64.AppImage`
(recommended, built-in auto-update) and `DiskHound-<ver>-x64.tar.gz`
(extract-and-run tree, no auto-update). Users whose distros have
trouble with AppImage's FUSE mount can grab the tar.gz instead.

Release workflow was updated to upload `release/*.tar.gz` to the
GitHub Release.

### Linux icon + .desktop metadata

AppImage users on Ubuntu reported a blank sidebar icon. Fixed by
adding explicit `linux.icon`, `linux.desktop` metadata to
electron-builder.yml:
- `Name`, `Comment`, `Categories`, `Keywords`, `StartupWMClass`
- 512×512 PNG embedded in the .desktop file's `Icon=` entry

### Responsive CSS for narrow windows

Drive pills in the header now scroll horizontally on overflow
instead of clipping, with a soft fade on the right edge hinting
more-content-offscreen. A new `@media (max-width: 780px)`
breakpoint:
- compresses pill padding + font size
- drops the used/free bar inside pills (not readable below 14 px)
- shrinks tab padding
- caps `.scan-input` tighter so drives get more room

Existing `@media (max-width: 960px)` breakpoint was extended with
a `max-width: 50vw` cap on `.drive-pills` so it can't steal all
the header space.

## 0.5.1 — 2026-04-24

Polish + bug-fix pass following the 0.5.0 public release. Everything
that shipped in local 0.5.1–0.5.9 iterations is consolidated here.

### Scan correctness + self-healing

- **Rescan truncation fix.** Non-elevated rescans following an
  elevated MFT scan were silently dropping every inherited file
  record — `Arc<ParallelSharedCtx>` held a clone of the baseline
  Arc through `try_unwrap`, so the post-walk stream got skipped
  and indices were written with 1.26 M dirs but only ~1968 file
  records. Explicit `drop(shared)` before `try_unwrap` fixes it.
- **Truncated-baseline auto-rejection.** A follow-up to the above:
  previous buggy scans left poisoned on-disk indices that
  self-propagated through subsequent rescans. The baseline loader
  now rejects any index where `file_records < dir_count / 2` (real
  NTFS has 5-50× more files than dirs), forcing a fresh full walk
  that rebuilds cleanly. User sees a one-time info toast
  explaining the rebuild. Self-healing — no manual intervention.
- **USN rescans carry forward the folder-tree sidecar.** USN-journal
  rescans update the NDJSON index but don't write a sidecar; the
  next Folders-tab open forced a 300+ MB rebuild via an OOM-prone
  worker. USN completion now copies the predecessor full scan's
  sidecar to the new history entry (near-perfect accuracy since
  USN deltas affect <1% of entries, refreshed on next full scan).
- **Folder-tree worker heap 8 GB → 12 GB.** Bigger headroom for
  drives past ~8 M records; paired with a `sidecar-empty-skip-rebuild`
  guard that avoids re-running the worker when the sidecar exists
  but parsed to zero entries.
- **Walker populates `directory_totals` for inherited subtree dirs.**
  Without this, the sidecar's `d` (subdirs) array was empty for every
  parent — Folders tab showed 21 files at C:\ and no subfolders on
  non-elevated rescans. The inheritance branch now primes
  `directory_totals` using the baseline's per-dir aggregates.

### Scan UX

- **Phase-first scan-status copy.** Scan-start elapsed time no longer
  lies about what's happening. `starting` (baseline load) → "Loading
  the prior scan's index — this speeds up the rescan". Previously a
  60-second baseline load was labelled "Getting ready" then followed
  by a "30-60 seconds" MFT-read estimate that read as contradictory
  at 1 m 23 s elapsed.
- **Walker sets `scan_phase`.** Non-elevated walker used to stay on
  `Starting` forever, clamping the UI at 99 % until scan-done. It now
  transitions `Indexing` → `Finalizing` with `expected_total_files`
  seeded from baseline.
- **Tile streaming on all scan paths.** The running-status snapshot
  now always includes the top-500 `largest_files` (up from the
  one-shot lite-mode flip). On elevated scans the tile_slot is
  assigned to the first-file shard instead of shard 0 — on dir-heavy
  drives shard 0 was entirely dirs and never published. Non-elevated
  walker's post-walk inherited-file stream emits progress every 50 K
  records so tiles stream there too.
- **Scheduled-task elevation reliability.** Tasks are now registered
  with `<UserId>` + `LogonType=InteractiveToken` + `RunLevel=
  HighestAvailable` instead of `<GroupId>S-1-5-32-544</GroupId>` —
  the Administrators-group principal made tasks invisible + un-
  runnable from the user's non-elevated shell. `hasScheduledTask`
  also distinguishes "access denied" from "doesn't exist" now.
  Settings toast surfaces the real schtasks error on failure.
- **Single-instance lock handles relaunch-as-admin.** Elevated child
  launched via `Start-Process -Verb RunAs` carries
  `--relaunched-as-admin`; lock acquisition retries up to 5 s for
  either that flag or `--launched-by-task` so the handoff doesn't
  leave the user with no window.

### Duplicates: 30-60 minute scans → seconds on repeat

- **Persistent SHA-256 cache** at
  `<userData>/duplicate-hash-cache.ndjson.gz`, keyed by
  `(path, size, mtime)`. Unchanged files skip the read+hash
  entirely on repeat scans. LRU-bounded at 500 k entries.
- **Cross-group parallelism.** Two flat `mapConcurrent` passes
  (prefix → bucket → full → bucket) replace the per-size-group
  serial loop. A 500-file bucket of 4 GB videos no longer blocks
  every other group.
- **Concurrency 8 → 16** (configurable via
  `DISKHOUND_HASH_CONCURRENCY`). Modern NVMe handles 16+ concurrent
  streaming reads without seek contention.
- **Streaming results into the UI.** Progress events carry a
  `newGroups` delta; the renderer appends groups to its list every
  ~200 ms so users see their biggest wasted-space finds within the
  first minute instead of waiting for scan-end.

### EasyMove: reliability + progress visibility

- **Robocopy `/b` fallback** for TrustedInstaller-owned paths (Hyper-V
  VHDX under `C:\ProgramData\...\Virtual Hard Disks\`, etc.).
  `fs.rename`/`fs.copyFile` use basic `CreateFileW` which doesn't
  enable `SeBackupPrivilege`; robocopy's `/b` flag does. Chain is:
  rename → copyFile → robocopy → elevation prompt.
- **`fs.mkdir` drive-root guard.** Moves to `E:\` (the drive root)
  were failing because Node's recursive mkdir doesn't short-circuit
  for existing drive letters (nodejs/node#43831). Now we
  `existsSync`-check before mkdir.
- **Live progress toast.** Stream-based cross-drive copies emit
  bytes-copied events every ~500 ms; a single upsert-by-id toast
  shows "Moving X / Y (Z %)" and updates in place. Robocopy path
  polls destination file size every 750 ms to surface progress for
  VHDX-sized moves. Link-creation phase emits `phase: "linking"` so
  the toast title flips to "Linking X…".
- **Post-creation link verification.** `createPlatformLink`
  `lstat`s the link after each of its three fallback methods
  (symlink → mklink → hardlink); throws if nothing's actually on
  disk. Previously each method could "succeed" silently without
  creating anything, saving a clean record for a broken link.
- **EasyMove verify UI** in the Easy Move tab. Auto-runs on mount;
  badges every record: `verified` / `link broken` /
  `dest missing` / `both missing` / `double file` /
  `needs admin to verify`. The last (new) category distinguishes
  ACL-locked source paths — previously EACCES on lstat was
  silently collapsed to "link broken" even when the link was fine.
- **Outer-catch error messages dispatch on `err.syscall`** so an
  `mkdir` failure says "Can't create destination folder" rather than
  the misleading "another process is holding the source file".
- **EasyMove diagnostic tracing** to `crash.log` via a
  `setEasyMoveLogger` hook. Every stat/rename/robocopy/link
  decision is logged.

### New features

- **GPU tab** (between CPU Heatmap and Affinity Rules). One
  PowerShell call pulls `\GPU Engine`, `\GPU Process Memory`,
  `\GPU Adapter Memory` counters + `Win32_VideoController` +
  `Get-Process`. Adapter cards (3D / Compute / Decode / Encode /
  Copy engine chips + dedicated/shared VRAM) + per-process table
  with right-click context menu (Reveal / Copy path / End / Force
  kill). Sampler caches `Win32_VideoController` across samples;
  timeout bumped 10 s → 20 s; phantom "Adapter 2" entries (Microsoft
  Basic Display Adapter) filtered out. Error messages summarised in
  the footer instead of leaking full PowerShell script text.
- **Affinity Rules tab** (Process Lasso-style). Persistent CPU
  affinity rules matched by exe-name or path-substring; main-process
  rule engine reapplies masks every ~4 s. Pin icon on every
  Processes view (list, treemap tiles, heatmap labels). Right-click
  on a pinned process opens "Edit affinity rule…" with the existing
  rule pre-loaded (no duplicate).

### Quality

- **62 vitest tests pass** (no regressions).
- All elevation/rescan/scan-phase logs use consistent `[easy-move]`,
  `[elevation-probe]`, `[scheduled-task]`, `[folder-tree-…]` tags for
  grep-friendly diagnostics.

## 0.5.0 — 2026-04-24

Processes + GPU overhaul, elevation robustness, and a scan-index
self-healing fix. The tentpole additions are a scrolling CPU heatmap, a
Process-Lasso-style affinity rules tab, a full per-process GPU viewer,
and a one-UAC "Always run as admin" scheduled-task flow. Along the way,
three fast-scan correctness bugs got caught and fixed; indices from
0.4.x are auto-rejected and rebuilt on first launch.

### Processes tab

- **CPU Heatmap view.** Scrolling spectrogram — rightmost column is
  "now", history flows left, amber intensity = CPU share. Each row
  pins a process; sparklines highlight recent spikes. Live-updates
  at the same 5 s cadence as the other process views.
- **Affinity Rules tab.** Persistent CPU-affinity rules matched by
  exe name OR path substring. The main-process rule engine re-applies
  matched processes' affinity masks every ~4 s, so Chrome / a
  compiler / whatever stays pinned to the cores you picked even
  across launches. Pinned processes show an amber 2×2-grid icon in
  every Processes view (list rows, treemap tiles, heatmap labels).
  Right-click a pinned process → "Edit affinity rule…" jumps
  straight to the editor pre-populated with the existing rule (no
  duplicate).
- **GPU tab.** New top-level view between CPU Heatmap and Affinity
  Rules. Adapter cards (utilisation %, dedicated VRAM used/total,
  shared memory, per-engine chips for 3D / Compute / Decode /
  Encode / Copy) + per-process table (icon, name, GPU %, VRAM,
  shared, top-2 engine chips, PID). One PowerShell call pulls
  `\GPU Engine(*)`, `\GPU Process Memory(*)`,
  `\GPU Adapter Memory(*)` counters plus `Win32_VideoController` +
  `Get-Process` together. Phantom Microsoft Basic Display Adapter
  entries filtered out. UTF-16 BOM tolerated in PowerShell output.

### Elevation / fast-scan reliability

- **One-UAC Always-run-as-admin.** Settings → Performance registers
  a Windows Scheduled Task bound to the current user's SID
  (`<UserId>` + `LogonType=InteractiveToken` +
  `RunLevel=HighestAvailable`). Every subsequent launch from the
  shortcut auto-elevates with **zero UAC prompts**. The task is
  runnable and queryable from the user's non-elevated shell —
  earlier builds bound it to the Administrators group SID, which
  returned "Access is denied" on `schtasks /run` from the normal
  shell and lied about existence on `schtasks /query`.
- **"Relaunch as admin" works.** The single-instance lock from the
  elevated-child spawn now recognises either `--launched-by-task`
  or `--relaunched-as-admin` argv flags and retries up to 5 s for
  the non-elevated parent to quit. Plain double-clicks still get
  a 1.5 s retry so they feel snappy.
- **Diagnostic logs.** `crash.log` records
  `elevation-probe: isElevated=… hasScheduledTask=… argv flags=…`
  plus every schtasks `/run` exit code + stdout + stderr. When
  something goes wrong, the actual cause is one file away.
- **EasyMove UAC retry.** Protected Windows paths (e.g. files under
  `\Windows\LiveKernelReports\`) hit EPERM on plain stat. EasyMove
  now returns `requiresElevation: true`; the renderer shows a
  confirm dialog; on accept a single UAC-elevated PowerShell does
  the move + symlink/junction creation. Batch moves coalesce
  multiple protected files into one confirm.

### Scan correctness (critical)

- **Post-walk stream always runs.** Non-elevated rescans that
  inherited from an elevated MFT baseline were silently dropping
  every inherited file record, reporting "24 dirs" on a 7 M-file
  drive. Root cause: `Arc<ParallelSharedCtx>` held a clone of the
  baseline Arc across `try_unwrap`, stranding strong_count at 2 and
  routing us through the "skip post-walk stream" fallback. Fix:
  explicit `drop(shared)` before the unwrap.
- **Mid-scan tile streaming restored.** Shard 0 now re-publishes
  its top-K every ~2 000 records (down from 5 000 once at the
  end), main pump consumes on every 200 ms tick (no more one-shot
  gate), and streamed snapshots are capped at 200 records so the
  Windows stdout pipe stays under its 64 KB buffer. Tiles show up
  within ~0.1 s of emit start instead of racing scan-done on fast
  drives.
- **Truncated-baseline self-healing.** Previous releases' scanner
  bugs could write index files with 1.26 M dir entries but only
  ~1 968 file records. Those poisoned indices self-propagated:
  every rescan inherited the 1 968 count and wrote a new
  truncated index. 0.5.0 detects this at load time
  (`file_records < dir_count / 2`), rejects the baseline, and
  forces a full walk that writes a clean replacement. Users see a
  one-time info toast ("Rebuilding scan index…"). Self-healing —
  no manual intervention required.

### UX polish

- **Single-instance lock.** Duplicate launches focus the existing
  window and exit, with the retry logic above ensuring the
  elevation-handoff scenarios don't leave users stranded.
- **"Edit affinity rule…" in context menu** replaces "Pin" when a
  rule already matches, with an amber highlight + pin icon. Kills
  duplicate-rule creation.

## 0.4.0 — 2026-04-23

### ⚡ MFT fast-scan path (the headline)

DiskHound now reads the NTFS Master File Table directly on Windows drives,
skipping the FindFirstFile walker entirely. On a 7 M-file C:\ drive this
drops a cold scan from ~18-20 minutes to **under 90 seconds** — including
path reconstruction, per-folder aggregation, and a full NDJSON + folder-tree
sidecar on disk.

Requires admin (`\\.\C:` is a privileged volume handle). First-run banner
offers "Relaunch as admin"; Settings → Performance has an "Always run as
admin" option that registers a Scheduled Task so subsequent launches skip
the UAC prompt entirely.

If admin isn't available, DiskHound falls through silently to the walker —
same behavior as 0.3.x, no regressions for unprivileged users.

### 🏎️ Parallel emit

Emit phase (the bookkeeping pass over MFT records) now runs across up to 8
worker threads with thread-local accumulators, merged at end. Paired with
a hand-rolled JSON writer and a background gzip-writer thread, emit time
on a 7 M-record drive drops from ~2 min → ~25 s.

### 📁 Folder-tree sidecar

The Rust scanner now emits a pre-built `<scanId>.folder-tree.ndjson.gz`
sidecar during the scan itself. The Folders tab loads this directly
(~6 s on 1 M parents) instead of re-streaming the full NDJSON index in a
Node worker (~5+ min with a 4-8 GB heap).

Sidecar write is parallelized across worker threads feeding a single gzip
writer — ~10 s on a 7 M-file drive, down from ~50 s serial.

### 🔁 USN-journal rescan fast-path

When a rescan is kicked off (manual or scheduled), DiskHound first probes
the volume's USN journal for any changes since the last scan. If nothing
has changed, the previous snapshot is reused instantly — **sub-second
rescans** on quiet volumes.

Falls back to a full scan when: no cursor persisted, journal was recreated
(journalId mismatch), or any records exist since the cursor.

### 🎨 UX improvements

- **First-run admin banner** with "Relaunch as admin" CTA.
- **Settings → Performance** section: status + two opt-in paths (one-time
  relaunch vs. persistent Scheduled Task).
- **Tile streaming mid-emit**: treemap lights up within ~2-3 s of emit
  start (shard 0 publishes its local top-K to main via
  `Arc<Mutex<Option<...>>>`).
- **Phase-aware progress**: UI title/subtitle/progress bar all consistent
  during `reading_metadata` → `indexing` → `finalizing` transitions;
  stats counters no longer reset mid-scan.
- **Folder tab actions column widened** 110 → 180 px so Move/Reveal/Open
  buttons don't overflow into the file-count column.
- **Treemap tooltip wraps long paths** instead of breaking out of its
  background box.
- **Full-diff and folder-tree workers bumped to 8 GB heap** from 4 GB —
  MFT emits ~25% more records than the walker (hardlink expansion +
  extension-record `$DATA` recovery) and was OOMing on drive-scale scans.

### 🛠️ Under the hood

- Scanner hand-rolls JSON emission for index records
  (`append_json_escaped` + `append_u64_decimal`) instead of
  `serde_json::to_writer` — ~5-10× faster in the tight per-record loop.
- Hardlinks are expanded during MFT read: one output record per
  `(parent_frn, name)` pair. Previously we kept only one name per FRN
  and missed files that appeared in multiple directories.
- `$ATTRIBUTE_LIST` records are no longer dropped; their resident
  `$FILE_NAME` and `$STANDARD_INFORMATION` still emit. Extension records
  carrying non-resident `$DATA` sizes are merged back into their base
  FRN (+2 TB of recovered sizes on one test drive).
- NTFS pseudo-files (`$MFT`, `$UsnJrnl`, the `$Extend` subtree, `System
  Volume Information`) are filtered so totals match what a regular
  walker would report.
- Index writer runs on a dedicated thread via a bounded crossbeam
  channel; main emit threads no longer block on per-record gzip.
- Gzip compression level dropped from `default` (level 6) to `fast`
  (level 1). ~25% larger index on disk, ~3-5× faster compression.
- Folder tree worker fall-back path got a faster NDJSON parser (regex
  on the canonical file-entry shape + early skip of dir entries).

### 🔧 Env-var knobs

- `DISKHOUND_NO_MFT=1` — skip the MFT path (falls straight through to
  the walker). Previously opt-in via `DISKHOUND_MFT=1`; now opt-out.
- `DISKHOUND_NO_PARALLEL=1` — skip the parallel walker.
- `DISKHOUND_PARALLEL_THREADS=N` — override parallel walker thread count.
- `DISKHOUND_EMIT_THREADS=N` — override MFT-emit shard count (default:
  `min(num_cpus, 8)`).
- `DISKHOUND_SIDECAR_THREADS=N` — override folder-tree sidecar shard
  count.

### Earlier releases

0.3.x versions were a long cycle of parallel-walker optimizations, USN
journal incremental monitoring, folder-tree persistence, and various
UX polish. Running diffs on git tags for the full commit history.
