use std::{
    collections::HashMap,
    fs,
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
    next_index: usize,
    total_bytes: usize,
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
            let directory = self.root.join(&id);
            if directory.exists() {
                continue;
            }
            fs::create_dir(&directory)
                .map_err(|error| format!("无法创建 GIF 临时帧目录：{error}"))?;
            self.entries
                .lock()
                .map_err(|_| "GIF 临时帧状态已损坏。".to_string())?
                .insert(
                    id.clone(),
                    SpoolEntry {
                        directory,
                        next_index: 0,
                        total_bytes: 0,
                    },
                );
            return Ok(id);
        }
        Err("无法生成唯一 GIF 临时帧 ID。".to_string())
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
            fs::remove_dir_all(&path)
                .map_err(|error| format!("无法清理 GIF 孤儿临时目录：{error}"))?;
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
        result
    }

    pub(super) fn discard(&self, id: &str) -> Result<(), String> {
        let entry = self
            .entries
            .lock()
            .map_err(|_| "GIF 临时帧状态已损坏。".to_string())?
            .remove(id);
        if let Some(entry) = entry {
            fs::remove_dir_all(entry.directory)
                .map_err(|error| format!("无法清理 GIF 临时帧：{error}"))?;
        }
        Ok(())
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
        let _ = fs::remove_dir_all(state.root);
    }

    #[test]
    fn failed_frame_write_does_not_leak_active_resource_counts() {
        let state = test_state("failed-write");
        let spool_id = state.create().unwrap();
        assert!(state.write_frame(&spool_id, "not-base64").is_err());
        assert_eq!(state.active_resource_snapshot(), (0, 0));
        state.discard(&spool_id).unwrap();
        assert_eq!(state.active_resource_snapshot(), (0, 0));
        let _ = fs::remove_dir_all(state.root);
    }

    #[test]
    fn removes_orphaned_directories_without_touching_active_spools() {
        let state = test_state("orphan-cleanup");
        fs::create_dir_all(&state.root).unwrap();
        let orphan = state.root.join("orphaned");
        fs::create_dir_all(&orphan).unwrap();
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
        let _ = fs::remove_dir_all(state.root);
    }

    #[test]
    fn records_grace_period_skips_without_exposing_paths() {
        let state = test_state("grace-period");
        fs::create_dir_all(&state.root).unwrap();
        let fresh = state.root.join("fresh");
        fs::create_dir_all(&fresh).unwrap();
        state
            .cleanup_orphaned_directories(ORPHAN_GRACE_PERIOD)
            .unwrap();
        let snapshot = state.latest_cleanup_snapshot().unwrap();
        assert_eq!(snapshot.removed, 0);
        assert_eq!(snapshot.skipped_active, 0);
        assert_eq!(snapshot.skipped_grace_period, 1);
        assert!(fresh.exists());
        let _ = fs::remove_dir_all(state.root);
    }
}
