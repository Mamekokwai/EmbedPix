use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::Engine;

use super::GifFrameRequest;

const MAX_SPOOL_FRAMES: usize = 200;
const MAX_SPOOL_FRAME_BYTES: usize = 32 * 1024 * 1024;
const MAX_SPOOL_TOTAL_BYTES: usize = 128 * 1024 * 1024;
const MAX_SPOOL_FRAME_BASE64_BYTES: usize = MAX_SPOOL_FRAME_BYTES.div_ceil(3) * 4;
const ORPHAN_GRACE_PERIOD: Duration = Duration::from_secs(60);

pub struct GifFrameSpoolState {
    root: PathBuf,
    entries: Mutex<HashMap<String, SpoolEntry>>,
    cleanup_snapshot: Mutex<Option<CleanupSnapshot>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CleanupSnapshot {
    scanned: usize,
    removed: usize,
    skipped_active: usize,
    skipped_grace_period: usize,
    elapsed_ms: u128,
}

struct SpoolEntry {
    directory: PathBuf,
    lock_path: PathBuf,
    _lock: SpoolLock,
    next_index: usize,
    total_bytes: usize,
}

struct SpoolLock {
    file: File,
}

impl SpoolLock {
    fn create(path: &PathBuf) -> io::Result<Self> {
        let file = OpenOptions::new()
            .create(true)
            .create_new(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        lock_file(&file)?;
        Ok(Self { file })
    }

    fn try_open(path: &PathBuf) -> io::Result<Option<Self>> {
        let file = match OpenOptions::new().read(true).write(true).open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        match lock_file(&file) {
            Ok(()) => Ok(Some(Self { file })),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(None),
            Err(error) => Err(error),
        }
    }
}

impl Drop for SpoolLock {
    fn drop(&mut self) {
        unlock_file(&self.file);
    }
}

#[cfg(unix)]
fn lock_file(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(())
    } else {
        let error = io::Error::last_os_error();
        if matches!(error.raw_os_error(), Some(libc::EAGAIN | libc::EWOULDBLOCK)) {
            Err(io::Error::new(io::ErrorKind::WouldBlock, error))
        } else {
            Err(error)
        }
    }
}

#[cfg(unix)]
fn unlock_file(file: &File) {
    use std::os::fd::AsRawFd;

    let _ = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
}

#[cfg(windows)]
fn lock_file(file: &File) -> io::Result<()> {
    use std::{mem::zeroed, os::windows::io::AsRawHandle};
    use windows_sys::Win32::{
        Storage::FileSystem::{LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY},
        System::IO::OVERLAPPED,
    };

    let mut overlapped = unsafe { zeroed::<OVERLAPPED>() };
    let result = unsafe {
        LockFileEx(
            file.as_raw_handle(),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            u32::MAX,
            u32::MAX,
            &mut overlapped,
        )
    };
    if result != 0 {
        Ok(())
    } else {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(33) {
            Err(io::Error::new(io::ErrorKind::WouldBlock, error))
        } else {
            Err(error)
        }
    }
}

#[cfg(windows)]
fn unlock_file(file: &File) {
    use std::{mem::zeroed, os::windows::io::AsRawHandle};
    use windows_sys::Win32::{Storage::FileSystem::UnlockFileEx, System::IO::OVERLAPPED};

    let mut overlapped = unsafe { zeroed::<OVERLAPPED>() };
    let _ = unsafe { UnlockFileEx(file.as_raw_handle(), 0, u32::MAX, u32::MAX, &mut overlapped) };
}

impl Default for GifFrameSpoolState {
    fn default() -> Self {
        Self {
            root: std::env::temp_dir().join("embedpix-gif-spool"),
            entries: Mutex::new(HashMap::new()),
            cleanup_snapshot: Mutex::new(None),
        }
    }
}

impl Drop for GifFrameSpoolState {
    fn drop(&mut self) {
        let entries = match self.entries.get_mut() {
            Ok(entries) => entries,
            Err(poisoned) => poisoned.into_inner(),
        };
        for (_, entry) in entries.drain() {
            let _ = fs::remove_dir_all(&entry.directory);
            drop(entry._lock);
            let _ = fs::remove_file(entry.lock_path);
        }
    }
}

impl GifFrameSpoolState {
    #[cfg(test)]
    fn active_resource_snapshot(&self) -> (usize, usize) {
        self.entries
            .lock()
            .map(|entries| {
                (
                    entries.values().map(|entry| entry.next_index).sum(),
                    entries.values().map(|entry| entry.total_bytes).sum(),
                )
            })
            .unwrap_or_default()
    }

