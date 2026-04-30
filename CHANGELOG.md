# Changelog

## 0.5.13 — 2026-04-30

System Widget: click-through tiles, sparklines, stale callout,
DISK pressure color, chrome cleanup. Plus a small main-app
header tidy-up.

### Widget chrome cleanup

- **Dropped the "updated just now" subtitle.** With sampler
  cadences ranging from 3-10 s and `relativeTime` returning
  "just now" up to 60 s, the line was always-true noise. The
  widget being open + tiles updating IS the alive signal; the
  warning strip surfaces real problems.
- **Dropped the manual refresh button.** Auto-refresh + the
  existing `Ctrl/Cmd+R` shortcut cover every legitimate use.
  The button was anxiety UX and the spinning-icon affordance
  for the in-flight state went with it.
- **Dropped the live-pulse dot.** It only existed to anchor the
  subtitle line; with the line gone there was nothing to anchor
  to. Title bar collapses to drag-grip + brand mark + title +
  pin / open-main / close.

### DISK tile color now tracks pressure

The hero DISK tile was hard-coded to amber regardless of fill
percentage. A 92 %-full drive showed amber in the tile *while*
the per-drive bar below it correctly showed red — same drive,
same percentage, two different colors. Tile now picks the
gradient via the same `pressureClass` thresholds the drive bars
use (>90 critical → red, >75 warn → amber, else ok → green).
Added a new `red` accent variant covering the critical case.

### Click-through tiles + sections

Every tile and section in the widget is now a click-through into
the matching tab in the main app:

| Click | Lands on |
|---|---|
| DISK tile | Overview (active drive's treemap) |
| MEMORY / CPU / GPU tile | Processes |
| DISK I/O section | Disk I/O tab |
| LATEST SCAN section | Changes tab |
| Each drive row | Overview, with that drive primed in the picker |
| "+ N more drives" | Overview |

Plumbed via a new `focusMainWithView({ view, scanRoot? })` IPC
that brings the main window forward AND pushes a
`diskhound:navigate-view` message to its renderer. App.tsx
subscribes once on mount, sets `currentRoot` and `view` on
receipt. The widget's renderer never receives its own request
back — main only sends the navigate signal to the main window.

Stat tiles + clickable sections render as `<button>`, so they
get keyboard focus rings (amber outline) and a tiny "↗"
affordance in the corner that fades in on hover.

### Sparklines

A 60×16 px inline SVG trace next to each hero tile's value
shows the last ~20 samples. Per-metric ring buffer in the
widget; the polyline is plotted at fixed 0-100 scale (every
metric is a percent so absolute "where am I in this range?" is
the right framing). Stroke uses the tile's accent color via
`currentColor`, dimmed to 0.75 opacity so the absolute value
stays primary and the trend stays secondary.

20 points × per-metric cadence = 60-200 s of trend per tile —
long enough to read the slope, short enough to stay current.
Below 360 px width the sparkline hides entirely (cramped) and
the absolute value carries the load.

### Stale callout

Hidden in normal operation. When the memory sampler
(`sampledAt`) is older than 30 s, a small pulsing-amber pill
shows above the tiles: "stale · 1m 12s ago". Surfaces real
problems (sleep/wake, hung sampler) without adding noise during
normal use. Age ticks every 5 s via a separate `now` interval
so the user sees it climb without waiting on the next sampler
return.

### Settings push instead of poll (already in 0.5.11, now used)

The widget's theme handling switched from a 12 s `getSettings()`
poll to a push subscription on the new `onSettingsUpdated`
channel back in 0.5.11. This release is the first where it's
actually used end-to-end (the previous landings still had the
poll wired). Theme flips made in main reach the widget within
~1 ms.

### Main-app header

Picture-in-Picture-style icon for the System Widget button —
universal "open as floating window" affordance, recognisable
from Apple, YouTube, video apps. Was a generic "rectangle with
content rows" that read as "settings panel" or "document".

The three header utility buttons (search / widget / settings)
are now wrapped in a `.header-utilities` flex container with
4 px internal gap and a thin vertical divider in front of them,
so they read as a separate region from the drive pills next to
them. Header grid drops from 5 to 4 columns — the third utility
button used to spill into row 2 on narrow widths.

## 0.5.12 — 2026-04-30

Release pipeline: macOS goes universal, drops macos-13 dependency.

### Single universal Mac build

The 0.5.9 release matrix split macOS into separate macos-13 (x64)
and macos-14 (arm64) jobs to make sure each architecture got a
natively-built Rust scanner. Worked, but macos-13 free runners on
GitHub Actions are increasingly scarce — the v0.5.11 release run
sat queued for 22 minutes waiting on a macos-13 host before being
cancelled.

The 0.5.12 setup:

- Single `macos-14` runner builds **both** Rust targets
  (`aarch64-apple-darwin` + `x86_64-apple-darwin`) and `lipo`s
  them into a fat Mach-O binary. Cross-compiling x86_64 from
  arm64 hardware works out of the box — Apple's toolchain
  handles the cross-arch link with no extra setup.
- `electron-builder.yml` mac arch is now `universal`. Electron's
  `@electron/universal` package merges the per-arch `.app`
  bundles produced by electron-builder into a single fat `.app`,
  packaged into one `.dmg`.
- Output: `DiskHound-universal.dmg` — runs natively on both
  Apple Silicon and Intel Macs from a single download.

Tradeoff: the universal `.dmg` is ~30 % larger than a single-arch
build because it contains both architecture slices. For a
~200 MB Electron app that's ~60 MB extra — noise on modern
broadband, dramatically simpler UX (no "which Mac am I on?"
decision at download time).

README updated: replaced the two separate `DiskHound-x64.dmg` /
`DiskHound-arm64.dmg` links with a single `DiskHound-universal.dmg`.

This is the same approach Discord, Slack, Cursor, and most modern
Electron apps use today.

## 0.5.11 — 2026-04-30

Settings push, repurposed cleanup toggle, Disk I/O hardening,
README catch-up.

### Settings broadcast IPC (replaces widget poll)

The System Widget previously polled `getSettings` every 12 s to
catch theme flips made in the main app. Now the main process
pushes settings updates to every renderer window via a new
`diskhound:settings-updated` IPC channel — a theme switch in main
reaches the widget within ~1 ms instead of up to 12 s. Feels alive,
costs less.

The mechanism is `settingsStore.subscribe(listener)`: the store
fires after every successful `set` / `update`, main.ts wires that
to `BrowserWindow.webContents.send` for every renderer. Any code
path that mutates settings (the affinity-rule engine recording
`lastAppliedAt`, monitoring schedule changes, future tabs) flows
through the same broadcast automatically — callers don't need to
remember to publish.

Preload exposes `nativeApi.onSettingsUpdated((settings) => ...)`.

### Cleanup setting repurposed: `confirmPermanentDelete`

The `cleanup.safeDeleteToTrash` toggle has been functionally
dead since 0.5.8 (Largest Files always shows the Del button now).
Renamed to `confirmPermanentDelete` and given new meaning: when
true (default), per-row "Del" buttons across the app pop a
confirmation dialog before permanently deleting; when false, they
fire immediately for power users who know what they're doing.
Bulk operations ("Delete selected") always confirm regardless —
multi-target actions deserve friction even if the per-row knob is
off.

Migration: the normalizer reads the old `safeDeleteToTrash` key
as a fallback when `confirmPermanentDelete` is absent. Polarity
is identical (true = safer / show confirm), so existing
settings.json files keep their preference automatically.

Touched: FileList, Overview's FeaturedFileCard, Treemap context
menu, DuplicatesView's per-copy Del button. All four collapse to
the same pattern: always render the button, gate the inline
`confirm()` on the new setting.

### Disk I/O view hardening

- `DiskIoView.refresh` now guards against a null snapshot from the
  IPC bridge (Vite HMR / first paint can transiently resolve null
  through the lazy proxy). Previously a bridge hiccup mid-session
  could clobber a perfectly good cached snapshot and blank the
  tab.
- First-load effect: only swap the snapshot when the fresh sample
  is non-null; loading state still flips off either way so the
  spinner doesn't persist.

### README

- Added the System Widget feature description (incl.
  `Ctrl+Shift+W` shortcut).
- Added the Disk I/O viewer feature description with platform
  notes (Windows / Linux supported, macOS unavailable).
- Added `Ctrl+Shift+W` to the keyboard shortcuts callout.

## 0.5.10 — 2026-04-30

First tagged release containing the **System Widget** + **Disk I/O
tab**, plus a full UX overhaul of the widget.

### New: System Widget (always-on-top monitor)

A frameless, draggable, always-on-top mini-window showing live
disk capacity, disk I/O, CPU, GPU (Windows), memory, scan
status, and per-drive pressure. Triggers:

- Header button beside Settings.
- Tray menu → "Open System Widget".
- Keyboard: `Ctrl+Shift+W`.

Behavior: pin/unpin via the widget's toolbar (uses `floating`
level on macOS plus visible-on-all-workspaces while pinned),
remembers its own size + position via
`userData/widget-window-state.json`, runs entirely in a separate
renderer with its own theme + color-blind awareness.

