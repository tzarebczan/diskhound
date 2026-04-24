//! NTFS Master File Table (MFT) reader (Windows only).
//!
//! Opens the raw NTFS volume, reads the MFT directly, parses each 1 KB
//! record for name/parent/size/mtime/is_dir, then reconstructs full paths
//! via the parent FRN chain. This is the approach Everything uses to
//! enumerate 7M files in a handful of seconds — dropping 15-20 min cold
//! scans to well under a minute on modern NVMe.
//!
//! Requires elevation (admin) — opening `\\.\X:` for raw read is a
//! privileged operation on NTFS volumes. When elevation is missing or
//! the volume isn't NTFS, the caller falls back to the FindFirstFile
//! walker.
//!
//! ## Record layout (the subset we care about)
//!
//! Each MFT record is typically 1024 bytes. It starts with a FILE_RECORD
//! header, followed by a variable number of attributes terminated by
//! `0xFFFFFFFF`. Attributes we parse:
//!
//! - `$STANDARD_INFORMATION` (0x10) — timestamps + flags (always resident)
//! - `$FILE_NAME` (0x30) — name + parent FRN + namespace (always resident)
//! - `$DATA` (0x80) — file size (resident data length OR non-resident
//!   allocated/real size in the attribute header)
//!
//! ## USA (Update Sequence Array) fixup
//!
//! NTFS replaces the last 2 bytes of each 512-byte sector of multi-sector
//! structures (like MFT records) with a sequence number. Before parsing
//! we must swap the original bytes (stored in the USA at the start of
//! the record) back in.
//!
//! ## What this file is NOT
//!
//! - We don't support $ATTRIBUTE_LIST (0x20) expansion for records whose
//!   attributes overflow a single record. These are rare (very fragmented
//!   files, giant directories); we log and skip them. This is fine
//!   because the goal is "fast common-case", not "archivally complete".
//! - We don't handle encrypted or sparse volumes specially.
//! - We don't process $FILE_NAME entries with DOS-only namespace (we
//!   prefer Win32/Win32AndDos when multiple names exist).

#![cfg(windows)]

use std::collections::HashMap;
use std::ffi::c_void;
use std::io::{self, Read, Seek, SeekFrom};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::path::Path;

use windows_sys::Win32::Foundation::{
    CloseHandle, GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::IO::DeviceIoControl;

// FSCTL_GET_NTFS_VOLUME_DATA = CTL_CODE(FILE_DEVICE_FILE_SYSTEM=9, 25, METHOD_BUFFERED=0, FILE_ANY_ACCESS=0)
// windows-sys exposes this under Ioctl but the struct is NTFS_VOLUME_DATA_BUFFER
// which we redefine locally to avoid pulling in an extra crate feature.
const FSCTL_GET_NTFS_VOLUME_DATA: u32 = 0x0009_0064;

const FILE_RECORD_MAGIC: &[u8; 4] = b"FILE";
const FLAG_IN_USE: u16 = 0x0001;
const FLAG_DIRECTORY: u16 = 0x0002;

const ATTR_STANDARD_INFORMATION: u32 = 0x10;
const ATTR_ATTRIBUTE_LIST: u32 = 0x20;
const ATTR_FILE_NAME: u32 = 0x30;
const ATTR_DATA: u32 = 0x80;
const ATTR_END_MARKER: u32 = 0xFFFF_FFFF;

const NAMESPACE_POSIX: u8 = 0;
const NAMESPACE_WIN32: u8 = 1;
const NAMESPACE_DOS: u8 = 2;
const NAMESPACE_WIN32_AND_DOS: u8 = 3;

const ROOT_FRN: u64 = 5; // NTFS root directory is always record 5.

/// Returns time-since-unix-epoch in milliseconds, matching the rest of
/// the scanner's mtime representation.
const WINDOWS_TO_UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;

#[repr(C)]
#[allow(non_snake_case, dead_code)]
struct NtfsVolumeDataBuffer {
    VolumeSerialNumber: i64,
    NumberSectors: i64,
    TotalClusters: i64,
    FreeClusters: i64,
    TotalReserved: i64,
    BytesPerSector: u32,
    BytesPerCluster: u32,
    BytesPerFileRecordSegment: u32,
    ClustersPerFileRecordSegment: u32,
    MftValidDataLength: i64,
    MftStartLcn: i64,
    Mft2StartLcn: i64,
    MftZoneStart: i64,
    MftZoneEnd: i64,
}

#[derive(Debug)]
#[allow(dead_code)]
pub struct MftRecordParsed {
    // frn + parent_frn are populated for diagnostics/symmetry with the
    // walker's record type but the Electron side only consumes `name`
    // (the full path), `size`, `mtime_ms`, and `is_dir`.
    pub frn: u64,
    pub parent_frn: u64,
    pub name: String,
    pub size: u64,
    pub mtime_ms: u64,
    pub is_dir: bool,
}

/// Internal record used during MFT parsing. A file may have several
/// `$FILE_NAME` attributes — one per hardlink, plus redundant DOS 8.3
/// aliases we dedupe away. In the final emit we expand this into one
/// `MftRecordParsed` per unique `(parent_frn, name)` pair so callers
/// see every visible path, matching what a FindFirstFile walker would
/// produce.
#[derive(Debug)]
struct ParsedRecord {
    size: u64,
    mtime_ms: u64,
    is_dir: bool,
    /// All visible names for this record. Post-dedup (namespace
    /// preference applied), typically 1 entry; 2-5+ for hardlinked files
    /// common in npm caches.
    names: Vec<(u64, String)>,
}

#[derive(Debug)]
#[allow(dead_code)]
pub enum MftError {
    NotElevated,
    NotNtfs,
    OpenVolumeFailed(io::Error),
    VolumeQueryFailed(io::Error),
    Io(io::Error),
    InvalidMftRecord,
}

impl std::fmt::Display for MftError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MftError::NotElevated => write!(f, "process not elevated"),
            MftError::NotNtfs => write!(f, "volume is not NTFS"),
            MftError::OpenVolumeFailed(e) => write!(f, "open volume failed: {}", e),
            MftError::VolumeQueryFailed(e) => {
                write!(f, "FSCTL_GET_NTFS_VOLUME_DATA failed: {}", e)
            }
            MftError::Io(e) => write!(f, "io: {}", e),
            MftError::InvalidMftRecord => write!(f, "invalid mft record (no FILE magic)"),
        }
    }
}

