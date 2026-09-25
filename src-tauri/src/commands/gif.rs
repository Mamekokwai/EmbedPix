use std::{
    collections::HashMap,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};

use base64::Engine;
use color_quant::NeuQuant;
use gif::{DisposalMethod, Encoder, Frame as GifFrame, Repeat};
use image::{
    imageops::FilterType,
    io::{Limits, Reader as ImageReader},
    ImageFormat,
};
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use tauri::State;

mod animation;
pub mod benchmark;
mod dither;
mod sequence;
mod spool;
mod storage;
#[cfg(test)]
mod tests;
mod webp;

const MAX_GIF_FRAMES: usize = 200;
const MAX_GIF_DIMENSION: u32 = 4096;
const MAX_GIF_PIXELS: u64 = 16_777_216;
const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;
const MAX_TOTAL_FRAME_BYTES: usize = 128 * 1024 * 1024;
const MAX_TOTAL_GIF_PIXELS: u64 = 64 * 1024 * 1024;
const MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;
const MIN_FRAME_DURATION_MS: u32 = 10;
const MAX_FRAME_DURATION_MS: u32 = 60_000;
const MIN_ENCODING_SPEED: i32 = 1;
const MAX_ENCODING_SPEED: i32 = 30;
const MIN_COLOR_COUNT: u16 = 2;
const MAX_COLOR_COUNT: u16 = 256;
const JOB_OPEN: u8 = 0;
const JOB_CANCELLING: u8 = 1;
const JOB_PUBLISHING: u8 = 2;
const JOB_COMMITTED: u8 = 3;
const JOB_FAILED: u8 = 4;
const JOB_CANCELLED: u8 = 5;
const MAX_ENCODING_CONCURRENCY: usize = 2;
const JOB_RETENTION: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GifExportProgress {
    pub job_id: String,
    pub format: String,
    pub status: String,
    pub stage: String,
    pub completed_frames: usize,
    pub total_frames: usize,
    pub output_path: Option<String>,
    pub error: Option<String>,
}

pub struct GifExportJobState {
    jobs: Mutex<HashMap<String, Arc<GifExportJob>>>,
    encoder_slots: Arc<EncodingSemaphore>,
}

pub use sequence::{export_png_sequence_cli, PngSequenceExportRequest};
pub use spool::GifFrameSpoolState;

pub(super) struct GifExportJob {
    phase: AtomicU8,
    progress: Mutex<GifExportProgress>,
    terminal_at: Mutex<Option<Instant>>,
}

struct EncodingSemaphore {
    available: Mutex<usize>,
    wake: Condvar,
}

struct EncodingPermit {
    semaphore: Arc<EncodingSemaphore>,
}

impl Default for GifExportJobState {
    fn default() -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            encoder_slots: Arc::new(EncodingSemaphore::new(MAX_ENCODING_CONCURRENCY)),
        }
    }
}

impl EncodingSemaphore {
    fn new(limit: usize) -> Self {
        assert!(limit > 0);
        Self {
            available: Mutex::new(limit),
            wake: Condvar::new(),
        }
    }

    fn acquire(self: &Arc<Self>) -> EncodingPermit {
        let mut available = self.available.lock().expect("encoding semaphore poisoned");
        while *available == 0 {
            available = self
                .wake
                .wait(available)
                .expect("encoding semaphore poisoned");
        }
        *available -= 1;
        EncodingPermit {
            semaphore: Arc::clone(self),
        }
    }
}

impl Drop for EncodingPermit {
    fn drop(&mut self) {
        if let Ok(mut available) = self.semaphore.available.lock() {
            *available += 1;
            self.semaphore.wake.notify_one();
        }
    }
}

pub(super) struct PublishLease(Arc<GifExportJob>);

impl Drop for PublishLease {
    fn drop(&mut self) {
        let _ = self.0.phase.compare_exchange(
            JOB_PUBLISHING,
            JOB_OPEN,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }
}

impl GifExportJob {
    fn new(job_id: String, format: &str, total_frames: usize) -> Self {
        Self {
            phase: AtomicU8::new(JOB_OPEN),
            progress: Mutex::new(GifExportProgress {
                job_id,
                format: format.to_string(),
                status: "running".to_string(),
                stage: "validating".to_string(),
                completed_frames: 0,
                total_frames,
                output_path: None,
                error: None,
            }),
            terminal_at: Mutex::new(None),
        }
    }

    fn mark_terminal(&self) {
        if let Ok(mut terminal_at) = self.terminal_at.lock() {
            *terminal_at = Some(Instant::now());
        }
    }

