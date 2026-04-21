use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;

/// Global cancellation flag — set by signal handlers.
static CANCELLED: AtomicBool = AtomicBool::new(false);

#[cfg(not(windows))]
use jwalk::WalkDir;
use serde::Serialize;

#[cfg(windows)]
mod usn_journal;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW,
    FindNextFileW, FIND_FIRST_EX_LARGE_FETCH, FILE_ATTRIBUTE_DEVICE,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    WIN32_FIND_DATAW,
};

// Generous internal caps — large enough that no user reasonably hits them,
// small enough that a multi-million-file scan stays memory-safe. The full
// per-file index on disk (NDJSON) is the source of truth for the treemap.
const DEFAULT_TOP_FILE_LIMIT: usize = 5_000;
const DEFAULT_TOP_DIRECTORY_LIMIT: usize = 10_000;
const TOP_EXTENSION_LIMIT: usize = 12;
const SNAPSHOT_INTERVAL_MS: u128 = 200;
const WINDOWS_TO_UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;

#[derive(Debug, Clone)]
struct ScanInput {
    root_path: PathBuf,
    top_file_limit: usize,
    top_directory_limit: usize,
    index_output: Option<PathBuf>,
    /// Optional previous scan's index. When provided, directories whose
    /// mtime matches the baseline have their subtree inherited instead
    /// of walked — typical 10-50x speedup on mostly-idle drives.
    baseline_index: Option<PathBuf>,
}

/// Empty options struct — kept for IPC contract stability with the JS side.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanOptions {}

#[derive(Serialize)]
struct IndexEntry<'a> {
    p: &'a str,
    s: u64,
    m: u64,
}

#[derive(Serialize)]
struct DirIndexEntry<'a> {
    p: &'a str,
    t: &'static str,
    m: u64,
}

/// Streams one gzipped NDJSON line per file to an output path.
/// Stdout is reserved for the scan snapshot JSON protocol — this writes
/// to the dedicated index file only.
struct IndexWriter {
    encoder: GzEncoder<BufWriter<File>>,
}

impl IndexWriter {
    fn create(path: &Path) -> io::Result<Self> {
        let file = File::create(path)?;
        // BufWriter sits between the gzip encoder and the file so that gzip
        // (which does not buffer) isn't making syscalls on every small write.
        let buffered = BufWriter::new(file);
        let encoder = GzEncoder::new(buffered, Compression::default());
        Ok(IndexWriter { encoder })
    }

    fn write_dir_entry(&mut self, path: &str, mtime: u64) -> io::Result<()> {
        let entry = DirIndexEntry {
            p: path,
            t: "d",
            m: mtime,
        };
        serde_json::to_writer(&mut self.encoder, &entry)?;
        self.encoder.write_all(b"\n")
    }

    fn write_entry(&mut self, path: &str, size: u64, mtime: u64) -> io::Result<()> {
        let entry = IndexEntry {
            p: path,
            s: size,
            m: mtime,
        };
        serde_json::to_writer(&mut self.encoder, &entry)?;
        self.encoder.write_all(b"\n")
    }