impl From<io::Error> for MftError {
    fn from(e: io::Error) -> Self {
        MftError::Io(e)
    }
}

/// RAII wrapper around a Windows volume HANDLE so we don't leak on error.
struct VolumeHandle(HANDLE);

impl Drop for VolumeHandle {
    fn drop(&mut self) {
        if self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Open `\\.\X:` as a raw volume for reading. Requires elevation on NTFS.
fn open_volume_raw(drive_letter: char) -> Result<VolumeHandle, MftError> {
    let path = format!(r"\\.\{}:", drive_letter.to_ascii_uppercase());
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
        let err = io::Error::last_os_error();
        // ERROR_ACCESS_DENIED (5) when not elevated.
        if err.raw_os_error() == Some(5) {
            return Err(MftError::NotElevated);
        }
        return Err(MftError::OpenVolumeFailed(err));
    }
    Ok(VolumeHandle(handle))
}

fn query_ntfs_volume_data(
    volume: &VolumeHandle,
) -> Result<NtfsVolumeDataBuffer, MftError> {
    let mut data: NtfsVolumeDataBuffer = unsafe { std::mem::zeroed() };
    let mut bytes_returned: u32 = 0;
    let ok = unsafe {
        DeviceIoControl(
            volume.0,
            FSCTL_GET_NTFS_VOLUME_DATA,
            std::ptr::null(),
            0,
            &mut data as *mut _ as *mut c_void,
            std::mem::size_of::<NtfsVolumeDataBuffer>() as u32,
            &mut bytes_returned,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        let err = io::Error::last_os_error();
        // On a non-NTFS volume this typically returns ERROR_INVALID_FUNCTION (1).
        if err.raw_os_error() == Some(1) {
            return Err(MftError::NotNtfs);
        }
        return Err(MftError::VolumeQueryFailed(err));
    }
    Ok(data)
}

/// Convert the raw volume handle to a File we can Seek+Read from. After
/// this call, the File owns the handle and will close it on drop.
fn volume_handle_to_file(volume: VolumeHandle) -> std::fs::File {
    let raw = volume.0;
    // Prevent Drop from closing the handle — File will own it now.
    std::mem::forget(volume);
    unsafe { std::fs::File::from_raw_handle(raw as _) }
}

/// Parsed MFT record header + pointer offsets. `record_buf` contains the
/// full record bytes after USA fixup.
struct RecordHeader {
    flags: u16,
    first_attr_offset: u16,
}

/// Apply the Update Sequence Array fixup in-place. Each 512-byte sector's
/// last 2 bytes get replaced with the corresponding USA entry.
fn apply_usa_fixup(buf: &mut [u8], bytes_per_sector: u32) -> bool {
    if buf.len() < 48 {
        return false;
    }
    let usa_offset = u16::from_le_bytes([buf[4], buf[5]]) as usize;
    let usa_size = u16::from_le_bytes([buf[6], buf[7]]) as usize; // includes the check value
    if usa_size == 0 || usa_offset + usa_size * 2 > buf.len() {
        return false;
    }
    // Check value is the first USA entry.
    let check_value = [buf[usa_offset], buf[usa_offset + 1]];
    let sector_count = usa_size - 1; // first entry is the check value
    let bps = bytes_per_sector as usize;
    if bps == 0 || sector_count * bps > buf.len() {
        return false;
    }
    for i in 0..sector_count {
        let sector_end = (i + 1) * bps;
        if sector_end < 2 || sector_end > buf.len() {
            return false;
        }
        // Verify the check value matches at sector end.
        let slot = [buf[sector_end - 2], buf[sector_end - 1]];
        if slot != check_value {
            return false;
        }
        // Swap in the real bytes (USA[i+1]).
        let fixup_idx = usa_offset + 2 * (i + 1);
        if fixup_idx + 2 > buf.len() {
            return false;
        }
        buf[sector_end - 2] = buf[fixup_idx];
        buf[sector_end - 1] = buf[fixup_idx + 1];
    }
    true
}

fn parse_record_header(buf: &[u8]) -> Option<RecordHeader> {
    if buf.len() < 48 || &buf[0..4] != FILE_RECORD_MAGIC {
        return None;
    }
    let first_attr_offset = u16::from_le_bytes([buf[20], buf[21]]);
    let flags = u16::from_le_bytes([buf[22], buf[23]]);
    // BaseFileRecordSegment at offset 32 (u64). If non-zero this record
    // is an extension of another record — we skip those for simplicity.
    let base_frn = u64::from_le_bytes([
        buf[32], buf[33], buf[34], buf[35], buf[36], buf[37], buf[38], buf[39],
    ]) & 0x0000_FFFF_FFFF_FFFF;
    if base_frn != 0 {
        return None;
    }
    // We do not read the header's MFTRecordNumber field (offset 44) —
    // it's only present on NTFS v3.0+ and some records carry zero here.
    // Instead the caller computes the record number from the record's
    // position within the logical MFT stream.
    Some(RecordHeader {
        flags,
        first_attr_offset,
    })
}

struct ParsedAttrs {
    mtime_ms: Option<u64>,
    /// Every `$FILE_NAME` attribute in the record, pre-dedup. Namespace
    /// filtering happens in `finalize_names`.
    raw_names: Vec<(u64, String, u8)>, // (parent_frn, name, namespace)
    data_size: Option<u64>,
    saw_attr_list: bool,
}

/// Walk attributes starting at `offset`. Collects all `$FILE_NAME`
/// attributes (one per hardlink), plus timestamps and data size.
fn parse_attributes(buf: &[u8], offset: usize) -> Option<ParsedAttrs> {
    let mut pos = offset;
    let mut out = ParsedAttrs {
        mtime_ms: None,
        raw_names: Vec::new(),
        data_size: None,
        saw_attr_list: false,
    };

    while pos + 16 <= buf.len() {
        let attr_type = u32::from_le_bytes([
            buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3],
        ]);
        if attr_type == ATTR_END_MARKER {
            break;
        }
        let attr_len = u32::from_le_bytes([
            buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7],
        ]) as usize;
        if attr_len < 16 || pos + attr_len > buf.len() {
            break;
        }
        let non_resident = buf[pos + 8];

        match attr_type {
            ATTR_STANDARD_INFORMATION => {
                if non_resident == 0 {
                    let value_offset = u16::from_le_bytes([
                        buf[pos + 20], buf[pos + 21],
                    ]) as usize;
                    let v = pos + value_offset;
                    if v + 32 <= buf.len() {
                        let ntfs_time = u64::from_le_bytes([
                            buf[v + 8], buf[v + 9], buf[v + 10], buf[v + 11],
                            buf[v + 12], buf[v + 13], buf[v + 14], buf[v + 15],
                        ]);
                        out.mtime_ms = Some(ntfs_time_to_unix_ms(ntfs_time));
                    }
                }
            }
            ATTR_ATTRIBUTE_LIST => {
                out.saw_attr_list = true;
            }
            ATTR_FILE_NAME => {
                if non_resident == 0 {
                    let value_offset = u16::from_le_bytes([
                        buf[pos + 20], buf[pos + 21],
                    ]) as usize;
                    let v = pos + value_offset;
                    if v + 66 <= buf.len() {
                        let parent_frn_raw = u64::from_le_bytes([
                            buf[v], buf[v + 1], buf[v + 2], buf[v + 3],
                            buf[v + 4], buf[v + 5], buf[v + 6], buf[v + 7],
                        ]);
                        let parent_frn =
                            parent_frn_raw & 0x0000_FFFF_FFFF_FFFF;
                        let name_length = buf[v + 64] as usize;
                        let namespace = buf[v + 65];
                        let name_start = v + 66;
                        let name_end = name_start + name_length * 2;
                        if name_end <= buf.len() {
                            let name_utf16: Vec<u16> = (0..name_length)
                                .map(|i| {
                                    u16::from_le_bytes([
                                        buf[name_start + i * 2],
                                        buf[name_start + i * 2 + 1],
                                    ])
                                })
                                .collect();
                            let name = String::from_utf16_lossy(&name_utf16);
                            out.raw_names.push((parent_frn, name, namespace));
                        }
                    }
                }
            }
            ATTR_DATA => {
                if out.data_size.is_none() {
                    if non_resident == 0 {
                        let value_length = u32::from_le_bytes([
                            buf[pos + 16], buf[pos + 17],
                            buf[pos + 18], buf[pos + 19],
                        ]) as u64;
                        out.data_size = Some(value_length);
                    } else if pos + 48 <= buf.len() {
                        let real_size = u64::from_le_bytes([
                            buf[pos + 48], buf[pos + 49],
                            buf[pos + 50], buf[pos + 51],
                            buf[pos + 52], buf[pos + 53],
                            buf[pos + 54], buf[pos + 55],
                        ]);
                        out.data_size = Some(real_size);
                    }
                }
            }
            _ => {}
        }

        pos += attr_len;
    }