    pub(super) fn create(&self) -> Result<String, String> {
        fs::create_dir_all(&self.root)
            .map_err(|error| format!("无法创建 GIF 临时目录：{error}"))?;
        self.cleanup_orphaned_directories(ORPHAN_GRACE_PERIOD)?;
        for attempt in 0..8 {
            let id = spool_id(attempt);
            match self.create_entry(&id)? {
                Some(id) => return Ok(id),
                None => continue,
            }
        }
        Err("无法生成唯一 GIF 临时帧 ID。".to_string())
    }

    fn create_entry(&self, id: &str) -> Result<Option<String>, String> {
        let directory = self.root.join(id);
        let lock_path = self.root.join(format!("{id}.lock"));
        let lock = match SpoolLock::create(&lock_path) {
            Ok(lock) => lock,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(None),
            Err(error) => return Err(format!("无法锁定 GIF 临时帧目录：{error}")),
        };
        if let Err(error) = fs::create_dir(&directory) {
            drop(lock);
            let _ = fs::remove_file(&lock_path);
            return Err(format!("无法创建 GIF 临时帧目录：{error}"));
        }
        let mut entries = match self.entries.lock() {
            Ok(entries) => entries,
            Err(_) => {
                let _ = fs::remove_dir_all(&directory);
                drop(lock);
                let _ = fs::remove_file(&lock_path);
                return Err("GIF 临时帧状态已损坏。".to_string());
            }
        };
        entries.insert(
            id.to_string(),
            SpoolEntry {
                directory,
                lock_path,
                _lock: lock,
                next_index: 0,
                total_bytes: 0,
            },
        );
        Ok(Some(id.to_string()))
    }