    fn finish(self) -> io::Result<()> {
        let mut buffered = self.encoder.finish()?;
        buffered.flush()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanFileRecord {
    path: String,
    name: String,
    parent_path: String,
    extension: String,
    size: u64,
    modified_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryHotspot {
    path: String,
    size: u64,
    file_count: u64,
    depth: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionBucket {
    extension: String,
    size: u64,
    count: u64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ScanStatus {
    Running,
    Done,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ScanEngine {
    NativeSidecar,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanSnapshot {
    status: ScanStatus,
    engine: ScanEngine,
    root_path: Option<String>,
    scan_options: ScanOptions,
    started_at: Option<u64>,
    finished_at: Option<u64>,
    elapsed_ms: u64,
    files_visited: u64,
    directories_visited: u64,
    skipped_entries: u64,
    bytes_seen: u64,
    largest_files: Vec<ScanFileRecord>,
    hottest_directories: Vec<DirectoryHotspot>,
    top_extensions: Vec<ExtensionBucket>,
    error_message: Option<String>,
    last_updated_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Message {
    Progress { snapshot: ScanSnapshot },
    Done { snapshot: ScanSnapshot },
    Error { message: String },
}

struct ScanState {
    input: ScanInput,
    root_path_string: String,
    started_at_ms: u64,
    started_at_instant: Instant,
    files_visited: u64,
    directories_visited: u64,
    skipped_entries: u64,
    bytes_seen: u64,
    largest_files: Vec<ScanFileRecord>,
    hottest_directories: Vec<DirectoryHotspot>,
    directory_totals: HashMap<String, DirectoryHotspot>,
    extension_totals: HashMap<String, ExtensionBucket>,
    last_emit_elapsed_ms: u128,
    index_writer: Option<IndexWriter>,
    /// Baseline used by the Phase-1 mtime-skip optimization. None when the
    /// caller didn't pass --baseline-index or when parsing it failed.
    baseline: Option<Baseline>,
    /// Directory paths (normalized) whose subtrees were inherited from the
    /// baseline during the walk. After the walk completes we do one more
    /// streaming pass over the baseline to copy file records under these
    /// prefixes into the new index + update top-N file and extension stats.
    inherited_prefixes: Vec<String>,
    /// Diagnostic counters — emitted on stderr so we can confirm the fast
    /// path actually fires in production builds.
    inherited_dirs: u64,
    inherited_files: u64,
}

/// Preloaded baseline from a previous scan's NDJSON index — streaming
/// variant that keeps per-directory metadata in memory but NOT individual
/// file records. For a drive with 7M files this holds ~150 MB of state
/// instead of ~2 GB, because cumulative file counts + sizes are O(dirs)
/// rather than O(files).
///
/// During the walk we use this to cheaply decide "is this dir's mtime
/// unchanged" and "how many files/bytes live under this dir" so running
/// progress counters stay accurate. After the walk we stream the full
/// baseline index a second time to copy actual file records into the new
/// index file for the subtrees we inherited.
struct Baseline {
    baseline_path: PathBuf,
    dir_mtimes: HashMap<String, u64>,
    /// Recursive total file count under each directory (bubbled up from
    /// leaves during load). Indexed by normalized dir path.
    dir_file_counts: HashMap<String, u64>,
    /// Recursive total bytes under each directory.
    dir_total_sizes: HashMap<String, u64>,
    /// Set of all dir paths present in the baseline — used for re-emitting
    /// dir entries under inherited subtrees in the new index.
    dirs: HashSet<String>,
}

impl Baseline {
    /// First pass over the baseline NDJSON: collect per-directory metadata
    /// (mtimes + cumulative file counts + cumulative bytes) without
    /// materializing individual file records. File data is re-streamed in
    /// `stream_inherited_files_into` after the walk completes.
    ///
    /// Calls `on_heartbeat` every `HEARTBEAT_LINES` lines so the caller
    /// can emit Progress snapshots during baseline load — on a drive with
    /// millions of prior-scan records this phase used to take 20-40s of
    /// stdout silence, long enough for the renderer's "0 files" display
    /// to look dead.
    fn load_metadata<F: FnMut(u64)>(path: &Path, mut on_heartbeat: F) -> Option<Baseline> {
        const HEARTBEAT_LINES: u64 = 100_000;
        let file = File::open(path).ok()?;
        let reader = BufReader::new(GzDecoder::new(BufReader::new(file)));

        let mut dir_mtimes: HashMap<String, u64> = HashMap::new();
        let mut dirs: HashSet<String> = HashSet::new();
        let mut dir_file_counts: HashMap<String, u64> = HashMap::new();
        let mut dir_total_sizes: HashMap<String, u64> = HashMap::new();
        let mut lines_read: u64 = 0;

        // Typed-struct deserialization — measurably faster than the prior
        // serde_json::Value approach because serde can stream the fields
        // it cares about without building a dynamic tree per line.
        #[derive(serde::Deserialize)]
        struct BaselineRec<'a> {
            p: &'a str,
            #[serde(default)]
            s: Option<u64>,
            #[serde(default)]
            t: Option<&'a str>,
            #[serde(default)]
            m: Option<u64>,
        }

        for line in reader.lines() {
            let Ok(line) = line else { continue };
            if line.is_empty() {
                continue;
            }
            lines_read += 1;
            if lines_read % HEARTBEAT_LINES == 0 {
                on_heartbeat(lines_read);
            }

            let Ok(rec) = serde_json::from_str::<BaselineRec>(&line) else {
                continue;
            };
            let is_dir = rec.t == Some("d");
            let normalized = normalize_path(Path::new(rec.p));

            if is_dir {
                let mtime = rec.m.unwrap_or(0);
                dir_mtimes.insert(normalized.clone(), mtime);
                dirs.insert(normalized);
                continue;
            }

            let Some(size) = rec.s else {
                continue;
            };

            // Bubble the file's size/count up to every ancestor directory.
            // This gives us O(1) "how much is under dir D" lookups during
            // the walk without having to store individual file records.
            let mut current = Path::new(rec.p).parent().map(normalize_path);
            while let Some(dir) = current {
                if dir.is_empty() {
                    break;
                }
                *dir_file_counts.entry(dir.clone()).or_insert(0) += 1;
                *dir_total_sizes.entry(dir.clone()).or_insert(0) += size;
                let parent = Path::new(&dir).parent().map(normalize_path);
                if parent.as_deref().map(str::is_empty).unwrap_or(true)
                    || parent.as_deref() == Some(dir.as_str())
                {
                    break;
                }
                current = parent;
            }
        }

        // Final heartbeat so the caller sees the full line count.
        on_heartbeat(lines_read);

        Some(Baseline {
            baseline_path: path.to_path_buf(),
            dir_mtimes,
            dir_file_counts,
            dir_total_sizes,
            dirs,
        })
    }

    /// Return all directory paths at or under the given root. Used when we
    /// inherit a subtree so we can re-emit dir entries in the new index.
    fn subtree_dirs(&self, dir_path: &str) -> Vec<String> {
        let prefix = if dir_path.ends_with(std::path::MAIN_SEPARATOR) {
            dir_path.to_string()
        } else {
            format!("{}{}", dir_path, std::path::MAIN_SEPARATOR)
        };
        self.dirs
            .iter()
            .filter(|d| d.as_str() != dir_path && d.starts_with(&prefix))
            .cloned()
            .collect()
    }
}

/// Second pass: stream the baseline NDJSON and copy file records (not
/// dir records — those were emitted during the walk) into the new index
/// for any inherited subtree. Also updates the scan's `largest_files`
/// and `extension_totals` so post-inherit snapshots are complete.
///
/// Extracted as a free function instead of an impl method so it can
/// borrow state mutably without fighting the borrow checker against a
/// live &self.baseline borrow.
fn stream_inherited_files_into(
    baseline_path: &Path,
    inherited_prefixes: &[String],
    state: &mut ScanState,
) -> io::Result<()> {
    if inherited_prefixes.is_empty() {
        return Ok(());
    }

    // Pre-compute path-separator-suffixed prefixes so we don't mismatch
    // `/foo/bar` against `/foo/barbaz/thing.txt`.
    let normalized_prefixes: Vec<(String, String)> = inherited_prefixes
        .iter()
        .map(|p| {
            let with_sep = if p.ends_with(std::path::MAIN_SEPARATOR) {
                p.clone()
            } else {
                format!("{}{}", p, std::path::MAIN_SEPARATOR)
            };
            (p.clone(), with_sep)
        })
        .collect();

    let file = File::open(baseline_path)?;
    let reader = BufReader::new(GzDecoder::new(BufReader::new(file)));

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(path_str) = value.get("p").and_then(|v| v.as_str()) else {
            continue;
        };
        let is_dir = value.get("t").and_then(|v| v.as_str()) == Some("d");
        if is_dir {
            // Dir entries were already emitted during the walk's inherit
            // path, so we don't re-emit them here.
            continue;
        }

        let normalized = normalize_path(Path::new(path_str));
        let under_inherit = normalized_prefixes
            .iter()
            .any(|(eq, prefix)| normalized == *eq || normalized.starts_with(prefix.as_str()));
        if !under_inherit {
            continue;
        }

        let Some(size) = value.get("s").and_then(|v| v.as_u64()) else {
            continue;
        };
        let mtime = value.get("m").and_then(|v| v.as_u64()).unwrap_or(0);

        let name = Path::new(path_str)
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("")
            .to_string();
        let extension = file_extension(&name);

        // Write to new index so the index remains a complete baseline for
        // the NEXT scan.
        if let Some(writer) = state.index_writer.as_mut() {
            let _ = writer.write_entry(&normalized, size, mtime);
        }

        // Update top-N + extension aggregates. Note: directory_totals +
        // bytes_seen were updated at inherit time in the walk using the
        // precomputed dir aggregates, so we skip those here to avoid
        // double-counting.
        let parent = Path::new(path_str)
            .parent()
            .map(normalize_path)
            .unwrap_or_default();
        let file_record = ScanFileRecord {
            path: normalized,
            name,
            parent_path: parent,
            extension: extension.clone(),
            size,
            modified_at: mtime,
        };
        upsert_ranked_file(&mut state.largest_files, file_record, state.input.top_file_limit);
        rollup_extension(&mut state.extension_totals, &extension, size);
    }

    Ok(())
}

fn main() {
    // Register signal handler for graceful cancellation.
    // On Windows, Node sends SIGTERM which triggers CTRL_CLOSE_EVENT.
    // On Unix, SIGTERM and SIGINT are caught.
    register_signal_handler();

    // Dispatch to USN-related subcommands before the standard scan path
    // so we don't require --root in those modes.
    let raw_args: Vec<String> = std::env::args().skip(1).collect();

    let is_journal_mode = raw_args.iter().any(|a| a == "--mode=journal")
        || matches_flag(&raw_args, "--mode", "journal");
    let is_cursor_query = raw_args.iter().any(|a| a == "--mode=query-cursor")
        || matches_flag(&raw_args, "--mode", "query-cursor");

    if is_journal_mode || is_cursor_query {
        #[cfg(windows)]
        {
            let result = if is_cursor_query {
                run_cursor_query(&raw_args)
            } else {
                run_journal_mode(&raw_args)
            };
            if let Err(error) = result {
                let _ = emit_message(&Message::Error { message: error });
                std::process::exit(1);
            }
            return;
        }
        #[cfg(not(windows))]
        {
            let _ = emit_message(&Message::Error {
                message: "USN journal mode is Windows-only".to_string(),
            });
            std::process::exit(1);
        }
    }

    if let Err(error) = run() {
        let _ = emit_message(&Message::Error {
            message: error.to_string(),
        });
        std::process::exit(1);
    }
}

fn matches_flag(args: &[String], name: &str, value: &str) -> bool {
    let mut iter = args.iter();
    while let Some(a) = iter.next() {
        if a == name {
            if let Some(next) = iter.next() {
                if next == value {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(windows)]
fn run_journal_mode(args: &[String]) -> Result<(), String> {
    let mut drive_letter: Option<char> = None;
    let mut cursor: Option<i64> = None;

    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--mode" => {
                // already validated to be "journal"
                let _ = iter.next();
            }
            "--mode=journal" => {}
            "--volume" => {
                let v = iter
                    .next()
                    .ok_or_else(|| String::from("Expected drive letter after --volume"))?;
                let trimmed = v.trim_end_matches(':').trim_end_matches('\\');
                let ch = trimmed
                    .chars()
                    .next()
                    .ok_or_else(|| String::from("Empty --volume"))?;
                drive_letter = Some(ch.to_ascii_uppercase());
            }
            "--cursor" => {
                let v = iter
                    .next()
                    .ok_or_else(|| String::from("Expected USN after --cursor"))?;
                cursor = Some(
                    v.parse::<i64>()
                        .map_err(|_| format!("Invalid --cursor: {v}"))?,
                );
            }
            unknown => return Err(format!("Unknown journal-mode arg: {unknown}")),
        }
    }

    let drive_letter = drive_letter
        .ok_or_else(|| String::from("--volume <drive-letter> required in journal mode"))?;

    usn_journal::run_journal_mode(drive_letter, cursor)
}

#[cfg(windows)]
fn run_cursor_query(args: &[String]) -> Result<(), String> {
    let mut drive_letter: Option<char> = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--mode" => { let _ = iter.next(); }
            "--mode=query-cursor" => {}
            "--volume" => {
                let v = iter
                    .next()
                    .ok_or_else(|| String::from("Expected drive letter after --volume"))?;
                let trimmed = v.trim_end_matches(':').trim_end_matches('\\');
                let ch = trimmed
                    .chars()
                    .next()
                    .ok_or_else(|| String::from("Empty --volume"))?;
                drive_letter = Some(ch.to_ascii_uppercase());
            }
            unknown => return Err(format!("Unknown query-cursor arg: {unknown}")),
        }
    }
    let drive_letter = drive_letter
        .ok_or_else(|| String::from("--volume <drive-letter> required in query-cursor mode"))?;
    usn_journal::query_cursor(drive_letter)
}

fn register_signal_handler() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::{
            SetConsoleCtrlHandler, CTRL_C_EVENT, CTRL_CLOSE_EVENT, CTRL_BREAK_EVENT,
        };

        unsafe extern "system" fn handler(ctrl_type: u32) -> i32 {
            if ctrl_type == CTRL_C_EVENT
                || ctrl_type == CTRL_CLOSE_EVENT
                || ctrl_type == CTRL_BREAK_EVENT
            {
                CANCELLED.store(true, Ordering::SeqCst);
                return 1; // handled
            }
            0
        }

        unsafe { SetConsoleCtrlHandler(Some(handler), 1) };
    }

    #[cfg(not(windows))]
    {
        // Best-effort: catch SIGTERM and SIGINT via a simple flag.
        // Rust's standard library doesn't expose signal handlers directly,
        // so we use a background thread that blocks on the signal.
        // This is a lightweight alternative to adding the ctrlc crate.
        unsafe {
            libc::signal(libc::SIGTERM, sigterm_handler as libc::sighandler_t);
            libc::signal(libc::SIGINT, sigterm_handler as libc::sighandler_t);
        }
    }
}

#[cfg(not(windows))]
extern "C" fn sigterm_handler(_sig: libc::c_int) {
    CANCELLED.store(true, Ordering::SeqCst);
}

fn is_cancelled() -> bool {
    CANCELLED.load(Ordering::Relaxed)
}

fn run() -> Result<(), String> {
    let input = parse_args()?;
    let root_path = input.root_path.canonicalize().map_err(|error| {
        format!(
            "Failed to resolve root path {}: {error}",
            input.root_path.to_string_lossy()
        )
    })?;

    let index_writer = match &input.index_output {
        Some(path) => match IndexWriter::create(path) {
            Ok(writer) => Some(writer),
            Err(error) => {
                return Err(format!(
                    "Failed to create index output at {}: {error}",
                    path.to_string_lossy()
                ));
            }
        },
        None => None,
    };

    let root_path_string = normalize_path(&root_path);
    let scan_started_ms = unix_timestamp_ms(SystemTime::now());
    let scan_started_instant = Instant::now();

    // Emit an early "running" snapshot BEFORE baseline loading so the
    // renderer sees the scan is alive even when baseline parsing takes
    // a while on huge drives. Without this the UI sat on its pre-scan
    // "0 files, 0 bytes" placeholder for 20-40s during a rescan.
    let _ = emit_message(&Message::Progress {
        snapshot: early_running_snapshot(&root_path_string, scan_started_ms, 0),
    });

    // Load baseline if provided. Silent fallback to None on any failure
    // (missing file, corrupt gzip, malformed NDJSON) — the scanner just
    // does a full walk as before. We pass a heartbeat closure so each
    // ~100k-line chunk fires a snapshot carrying the current elapsed
    // time; keeps the UI alive during long baseline parses.
    let baseline = input.baseline_index.as_deref().and_then(|path| {
        if !path.exists() {
            return None;
        }
        let root_for_heartbeat = root_path_string.clone();
        Baseline::load_metadata(path, |_lines_read| {
            // Stderr line lands in the scanner's log buffer so we can
            // confirm the fast path in production without noise on stdout
            // (stdout is reserved for Progress/Done messages).
            eprintln!(
                "[diskhound-native-scanner] baseline load heartbeat: {} lines",
                _lines_read
            );
            let elapsed = scan_started_instant.elapsed().as_millis() as u64;
            let _ = emit_message(&Message::Progress {
                snapshot: early_running_snapshot(&root_for_heartbeat, scan_started_ms, elapsed),
            });
        })
    });

    let mut state = ScanState {
        input: ScanInput {
            root_path: root_path.clone(),
            top_file_limit: input.top_file_limit,
            top_directory_limit: input.top_directory_limit,
            index_output: input.index_output.clone(),
            baseline_index: input.baseline_index.clone(),
        },
        root_path_string: root_path_string.clone(),
        started_at_ms: scan_started_ms,
        started_at_instant: scan_started_instant,
        files_visited: 0,
        directories_visited: 0,
        skipped_entries: 0,
        bytes_seen: 0,
        largest_files: Vec::with_capacity(input.top_file_limit),
        hottest_directories: Vec::with_capacity(input.top_directory_limit),
        directory_totals: HashMap::new(),
        extension_totals: HashMap::new(),
        last_emit_elapsed_ms: 0,
        index_writer,
        baseline,
        inherited_prefixes: Vec::new(),
        inherited_dirs: 0,
        inherited_files: 0,
    };

    state.directory_totals.insert(
        root_path_string.clone(),
        DirectoryHotspot {
            path: root_path_string,
            size: 0,
            file_count: 0,
            depth: 0,
        },
    );

    scan_root(&root_path, &mut state)?;

    let final_status = if is_cancelled() {
        ScanStatus::Cancelled
    } else {
        ScanStatus::Done
    };

    let emit_result = emit_message(&Message::Done {
        snapshot: state.snapshot(final_status, None),
    })
    .map_err(|error| error.to_string());

    // Flush and close the index writer in both the success and cancelled
    // paths. Best-effort: if finalizing the gzip stream fails, drop it
    // silently rather than crashing the scan.
    if let Some(writer) = state.index_writer.take() {
        let _ = writer.finish();
    }

    emit_result
}

#[cfg(windows)]
fn scan_root(root_path: &Path, state: &mut ScanState) -> Result<(), String> {
    scan_windows(root_path, state)
}

#[cfg(not(windows))]
fn scan_root(root_path: &Path, state: &mut ScanState) -> Result<(), String> {
    scan_generic(root_path, state)
}

#[cfg(not(windows))]
fn scan_generic(root_path: &Path, state: &mut ScanState) -> Result<(), String> {
    let walker = WalkDir::new(root_path)
        .sort(false)
        .skip_hidden(false);

    for entry in walker {
        if is_cancelled() {
            return Ok(());
        }

        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                state.skipped_entries += 1;
                maybe_emit_progress(state)?;
                continue;
            }
        };

        if entry.read_children_error.is_some() {
            state.skipped_entries += 1;
        }

        if entry.file_type().is_dir() {
            state.directories_visited += 1;
            // Emit dir mtime entry so this scan is a valid baseline for the
            // next one. The Phase-1 inherit optimization isn't wired into
            // jwalk's iterator model here — the non-Windows scanner still
            // always walks — but we at least keep the output format
            // consistent so the JS worker (which does implement Phase 1)
            // can read it back.
            if let (Some(writer), Ok(meta)) = (state.index_writer.as_mut(), entry.metadata()) {
                if let Ok(modified) = meta.modified() {
                    let dir_path = normalize_path(entry.path().as_path());
                    let _ = writer.write_dir_entry(&dir_path, unix_timestamp_ms(modified));
                }
            }
            maybe_emit_progress(state)?;
            continue;
        }

        if !entry.file_type().is_file() {
            state.skipped_entries += 1;
            maybe_emit_progress(state)?;
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                state.skipped_entries += 1;
                maybe_emit_progress(state)?;
                continue;
            }
        };

        let file_path = entry.path();
        let parent_path = file_path
            .parent()
            .map(normalize_path)
            .unwrap_or_else(|| state.root_path_string.clone());
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let file_record = ScanFileRecord {
            path: normalize_path(&file_path),
            name: file_name.clone(),
            parent_path,
            extension: file_extension(&file_name),
            size: metadata.len(),
            modified_at: metadata_modified_at_ms(&metadata),
        };

        record_file(state, file_record)?;
    }