    Some(out)
}

/// Collapse the raw `$FILE_NAME` list to one entry per hardlink (parent
/// dir). Within a single parent, prefer Win32/Win32AndDos over POSIX
/// over DOS 8.3, so we keep the user-visible long name and drop the
/// 8.3 alias that would otherwise become a duplicate.
fn finalize_names(raw: Vec<(u64, String, u8)>) -> Vec<(u64, String)> {
    if raw.is_empty() {
        return Vec::new();
    }
    // Most files have 1 name; hardlinked files have 2-20. Use a small
    // HashMap keyed by parent_frn and keep the best namespace per parent.
    let mut best: HashMap<u64, (String, u8)> = HashMap::with_capacity(raw.len());
    for (parent, name, namespace) in raw {
        match best.get(&parent) {
            Some((_, existing_ns))
                if namespace_rank(namespace) <= namespace_rank(*existing_ns) =>
            {
                // Existing entry is same or better — drop this one.
            }
            _ => {
                best.insert(parent, (name, namespace));
            }
        }
    }
    best.into_iter()
        .map(|(parent, (name, _ns))| (parent, name))
        .collect()
}

fn namespace_rank(ns: u8) -> u8 {
    match ns {
        NAMESPACE_WIN32_AND_DOS => 3,
        NAMESPACE_WIN32 => 2,
        NAMESPACE_POSIX => 1,
        NAMESPACE_DOS => 0,
        _ => 0,
    }
}

