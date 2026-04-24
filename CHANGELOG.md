# Changelog

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