    Ok(())
}

#[cfg(windows)]
fn scan_windows(root_path: &Path, state: &mut ScanState) -> Result<(), String> {
    let mut stack = vec![root_path.to_path_buf()];

    while let Some(directory_path) = stack.pop() {
        if is_cancelled() {
            return Ok(());
        }
        state.directories_visited += 1;
        maybe_emit_progress(state)?;

        // Phase-1 mtime skip: before enumerating, check whether the directory's
        // mtime matches the baseline. If so, inherit the entire subtree from
        // the baseline's file records and don't walk further.
        let directory_path_str = normalize_path(&directory_path);
        let current_mtime = directory_mtime(&directory_path).unwrap_or(0);

        // Streaming-baseline inheritance path: if this dir's mtime matches
        // the baseline, we defer the actual file-record copying to a
        // post-walk streaming pass. During the walk we only:
        //   1. Record the prefix as "inherited" for later streaming.
        //   2. Emit dir entries for this dir + all its subtree dirs so
        //      the new index's directory structure is complete.
        //   3. Update counters that are cheap to get from per-dir
        //      aggregates (files_visited, bytes_seen, directory_totals).
        //
        // `largest_files` and `extension_totals` get filled in post-walk
        // during the actual file-record stream. Accept that snapshots
        // emitted during the walk are slightly incomplete for those —
        // they'll be corrected before the final `done` snapshot.
        let inheritance_plan = state.baseline.as_ref().and_then(|baseline| {
            let baseline_mtime = *baseline.dir_mtimes.get(&directory_path_str)?;
            if current_mtime.abs_diff(baseline_mtime) >= 2 {
                return None;
            }
            let inherited_file_count = baseline
                .dir_file_counts
                .get(&directory_path_str)
                .copied()
                .unwrap_or(0);
            let inherited_bytes = baseline
                .dir_total_sizes
                .get(&directory_path_str)
                .copied()
                .unwrap_or(0);
            let subtree_dir_entries: Vec<(String, u64)> = baseline
                .subtree_dirs(&directory_path_str)
                .into_iter()
                .filter_map(|sub| baseline.dir_mtimes.get(&sub).map(|m| (sub, *m)))
                .collect();
            Some((inherited_file_count, inherited_bytes, subtree_dir_entries))
        });

        if let Some((inherited_count, inherited_bytes, subtree_dir_entries)) = inheritance_plan {
            state.inherited_dirs += 1;
            state.inherited_files += inherited_count;
            state.files_visited += inherited_count;
            state.bytes_seen += inherited_bytes;
            // Credit the inherited subtree to directories_visited so the
            // "N dirs" status-bar stat reflects the full tree we scanned
            // (not just the handful of dirs we re-walked on a warm cache).
            // Without this, a fully-inherited scan of C:\ reported "1 dir"
            // despite covering millions of files under thousands of dirs.
            state.directories_visited += subtree_dir_entries.len() as u64;
            state.inherited_prefixes.push(directory_path_str.clone());

            // Roll up directory totals using the precomputed cumulative
            // size so the hottest-directories panel is accurate during
            // the walk, even though individual file records haven't
            // streamed in yet.
            rollup_directory_bytes(
                &state.root_path_string,
                &directory_path_str,
                inherited_bytes,
                inherited_count,
                &mut state.directory_totals,
                &mut state.hottest_directories,
                state.input.top_directory_limit,
            );

            // Re-emit dir entries from the subtree so the new index remains
            // a valid baseline for the next scan.
            if let Some(writer) = state.index_writer.as_mut() {
                let _ = writer.write_dir_entry(&directory_path_str, current_mtime);
                for (sub, m) in &subtree_dir_entries {
                    let _ = writer.write_dir_entry(sub, *m);
                }
            }
            maybe_emit_progress(state)?;
            continue;
        }

        // Emit dir entry for the re-walked directory so future scans can skip it.
        if let Some(writer) = state.index_writer.as_mut() {
            let _ = writer.write_dir_entry(&directory_path_str, current_mtime);
        }

        enumerate_windows_directory(&directory_path, state, &mut stack)?;
    }

    // Post-walk streaming pass: if any subtrees were inherited, stream the
    // baseline NDJSON one more time to copy file records + update top-N
    // and extension stats for those subtrees. This is where the memory
    // savings pay off — instead of holding every baseline file record in
    // memory throughout the walk, we touch each one exactly once right
    // here and release it.
    if !state.inherited_prefixes.is_empty() {
        let baseline_path = state.baseline.as_ref().map(|b| b.baseline_path.clone());
        let inherited_prefixes = state.inherited_prefixes.clone();
        if let Some(path) = baseline_path {
            let _ = stream_inherited_files_into(&path, &inherited_prefixes, state);
            maybe_emit_progress(state)?;
        }
    }

    // Emit a diagnostic so we can verify the fast path in production.
    if state.baseline.is_some() {
        eprintln!(
            "[diskhound-native-scanner] Phase-1 inheritance (streaming): {} dirs skipped, {} files inherited",
            state.inherited_dirs, state.inherited_files,
        );
    }

    Ok(())
}