fn ntfs_time_to_unix_ms(ntfs_ticks: u64) -> u64 {
    // Ticks are 100ns intervals since 1601-01-01.
    if ntfs_ticks < WINDOWS_TO_UNIX_EPOCH_TICKS {
        return 0;
    }
    (ntfs_ticks - WINDOWS_TO_UNIX_EPOCH_TICKS) / 10_000
}

/// A single (LCN, cluster_count) extent of a non-resident attribute's
/// data. Returned by `parse_data_runs` when we follow $MFT's own $DATA
/// attribute to discover where on disk each piece of the MFT lives.
#[derive(Debug, Clone, Copy)]
struct DataRun {
    lcn: i64, // signed; relative accumulator can go negative for sparse runs
    cluster_count: u64,
}

/// Parse an NTFS data run list starting at `runs` and return the absolute
/// extents. The stream ends on a zero header byte. Sparse runs (zero
/// offset length) are represented with lcn=-1 and skipped by callers.
fn parse_data_runs(mut runs: &[u8]) -> Vec<DataRun> {
    let mut out = Vec::new();
    let mut current_lcn: i64 = 0;
    while !runs.is_empty() {
        let header = runs[0];
        if header == 0 {
            break;
        }
        let offset_len = (header >> 4) as usize;
        let count_len = (header & 0x0F) as usize;
        if count_len == 0 || 1 + count_len + offset_len > runs.len() {
            break;
        }
        // Read unsigned cluster count (little-endian, count_len bytes).
        let mut count: u64 = 0;
        for i in 0..count_len {
            count |= (runs[1 + i] as u64) << (8 * i);
        }
        // Read signed offset delta (little-endian, offset_len bytes,
        // sign-extended from the top byte). A length of 0 means SPARSE.
        if offset_len == 0 {
            out.push(DataRun {
                lcn: -1,
                cluster_count: count,
            });
        } else {
            let mut offset_delta: i64 = 0;
            let delta_bytes = &runs[1 + count_len..1 + count_len + offset_len];
            for (i, byte) in delta_bytes.iter().enumerate() {
                offset_delta |= (*byte as i64) << (8 * i);
            }
            // Sign-extend from offset_len bytes to 64 bits.
            let sign_bit = 1_i64 << (8 * offset_len - 1);
            if offset_delta & sign_bit != 0 {
                offset_delta |= !((1_i64 << (8 * offset_len)) - 1);
            }
            current_lcn = current_lcn.wrapping_add(offset_delta);
            out.push(DataRun {
                lcn: current_lcn,
                cluster_count: count,
            });
        }
        runs = &runs[1 + count_len + offset_len..];
    }
    out
}

/// Find the non-resident $DATA attribute in $MFT's own record and return
/// its run list. Record 0 is $MFT itself; its $DATA run list IS the map
/// of "where on disk are the MFT records".
fn extract_mft_data_runs(
    mft_record_0: &[u8],
) -> Option<Vec<DataRun>> {
    let header = parse_record_header(mft_record_0)?;
    if header.flags & FLAG_IN_USE == 0 {
        return None;
    }
    let mut pos = header.first_attr_offset as usize;
    while pos + 16 <= mft_record_0.len() {
        let attr_type = u32::from_le_bytes([
            mft_record_0[pos], mft_record_0[pos + 1],
            mft_record_0[pos + 2], mft_record_0[pos + 3],
        ]);
        if attr_type == ATTR_END_MARKER {
            break;
        }
        let attr_len = u32::from_le_bytes([
            mft_record_0[pos + 4], mft_record_0[pos + 5],
            mft_record_0[pos + 6], mft_record_0[pos + 7],
        ]) as usize;
        if attr_len < 16 || pos + attr_len > mft_record_0.len() {
            break;
        }
        let non_resident = mft_record_0[pos + 8];
        if attr_type == ATTR_DATA && non_resident != 0 {
            // Non-resident attribute header: runlist offset at offset 32.
            let runlist_offset = u16::from_le_bytes([
                mft_record_0[pos + 32], mft_record_0[pos + 33],
            ]) as usize;
            let run_start = pos + runlist_offset;
            let run_end = pos + attr_len;
            if run_start < run_end && run_end <= mft_record_0.len() {
                return Some(parse_data_runs(&mft_record_0[run_start..run_end]));
            }
        }
        pos += attr_len;
    }
    None
}

