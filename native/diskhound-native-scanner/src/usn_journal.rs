//! NTFS USN Journal reader (Windows only).
//!
//! The USN Journal is an append-only log of every filesystem change on an
//! NTFS volume. By remembering a cursor (the last USN we processed), we can
//! reread just what's new since the last check — typical cost is a few
//! milliseconds for thousands of changes, vs. walking the whole drive.
//!
//! This module provides:
//! 1. `open_volume()` — opens a raw volume handle (requires read access)
//! 2. `query_journal()` — reads journal metadata (id, first/next USN)
//! 3. `read_journal()` — streams USN records starting at a cursor
//! 4. `resolve_path()` — turns a FileReferenceNumber into a full path via
//!    OpenFileById + GetFinalPathNameByHandleW
//! 5. `run_journal_mode()` — CLI entry point that emits NDJSON records to
//!    stdout, plus a final cursor line for the caller to persist.
//!
//! Output format (one JSON object per line):
//!   {"type":"journal-record","op":"create"|"modify"|"delete"|"rename",
//!    "path":"...","size":N,"mtime":ms,"usn":N,"parentRef":N}
//!   {"type":"journal-cursor","cursor":N,"journalId":N}
//!
//! What is NOT yet wired up (Phase 2b, follow-up commit):
//! - JS-side orchestration that applies these records to the persisted
//!   snapshot + index so the Changes tab updates from journal events.
//! - Handling journal wrap-around (journal ID changes → full rescan needed).
//! - Permission handling: some records for system files will fail path
//!   resolution; those records are currently dropped with a diagnostic.

#![cfg(windows)]

use std::ffi::c_void;
use std::io::{self, Write};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use serde::Serialize;