    fn is_expired(&self, now: Instant) -> bool {
        self.terminal_at
            .lock()
            .ok()
            .and_then(|terminal_at| *terminal_at)
            .is_some_and(|terminal_at| now.duration_since(terminal_at) >= JOB_RETENTION)
    }

    #[cfg(test)]
    fn expire_for_test(&self) {
        if let Ok(mut terminal_at) = self.terminal_at.lock() {
            *terminal_at = Some(Instant::now() - JOB_RETENTION - Duration::from_secs(1));
        }
    }

    fn is_active(&self) -> bool {
        matches!(
            self.phase.load(Ordering::Acquire),
            JOB_OPEN | JOB_CANCELLING | JOB_PUBLISHING
        )
    }

    fn checkpoint(&self) -> Result<(), String> {
        if self.phase.load(Ordering::Acquire) == JOB_CANCELLING {
            Err("导出已取消。".to_string())
        } else {
            Ok(())
        }
    }

    fn report(&self, stage: &str, completed_frames: usize) {
        if let Ok(mut progress) = self.progress.lock() {
            progress.stage = stage.to_string();
            progress.completed_frames = completed_frames;
        }
    }

    fn cancel(&self) -> GifExportProgress {
        let mut phase = self.phase.load(Ordering::Acquire);
        loop {
            match phase {
                JOB_OPEN => match self.phase.compare_exchange(
                    JOB_OPEN,
                    JOB_CANCELLING,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                ) {
                    Ok(_) => break,
                    Err(next) => phase = next,
                },
                JOB_CANCELLING | JOB_PUBLISHING | JOB_COMMITTED => {
                    return self.progress();
                }
                _ => return self.progress(),
            }
        }
        if let Ok(mut progress) = self.progress.lock() {
            progress.status = "cancelling".to_string();
            progress.stage = "cancelling".to_string();
            return progress.clone();
        }
        self.progress()
    }

    fn finish_ok(&self, output_path: String) {
        if let Ok(mut progress) = self.progress.lock() {
            if self.phase.load(Ordering::Acquire) == JOB_CANCELLING {
                progress.status = "cancelled".to_string();
                progress.stage = "cancelled".to_string();
                progress.error = Some("导出已取消。".to_string());
                self.phase.store(JOB_CANCELLED, Ordering::Release);
                self.mark_terminal();
            } else {
                progress.status = "completed".to_string();
                progress.stage = "completed".to_string();
                progress.output_path = Some(output_path);
                self.phase.store(JOB_COMMITTED, Ordering::Release);
                self.mark_terminal();
            }
        }
    }

    fn finish_error(&self, error: String) {
        if let Ok(mut progress) = self.progress.lock() {
            if self.phase.load(Ordering::Acquire) == JOB_CANCELLING {
                progress.status = "cancelled".to_string();
                progress.stage = "cancelled".to_string();
                progress.error = Some("导出已取消。".to_string());
                self.phase.store(JOB_CANCELLED, Ordering::Release);
            } else {
                progress.status = "failed".to_string();
                progress.stage = "failed".to_string();
                progress.error = Some(error);
                self.phase.store(JOB_FAILED, Ordering::Release);
            }
            self.mark_terminal();
        }
    }

    fn progress(&self) -> GifExportProgress {
        self.progress
            .lock()
            .map(|progress| progress.clone())
            .unwrap_or_else(|_| GifExportProgress {
                job_id: String::new(),
                format: "unknown".to_string(),
                status: "failed".to_string(),
                stage: "failed".to_string(),
                completed_frames: 0,
                total_frames: 0,
                output_path: None,
                error: Some("导出任务状态不可用。".to_string()),
            })
    }

    fn begin_publish(self: &Arc<Self>) -> Result<PublishLease, String> {
        match self.phase.compare_exchange(
            JOB_OPEN,
            JOB_PUBLISHING,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => {
                if let Ok(mut progress) = self.progress.lock() {
                    progress.stage = "publishing".to_string();
                }
                Ok(PublishLease(Arc::clone(self)))
            }
            Err(JOB_CANCELLING) => Err("导出已取消。".to_string()),
            Err(_) => Err("导出任务已进入发布阶段。".to_string()),
        }
    }