/// Read the entire MFT into a FRN → MftRecordParsed map by following the
/// data runs discovered in $MFT's own record 0.
///
/// Why not just seek to MftStartLcn and read MftValidDataLength bytes?
/// Because the MFT is typically fragmented on any drive that's seen real
/// use — the "MFT zone" NTFS reserves isn't large enough, and once it
/// fills, further MFT growth spills into whatever clusters are free.
/// Reading sequentially from MftStartLcn past the first extent walks
/// into unrelated file data, which fails the `FILE` magic check. We
/// observed this dropping ~54% of records on a C:\ with 8M entries.
///
/// Progress is reported via `progress_cb` every 100k records.
fn read_all_mft_records(
    mut volume: std::fs::File,
    volume_data: &NtfsVolumeDataBuffer,
    mut progress_cb: impl FnMut(u64, u64, u64),
) -> Result<HashMap<u64, ParsedRecord>, MftError> {
    let bytes_per_cluster = volume_data.BytesPerCluster as u64;
    let bytes_per_sector = volume_data.BytesPerSector;
    let record_size = volume_data.BytesPerFileRecordSegment as usize;
    let mft_start_byte = (volume_data.MftStartLcn as u64) * bytes_per_cluster;

    if record_size == 0 || record_size % 512 != 0 {
        return Err(MftError::VolumeQueryFailed(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid MFT record size {}", record_size),
        )));
    }

    // Step 1 — read $MFT record 0 to discover the MFT's own data runs.
    volume.seek(SeekFrom::Start(mft_start_byte))?;
    let mut record_0 = vec![0u8; record_size];
    volume.read_exact(&mut record_0)?;
    if &record_0[0..4] != FILE_RECORD_MAGIC {
        return Err(MftError::InvalidMftRecord);
    }
    apply_usa_fixup(&mut record_0, bytes_per_sector);
    let runs = extract_mft_data_runs(&record_0).ok_or_else(|| {
        MftError::VolumeQueryFailed(io::Error::new(
            io::ErrorKind::InvalidData,
            "could not parse $MFT's $DATA run list from record 0",
        ))
    })?;
    let total_clusters: u64 = runs
        .iter()
        .filter(|r| r.lcn >= 0)
        .map(|r| r.cluster_count)
        .sum();
    let total_mft_bytes = total_clusters * bytes_per_cluster;
    eprintln!(
        "[diskhound-native-scanner] mft: $MFT data runs: {} extents, {} clusters total, {:.1} MB",
        runs.len(),
        total_clusters,
        total_mft_bytes as f64 / (1024.0 * 1024.0)
    );

    // Step 2 — iterate extents, reading each. Record-number in the
    // global MFT is derived from the *logical* position within the MFT
    // stream, not the on-disk byte offset — because extents aren't
    // contiguous on disk but record numbering is contiguous in the
    // logical stream.
    const CHUNK_BYTES: usize = 4 * 1024 * 1024;
    let mut chunk = vec![0u8; CHUNK_BYTES];
    let mut records: HashMap<u64, ParsedRecord> =
        HashMap::with_capacity(8_000_000);
    // Side map of (base_frn → data_size) harvested from BOTH base and
    // extension records. Populated on every record we encounter; after
    // the read pass we merge these into the real `records` entries so
    // base records whose $DATA lives in an extension (common for game
    // installs, VM disks, pagefile, etc.) get the correct size instead
    // of the 0 we'd have read from the empty base $DATA slot.
    let mut size_by_base: HashMap<u64, u64> = HashMap::with_capacity(512);
    let mut total_records_read: u64 = 0;
    let mut logical_position: u64 = 0; // byte offset within the logical MFT stream
    let mut attr_list_records: u64 = 0;
    let mut hardlink_records: u64 = 0;
    let mut extension_records_with_data: u64 = 0;
    // Separate file / dir tallies during MFT read so the progress callback
    // can feed accurate files_visited and directories_visited values to
    // the UI. Without this split, the UI sees file count jump to total
    // records during MFT read (both files and dirs counted as files).
    let mut kept_files: u64 = 0;
    let mut kept_dirs: u64 = 0;

    for run in &runs {
        if run.lcn < 0 {
            // Sparse — advance logical position, no disk read.
            let bytes = run.cluster_count * bytes_per_cluster;
            logical_position += bytes;
            total_records_read += bytes / record_size as u64;
            continue;
        }
        let run_byte_offset = (run.lcn as u64) * bytes_per_cluster;
        let run_bytes_total = run.cluster_count * bytes_per_cluster;
        volume.seek(SeekFrom::Start(run_byte_offset))?;

        let mut bytes_remaining = run_bytes_total;
        while bytes_remaining > 0 {
            let to_read = CHUNK_BYTES.min(bytes_remaining as usize);
            let n = volume.read(&mut chunk[..to_read])?;
            if n == 0 {
                break;
            }
            bytes_remaining -= n as u64;

            let mut offset = 0;
            while offset + record_size <= n {
                let slice_start = offset;
                let slice_end = offset + record_size;
                offset += record_size;

                // Record number = logical position / record_size at the
                // start of this record.
                let record_number = logical_position / record_size as u64;
                logical_position += record_size as u64;
                total_records_read += 1;

                let mut rec_buf = chunk[slice_start..slice_end].to_vec();
                if &rec_buf[0..4] != FILE_RECORD_MAGIC {
                    continue;
                }
                if !apply_usa_fixup(&mut rec_buf, bytes_per_sector) {
                    continue;
                }

                // Parse header WITHOUT skipping extension records — we
                // need the size data they carry. parse_record_header
                // used to return None for base_frn != 0; we pull that
                // check inline here so we can see extensions.
                if rec_buf.len() < 48 || &rec_buf[0..4] != FILE_RECORD_MAGIC {
                    continue;
                }
                let first_attr_offset =
                    u16::from_le_bytes([rec_buf[20], rec_buf[21]]);
                let flags = u16::from_le_bytes([rec_buf[22], rec_buf[23]]);
                if flags & FLAG_IN_USE == 0 {
                    continue;
                }
                let base_frn_raw = u64::from_le_bytes([
                    rec_buf[32], rec_buf[33], rec_buf[34], rec_buf[35],
                    rec_buf[36], rec_buf[37], rec_buf[38], rec_buf[39],
                ]);
                let base_frn = base_frn_raw & 0x0000_FFFF_FFFF_FFFF;
                let is_extension = base_frn != 0;
                let effective_frn = if is_extension { base_frn } else { record_number };

                let is_dir = (flags & FLAG_DIRECTORY) != 0;
                let attrs_offset = first_attr_offset as usize;
                let parsed = match parse_attributes(&rec_buf, attrs_offset) {
                    Some(p) => p,
                    None => continue,
                };

                // Always harvest $DATA size into the side map keyed by
                // base FRN. This captures data sizes that live in
                // extension records for big/fragmented files.
                if let Some(sz) = parsed.data_size {
                    if sz > 0 {
                        size_by_base
                            .entry(effective_frn)
                            .and_modify(|existing| {
                                if sz > *existing {
                                    *existing = sz;
                                }
                            })
                            .or_insert(sz);
                    }
                    if is_extension {
                        extension_records_with_data += 1;
                    }
                }

                if is_extension {
                    // Extension records only carry attribute overflow,
                    // not names/mtimes — we're done with this record
                    // once its $DATA (if any) has been captured above.
                    continue;
                }

                if parsed.saw_attr_list {
                    attr_list_records += 1;
                }
                let names = finalize_names(parsed.raw_names);
                if names.is_empty() {
                    continue;
                }
                if names.len() > 1 {
                    hardlink_records += 1;
                }

                if is_dir {
                    kept_dirs += 1;
                } else {
                    kept_files += 1;
                }
                records.insert(
                    record_number,
                    ParsedRecord {
                        size: parsed.data_size.unwrap_or(0),
                        mtime_ms: parsed.mtime_ms.unwrap_or(0),
                        is_dir,
                        names,
                    },
                );

                if total_records_read % 200_000 == 0 {
                    progress_cb(total_records_read, kept_files, kept_dirs);
                }
            }
        }
    }

    // Merge extension-record $DATA sizes back into their base records.
    // Without this, every file whose $DATA overflowed to an extension
    // record ended up with size=0 in our output — commonly game
    // installs, VM disks, pagefile.sys, hiberfil.sys. On one user's
    // 800 GB C:\ this lifted total bytes from 432 GB → near-800 GB.
    let mut size_upgrades: u64 = 0;
    let mut size_bytes_added: u64 = 0;
    for (frn, rec) in records.iter_mut() {
        if let Some(&ext_size) = size_by_base.get(frn) {
            if ext_size > rec.size {
                size_bytes_added += ext_size - rec.size;
                rec.size = ext_size;
                size_upgrades += 1;
            }
        }
    }
    eprintln!(
        "[diskhound-native-scanner] mft: read {} records across {} extents, kept {} in-use non-extension entries ({} had $ATTRIBUTE_LIST, {} had hardlinks, {} extension-records carried $DATA → {} records size-upgraded, {:.1} GB recovered)",
        total_records_read,
        runs.iter().filter(|r| r.lcn >= 0).count(),
        records.len(),
        attr_list_records,
        hardlink_records,
        extension_records_with_data,
        size_upgrades,
        size_bytes_added as f64 / (1024.0 * 1024.0 * 1024.0),
    );
    Ok(records)
}