/// Roll up already-summed file-count + byte-count onto a directory and
/// all its ancestors. Used by the Phase-1 inherit path where we're
/// crediting a whole subtree at once rather than one file at a time.
fn rollup_directory_bytes(
    root_path: &str,
    directory_path: &str,
    bytes: u64,
    file_count: u64,
    directory_totals: &mut HashMap<String, DirectoryHotspot>,
    hottest_directories: &mut Vec<DirectoryHotspot>,
    dir_limit: usize,
) {
    let mut current_path = directory_path.to_string();

    loop {
        let next_record = {
            let entry = directory_totals
                .entry(current_path.clone())
                .or_insert_with(|| DirectoryHotspot {
                    path: current_path.clone(),
                    size: 0,
                    file_count: 0,
                    depth: directory_depth(root_path, &current_path),
                });

            entry.size += bytes;
            entry.file_count += file_count;
            entry.clone()
        };

        upsert_ranked_directory(hottest_directories, next_record, dir_limit);

        if current_path == root_path {
            return;
        }

        let parent = Path::new(&current_path)
            .parent()
            .map(normalize_path)
            .unwrap_or_else(|| root_path.to_string());

        if parent == current_path {
            return;
        }

        current_path = parent;
    }
}

/// Return a directory's last-write time in Unix ms, or None on failure.
#[cfg(windows)]
fn directory_mtime(dir: &Path) -> Option<u64> {
    let metadata = std::fs::metadata(dir).ok()?;
    let modified = metadata.modified().ok()?;
    Some(unix_timestamp_ms(modified))
}

