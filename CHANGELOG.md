# Changelog

## 0.5.41 — 2026-05-29

DiskHound keeps the protected-folder delete guardrails from 0.5.40, but
backs off the default hiding for large space buckets users may actually
need to inspect.

### Protected folder visibility

- ProgramData and Recycle Bin remain protected from Trash, permanent
  Delete, Easy Move, and parent-folder moves.
- ProgramData and Recycle Bin are visible by default in folder scan
  results, so their space shows as normal drill-in tiles instead of only
  being rolled into the parent total.
- Stricter operating-system folders such as Windows, Program Files,
  System Volume Information, and Recovery remain hidden from Folders by
  default while still counting toward totals.

### Tests

Added coverage for visible-but-protected folders so cleanup visibility
and destructive protection stay separate.

## 0.5.40 — 2026-05-28

DiskHound now protects operating-system folders from accidental cleanup
while still counting their space in scan totals. This keeps disk-usage
math honest without putting risky system paths directly in the normal
cleanup flow.

### Protected folder guardrails

- Added default protected folders for Windows, macOS, and Linux system
  locations.
- The Folders tab hides protected direct children by default, but parent
  totals still include their bytes and item counts.
- Trash, permanent delete, Easy Move, cleanup suggestions, duplicate
  cleanup, Changes, Overview, Treemap, and folder/file lists now refuse
  protected paths.
- Parent folders that contain a protected subtree are blocked too, so
  moving or deleting a higher-level folder cannot carry protected files
  along by accident.

### Settings and context menus

- Added Settings > Protected Folders with add, remove, browse, reset
  defaults, and a Folders-tab visibility toggle.
- Added right-click protection actions on file and folder surfaces:
  protect this folder for directories, or protect parent folder for
  files.
- Protected rows show badges and disabled destructive actions instead of
  relying only on backend refusal.

### Tests

Added shared path-protection coverage for default folders, path
normalization, exact/nested matching, parent derivation, and destructive
action blockers.

## 0.5.39 — 2026-05-20

User confirmed v0.5.38 hit the long-standing full-diff-worker OOM on
a 7.8M-file drive. Symptom: opening the Changes tab triggers the
full per-file diff, which loads ~7M index entries into a `Map<path,
record>` to look up cross-references against the streamed-from-disk
other side. The 8 GB worker heap wasn't enough.

What it affects (user-visible):
- The top-N summary file list (`FileDeltaList`) and directory deltas
  keep working.
- The full per-file diff (`FullDiffList` — every changed file, not
  just the largest tracked ones) falls back to an error toast.

### Three fixes

**Compact map encoding.** Was `Map<string, {p: string, s: number}>`; now
`Map<string, [origPath: string | null, size: number]>`. On POSIX
(case-sensitive volumes) the normalised key always equals the original
path, so we set `origPath = null` and save the entire duplicate ~200 B
string per entry. For a 7M-file POSIX scan that frees ~1.4 GB. Windows
users with mixed-case paths see smaller savings; all-lowercase paths get
the full win.

**Heap ceiling 8 GB → 12 GB.** Reserved pages don't commit until touched,
so small diffs still pay zero extra. The 12 GB ceiling covers up to
roughly 10M-file index pairs on a box with 16+ GB RAM. Beyond that we'd
need external-sort-style streaming merge, which is a much bigger
architectural change (left as future work).

**Better error message** when OOM does still hit: explains the 12 GB
limit, points out the top-N summary still works, and doesn't suggest
"smaller diff pair" (the user has no control over the index size on a
given drive).

### Tests

`fullDiffWorkerRuntime.test.ts` (5 tests) updated and still passing — the
compact-value refactor is purely an internal shape change; the result
shape is identical.

## 0.5.38 — 2026-05-20

DiskHound v0.5.38 focuses on scan performance and Changes-tab clarity.

### Faster scans

- Added a native scanner engine for Windows, macOS, and Linux.
- Added bundled native-scanner resolution so packaged builds can use the
  Rust scanner without requiring a local toolchain.
- Kept the TypeScript scanner as the compatibility fallback.

### Changes tab

- Added clearer empty and loading states when there is no previous scan
  or no diff data available.
- Improved scan-history selection so users can compare retained scans
  more reliably.

### Tests

Added runtime coverage for native scanner resolution and full-diff worker
behavior.