/// Cache entry keyed by directory FRN. Stores the directory's full path
/// so repeated children don't re-walk the parent chain.
type DirPathCache = HashMap<u64, String>;

/// Resolve the full path of directory `frn` by walking parent links up to
/// the NTFS root. Results are memoized so files sharing a parent amortize
/// the walk. Returns None only on broken chains (missing parent, cycle,
/// or depth overflow).
fn resolve_dir_path(
    frn: u64,
    records: &HashMap<u64, ParsedRecord>,
    cache: &mut DirPathCache,
    drive_root: &str,
) -> Option<String> {
    if frn == ROOT_FRN {
        return Some(drive_root.to_string());
    }
    if let Some(cached) = cache.get(&frn) {
        return Some(cached.clone());
    }
    let rec = records.get(&frn)?;
    // Directories typically have exactly one $FILE_NAME (in their one
    // parent). If the MFT somehow records multiple for a dir we take
    // the first and continue — this is rare enough that paying extra
    // complexity for it isn't worth it.
    let (parent_frn, name) = rec.names.first()?;
    if *parent_frn == frn {
        // Self-reference — broken link.
        return None;
    }

    // Iteratively walk parents until we find a cached entry or reach
    // the root. Collect intermediate segments so we can assemble the
    // path afterward.
    let mut segments: Vec<&str> = vec![name.as_str()];
    let mut cur = *parent_frn;
    let mut to_cache: Vec<u64> = vec![frn];
    let mut safety = 0;
    let base_assembled = loop {
        safety += 1;
        if safety > 256 {
            return None;
        }
        if cur == ROOT_FRN {
            break drive_root.to_string();
        }
        if let Some(cached) = cache.get(&cur) {
            break cached.clone();
        }
        let parent_rec = records.get(&cur)?;
        let (next_parent, parent_name) = parent_rec.names.first()?;
        if *next_parent == cur {
            return None;
        }
        segments.push(parent_name.as_str());
        to_cache.push(cur);
        cur = *next_parent;
    };

    // Assemble the final path and populate the cache for every
    // directory we just walked through, so the next child of any of
    // them resolves in O(1). Walking segments in reverse of their push
    // order (i.e. from deepest back toward the base) lets us build the
    // cache progressively as we extend the string.
    let mut assembled = base_assembled;
    // `segments` was pushed deepest-child-first; iterate it in reverse
    // to go root → leaf order when appending.
    let mut to_cache_iter = to_cache.iter().rev();
    for seg in segments.iter().rev() {
        if !assembled.ends_with('\\') {
            assembled.push('\\');
        }
        assembled.push_str(seg);
        if let Some(dir_frn) = to_cache_iter.next() {
            cache.insert(*dir_frn, assembled.clone());
        }
    }
    Some(assembled)
}

