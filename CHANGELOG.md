# Changelog

## 0.5.8 — 2026-04-24

EasyMove progress coverage extended to the two phases that used to
run silently:

- **Robocopy phase**. When a move hits the `/b` fallback (elevated
  moves of TrustedInstaller-owned files like a 12 GB Hyper-V VHDX),
  robocopy doesn't expose a parseable progress stream. We now poll
  the destination file's size every 750 ms during the robocopy run
  and emit progress events — user sees a live counter instead of a
  frozen toast.
- **Link-creation phase**. `createPlatformLink` is fast for
  symbolic links but can take 1–2 seconds for mklink + junctions.
  We now emit `phase: "linking"` immediately before that step so
  the toast title flips to "Linking X…" instead of showing the
  copying state at 100% until success lands.
- **`phase: "done"` on every exit path**. Progress toast now
  dismisses cleanly on robocopy failure, non-elevated short-
  circuit, link-failure rollback, and the outer error catch — no
  lingering "Copying" toasts after a failed move.

## 0.5.7 — 2026-04-24

Scan-status copy was contradicting itself on rescans of multi-million-
file drives. User reported seeing "Getting ready — could take a
couple of minutes on large drives (43 s elapsed)" → then "Reading
the volume's filesystem metadata — this can take 30-60 seconds on
drives with millions of files (1m 23 s elapsed)". The "30-60 s"
phrase was unreachable relative to the scan-start timer (we'd
already burned 60 s+ loading the baseline before the MFT read even
started) and "Getting ready" misrepresented a 45-second baseline
load as pre-scan prep.

Fix: dispatch on `scan_phase` first, only use elapsed time as a
qualifier. Three cases:

1. **`starting` phase** (baseline-index load on rescans): now says
   "Loading the prior scan's index — this speeds up the rescan"
   with tiered copy that acknowledges long waits honestly
   ("typical on drives with millions of files" → "large drives or
   slow disks can take 2-3 minutes") instead of "Getting ready".
2. **`reading_metadata` phase** (MFT bulk read): drops the absolute
   "30-60 seconds" claim that made elapsed timing look contradictory;
   now "typically 15-60 seconds of work, depending on file count" —
   the estimate is about the phase, not the total scan.
3. **fallback** (indexing / walker): unchanged early copy;
   transitions to "Indexing files — tiles will stream in as
   they're processed" once we're past the prep window.

Byproduct: first-scan users (no baseline to load) still see the
"Getting ready" → "first files should appear" → indexing arc
quickly. Only rescans see the new baseline-load copy, where it
actually applies.

## 0.5.6 — 2026-04-24

EasyMove robustness + progress visibility pass, driven by user
verification finding that a prior move had completed but left no
symlink at the source (silent failure in the 3-tier link fallback).

- **Post-creation link verification.** `createPlatformLink` now
  `lstat`s the link after each of its three fallback methods
  (symlink → mklink → hardlink) and throws if the link isn't
  actually there. Previously each fallback could "succeed" without
  actually creating anything on disk; the outer try/catch then saved
  a clean record even though the source was just … gone. Found via
  user verification: `C:\ProgramData\…\Ubuntu 22.04 LTS.vhdx` was
  missing with no link, easy-moves.json thought it was fine.
- **Which link method succeeded is now logged** — crash.log shows
  `[easy-move-link] method=symlink|mklink|hardlink verified=true`
  so future failures are easy to triage.
- **Easy Move tab verifies every record on mount.** New
  `verifyEasyMoves` IPC runs lstat on every record's source + dest
  and returns a status per entry. The UI badges each row as
  `verified` / `link broken` / `dest missing` / `both missing` /
  `double file` with hover tooltips explaining the state. A
  "Verify" button re-runs the check on demand.
- **Live progress toast for cross-drive copies.** Stream-based copy
  now fires progress events every ~500 ms with bytes-copied,
  bytes-total, and phase. A single upsert-by-id toast shows
  "Moving X / Y (Z%)" and updates in place until the move
  completes. Toast system extended with stable-id upsert + sticky
  mode (`dismissAfterMs: 0`) so progress entries don't multiply
  or auto-dismiss mid-copy.

## 0.5.5 — 2026-04-24

**EasyMove to drive roots (`E:\`, `D:\`, etc.) was broken.** 0.5.4's
diagnostic tracing surfaced the actual failure:

```
[easy-move] start src=C:\testing\...\headers dest=E:\
[easy-move] stat ok isDir=false size=88388496
[easy-move] outer catch error code=EPERM msg=EPERM: operation not permitted, mkdir 'E:\'
```

Node's `fs.mkdir('E:\\', { recursive: true })` throws EPERM on
Windows drive roots — Windows refuses `CreateDirectoryW` on a drive
letter even when it already exists. This is a known Node quirk
(see nodejs/node#43831) and the `recursive: true` option doesn't
short-circuit for drive roots.

Fix:
- Skip `fs.mkdir` entirely when `destinationDir` already exists.
- **Outer-catch error messages now dispatch on `err.syscall`**, so
  an `mkdir` failure says "Can't create destination folder" instead
  of the misleading "Another process is likely holding the file
  open" that blamed the source when the problem was on the
  destination side.
- Full underlying error message now appended to the toast so the
  diagnostic is visible without crash-log digging.

Users seeing the old "Another process is likely holding…" on a
simple .txt move were hitting this mkdir bug, not a real file lock.

## 0.5.4 — 2026-04-24

EasyMove diagnostics pass. Users reported EPERM-locked messages
on `C:\Windows\LiveKernelReports\*.dmp` even on elevated scans
despite 0.5.2's robocopy `/b` fallback. The existing logging stopped
at the scanner boundary — we couldn't tell whether robocopy was
actually invoked, what its exit code was, or whether `isElevated()`
was returning what we expected.

- **Crash-log tracing throughout `easyMove`**: every decision point
  now writes an `[easy-move]` entry (stat result, rename result,
  isElevated probe, robocopy spawn args + exit code + stdout/stderr,
  outer catch error code). Next time a user hits EPERM, the log
  will tell us exactly which tier failed.
- **Robocopy failure now returns a specific, actionable message**
  naming robocopy's exit code + hint about live processes
  (Hyper-V / WSL / dump consumers) — replaces the old generic
  "another process holding it open" string that masked the real
  robocopy diagnostic.

## 0.5.3 — 2026-04-24

Walker-scan polish pass, rooted in user-reported log evidence:

- **Folders tab showed 21 files / zero subdirs at C:\ on non-elevated
  rescans.** Root cause: the walker's inheritance branch wrote
  inherited dirs to the NDJSON index but skipped adding them to
  `state.directory_totals`. The sidecar builder assembles each
  parent's `d` (subdirs) array from `directory_totals` — with only
  the root present, every parent's `d` was `[]`. Fix: inheritance
  branch now populates `directory_totals` for every subtree dir
  using the baseline's `dir_total_sizes` + `dir_file_counts` for
  accurate per-dir size + file count. Applies to both the
  sequential walker and the parallel walker's root-inheritance
  shortcut. On a C:\ scan: root now shows C:\Users, C:\Windows,
  C:\ProgramData, etc. — 1 M+ dirs populated correctly in the
  sidecar instead of 0.

- **Progress bar stuck at 99% for minutes on non-elevated rescans.**
  Walker path never set `scan_phase`, so the UI's files-indexed
  fraction ("1.6 M / 8.3 M files indexed · 99%") never kicked in —
  the bar clamped at 99% with no hint the scan was still working.
  Fix: walker entry sets `scan_phase = Indexing` (seeds
  `expected_total_files` from baseline when available) and
  `Finalizing` at post-walk-stream entry. UI now shows a moving
  files-indexed fraction + "Finalizing" copy rather than a stuck
  percentage.

- **No tiles streaming during non-elevated scans.** The walker
  populates `state.largest_files` in-process, but
  `stream_inherited_files_into` (which processes 7 M+ inherited
  file records post-walk) didn't call `maybe_emit_progress`
  anywhere in its loop. Tiles grew in memory but never left to the
  UI. Fix: emit every 50 K records; maybe_emit_progress's 200 ms
  throttle handles the rate limit.

- **Abrupt tile update at scan-end.** Running snapshots carried
  top-200 tiles, Done carried top-5000. User saw the 4 800
  additional small rectangles pop in at finalization. Fix: bump
  running cap to 500. Pipe cost: ~1 MB/sec stdout at 5 emits/sec —
  modest. Done transition now feels like a polish rather than a
  redraw.

## 0.5.2 — 2026-04-24

EasyMove on TrustedInstaller-owned paths (Hyper-V VHDX in
`C:\ProgramData\Microsoft\Windows\Virtual Hard Disks\`, etc.) now
works. 0.5.1 got past `fs.stat` EPERM but `fs.rename` itself still
failed because Node doesn't enable `SeBackupPrivilege` — so even an
elevated DiskHound couldn't move the file.

Fix: escalate to `robocopy /move /b` when `fs.rename` hits a
permission error. `/b` (backup semantics) uses the admin token's
`SeBackupPrivilege`, which is specifically designed for this case —
Windows ships robocopy exactly for administrative moves across
ACL-locked files. Applies to both the direct move path (when already
elevated) and the elevated-PowerShell retry (when a non-elevated
user accepts UAC).

Non-elevated users hitting a protected path still get the
`requiresElevation: true` signal, so the renderer prompts for UAC
before attempting the move.

## 0.5.1 — 2026-04-24

Bug-fix follow-up to 0.5.0:

- **Folders tab empty / showing handful of entries after USN rescan.**
  USN-journal scans update the NDJSON index incrementally but never
  emitted a folder-tree sidecar, so `history[0]` became a USN scan
  with no sidecar, the next Folders-tab open fell through to the
  worker-based rebuild (300+ MB gzipped NDJSON → 1.5 GB decompressed),
  and on big drives the worker either OOM'd or produced a partial
  tree. Fix: USN completion now copies the predecessor full scan's
  sidecar forward to the new history entry. Accuracy is near-perfect
  (USN deltas affect a tiny fraction of entries) and the next full
  scan refreshes it. Logs: `[folder-tree-sidecar-carry-forward] usn
  scan <id> carried forward sidecar from <prev-id>`.

- **EasyMove EPERM on Windows-protected paths even when elevated.**
  Hyper-V VHDX files under `C:\ProgramData\Microsoft\Windows\Virtual
  Hard Disks\` are TrustedInstaller-owned, so `fs.stat` fails with
  EPERM even for admins (Node doesn't enable SeBackupPrivilege by
  default). Before: the user saw "Another process is likely holding
  the file open" but nothing was locking it. Fix: on stat EPERM,
  fall back to `lstat` (different CreateFile flags — works on more
  paths), or guess `isDirectory` from the filename extension and
  attempt the rename anyway. `fs.rename` on Windows only needs
  write access to the source directory, not the file metadata
  handle, so moves now succeed on paths where stat doesn't.

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