    fn mark_published(&self, output_path: String) {
        if let Ok(mut progress) = self.progress.lock() {
            progress.status = "completed".to_string();
            progress.stage = "completed".to_string();
            progress.completed_frames = progress.total_frames;
            progress.output_path = Some(output_path);
            progress.error = None;
        }
        self.phase.store(JOB_COMMITTED, Ordering::Release);
        self.mark_terminal();
    }
}

impl GifExportJobState {
    fn cleanup_expired(&self) -> Result<(), String> {
        let now = Instant::now();
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| "导出任务状态不可用。".to_string())?;
        jobs.retain(|_, job| !job.is_expired(now));
        Ok(())
    }

    fn encoder_slots(&self) -> Arc<EncodingSemaphore> {
        Arc::clone(&self.encoder_slots)
    }

    fn register(
        &self,
        job_id: Option<&str>,
        format: &str,
        total_frames: usize,
    ) -> Result<Option<Arc<GifExportJob>>, String> {
        self.cleanup_expired()?;
        let Some(job_id) = normalize_job_id(job_id)? else {
            return Ok(None);
        };
        let job = Arc::new(GifExportJob::new(job_id.clone(), format, total_frames));
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| "导出任务状态不可用。".to_string())?;
        if jobs
            .get(&job_id)
            .is_some_and(|existing| existing.is_active())
        {
            return Err("导出任务 ID 已在使用中。".to_string());
        }
        jobs.insert(job_id, job.clone());
        Ok(Some(job))
    }

    fn get(&self, job_id: &str) -> Result<Arc<GifExportJob>, String> {
        self.cleanup_expired()?;
        let job_id =
            normalize_job_id(Some(job_id))?.ok_or_else(|| "导出任务 ID 不能为空。".to_string())?;
        self.jobs
            .lock()
            .map_err(|_| "导出任务状态不可用。".to_string())?
            .get(&job_id)
            .cloned()
            .ok_or_else(|| "导出任务不存在或已过期。".to_string())
    }
}

fn normalize_job_id(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.len() > 128 || value.chars().any(char::is_control) {
        return Err("导出任务 ID 无效。".to_string());
    }
    Ok(Some(value.to_string()))
}

pub(super) type ExportJob = Option<Arc<GifExportJob>>;

pub(super) fn job_checkpoint(job: &ExportJob) -> Result<(), String> {
    if let Some(job) = job {
        job.checkpoint()?;
    }
    Ok(())
}

pub(super) fn job_report(job: &ExportJob, stage: &str, completed_frames: usize) {
    if let Some(job) = job {
        job.report(stage, completed_frames);
    }
}

pub(super) fn job_begin_publish(job: &ExportJob) -> Result<Option<PublishLease>, String> {
    job.as_ref()
        .map_or(Ok(None), |job| job.begin_publish().map(Some))
}