/// Public entry: scan the volume containing `root_path` via the raw MFT.
/// Returns a Vec of records filtered to those whose full path is under
/// `root_path`. On error (not elevated, not NTFS, etc.) returns the
/// appropriate MftError and the caller falls back to the walker.
pub fn scan_via_mft<F>(
    root_path: &Path,
    mut progress_cb: F,
) -> Result<Vec<MftRecordParsed>, MftError>
where
    F: FnMut(u64, u64, u64),
{
    // Root path like "C:\" → drive letter 'C'. We use Prefix::Disk /
    // VerbatimDisk directly rather than parsing the prefix's string
    // form — the latter gave us "\" in testing because the first
    // Component returned from some normalized paths is RootDir, not
    // Prefix. Matching on Prefix::kind() is both type-safe and handles
    // verbatim-prefixed paths (\\?\C:\) that the normalize_path pass
    // can produce.
    let drive_letter = extract_drive_letter(root_path).ok_or_else(|| {
        MftError::Io(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "could not extract drive letter from root path: {:?}",
                root_path
            ),
        ))
    })?;

    eprintln!(
        "[diskhound-native-scanner] mft: opening volume {}:",
        drive_letter
    );
    let volume = open_volume_raw(drive_letter)?;
    let volume_data = query_ntfs_volume_data(&volume)?;
    eprintln!(
        "[diskhound-native-scanner] mft: volume data — BytesPerCluster={}, BytesPerFileRecordSegment={}, MftValidDataLength={} ({:.1} MB)",
        volume_data.BytesPerCluster,
        volume_data.BytesPerFileRecordSegment,
        volume_data.MftValidDataLength,
        volume_data.MftValidDataLength as f64 / (1024.0 * 1024.0)
    );

    let file = volume_handle_to_file(volume);
    let started = std::time::Instant::now();
    let records = read_all_mft_records(file, &volume_data, |total, files, dirs| {
        eprintln!(
            "[diskhound-native-scanner] mft: progress — {} records scanned, {} files + {} dirs kept ({}ms)",
            total,
            files,
            dirs,
            started.elapsed().as_millis()
        );
        progress_cb(total, files, dirs);
    })?;
    eprintln!(
        "[diskhound-native-scanner] mft: record read took {} ms ({} kept)",
        started.elapsed().as_millis(),
        records.len()
    );

    // Build drive root prefix like "C:\".
    let drive_root = format!("{}:\\", drive_letter.to_ascii_uppercase());

    // Root-scoped filter: if root_path is the drive root, keep everything;
    // otherwise filter to entries whose full path is under root_path.
    let root_norm = normalize_root_for_prefix_match(root_path);

    eprintln!(
        "[diskhound-native-scanner] mft: root_path={:?}, drive_root={:?}, root_norm={:?}",
        root_path, drive_root, root_norm
    );

    let path_build_started = std::time::Instant::now();
    // The path cache holds ONE entry per directory FRN (not per file).
    // File paths are assembled at emit time by resolving the parent
    // directory's path and appending the file's own name — this keeps
    // the cache small (~O(dirs) = ~1M entries) while still giving
    // O(1) amortized path build per file.
    let mut dir_path_cache: DirPathCache =
        HashMap::with_capacity(records.len() / 8);
    let mut out: Vec<MftRecordParsed> = Vec::with_capacity(records.len());
    let mut path_build_failures: u64 = 0;
    let mut root_filtered: u64 = 0;
    let mut hardlink_emits: u64 = 0;
    let mut sample_paths: Vec<String> = Vec::with_capacity(5);
    let mut sample_rejected: Vec<String> = Vec::with_capacity(5);

    let mut system_filtered: u64 = 0;
    for (&frn, rec) in records.iter() {
        for (parent_frn, name) in rec.names.iter() {
            // Skip NTFS pseudo-filesystem entries that a regular
            // FindFirstFile walker never sees. Without this filter the
            // scan reports 2.6 TB on an 800 GB drive because $UsnJrnl
            // advertises ~1.7 TB of logical size (sparse on disk),
            // $MFT ~7.6 GB, plus $LogFile, $Bitmap, $Secure, etc. None
            // of these are user-visible files. The System Volume
            // Information tree holds per-volume VSS / recovery metadata
            // that walkers also typically can't read.
            if is_ntfs_system_path(frn, *parent_frn, name) {
                system_filtered += 1;
                continue;
            }

            // Resolve the parent directory path (cached per-parent FRN).
            let parent_path = match resolve_dir_path(
                *parent_frn,
                &records,
                &mut dir_path_cache,
                &drive_root,
            ) {
                Some(p) => p,
                None => {
                    path_build_failures += 1;
                    continue;
                }
            };
            let mut full = parent_path;
            if !full.ends_with('\\') {
                full.push('\\');
            }
            full.push_str(name);

            // Second-chance path filter — excludes subtrees like
            // C:\$Extend\$UsnJrnl or C:\System Volume Information that
            // weren't caught by the FRN-level check above.
            if is_filtered_full_path(&full, &drive_root) {
                system_filtered += 1;
                continue;
            }

            if sample_paths.len() < 5 {
                sample_paths.push(full.clone());
            }
            if !root_norm.is_empty() && !path_matches_root(&full, &root_norm) {
                if sample_rejected.len() < 5 {
                    sample_rejected.push(full.clone());
                }
                root_filtered += 1;
                continue;
            }
            out.push(MftRecordParsed {
                frn,
                parent_frn: *parent_frn,
                name: full, // repurposed to carry the full path on output
                size: rec.size,
                mtime_ms: rec.mtime_ms,
                is_dir: rec.is_dir,
            });
        }
        if rec.names.len() > 1 {
            // We already counted the primary emit; each extra hardlink
            // adds one.
            hardlink_emits += rec.names.len() as u64 - 1;
        }
    }
    eprintln!(
        "[diskhound-native-scanner] mft: filtered {} NTFS system/metadata entries (pseudo-files like $MFT, $UsnJrnl that aren't visible to normal walkers)",
        system_filtered,
    );

    eprintln!(
        "[diskhound-native-scanner] mft: path build took {} ms ({} emitted [incl {} hardlink expansions], {} failed, {} root-filtered)",
        path_build_started.elapsed().as_millis(),
        out.len(),
        hardlink_emits,
        path_build_failures,
        root_filtered,
    );
    eprintln!(
        "[diskhound-native-scanner] mft: sample built paths: {:?}",
        sample_paths
    );
    if !sample_rejected.is_empty() {
        eprintln!(
            "[diskhound-native-scanner] mft: sample root-rejected paths: {:?}",
            sample_rejected
        );
    }

    Ok(out)
}