    pub(super) fn write_frame(&self, id: &str, encoded: &str) -> Result<(), String> {
        if encoded.len() > MAX_SPOOL_FRAME_BASE64_BYTES {
            return Err("GIF 临时帧数据超过单帧内存上限。".to_string());
        }
        let data = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "GIF 临时帧数据无效。".to_string())?;
        if data.is_empty() || data.len() > MAX_SPOOL_FRAME_BYTES {
            return Err("GIF 临时帧大小无效。".to_string());
        }
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "GIF 临时帧状态已损坏。".to_string())?;
        let entry = entries
            .get_mut(id)
            .ok_or_else(|| "GIF 临时帧 ID 无效或已过期。".to_string())?;
        if entry.next_index >= MAX_SPOOL_FRAMES {
            return Err("GIF 临时帧数量超过上限。".to_string());
        }
        let next_total = entry
            .total_bytes
            .checked_add(data.len())
            .ok_or_else(|| "GIF 临时帧总大小无效。".to_string())?;
        if next_total > MAX_SPOOL_TOTAL_BYTES {
            return Err("GIF 临时帧总大小超过上限。".to_string());
        }
        let path = entry
            .directory
            .join(format!("frame-{:06}.bin", entry.next_index));
        fs::write(path, data).map_err(|error| format!("无法写入 GIF 临时帧：{error}"))?;
        entry.next_index += 1;
        entry.total_bytes = next_total;
        Ok(())
    }

    fn cleanup_orphaned_directories(&self, grace_period: Duration) -> Result<(), String> {
        let started_at = Instant::now();
        let entries = self
            .entries
            .lock()
            .map_err(|_| "GIF 临时帧状态已损坏。".to_string())?;
        let active_directories: Vec<PathBuf> = entries
            .values()
            .map(|entry| entry.directory.clone())
            .collect();
        let mut scanned = 0usize;
        let mut removed = 0usize;
        let mut skipped_active = 0usize;
        let mut skipped_grace_period = 0usize;
        for item in
            fs::read_dir(&self.root).map_err(|error| format!("无法扫描 GIF 临时目录：{error}"))?
        {
            let path = item
                .map_err(|error| format!("无法读取 GIF 临时目录项：{error}"))?
                .path();
            if path.is_file() {
                let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                let Some(id) = name.strip_suffix(".lock") else {
                    continue;
                };
                if id.is_empty() || self.root.join(id).exists() {
                    continue;
                }
                let recently_created = fs::metadata(&path)
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                    .is_some_and(|age| age < grace_period);
                if recently_created {
                    skipped_grace_period += 1;
                    continue;
                }
                let Some(lock) = SpoolLock::try_open(&path)
                    .map_err(|error| format!("无法检查 GIF 临时帧目录锁：{error}"))?
                else {
                    skipped_active += 1;
                    continue;
                };
                let quarantine = path.with_file_name(format!(".{name}.quarantine-{}", spool_id(0)));
                if fs::rename(&path, &quarantine).is_err() {
                    drop(lock);
                    skipped_active += 1;
                    continue;
                }
                drop(lock);
                let _ = fs::remove_file(quarantine);
                continue;
            }
            if !path.is_dir() {
                continue;
            }
            scanned += 1;
            if active_directories.iter().any(|active| active == &path) {
                skipped_active += 1;
                continue;
            }
            let recently_created = fs::metadata(&path)
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age < grace_period);
            if recently_created {
                skipped_grace_period += 1;
                continue;
            }
            let lock_path = path.with_extension("lock");
            let Some(lock) = SpoolLock::try_open(&lock_path)
                .map_err(|error| format!("无法检查 GIF 临时帧目录锁：{error}"))?
            else {
                skipped_active += 1;
                continue;
            };
            remove_dir_all_idempotent(&path)
                .map_err(|error| format!("无法清理 GIF 孤儿临时目录：{error}"))?;
            drop(lock);
            let _ = fs::remove_file(lock_path);
            removed += 1;
        }
        let snapshot = CleanupSnapshot {
            scanned,
            removed,
            skipped_active,
            skipped_grace_period,
            elapsed_ms: started_at.elapsed().as_millis(),
        };
        if let Ok(mut latest) = self.cleanup_snapshot.lock() {
            *latest = Some(snapshot.clone());
        }
        eprintln!(
            "GIF 临时目录扫描：扫描 {scanned} 个目录，清理 {removed} 个，跳过活跃 {skipped_active} 个、宽限期 {skipped_grace_period} 个，耗时 {} ms。",
            snapshot.elapsed_ms
        );
        Ok(())
    }

    #[cfg(test)]
    fn latest_cleanup_snapshot(&self) -> Option<CleanupSnapshot> {
        self.cleanup_snapshot
            .lock()
            .ok()
            .and_then(|latest| latest.clone())
    }

    pub(super) fn take_frames(
        &self,
        id: &str,
        durations: &[u32],
    ) -> Result<Vec<GifFrameRequest>, String> {
        let entry = self
            .entries
            .lock()
            .map_err(|_| "GIF 临时帧状态已损坏。".to_string())?
            .remove(id)
            .ok_or_else(|| "GIF 临时帧 ID 无效或已过期。".to_string())?;
        let result = (|| {
            if durations.is_empty()
                || durations.len() != entry.next_index
                || durations.len() > MAX_SPOOL_FRAMES
            {
                return Err("GIF 临时帧元数据与已写入帧数不匹配。".to_string());
            }
            durations
                .iter()
                .enumerate()
                .map(|(index, duration_ms)| {
                    let data = fs::read(entry.directory.join(format!("frame-{:06}.bin", index)))
                        .map_err(|error| format!("无法读取 GIF 临时帧：{error}"))?;
                    Ok(GifFrameRequest {
                        data,
                        duration_ms: *duration_ms,
                    })
                })
                .collect()
        })();
        let _ = fs::remove_dir_all(&entry.directory);
        drop(entry._lock);
        let _ = fs::remove_file(entry.lock_path);
        result
    }

    pub(super) fn discard(&self, id: &str) -> Result<(), String> {
        let entry = self
            .entries
            .lock()
            .map_err(|_| "GIF 临时帧状态已损坏。".to_string())?
            .remove(id);
        if let Some(entry) = entry {
            remove_dir_all_idempotent(&entry.directory)
                .map_err(|error| format!("无法清理 GIF 临时帧：{error}"))?;
            drop(entry._lock);
            let _ = fs::remove_file(entry.lock_path);
        }
        Ok(())
    }
}