### New: Disk I/O tab (Ctrl+8)

Per-process and per-volume disk-I/O sampling running on the
existing 5 s memory cadence. Tabs renumbered:
`Settings` moves from `Ctrl+8` to `Ctrl+9`.

### System Widget UX overhaul

The widget shipped functional in its first cut but read as a
different product — conic-gradient rings where everything else
is flat bars, heavy uppercase section heads, a generic chevron
pretending to be a pin, no drag affordance, no keyboard
handling, a permanent dead "GPU n/a" tile on Linux/Mac.
Rewrote against DiskHound's existing design language (mono
numerics, 9.5 px uppercase mono kickers, thin gradient bars).

#### Hero metrics

- Replaced the four 78 px conic-gradient `MetricDial` rings with
  flat `StatTile` cards mirroring `.diskio-metric` from the main
  app: 9.5 px mono kicker → 18 px tabular-nums value → 4 px
  gradient progress bar → mono sub-line. Same data, ~38 % less
  vertical space, fits the rest of DiskHound's vocabulary.
- Hero grid now adapts: 2-up below 460 px (the default 390 px
  width), 3-up at ≥460 px on macOS/Linux, 4-up on Windows. Was
  locked at 2-up regardless of width — at 560 px each tile was
  270 px wide.
- **GPU tile hidden on non-Windows** entirely. The previous
  permanent "n/a — Windows only" tile was 78 px of dead space on
  every Linux/Mac user's widget forever.

#### Affordances

- **Real thumbtack pin icon** with filled head when active. Was a
  generic chevron-with-tail that read as "elevate / promote";
  pinned vs unpinned states were nearly indistinguishable.
- **2×3 dot grip** on the left of the title bar — the de-facto
  "this is draggable" affordance on frameless utility windows
  (iStat, Stats, Loop). Subtle by default, brighter on titlebar
  hover.
- **DiskHound brand mark** (the same 16×16 stacked-tile SVG used
  in the main app header) anchors widget identity.
- **Live dot** stays green always now. Refreshing is signaled by
  a 1.2 s opacity pulse instead of switching to amber — amber is
  DiskHound's warn color and repurposing it for a benign refresh
  tick was confusing.
- **Refresh icon spins** while a refresh is in flight.
- **Focus-visible ring** (2 px amber outline) on every icon
  button. The previous rule collapsed `:focus-visible` into
  `:hover` with `outline: none`, leaving keyboard users blind.