/// Pull the drive letter out of a root path. Handles the common forms:
///   C:\           → 'C'
///   C:            → 'C'
///   \\?\C:\       → 'C' (verbatim)
///   D:\Users\...  → 'D'
/// Also handles case where the first Component is a string-form Prefix
/// by falling back to parsing the raw path.
fn extract_drive_letter(root_path: &Path) -> Option<char> {
    use std::path::{Component, Prefix};
    for comp in root_path.components() {
        if let Component::Prefix(p) = comp {
            match p.kind() {
                Prefix::Disk(b) | Prefix::VerbatimDisk(b) => {
                    return Some(b as char);
                }
                _ => {}
            }
        }
    }
    // Fallback: inspect the raw string for "X:" at the start. Paths that
    // survive normalize_path's stripping of "\\?\" prefixes can look
    // weird to Rust's component iterator on some builds.
    let s = root_path.to_string_lossy();
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Some(bytes[0] as char);
    }
    None
}

/// Strip the `\\?\` verbatim prefix (Node passes paths this way after
/// `path.resolve()`), trim trailing separators, and lowercase (Windows
/// is case-insensitive) so prefix matching in path_matches_root works.
/// Without the prefix strip, every path comparison failed because the
/// built paths were "C:\..." but root was "\\?\C:\".
fn normalize_root_for_prefix_match(root: &Path) -> String {
    let s: String = root.to_string_lossy().into();
    let s = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", rest)
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s
    };
    let s = s.trim_end_matches(['\\', '/']);
    s.to_ascii_lowercase()
}

/// Identify NTFS pseudo-filesystem records. These occupy MFT entries
/// but don't show up through the regular Win32 walker API, so including
/// them makes our byte totals nonsense. Covers:
///   - Reserved FRNs 0..15 (except 5 = root, handled separately as a dir)
///   - Records whose immediate parent is root (FRN 5) AND name starts
///     with "$" — these are the top-level NTFS metadata files like $MFT,
///     $UsnJrnl (via $Extend), $LogFile, $Bitmap, $Boot, $BadClus, etc.
///   - Records whose parent is $Extend (FRN 11) — their children include
///     $UsnJrnl itself, which can advertise TB-sized sparse allocations.
fn is_ntfs_system_path(frn: u64, parent_frn: u64, name: &str) -> bool {
    // Reserved MFT slots. FRN 5 is the root directory — we need it to
    // resolve paths for regular files, so leave it in; resolve_dir_path
    // handles it specially.
    if frn <= 15 && frn != ROOT_FRN {
        return true;
    }
    // Top-level NTFS metadata files (parent = root) with $-prefixed names.
    if parent_frn == ROOT_FRN && name.starts_with('$') {
        return true;
    }
    // Anything whose parent is FRN 11 ($Extend) — covers $ObjId, $Quota,
    // $Reparse, $RmMetadata, and most importantly $UsnJrnl.
    if parent_frn == 11 {
        return true;
    }
    false
}

/// Post-path filter for subtree paths the FRN-level check can't catch —
/// primarily because a parent chain walker can't know a mid-tree FRN
/// corresponds to `System Volume Information` without doing the walk.
/// Keep this cheap: single ASCII prefix comparison per candidate path.
fn is_filtered_full_path(full_lc_path: &str, drive_root: &str) -> bool {
    // Build expected prefixes relative to the drive root. Most typical
    // tests: "C:\$" for NTFS metadata, "C:\System Volume Information"
    // for per-volume recovery metadata.
    let full_lower = full_lc_path.to_ascii_lowercase();
    let root_lower = drive_root.to_ascii_lowercase();
    let root_trim = root_lower.trim_end_matches(['\\', '/']);

    let sys_metadata_prefix = format!("{}{}", root_trim, r"\$");
    if full_lower.starts_with(&sys_metadata_prefix) {
        return true;
    }
    let svi_prefix = format!("{}{}", root_trim, r"\system volume information");
    if full_lower == svi_prefix || full_lower.starts_with(&format!("{}{}", svi_prefix, r"\")) {
        return true;
    }
    false
}

fn path_matches_root(full: &str, root_lc: &str) -> bool {
    let full_lc = full.to_ascii_lowercase();
    let trimmed = full_lc.trim_end_matches(['\\', '/']);
    if trimmed == root_lc {
        return true;
    }
    // Require the next char to be a separator so "C:\Users" doesn't match
    // "C:\UsersOther".
    if full_lc.starts_with(root_lc) {
        let next = full_lc.as_bytes().get(root_lc.len()).copied();
        return matches!(next, Some(b'\\') | Some(b'/'));
    }
    false
}

