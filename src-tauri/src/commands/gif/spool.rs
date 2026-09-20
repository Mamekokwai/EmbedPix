use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::Engine;

use super::GifFrameRequest;

const MAX_SPOOL_FRAMES: usize = 200;
const MAX_SPOOL_FRAME_BYTES: usize = 32 * 1024 * 1024;
const MAX_SPOOL_TOTAL_BYTES: usize = 128 * 1024 * 1024;

pub struct GifFrameSpoolState {
    root: PathBuf,
    entries: Mutex<HashMap<String, SpoolEntry>>,
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
        }
    }
}

impl GifFrameSpoolState {
    pub(super) fn create(&self) -> Result<String, String> {
        fs::create_dir_all(&self.root)
            .map_err(|error| format!("无法创建 GIF 临时目录：{error}"))?;
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