- **Icon-group divider** before the close button so the
  destructive action is visually fenced off from refresh / pin /
  open-main.
- **Section heads** dropped from 11 px sans 700-weight uppercase
  to 9.5 px mono 600-weight — matches `.diskio-metric-label` and
  stops fighting the values for hierarchy.

#### Edge cases

- **First-paint skeleton.** Widget now renders a "Sampling
  system…" pulse until the first sampler returns instead of
  showing four "—%" tiles + "warming counters".
- **Sampler error stack.** Multiple simultaneous failures now
  each get their own row (deduped by source) and can wrap to two
  lines before truncating. Previously the first error overwrote
  the rest and the strip was one-lined with a tooltip.
- **Theme refresh.** Widget re-reads settings every 12 s so a
  dark/light flip in the main window propagates (the in-window
  `SETTINGS_UPDATED_EVENT` bus doesn't reach a separate
  renderer).
- **Idle scan bar** is now 0 % (was a phantom 8 % stub that made
  the widget look like something was always running).
- **Scan state colors** flow through the bar fill — running:
  amber→orange, done: solid green, error: solid red. Dropped the
  separate left-border accent.

#### Smaller polish

- `BrowserWindow.title` now matches the in-window text
  ("DiskHound Monitor" — was "DiskHound Widget"). User-visible
  in Alt-Tab / WM tooltips.
- Top-process line for Disk I/O now badges the dominant
  direction (`r` / `w` / `r+w`).
- Top-process line for CPU now shows `name 12 %` instead of bare
  process name.
- Drives section caps at 4 with a "+ N more drives →" overflow
  row that opens the main window's DiskPicker. Was 5 with no
  overflow indicator.
- Drive pressure thresholds renamed `low/mid/high` →
  `ok/warn/critical` to match the main app's DriveCard.
- Disk-I/O baseline placeholder hidden for the first 4 s so a
  cold-start doesn't surface an unexplained "baseline" string.
- Sampler issue copy: removes "Windows only", "warming
  counters", and similar imprecise phrases. Either show real
  data or show nothing.
- **Keyboard.** `Esc` closes the widget; `Ctrl/Cmd+R`
  refreshes (preventDefault'd so it doesn't reload the renderer
  process).

## 0.5.9 — 2026-04-28

Release-pipeline + cross-platform polish pass.

### macOS arm64 builds are now actually arm64

The release workflow ran `electron-builder` on a single
`macos-latest` runner (currently macOS 14, arm64) and asked it to
package both arm64 and x64 — which meant the x64 native scanner
was a cross-compile that may or may not have actually shipped in
the .dmg. Split into two macOS jobs:

- `macos-13` builds the `x86_64-apple-darwin` Rust target and
  packages with `electron-builder --mac --x64`.
- `macos-14` builds the `aarch64-apple-darwin` Rust target and
  packages with `electron-builder --mac --arm64`.

Each runner now produces exactly one binary, natively-built for
its target. Same approach applied to Windows + Linux jobs
(`--win --x64`, `--linux --x64`) so each runner only emits its
own artifact. Also wires `cargo build --target ${rust-target}`
explicitly and stages the produced binary at
`target/release/<bin>` where electron-builder expects it.

### macOS disk listing

`getDiskSpace()` was calling `df -P -k -T` on every Unix host —
but `-T` is a GNU coreutils flag, BSD/macOS `df` rejects it and
the whole call failed silently, leaving the drive picker empty
on Mac. Split into a separate `getMacDiskSpace()` that:

- Uses POSIX-portable `df -P -k` (no `-T`).
- Filters `/System/Volumes/*` (paired with `/` on APFS — Finder
  shows them as one disk, we should too), `/dev`, the swap mount
  at `/private/var/vm`, and zero-sized devfs entries.
