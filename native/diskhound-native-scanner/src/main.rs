use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Global cancellation flag — set by signal handlers.
static CANCELLED: AtomicBool = AtomicBool::new(false);

#[cfg(not(windows))]
use jwalk::WalkDir;
use serde::Serialize;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW,
    FindNextFileW, FIND_FIRST_EX_LARGE_FETCH, FILE_ATTRIBUTE_DEVICE,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    WIN32_FIND_DATAW,
};

const DEFAULT_TOP_FILE_LIMIT: usize = 100;
const DEFAULT_TOP_DIRECTORY_LIMIT: usize = 500;
const TOP_EXTENSION_LIMIT: usize = 12;
const SNAPSHOT_INTERVAL_MS: u128 = 200;
const WINDOWS_TO_UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;

#[derive(Debug, Clone)]
struct ScanInput {
    root_path: PathBuf,
    top_file_limit: usize,
    top_directory_limit: usize,
}

/// Empty options struct — kept for IPC contract stability with the JS side.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanOptions {}

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
}

fn main() {
    // Register signal handler for graceful cancellation.
    // On Windows, Node sends SIGTERM which triggers CTRL_CLOSE_EVENT.
    // On Unix, SIGTERM and SIGINT are caught.
    register_signal_handler();

    if let Err(error) = run() {
        let _ = emit_message(&Message::Error {
            message: error.to_string(),
        });
        std::process::exit(1);
    }
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

    let root_path_string = normalize_path(&root_path);
    let mut state = ScanState {
        input: ScanInput {
            root_path: root_path.clone(),
            top_file_limit: input.top_file_limit,
            top_directory_limit: input.top_directory_limit,
        },
        root_path_string: root_path_string.clone(),
        started_at_ms: unix_timestamp_ms(SystemTime::now()),
        started_at_instant: Instant::now(),
        files_visited: 0,
        directories_visited: 0,
        skipped_entries: 0,
        bytes_seen: 0,
        largest_files: Vec::with_capacity(input.top_file_limit),
        hottest_directories: Vec::with_capacity(input.top_directory_limit),
        directory_totals: HashMap::new(),
        extension_totals: HashMap::new(),
        last_emit_elapsed_ms: 0,
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

    emit_message(&Message::Done {
        snapshot: state.snapshot(final_status, None),
    })
    .map_err(|error| error.to_string())
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

        enumerate_windows_directory(&directory_path, state, &mut stack)?;
    }

    Ok(())
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