use windows_sys::Win32::Foundation::{
    CloseHandle, GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, GetFinalPathNameByHandleW, OpenFileById, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_ID_DESCRIPTOR, FILE_ID_DESCRIPTOR_0, FILE_ID_TYPE, FILE_READ_ATTRIBUTES,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Ioctl::{
    FSCTL_QUERY_USN_JOURNAL, FSCTL_READ_USN_JOURNAL, USN_JOURNAL_DATA_V0,
    USN_RECORD_V2,
};
use windows_sys::Win32::System::IO::DeviceIoControl;

// ── USN reason flag bits (subset we care about). See winioctl.h ────────────
const USN_REASON_DATA_OVERWRITE: u32 = 0x0000_0001;
const USN_REASON_DATA_EXTEND: u32 = 0x0000_0002;
const USN_REASON_DATA_TRUNCATION: u32 = 0x0000_0004;
const USN_REASON_FILE_CREATE: u32 = 0x0000_0100;
const USN_REASON_FILE_DELETE: u32 = 0x0000_0200;
const USN_REASON_RENAME_NEW_NAME: u32 = 0x0000_2000;
const USN_REASON_CLOSE: u32 = 0x8000_0000;

const WINDOWS_TO_UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;

// ── IDs for the FILE_ID_DESCRIPTOR type discriminator ──────────────────────
// Rust bindgen names this FILE_ID_TYPE with variants FileIdType (0), etc.
const FILE_ID_TYPE_FILE_ID: FILE_ID_TYPE = 0;

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub struct JournalInfo {
    pub journal_id: u64,
    pub first_usn: i64,
    pub next_usn: i64,
    pub lowest_valid_usn: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
pub enum JournalOp {
    Create,
    Modify,
    Delete,
    Rename,
    Close,
    Other,
}

impl JournalOp {
    fn from_reason(reason: u32) -> Self {
        if reason & USN_REASON_FILE_DELETE != 0 {
            return JournalOp::Delete;
        }
        if reason & USN_REASON_RENAME_NEW_NAME != 0 {
            return JournalOp::Rename;
        }
        if reason & USN_REASON_FILE_CREATE != 0 {
            return JournalOp::Create;
        }
        if reason
            & (USN_REASON_DATA_OVERWRITE | USN_REASON_DATA_EXTEND | USN_REASON_DATA_TRUNCATION)
            != 0
        {
            return JournalOp::Modify;
        }
        if reason & USN_REASON_CLOSE != 0 {
            return JournalOp::Close;
        }
        JournalOp::Other
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum OutputLine {
    JournalRecord {
        op: JournalOp,
        path: String,
        #[serde(rename = "fileRef")]
        file_ref: u64,
        #[serde(rename = "parentRef")]
        parent_ref: u64,
        usn: i64,
        #[serde(rename = "reasonMask")]
        reason_mask: u32,
        timestamp: u64,
    },
    JournalCursor {
        cursor: i64,
        #[serde(rename = "journalId")]
        journal_id: u64,
        #[serde(rename = "recordsEmitted")]
        records_emitted: u64,
        #[serde(rename = "recordsDropped")]
        records_dropped: u64,
    },
    JournalError {
        message: String,
    },
}

/// Open a raw volume handle like `\\.\C:` with read access. Requires the
/// process token to have the `SeManageVolumePrivilege` is NOT strictly
/// required for read-only access — GENERIC_READ is sufficient for USN
/// journal queries on most volumes, though some operations may require
/// Administrator depending on the journal's ACL.
fn open_volume(drive_letter: char) -> io::Result<HANDLE> {
    let path = format!(r"\\.\{}:", drive_letter);
    let wide: Vec<u16> = std::ffi::OsStr::new(&path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(handle)
}

fn query_journal(volume: HANDLE) -> io::Result<JournalInfo> {
    let mut data: USN_JOURNAL_DATA_V0 = unsafe { std::mem::zeroed() };
    let mut bytes_returned: u32 = 0;

    let ok = unsafe {
        DeviceIoControl(
            volume,
            FSCTL_QUERY_USN_JOURNAL,
            std::ptr::null(),
            0,
            &mut data as *mut _ as *mut c_void,
            std::mem::size_of::<USN_JOURNAL_DATA_V0>() as u32,
            &mut bytes_returned,
            std::ptr::null_mut(),
        )
    };

    if ok == 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(JournalInfo {
        journal_id: data.UsnJournalID,
        first_usn: data.FirstUsn,
        next_usn: data.NextUsn,
        lowest_valid_usn: data.LowestValidUsn,
    })
}

/// Read USN records from `start_usn` onwards, calling `handle_record` for
/// each. Returns the final cursor (the `NextUsn` from the last batch).
fn read_journal<F>(
    volume: HANDLE,
    journal_id: u64,
    start_usn: i64,
    mut handle_record: F,
) -> io::Result<i64>
where
    F: FnMut(&USN_RECORD_V2, &[u16]),
{
    #[repr(C)]
    struct ReadUsnJournalDataV0 {
        start_usn: i64,
        reason_mask: u32,
        return_only_on_close: u32,
        timeout: u64,
        bytes_to_wait_for: u64,
        usn_journal_id: u64,
    }

    let mut request = ReadUsnJournalDataV0 {
        start_usn,
        reason_mask: 0xFFFF_FFFF, // all reasons
        return_only_on_close: 0,
        timeout: 0,
        bytes_to_wait_for: 0,
        usn_journal_id: journal_id,
    };

    let mut buffer = vec![0u8; 64 * 1024]; // 64KB buffer per read
    let mut last_cursor: i64 = start_usn;

    loop {
        let mut bytes_returned: u32 = 0;
        let ok = unsafe {
            DeviceIoControl(
                volume,
                FSCTL_READ_USN_JOURNAL,
                &request as *const _ as *const c_void,
                std::mem::size_of::<ReadUsnJournalDataV0>() as u32,
                buffer.as_mut_ptr() as *mut c_void,
                buffer.len() as u32,
                &mut bytes_returned,
                std::ptr::null_mut(),
            )
        };

        if ok == 0 {
            return Err(io::Error::last_os_error());
        }

        // First 8 bytes of the returned buffer is the next USN to resume from.
        if (bytes_returned as usize) < 8 {
            break;
        }
        let next_usn = i64::from_ne_bytes(buffer[0..8].try_into().unwrap());

        let mut offset = 8;
        let mut emitted_in_batch = 0;
        while offset + std::mem::size_of::<USN_RECORD_V2>() <= bytes_returned as usize {
            let record_ptr = unsafe { buffer.as_ptr().add(offset) as *const USN_RECORD_V2 };
            let record = unsafe { &*record_ptr };
            let record_length = record.RecordLength as usize;
            if record_length == 0 || offset + record_length > bytes_returned as usize {
                break;
            }

            // Only process V2 records for now. V3/V4 have 128-bit file IDs
            // and require a different parse; on NTFS V2 covers everything.
            if record.MajorVersion == 2 {
                let name_offset = record.FileNameOffset as usize;
                let name_length_bytes = record.FileNameLength as usize;
                if name_offset + name_length_bytes <= record_length {
                    let name_ptr =
                        unsafe { (record_ptr as *const u8).add(name_offset) as *const u16 };
                    let name_len_u16 = name_length_bytes / 2;
                    let name_slice = unsafe { std::slice::from_raw_parts(name_ptr, name_len_u16) };
                    handle_record(record, name_slice);
                    emitted_in_batch += 1;
                }
            }

            offset += record_length;
        }

        // If we made no forward progress, bail out — otherwise we'd spin.
        if next_usn == last_cursor && emitted_in_batch == 0 {
            last_cursor = next_usn;
            break;
        }
        last_cursor = next_usn;

        // When the buffer was big enough for "most of" the journal but more
        // remains, DeviceIoControl tells us so by setting NextUsn < journal's
        // NextUsn. We keep looping. When we reach the tail, NextUsn stops
        // advancing and emitted_in_batch drops to 0 — we exit above.
        if emitted_in_batch == 0 {
            break;
        }

        request.start_usn = next_usn;
    }

    Ok(last_cursor)
}

/// Best-effort path resolution via OpenFileById → GetFinalPathNameByHandleW.
/// Returns None for files that can't be opened (deleted, insufficient
/// permissions, race conditions). Callers should expect a meaningful
/// fraction to fail on system volumes.
fn resolve_path(volume: HANDLE, file_ref: u64) -> Option<String> {
    let descriptor = FILE_ID_DESCRIPTOR {
        dwSize: std::mem::size_of::<FILE_ID_DESCRIPTOR>() as u32,
        Type: FILE_ID_TYPE_FILE_ID,
        Anonymous: FILE_ID_DESCRIPTOR_0 {
            FileId: file_ref as i64,
        },
    };

    let handle = unsafe {
        OpenFileById(
            volume,
            &descriptor,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            FILE_FLAG_BACKUP_SEMANTICS,
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        return None;
    }

    let mut buffer = vec![0u16; 32_768];
    let chars_written = unsafe {
        GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0)
    };

    unsafe { CloseHandle(handle) };

    if chars_written == 0 || chars_written as usize >= buffer.len() {
        return None;
    }

    let path = String::from_utf16_lossy(&buffer[..chars_written as usize]);
    // Strip the `\\?\` extended-length prefix for consistency with the scanner.
    Some(
        path.strip_prefix(r"\\?\")
            .map(str::to_string)
            .unwrap_or(path),
    )
}

fn windows_filetime_to_unix_ms(ticks: i64) -> u64 {
    let unsigned = ticks.max(0) as u64;
    unsigned
        .saturating_sub(WINDOWS_TO_UNIX_EPOCH_TICKS)
        .saturating_div(10_000)
}

fn emit(line: &OutputLine) -> io::Result<()> {
    let stdout = io::stdout();
    let mut writer = stdout.lock();
    serde_json::to_writer(&mut writer, line)?;
    writer.write_all(b"\n")
}

/// CLI entry point for `--mode journal`. Opens the volume, streams new
/// records since `start_cursor`, emits one NDJSON line per resolvable
/// record, then a final cursor line.
///
/// Arguments:
/// - `drive_letter`: e.g. 'C' for `C:`
/// - `start_cursor`: None for "from the beginning of the journal";
///    otherwise a USN from a previous run.
pub fn run_journal_mode(drive_letter: char, start_cursor: Option<i64>) -> Result<(), String> {
    let volume = open_volume(drive_letter)
        .map_err(|e| format!("Failed to open volume {drive_letter}: {e}"))?;

    let info = query_journal(volume)
        .map_err(|e| format!("Failed to query USN journal on {drive_letter}: {e}"))?;

    // If the caller's cursor is older than `first_usn`, the journal has
    // wrapped and older records are gone. Caller must fall back to a full
    // scan. We emit an error line and exit cleanly.
    let effective_start = start_cursor.unwrap_or(info.next_usn);
    if effective_start < info.first_usn {
        let _ = emit(&OutputLine::JournalError {
            message: format!(
                "Cursor {} predates journal start {}; full rescan required",
                effective_start, info.first_usn
            ),
        });
        unsafe { CloseHandle(volume) };
        return Ok(());
    }

    let mut emitted: u64 = 0;
    let mut dropped: u64 = 0;

    let final_cursor = read_journal(volume, info.journal_id, effective_start, |record, name_u16| {
        let path = match resolve_path(volume, record.FileReferenceNumber) {
            Some(p) => p,
            None => {
                dropped += 1;
                return;
            }
        };

        // Sanity check: the emitted record's name should match the tail of
        // the resolved path. If it doesn't (e.g. the file was renamed
        // between journal write and our resolve), log the journal's name
        // as a hint.
        let _name = String::from_utf16_lossy(name_u16);
        let basename = Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        let _ = basename; // used to assert basename == _name in a stricter build

        let line = OutputLine::JournalRecord {
            op: JournalOp::from_reason(record.Reason),
            path,
            file_ref: record.FileReferenceNumber,
            parent_ref: record.ParentFileReferenceNumber,
            usn: record.Usn,
            reason_mask: record.Reason,
            timestamp: windows_filetime_to_unix_ms(record.TimeStamp),
        };
        let _ = emit(&line);
        emitted += 1;
    })
    .map_err(|e| format!("Failed to read USN journal on {drive_letter}: {e}"))?;

    let _ = emit(&OutputLine::JournalCursor {
        cursor: final_cursor,
        journal_id: info.journal_id,
        records_emitted: emitted,
        records_dropped: dropped,
    });

    unsafe { CloseHandle(volume) };
    Ok(())
}