- Keeps the modern APFS `/` ("Macintosh HD"), `/Volumes/*`
  external/network shares, and direct `/dev/*` mounts.

Also fixes mount paths containing spaces (`/Volumes/Media Share`)
on both Linux and Mac — previously `parts[6]` truncated at the
first space and dropped the trailing path component.

New `parseMacDfOutput` test (2 cases, +2 to the suite total)
covers happy-path + virtual-volume filtering.

### Drive card label

The drive card was hard-coding a trailing `:` after the drive
label, which read fine for Windows (`C:`) but produced
`/Users:` on macOS / `/:` on the Linux root. Now strips trailing
slashes/backslashes and shows the bare path.

### Rust scanner

- **Final scan_phase = Complete.** The `Done` message now carries
  `ScanPhase::Complete` instead of leaking whatever phase was last
  active (Walk / Indexing). Cosmetic but the renderer was briefly
  showing "Indexing… (done)" between the last progress event and
  the snapshot swap.
- **`allocated_size` cfg gate** simplified to `#[cfg(not(windows))]`.
  Only the Linux/Mac `scan_generic` walker calls it (the Windows
  scanner uses MFT and never touches Node's `stat`), so the
  `metadata.len()` Windows fallback was dead code.

### CI

`rust-check` job now runs on Windows + Linux + macOS instead of
just Windows. Catches `#[cfg(...)]` regressions like the one
above before they reach a release tag.

## 0.5.8 — 2026-04-26

Largest Files tab — pagination + always-on permanent delete.

### 1K-row pagination

Rendering 50K files (the scanner's default top-file ceiling) in a
single Preact pass cost ~600 ms and made every keystroke in the
filter input stutter. The list now renders the top 1,000 rows of
the filtered+sorted view by default and offers two follow-up
actions:

- **Load N more** — bumps the limit by another page (1,000).
  Bounded N to "remaining matches" so the label is honest.
- **Show all** — bypasses pagination for users who want to
  scroll everything (e.g. exporting). Tooltipped warning that
  it may lag on very large result sets.

Filter / sort / quick-filter changes reset the page to 1, so
narrowing the view (e.g. picking the Video chip) doesn't leave
the user stuck on a stale tail of the list.

Bulk actions ("Trash selected", "Delete selected", "Move
selected") now operate on the full filtered selection — not just
the rendered page. Without this, paginating with rows ticked on
page 1 then page 2 would silently drop page-1's selection from
the bulk action. The selection counter shows
"X selected (of N matching)" so the larger-than-visible target
set is obvious before clicking.

"Select all" was renamed to "Select page" to match the new
semantics: it toggles every checkbox on the visible page, not
across the entire filtered result.

### Permanent delete always available

The per-row "Del" and bulk "Delete selected" buttons used to be
gated on a global Settings toggle (`cleanup.safeDeleteToTrash`)
which defaulted to "trash only." Hiding the permanent option
behind a settings round-trip was hostile when the user knew
exactly what they wanted to do — a Steam cache, a deleted-but-
still-trashed VM image, etc. Both buttons are now always
visible. The confirm dialog gained stronger irreversibility
wording ("SKIPS the trash and CANNOT be undone — the OS will
free the bytes immediately") to compensate for the reduced
friction.

## 0.5.7 — 2026-04-24

Window-geometry persistence + icon sharpness pass.

### Persist window size / position across restarts

DiskHound now remembers width, height, x, y, and maximize /
fullscreen state between launches. Saved to
`userData/window-state.json` via a new `windowStateStore` that
mirrors the existing settings/scan store pattern (no new
dependencies).

Cross-platform behavior:

- **Windows / Linux**: x/y honored. Window comes back where you
  left it.
- **macOS**: maximize maps to "zoom" (fills work area minus
  dock/menu bar). Fullscreen restoration opens a new Space and
  animates ~500 ms. Both correct.
- **Multi-monitor sanity**: on every launch we validate the
  saved rect against `screen.getAllDisplays()`. If you've
  unplugged a monitor and the saved position is now off-screen,
  the position is dropped and the WM centers the window —
  better than stranding it on a phantom display.

Save cadence is debounced ~400 ms during a drag/resize so a slow
window-resize doesn't generate one disk write per frame. The
debounce is flushed on `app.before-quit` and on the window's
`close` event so we never lose a final-state save.

### Icon sharpness — supersampled AA + 96/192 sizes

Sidebar icon rendered "jaggedy / lower-res" on Ubuntu 22.04 even
at 64-96 px dock sizes. Two causes:

1. **GNOME upscaled `64.png` to fit the dock** because we shipped
   no closer match. Adding 96.png and 192.png (both standard
   freedesktop hicolor sizes) means GNOME picks an exact match
   for the default-scale dock and the 200%-scale HiDPI dock,
   eliminating the upscale step.
2. **Hand-rolled `fillRoundedRect` AA was 1 px wide.** At small
   target sizes, that gradient was wider than the corner itself,
   producing stair-stepped edges on rounded blocks. The
   generator now renders every icon at 3× target dimensions and
   box-filter downsamples — same pixels of detail, dramatically
   smoother corners and edges.

`linuxDesktopIntegration.ts` updated to install the new sizes
into `~/.local/share/icons/hicolor/`.

## 0.5.6 — 2026-04-24

Icon design correction. 0.5.5 over-simplified the icon to fix the
top-bar legibility problem — the sidebar at 64-96 px ended up
showing only 4-5 blocks where it used to show a rich 8-block
treemap, and the top-bar got a single orange tile that GNOME's
Yaru theme washed out to a near-white square because flat colors
are exactly what theme recoloring filters target.

The right tradeoff is to use the v0.5.3 8-block treemap at every
size where it physically fits (≥32 px), and only fall back at
16-24 px to a 2×2 grid of bold tiles — four distinct colors are
detail GNOME can't desaturate to "background", so the top-bar
icon now stays recognisable as DiskHound regardless of theme.

### Icon generator

- ≥32 px: full 8-block treemap (the design from v0.5.3 that
  matches the in-app Overview tab).
- ≤24 px: 2×2 grid of orange / dark-orange / red / blue.
- Padding back to v0.5.3's 7.8% at large sizes (the 8-18% range
  in 0.5.5 was over-cropping the dock icon).

## 0.5.5 — 2026-04-24

Icon design fix. 0.5.4 got the desktop integration working, which
*revealed* a second problem: the icon design itself didn't scale
to the small sizes GNOME actually requested. The top-bar icon
next to "Activities" rendered as a near-black blob (8 colored
blocks at 16 px is ~2 px each — they just dissolve into the dark
frame), and the dock icon at 64-96 px looked like noise instead
of an app silhouette.

### Size-responsive icon rendering

`scripts/generate-icon.mjs` now picks a different block layout
per size tier:

- **≤24 px** — single bold orange tile. Recognisable as
  "DiskHound orange" against any GNOME top-bar background.
- **32-48 px** — 2×2 grid of four big blocks (orange / dark
  orange / red / blue). Hints at the treemap concept without
  dissolving.
- **64-96 px** — 5-block layout. Drops the smallest two tiles
  from the full design so adjacent blocks don't fuse during
  downscale.
- **128+ px** — full 8-block treemap, unchanged.

Padding scales up at small sizes too (was a flat 7.8% across all
sizes — collapsed to 1 px at 16 px and was effectively invisible).
Now 14% at ≤24 px, 10% at ≤48 px, 8% at large sizes. Same with
gaps between tiles. 3D highlight/shadow cues skip below 64 px
where every pixel matters for legibility.

Outer corner radius bumped from 14% to 18% so the silhouette
reads more like a "tile" than a "square" against the round-ish
neighbours in the GNOME dock (Firefox, Settings).

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