fn remove_dir_all_idempotent(path: &PathBuf) -> std::io::Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn spool_id(attempt: u32) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO);
    let mut seed = [0u8; 32];
    seed[..16].copy_from_slice(&now.as_nanos().to_le_bytes());
    seed[16..24].copy_from_slice(&(std::process::id() as u64).to_le_bytes());
    seed[24..28].copy_from_slice(&attempt.to_le_bytes());
    getrandom::fill(&mut seed).unwrap_or_else(|_| {
        for (index, byte) in seed.iter_mut().enumerate() {
            *byte ^= (index as u8).wrapping_mul(31);
        }
    });
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(seed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state(name: &str) -> GifFrameSpoolState {
        GifFrameSpoolState {
            root: std::env::temp_dir().join(format!(
                "embedpix-gif-spool-test-{name}-{}",
                std::process::id()
            )),
            entries: Mutex::new(HashMap::new()),
            cleanup_snapshot: Mutex::new(None),
        }
    }

    #[test]
    fn creates_and_cleans_a_200_frame_spool() {
        let state = test_state("frame-limit");
        let spool_id = state.create().unwrap();
        for _ in 0..MAX_SPOOL_FRAMES {
            state
                .write_frame(
                    &spool_id,
                    &base64::engine::general_purpose::STANDARD.encode([1u8]),
                )
                .unwrap();
        }
        assert_eq!(
            state.active_resource_snapshot(),
            (MAX_SPOOL_FRAMES, MAX_SPOOL_FRAMES)
        );
        assert!(state
            .write_frame(
                &spool_id,
                &base64::engine::general_purpose::STANDARD.encode([1u8])
            )
            .is_err());
        state.discard(&spool_id).unwrap();
        assert_eq!(state.active_resource_snapshot(), (0, 0));
        assert!(!state.root.join(&spool_id).exists());
        let _ = fs::remove_dir_all(state.root.clone());
    }

    #[test]
    fn failed_frame_write_does_not_leak_active_resource_counts() {
        let state = test_state("failed-write");
        let spool_id = state.create().unwrap();
        assert!(state.write_frame(&spool_id, "not-base64").is_err());
        assert_eq!(state.active_resource_snapshot(), (0, 0));
        state.discard(&spool_id).unwrap();
        assert_eq!(state.active_resource_snapshot(), (0, 0));
        let _ = fs::remove_dir_all(state.root.clone());
    }

    #[test]
    fn repeated_directory_cleanup_treats_missing_directory_as_success() {
        let state = test_state("missing-cleanup");
        let directory = state.root.join("already-removed");
        fs::create_dir_all(&directory).unwrap();
        fs::remove_dir_all(&directory).unwrap();
        assert!(remove_dir_all_idempotent(&directory).is_ok());
        let _ = fs::remove_dir_all(state.root.clone());
    }

    #[test]
    fn removes_orphaned_directories_without_touching_active_spools() {
        let state = test_state("orphan-cleanup");
        fs::create_dir_all(&state.root).unwrap();
        let orphan = state.root.join("orphaned");
        fs::create_dir_all(&orphan).unwrap();
        drop(SpoolLock::create(&state.root.join("orphaned.lock")).unwrap());
        let active_id = state.create().unwrap();
        state.cleanup_orphaned_directories(Duration::ZERO).unwrap();
        let snapshot = state.latest_cleanup_snapshot().unwrap();
        assert_eq!(snapshot.removed, 1);
        assert_eq!(snapshot.skipped_active, 1);
        assert_eq!(snapshot.skipped_grace_period, 0);
        assert!(snapshot.elapsed_ms < 1_000);
        assert!(!orphan.exists());
        assert!(state.root.join(&active_id).exists());
        state.discard(&active_id).unwrap();
        let _ = fs::remove_dir_all(state.root.clone());
    }

    #[test]
    fn records_grace_period_skips_without_exposing_paths() {
        let state = test_state("grace-period");
        fs::create_dir_all(&state.root).unwrap();
        let fresh = state.root.join("fresh");
        fs::create_dir_all(&fresh).unwrap();
        drop(SpoolLock::create(&state.root.join("fresh.lock")).unwrap());
        state
            .cleanup_orphaned_directories(ORPHAN_GRACE_PERIOD)
            .unwrap();
        let snapshot = state.latest_cleanup_snapshot().unwrap();
        assert_eq!(snapshot.removed, 0);
        assert_eq!(snapshot.skipped_active, 0);
        assert_eq!(snapshot.skipped_grace_period, 1);
        assert!(fresh.exists());
        let _ = fs::remove_dir_all(state.root.clone());
    }

    #[test]
    fn cleanup_does_not_remove_a_spool_locked_by_another_instance() {
        let state = test_state("foreign-lock");
        fs::create_dir_all(&state.root).unwrap();
        let foreign = state.root.join("foreign");
        fs::create_dir_all(&foreign).unwrap();
        let _foreign_lock = SpoolLock::create(&state.root.join("foreign.lock")).unwrap();
        state.cleanup_orphaned_directories(Duration::ZERO).unwrap();
        let snapshot = state.latest_cleanup_snapshot().unwrap();
        assert_eq!(snapshot.removed, 0);
        assert_eq!(snapshot.skipped_active, 1);
        assert!(foreign.exists());
        let _ = fs::remove_dir_all(state.root.clone());
    }

    #[test]
    fn cleanup_handles_directory_created_after_lock_without_removing_active_spool() {
        let state = test_state("creation-window");
        fs::create_dir_all(&state.root).unwrap();
        let id = "creation-window";
        let lock_path = state.root.join(format!("{id}.lock"));
        let lock = SpoolLock::create(&lock_path).unwrap();
        let directory = state.root.join(id);
        fs::create_dir(&directory).unwrap();

        state.cleanup_orphaned_directories(Duration::ZERO).unwrap();
        assert!(directory.exists());
        assert_eq!(state.latest_cleanup_snapshot().unwrap().skipped_active, 1);

        drop(lock);
        state.cleanup_orphaned_directories(Duration::ZERO).unwrap();
        assert!(!directory.exists());
        assert!(!lock_path.exists());
        let _ = fs::remove_dir_all(state.root.clone());
    }

    #[test]
    fn cleanup_skips_an_active_lock_without_a_directory() {
        let state = test_state("active-lock-only");
        fs::create_dir_all(&state.root).unwrap();
        let lock_path = state.root.join("active-lock-only.lock");
        let lock = SpoolLock::create(&lock_path).unwrap();

        state.cleanup_orphaned_directories(Duration::ZERO).unwrap();
        assert!(lock_path.exists());
        assert_eq!(state.latest_cleanup_snapshot().unwrap().skipped_active, 1);

        drop(lock);
        let _ = fs::remove_file(lock_path);
        let _ = fs::remove_dir_all(state.root.clone());
    }

    #[test]
    fn cleanup_removes_a_stale_lock_without_a_directory() {
        let state = test_state("stale-lock-only");
        fs::create_dir_all(&state.root).unwrap();
        let lock_path = state.root.join("stale-lock-only.lock");
        let unrelated = state.root.join("unrelated.lock.bak");
        fs::write(&unrelated, b"keep").unwrap();
        drop(SpoolLock::create(&lock_path).unwrap());

        state.cleanup_orphaned_directories(Duration::ZERO).unwrap();
        assert!(!lock_path.exists());
        assert!(unrelated.exists());
        assert!(fs::read_dir(&state.root).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("quarantine-")));
        let _ = fs::remove_dir_all(state.root.clone());
    }

    #[test]
    fn failed_directory_creation_removes_precreated_lock() {
        let state = test_state("creation-failure");
        fs::create_dir_all(&state.root).unwrap();
        let id = "creation-failure";
        let directory = state.root.join(id);
        fs::write(&directory, b"not a directory").unwrap();
        let error = state.create_entry(id).unwrap_err();

        assert!(error.contains("无法创建 GIF 临时帧目录"));
        assert!(!state.root.join(format!("{id}.lock")).exists());
        assert!(directory.exists());
        let _ = fs::remove_dir_all(state.root.clone());
    }

    #[test]
    fn dropping_state_cleans_active_spool_directories() {
        let state = test_state("drop-cleanup");
        let root = state.root.clone();
        let spool_id = state.create().unwrap();
        let directory = root.join(&spool_id);
        let lock_path = root.join(format!("{spool_id}.lock"));
        assert!(directory.exists());
        assert!(lock_path.exists());
        drop(state);
        assert!(!directory.exists());
        assert!(!lock_path.exists());
        let _ = fs::remove_dir_all(root);
    }
}