pub(super) fn job_mark_published(job: &ExportJob, output_path: String) {
    if let Some(job) = job {
        job.mark_published(output_path);
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifExportRequest {
    #[serde(default)]
    output_path: String,
    #[serde(default)]
    output_location: Option<String>,
    #[serde(default)]
    source_path: Option<String>,
    #[serde(default)]
    output_subdirectory: Option<String>,
    #[serde(default)]
    output_directory: Option<String>,
    #[serde(default)]
    file_name: Option<String>,
    width: u32,
    height: u32,
    loop_mode: String,
    loop_count: u16,
    #[serde(default = "default_encoding_speed")]
    encoding_speed: i32,
    #[serde(default = "default_color_count")]
    color_count: u16,
    #[serde(default = "default_dither_mode")]
    dither_mode: String,
    #[serde(default)]
    frames: Vec<GifFrameRequest>,
    #[serde(default)]
    spool_id: Option<String>,
    #[serde(default)]
    spool_durations: Vec<u32>,
    #[serde(default)]
    overwrite_existing: bool,
    #[serde(default)]
    job_id: Option<String>,
    #[serde(default)]
    target_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct GifSizeEstimateRequest {
    width: u32,
    height: u32,
    loop_mode: String,
    loop_count: u16,
    #[serde(default = "default_encoding_speed")]
    encoding_speed: i32,
    #[serde(default = "default_color_count")]
    color_count: u16,
    #[serde(default = "default_dither_mode")]
    dither_mode: String,
    frames: Vec<GifFrameRequest>,
}

impl From<GifSizeEstimateRequest> for GifExportRequest {
    fn from(request: GifSizeEstimateRequest) -> Self {
        Self {
            output_path: "estimate.gif".to_string(),
            output_location: None,
            source_path: None,
            output_subdirectory: None,
            output_directory: None,
            file_name: None,
            width: request.width,
            height: request.height,
            loop_mode: request.loop_mode,
            loop_count: request.loop_count,
            encoding_speed: request.encoding_speed,
            color_count: request.color_count,
            dither_mode: request.dither_mode,
            frames: request.frames,
            spool_id: None,
            spool_durations: Vec::new(),
            overwrite_existing: false,
            job_id: None,
            target_bytes: None,
        }
    }
}

fn default_encoding_speed() -> i32 {
    MIN_ENCODING_SPEED
}

fn default_color_count() -> u16 {
    MAX_COLOR_COUNT
}

fn default_dither_mode() -> String {
    "none".to_string()
}

#[derive(Debug, Clone)]
pub struct GifFrameRequest {
    data: Vec<u8>,
    duration_ms: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GifCompressionRequest {
    width: u32,
    height: u32,
    loop_mode: String,
    loop_count: u16,
    #[serde(default = "default_encoding_speed")]
    encoding_speed: i32,
    #[serde(default = "default_color_count")]
    color_count: u16,
    #[serde(default = "default_dither_mode")]
    dither_mode: String,
    frames: Vec<GifFrameRequest>,
    target_bytes: u64,
    #[serde(default)]
    max_candidates: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GifCompressionCandidate {
    pub width: u32,
    pub height: u32,
    pub color_count: u16,
    pub frame_count: usize,
    pub estimated_bytes: u64,
    pub meets_target: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GifCompressionResult {
    pub target_bytes: u64,
    pub selected: Option<GifCompressionCandidate>,
    pub candidates: Vec<GifCompressionCandidate>,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GifFrameWire {
    #[serde(default)]
    data: Option<Vec<u8>>,
    #[serde(default)]
    data_base64: Option<String>,
    duration_ms: u32,
}

impl<'de> Deserialize<'de> for GifFrameRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = GifFrameWire::deserialize(deserializer)?;
        let data = match (wire.data, wire.data_base64) {
            (Some(data), None) => data,
            (None, Some(encoded)) => base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(serde::de::Error::custom)?,
            (Some(_), Some(_)) => {
                return Err(serde::de::Error::custom(
                    "GIF 帧不能同时提供 data 和 dataBase64。",
                ))
            }
            (None, None) => return Err(serde::de::Error::missing_field("dataBase64")),
        };
        Ok(Self {
            data,
            duration_ms: wire.duration_ms,
        })
    }
}

#[derive(Debug, Serialize)]
pub struct GifSizeEstimateResult {
    pub bytes: u64,
}

#[tauri::command]
pub async fn pick_gif_output(suggested_name: String) -> Result<Option<String>, String> {
    let file_name = normalize_suggested_name(&suggested_name);
    Ok(FileDialog::new()
        .add_filter("GIF 动图", &["gif"])
        .set_file_name(&file_name)
        .save_file()
        .map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn export_gif(
    state: State<'_, GifExportJobState>,
    spool_state: State<'_, GifFrameSpoolState>,
    mut request: GifExportRequest,
) -> Result<String, String> {
    if let Some(spool_id) = request.spool_id.take() {
        request.frames = spool_state.take_frames(&spool_id, &request.spool_durations)?;
        request.spool_durations.clear();
    }
    let job = state.register(request.job_id.as_deref(), "gif", request.frames.len())?;
    let encoder_slots = state.encoder_slots();
    let result = tauri::async_runtime::spawn_blocking({
        let job = job.clone();
        move || {
            let _encoding_permit = encoder_slots.acquire();
            export_gif_blocking_with_job(request, job)
        }
    })
    .await
    .map_err(|error| format!("GIF 导出任务失败：{error}"))?;
    if let Some(job) = &job {
        match &result {
            Ok(output_path) => job.finish_ok(output_path.clone()),
            Err(error) => job.finish_error(error.clone()),
        }
    }
    result
}

#[tauri::command]
pub fn create_gif_frame_spool(state: State<'_, GifFrameSpoolState>) -> Result<String, String> {
    state.create()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GifSpoolFrameRequest {
    spool_id: String,
    data_base64: String,
}

#[tauri::command]
pub fn write_gif_frame_spool(
    state: State<'_, GifFrameSpoolState>,
    request: GifSpoolFrameRequest,
) -> Result<(), String> {
    state.write_frame(&request.spool_id, &request.data_base64)
}

#[tauri::command]
pub fn discard_gif_frame_spool(
    state: State<'_, GifFrameSpoolState>,
    spool_id: String,
) -> Result<(), String> {
    state.discard(&spool_id)
}

#[tauri::command]
pub fn cancel_gif_export(
    state: State<'_, GifExportJobState>,
    job_id: String,
) -> Result<GifExportProgress, String> {
    Ok(state.get(&job_id)?.cancel())
}

#[tauri::command]
pub fn get_gif_export_progress(
    state: State<'_, GifExportJobState>,
    job_id: String,
) -> Result<GifExportProgress, String> {
    Ok(state.get(&job_id)?.progress())
}

#[tauri::command]
pub async fn estimate_gif_size(
    state: State<'_, GifExportJobState>,
    request: GifSizeEstimateRequest,
) -> Result<GifSizeEstimateResult, String> {
    let encoder_slots = state.encoder_slots();
    tauri::async_runtime::spawn_blocking(move || {
        let _encoding_permit = encoder_slots.acquire();
        estimate_gif_size_blocking(request)
    })
    .await
    .map_err(|error| format!("GIF 体积测量任务失败：{error}"))?
}

#[tauri::command]
pub async fn plan_gif_compression(
    state: State<'_, GifExportJobState>,
    request: GifCompressionRequest,
) -> Result<GifCompressionResult, String> {
    let encoder_slots = state.encoder_slots();
    tauri::async_runtime::spawn_blocking(move || {
        let _encoding_permit = encoder_slots.acquire();
        plan_gif_compression_blocking(request)
    })
    .await
    .map_err(|error| format!("GIF 压缩规划任务失败：{error}"))?
}

fn plan_gif_compression_blocking(
    request: GifCompressionRequest,
) -> Result<GifCompressionResult, String> {
    if request.target_bytes == 0 {
        return Err("targetBytes must be greater than zero".to_string());
    }
    let budget = request.max_candidates.unwrap_or(4).clamp(1, 8);
    let mut candidates = Vec::new();
    for index in 0..budget {
        let color_count = match index {
            0 => request.color_count,
            1 => (request.color_count / 2).max(MIN_COLOR_COUNT),
            _ => (request.color_count / 4).max(MIN_COLOR_COUNT),
        };
        let step = if index >= 2 { 2 } else { 1 };
        let frames = request
            .frames
            .iter()
            .cloned()
            .step_by(step)
            .collect::<Vec<_>>();
        let estimate = GifSizeEstimateRequest {
            width: if index >= 3 {
                (request.width / 2).max(1)
            } else {
                request.width
            },
            height: if index >= 3 {
                (request.height / 2).max(1)
            } else {
                request.height
            },
            loop_mode: request.loop_mode.clone(),
            loop_count: request.loop_count,
            encoding_speed: request.encoding_speed,
            color_count,
            dither_mode: request.dither_mode.clone(),
            frames,
        };
        let estimated_bytes = estimate_gif_size_blocking(estimate)?.bytes;
        candidates.push(GifCompressionCandidate {
            width: if index >= 3 {
                (request.width / 2).max(1)
            } else {
                request.width
            },
            height: if index >= 3 {
                (request.height / 2).max(1)
            } else {
                request.height
            },
            color_count,
            frame_count: if step == 1 {
                request.frames.len()
            } else {
                request.frames.len().div_ceil(step)
            },
            estimated_bytes,
            meets_target: estimated_bytes <= request.target_bytes,
        });
    }
    let selected = candidates
        .iter()
        .filter(|candidate| candidate.meets_target)
        .min_by_key(|candidate| candidate.estimated_bytes)
        .cloned();
    let reason = selected
        .is_none()
        .then(|| "目标体积在候选预算内不可达；返回最小候选供调用方决定".to_string());
    Ok(GifCompressionResult {
        target_bytes: request.target_bytes,
        selected,
        candidates,
        reason,
    })
}

#[tauri::command]
pub async fn pick_gif_sequence_output() -> Result<Option<String>, String> {
    sequence::pick_gif_sequence_output().await
}

#[tauri::command]
pub async fn export_png_sequence(
    state: State<'_, GifExportJobState>,
    request: sequence::PngSequenceExportRequest,
) -> Result<Vec<String>, String> {
    let job = state.register(
        request.job_id.as_deref(),
        "png-sequence",
        request.frames.len(),
    )?;
    let result = sequence::export_png_sequence(request, job.clone(), state.encoder_slots()).await;
    if let Some(job) = &job {
        match &result {
            Ok(output_paths) => job.finish_ok(output_paths.first().cloned().unwrap_or_default()),
            Err(error) => job.finish_error(error.clone()),
        }
    }
    result
}

#[tauri::command]
pub async fn estimate_png_sequence_size(
    state: State<'_, GifExportJobState>,
    request: sequence::PngSequenceExportRequest,
) -> Result<sequence::PngSequenceSizeEstimateResult, String> {
    sequence::estimate_png_sequence_size(request, state.encoder_slots()).await
}

#[tauri::command]
pub async fn pick_animation_output(
    format: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    animation::pick_animation_output(format, suggested_name).await
}

#[tauri::command]
pub async fn export_webp_animation(
    state: State<'_, GifExportJobState>,
    request: animation::AnimationExportRequest,
) -> Result<String, String> {
    let job = state.register(request.job_id.as_deref(), "webp", request.frames.len())?;
    let result =
        animation::export_webp_animation(request, job.clone(), state.encoder_slots()).await;
    if let Some(job) = &job {
        match &result {
            Ok(output_path) => job.finish_ok(output_path.clone()),
            Err(error) => job.finish_error(error.clone()),
        }
    }
    result
}

#[tauri::command]
pub async fn export_apng(
    state: State<'_, GifExportJobState>,
    request: animation::AnimationExportRequest,
) -> Result<String, String> {
    let job = state.register(request.job_id.as_deref(), "apng", request.frames.len())?;
    let result = animation::export_apng(request, job.clone(), state.encoder_slots()).await;
    if let Some(job) = &job {
        match &result {
            Ok(output_path) => job.finish_ok(output_path.clone()),
            Err(error) => job.finish_error(error.clone()),
        }
    }
    result
}

#[tauri::command]
pub async fn estimate_animation_size(
    state: State<'_, GifExportJobState>,
    format: String,
    request: animation::AnimationExportRequest,
) -> Result<animation::AnimationSizeEstimateResult, String> {
    animation::estimate_animation_size(format, request, state.encoder_slots()).await
}

pub fn export_gif_cli(request: GifExportRequest) -> Result<String, String> {
    export_gif_blocking_with_job(request, None)
}

#[cfg(test)]
fn export_gif_blocking(request: GifExportRequest) -> Result<String, String> {
    export_gif_cli(request)
}

fn export_gif_blocking_with_job(
    request: GifExportRequest,
    job: ExportJob,
) -> Result<String, String> {
    job_report(&job, "validating", 0);
    job_checkpoint(&job)?;
    validate_request(&request)?;
    let request = if request.target_bytes.is_some() {
        select_export_candidate(request, &job)?
    } else {
        request
    };
    let output_path = resolve_output_path(&request)?;
    job_report(&job, "encoding", 0);
    let publish_job = job.clone();
    let completed_job = job.clone();
    let completed_path = output_path.to_string_lossy().into_owned();
    storage::write_output_with_publish(
        &output_path,
        request.overwrite_existing,
        storage::MAX_OUTPUT_BYTES,
        |file| encode_gif_with_job(file, &request, &job),
        || job_checkpoint(&job),
        move || job_begin_publish(&publish_job),
        move || job_mark_published(&completed_job, completed_path),
    )?;
    Ok(output_path.to_string_lossy().into_owned())
}

fn select_export_candidate(
    request: GifExportRequest,
    job: &ExportJob,
) -> Result<GifExportRequest, String> {
    let target_bytes = request
        .target_bytes
        .ok_or_else(|| "targetBytes is required".to_string())?;
    job_checkpoint(job)?;
    let plan = plan_gif_compression_blocking(GifCompressionRequest {
        width: request.width,
        height: request.height,
        loop_mode: request.loop_mode.clone(),
        loop_count: request.loop_count,
        encoding_speed: request.encoding_speed,
        color_count: request.color_count,
        dither_mode: request.dither_mode.clone(),
        frames: request.frames.clone(),
        target_bytes,
        max_candidates: None,
    })?;
    let candidate = plan.selected.ok_or_else(|| {
        plan.reason
            .unwrap_or_else(|| "GIF 目标体积不可达".to_string())
    })?;
    job_checkpoint(job)?;
    let mut selected = request;
    selected.width = candidate.width;
    selected.height = candidate.height;
    selected.color_count = candidate.color_count;
    if candidate.frame_count < selected.frames.len() {
        selected.frames = selected.frames.into_iter().step_by(2).collect();
    }
    selected.target_bytes = None;
    Ok(selected)
}

fn estimate_gif_size_blocking(
    request: GifSizeEstimateRequest,
) -> Result<GifSizeEstimateResult, String> {
    let request = request.into();
    validate_request(&request)?;
    let mut output = Vec::new();
    encode_gif(&mut output, &request)?;
    Ok(GifSizeEstimateResult {
        bytes: output.len() as u64,
    })
}

fn encode_gif(writer: impl Write, request: &GifExportRequest) -> Result<(), String> {
    encode_gif_with_job(writer, request, &None)
}

fn encode_gif_with_job(
    writer: impl Write,
    request: &GifExportRequest,
    job: &ExportJob,
) -> Result<(), String> {
    let mut writer = storage::CheckedWriter::new(writer);
    {
        let mut encoder = Encoder::new(
            &mut writer,
            request.width as u16,
            request.height as u16,
            &[],
        )
        .map_err(|error| format!("无法创建 GIF 编码器：{error}"))?;
        let repeat = if request.loop_mode == "finite" {
            // NETSCAPE 的值是首次播放后的重复次数，保持与 gateway 契约一致。
            Repeat::Finite(request.loop_count)
        } else {
            Repeat::Infinite
        };
        encoder
            .set_repeat(repeat)
            .map_err(|error| format!("无法写入 GIF 循环设置：{error}"))?;

        for (index, frame) in request.frames.iter().enumerate() {
            job_checkpoint(job)?;
            let mut reader =
                ImageReader::with_format(Cursor::new(&frame.data), detect_format(&frame.data)?);
            reader.limits(decode_limits());
            let image = reader
                .decode()
                .map_err(|error| format!("无法读取 GIF 帧：{error}"))?;
            let image = if image.width() == request.width && image.height() == request.height {
                image.into_rgba8()
            } else {
                image
                    .resize_exact(request.width, request.height, FilterType::Lanczos3)
                    .into_rgba8()
            };
            let mut pixels = image.into_raw();
            let transparent_pixel = pixels
                .chunks_exact(4)
                .find(|pixel| pixel[3] == 0)
                .map(|pixel| [pixel[0], pixel[1], pixel[2], pixel[3]]);
            for pixel in pixels.chunks_exact_mut(4) {
                if pixel[3] != 0 {
                    pixel[3] = 255;
                }
            }
            let quantizer = NeuQuant::new(
                request.encoding_speed,
                request.color_count as usize,
                &pixels,
            );
            let indexed = pixels.as_slice();
            let dither_mode = dither::DitherMode::parse(&request.dither_mode)?;
            let indexed = if dither_mode == dither::DitherMode::None {
                indexed
                    .chunks_exact(4)
                    .map(|pixel| quantizer.index_of(pixel) as u8)
                    .collect()
            } else {
                dither::quantize_rgba(
                    indexed,
                    request.width,
                    request.height,
                    &quantizer.color_map_rgb(),
                    dither_mode,
                )
            };
            let mut gif_frame = GifFrame::from_palette_pixels(
                request.width as u16,
                request.height as u16,
                indexed,
                quantizer.color_map_rgb(),
                transparent_pixel.map(|pixel| quantizer.index_of(&pixel) as u8),
            );
            // 每帧从透明画布开始，避免透明像素被解码器与上一帧合成。
            gif_frame.dispose = DisposalMethod::Background;
            gif_frame.delay = (quantize_duration_ms(frame.duration_ms) / 10) as u16;
            encoder
                .write_frame(&gif_frame)
                .map_err(|error| format!("无法写入 GIF 帧：{error}"))?;
            job_report(job, "encoding", index + 1);
        }
    }
    job_checkpoint(job)?;
    writer
        .finish()
        .map_err(|error| format!("无法完成 GIF 文件写入：{error}"))
}

fn decode_limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_GIF_DIMENSION);
    limits.max_image_height = Some(MAX_GIF_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    limits
}

fn resolve_output_path(request: &GifExportRequest) -> Result<PathBuf, String> {
    storage::resolve_output_file_path(
        &request.output_path,
        request.output_location.as_deref(),
        request.source_path.as_deref(),
        request.output_subdirectory.as_deref(),
        request.output_directory.as_deref(),
        request.file_name.as_deref(),
        "gif",
    )
}

fn inspect_frame_dimensions(data: &[u8]) -> Result<(u32, u32), String> {
    let format = detect_format(data)?;
    if format == ImageFormat::WebP {
        return webp::inspect_dimensions(data);
    }
    if format == ImageFormat::Png {
        use image::{codecs::png::PngDecoder, ImageDecoder};
        return PngDecoder::with_limits(Cursor::new(data), decode_limits())
            .map(|decoder| decoder.dimensions())
            .map_err(|error| format!("无法读取 GIF 帧尺寸：{error}"));
    }
    ImageReader::with_format(Cursor::new(data), format)
        .into_dimensions()
        .map_err(|error| format!("无法读取 GIF 帧尺寸：{error}"))
}

fn validate_frame_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0
        || height == 0
        || width > MAX_GIF_DIMENSION
        || height > MAX_GIF_DIMENSION
        || u64::from(width).saturating_mul(u64::from(height)) > MAX_GIF_PIXELS
    {
        return Err("GIF 帧尺寸超出限制，最大为 4096 × 4096 且不超过 16 MP。".to_string());
    }
    Ok(())
}

fn quantize_duration_ms(duration_ms: u32) -> u32 {
    (duration_ms / 10).max(1) * 10
}

fn validate_request(request: &GifExportRequest) -> Result<(), String> {
    resolve_output_path(request)?;
    if request.width == 0
        || request.height == 0
        || request.width > MAX_GIF_DIMENSION
        || request.height > MAX_GIF_DIMENSION
        || (request.width as u64 * request.height as u64) > MAX_GIF_PIXELS
    {
        return Err("GIF 画布尺寸超出限制，最大为 4096 × 4096 且不超过 16 MP。".to_string());
    }
    if request.frames.is_empty() || request.frames.len() > MAX_GIF_FRAMES {
        return Err(format!("GIF 帧数必须在 1 到 {MAX_GIF_FRAMES} 之间。"));
    }
    if !(MIN_ENCODING_SPEED..=MAX_ENCODING_SPEED).contains(&request.encoding_speed) {
        return Err("GIF 编码速度必须在 1–30 之间。".to_string());
    }
    if !matches!(request.color_count, 2 | 16 | 32 | 64 | 128 | 256)
        || !(MIN_COLOR_COUNT..=MAX_COLOR_COUNT).contains(&request.color_count)
    {
        return Err("GIF 颜色数量必须为 2、16、32、64、128 或 256。".to_string());
    }
    let canvas_pixels = u64::from(request.width).saturating_mul(u64::from(request.height));
    if canvas_pixels.saturating_mul(request.frames.len() as u64) > MAX_TOTAL_GIF_PIXELS {
        return Err("GIF 所有帧的累计画布像素超过限制。".to_string());
    }
    request.frames.iter().try_fold(0usize, |total, frame| {
        if frame.data.is_empty() || frame.data.len() > MAX_FRAME_BYTES {
            return Err("单帧图片不能为空且不能超过 32 MiB。".to_string());
        }
        if !(MIN_FRAME_DURATION_MS..=MAX_FRAME_DURATION_MS).contains(&frame.duration_ms) {
            return Err("帧时长必须在 10 到 60000 毫秒之间。".to_string());
        }
        total
            .checked_add(frame.data.len())
            .filter(|value| *value <= MAX_TOTAL_FRAME_BYTES)
            .ok_or_else(|| "GIF 所有帧的图片数据不能超过 128 MiB。".to_string())
    })?;
    if request.loop_mode != "infinite" && request.loop_mode != "finite" {
        return Err("GIF 循环模式无效。".to_string());
    }
    if request.loop_mode == "finite" && request.loop_count == 0 {
        return Err("有限循环次数必须大于 0。".to_string());
    }
    let mut source_pixels = 0u64;
    for (index, frame) in request.frames.iter().enumerate() {
        let (width, height) = inspect_frame_dimensions(&frame.data)
            .map_err(|error| format!("第 {} 帧：{error}", index + 1))?;
        validate_frame_dimensions(width, height)?;
        source_pixels += u64::from(width) * u64::from(height);
        if source_pixels > MAX_TOTAL_GIF_PIXELS {
            return Err("GIF 所有帧的累计源图片像素超过限制。".to_string());
        }
    }
    Ok(())
}

fn detect_format(data: &[u8]) -> Result<ImageFormat, String> {
    image::guess_format(data).map_err(|error| format!("无法识别图片格式：{error}"))
}

fn normalize_suggested_name(value: &str) -> String {
    let name = value.trim();
    let name = if name.is_empty() {
        "animation.gif"
    } else {
        name
    };
    let name = Path::new(name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("animation.gif");
    if name.to_ascii_lowercase().ends_with(".gif") {
        name.to_string()
    } else {
        format!("{name}.gif")
    }
}