#[cfg(not(windows))]
fn directory_mtime(dir: &Path) -> Option<u64> {
    let metadata = std::fs::metadata(dir).ok()?;
    let modified = metadata.modified().ok()?;
    Some(unix_timestamp_ms(modified))
}

#[cfg(windows)]
fn enumerate_windows_directory(
    directory_path: &Path,
    state: &mut ScanState,
    stack: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let search_pattern = windows_search_pattern(directory_path);
    let wide_search_pattern = windows_wide_string(&search_pattern);
    let mut find_data = unsafe { std::mem::zeroed::<WIN32_FIND_DATAW>() };

    let handle = unsafe {
        FindFirstFileExW(
            wide_search_pattern.as_ptr(),
            FindExInfoBasic,
            &mut find_data as *mut WIN32_FIND_DATAW as *mut _,
            FindExSearchNameMatch,
            std::ptr::null(),
            FIND_FIRST_EX_LARGE_FETCH,
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        state.skipped_entries += 1;
        maybe_emit_progress(state)?;
        return Ok(());
    }

    loop {
        let file_name = win32_name_to_string(&find_data.cFileName);

        if file_name != "." && file_name != ".." {
          let attributes = find_data.dwFileAttributes;
          let is_directory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
          let is_reparse_point = (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
          let is_device = (attributes & FILE_ATTRIBUTE_DEVICE) != 0;

          if is_reparse_point || is_device {
              state.skipped_entries += 1;
          } else if is_directory {
              stack.push(directory_path.join(&file_name));
          } else {
              let file_size =
                  ((find_data.nFileSizeHigh as u64) << 32) | find_data.nFileSizeLow as u64;
              let file_record = ScanFileRecord {
                  path: normalize_path(&directory_path.join(&file_name)),
                  name: file_name.clone(),
                  parent_path: normalize_path(directory_path),
                  extension: file_extension(&file_name),
                  size: file_size,
                  modified_at: windows_filetime_to_unix_ms(
                      find_data.ftLastWriteTime.dwHighDateTime,
                      find_data.ftLastWriteTime.dwLowDateTime,
                  ),
              };
              record_file(state, file_record)?;
          }
        }

        let found_next = unsafe { FindNextFileW(handle, &mut find_data) };
        if found_next == 0 {
            let error_code = unsafe { GetLastError() };
            if error_code != ERROR_NO_MORE_FILES {
                state.skipped_entries += 1;
                maybe_emit_progress(state)?;
            }
            break;
        }
    }

    unsafe {
        FindClose(handle);
    }

    Ok(())
}

fn record_file(state: &mut ScanState, file_record: ScanFileRecord) -> Result<(), String> {
    state.files_visited += 1;
    state.bytes_seen += file_record.size;
    let file_limit = state.input.top_file_limit;
    let dir_limit = state.input.top_directory_limit;
    upsert_ranked_file(&mut state.largest_files, file_record.clone(), file_limit);
    rollup_directory_size(
        &state.root_path_string,
        &file_record.parent_path,
        file_record.size,
        &mut state.directory_totals,
        &mut state.hottest_directories,
        dir_limit,
    );
    rollup_extension(
        &mut state.extension_totals,
        &file_record.extension,
        file_record.size,
    );

    // Best-effort index write. If it fails partway through the scan
    // (e.g. disk full), drop the writer so we stop trying but let the
    // snapshot protocol keep working.
    if let Some(writer) = state.index_writer.as_mut() {
        if writer
            .write_entry(&file_record.path, file_record.size, file_record.modified_at)
            .is_err()
        {
            state.index_writer = None;
        }
    }

    maybe_emit_progress(state)
}

impl ScanState {
    fn snapshot(&self, status: ScanStatus, error_message: Option<String>) -> ScanSnapshot {
        let now_ms = unix_timestamp_ms(SystemTime::now());
        let elapsed_ms = self.started_at_instant.elapsed().as_millis() as u64;
        let mut top_extensions = self
            .extension_totals
            .values()
            .cloned()
            .collect::<Vec<_>>();
        top_extensions.sort_by(|left, right| right.size.cmp(&left.size));
        top_extensions.truncate(TOP_EXTENSION_LIMIT);

        ScanSnapshot {
            status,
            engine: ScanEngine::NativeSidecar,
            root_path: Some(self.root_path_string.clone()),
            scan_options: ScanOptions {},
            started_at: Some(self.started_at_ms),
            finished_at: matches!(status, ScanStatus::Done).then_some(now_ms),
            elapsed_ms,
            files_visited: self.files_visited,
            directories_visited: self.directories_visited,
            skipped_entries: self.skipped_entries,
            bytes_seen: self.bytes_seen,
            largest_files: self.largest_files.clone(),
            hottest_directories: self.hottest_directories.clone(),
            top_extensions,
            error_message,
            last_updated_at: now_ms,
        }
    }
}

/// Minimal Progress snapshot emitted before ScanState is built — during
/// the baseline-load phase of a rescan. All counters are zero; the UI
/// uses `status = Running` and `started_at` so it can show "Preparing…"
/// and start its live elapsed ticker instead of looking frozen.
fn early_running_snapshot(root_path: &str, started_at_ms: u64, elapsed_ms: u64) -> ScanSnapshot {
    let now_ms = unix_timestamp_ms(SystemTime::now());
    ScanSnapshot {
        status: ScanStatus::Running,
        engine: ScanEngine::NativeSidecar,
        root_path: Some(root_path.to_string()),
        scan_options: ScanOptions {},
        started_at: Some(started_at_ms),
        finished_at: None,
        elapsed_ms,
        files_visited: 0,
        directories_visited: 0,
        skipped_entries: 0,
        bytes_seen: 0,
        largest_files: Vec::new(),
        hottest_directories: Vec::new(),
        top_extensions: Vec::new(),
        error_message: None,
        last_updated_at: now_ms,
    }
}

fn maybe_emit_progress(state: &mut ScanState) -> Result<(), String> {
    let elapsed_ms = state.started_at_instant.elapsed().as_millis();
    if elapsed_ms.saturating_sub(state.last_emit_elapsed_ms) < SNAPSHOT_INTERVAL_MS {
        return Ok(());
    }

    state.last_emit_elapsed_ms = elapsed_ms;
    emit_message(&Message::Progress {
        snapshot: state.snapshot(ScanStatus::Running, None),
    })
    .map_err(|error| error.to_string())
}

fn emit_message(message: &Message) -> io::Result<()> {
    let stdout = io::stdout();
    let mut writer = BufWriter::new(stdout.lock());
    serde_json::to_writer(&mut writer, message)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn parse_args() -> Result<ScanInput, String> {
    let mut root_path: Option<PathBuf> = None;
    let mut top_file_limit: Option<usize> = None;
    let mut top_directory_limit: Option<usize> = None;
    let mut index_output: Option<PathBuf> = None;
    let mut baseline_index: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);

    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--root" => {
                let value = args
                    .next()
                    .ok_or_else(|| String::from("Expected a path after --root"))?;
                root_path = Some(PathBuf::from(value));
            }
            "--top-file-limit" => {
                let value = args
                    .next()
                    .ok_or_else(|| String::from("Expected a number after --top-file-limit"))?;
                top_file_limit = Some(
                    value.parse::<usize>().map_err(|_| format!("Invalid --top-file-limit: {value}"))?,
                );
            }
            "--top-directory-limit" => {
                let value = args
                    .next()
                    .ok_or_else(|| String::from("Expected a number after --top-directory-limit"))?;
                top_directory_limit = Some(
                    value.parse::<usize>().map_err(|_| format!("Invalid --top-directory-limit: {value}"))?,
                );
            }
            "--index-output" => {
                let value = args
                    .next()
                    .ok_or_else(|| String::from("Expected a path after --index-output"))?;
                index_output = Some(PathBuf::from(value));
            }
            "--baseline-index" => {
                let value = args
                    .next()
                    .ok_or_else(|| String::from("Expected a path after --baseline-index"))?;
                baseline_index = Some(PathBuf::from(value));
            }
            unknown => {
                return Err(format!("Unknown argument: {unknown}"));
            }
        }
    }

    let root_path = root_path.ok_or_else(|| String::from("Missing required --root argument"))?;
    if !root_path.exists() {
        return Err(format!("Root path does not exist: {}", root_path.to_string_lossy()));
    }

    Ok(ScanInput {
        root_path,
        top_file_limit: top_file_limit.unwrap_or(DEFAULT_TOP_FILE_LIMIT),
        top_directory_limit: top_directory_limit.unwrap_or(DEFAULT_TOP_DIRECTORY_LIMIT),
        index_output,
        baseline_index,
    })
}

fn file_extension(file_name: &str) -> String {
    Path::new(file_name)
        .extension()
        .and_then(OsStr::to_str)
        .map(|extension| format!(".{}", extension.to_ascii_lowercase()))
        .unwrap_or_else(|| String::from("(no ext)"))
}

#[cfg(not(windows))]
fn metadata_modified_at_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .map(unix_timestamp_ms)
        .unwrap_or(0)
}

fn unix_timestamp_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().into_owned();

    #[cfg(windows)]
    {
        if let Some(without_prefix) = normalized.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{}", without_prefix);
        }

        if let Some(without_prefix) = normalized.strip_prefix(r"\\?\") {
            return without_prefix.to_string();
        }
    }

    normalized
}

fn upsert_ranked_file(ranked: &mut Vec<ScanFileRecord>, next_record: ScanFileRecord, limit: usize) {
    if let Some(index) = ranked.iter().position(|candidate| candidate.path == next_record.path) {
        ranked.remove(index);
    } else if ranked.len() >= limit && next_record.size <= ranked.last().map(|r| r.size).unwrap_or(0) {
        return; // Too small to make the list
    }

    ranked.push(next_record);
    ranked.sort_by(|left, right| right.size.cmp(&left.size));
    ranked.truncate(limit);
}

fn upsert_ranked_directory(
    ranked: &mut Vec<DirectoryHotspot>,
    next_record: DirectoryHotspot,
    limit: usize,
) {
    if let Some(index) = ranked.iter().position(|candidate| candidate.path == next_record.path) {
        ranked[index] = next_record;
    } else if ranked.len() >= limit && next_record.size <= ranked.last().map(|r| r.size).unwrap_or(0) {
        return; // Too small to make the list
    } else {
        ranked.push(next_record);
    }

    ranked.sort_by(|left, right| right.size.cmp(&left.size));
    ranked.truncate(limit);
}

fn rollup_directory_size(
    root_path: &str,
    directory_path: &str,
    file_size: u64,
    directory_totals: &mut HashMap<String, DirectoryHotspot>,
    hottest_directories: &mut Vec<DirectoryHotspot>,
    dir_limit: usize,
) {
    let mut current_path = directory_path.to_string();

    loop {
        let next_record = {
            let entry = directory_totals
                .entry(current_path.clone())
                .or_insert_with(|| DirectoryHotspot {
                    path: current_path.clone(),
                    size: 0,
                    file_count: 0,
                    depth: directory_depth(root_path, &current_path),
                });

            entry.size += file_size;
            entry.file_count += 1;
            entry.clone()
        };

        upsert_ranked_directory(hottest_directories, next_record, dir_limit);

        if current_path == root_path {
            return;
        }

        let parent = Path::new(&current_path)
            .parent()
            .map(normalize_path)
            .unwrap_or_else(|| root_path.to_string());

        if parent == current_path {
            return;
        }

        current_path = parent;
    }
}

fn rollup_extension(
    extension_totals: &mut HashMap<String, ExtensionBucket>,
    extension: &str,
    file_size: u64,
) {
    let entry = extension_totals
        .entry(extension.to_string())
        .or_insert_with(|| ExtensionBucket {
            extension: extension.to_string(),
            size: 0,
            count: 0,
        });

    entry.size += file_size;
    entry.count += 1;
}

fn directory_depth(root_path: &str, directory_path: &str) -> usize {
    let root = Path::new(root_path);
    let directory = Path::new(directory_path);
    directory
        .strip_prefix(root)
        .ok()
        .map(|relative| relative.components().count())
        .unwrap_or(0)
}

#[cfg(windows)]
fn win32_name_to_string(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|value| *value == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

#[cfg(windows)]
fn windows_filetime_to_unix_ms(high: u32, low: u32) -> u64 {
    let ticks = ((high as u64) << 32) | (low as u64);
    ticks
        .saturating_sub(WINDOWS_TO_UNIX_EPOCH_TICKS)
        .saturating_div(10_000)
}

#[cfg(windows)]
fn windows_wide_string(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn windows_search_pattern(directory_path: &Path) -> String {
    let extended_path = windows_extended_path(directory_path);
    if extended_path.ends_with('\\') {
        format!("{extended_path}*")
    } else {
        format!("{extended_path}\\*")
    }
}

#[cfg(windows)]
fn windows_extended_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().into_owned();
    if normalized.starts_with(r"\\?\") {
        return normalized;
    }

    if let Some(without_unc) = normalized.strip_prefix(r"\\") {
        return format!(r"\\?\UNC\{}", without_unc);
    }

    format!(r"\\?\{}", normalized)
}
