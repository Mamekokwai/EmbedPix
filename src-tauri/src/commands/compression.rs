use std::{
    collections::HashMap,
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};

use gif::DecodeOptions;
use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, io::Reader as ImageReader, DynamicImage,
    GenericImageView, ImageBuffer, ImageFormat, Rgb, RgbImage,
};
use jpeg_encoder::{ColorType as JpegColorType, Encoder as RustJpegEncoder};
use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{InvokeBody, Request},
    State,
};

use super::{
    export_image::{write_exported_file, WriteOptions},
    image_orientation::normalize_jpeg_orientation,
    path_security,
    webp_metadata::{apply_strip_safe as apply_webp_strip_safe, extract_static_icc},
    webp_static::{
        encode_lossless_rgba_with_method, encode_lossy_rgba,
        encode_lossy_rgba_with_method_and_alpha_quality, encode_near_lossless_rgba,
    },
};

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 128 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 8_192;
const MAX_IMAGE_PIXELS: u64 = 16_777_216;
const MAX_DECODER_ALLOC_BYTES: u64 = 128 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 64 * 1024;
const MAX_JPEG_ICC_SEGMENTS: u8 = 16;
const MAX_JPEG_ICC_CHUNK_BYTES: usize = 65_519;
const MAX_JPEG_ICC_BYTES: usize = MAX_JPEG_ICC_SEGMENTS as usize * MAX_JPEG_ICC_CHUNK_BYTES;
const MAX_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_MAX_CANDIDATES: usize = 8;
const MAX_CANDIDATES: usize = 12;
const AUTO_RESIZE_PERCENT_CANDIDATES: [u8; 5] = [100, 75, 50, 25, 10];
const MIN_TARGET_RESIZE_PERCENT: u8 = 10;
const MAX_TARGET_RESIZE_PERCENT: u8 = 100;
const MAX_AUTO_RENAME_ATTEMPTS: usize = 10_000;
const PREFLIGHT_SPACE_ERROR_CODE: &str = "[preflight_output_space_insufficient]";
const JOB_RETENTION: Duration = Duration::from_secs(5 * 60);
const MAX_COMPRESSION_CONCURRENCY: usize = 2;
const MAX_ACTIVE_COMPRESSION_JOBS: usize = MAX_COMPRESSION_CONCURRENCY * 4;
const COMPRESSION_SCHEMA_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CompressionStage {
    Queued,
    Preflight,
    Reading,
    Decoding,
    Planning,
    Encoding,
    Validating,
    Publishing,
    Completed,
    Skipped,
    Cancelling,
    Cancelled,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CompressionErrorCode {
    Skipped,
    Cancelled,
    MetadataPolicyUnsupported,
    Decode,
    Publish,
    Encode,
}

impl CompressionErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Skipped => "skipped",
            Self::Cancelled => "cancelled",
            Self::MetadataPolicyUnsupported => "metadata_policy_unsupported",
            Self::Decode => "decode",
            Self::Publish => "publish",
            Self::Encode => "encode",
        }
    }
}

impl CompressionStage {
    fn from_status(status: &str) -> Self {
        match status {
            "skipped" => Self::Skipped,
            "completed" => Self::Completed,
            _ => Self::Failed,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Preflight => "preflight",
            Self::Reading => "reading",
            Self::Decoding => "decoding",
            Self::Planning => "planning",
            Self::Encoding => "encoding",
            Self::Validating => "validating",
            Self::Publishing => "publishing",
            Self::Completed => "completed",
            Self::Skipped => "skipped",
            Self::Cancelling => "cancelling",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Skipped | Self::Cancelled | Self::Failed
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum CompressionFormat {
    Png,
    Jpeg,
    Webp,
}

impl CompressionFormat {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "png" => Ok(Self::Png),
            "jpg" | "jpeg" => Ok(Self::Jpeg),
            "webp" => Ok(Self::Webp),
            other => Err(format!(
                "unsupported compression format `{other}`; expected png, jpeg, or webp"
            )),
        }
    }
    fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpeg",
            Self::Webp => "webp",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CompressionMode {
    Lossless,
    Lossy,
}

impl CompressionMode {
    fn from_lossless(lossless: bool) -> Self {
        if lossless {
            Self::Lossless
        } else {
            Self::Lossy
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Lossless => "lossless",
            Self::Lossy => "lossy",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CompressionEngine {
    OxiPng,
    ImageJpeg,
    RustJpeg,
    LibWebp,
}

impl CompressionEngine {
    fn for_format(format: CompressionFormat) -> Self {
        match format {
            CompressionFormat::Png => Self::OxiPng,
            CompressionFormat::Jpeg => Self::ImageJpeg,
            CompressionFormat::Webp => Self::LibWebp,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::OxiPng => "oxipng",
            Self::ImageJpeg => "image-jpeg",
            Self::RustJpeg => "jpeg-encoder",
            Self::LibWebp => "libwebp",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
enum MetadataPolicy {
    #[default]
    Strip,
    Preserve,
    #[serde(rename = "stripSafe")]
    StripSafe,
    #[serde(rename = "stripAll", alias = "strip-all")]
    StripAll,
}

impl MetadataPolicy {
    fn as_str(self) -> &'static str {
        match self {
            Self::Strip => "strip",
            Self::Preserve => "preserve",
            Self::StripSafe => "strip-safe",
            Self::StripAll => "stripAll",
        }
    }
}

fn validate_compression_metadata_policy(policy: MetadataPolicy) -> Result<(), String> {
    match policy {
        MetadataPolicy::Strip => Ok(()),
        MetadataPolicy::Preserve => Err(
            "metadataPolicy=preserve is not supported by first-stage compression; use strip".into(),
        ),
        MetadataPolicy::StripSafe => Ok(()),
        MetadataPolicy::StripAll => Ok(()),
    }
}

fn validate_png_optimize_alpha(enabled: bool, format: CompressionFormat) -> Result<(), String> {
    if enabled && format != CompressionFormat::Png {
        return Err("pngOptimizeAlpha is only supported for PNG output; it may change RGB values of fully transparent pixels".into());
    }
    Ok(())
}

fn validate_jpeg_options(
    progressive: bool,
    optimize_huffman: bool,
    format: CompressionFormat,
) -> Result<(), String> {
    if (progressive || optimize_huffman) && format != CompressionFormat::Jpeg {
        return Err(
            "jpegProgressive and jpegOptimizeHuffman are only supported for JPEG output".into(),
        );
    }
    Ok(())
}

fn validate_png_strip_safe(
    policy: MetadataPolicy,
    format: CompressionFormat,
    input: &[u8],
) -> Result<(), String> {
    let supported = match format {
        CompressionFormat::Png => input.starts_with(b"\x89PNG\r\n\x1a\n"),
        CompressionFormat::Jpeg => input.starts_with(&[0xff, 0xd8]),
        CompressionFormat::Webp => input.starts_with(b"RIFF") && input.get(8..12) == Some(b"WEBP"),
    };
    if policy == MetadataPolicy::StripSafe && !supported {
        return Err(
            "metadataPolicy=stripSafe is only supported for static PNG, JPEG, or WebP input to the same output format".into(),
        );
    }
    if policy == MetadataPolicy::StripSafe && format == CompressionFormat::Webp {
        extract_static_icc(input)?;
    }
    Ok(())
}

fn extract_jpeg_icc_profile(input: &[u8]) -> Result<Option<Vec<u8>>, String> {
    if input.len() < 4 || input[..2] != [0xff, 0xd8] {
        return Err("stripSafe JPEG input is missing a valid SOI marker".into());
    }
    let mut offset = 2usize;
    let mut icc_parts: Option<(u8, Vec<Option<Vec<u8>>>)> = None;
    let mut saw_eoi = false;
    while offset < input.len() {
        if input[offset] != 0xff {
            return Err("stripSafe JPEG input has an invalid marker prefix".into());
        }
        while offset < input.len() && input[offset] == 0xff {
            offset += 1;
        }
        let marker = *input
            .get(offset)
            .ok_or_else(|| "stripSafe JPEG input ends inside a marker".to_string())?;
        offset += 1;
        if marker == 0xd9 {
            if offset != input.len() {
                return Err("stripSafe JPEG input has trailing bytes after EOI".into());
            }
            saw_eoi = true;
            break;
        }
        if marker == 0xda {
            let length = jpeg_segment_end(input, offset)?;
            offset = length;
            loop {
                let byte = *input
                    .get(offset)
                    .ok_or_else(|| "stripSafe JPEG input truncates scan data".to_string())?;
                offset += 1;
                if byte != 0xff {
                    continue;
                }
                while input.get(offset) == Some(&0xff) {
                    offset += 1;
                }
                let scan_marker = *input
                    .get(offset)
                    .ok_or_else(|| "stripSafe JPEG input truncates scan marker".to_string())?;
                if scan_marker == 0x00 || (0xd0..=0xd7).contains(&scan_marker) {
                    offset += 1;
                    continue;
                }
                offset -= 1;
                break;
            }
            continue;
        }
        if marker == 0x00 || marker == 0xd8 || (0xd0..=0xd7).contains(&marker) {
            return Err("stripSafe JPEG input has an invalid standalone marker".into());
        }
        let segment_start = offset;
        let segment_end = jpeg_segment_end(input, offset)?;
        let payload = &input[segment_start + 2..segment_end];
        if marker == 0xe2 && payload.starts_with(b"ICC_PROFILE\0") {
            if payload.len() < 14 {
                return Err("stripSafe JPEG ICC profile segment is truncated".into());
            }
            let sequence = payload[12];
            let count = payload[13];
            if count == 0 || count > MAX_JPEG_ICC_SEGMENTS || sequence == 0 || sequence > count {
                return Err("stripSafe JPEG ICC profile sequence is invalid".into());
            }
            let (expected_count, parts) =
                icc_parts.get_or_insert_with(|| (count, vec![None; count as usize]));
            if *expected_count != count || parts[sequence as usize - 1].is_some() {
                return Err(
                    "stripSafe JPEG ICC profile has duplicate or inconsistent segments".into(),
                );
            }
            parts[sequence as usize - 1] = Some(payload[14..].to_vec());
        }
        offset = segment_end;
    }
    if !saw_eoi {
        return Err("stripSafe JPEG input is missing an EOI marker".into());
    }
    let Some((_, parts)) = icc_parts else {
        return Ok(None);
    };
    let mut profile = Vec::new();
    for part in parts {
        profile.extend(part.ok_or_else(|| "stripSafe JPEG ICC profile is incomplete".to_string())?);
        if profile.len() > MAX_JPEG_ICC_BYTES {
            return Err("stripSafe JPEG ICC profile is too large".into());
        }
    }
    if profile.is_empty() {
        return Err("stripSafe JPEG ICC profile is empty".into());
    }
    Ok(Some(profile))
}

fn jpeg_segment_end(input: &[u8], offset: usize) -> Result<usize, String> {
    let length = u16::from_be_bytes(
        input
            .get(offset..offset + 2)
            .ok_or_else(|| "stripSafe JPEG input truncates a segment length".to_string())?
            .try_into()
            .expect("segment length is exactly two bytes"),
    ) as usize;
    if length < 2 {
        return Err("stripSafe JPEG input has an invalid segment length".into());
    }
    offset
        .checked_add(length)
        .filter(|end| *end <= input.len())
        .ok_or_else(|| "stripSafe JPEG input truncates a segment".to_string())
}

fn inject_jpeg_icc_profile(output: &[u8], profile: &[u8]) -> Result<Vec<u8>, String> {
    if output.len() < 2 || output[..2] != [0xff, 0xd8] {
        return Err("stripSafe JPEG output is missing a valid SOI marker".into());
    }
    if profile.len() > MAX_JPEG_ICC_BYTES {
        return Err("stripSafe JPEG ICC profile is too large".into());
    }
    let chunks = profile.chunks(MAX_JPEG_ICC_CHUNK_BYTES).collect::<Vec<_>>();
    if chunks.len() > MAX_JPEG_ICC_SEGMENTS as usize {
        return Err("stripSafe JPEG ICC profile requires too many segments".into());
    }
    let mut result = Vec::with_capacity(output.len() + profile.len() + chunks.len() * 16);
    result.extend_from_slice(&output[..2]);
    for (index, chunk) in chunks.iter().enumerate() {
        let length = u16::try_from(2 + 14 + chunk.len())
            .map_err(|_| "stripSafe JPEG ICC profile segment is too large".to_string())?;
        result.extend_from_slice(&[0xff, 0xe2]);
        result.extend_from_slice(&length.to_be_bytes());
        result.extend_from_slice(b"ICC_PROFILE\0");
        result.push((index + 1) as u8);
        result.push(chunks.len() as u8);
        result.extend_from_slice(chunk);
    }
    result.extend_from_slice(&output[2..]);
    Ok(result)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompressionMetadata {
    #[serde(default = "default_compression_schema_version")]
    schema_version: u8,
    file_name: String,
    #[serde(default)]
    output_file_name: Option<String>,
    output_format: String,
    #[serde(default)]
    output_path: Option<String>,
    #[serde(default)]
    output_location: Option<String>,
    #[serde(default)]
    source_path: Option<String>,
    #[serde(default)]
    output_directory: Option<String>,
    #[serde(default)]
    output_subdirectory: Option<String>,
    #[serde(default)]
    overwrite_existing: bool,
    #[serde(default)]
    replace_original: bool,
    #[serde(default)]
    delete_source: bool,
    #[serde(default)]
    auto_sequence: bool,
    #[serde(default)]
    auto_rename: bool,
    #[serde(default)]
    jpeg_quality: Option<u8>,
    #[serde(default)]
    jpeg_background: Option<String>,
    #[serde(default)]
    jpeg_progressive: bool,
    #[serde(default)]
    jpeg_optimize_huffman: bool,
    #[serde(default)]
    webp_method: Option<u8>,
    #[serde(default)]
    webp_alpha_quality: Option<u8>,
    #[serde(default)]
    webp_pass: Option<u8>,
    #[serde(default)]
    webp_near_lossless: Option<u8>,
    #[serde(default)]
    webp_lossless_method: Option<u8>,
    #[serde(default)]
    lossless: Option<bool>,
    #[serde(default = "default_skip_if_larger")]
    skip_if_larger: bool,
    #[serde(default)]
    max_output_bytes: Option<u64>,
    #[serde(default)]
    max_candidates: Option<usize>,
    #[serde(default)]
    max_rgb_mae: Option<f64>,
    #[serde(default)]
    target_resize_percent: Option<u8>,
    #[serde(default)]
    auto_resize_to_target: bool,
    #[serde(default)]
    max_input_bytes: Option<u64>,
    #[serde(default)]
    png_optimization_level: Option<u8>,
    #[serde(default)]
    png_optimize_alpha: bool,
    #[serde(default)]
    metadata_policy: MetadataPolicy,
    #[serde(default)]
    job_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompressionEstimateMetadata {
    #[serde(default = "default_compression_schema_version")]
    schema_version: u8,
    file_name: String,
    output_format: String,
    #[serde(default)]
    jpeg_quality: Option<u8>,
    #[serde(default)]
    jpeg_background: Option<String>,
    #[serde(default)]
    jpeg_progressive: bool,
    #[serde(default)]
    jpeg_optimize_huffman: bool,
    #[serde(default)]
    webp_method: Option<u8>,
    #[serde(default)]
    webp_alpha_quality: Option<u8>,
    #[serde(default)]
    webp_pass: Option<u8>,
    #[serde(default)]
    webp_near_lossless: Option<u8>,
    #[serde(default)]
    webp_lossless_method: Option<u8>,
    #[serde(default)]
    lossless: Option<bool>,
    #[serde(default = "default_skip_if_larger")]
    skip_if_larger: bool,
    #[serde(default)]
    max_output_bytes: Option<u64>,
    #[serde(default)]
    max_candidates: Option<usize>,
    #[serde(default)]
    max_rgb_mae: Option<f64>,
    #[serde(default)]
    target_resize_percent: Option<u8>,
    #[serde(default)]
    auto_resize_to_target: bool,
    #[serde(default)]
    max_input_bytes: Option<u64>,
    #[serde(default)]
    png_optimization_level: Option<u8>,
    #[serde(default)]
    png_optimize_alpha: bool,
    #[serde(default)]
    metadata_policy: MetadataPolicy,
}

#[derive(Debug, Clone)]
struct CompressionRequest {
    metadata: CompressionMetadata,
    input: Vec<u8>,
    format: CompressionFormat,
    lossless: bool,
    target_bytes: Option<u64>,
    max_candidates: usize,
    png_optimization_level: u8,
    png_optimize_alpha: bool,
}

#[derive(Clone, Copy, Debug, Default)]
struct JpegEncodingOptions {
    progressive: bool,
    optimize_huffman: bool,
}

impl CompressionRequest {
    fn jpeg_options(&self) -> JpegEncodingOptions {
        JpegEncodingOptions {
            progressive: self.metadata.jpeg_progressive,
            optimize_huffman: self.metadata.jpeg_optimize_huffman,
        }
    }

    fn compression_engine(&self) -> CompressionEngine {
        if self.format == CompressionFormat::Jpeg
            && (self.metadata.jpeg_progressive || self.metadata.jpeg_optimize_huffman)
        {
            CompressionEngine::RustJpeg
        } else {
            CompressionEngine::for_format(self.format)
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionProgress {
    pub job_id: String,
    pub status: String,
    pub stage: String,
    pub output_path: Option<String>,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_bytes: Option<u64>,
}

pub struct CompressionJobState {
    jobs: Mutex<HashMap<String, Arc<CompressionJob>>>,
    encoder_slots: Arc<CompressionSemaphore>,
}

struct CompressionSemaphore {
    available: Mutex<usize>,
    wake: Condvar,
}

struct CompressionPermit {
    semaphore: Arc<CompressionSemaphore>,
}

struct CompressionJob {
    cancelled: AtomicBool,
    progress: Mutex<CompressionProgress>,
    terminal_at: Mutex<Option<Instant>>,
}

impl Default for CompressionJobState {
    fn default() -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            encoder_slots: Arc::new(CompressionSemaphore {
                available: Mutex::new(MAX_COMPRESSION_CONCURRENCY),
                wake: Condvar::new(),
            }),
        }
    }
}

impl Drop for CompressionJobState {
    fn drop(&mut self) {
        let jobs = match self.jobs.get_mut() {
            Ok(jobs) => jobs,
            Err(poisoned) => poisoned.into_inner(),
        };
        for job in jobs.values() {
            let _ = cancel_job(job);
        }
    }
}

impl CompressionSemaphore {
    fn acquire(self: &Arc<Self>) -> CompressionPermit {
        let mut available = self
            .available
            .lock()
            .expect("compression semaphore poisoned");
        while *available == 0 {
            available = self
                .wake
                .wait(available)
                .expect("compression semaphore poisoned");
        }
        *available -= 1;
        CompressionPermit {
            semaphore: Arc::clone(self),
        }
    }

    fn acquire_cancellable(
        self: &Arc<Self>,
        job: &Arc<CompressionJob>,
    ) -> Result<CompressionPermit, String> {
        let mut available = self
            .available
            .lock()
            .map_err(|_| "compression semaphore is unavailable".to_string())?;
        let mut announced_queued = false;
        while *available == 0 {
            if !announced_queued {
                update_progress(job, CompressionStage::Queued, None, None);
                announced_queued = true;
            }
            if job.cancelled.load(Ordering::Acquire) {
                return Err(fail_message(job, "compression cancelled".to_string()));
            }
            let (next, _) = self
                .wake
                .wait_timeout(available, Duration::from_millis(50))
                .map_err(|_| "compression semaphore is unavailable".to_string())?;
            available = next;
        }
        *available -= 1;
        if job.cancelled.load(Ordering::Acquire) {
            *available += 1;
            self.wake.notify_one();
            return Err(fail_message(job, "compression cancelled".to_string()));
        }
        Ok(CompressionPermit {
            semaphore: Arc::clone(self),
        })
    }
}

impl Drop for CompressionPermit {
    fn drop(&mut self) {
        if let Ok(mut available) = self.semaphore.available.lock() {
            *available += 1;
            self.semaphore.wake.notify_one();
        }
    }
}

fn run_with_encoder_slot<T>(semaphore: Arc<CompressionSemaphore>, task: impl FnOnce() -> T) -> T {
    let _permit = semaphore.acquire();
    task()
}

impl CompressionJobState {
    fn register(&self, job_id: String, job: Arc<CompressionJob>) -> Result<(), String> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| "compression job state is unavailable".to_string())?;
        if let Some(existing) = jobs.get(&job_id) {
            let active = existing
                .progress
                .lock()
                .map(|progress| matches!(progress.status.as_str(), "running" | "cancelling"))
                .unwrap_or(true);
            if active {
                return Err("compression job id is already active".to_string());
            }
        }
        let active_jobs = jobs
            .values()
            .filter(|existing| {
                existing
                    .progress
                    .lock()
                    .map(|progress| matches!(progress.status.as_str(), "running" | "cancelling"))
                    .unwrap_or(true)
            })
            .count();
        if active_jobs >= MAX_ACTIVE_COMPRESSION_JOBS {
            return Err(
                "too many compression jobs are in progress; retry after an active job finishes"
                    .to_string(),
            );
        }
        jobs.insert(job_id, job);
        Ok(())
    }

    fn prune(&self) {
        let now = Instant::now();
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.retain(|_, job| {
                job.terminal_at
                    .lock()
                    .ok()
                    .and_then(|value| *value)
                    .is_none_or(|finished| now.duration_since(finished) < JOB_RETENTION)
            });
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionResult {
    pub job_id: String,
    pub output_path: String,
    pub status: String,
    pub skipped_reason: Option<String>,
    pub input_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_input_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prepared_input_bytes: Option<u64>,
    pub output_bytes: u64,
    pub saved_bytes: i64,
    pub savings_percent: f64,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub lossless: bool,
    pub compression_mode: &'static str,
    pub compression_engine: &'static str,
    pub metadata_policy: &'static str,
    pub source_deleted: bool,
    pub target_bytes: Option<u64>,
    pub target_met: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_resize_percent: Option<u8>,
    pub auto_resize_to_target: bool,
    pub selected_quality: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_search_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_count: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_rgb_mae: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality_metrics: Option<CompressionQualityMetrics>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionPreflight {
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub input_bytes: u64,
    pub output_path: String,
    pub overwrites_existing: bool,
    pub lossless: bool,
    pub compression_mode: &'static str,
    pub compression_engine: &'static str,
    pub auto_resize_to_target: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resize_candidate_count: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_prepared_input_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_encoded_candidate_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_pixels: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_space_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionPreview {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub output_bytes: u64,
    pub lossless: bool,
    pub compression_mode: &'static str,
    pub compression_engine: &'static str,
    pub metadata_policy: &'static str,
    pub status: String,
    pub skipped_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_input_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prepared_input_bytes: Option<u64>,
    pub target_bytes: Option<u64>,
    pub target_met: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_resize_percent: Option<u8>,
    pub auto_resize_to_target: bool,
    pub selected_quality: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_search_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_count: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_rgb_mae: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality_metrics: Option<CompressionQualityMetrics>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionQualityMetrics {
    pub rgb_mae: f64,
    pub psnr_db: Option<f64>,
    pub alpha_mismatch_pixels: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionEstimate {
    pub input_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_input_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prepared_input_bytes: Option<u64>,
    pub output_bytes: u64,
    pub saved_bytes: i64,
    pub savings_percent: f64,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub lossless: bool,
    pub compression_mode: &'static str,
    pub compression_engine: &'static str,
    pub metadata_policy: &'static str,
    pub status: String,
    pub skipped_reason: Option<String>,
    pub target_bytes: Option<u64>,
    pub target_met: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_resize_percent: Option<u8>,
    pub auto_resize_to_target: bool,
    pub selected_quality: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_search_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_count: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_rgb_mae: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality_metrics: Option<CompressionQualityMetrics>,
}

#[tauri::command(rename_all = "camelCase")]
pub async fn preflight_compression(request: Request<'_>) -> Result<CompressionPreflight, String> {
    let request = parse_request(request)?;
    let (source_width, source_height) = inspect_image(&request.input)?;
    let (width, height) = resized_dimensions(
        source_width,
        source_height,
        request.metadata.target_resize_percent,
    );
    let output_path = resolve_preflight_output_path(&request)?;
    let required_space_bytes = estimate_preflight_required_space(&request);
    ensure_preflight_available_space(&output_path, required_space_bytes)?;
    Ok(CompressionPreflight {
        format: request.format.name().to_string(),
        width,
        height,
        input_bytes: request.input.len() as u64,
        overwrites_existing: output_path.exists(),
        lossless: request.lossless,
        compression_mode: CompressionMode::from_lossless(request.lossless).as_str(),
        compression_engine: request.compression_engine().as_str(),
        auto_resize_to_target: request.metadata.auto_resize_to_target,
        resize_candidate_count: request.metadata.auto_resize_to_target.then_some(
            AUTO_RESIZE_PERCENT_CANDIDATES
                .len()
                .min(request.max_candidates) as u8,
        ),
        max_prepared_input_bytes: request.metadata.auto_resize_to_target.then_some(
            request
                .metadata
                .max_input_bytes
                .unwrap_or(MAX_INPUT_BYTES as u64),
        ),
        max_encoded_candidate_bytes: request
            .metadata
            .auto_resize_to_target
            .then_some(MAX_OUTPUT_BYTES as u64),
        max_pixels: request
            .metadata
            .auto_resize_to_target
            .then_some(u64::from(source_width).saturating_mul(u64::from(source_height))),
        output_path: output_path.to_string_lossy().into_owned(),
        required_space_bytes,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn preview_compression(
    request: Request<'_>,
    state: State<'_, CompressionJobState>,
) -> Result<CompressionPreview, String> {
    let request = parse_request(request)?;
    state.prune();
    let job_id = request
        .metadata
        .job_id
        .clone()
        .unwrap_or_else(|| format!("compression-preview-{}", uuid_like_id()));
    let job = Arc::new(CompressionJob {
        cancelled: AtomicBool::new(false),
        progress: Mutex::new(CompressionProgress {
            job_id: job_id.clone(),
            status: "running".into(),
            stage: CompressionStage::Preflight.as_str().into(),
            output_path: None,
            error: None,
            code: None,
            input_bytes: Some(request.input.len() as u64),
            output_bytes: None,
        }),
        terminal_at: Mutex::new(None),
    });
    state.register(job_id, Arc::clone(&job))?;
    let encoder_slots = Arc::clone(&state.encoder_slots);
    let job_for_task = Arc::clone(&job);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _permit = encoder_slots.acquire_cancellable(&job_for_task)?;
        run_preview_with_cancellation(&request, &job_for_task)
    })
    .await
    .map_err(|error| {
        let message = format!("compression preview task failed: {error}");
        fail_message(&job, message.clone());
        message
    })?;
    match result {
        Ok(preview) => {
            update_progress(
                &job,
                CompressionStage::from_status(&preview.status),
                None,
                None,
            );
            Ok(preview)
        }
        Err(error) => Err(fail_message(&job, error)),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn estimate_image_compression(
    request: Request<'_>,
    state: State<'_, CompressionJobState>,
) -> Result<CompressionEstimate, String> {
    let request = parse_estimate_request(request)?;
    let encoder_slots = Arc::clone(&state.encoder_slots);
    tauri::async_runtime::spawn_blocking(move || {
        run_with_encoder_slot(encoder_slots, || run_estimate(&request))
    })
    .await
    .map_err(|error| format!("compression estimate task failed: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn compress_image(
    request: Request<'_>,
    state: State<'_, CompressionJobState>,
) -> Result<CompressionResult, String> {
    let request = parse_request(request)?;
    state.prune();
    let job_id = request
        .metadata
        .job_id
        .clone()
        .unwrap_or_else(|| format!("compression-{}", uuid_like_id()));
    let job = Arc::new(CompressionJob {
        cancelled: AtomicBool::new(false),
        progress: Mutex::new(CompressionProgress {
            job_id: job_id.clone(),
            status: "running".into(),
            stage: CompressionStage::Preflight.as_str().into(),
            output_path: None,
            error: None,
            code: None,
            input_bytes: Some(request.input.len() as u64),
            output_bytes: None,
        }),
        terminal_at: Mutex::new(None),
    });
    state.register(job_id.clone(), Arc::clone(&job))?;
    let encoder_slots = Arc::clone(&state.encoder_slots);
    let job_for_task = Arc::clone(&job);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _permit = encoder_slots.acquire_cancellable(&job_for_task)?;
        run_compression(&request, &job_for_task)
    })
    .await
    .map_err(|error| {
        let message = format!("compression task failed: {error}");
        fail_message(&job, message.clone());
        message
    })?;
    state.prune();
    result
}

/// Runs the same validated compression core for the standalone CLI.
pub fn compress_file_cli(
    input_path: &Path,
    output_path: &Path,
    format: &str,
    quality: u8,
    max_input_bytes: Option<u64>,
) -> Result<CompressionResult, String> {
    compress_file_cli_with_jpeg_options(
        input_path,
        output_path,
        format,
        quality,
        max_input_bytes,
        false,
        false,
    )
}

/// Runs the CLI compression path with optional JPEG scan/Huffman controls.
pub fn compress_file_cli_with_jpeg_options(
    input_path: &Path,
    output_path: &Path,
    format: &str,
    quality: u8,
    max_input_bytes: Option<u64>,
    jpeg_progressive: bool,
    jpeg_optimize_huffman: bool,
) -> Result<CompressionResult, String> {
    compress_file_cli_with_advanced_options(
        input_path,
        output_path,
        format,
        quality,
        max_input_bytes,
        None,
        jpeg_progressive,
        jpeg_optimize_huffman,
        format.eq_ignore_ascii_case("png"),
        None,
        None,
        false,
    )
}

/// Runs the CLI compression path with JPEG controls and optional lossless WebP method.
#[allow(clippy::too_many_arguments)]
pub fn compress_file_cli_with_advanced_options(
    input_path: &Path,
    output_path: &Path,
    format: &str,
    quality: u8,
    max_input_bytes: Option<u64>,
    max_output_bytes: Option<u64>,
    jpeg_progressive: bool,
    jpeg_optimize_huffman: bool,
    lossless: bool,
    webp_lossless_method: Option<u8>,
    target_resize_percent: Option<u8>,
    auto_resize_to_target: bool,
) -> Result<CompressionResult, String> {
    compress_file_cli_with_quality_threshold(
        input_path,
        output_path,
        format,
        quality,
        max_input_bytes,
        max_output_bytes,
        jpeg_progressive,
        jpeg_optimize_huffman,
        lossless,
        webp_lossless_method,
        target_resize_percent,
        auto_resize_to_target,
        None,
        None,
    )
}

/// Runs the CLI compression path with an optional lossy quality threshold.
#[allow(clippy::too_many_arguments)]
pub fn compress_file_cli_with_quality_threshold(
    input_path: &Path,
    output_path: &Path,
    format: &str,
    quality: u8,
    max_input_bytes: Option<u64>,
    max_output_bytes: Option<u64>,
    jpeg_progressive: bool,
    jpeg_optimize_huffman: bool,
    lossless: bool,
    webp_lossless_method: Option<u8>,
    target_resize_percent: Option<u8>,
    auto_resize_to_target: bool,
    jpeg_background: Option<&str>,
    max_rgb_mae: Option<f64>,
) -> Result<CompressionResult, String> {
    let input =
        fs::read(input_path).map_err(|error| format!("failed to read input image: {error}"))?;
    let metadata = serde_json::json!({
        "fileName": output_path.file_name().and_then(|value| value.to_str()).unwrap_or("output"),
        "outputFormat": format,
        "outputPath": output_path,
        "outputLocation": "path",
        "sourcePath": input_path,
        "overwriteExisting": false,
        "jpegQuality": quality,
        "lossless": lossless,
        "skipIfLarger": false,
        "maxInputBytes": max_input_bytes,
        "maxOutputBytes": max_output_bytes,
        "metadataPolicy": "strip",
        "jpegProgressive": jpeg_progressive,
        "jpegOptimizeHuffman": jpeg_optimize_huffman,
        "webpLosslessMethod": webp_lossless_method,
        "targetResizePercent": target_resize_percent,
        "autoResizeToTarget": auto_resize_to_target,
        "jpegBackground": jpeg_background,
        "maxRgbMae": max_rgb_mae,
    });
    let metadata = serde_json::to_vec(&metadata).map_err(|error| error.to_string())?;
    let mut payload = b"EGF1".to_vec();
    payload.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
    payload.extend_from_slice(&metadata);
    payload.extend_from_slice(&input);
    let request = parse_raw_payload(&payload)?;
    let job_id = format!("compression-cli-{}", uuid_like_id());
    let job = Arc::new(CompressionJob {
        cancelled: AtomicBool::new(false),
        progress: Mutex::new(CompressionProgress {
            job_id,
            status: "running".into(),
            stage: CompressionStage::Preflight.as_str().into(),
            output_path: None,
            error: None,
            code: None,
            input_bytes: Some(request.input.len() as u64),
            output_bytes: None,
        }),
        terminal_at: Mutex::new(None),
    });
    let state = CompressionJobState::default();
    let _permit = state.encoder_slots.acquire();
    run_compression(&request, &job)
}

#[tauri::command(rename_all = "camelCase")]
pub fn cancel_compression(
    job_id: String,
    state: State<'_, CompressionJobState>,
) -> Result<CompressionProgress, String> {
    state.prune();
    let job = state
        .jobs
        .lock()
        .map_err(|_| "compression job state is unavailable".to_string())?
        .get(&job_id)
        .cloned()
        .ok_or_else(|| "compression job not found".to_string())?;
    cancel_job(&job)
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_compression_progress(
    job_id: String,
    state: State<'_, CompressionJobState>,
) -> Result<CompressionProgress, String> {
    state.prune();
    let job = state
        .jobs
        .lock()
        .map_err(|_| "compression job state is unavailable".to_string())?
        .get(&job_id)
        .cloned()
        .ok_or_else(|| "compression job not found".to_string())?;
    let progress = job
        .progress
        .lock()
        .map_err(|_| "compression progress is unavailable".to_string())?
        .clone();
    Ok(progress)
}

fn resize_dimension(value: u32, percent: u8) -> u32 {
    ((u64::from(value) * u64::from(percent) + 50) / 100).clamp(1, u64::from(MAX_IMAGE_DIMENSION))
        as u32
}

fn resized_dimensions(width: u32, height: u32, percent: Option<u8>) -> (u32, u32) {
    percent
        .map(|percent| {
            (
                resize_dimension(width, percent),
                resize_dimension(height, percent),
            )
        })
        .unwrap_or((width, height))
}

fn prepare_resize_request(
    request: &CompressionRequest,
    job: Option<&Arc<CompressionJob>>,
) -> Result<CompressionRequest, String> {
    let Some(percent) = request.metadata.target_resize_percent else {
        return Ok(request.clone());
    };
    if let Some(job) = job {
        checkpoint(job)?;
    }
    let image = decode_image(&request.input)?;
    if let Some(job) = job {
        checkpoint(job)?;
    }
    let (source_width, source_height) = image.dimensions();
    let target_width = resize_dimension(source_width, percent);
    let target_height = resize_dimension(source_height, percent);
    if (target_width, target_height) == (source_width, source_height) {
        return Ok(request.clone());
    }
    let resized = image.resize_exact(target_width, target_height, FilterType::Lanczos3);
    if let Some(job) = job {
        checkpoint(job)?;
    }
    let mut encoded = Vec::new();
    resized
        .write_to(&mut Cursor::new(&mut encoded), ImageFormat::Png)
        .map_err(|error| format!("failed to prepare resized compression input: {error}"))?;
    let prepared_limit = request
        .metadata
        .max_input_bytes
        .map(|limit| limit as usize)
        .unwrap_or(MAX_INPUT_BYTES)
        .min(MAX_INPUT_BYTES);
    if encoded.len() > prepared_limit {
        return Err(format!(
            "resized compression input exceeds the {} MiB input limit",
            prepared_limit / (1024 * 1024)
        ));
    }
    if let Some(job) = job {
        checkpoint(job)?;
    }
    let mut prepared = request.clone();
    prepared.input = encoded;
    Ok(prepared)
}

fn run_compression(
    request: &CompressionRequest,
    job: &Arc<CompressionJob>,
) -> Result<CompressionResult, String> {
    checkpoint(job)?;
    update_progress(job, CompressionStage::Reading, None, None);
    update_progress(job, CompressionStage::Decoding, None, None);
    let PreparedEncoding {
        request: prepared_request,
        width,
        height,
        selection:
            EncodedSelection {
                bytes,
                selected_quality,
                target_met,
                skipped_reason: selection_skipped_reason,
                candidate_search_ms,
                candidate_count,
            },
    } = prepare_and_choose_output(request, Some(job)).map_err(|error| fail_message(job, error))?;
    update_progress(job, CompressionStage::Encoding, None, None);
    checkpoint(job)?;
    update_progress(job, CompressionStage::Validating, None, None);
    let output_path =
        resolve_final_output_path(request).map_err(|error| fail_message(job, error))?;
    let input_bytes = request.input.len() as u64;
    let output_bytes = bytes.len() as u64;
    let (saved_bytes, savings_percent) = compression_statistics(input_bytes, output_bytes);
    let verified = verify_compressed_output(&bytes, request.format, width, height)
        .map_err(|error| fail_message(job, error))?;
    let quality_metrics = if request.format == CompressionFormat::Webp && !request.lossless {
        quality_metrics_for_output(&prepared_request, &verified, Some(job))?
    } else {
        None
    };
    checkpoint(job).map_err(|error| fail_message(job, error))?;
    update_progress_bytes(job, Some(input_bytes), Some(output_bytes));
    let skipped_reason = selection_skipped_reason.or_else(|| {
        request
            .metadata
            .skip_if_larger
            .then_some(output_bytes > input_bytes)
            .filter(|value| *value)
            .map(|_| {
                "compressed output is larger than the source; output was not published".to_string()
            })
    });
    if let Some(skipped_reason) = skipped_reason {
        update_progress(
            job,
            CompressionStage::Skipped,
            None,
            Some(skipped_reason.to_string()),
        );
        return Ok(CompressionResult {
            job_id: job
                .progress
                .lock()
                .map_err(|_| "compression progress is unavailable".to_string())?
                .job_id
                .clone(),
            output_path: output_path.to_string_lossy().into_owned(),
            status: "skipped".to_string(),
            skipped_reason: Some(skipped_reason),
            input_bytes,
            original_input_bytes: Some(input_bytes),
            prepared_input_bytes: Some(prepared_request.input.len() as u64),
            output_bytes,
            saved_bytes,
            savings_percent,
            width,
            height,
            format: request.format.name().into(),
            lossless: request.lossless,
            compression_mode: CompressionMode::from_lossless(request.lossless).as_str(),
            compression_engine: request.compression_engine().as_str(),
            metadata_policy: request.metadata.metadata_policy.as_str(),
            source_deleted: false,
            target_bytes: request.target_bytes,
            target_met,
            selected_resize_percent: prepared_request.metadata.target_resize_percent,
            auto_resize_to_target: request.metadata.auto_resize_to_target,
            selected_quality,
            candidate_search_ms,
            candidate_count,
            max_rgb_mae: request.metadata.max_rgb_mae,
            quality_metrics,
        });
    }
    update_progress(job, CompressionStage::Publishing, None, None);
    let source_path = request.metadata.source_path.as_deref();
    write_exported_file(
        &output_path,
        bytes,
        source_path,
        WriteOptions {
            manage_existing_output: true,
            overwrite_existing: request.metadata.overwrite_existing,
            overwrite_same_name: false,
            replace_original: request.metadata.replace_original
                || request.metadata.output_location.as_deref() == Some("original"),
            delete_source: request.metadata.delete_source,
        },
    )
    .map_err(|error| fail_message(job, error))?;
    let published_output_bytes = fs::metadata(&output_path)
        .map_err(|error| {
            fail_message(job, format!("failed to inspect compressed output: {error}"))
        })?
        .len();
    update_progress_bytes(job, None, Some(published_output_bytes));
    let result = CompressionResult {
        job_id: job
            .progress
            .lock()
            .map_err(|_| "compression progress is unavailable".to_string())?
            .job_id
            .clone(),
        output_path: output_path.to_string_lossy().into_owned(),
        status: "completed".to_string(),
        skipped_reason: None,
        input_bytes,
        original_input_bytes: Some(input_bytes),
        prepared_input_bytes: Some(prepared_request.input.len() as u64),
        output_bytes: published_output_bytes,
        saved_bytes,
        savings_percent,
        width,
        height,
        format: request.format.name().into(),
        lossless: request.lossless,
        compression_mode: CompressionMode::from_lossless(request.lossless).as_str(),
        compression_engine: request.compression_engine().as_str(),
        metadata_policy: request.metadata.metadata_policy.as_str(),
        source_deleted: request.metadata.delete_source,
        target_bytes: request.target_bytes,
        target_met,
        selected_resize_percent: prepared_request.metadata.target_resize_percent,
        auto_resize_to_target: request.metadata.auto_resize_to_target,
        selected_quality,
        candidate_search_ms,
        candidate_count,
        max_rgb_mae: request.metadata.max_rgb_mae,
        quality_metrics,
    };
    update_progress(
        job,
        CompressionStage::Completed,
        Some(result.output_path.clone()),
        None,
    );
    Ok(result)
}

fn default_skip_if_larger() -> bool {
    true
}

fn default_compression_schema_version() -> u8 {
    COMPRESSION_SCHEMA_VERSION
}

fn validate_compression_schema_version(version: u8) -> Result<(), String> {
    if version != COMPRESSION_SCHEMA_VERSION {
        return Err(format!(
            "unsupported compression schemaVersion {version}; expected {COMPRESSION_SCHEMA_VERSION}"
        ));
    }
    Ok(())
}

fn validate_webp_method(
    method: Option<u8>,
    format: CompressionFormat,
    lossless: bool,
) -> Result<(), String> {
    if let Some(method) = method {
        if method > 6 {
            return Err("webpMethod must be between 0 and 6".into());
        }
        if format != CompressionFormat::Webp || lossless {
            return Err("webpMethod is only supported for lossy WebP".into());
        }
    }
    Ok(())
}

fn validate_webp_alpha_quality(
    alpha_quality: Option<u8>,
    format: CompressionFormat,
    lossless: bool,
) -> Result<(), String> {
    if alpha_quality.is_some_and(|value| value > 100) {
        return Err("webpAlphaQuality must be between 0 and 100".into());
    }
    if alpha_quality.is_some() && (format != CompressionFormat::Webp || lossless) {
        return Err("webpAlphaQuality is only supported for lossy WebP".into());
    }
    Ok(())
}

fn validate_webp_pass(
    pass: Option<u8>,
    format: CompressionFormat,
    lossless: bool,
) -> Result<(), String> {
    if pass.is_some_and(|value| !(1..=10).contains(&value)) {
        return Err("webpPass must be between 1 and 10".into());
    }
    if pass.is_some() && (format != CompressionFormat::Webp || lossless) {
        return Err("webpPass is only supported for lossy WebP".into());
    }
    Ok(())
}

fn validate_max_input_bytes(value: Option<u64>) -> Result<usize, String> {
    let bytes = value.unwrap_or(MAX_INPUT_BYTES as u64);
    const MIN_INPUT_BYTES: u64 = 1024 * 1024;
    if !(MIN_INPUT_BYTES..=MAX_INPUT_BYTES as u64).contains(&bytes) {
        return Err("maxInputBytes must be between 1 and 32 MiB".into());
    }
    Ok(bytes as usize)
}

fn validate_max_rgb_mae(
    value: Option<f64>,
    format: CompressionFormat,
    lossless: bool,
    target_bytes: Option<u64>,
) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    if !value.is_finite() || !(0.0..=255.0).contains(&value) {
        return Err("maxRgbMae must be a finite number between 0 and 255".into());
    }
    if !matches!(format, CompressionFormat::Jpeg | CompressionFormat::Webp)
        || lossless
        || target_bytes.is_none()
    {
        return Err(
            "maxRgbMae is only supported for lossy JPEG or WebP compression with maxOutputBytes"
                .into(),
        );
    }
    Ok(())
}

fn validate_webp_near_lossless(
    level: Option<u8>,
    format: CompressionFormat,
    lossless: bool,
) -> Result<(), String> {
    if let Some(level) = level {
        if !(1..=99).contains(&level) {
            return Err("webpNearLossless must be between 1 and 99".into());
        }
        if format != CompressionFormat::Webp || !lossless {
            return Err("webpNearLossless is only supported for lossless WebP".into());
        }
    }
    Ok(())
}

fn validate_webp_lossless_method(
    method: Option<u8>,
    format: CompressionFormat,
    lossless: bool,
) -> Result<(), String> {
    if let Some(method) = method {
        if method > 6 {
            return Err("webpLosslessMethod must be between 0 and 6".into());
        }
        if format != CompressionFormat::Webp || !lossless {
            return Err("webpLosslessMethod is only supported for lossless WebP".into());
        }
    }
    Ok(())
}

fn validate_target_resize_percent(
    percent: Option<u8>,
    format: CompressionFormat,
    lossless: bool,
) -> Result<(), String> {
    let Some(percent) = percent else {
        return Ok(());
    };
    if !(MIN_TARGET_RESIZE_PERCENT..=MAX_TARGET_RESIZE_PERCENT).contains(&percent) {
        return Err(format!(
            "targetResizePercent must be between {MIN_TARGET_RESIZE_PERCENT} and {MAX_TARGET_RESIZE_PERCENT}"
        ));
    }
    if !matches!(format, CompressionFormat::Jpeg | CompressionFormat::Webp) || lossless {
        return Err("targetResizePercent is only supported for lossy JPEG or WebP".into());
    }
    Ok(())
}

fn validate_auto_resize_to_target(
    enabled: bool,
    target_bytes: Option<u64>,
    target_resize_percent: Option<u8>,
    format: CompressionFormat,
    lossless: bool,
) -> Result<(), String> {
    if !enabled {
        return Ok(());
    }
    if target_bytes.is_none() {
        return Err("autoResizeToTarget requires maxOutputBytes".into());
    }
    if !matches!(format, CompressionFormat::Jpeg | CompressionFormat::Webp) || lossless {
        return Err("autoResizeToTarget is only supported for lossy JPEG or WebP".into());
    }
    if target_resize_percent.is_some() {
        return Err("autoResizeToTarget cannot be combined with targetResizePercent".into());
    }
    Ok(())
}

fn parse_jpeg_background(value: Option<&str>) -> Result<[u8; 3], String> {
    let value = value.unwrap_or("#ffffff").trim();
    let hex = value
        .strip_prefix('#')
        .ok_or_else(|| "jpegBackground must be a #RRGGBB color".to_string())?;
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("jpegBackground must be a #RRGGBB color".into());
    }
    Ok([
        u8::from_str_radix(&hex[0..2], 16).map_err(|_| "jpegBackground is invalid")?,
        u8::from_str_radix(&hex[2..4], 16).map_err(|_| "jpegBackground is invalid")?,
        u8::from_str_radix(&hex[4..6], 16).map_err(|_| "jpegBackground is invalid")?,
    ])
}

fn validate_jpeg_background(value: Option<&str>, format: CompressionFormat) -> Result<(), String> {
    if value.is_some() && format != CompressionFormat::Jpeg {
        return Err("jpegBackground is only supported for JPEG output".into());
    }
    if value.is_some() {
        parse_jpeg_background(value)?;
    }
    Ok(())
}

fn validate_compression_mode(format: CompressionFormat, lossless: bool) -> Result<(), String> {
    if format == CompressionFormat::Png && !lossless {
        return Err("lossy compression is not supported for PNG; use JPEG or WebP".into());
    }
    if format == CompressionFormat::Jpeg && lossless {
        return Err("lossless compression is not supported for JPEG; use PNG or WebP".into());
    }
    Ok(())
}

fn composite_jpeg_background(image: &image::RgbaImage, background: [u8; 3]) -> RgbImage {
    ImageBuffer::from_fn(image.width(), image.height(), |x, y| {
        let pixel = image.get_pixel(x, y);
        let alpha = u16::from(pixel[3]);
        let inverse_alpha = 255u16 - alpha;
        Rgb([
            ((u16::from(pixel[0]) * alpha + u16::from(background[0]) * inverse_alpha + 127) / 255)
                as u8,
            ((u16::from(pixel[1]) * alpha + u16::from(background[1]) * inverse_alpha + 127) / 255)
                as u8,
            ((u16::from(pixel[2]) * alpha + u16::from(background[2]) * inverse_alpha + 127) / 255)
                as u8,
        ])
    })
}

fn compression_statistics(input_bytes: u64, output_bytes: u64) -> (i64, f64) {
    let saved_bytes = input_bytes as i128 - output_bytes as i128;
    let savings_percent = if input_bytes == 0 {
        0.0
    } else {
        (saved_bytes as f64 / input_bytes as f64) * 100.0
    };
    (
        saved_bytes.clamp(i64::MIN as i128, i64::MAX as i128) as i64,
        savings_percent,
    )
}

#[derive(Debug)]
struct EncodedSelection {
    bytes: Vec<u8>,
    selected_quality: Option<u8>,
    target_met: bool,
    skipped_reason: Option<String>,
    candidate_search_ms: Option<u64>,
    candidate_count: Option<u8>,
}

struct PreparedEncoding {
    request: CompressionRequest,
    width: u32,
    height: u32,
    selection: EncodedSelection,
}

#[cfg(test)]
#[allow(dead_code)]
fn choose_encoded_output(
    request: &CompressionRequest,
    width: u32,
    height: u32,
) -> Result<EncodedSelection, String> {
    choose_encoded_output_with_cancellation(request, width, height, None)
}

fn prepare_and_choose_output(
    request: &CompressionRequest,
    job: Option<&Arc<CompressionJob>>,
) -> Result<PreparedEncoding, String> {
    if !request.metadata.auto_resize_to_target {
        let prepared_request = prepare_resize_request(request, job)?;
        let (width, height) = inspect_image(&prepared_request.input)?;
        let selection =
            choose_encoded_output_with_cancellation(&prepared_request, width, height, job)?;
        return Ok(PreparedEncoding {
            request: prepared_request,
            width,
            height,
            selection,
        });
    }

    let max_rounds = AUTO_RESIZE_PERCENT_CANDIDATES
        .len()
        .min(request.max_candidates);
    let mut remaining_candidates = request.max_candidates;
    let mut aggregate_candidate_count = 0u8;
    let mut aggregate_search_ms = 0u64;
    let mut smallest: Option<PreparedEncoding> = None;

    for (index, percent) in AUTO_RESIZE_PERCENT_CANDIDATES
        .iter()
        .copied()
        .take(max_rounds)
        .enumerate()
    {
        if let Some(job) = job {
            checkpoint(job)?;
            update_progress(job, CompressionStage::Planning, None, None);
        }
        let rounds_left = max_rounds - index;
        let budget = (remaining_candidates / rounds_left).max(1);
        remaining_candidates = remaining_candidates.saturating_sub(budget);

        let mut round_request = request.clone();
        round_request.metadata.target_resize_percent = Some(percent);
        round_request.max_candidates = budget;
        let prepared_request = prepare_resize_request(&round_request, job)?;
        let (width, height) = inspect_image(&prepared_request.input)?;
        let mut selection =
            choose_encoded_output_with_cancellation(&prepared_request, width, height, job)?;
        aggregate_candidate_count =
            aggregate_candidate_count.saturating_add(selection.candidate_count.unwrap_or(0));
        aggregate_search_ms =
            aggregate_search_ms.saturating_add(selection.candidate_search_ms.unwrap_or(0));
        selection.candidate_count = Some(aggregate_candidate_count);
        selection.candidate_search_ms = Some(aggregate_search_ms);
        let candidate = PreparedEncoding {
            request: prepared_request,
            width,
            height,
            selection,
        };

        if candidate.selection.target_met {
            return Ok(candidate);
        }
        if smallest
            .as_ref()
            .is_none_or(|current| candidate.selection.bytes.len() < current.selection.bytes.len())
        {
            smallest = Some(candidate);
        }
    }

    let mut smallest =
        smallest.ok_or_else(|| "automatic resize produced no encoded candidate".to_string())?;
    smallest.selection.skipped_reason =
        Some("target_unreachable: automatic resize candidates did not fit maxOutputBytes".into());
    Ok(smallest)
}

fn choose_encoded_output_with_cancellation(
    request: &CompressionRequest,
    width: u32,
    height: u32,
    job: Option<&Arc<CompressionJob>>,
) -> Result<EncodedSelection, String> {
    if let Some(job) = job {
        checkpoint(job)?;
    }
    let quality = request.metadata.jpeg_quality.unwrap_or(82);
    let Some(target_bytes) = request.target_bytes else {
        let bytes = encode_and_verify(
            &request.input,
            request.format,
            quality,
            request.png_optimization_level,
            request.png_optimize_alpha,
            width,
            height,
            request.lossless,
            request.metadata.jpeg_background.as_deref(),
            request.metadata.webp_method,
            request.metadata.webp_alpha_quality,
            request.metadata.webp_pass,
            request.metadata.webp_near_lossless,
            request.metadata.webp_lossless_method,
            request.metadata.metadata_policy,
            request.jpeg_options(),
        )?;
        return Ok(EncodedSelection {
            bytes,
            selected_quality: (request.format == CompressionFormat::Jpeg
                || (request.format == CompressionFormat::Webp && !request.lossless))
                .then_some(quality),
            target_met: false,
            skipped_reason: None,
            candidate_search_ms: None,
            candidate_count: None,
        });
    };

    let quality_search = request.format == CompressionFormat::Jpeg
        || (request.format == CompressionFormat::Webp && !request.lossless);
    if !quality_search {
        let bytes = encode_and_verify(
            &request.input,
            request.format,
            quality,
            request.png_optimization_level,
            request.png_optimize_alpha,
            width,
            height,
            request.lossless,
            request.metadata.jpeg_background.as_deref(),
            request.metadata.webp_method,
            request.metadata.webp_alpha_quality,
            request.metadata.webp_pass,
            request.metadata.webp_near_lossless,
            request.metadata.webp_lossless_method,
            request.metadata.metadata_policy,
            request.jpeg_options(),
        )?;
        return Ok(EncodedSelection {
            target_met: (bytes.len() as u64) <= target_bytes,
            skipped_reason: ((bytes.len() as u64) > target_bytes).then_some(if request.lossless {
                "target_unreachable: lossless output exceeds maxOutputBytes".to_string()
            } else {
                "target_unmet: WebP quality candidate search is not available".to_string()
            }),
            bytes,
            selected_quality: None,
            candidate_search_ms: None,
            candidate_count: None,
        });
    }

    if let Some(max_rgb_mae) = request.metadata.max_rgb_mae {
        return choose_lossy_output_with_rgb_mae(
            request,
            width,
            height,
            target_bytes,
            max_rgb_mae,
            job,
        );
    }

    let search_started_at = Instant::now();
    let max_quality = quality;
    let mut low = 1u8;
    let mut high = max_quality;
    let mut candidates = Vec::new();
    let mut best: Option<(u8, Vec<u8>)> = None;
    let mut smallest: Option<(u8, Vec<u8>)> = None;
    while candidates.len() < request.max_candidates && low <= high {
        if let Some(job) = job {
            checkpoint(job)?;
        }
        let candidate = if candidates.is_empty() {
            max_quality
        } else if candidates.len() == 1 {
            1
        } else {
            low + (high - low) / 2
        };
        if candidates.contains(&candidate) {
            break;
        }
        candidates.push(candidate);
        let bytes = encode_and_verify(
            &request.input,
            request.format,
            candidate,
            request.png_optimization_level,
            request.png_optimize_alpha,
            width,
            height,
            request.lossless,
            request.metadata.jpeg_background.as_deref(),
            request.metadata.webp_method,
            request.metadata.webp_alpha_quality,
            request.metadata.webp_pass,
            request.metadata.webp_near_lossless,
            request.metadata.webp_lossless_method,
            request.metadata.metadata_policy,
            request.jpeg_options(),
        )?;
        if let Some(job) = job {
            update_progress_bytes(job, None, Some(bytes.len() as u64));
            checkpoint(job)?;
        }
        if smallest
            .as_ref()
            .is_none_or(|(_, current)| bytes.len() < current.len())
        {
            smallest = Some((candidate, bytes.clone()));
        }
        if bytes.len() as u64 <= target_bytes {
            best = Some((candidate, bytes));
            low = candidate.saturating_add(1);
        } else {
            high = candidate.saturating_sub(1);
        }
    }
    let target_met = best.is_some();
    let Some((selected_quality, bytes)) = best.or(smallest) else {
        return Err(format!(
            "{} candidate search produced no encoded output",
            if request.format == CompressionFormat::Jpeg {
                "JPEG"
            } else {
                "WebP"
            }
        ));
    };
    let skipped_reason = if !target_met {
        Some(if request.format == CompressionFormat::Jpeg {
            "target_unreachable: no JPEG quality candidate fits maxOutputBytes".to_string()
        } else {
            "target_unmet: no WebP quality candidate fits maxOutputBytes".to_string()
        })
    } else {
        None
    };
    Ok(EncodedSelection {
        bytes,
        selected_quality: Some(selected_quality),
        target_met,
        skipped_reason,
        candidate_search_ms: Some(
            search_started_at
                .elapsed()
                .as_millis()
                .min(u64::MAX as u128) as u64,
        ),
        candidate_count: Some(candidates.len() as u8),
    })
}

fn choose_lossy_output_with_rgb_mae(
    request: &CompressionRequest,
    width: u32,
    height: u32,
    target_bytes: u64,
    max_rgb_mae: f64,
    job: Option<&Arc<CompressionJob>>,
) -> Result<EncodedSelection, String> {
    let search_started_at = Instant::now();
    let max_quality = request.metadata.jpeg_quality.unwrap_or(82);
    let mut candidates = Vec::new();
    let mut smallest: Option<(u8, Vec<u8>)> = None;
    let mut best_quality: Option<(u8, Vec<u8>, f64)> = None;
    let mut best_fit: Option<(u8, Vec<u8>)> = None;
    let mut target_fit = false;

    for index in 0..request.max_candidates {
        if let Some(job) = job {
            checkpoint(job)?;
        }
        let candidate = if request.max_candidates == 1 {
            max_quality
        } else {
            max_quality.saturating_sub(
                ((usize::from(max_quality.saturating_sub(1)) * index)
                    / (request.max_candidates - 1)) as u8,
            )
        };
        if candidates.contains(&candidate) {
            continue;
        }
        candidates.push(candidate);
        let bytes = encode_and_verify(
            &request.input,
            request.format,
            candidate,
            request.png_optimization_level,
            request.png_optimize_alpha,
            width,
            height,
            request.lossless,
            request.metadata.jpeg_background.as_deref(),
            request.metadata.webp_method,
            request.metadata.webp_alpha_quality,
            request.metadata.webp_pass,
            request.metadata.webp_near_lossless,
            request.metadata.webp_lossless_method,
            request.metadata.metadata_policy,
            request.jpeg_options(),
        )?;
        if let Some(job) = job {
            update_progress_bytes(job, None, Some(bytes.len() as u64));
        }
        let decoded = verify_compressed_output(&bytes, request.format, width, height)?;
        let metrics = quality_metrics_for_output(request, &decoded, job)?
            .ok_or_else(|| "maxRgbMae requires lossy JPEG or WebP quality metrics".to_string())?;
        if let Some(job) = job {
            checkpoint(job)?;
        }
        if smallest
            .as_ref()
            .is_none_or(|(_, current)| bytes.len() < current.len())
        {
            smallest = Some((candidate, bytes.clone()));
        }
        let fits_target = bytes.len() as u64 <= target_bytes;
        let fits_quality = metrics.rgb_mae <= max_rgb_mae;
        if fits_target {
            target_fit = true;
            if best_quality
                .as_ref()
                .is_none_or(|(_, _, current)| metrics.rgb_mae < *current)
            {
                best_quality = Some((candidate, bytes.clone(), metrics.rgb_mae));
            }
        }
        if fits_target
            && fits_quality
            && best_fit
                .as_ref()
                .is_none_or(|(current, _)| candidate > *current)
        {
            best_fit = Some((candidate, bytes));
        }
    }

    let target_met = best_fit.is_some();
    let (selected_quality, bytes) = if let Some((quality, bytes)) = best_fit {
        (quality, bytes)
    } else if target_fit {
        let (quality, bytes, _) = best_quality
            .ok_or_else(|| "WebP maxRgbMae search produced no quality candidate".to_string())?;
        (quality, bytes)
    } else {
        smallest.ok_or_else(|| "WebP maxRgbMae search produced no encoded output".to_string())?
    };
    let skipped_reason = if target_met {
        None
    } else if target_fit {
        Some(format!(
            "quality_threshold_unmet: no {} quality candidate meets maxRgbMae",
            request.format.name().to_ascii_uppercase()
        ))
    } else {
        Some(format!(
            "target_unmet: no {} quality candidate fits maxOutputBytes",
            request.format.name().to_ascii_uppercase()
        ))
    };
    Ok(EncodedSelection {
        bytes,
        selected_quality: Some(selected_quality),
        target_met,
        skipped_reason,
        candidate_search_ms: Some(
            search_started_at
                .elapsed()
                .as_millis()
                .min(u64::MAX as u128) as u64,
        ),
        candidate_count: Some(candidates.len() as u8),
    })
}

#[allow(clippy::too_many_arguments)]
fn encode_and_verify(
    input: &[u8],
    format: CompressionFormat,
    quality: u8,
    png_optimization_level: u8,
    png_optimize_alpha: bool,
    width: u32,
    height: u32,
    lossless: bool,
    jpeg_background: Option<&str>,
    webp_method: Option<u8>,
    webp_alpha_quality: Option<u8>,
    webp_pass: Option<u8>,
    webp_near_lossless: Option<u8>,
    webp_lossless_method: Option<u8>,
    metadata_policy: MetadataPolicy,
    jpeg_options: JpegEncodingOptions,
) -> Result<Vec<u8>, String> {
    let bytes = encode_image_with_webp_method_alpha(
        input,
        format,
        quality,
        png_optimization_level,
        png_optimize_alpha,
        lossless,
        jpeg_background,
        webp_method,
        webp_alpha_quality,
        webp_pass,
        webp_near_lossless,
        webp_lossless_method,
        metadata_policy,
        jpeg_options,
    )?;
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err("compressed output exceeds the 128 MiB limit".into());
    }
    verify_compressed_output(&bytes, format, width, height)?;
    Ok(bytes)
}

fn verify_compressed_output(
    bytes: &[u8],
    format: CompressionFormat,
    width: u32,
    height: u32,
) -> Result<DynamicImage, String> {
    let actual_format = image::guess_format(bytes)
        .map_err(|error| format!("compressed output failed format verification: {error}"))?;
    let expected_format = match format {
        CompressionFormat::Png => ImageFormat::Png,
        CompressionFormat::Jpeg => ImageFormat::Jpeg,
        CompressionFormat::Webp => ImageFormat::WebP,
    };
    if actual_format != expected_format {
        return Err(format!(
            "compressed output format does not match requested {} format: detected {actual_format:?}",
            format.name()
        ));
    }
    let verified = decode_image(bytes)
        .map_err(|error| format!("compressed output failed decode verification: {error}"))?;
    if verified.dimensions() != (width, height) {
        return Err("compressed output dimensions do not match the source image".into());
    }
    Ok(verified)
}

#[cfg(test)]
fn run_preview(request: &CompressionRequest) -> Result<CompressionPreview, String> {
    run_preview_core(request, None)
}

fn run_preview_with_cancellation(
    request: &CompressionRequest,
    job: &Arc<CompressionJob>,
) -> Result<CompressionPreview, String> {
    run_preview_core(request, Some(job))
}

fn run_preview_core(
    request: &CompressionRequest,
    job: Option<&Arc<CompressionJob>>,
) -> Result<CompressionPreview, String> {
    if let Some(job) = job {
        checkpoint(job)?;
        update_progress(job, CompressionStage::Reading, None, None);
        update_progress(job, CompressionStage::Decoding, None, None);
    }
    let PreparedEncoding {
        request: prepared_request,
        width,
        height,
        selection:
            EncodedSelection {
                bytes: data,
                selected_quality,
                target_met,
                skipped_reason,
                candidate_search_ms,
                candidate_count,
            },
    } = prepare_and_choose_output(request, job)?;
    if let Some(job) = job {
        update_progress(job, CompressionStage::Encoding, None, None);
    }
    if data.len() > MAX_PREVIEW_BYTES {
        return Err(format!(
            "compressed preview exceeds the {} MiB limit",
            MAX_PREVIEW_BYTES / (1024 * 1024)
        ));
    }
    if let Some(job) = job {
        checkpoint(job)?;
        update_progress(job, CompressionStage::Validating, None, None);
    }
    let verified = verify_compressed_output(&data, request.format, width, height)?;
    let quality_metrics = quality_metrics_for_output(&prepared_request, &verified, job)?;
    let output_bytes = data.len() as u64;
    if let Some(job) = job {
        update_progress_bytes(job, None, Some(output_bytes));
    }
    Ok(CompressionPreview {
        data,
        width,
        height,
        format: request.format.name().into(),
        output_bytes,
        lossless: request.lossless,
        compression_mode: CompressionMode::from_lossless(request.lossless).as_str(),
        compression_engine: request.compression_engine().as_str(),
        metadata_policy: request.metadata.metadata_policy.as_str(),
        status: if skipped_reason.is_some() {
            "skipped"
        } else {
            "completed"
        }
        .into(),
        skipped_reason,
        original_input_bytes: Some(request.input.len() as u64),
        prepared_input_bytes: Some(prepared_request.input.len() as u64),
        target_bytes: request.target_bytes,
        target_met,
        selected_resize_percent: prepared_request.metadata.target_resize_percent,
        auto_resize_to_target: request.metadata.auto_resize_to_target,
        selected_quality,
        candidate_search_ms,
        candidate_count,
        max_rgb_mae: request.metadata.max_rgb_mae,
        quality_metrics,
    })
}

fn calculate_quality_metrics_with_checkpoint(
    source: &DynamicImage,
    output: &DynamicImage,
    job: Option<&Arc<CompressionJob>>,
) -> Result<CompressionQualityMetrics, String> {
    if source.dimensions() != output.dimensions() {
        return Err("quality comparison requires matching image dimensions".into());
    }
    let source = source.to_rgba8();
    let output = output.to_rgba8();
    let channel_count = source.width() as f64 * source.height() as f64 * 3.0;
    if channel_count == 0.0 {
        return Err("quality comparison requires a non-empty image".into());
    }
    let mut absolute_error = 0.0;
    let mut squared_error = 0.0;
    let mut alpha_mismatch_pixels = 0u64;
    for (index, (source_pixel, output_pixel)) in source.pixels().zip(output.pixels()).enumerate() {
        if index % 4096 == 0 {
            if let Some(job) = job {
                checkpoint(job)?;
            }
        }
        for channel in 0..3 {
            let difference = f64::from(source_pixel[channel]) - f64::from(output_pixel[channel]);
            absolute_error += difference.abs();
            squared_error += difference * difference;
        }
        if source_pixel[3] != output_pixel[3] {
            alpha_mismatch_pixels = alpha_mismatch_pixels.saturating_add(1);
        }
    }
    let rgb_mae = absolute_error / channel_count;
    let mean_squared_error = squared_error / channel_count;
    let psnr_db = if mean_squared_error == 0.0 {
        None
    } else {
        Some(10.0 * (255.0_f64 * 255.0 / mean_squared_error).log10())
    };
    Ok(CompressionQualityMetrics {
        rgb_mae,
        psnr_db,
        alpha_mismatch_pixels,
    })
}

fn quality_metrics_for_output(
    request: &CompressionRequest,
    output: &DynamicImage,
    job: Option<&Arc<CompressionJob>>,
) -> Result<Option<CompressionQualityMetrics>, String> {
    if !matches!(
        request.format,
        CompressionFormat::Jpeg | CompressionFormat::Webp
    ) || request.lossless
    {
        return Ok(None);
    }
    if request.format == CompressionFormat::Jpeg && request.metadata.max_rgb_mae.is_none() {
        return Ok(None);
    }
    if let Some(job) = job {
        checkpoint(job)?;
    }
    let source = decode_image(&request.input)?;
    let source = if request.format == CompressionFormat::Jpeg {
        let rgba = source.to_rgba8();
        if rgba.pixels().any(|pixel| pixel[3] < 255) {
            DynamicImage::ImageRgb8(composite_jpeg_background(
                &rgba,
                parse_jpeg_background(request.metadata.jpeg_background.as_deref())?,
            ))
        } else {
            DynamicImage::ImageRgb8(source.to_rgb8())
        }
    } else {
        source
    };
    Ok(Some(calculate_quality_metrics_with_checkpoint(
        &source, output, job,
    )?))
}

fn run_estimate(request: &CompressionRequest) -> Result<CompressionEstimate, String> {
    let PreparedEncoding {
        request: prepared_request,
        width,
        height,
        selection:
            EncodedSelection {
                bytes,
                selected_quality,
                target_met,
                skipped_reason: selection_skipped_reason,
                candidate_search_ms,
                candidate_count,
            },
    } = prepare_and_choose_output(request, None)?;
    let input_bytes = request.input.len() as u64;
    let output_bytes = bytes.len() as u64;
    let (saved_bytes, savings_percent) = compression_statistics(input_bytes, output_bytes);
    let verified = verify_compressed_output(&bytes, request.format, width, height)?;
    let quality_metrics = quality_metrics_for_output(&prepared_request, &verified, None)?;
    let skipped_reason = selection_skipped_reason.or_else(|| {
        request
            .metadata
            .skip_if_larger
            .then_some(output_bytes > input_bytes)
            .filter(|value| *value)
            .map(|_| {
                "compressed output is larger than the source; estimate would skip publishing"
                    .to_string()
            })
    });
    Ok(CompressionEstimate {
        input_bytes,
        original_input_bytes: Some(input_bytes),
        prepared_input_bytes: Some(prepared_request.input.len() as u64),
        output_bytes,
        saved_bytes,
        savings_percent,
        width,
        height,
        format: request.format.name().into(),
        lossless: request.lossless,
        compression_mode: CompressionMode::from_lossless(request.lossless).as_str(),
        compression_engine: request.compression_engine().as_str(),
        metadata_policy: request.metadata.metadata_policy.as_str(),
        status: if skipped_reason.is_some() {
            "skipped".into()
        } else {
            "completed".into()
        },
        skipped_reason,
        target_bytes: request.target_bytes,
        target_met,
        selected_resize_percent: prepared_request.metadata.target_resize_percent,
        auto_resize_to_target: request.metadata.auto_resize_to_target,
        selected_quality,
        candidate_search_ms,
        candidate_count,
        max_rgb_mae: request.metadata.max_rgb_mae,
        quality_metrics,
    })
}

#[cfg(test)]
fn encode_image(
    input: &[u8],
    format: CompressionFormat,
    quality: u8,
    png_optimization_level: u8,
) -> Result<Vec<u8>, String> {
    encode_image_with_mode(input, format, quality, png_optimization_level, true)
}

#[cfg(test)]
fn encode_image_with_mode(
    input: &[u8],
    format: CompressionFormat,
    quality: u8,
    png_optimization_level: u8,
    lossless: bool,
) -> Result<Vec<u8>, String> {
    encode_image_with_webp_method(
        input,
        format,
        quality,
        png_optimization_level,
        lossless,
        None,
        None,
        None,
        None,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
#[cfg(test)]
fn encode_image_with_webp_method(
    input: &[u8],
    format: CompressionFormat,
    quality: u8,
    png_optimization_level: u8,
    lossless: bool,
    jpeg_background: Option<&str>,
    webp_method: Option<u8>,
    webp_alpha_quality: Option<u8>,
    webp_pass: Option<u8>,
    webp_near_lossless: Option<u8>,
) -> Result<Vec<u8>, String> {
    encode_image_with_webp_method_alpha(
        input,
        format,
        quality,
        png_optimization_level,
        false,
        lossless,
        jpeg_background,
        webp_method,
        webp_alpha_quality,
        webp_pass,
        webp_near_lossless,
        None,
        MetadataPolicy::Strip,
        JpegEncodingOptions::default(),
    )
}

#[allow(clippy::too_many_arguments)]
fn encode_image_with_webp_method_alpha(
    input: &[u8],
    format: CompressionFormat,
    quality: u8,
    png_optimization_level: u8,
    png_optimize_alpha: bool,
    lossless: bool,
    jpeg_background: Option<&str>,
    webp_method: Option<u8>,
    webp_alpha_quality: Option<u8>,
    webp_pass: Option<u8>,
    webp_near_lossless: Option<u8>,
    webp_lossless_method: Option<u8>,
    metadata_policy: MetadataPolicy,
    jpeg_options: JpegEncodingOptions,
) -> Result<Vec<u8>, String> {
    let webp_strip_safe =
        format == CompressionFormat::Webp && metadata_policy == MetadataPolicy::StripSafe;
    let webp_icc_profile = if webp_strip_safe {
        extract_static_icc(input)?
    } else {
        None
    };
    let jpeg_icc_profile =
        if format == CompressionFormat::Jpeg && metadata_policy == MetadataPolicy::StripSafe {
            extract_jpeg_icc_profile(input)?
        } else {
            None
        };
    let image = decode_image(input)?;
    let mut output = LimitedWriter {
        bytes: Vec::new(),
        limit: MAX_OUTPUT_BYTES,
    };
    match format {
        CompressionFormat::Jpeg => {
            let rgba = image.to_rgba8();
            let rgb = if rgba.pixels().any(|pixel| pixel[3] < 255) {
                composite_jpeg_background(&rgba, parse_jpeg_background(jpeg_background)?)
            } else {
                image.to_rgb8()
            };
            if jpeg_options.progressive || jpeg_options.optimize_huffman {
                let width = u16::try_from(rgb.width())
                    .map_err(|_| "jpeg width exceeds encoder limit".to_string())?;
                let height = u16::try_from(rgb.height())
                    .map_err(|_| "jpeg height exceeds encoder limit".to_string())?;
                let mut encoder = RustJpegEncoder::new(&mut output, quality);
                encoder.set_progressive(jpeg_options.progressive);
                encoder.set_optimized_huffman_tables(jpeg_options.optimize_huffman);
                encoder
                    .encode(rgb.as_raw(), width, height, JpegColorType::Rgb)
                    .map_err(|error| format!("failed to encode jpeg: {error}"))?;
            } else {
                JpegEncoder::new_with_quality(&mut output, quality)
                    .encode_image(&rgb)
                    .map_err(|error| format!("failed to encode jpeg: {error}"))?;
            }
            if let Some(profile) = jpeg_icc_profile {
                output.bytes = inject_jpeg_icc_profile(&output.bytes, &profile)?;
            }
        }
        CompressionFormat::Png => {
            if metadata_policy == MetadataPolicy::StripSafe {
                let mut options = oxipng::Options::from_preset(png_optimization_level);
                options.strip = oxipng::StripChunks::Safe;
                output.bytes = oxipng::optimize_from_memory(input, &options)
                    .map_err(|error| format!("failed to strip-safe optimize png: {error}"))?;
            } else {
                image
                    .write_to(&mut Cursor::new(&mut output.bytes), ImageFormat::Png)
                    .map_err(|error| format!("failed to encode png: {error}"))?;
            }
            if metadata_policy != MetadataPolicy::StripSafe {
                let optimized = oxipng::optimize_from_memory(
                    &output.bytes,
                    &oxipng::Options {
                        optimize_alpha: png_optimize_alpha,
                        ..oxipng::Options::from_preset(png_optimization_level)
                    },
                )
                .map_err(|error| format!("failed to optimize png: {error}"))?;
                output.bytes = optimized;
            }
        }
        CompressionFormat::Webp if lossless => {
            if let Some(near_lossless) = webp_near_lossless {
                output.bytes = encode_near_lossless_rgba(
                    &image.to_rgba8(),
                    near_lossless,
                    webp_method.unwrap_or(4),
                )?;
            } else if let Some(method) = webp_lossless_method {
                output.bytes = encode_lossless_rgba_with_method(&image.to_rgba8(), method)?;
            } else {
                image
                    .write_to(&mut Cursor::new(&mut output.bytes), ImageFormat::WebP)
                    .map_err(|error| format!("failed to encode webp: {error}"))?;
            }
        }
        CompressionFormat::Webp => {
            let rgba = image.to_rgba8();
            output.bytes = match (webp_method, webp_alpha_quality) {
                (Some(method), alpha_quality) => encode_lossy_rgba_with_method_and_alpha_quality(
                    &rgba,
                    quality,
                    method,
                    alpha_quality,
                    webp_pass,
                )?,
                (None, Some(alpha_quality)) => encode_lossy_rgba_with_method_and_alpha_quality(
                    &rgba,
                    quality,
                    4,
                    Some(alpha_quality),
                    webp_pass,
                )?,
                (None, None) => match webp_pass {
                    Some(pass) => encode_lossy_rgba_with_method_and_alpha_quality(
                        &rgba,
                        quality,
                        4,
                        None,
                        Some(pass),
                    )?,
                    None => encode_lossy_rgba(&rgba, quality)?,
                },
            };
        }
    }
    if webp_strip_safe {
        output.bytes = apply_webp_strip_safe(&output.bytes, webp_icc_profile.as_deref())?;
    }
    if output.bytes.len() > output.limit {
        return Err("compressed output exceeds the 128 MiB limit".into());
    }
    Ok(output.bytes)
}

struct LimitedWriter {
    bytes: Vec<u8>,
    limit: usize,
}
impl Write for LimitedWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.bytes.len().saturating_add(bytes.len()) > self.limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "compressed output limit exceeded",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn inspect_image(input: &[u8]) -> Result<(u32, u32), String> {
    let image = decode_image(input)?;
    Ok(image.dimensions())
}

fn decode_image(input: &[u8]) -> Result<DynamicImage, String> {
    if input.is_empty() || input.len() > MAX_INPUT_BYTES {
        return Err(format!(
            "input image must be between 1 and {} MiB",
            MAX_INPUT_BYTES / (1024 * 1024)
        ));
    }
    reject_animation_input(input)?;
    let reader = ImageReader::new(Cursor::new(input))
        .with_guessed_format()
        .map_err(|error| format!("failed to inspect input image: {error}"))?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|error| format!("failed to read image dimensions: {error}"))?;
    if width == 0
        || height == 0
        || width > MAX_IMAGE_DIMENSION
        || height > MAX_IMAGE_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
    {
        return Err("input image dimensions exceed the compression limit".into());
    }
    let mut reader = ImageReader::new(Cursor::new(input))
        .with_guessed_format()
        .map_err(|error| format!("failed to inspect input image: {error}"))?;
    let mut limits = image::io::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODER_ALLOC_BYTES);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|error| format!("failed to decode input image: {error}"))?;
    Ok(normalize_jpeg_orientation(input, image))
}

fn reject_animation_input(input: &[u8]) -> Result<(), String> {
    if input.starts_with(b"GIF87a") || input.starts_with(b"GIF89a") {
        let mut options = DecodeOptions::new();
        options.skip_frame_decoding(true);
        let mut decoder = options
            .read_info(Cursor::new(input))
            .map_err(|error| format!("failed to inspect GIF input: {error}"))?;
        let mut frames = 0;
        while decoder
            .read_next_frame()
            .map_err(|error| format!("failed to inspect GIF input: {error}"))?
            .is_some()
        {
            frames += 1;
            if frames > 1 {
                return Err("animated GIF input is not supported; provide a static GIF".into());
            }
        }
        return Ok(());
    }
    if input.get(..4) == Some(b"RIFF") && input.get(8..12) == Some(b"WEBP") {
        let declared_size = u32::from_le_bytes(input[4..8].try_into().unwrap()) as usize;
        if declared_size.checked_add(8) != Some(input.len()) {
            return Err("invalid WebP container length".into());
        }
        let mut offset = 12usize;
        while offset.checked_add(8).is_some_and(|end| end <= input.len()) {
            let name = &input[offset..offset + 4];
            let length =
                u32::from_le_bytes(input[offset + 4..offset + 8].try_into().unwrap()) as usize;
            let end = offset
                .checked_add(8)
                .and_then(|value| value.checked_add(length))
                .ok_or_else(|| "invalid WebP chunk length".to_string())?;
            if end > input.len() {
                return Err("invalid WebP chunk length".into());
            }
            if name == b"ANIM" || name == b"ANMF" {
                return Err("animated WebP input is not supported; provide a static WebP".into());
            }
            offset = end
                .checked_add(length & 1)
                .ok_or_else(|| "invalid WebP chunk padding".to_string())?;
            if offset > input.len() {
                return Err("invalid WebP chunk padding".into());
            }
        }
        if offset != input.len() {
            return Err("invalid WebP chunk layout".into());
        }
    }
    Ok(())
}

fn parse_request(request: Request<'_>) -> Result<CompressionRequest, String> {
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        _ => return Err("compression commands require a raw binary IPC request".into()),
    };
    parse_raw_payload(body)
}

fn parse_raw_payload(body: &[u8]) -> Result<CompressionRequest, String> {
    if body.len() < 8 {
        return Err("compression request is truncated".into());
    }
    if &body[..4] != b"EGF1" {
        return Err("compression request has invalid magic; expected EGF1".into());
    }
    let metadata_len = u32::from_le_bytes(body[4..8].try_into().unwrap()) as usize;
    if metadata_len > MAX_METADATA_BYTES {
        return Err(format!(
            "compression metadata is too large: maximum is {MAX_METADATA_BYTES} bytes"
        ));
    }
    let end = 8usize
        .checked_add(metadata_len)
        .ok_or_else(|| "compression metadata length overflowed".to_string())?;
    if end > body.len() {
        return Err("compression metadata length exceeds payload size".into());
    }
    let metadata: CompressionMetadata = serde_json::from_slice(&body[8..end])
        .map_err(|error| format!("invalid compression metadata JSON: {error}"))?;
    validate_compression_schema_version(metadata.schema_version)?;
    let format = CompressionFormat::parse(&metadata.output_format)?;
    let output_location = normalize_output_location(metadata.output_location.as_deref())?;
    let lossless = metadata.lossless.unwrap_or(matches!(
        format,
        CompressionFormat::Png | CompressionFormat::Webp
    ));
    if metadata.file_name.trim().is_empty()
        || metadata.file_name.len() > 1024
        || metadata.file_name.chars().any(char::is_control)
    {
        return Err("fileName is invalid".into());
    }
    if let Some(quality) = metadata.jpeg_quality {
        if !(1..=100).contains(&quality) {
            return Err("jpegQuality must be between 1 and 100".into());
        }
    }
    validate_jpeg_background(metadata.jpeg_background.as_deref(), format)?;
    if let Some(target_bytes) = metadata.max_output_bytes {
        if target_bytes == 0 || target_bytes > MAX_OUTPUT_BYTES as u64 {
            return Err(format!(
                "maxOutputBytes must be between 1 and {} MiB",
                MAX_OUTPUT_BYTES / (1024 * 1024)
            ));
        }
    }
    let target_bytes = metadata.max_output_bytes;
    validate_max_rgb_mae(metadata.max_rgb_mae, format, lossless, target_bytes)?;
    let max_input_bytes = validate_max_input_bytes(metadata.max_input_bytes)?;
    let max_candidates = metadata.max_candidates.unwrap_or(DEFAULT_MAX_CANDIDATES);
    if !(1..=MAX_CANDIDATES).contains(&max_candidates) {
        return Err(format!(
            "maxCandidates must be between 1 and {MAX_CANDIDATES}"
        ));
    }
    let png_optimization_level = metadata.png_optimization_level.unwrap_or(2);
    if png_optimization_level > 6 {
        return Err("pngOptimizationLevel must be between 0 and 6".into());
    }
    validate_png_optimize_alpha(metadata.png_optimize_alpha, format)?;
    validate_jpeg_options(
        metadata.jpeg_progressive,
        metadata.jpeg_optimize_huffman,
        format,
    )?;
    validate_webp_method(metadata.webp_method, format, lossless)?;
    validate_webp_alpha_quality(metadata.webp_alpha_quality, format, lossless)?;
    validate_webp_pass(metadata.webp_pass, format, lossless)?;
    validate_webp_near_lossless(metadata.webp_near_lossless, format, lossless)?;
    validate_webp_lossless_method(metadata.webp_lossless_method, format, lossless)?;
    validate_target_resize_percent(metadata.target_resize_percent, format, lossless)?;
    validate_auto_resize_to_target(
        metadata.auto_resize_to_target,
        target_bytes,
        metadata.target_resize_percent,
        format,
        lossless,
    )?;
    validate_compression_mode(format, lossless)?;
    validate_compression_metadata_policy(metadata.metadata_policy)?;
    if metadata.replace_original && metadata.source_path.is_none() {
        return Err("replaceOriginal requires sourcePath".into());
    }
    if metadata.delete_source && metadata.source_path.is_none() {
        return Err("deleteSource requires sourcePath".into());
    }
    if metadata.delete_source && (metadata.replace_original || output_location == "original") {
        return Err("deleteSource cannot be combined with replaceOriginal".into());
    }
    if (metadata.auto_sequence || metadata.auto_rename) && metadata.overwrite_existing {
        return Err("autoSequence cannot be combined with overwriteExisting".into());
    }
    if (metadata.auto_sequence || metadata.auto_rename)
        && (metadata.replace_original || metadata.output_location.as_deref() == Some("original"))
    {
        return Err("autoSequence cannot be combined with replaceOriginal".into());
    }
    if let Some(output_file_name) = metadata.output_file_name.as_deref() {
        normalize_custom_output_file_name(output_file_name, format)?;
        if output_location == "path" {
            return Err("outputFileName cannot be combined with outputPath".into());
        }
        if metadata.replace_original || output_location == "original" {
            return Err("outputFileName cannot change the target of original replacement".into());
        }
    }
    if let Some(source_path) = metadata.source_path.as_deref() {
        let source_path = path_security::normalize_path(source_path)
            .map_err(|error| format!("invalid sourcePath: {error:?}"))?;
        path_security::validate_source_path(&source_path)
            .map_err(|error| format!("invalid sourcePath: {error:?}"))?;
    }
    let input = body[end..].to_vec();
    validate_png_strip_safe(metadata.metadata_policy, format, &input)?;
    if input.len() > max_input_bytes {
        return Err(if max_input_bytes == MAX_INPUT_BYTES {
            "input image exceeds the 32 MiB limit".into()
        } else {
            "input image exceeds the configured maxInputBytes limit".into()
        });
    }
    let png_optimize_alpha = metadata.png_optimize_alpha;
    Ok(CompressionRequest {
        metadata,
        input,
        format,
        lossless,
        target_bytes,
        max_candidates,
        png_optimization_level,
        png_optimize_alpha,
    })
}

fn parse_estimate_request(request: Request<'_>) -> Result<CompressionRequest, String> {
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        _ => return Err("compression estimate requires a raw binary IPC request".into()),
    };
    parse_estimate_raw_payload(body)
}

fn parse_estimate_raw_payload(body: &[u8]) -> Result<CompressionRequest, String> {
    if body.len() < 8 {
        return Err("compression estimate request is truncated".into());
    }
    if &body[..4] != b"EGF1" {
        return Err("compression estimate request has invalid magic; expected EGF1".into());
    }
    let metadata_len = u32::from_le_bytes(body[4..8].try_into().unwrap()) as usize;
    if metadata_len > MAX_METADATA_BYTES {
        return Err(format!(
            "compression estimate metadata is too large: maximum is {MAX_METADATA_BYTES} bytes"
        ));
    }
    let end = 8usize
        .checked_add(metadata_len)
        .ok_or_else(|| "compression estimate metadata length overflowed".to_string())?;
    if end > body.len() {
        return Err("compression estimate metadata length exceeds payload size".into());
    }
    let metadata: CompressionEstimateMetadata = serde_json::from_slice(&body[8..end])
        .map_err(|error| format!("invalid compression estimate metadata JSON: {error}"))?;
    validate_compression_schema_version(metadata.schema_version)?;
    let format = CompressionFormat::parse(&metadata.output_format)?;
    let lossless = metadata.lossless.unwrap_or(matches!(
        format,
        CompressionFormat::Png | CompressionFormat::Webp
    ));
    if metadata.file_name.trim().is_empty()
        || metadata.file_name.len() > 1024
        || metadata.file_name.chars().any(char::is_control)
    {
        return Err("fileName is invalid".into());
    }
    if let Some(quality) = metadata.jpeg_quality {
        if !(1..=100).contains(&quality) {
            return Err("jpegQuality must be between 1 and 100".into());
        }
    }
    validate_jpeg_background(metadata.jpeg_background.as_deref(), format)?;
    if let Some(target_bytes) = metadata.max_output_bytes {
        if target_bytes == 0 || target_bytes > MAX_OUTPUT_BYTES as u64 {
            return Err(format!(
                "maxOutputBytes must be between 1 and {} MiB",
                MAX_OUTPUT_BYTES / (1024 * 1024)
            ));
        }
    }
    let target_bytes = metadata.max_output_bytes;
    validate_max_rgb_mae(metadata.max_rgb_mae, format, lossless, target_bytes)?;
    let max_input_bytes = validate_max_input_bytes(metadata.max_input_bytes)?;
    let max_candidates = metadata.max_candidates.unwrap_or(DEFAULT_MAX_CANDIDATES);
    if !(1..=MAX_CANDIDATES).contains(&max_candidates) {
        return Err(format!(
            "maxCandidates must be between 1 and {MAX_CANDIDATES}"
        ));
    }
    let png_optimization_level = metadata.png_optimization_level.unwrap_or(2);
    if png_optimization_level > 6 {
        return Err("pngOptimizationLevel must be between 0 and 6".into());
    }
    validate_png_optimize_alpha(metadata.png_optimize_alpha, format)?;
    validate_jpeg_options(
        metadata.jpeg_progressive,
        metadata.jpeg_optimize_huffman,
        format,
    )?;
    validate_webp_method(metadata.webp_method, format, lossless)?;
    validate_webp_alpha_quality(metadata.webp_alpha_quality, format, lossless)?;
    validate_webp_pass(metadata.webp_pass, format, lossless)?;
    validate_webp_near_lossless(metadata.webp_near_lossless, format, lossless)?;
    validate_webp_lossless_method(metadata.webp_lossless_method, format, lossless)?;
    validate_target_resize_percent(metadata.target_resize_percent, format, lossless)?;
    validate_auto_resize_to_target(
        metadata.auto_resize_to_target,
        target_bytes,
        metadata.target_resize_percent,
        format,
        lossless,
    )?;
    validate_compression_mode(format, lossless)?;
    validate_compression_metadata_policy(metadata.metadata_policy)?;
    let input = body[end..].to_vec();
    validate_png_strip_safe(metadata.metadata_policy, format, &input)?;
    if input.len() > max_input_bytes {
        return Err(if max_input_bytes == MAX_INPUT_BYTES {
            "input image exceeds the 32 MiB limit".into()
        } else {
            "input image exceeds the configured maxInputBytes limit".into()
        });
    }
    Ok(CompressionRequest {
        metadata: CompressionMetadata {
            schema_version: COMPRESSION_SCHEMA_VERSION,
            file_name: metadata.file_name,
            output_file_name: None,
            output_format: format.name().into(),
            output_path: None,
            output_location: None,
            source_path: None,
            output_directory: None,
            output_subdirectory: None,
            overwrite_existing: false,
            replace_original: false,
            delete_source: false,
            auto_sequence: false,
            auto_rename: false,
            jpeg_quality: metadata.jpeg_quality,
            jpeg_background: metadata.jpeg_background,
            jpeg_progressive: metadata.jpeg_progressive,
            jpeg_optimize_huffman: metadata.jpeg_optimize_huffman,
            webp_method: metadata.webp_method,
            webp_alpha_quality: metadata.webp_alpha_quality,
            webp_pass: metadata.webp_pass,
            webp_near_lossless: metadata.webp_near_lossless,
            webp_lossless_method: metadata.webp_lossless_method,
            lossless: Some(lossless),
            skip_if_larger: metadata.skip_if_larger,
            max_output_bytes: metadata.max_output_bytes,
            max_candidates: metadata.max_candidates,
            max_rgb_mae: metadata.max_rgb_mae,
            target_resize_percent: metadata.target_resize_percent,
            auto_resize_to_target: metadata.auto_resize_to_target,
            max_input_bytes: metadata.max_input_bytes,
            png_optimization_level: metadata.png_optimization_level,
            png_optimize_alpha: metadata.png_optimize_alpha,
            metadata_policy: metadata.metadata_policy,
            job_id: None,
        },
        input,
        format,
        lossless,
        target_bytes,
        max_candidates,
        png_optimization_level,
        png_optimize_alpha: metadata.png_optimize_alpha,
    })
}

fn resolve_output_path(request: &CompressionRequest) -> Result<PathBuf, String> {
    let metadata = &request.metadata;
    let location = normalize_output_location(metadata.output_location.as_deref())?;
    let custom_file_name = metadata
        .output_file_name
        .as_deref()
        .map(|value| normalize_custom_output_file_name(value, request.format))
        .transpose()?;
    if custom_file_name.is_some() && location == "path" {
        return Err("outputFileName cannot be combined with outputPath".into());
    }
    let source = metadata.source_path.as_deref().map(PathBuf::from);
    let path = if location == "path" {
        path_security::normalize_path(
            metadata
                .output_path
                .as_deref()
                .ok_or_else(|| "outputPath is required for path output".to_string())?,
        )
        .map_err(|error| format!("invalid outputPath: {error:?}"))?
    } else if location == "original" || metadata.replace_original {
        if custom_file_name.is_some() {
            return Err("outputFileName cannot change the target of original replacement".into());
        }
        source
            .clone()
            .ok_or_else(|| "sourcePath is required for original output".to_string())?
    } else {
        let directory = if location == "directory" {
            path_security::normalize_path(
                metadata
                    .output_directory
                    .as_deref()
                    .ok_or_else(|| "outputDirectory is required".to_string())?,
            )
            .map_err(|error| format!("invalid outputDirectory: {error:?}"))?
        } else {
            source
                .as_ref()
                .and_then(|path| path.parent().map(Path::to_path_buf))
                .ok_or_else(|| "sourcePath is required for source output".to_string())?
        };
        if location == "subfolder" {
            directory.join(
                path_security::normalize_subdirectory(metadata.output_subdirectory.as_deref())
                    .map_err(|error| format!("invalid outputSubdirectory: {error:?}"))?
                    .ok_or_else(|| "outputSubdirectory is required".to_string())?,
            )
        } else {
            directory
        }
        .join(custom_file_name.unwrap_or_else(|| default_name(&metadata.file_name, request.format)))
    };
    let path = with_extension(path, request.format.extension());
    path_security::validate_output_path(&path)
        .map_err(|error| format!("invalid compression output path: {error:?}"))?;
    Ok(path)
}

fn normalize_output_location(value: Option<&str>) -> Result<String, String> {
    let location = value.unwrap_or("path").to_ascii_lowercase();
    if matches!(
        location.as_str(),
        "path" | "source" | "subfolder" | "directory" | "original"
    ) {
        Ok(location)
    } else {
        Err(format!(
            "[output_location_invalid] unsupported outputLocation `{location}`"
        ))
    }
}

fn normalize_custom_output_file_name(
    value: &str,
    format: CompressionFormat,
) -> Result<String, String> {
    if value.is_empty() || value.trim() != value {
        return Err(
            "[output_file_name_invalid] outputFileName must be a non-empty file name".into(),
        );
    }
    if value.len() > 255
        || value.chars().any(char::is_control)
        || value.contains(['/', '\\'])
        || value
            .chars()
            .any(|character| matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        || value.starts_with('.')
        || value == "."
        || value == ".."
        || value.ends_with(['.', ' '])
    {
        return Err(
            "[output_file_name_invalid] outputFileName must be a single safe file name".into(),
        );
    }
    let path = Path::new(value);
    let extension = path.extension().and_then(|extension| extension.to_str());
    if let Some(extension) = extension {
        if !extension.eq_ignore_ascii_case(format.extension()) {
            return Err(format!(
                "[output_file_name_invalid] outputFileName must use the .{} extension",
                format.extension()
            ));
        }
    }
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| {
            "[output_file_name_invalid] outputFileName is not valid Unicode".to_string()
        })?;
    let normalized = format!("{stem}.{}", format.extension());
    if path_security::is_reserved_windows_name(&normalized) {
        return Err(
            "[output_file_name_invalid] outputFileName uses a reserved Windows name".into(),
        );
    }
    Ok(normalized)
}

fn resolve_final_output_path(request: &CompressionRequest) -> Result<PathBuf, String> {
    let output_path = resolve_output_path(request)?;
    let location = normalize_output_location(request.metadata.output_location.as_deref())?;
    if !request.metadata.auto_sequence && !request.metadata.auto_rename
        || request.metadata.overwrite_existing
        || request.metadata.replace_original
        || location == "original"
    {
        return Ok(output_path);
    }
    choose_auto_rename_path(output_path)
}

fn choose_auto_rename_path(output_path: PathBuf) -> Result<PathBuf, String> {
    choose_auto_rename_path_with_limit(output_path, MAX_AUTO_RENAME_ATTEMPTS)
}

fn choose_auto_rename_path_with_limit(
    output_path: PathBuf,
    max_attempts: usize,
) -> Result<PathBuf, String> {
    if !output_path.exists() {
        return Ok(output_path);
    }
    let parent = output_path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = output_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "compression output file has no valid file name".to_string())?;
    let source = Path::new(file_name);
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "compression output file has no valid stem".to_string())?;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();

    for index in 1..=max_attempts {
        let candidate = parent.join(format!("{stem}_{index}{extension}"));
        path_security::validate_output_path(&candidate)
            .map_err(|error| format!("invalid compression auto-rename path: {error:?}"))?;
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => continue,
            Ok(_) => {
                return Err(format!(
                    "compression auto-rename candidate is not a regular file: {}",
                    candidate.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Err(error) => {
                return Err(format!(
                    "failed to inspect compression auto-rename candidate {}: {error}",
                    candidate.display()
                ));
            }
        }
    }
    Err(format!(
        "compression auto-rename exhausted {} candidates",
        max_attempts
    ))
}

fn existing_preflight_output_directory(output_path: &Path) -> Result<PathBuf, String> {
    let requested_directory = output_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut directory = requested_directory;
    loop {
        let metadata = match fs::symlink_metadata(directory) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let Some(parent) = directory.parent() else {
                    return Err(format!(
                        "[preflight_output_directory_missing] no existing ancestor for output directory: {}",
                        requested_directory.display()
                    ));
                };
                if parent == directory {
                    return Err(format!(
                        "[preflight_output_directory_missing] no existing ancestor for output directory: {}",
                        requested_directory.display()
                    ));
                }
                directory = parent;
                continue;
            }
            Err(error) => {
                return Err(format!(
                    "[preflight_output_directory_unreadable] cannot inspect output directory `{}`: {error}",
                    directory.display()
                ));
            }
        };
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || path_security::has_reparse_point(&metadata)
        {
            return Err(format!(
                "[preflight_output_directory_invalid] output path parent is not a regular directory: {}",
                directory.display()
            ));
        }
        if metadata.permissions().readonly() {
            return Err(format!(
                "[preflight_output_directory_not_writable] output directory is read-only: {}",
                directory.display()
            ));
        }
        return Ok(directory.to_path_buf());
    }
}

fn validate_preflight_output_directory(output_path: &Path) -> Result<(), String> {
    existing_preflight_output_directory(output_path).map(|_| ())
}

fn estimate_preflight_required_space(request: &CompressionRequest) -> Option<u64> {
    let input_bytes = request.input.len() as u64;
    let candidate_slots = (request.max_candidates as u64).checked_add(1)?;
    let candidate_bytes = (MAX_OUTPUT_BYTES as u64).checked_mul(candidate_slots)?;
    input_bytes.checked_add(candidate_bytes)
}

fn ensure_preflight_available_space(
    output_path: &Path,
    required_bytes: Option<u64>,
) -> Result<(), String> {
    let Some(required_bytes) = required_bytes else {
        return Ok(());
    };
    let directory = existing_preflight_output_directory(output_path)?;
    let Some(available_bytes) = query_available_space(&directory) else {
        return Ok(());
    };
    evaluate_preflight_available_space(Some(available_bytes), required_bytes)
}

fn evaluate_preflight_available_space(
    available_bytes: Option<u64>,
    required_bytes: u64,
) -> Result<(), String> {
    let Some(available_bytes) = available_bytes else {
        return Ok(());
    };
    if available_bytes < required_bytes {
        return Err(format!(
            "{PREFLIGHT_SPACE_ERROR_CODE} insufficient available disk space for compression: required at least {required_bytes} bytes, available {available_bytes} bytes"
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn query_available_space(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    wide.push(0);
    let mut available = 0u64;
    let success = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (success != 0).then_some(available)
}

#[cfg(unix)]
fn query_available_space(path: &Path) -> Option<u64> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats = unsafe { std::mem::zeroed::<libc::statvfs>() };
    let success = unsafe { libc::statvfs(path.as_ptr(), &mut stats) } == 0;
    success.then(|| (stats.f_bavail as u64).checked_mul(stats.f_frsize as u64))?
}

#[cfg(not(any(unix, windows)))]
fn query_available_space(_path: &Path) -> Option<u64> {
    None
}

fn resolve_preflight_output_path(request: &CompressionRequest) -> Result<PathBuf, String> {
    let output_path = resolve_final_output_path(request)
        .map_err(|error| format!("[preflight_output_path_invalid] {error}"))?;
    validate_preflight_output_directory(&output_path)?;
    Ok(output_path)
}

fn default_name(file_name: &str, format: CompressionFormat) -> String {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("image");
    format!("{stem}.{}", format.extension())
}
fn with_extension(mut path: PathBuf, extension: &str) -> PathBuf {
    path.set_extension(extension);
    path
}
fn checkpoint(job: &Arc<CompressionJob>) -> Result<(), String> {
    if job.cancelled.load(Ordering::Acquire) {
        Err(fail_message(job, "compression cancelled".to_string()))
    } else {
        Ok(())
    }
}

fn cancel_job(job: &Arc<CompressionJob>) -> Result<CompressionProgress, String> {
    let is_terminal = job
        .progress
        .lock()
        .map(|progress| {
            matches!(
                progress.status.as_str(),
                "completed" | "skipped" | "failed" | "cancelled"
            )
        })
        .unwrap_or(true);
    if !is_terminal {
        job.cancelled.store(true, Ordering::Release);
        update_progress(job, CompressionStage::Cancelling, None, None);
    }
    job.progress
        .lock()
        .map_err(|_| "compression progress is unavailable".to_string())
        .map(|progress| progress.clone())
}

fn fail_message(job: &Arc<CompressionJob>, message: String) -> String {
    update_progress(
        job,
        if job.cancelled.load(Ordering::Acquire) {
            CompressionStage::Cancelled
        } else {
            CompressionStage::Failed
        },
        None,
        Some(message.clone()),
    );
    message
}
fn update_progress(
    job: &Arc<CompressionJob>,
    stage: CompressionStage,
    output_path: Option<String>,
    error: Option<String>,
) {
    if let Ok(mut progress) = job.progress.lock() {
        if stage == CompressionStage::Cancelling
            && matches!(
                progress.status.as_str(),
                "completed" | "failed" | "cancelled"
            )
        {
            return;
        }
        progress.stage = stage.as_str().into();
        progress.status = match stage {
            CompressionStage::Completed => "completed",
            CompressionStage::Skipped => "skipped",
            CompressionStage::Cancelled => "cancelled",
            CompressionStage::Failed => "failed",
            CompressionStage::Cancelling => "cancelling",
            _ => "running",
        }
        .to_string();
        if output_path.is_some() {
            progress.output_path = output_path;
        }
        progress.error = error;
        progress.code = progress
            .error
            .as_deref()
            .map(|message| classify_error_code(stage, message).as_str().into());
        if stage.is_terminal() {
            if let Ok(mut terminal_at) = job.terminal_at.lock() {
                *terminal_at = Some(Instant::now());
            }
        }
    }
}

fn update_progress_bytes(
    job: &Arc<CompressionJob>,
    input_bytes: Option<u64>,
    output_bytes: Option<u64>,
) {
    if let Ok(mut progress) = job.progress.lock() {
        if input_bytes.is_some() {
            progress.input_bytes = input_bytes;
        }
        if output_bytes.is_some() {
            progress.output_bytes = output_bytes;
        }
    }
}

fn classify_error_code(stage: CompressionStage, message: &str) -> CompressionErrorCode {
    if stage == CompressionStage::Skipped {
        return CompressionErrorCode::Skipped;
    }
    if matches!(
        stage,
        CompressionStage::Cancelled | CompressionStage::Cancelling
    ) {
        return CompressionErrorCode::Cancelled;
    }
    let lower = message.to_ascii_lowercase();
    if lower.contains("metadatapolicy=preserve")
        || lower.contains("metadatapolicy=stripsafe")
        || lower.contains("metadatapolicy=stripall")
    {
        return CompressionErrorCode::MetadataPolicyUnsupported;
    }
    if lower.contains("decode")
        || lower.contains("inspect input")
        || lower.contains("inspect gif input")
        || lower.contains("dimensions")
        || lower.contains("opaque")
        || lower.contains("animated gif input")
        || lower.contains("animated webp input")
        || lower.contains("invalid webp container")
        || lower.contains("invalid webp chunk")
    {
        return CompressionErrorCode::Decode;
    }
    if lower.contains("path")
        || lower.contains("directory")
        || lower.contains("output file")
        || lower.contains("write")
        || lower.contains("bak")
        || lower.contains("publish")
    {
        return CompressionErrorCode::Publish;
    }
    CompressionErrorCode::Encode
}
fn uuid_like_id() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageBuffer, ImageOutputFormat, Luma, Rgba};

    fn png_input() -> Vec<u8> {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(2, 2, Rgba([255, 0, 0, 255])));
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), ImageOutputFormat::Png)
            .unwrap();
        bytes
    }

    fn png_chunk(name: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut crc = 0xffff_ffffu32;
        for byte in name.iter().chain(data) {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        let mut chunk = Vec::new();
        chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
        chunk.extend_from_slice(name);
        chunk.extend_from_slice(data);
        chunk.extend_from_slice(&(crc ^ 0xffff_ffff).to_be_bytes());
        chunk
    }

    fn png_with_metadata_chunks_from(source: &[u8]) -> Vec<u8> {
        let end = source.len() - 12;
        let mut output = source[..end].to_vec();
        output.extend_from_slice(&png_chunk(b"iCCP", b"icc\0\0x\x9c\x03\0\0\0\0\0\x01"));
        output.extend_from_slice(&png_chunk(b"eXIf", b"Exif\0\0GPS"));
        output.extend_from_slice(&png_chunk(b"iTXt", b"XML:com.adobe.xmp\0\0\0\0\0<xmp/>"));
        output.extend_from_slice(&png_chunk(b"tEXt", b"Thumb\0thumbnail"));
        output.extend_from_slice(&png_chunk(b"zzZZ", b"unknown ancillary"));
        output.extend_from_slice(&source[end..]);
        output
    }

    fn png_with_metadata_chunks() -> Vec<u8> {
        png_with_metadata_chunks_from(&png_input())
    }

    fn animated_gif_input() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = gif::Encoder::new(&mut bytes, 1, 1, &[]).unwrap();
            encoder.set_repeat(gif::Repeat::Infinite).unwrap();
            for color in [[255, 0, 0], [0, 255, 0]] {
                let frame = gif::Frame {
                    width: 1,
                    height: 1,
                    buffer: vec![0].into(),
                    palette: Some(vec![color[0], color[1], color[2]]),
                    ..gif::Frame::default()
                };
                encoder.write_frame(&frame).unwrap();
            }
        }
        bytes
    }

    fn static_gif_input() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = gif::Encoder::new(&mut bytes, 1, 1, &[]).unwrap();
            let frame = gif::Frame {
                width: 1,
                height: 1,
                buffer: vec![0].into(),
                palette: Some(vec![255, 0, 0]),
                ..gif::Frame::default()
            };
            encoder.write_frame(&frame).unwrap();
        }
        bytes
    }

    fn jpeg_input() -> Vec<u8> {
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, 80)
            .encode_image(&DynamicImage::ImageRgba8(ImageBuffer::from_pixel(
                2,
                2,
                Rgba([255, 0, 0, 255]),
            )))
            .unwrap();
        bytes
    }

    fn jpeg_segment(marker: u8, payload: &[u8]) -> Vec<u8> {
        let length = u16::try_from(payload.len() + 2).unwrap();
        let mut segment = vec![0xff, marker];
        segment.extend_from_slice(&length.to_be_bytes());
        segment.extend_from_slice(payload);
        segment
    }

    fn jpeg_with_metadata_segments() -> (Vec<u8>, Vec<u8>) {
        let source = jpeg_input();
        let profile = b"EmbedPix ICC profile with two segments".to_vec();
        let split = 17;
        let mut input = source[..2].to_vec();
        input.extend_from_slice(&jpeg_segment(0xe1, b"Exif\0\0GPSLatitude=secret"));
        input.extend_from_slice(&jpeg_segment(
            0xe1,
            b"http://ns.adobe.com/xap/1.0/\0<xmp:CreatorTool>secret</xmp:CreatorTool>",
        ));
        input.extend_from_slice(&jpeg_segment(0xfe, b"private comment"));
        for (index, chunk) in profile.chunks(split).enumerate() {
            let mut payload = b"ICC_PROFILE\0".to_vec();
            payload.extend_from_slice(&[index as u8 + 1, 3]);
            payload.extend_from_slice(chunk);
            input.extend_from_slice(&jpeg_segment(0xe2, &payload));
        }
        input.extend_from_slice(&source[2..]);
        (input, profile)
    }

    fn jpeg_sof_markers(bytes: &[u8]) -> Vec<u8> {
        assert_eq!(&bytes[..2], &[0xff, 0xd8]);
        let mut markers = Vec::new();
        let mut offset = 2;
        while offset < bytes.len() {
            assert_eq!(bytes[offset], 0xff);
            while offset < bytes.len() && bytes[offset] == 0xff {
                offset += 1;
            }
            let marker = bytes[offset];
            offset += 1;
            if marker == 0xda || marker == 0xd9 {
                break;
            }
            if !matches!(marker, 0xd8 | 0xd9 | 0x01 | 0xd0..=0xd7) {
                let length = u16::from_be_bytes([bytes[offset], bytes[offset + 1]]) as usize;
                assert!(length >= 2);
                if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
                    markers.push(marker);
                }
                offset += length;
            }
        }
        markers
    }

    fn raw_payload(metadata: &str, input: &[u8]) -> Vec<u8> {
        let mut payload = Vec::from(*b"EGF1");
        payload.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
        payload.extend_from_slice(metadata.as_bytes());
        payload.extend_from_slice(input);
        payload
    }

    fn path_request(output_path: &Path) -> CompressionRequest {
        CompressionRequest {
            metadata: CompressionMetadata {
                schema_version: COMPRESSION_SCHEMA_VERSION,
                file_name: "sample.png".into(),
                output_file_name: None,
                output_format: "webp".into(),
                output_path: Some(output_path.to_string_lossy().into_owned()),
                output_location: Some("path".into()),
                source_path: None,
                output_directory: None,
                output_subdirectory: None,
                overwrite_existing: false,
                replace_original: false,
                delete_source: false,
                auto_sequence: false,
                auto_rename: false,
                jpeg_quality: None,
                jpeg_background: None,
                jpeg_progressive: false,
                jpeg_optimize_huffman: false,
                webp_method: None,
                webp_alpha_quality: None,
                webp_pass: None,
                webp_near_lossless: None,
                webp_lossless_method: None,
                lossless: Some(true),
                skip_if_larger: false,
                max_output_bytes: None,
                max_candidates: None,
                max_rgb_mae: None,
                target_resize_percent: None,
                auto_resize_to_target: false,
                max_input_bytes: None,
                png_optimization_level: Some(2),
                png_optimize_alpha: false,
                metadata_policy: MetadataPolicy::Strip,
                job_id: Some("auto-rename-test".into()),
            },
            input: png_input(),
            format: CompressionFormat::Webp,
            lossless: true,
            target_bytes: None,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            png_optimization_level: 2,
            png_optimize_alpha: false,
        }
    }

    fn test_job(job_id: &str) -> Arc<CompressionJob> {
        Arc::new(CompressionJob {
            cancelled: AtomicBool::new(false),
            progress: Mutex::new(CompressionProgress {
                job_id: job_id.into(),
                status: "running".into(),
                stage: CompressionStage::Preflight.as_str().into(),
                output_path: None,
                error: None,
                code: None,
                input_bytes: None,
                output_bytes: None,
            }),
            terminal_at: Mutex::new(None),
        })
    }

    fn luma_png_input(width: u32, height: u32) -> Vec<u8> {
        let image = DynamicImage::ImageLuma8(ImageBuffer::from_pixel(width, height, Luma([0])));
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), ImageOutputFormat::Png)
            .unwrap();
        bytes
    }

    fn lossy_webp_input() -> Vec<u8> {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_fn(64, 48, |x, y| {
            Rgba([
                (x.wrapping_mul(17) ^ y.wrapping_mul(11)) as u8,
                (x.wrapping_mul(7) ^ y.wrapping_mul(29)) as u8,
                (x.wrapping_mul(31) ^ y.wrapping_mul(3)) as u8,
                255,
            ])
        }));
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), ImageOutputFormat::Png)
            .unwrap();
        bytes
    }
    #[test]
    fn encodes_supported_formats_and_rejects_bad_input() {
        let input = png_input();
        for format in [
            CompressionFormat::Png,
            CompressionFormat::Jpeg,
            CompressionFormat::Webp,
        ] {
            let output = encode_image(&input, format, 80, 2).unwrap();
            assert!(!output.is_empty());
            assert!(decode_image(&output).is_ok());
        }
        assert!(decode_image(b"bad").is_err());
        assert!(decode_image(&[]).is_err());
    }

    #[test]
    fn rejects_animated_gif_and_webp_inputs_before_compression() {
        let gif_error = decode_image(&animated_gif_input()).unwrap_err();
        assert!(gif_error.contains("animated GIF input is not supported"));

        for marker in [b"ANIM", b"ANMF"] {
            let mut webp = b"RIFF\0\0\0\0WEBP".to_vec();
            webp.extend_from_slice(marker);
            webp.extend_from_slice(&6u32.to_le_bytes());
            webp.extend_from_slice(&[0; 6]);
            let size = (webp.len() - 8) as u32;
            webp[4..8].copy_from_slice(&size.to_le_bytes());
            let webp_error = decode_image(&webp).unwrap_err();
            assert!(webp_error.contains("animated WebP input is not supported"));
        }

        let mut truncated_chunk = b"RIFF\0\0\0\0WEBPTEST".to_vec();
        let truncated_size = (truncated_chunk.len() - 8) as u32;
        truncated_chunk[4..8].copy_from_slice(&truncated_size.to_le_bytes());
        assert!(reject_animation_input(&truncated_chunk).is_err());

        let mut oversized_chunk = b"RIFF\0\0\0\0WEBPTEST\x10\0\0\0\0".to_vec();
        let oversized_size = (oversized_chunk.len() - 8) as u32;
        oversized_chunk[4..8].copy_from_slice(&oversized_size.to_le_bytes());
        assert!(reject_animation_input(&oversized_chunk).is_err());

        let mut odd_with_padding = b"RIFF\0\0\0\0WEBPTEST\x01\0\0\0x\0".to_vec();
        let odd_with_padding_size = (odd_with_padding.len() - 8) as u32;
        odd_with_padding[4..8].copy_from_slice(&odd_with_padding_size.to_le_bytes());
        assert!(reject_animation_input(&odd_with_padding).is_ok());

        let mut odd_without_padding = b"RIFF\0\0\0\0WEBPTEST\x01\0\0\0x".to_vec();
        let odd_without_padding_size = (odd_without_padding.len() - 8) as u32;
        odd_without_padding[4..8].copy_from_slice(&odd_without_padding_size.to_le_bytes());
        assert!(reject_animation_input(&odd_without_padding).is_err());
    }

    #[test]
    fn lossless_webp_preserves_rgba_pixels_and_alpha() {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_fn(3, 2, |x, y| {
            Rgba([
                (x * 70 + y * 13) as u8,
                (y * 90 + x * 17) as u8,
                210,
                if x == 1 { 48 } else { 255 },
            ])
        }));
        let expected = image.to_rgba8().into_raw();
        let mut input = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut input), ImageOutputFormat::Png)
            .unwrap();

        let output = encode_image(&input, CompressionFormat::Webp, 80, 2).unwrap();
        let actual = decode_image(&output).unwrap().to_rgba8().into_raw();
        assert_eq!(actual, expected);
    }

    #[test]
    fn strip_safe_rgba_webp_accepts_libwebp_alpha_chunks() {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(2, 2, Rgba([20, 40, 60, 96])));
        let mut input = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut input), ImageOutputFormat::WebP)
            .unwrap();
        let output = encode_image_with_webp_method_alpha(
            &input,
            CompressionFormat::Webp,
            80,
            2,
            false,
            false,
            None,
            None,
            None,
            None,
            None,
            None,
            MetadataPolicy::StripSafe,
            JpegEncodingOptions::default(),
        )
        .unwrap();
        assert_eq!(decode_image(&output).unwrap().dimensions(), (2, 2));
    }

    #[test]
    fn png_optimization_preserves_alpha_and_rgba_pixels_at_all_levels() {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_fn(3, 2, |x, y| {
            Rgba([
                (x * 80 + y * 17) as u8,
                (y * 100 + x * 11) as u8,
                220,
                if x == 1 { 64 } else { 255 },
            ])
        }));
        let expected = image.to_rgba8().into_raw();
        let mut input = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut input), ImageOutputFormat::Png)
            .unwrap();
        for level in 0..=6 {
            let output = encode_image(&input, CompressionFormat::Png, 80, level).unwrap();
            let actual = decode_image(&output).unwrap().to_rgba8().into_raw();
            assert_eq!(
                actual, expected,
                "PNG optimization level {level} changed pixels"
            );
        }
        let output = encode_image_with_webp_method_alpha(
            &input,
            CompressionFormat::Png,
            80,
            2,
            true,
            true,
            None,
            None,
            None,
            None,
            None,
            None,
            MetadataPolicy::Strip,
            JpegEncodingOptions::default(),
        )
        .unwrap();
        assert_eq!(decode_image(&output).unwrap().dimensions(), (3, 2));
    }

    #[test]
    fn png_strip_safe_preserves_iccp_and_removes_metadata_and_unknown_chunks() {
        let input = png_with_metadata_chunks();
        let output = encode_image_with_webp_method_alpha(
            &input,
            CompressionFormat::Png,
            80,
            2,
            false,
            true,
            None,
            None,
            None,
            None,
            None,
            None,
            MetadataPolicy::StripSafe,
            JpegEncodingOptions::default(),
        )
        .unwrap();
        assert_eq!(decode_image(&output).unwrap().dimensions(), (2, 2));
        assert!(output.windows(4).any(|chunk| chunk == b"iCCP"));
        for removed in [b"eXIf".as_slice(), b"iTXt", b"tEXt", b"zzZZ"] {
            assert!(!output.windows(4).any(|chunk| chunk == removed));
        }
    }

    #[test]
    fn png_strip_safe_rejects_bad_chunk_crc() {
        let mut input = png_with_metadata_chunks();
        let crc = input.len() - 8;
        input[crc] ^= 1;
        let error = encode_image_with_webp_method_alpha(
            &input,
            CompressionFormat::Png,
            80,
            2,
            false,
            true,
            None,
            None,
            None,
            None,
            None,
            None,
            MetadataPolicy::StripSafe,
            JpegEncodingOptions::default(),
        )
        .unwrap_err();
        assert!(error.contains("strip-safe optimize png") || error.contains("decode"));
    }

    #[test]
    fn png_strip_safe_bad_crc_does_not_replace_existing_target() {
        let directory = crate::commands::test_temp_dir().join(format!(
            "embedpix-strip-safe-crc-publish-{}",
            uuid_like_id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let output = directory.join("existing.png");
        let original = b"existing target bytes";
        fs::write(&output, original).unwrap();

        let mut request = path_request(&output);
        request.metadata.output_format = "png".into();
        request.metadata.file_name = "existing.png".into();
        request.metadata.lossless = Some(true);
        request.metadata.overwrite_existing = true;
        request.metadata.metadata_policy = MetadataPolicy::StripSafe;
        request.input = {
            let mut input = png_with_metadata_chunks();
            let crc = input.len() - 8;
            input[crc] ^= 1;
            input
        };
        request.format = CompressionFormat::Png;
        request.lossless = true;

        let error = run_compression(&request, &test_job("strip-safe-crc-publish")).unwrap_err();
        assert!(error.contains("strip-safe optimize png") || error.contains("decode"));
        assert_eq!(fs::read(&output).unwrap(), original);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn png_strip_safe_preserves_rgba_pixels_and_alpha() {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_fn(3, 2, |x, y| {
            Rgba([
                (x * 61 + y * 17) as u8,
                (y * 83 + x * 13) as u8,
                211,
                match (x, y) {
                    (0, 0) => 0,
                    (1, 0) => 64,
                    (2, 0) => 128,
                    _ => 255,
                },
            ])
        }));
        let expected = image.to_rgba8();
        let mut source = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut source), ImageOutputFormat::Png)
            .unwrap();
        let input = png_with_metadata_chunks_from(&source);
        let output = encode_image_with_webp_method_alpha(
            &input,
            CompressionFormat::Png,
            80,
            2,
            false,
            true,
            None,
            None,
            None,
            None,
            None,
            None,
            MetadataPolicy::StripSafe,
            JpegEncodingOptions::default(),
        )
        .unwrap();
        let decoded = decode_image(&output).unwrap().to_rgba8();
        assert_eq!(decoded.dimensions(), expected.dimensions());
        assert_eq!(decoded, expected);
    }

    #[test]
    fn jpeg_composites_transparency_with_requested_background() {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(2, 2, Rgba([10, 20, 30, 0])));
        let mut input = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut input), ImageOutputFormat::Png)
            .unwrap();
        let output = encode_image_with_webp_method(
            &input,
            CompressionFormat::Jpeg,
            100,
            2,
            false,
            Some("#123456"),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let pixel = decode_image(&output).unwrap().to_rgb8().get_pixel(0, 0).0;
        assert!((i16::from(pixel[0]) - 0x12).abs() <= 3);
        assert!((i16::from(pixel[1]) - 0x34).abs() <= 3);
        assert!((i16::from(pixel[2]) - 0x56).abs() <= 3);
        assert!(encode_image_with_webp_method(
            &input,
            CompressionFormat::Jpeg,
            80,
            2,
            false,
            Some("#12"),
            None,
            None,
            None,
            None,
        )
        .is_err());
    }

    #[test]
    fn jpeg_quality_boundaries_encode_decodable_rgb_outputs() {
        let image = DynamicImage::ImageRgb8(ImageBuffer::from_fn(7, 5, |x, y| {
            image::Rgb([
                (x * 31 + y * 7) as u8,
                (y * 43 + x * 11) as u8,
                ((x * 17) ^ (y * 29)) as u8,
            ])
        }));
        let mut input = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut input), ImageOutputFormat::Png)
            .unwrap();

        for quality in [1, 100] {
            let output = encode_and_verify(
                &input,
                CompressionFormat::Jpeg,
                quality,
                2,
                false,
                7,
                5,
                false,
                None,
                None,
                None,
                None,
                None,
                None,
                MetadataPolicy::Strip,
                JpegEncodingOptions::default(),
            )
            .unwrap();
            let decoded = decode_image(&output).unwrap();
            assert_eq!(decoded.dimensions(), (7, 5));
            assert_eq!(decoded.color().channel_count(), 3);
            assert_eq!(decoded.to_rgb8().as_raw().len(), 7 * 5 * 3);
        }
    }

    #[test]
    fn compressed_output_verification_requires_the_requested_format() {
        let png = encode_image(&png_input(), CompressionFormat::Png, 82, 2).unwrap();
        assert_eq!(
            verify_compressed_output(&png, CompressionFormat::Png, 2, 2)
                .unwrap()
                .dimensions(),
            (2, 2)
        );
        let mismatch = verify_compressed_output(&png, CompressionFormat::Jpeg, 2, 2).unwrap_err();
        assert!(mismatch.contains("compressed output format does not match requested jpeg"));

        let invalid =
            verify_compressed_output(b"not an image", CompressionFormat::Webp, 2, 2).unwrap_err();
        assert!(invalid.contains("compressed output failed format verification"));
    }

    #[test]
    fn jpeg_formal_output_is_baseline_and_not_progressive() {
        let output = encode_image(&png_input(), CompressionFormat::Jpeg, 82, 2).unwrap();
        let markers = jpeg_sof_markers(&output);

        assert!(markers.contains(&0xc0));
        assert!(!markers.contains(&0xc2));
        assert!(decode_image(&output).is_ok());
    }

    #[test]
    fn jpeg_advanced_options_emit_progressive_and_optimized_outputs() {
        let progressive = encode_and_verify(
            &png_input(),
            CompressionFormat::Jpeg,
            82,
            2,
            false,
            2,
            2,
            false,
            None,
            None,
            None,
            None,
            None,
            None,
            MetadataPolicy::Strip,
            JpegEncodingOptions {
                progressive: true,
                optimize_huffman: false,
            },
        )
        .unwrap();
        let progressive_markers = jpeg_sof_markers(&progressive);
        assert!(progressive_markers.contains(&0xc2));
        assert!(!progressive_markers.contains(&0xc0));
        assert!(decode_image(&progressive).is_ok());

        let optimized = encode_and_verify(
            &png_input(),
            CompressionFormat::Jpeg,
            82,
            2,
            false,
            2,
            2,
            false,
            None,
            None,
            None,
            None,
            None,
            None,
            MetadataPolicy::Strip,
            JpegEncodingOptions {
                progressive: false,
                optimize_huffman: true,
            },
        )
        .unwrap();
        assert!(jpeg_sof_markers(&optimized).contains(&0xc0));
        assert!(decode_image(&optimized).is_ok());
        assert_ne!(
            optimized,
            encode_image(&png_input(), CompressionFormat::Jpeg, 82, 2).unwrap()
        );
    }

    #[test]
    fn jpeg_advanced_options_are_jpeg_only() {
        assert!(validate_jpeg_options(true, false, CompressionFormat::Png).is_err());
        assert!(validate_jpeg_options(false, true, CompressionFormat::Webp).is_err());
        assert!(validate_jpeg_options(true, true, CompressionFormat::Jpeg).is_ok());
    }

    #[test]
    fn jpeg_strip_safe_reassembles_icc_and_removes_private_metadata() {
        let (input, profile) = jpeg_with_metadata_segments();
        let output = encode_and_verify(
            &input,
            CompressionFormat::Jpeg,
            100,
            2,
            false,
            2,
            2,
            false,
            None,
            None,
            None,
            None,
            None,
            None,
            MetadataPolicy::StripSafe,
            JpegEncodingOptions::default(),
        )
        .unwrap();
        assert_eq!(&output[..3], &[0xff, 0xd8, 0xff]);
        assert_eq!(decode_image(&output).unwrap().dimensions(), (2, 2));
        assert_eq!(extract_jpeg_icc_profile(&output).unwrap(), Some(profile));
        assert!(!output.windows(5).any(|bytes| bytes == b"Exif\0"));
        assert!(!output.windows(4).any(|bytes| bytes == b"xmp:"));
        assert!(!output.windows(15).any(|bytes| bytes == b"private comment"));
    }

    #[test]
    fn jpeg_strip_safe_rejects_truncated_metadata_markers() {
        let (mut input, _) = jpeg_with_metadata_segments();
        input[4..6].copy_from_slice(&[0, 1]);
        let error = encode_and_verify(
            &input,
            CompressionFormat::Jpeg,
            82,
            2,
            false,
            2,
            2,
            false,
            None,
            None,
            None,
            None,
            None,
            None,
            MetadataPolicy::StripSafe,
            JpegEncodingOptions::default(),
        )
        .unwrap_err();
        assert!(error.contains("stripSafe JPEG") || error.contains("segment length"));
    }

    #[test]
    fn jpeg_input_to_webp_preserves_rgb_channels_and_dimensions() {
        let image = DynamicImage::ImageRgb8(ImageBuffer::from_fn(8, 6, |x, y| {
            image::Rgb([
                24u8.saturating_add((x * 19) as u8),
                48u8.saturating_add((y * 23) as u8),
                96u8.saturating_add(((x + y) * 11) as u8),
            ])
        }));
        let mut jpeg = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut jpeg), ImageOutputFormat::Jpeg(100))
            .unwrap();
        let webp = encode_image_with_webp_method(
            &jpeg,
            CompressionFormat::Webp,
            90,
            2,
            false,
            None,
            Some(4),
            None,
            None,
            None,
        )
        .unwrap();
        let decoded = decode_image(&webp).unwrap().to_rgb8();
        assert_eq!(decoded.dimensions(), (8, 6));
        let source = image.to_rgb8().get_pixel(3, 4).0;
        let actual = decoded.get_pixel(3, 4).0;
        for channel in 0..3 {
            assert!((i16::from(source[channel]) - i16::from(actual[channel])).abs() <= 32);
        }
    }

    #[test]
    fn jpeg_transparency_uses_background_and_publishes_output() {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(2, 2, Rgba([10, 20, 30, 64])));
        let mut input = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut input), ImageOutputFormat::Png)
            .unwrap();
        let output_path = crate::commands::test_temp_dir().join(format!(
            "embedpix-compression-transparent-jpeg-{}.jpg",
            uuid_like_id()
        ));
        let request = CompressionRequest {
            metadata: CompressionMetadata {
                schema_version: COMPRESSION_SCHEMA_VERSION,
                file_name: "transparent.png".into(),
                output_file_name: None,
                output_format: "jpeg".into(),
                output_path: Some(output_path.to_string_lossy().into_owned()),
                output_location: Some("path".into()),
                source_path: None,
                output_directory: None,
                output_subdirectory: None,
                overwrite_existing: false,
                replace_original: false,
                delete_source: false,
                auto_sequence: false,
                auto_rename: false,
                jpeg_quality: Some(80),
                jpeg_background: Some("#123456".into()),
                jpeg_progressive: false,
                jpeg_optimize_huffman: false,
                webp_method: None,
                webp_alpha_quality: None,
                webp_pass: None,
                webp_near_lossless: None,
                webp_lossless_method: None,
                lossless: Some(false),
                skip_if_larger: false,
                max_output_bytes: None,
                max_candidates: None,
                max_rgb_mae: None,
                target_resize_percent: None,
                auto_resize_to_target: false,
                max_input_bytes: None,
                png_optimization_level: Some(2),
                png_optimize_alpha: false,
                metadata_policy: MetadataPolicy::Strip,
                job_id: Some("transparent-jpeg-publish-test".into()),
            },
            input,
            format: CompressionFormat::Jpeg,
            lossless: false,
            target_bytes: None,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            png_optimization_level: 2,
            png_optimize_alpha: false,
        };
        let job = Arc::new(CompressionJob {
            cancelled: AtomicBool::new(false),
            progress: Mutex::new(CompressionProgress {
                job_id: "transparent-jpeg-publish-test".into(),
                status: "running".into(),
                stage: CompressionStage::Preflight.as_str().into(),
                output_path: None,
                error: None,
                code: None,
                input_bytes: None,
                output_bytes: None,
            }),
            terminal_at: Mutex::new(None),
        });

        let result = run_compression(&request, &job).unwrap();
        assert_eq!(result.status, "completed");
        assert_eq!(job.progress.lock().unwrap().status, "completed");
        assert!(output_path.exists());
        let decoded = image::load_from_memory(&fs::read(&output_path).unwrap())
            .unwrap()
            .to_rgb8();
        let pixel = decoded.get_pixel(0, 0).0;
        assert!((i16::from(pixel[0]) - 0x12).abs() <= 20);
        assert!((i16::from(pixel[1]) - 0x34).abs() <= 20);
        assert!((i16::from(pixel[2]) - 0x56).abs() <= 20);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn validates_quality_and_metadata_policy() {
        assert!(CompressionFormat::parse("jpeg").is_ok());
        assert!(CompressionFormat::parse("bmp").is_err());
        assert!(!(1..=100).contains(&0));
        assert_eq!(MetadataPolicy::default(), MetadataPolicy::Strip);
    }

    #[test]
    fn max_rgb_mae_requires_finite_bounded_lossy_target_search() {
        for metadata in [
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":true,"maxOutputBytes":100000,"maxRgbMae":10}"#,
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":false,"maxRgbMae":10}"#,
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":false,"maxOutputBytes":100000,"maxRgbMae":256}"#,
        ] {
            assert!(parse_raw_payload(&raw_payload(metadata, &png_input())).is_err());
            assert!(parse_estimate_raw_payload(&raw_payload(metadata, &png_input())).is_err());
        }
        let valid = raw_payload(
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":false,"maxOutputBytes":100000,"maxCandidates":4,"maxRgbMae":10}"#,
            &png_input(),
        );
        assert_eq!(
            parse_raw_payload(&valid).unwrap().metadata.max_rgb_mae,
            Some(10.0)
        );
        let jpeg_valid = raw_payload(
            r#"{"fileName":"sample.png","outputFormat":"jpeg","lossless":false,"maxOutputBytes":100000,"maxCandidates":4,"maxRgbMae":10}"#,
            &png_input(),
        );
        assert_eq!(
            parse_raw_payload(&jpeg_valid).unwrap().metadata.max_rgb_mae,
            Some(10.0)
        );
    }

    #[test]
    fn rejects_lossy_png_mode_for_requests_and_estimates() {
        let metadata = r#"{"fileName":"sample.png","outputFormat":"png","lossless":false}"#;
        let payload = raw_payload(metadata, &png_input());
        assert!(parse_raw_payload(&payload)
            .unwrap_err()
            .contains("lossy compression is not supported for PNG"));
        assert!(parse_estimate_raw_payload(&payload)
            .unwrap_err()
            .contains("lossy compression is not supported for PNG"));
    }

    #[test]
    fn compression_schema_version_is_explicit_and_backward_compatible() {
        let legacy = raw_payload(
            r#"{"fileName":"sample.png","outputFormat":"png"}"#,
            &png_input(),
        );
        assert!(parse_raw_payload(&legacy).is_ok());
        assert!(parse_estimate_raw_payload(&legacy).is_ok());

        let current = raw_payload(
            r#"{"schemaVersion":1,"fileName":"sample.png","outputFormat":"png"}"#,
            &png_input(),
        );
        assert!(parse_raw_payload(&current).is_ok());
        assert!(parse_estimate_raw_payload(&current).is_ok());

        let unsupported = raw_payload(
            r#"{"schemaVersion":2,"fileName":"sample.png","outputFormat":"png"}"#,
            &png_input(),
        );
        assert!(parse_raw_payload(&unsupported)
            .unwrap_err()
            .contains("schemaVersion"));
        assert!(parse_estimate_raw_payload(&unsupported)
            .unwrap_err()
            .contains("schemaVersion"));
    }

    #[test]
    fn png_optimize_alpha_is_png_only_and_backward_compatible() {
        let legacy = parse_raw_payload(&raw_payload(
            r#"{"fileName":"sample.png","outputFormat":"png"}"#,
            &png_input(),
        ))
        .unwrap();
        assert!(!legacy.png_optimize_alpha);

        for metadata in [
            r#"{"fileName":"sample.png","outputFormat":"jpeg","pngOptimizeAlpha":true}"#,
            r#"{"fileName":"sample.png","outputFormat":"webp","pngOptimizeAlpha":true}"#,
        ] {
            let error = parse_raw_payload(&raw_payload(metadata, &png_input())).unwrap_err();
            assert!(error.contains("pngOptimizeAlpha is only supported for PNG"));
            let estimate_error =
                parse_estimate_raw_payload(&raw_payload(metadata, &png_input())).unwrap_err();
            assert!(estimate_error.contains("pngOptimizeAlpha is only supported for PNG"));
        }

        let enabled = parse_raw_payload(&raw_payload(
            r#"{"fileName":"sample.png","outputFormat":"png","pngOptimizeAlpha":true}"#,
            &png_input(),
        ))
        .unwrap();
        assert!(enabled.png_optimize_alpha);
        let estimate = parse_estimate_raw_payload(&raw_payload(
            r#"{"fileName":"sample.png","outputFormat":"png","pngOptimizeAlpha":true}"#,
            &png_input(),
        ))
        .unwrap();
        assert!(estimate.png_optimize_alpha);
    }

    #[test]
    fn validates_webp_method_contract_for_requests_and_estimates() {
        for method in [0, 6] {
            let metadata = format!(
                r#"{{"fileName":"sample.png","outputFormat":"webp","lossless":false,"webpMethod":{method}}}"#
            );
            let request = parse_raw_payload(&raw_payload(&metadata, &png_input())).unwrap();
            assert_eq!(request.metadata.webp_method, Some(method));
            let estimate =
                parse_estimate_raw_payload(&raw_payload(&metadata, &png_input())).unwrap();
            assert_eq!(estimate.metadata.webp_method, Some(method));
        }

        for metadata in [
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":false,"webpMethod":7}"#,
            r#"{"fileName":"sample.png","outputFormat":"png","webpMethod":4}"#,
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":true,"webpMethod":4}"#,
        ] {
            assert!(parse_raw_payload(&raw_payload(metadata, &png_input())).is_err());
            assert!(parse_estimate_raw_payload(&raw_payload(metadata, &png_input())).is_err());
        }
    }

    #[test]
    fn validates_webp_alpha_quality_contract_for_requests_and_estimates() {
        for alpha_quality in [0, 100] {
            let metadata = format!(
                r#"{{"fileName":"sample.png","outputFormat":"webp","lossless":false,"webpAlphaQuality":{alpha_quality}}}"#
            );
            let request = parse_raw_payload(&raw_payload(&metadata, &png_input())).unwrap();
            assert_eq!(request.metadata.webp_alpha_quality, Some(alpha_quality));
            let estimate =
                parse_estimate_raw_payload(&raw_payload(&metadata, &png_input())).unwrap();
            assert_eq!(estimate.metadata.webp_alpha_quality, Some(alpha_quality));
        }

        let legacy = parse_raw_payload(&raw_payload(
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":false}"#,
            &png_input(),
        ))
        .unwrap();
        assert_eq!(legacy.metadata.webp_alpha_quality, None);

        for metadata in [
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":false,"webpAlphaQuality":101}"#,
            r#"{"fileName":"sample.png","outputFormat":"png","webpAlphaQuality":50}"#,
            r#"{"fileName":"sample.png","outputFormat":"jpeg","webpAlphaQuality":50}"#,
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":true,"webpAlphaQuality":50}"#,
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":true,"webpNearLossless":90,"webpAlphaQuality":50}"#,
        ] {
            assert!(parse_raw_payload(&raw_payload(metadata, &png_input())).is_err());
            assert!(parse_estimate_raw_payload(&raw_payload(metadata, &png_input())).is_err());
        }
    }

    #[test]
    fn validates_webp_pass_contract_for_requests_and_estimates() {
        for pass in [1, 10] {
            let metadata = format!(
                r#"{{"fileName":"sample.png","outputFormat":"webp","lossless":false,"webpPass":{pass}}}"#
            );
            assert_eq!(
                parse_raw_payload(&raw_payload(&metadata, &png_input()))
                    .unwrap()
                    .metadata
                    .webp_pass,
                Some(pass)
            );
            assert_eq!(
                parse_estimate_raw_payload(&raw_payload(&metadata, &png_input()))
                    .unwrap()
                    .metadata
                    .webp_pass,
                Some(pass)
            );
        }
        for metadata in [
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":false,"webpPass":0}"#,
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":false,"webpPass":11}"#,
            r#"{"fileName":"sample.png","outputFormat":"png","webpPass":2}"#,
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":true,"webpPass":2}"#,
        ] {
            assert!(parse_raw_payload(&raw_payload(metadata, &png_input())).is_err());
            assert!(parse_estimate_raw_payload(&raw_payload(metadata, &png_input())).is_err());
        }
    }

    #[test]
    fn validates_webp_near_lossless_contract_for_requests_and_estimates() {
        let metadata = r#"{"fileName":"sample.png","outputFormat":"webp","lossless":true,"webpNearLossless":90}"#;
        let request = parse_raw_payload(&raw_payload(metadata, &png_input())).unwrap();
        assert_eq!(request.metadata.webp_near_lossless, Some(90));
        let estimate = parse_estimate_raw_payload(&raw_payload(metadata, &png_input())).unwrap();
        assert_eq!(estimate.metadata.webp_near_lossless, Some(90));

        for metadata in [
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":true,"webpNearLossless":0}"#,
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":true,"webpNearLossless":100}"#,
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":false,"webpNearLossless":90}"#,
            r#"{"fileName":"sample.png","outputFormat":"png","webpNearLossless":90}"#,
        ] {
            assert!(parse_raw_payload(&raw_payload(metadata, &png_input())).is_err());
            assert!(parse_estimate_raw_payload(&raw_payload(metadata, &png_input())).is_err());
        }
    }

    #[test]
    fn validates_webp_lossless_method_contract_for_requests_and_estimates() {
        let metadata = r#"{"fileName":"sample.png","outputFormat":"webp","lossless":true,"webpLosslessMethod":6}"#;
        let request = parse_raw_payload(&raw_payload(metadata, &png_input())).unwrap();
        assert_eq!(request.metadata.webp_lossless_method, Some(6));
        let estimate = parse_estimate_raw_payload(&raw_payload(metadata, &png_input())).unwrap();
        assert_eq!(estimate.metadata.webp_lossless_method, Some(6));

        for metadata in [
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":true,"webpLosslessMethod":7}"#,
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":false,"webpLosslessMethod":4}"#,
            r#"{"fileName":"sample.png","outputFormat":"png","webpLosslessMethod":4}"#,
        ] {
            assert!(parse_raw_payload(&raw_payload(metadata, &png_input())).is_err());
            assert!(parse_estimate_raw_payload(&raw_payload(metadata, &png_input())).is_err());
        }
    }

    #[test]
    fn validates_and_applies_lossy_target_resize_percent_across_paths() {
        let metadata = r#"{"fileName":"sample.png","outputFormat":"jpeg","lossless":false,"targetResizePercent":50}"#;
        let request = parse_raw_payload(&raw_payload(metadata, &png_input())).unwrap();
        assert_eq!(request.metadata.target_resize_percent, Some(50));
        let estimate_request =
            parse_estimate_raw_payload(&raw_payload(metadata, &png_input())).unwrap();
        assert_eq!(estimate_request.metadata.target_resize_percent, Some(50));

        let preview = run_preview(&request).unwrap();
        assert_eq!((preview.width, preview.height), (1, 1));
        let estimate = run_estimate(&estimate_request).unwrap();
        assert_eq!((estimate.width, estimate.height), (1, 1));
        assert_eq!(
            estimate.original_input_bytes,
            Some(png_input().len() as u64)
        );
        assert!(estimate.prepared_input_bytes.unwrap() > 0);

        let output_path = crate::commands::test_temp_dir()
            .join(format!("embedpix-target-resize-{}.jpg", uuid_like_id()));
        let formal_metadata = format!(
            "{{\"fileName\":\"sample.png\",\"outputFormat\":\"jpeg\",\"lossless\":false,\"targetResizePercent\":50,\"skipIfLarger\":false,\"outputPath\":\"{}\"}}",
            output_path.to_string_lossy().replace('\\', "/")
        );
        let formal_request =
            parse_raw_payload(&raw_payload(&formal_metadata, &png_input())).unwrap();
        let result = run_compression(&formal_request, &test_job("target-resize-formal")).unwrap();
        assert_eq!(result.original_input_bytes, Some(png_input().len() as u64));
        assert!(result.prepared_input_bytes.unwrap() > 0);
        assert_eq!((result.width, result.height), (1, 1));
        assert!(output_path.exists());
        fs::remove_file(output_path).unwrap();

        for metadata in [
            r#"{"fileName":"sample.png","outputFormat":"jpeg","targetResizePercent":9}"#,
            r#"{"fileName":"sample.png","outputFormat":"jpeg","targetResizePercent":101}"#,
            r#"{"fileName":"sample.png","outputFormat":"png","targetResizePercent":50}"#,
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":true,"targetResizePercent":50}"#,
        ] {
            assert!(parse_raw_payload(&raw_payload(metadata, &png_input())).is_err());
            assert!(parse_estimate_raw_payload(&raw_payload(metadata, &png_input())).is_err());
        }
    }

    #[test]
    fn automatic_target_resize_is_shared_and_never_publishes_unreachable_output() {
        let metadata = r#"{"fileName":"sample.png","outputFormat":"jpeg","lossless":false,"autoResizeToTarget":true,"maxOutputBytes":1,"maxCandidates":5,"skipIfLarger":false}"#;
        let request = parse_raw_payload(&raw_payload(metadata, &luma_png_input(64, 48))).unwrap();
        assert!(request.metadata.auto_resize_to_target);
        assert_eq!(request.metadata.target_resize_percent, None);

        let mut baseline = request.clone();
        baseline.metadata.auto_resize_to_target = false;
        baseline.metadata.max_output_bytes = None;
        baseline.target_bytes = None;
        let mut baseline_sizes = Vec::new();
        for percent in AUTO_RESIZE_PERCENT_CANDIDATES {
            let mut fixed = baseline.clone();
            fixed.metadata.target_resize_percent = Some(percent);
            let prepared = prepare_resize_request(&fixed, None).unwrap();
            let (width, height) = inspect_image(&prepared.input).unwrap();
            let selection =
                choose_encoded_output_with_cancellation(&prepared, width, height, None).unwrap();
            baseline_sizes.push((percent, selection.bytes.len() as u64));
        }
        let (target_bytes, expected_percent) = baseline_sizes
            .windows(2)
            .find_map(|pair| {
                (pair[1].1 < pair[0].1).then_some(((pair[0].1 + pair[1].1) / 2, pair[1].0))
            })
            .expect("automatic resize fixture must shrink at one candidate boundary");
        let reachable_metadata = format!(
            "{{\"fileName\":\"sample.png\",\"outputFormat\":\"jpeg\",\"lossless\":false,\"autoResizeToTarget\":true,\"maxOutputBytes\":{target_bytes},\"maxCandidates\":5,\"skipIfLarger\":false}}"
        );
        let reachable_request =
            parse_raw_payload(&raw_payload(&reachable_metadata, &luma_png_input(64, 48))).unwrap();
        let reachable_preview = run_preview(&reachable_request).unwrap();
        assert!(reachable_preview.target_met);
        assert_eq!(
            (reachable_preview.width, reachable_preview.height),
            (
                resize_dimension(64, expected_percent),
                resize_dimension(48, expected_percent)
            )
        );

        let preview = run_preview(&request).unwrap();
        assert_eq!(preview.status, "skipped");
        assert!(!preview.target_met);
        assert_eq!((preview.width, preview.height), (6, 5));
        assert!(preview.candidate_count.unwrap_or(0) <= 5);
        let estimate_request =
            parse_estimate_raw_payload(&raw_payload(metadata, &luma_png_input(64, 48))).unwrap();
        let estimate = run_estimate(&estimate_request).unwrap();
        assert_eq!(estimate.status, "skipped");
        assert_eq!((estimate.width, estimate.height), (6, 5));
        assert!(estimate.candidate_count.unwrap_or(0) <= 5);

        let output_path = crate::commands::test_temp_dir().join(format!(
            "embedpix-auto-resize-unreachable-{}.jpg",
            uuid_like_id()
        ));
        let formal_metadata = format!(
            "{{\"fileName\":\"sample.png\",\"outputFormat\":\"jpeg\",\"lossless\":false,\"autoResizeToTarget\":true,\"maxOutputBytes\":1,\"maxCandidates\":5,\"skipIfLarger\":false,\"outputPath\":\"{}\"}}",
            output_path.to_string_lossy().replace('\\', "/")
        );
        let formal_request =
            parse_raw_payload(&raw_payload(&formal_metadata, &luma_png_input(64, 48))).unwrap();
        let result =
            run_compression(&formal_request, &test_job("auto-resize-unreachable")).unwrap();
        assert_eq!(result.status, "skipped");
        assert!(!output_path.exists());

        for invalid in [
            r#"{"fileName":"sample.png","outputFormat":"jpeg","autoResizeToTarget":true}"#,
            r#"{"fileName":"sample.png","outputFormat":"png","autoResizeToTarget":true,"maxOutputBytes":100}"#,
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":true,"autoResizeToTarget":true,"maxOutputBytes":100}"#,
            r#"{"fileName":"sample.png","outputFormat":"jpeg","autoResizeToTarget":true,"targetResizePercent":50,"maxOutputBytes":100}"#,
        ] {
            assert!(parse_raw_payload(&raw_payload(invalid, &png_input())).is_err());
            assert!(parse_estimate_raw_payload(&raw_payload(invalid, &png_input())).is_err());
        }
    }

    #[test]
    fn validates_jpeg_background_contract_for_requests_and_estimates() {
        let metadata =
            r##"{"fileName":"sample.png","outputFormat":"jpeg","jpegBackground":"#123456"}"##;
        let request = parse_raw_payload(&raw_payload(metadata, &png_input())).unwrap();
        assert_eq!(request.metadata.jpeg_background.as_deref(), Some("#123456"));
        let estimate = parse_estimate_raw_payload(&raw_payload(metadata, &png_input())).unwrap();
        assert_eq!(
            estimate.metadata.jpeg_background.as_deref(),
            Some("#123456")
        );

        for metadata in [
            r##"{"fileName":"sample.png","outputFormat":"jpeg","jpegBackground":"#12"}"##,
            r##"{"fileName":"sample.png","outputFormat":"jpeg","jpegBackground":"123456"}"##,
            r##"{"fileName":"sample.png","outputFormat":"png","jpegBackground":"#123456"}"##,
        ] {
            assert!(parse_raw_payload(&raw_payload(metadata, &png_input())).is_err());
            assert!(parse_estimate_raw_payload(&raw_payload(metadata, &png_input())).is_err());
        }
    }

    #[test]
    fn compression_rejects_metadata_preserve_contract() {
        let metadata =
            br#"{"fileName":"sample.png","outputFormat":"webp","metadataPolicy":"preserve"}"#;
        let mut payload = Vec::from(*b"EGF1");
        payload.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
        payload.extend_from_slice(metadata);
        payload.extend_from_slice(&png_input());

        assert!(parse_raw_payload(&payload)
            .unwrap_err()
            .contains("metadataPolicy=preserve"));
        assert!(parse_estimate_raw_payload(&payload)
            .unwrap_err()
            .contains("metadataPolicy=preserve"));

        let metadata =
            r#"{"fileName":"sample.png","outputFormat":"webp","metadataPolicy":"stripSafe"}"#;
        let payload = raw_payload(metadata, &png_input());
        assert!(parse_raw_payload(&payload)
            .unwrap_err()
            .contains("static PNG, JPEG, or WebP input"));
        assert!(parse_estimate_raw_payload(&payload)
            .unwrap_err()
            .contains("static PNG, JPEG, or WebP input"));

        let png_safe = raw_payload(
            r#"{"fileName":"sample.png","outputFormat":"png","metadataPolicy":"stripSafe"}"#,
            &png_input(),
        );
        assert_eq!(
            parse_raw_payload(&png_safe)
                .unwrap()
                .metadata
                .metadata_policy,
            MetadataPolicy::StripSafe
        );
        assert_eq!(
            parse_estimate_raw_payload(&png_safe)
                .unwrap()
                .metadata
                .metadata_policy,
            MetadataPolicy::StripSafe
        );

        let estimate_payload = raw_payload(
            r#"{"fileName":"sample.png","outputFormat":"webp","lossless":false,"skipIfLarger":false,"metadataPolicy":"strip-all"}"#,
            &png_input(),
        );
        let estimate_request = parse_estimate_raw_payload(&estimate_payload).unwrap();
        assert_eq!(
            run_estimate(&estimate_request).unwrap().metadata_policy,
            "stripAll"
        );

        let output_path = crate::commands::test_temp_dir()
            .join(format!("embedpix-strip-all-{}.webp", uuid_like_id()));
        let output_metadata = format!(
            "{{\"fileName\":\"sample.png\",\"outputFormat\":\"webp\",\"outputPath\":\"{}\",\"lossless\":false,\"skipIfLarger\":false,\"metadataPolicy\":\"stripAll\"}}",
            output_path.to_string_lossy().replace('\\', "/")
        );
        let output_request =
            parse_raw_payload(&raw_payload(&output_metadata, &png_input())).unwrap();
        let output = run_compression(&output_request, &test_job("strip-all-output")).unwrap();
        assert_eq!(output.metadata_policy, "stripAll");
        assert!(output_path.exists());
        fs::remove_file(output_path).unwrap();
    }

    #[test]
    fn webp_strip_safe_round_trips_bounded_icc_across_preview_and_estimate() {
        let source =
            encode_image_with_mode(&png_input(), CompressionFormat::Webp, 82, 2, false).unwrap();
        let mut profile = vec![0; 128];
        profile[..4].copy_from_slice(&(128u32.to_be_bytes()));
        profile[36..40].copy_from_slice(b"acsp");
        let source = apply_webp_strip_safe(&source, Some(&profile)).unwrap();
        let metadata = r#"{"fileName":"sample.webp","outputFormat":"webp","lossless":false,"metadataPolicy":"stripSafe"}"#;
        let request = parse_raw_payload(&raw_payload(metadata, &source)).unwrap();
        let preview = run_preview(&request).unwrap();
        assert_eq!(
            extract_static_icc(&preview.data).unwrap(),
            Some(profile.clone())
        );
        let estimate = run_estimate(&request).unwrap();
        assert_eq!(estimate.metadata_policy, "strip-safe");
        assert_eq!(estimate.output_bytes, preview.output_bytes);
    }

    #[test]
    fn compression_rejects_source_deletion_without_a_desktop_source() {
        for metadata in [
            r#"{"fileName":"sample.png","outputFormat":"webp","deleteSource":true}"#,
            r#"{"fileName":"sample.png","outputFormat":"webp","sourcePath":"C:/sample.png","outputLocation":"original","deleteSource":true}"#,
            r#"{"fileName":"sample.png","outputFormat":"webp","sourcePath":"C:/sample.png","replaceOriginal":true,"deleteSource":true}"#,
        ] {
            assert!(parse_raw_payload(&raw_payload(metadata, &png_input()))
                .unwrap_err()
                .contains("deleteSource"));
        }
    }

    #[test]
    fn strip_policy_does_not_copy_jpeg_exif_into_any_supported_output() {
        let jpeg = encode_image(&png_input(), CompressionFormat::Jpeg, 82, 2).unwrap();
        let exif = b"Exif\0\0EmbedPix-test";
        let app1_length = u16::try_from(exif.len() + 2).unwrap().to_be_bytes();
        let mut source = vec![0xff, 0xd8, 0xff, 0xe1, app1_length[0], app1_length[1]];
        source.extend_from_slice(exif);
        source.extend_from_slice(&jpeg[2..]);
        assert!(decode_image(&source).is_ok());

        for format in [
            CompressionFormat::Png,
            CompressionFormat::Jpeg,
            CompressionFormat::Webp,
        ] {
            let output = encode_image_with_webp_method(
                &source,
                format,
                82,
                2,
                format != CompressionFormat::Jpeg,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            assert!(!output.windows(exif.len()).any(|window| window == exif));
            if format == CompressionFormat::Jpeg {
                assert!(!output.windows(2).any(|window| window == [0xff, 0xe1]));
            }
        }
    }

    #[test]
    fn preflight_rejects_unsafe_paths_with_stable_codes() {
        let traversal = raw_payload(
            r#"{"fileName":"sample.png","outputFormat":"webp","outputPath":"out/../escape.webp"}"#,
            &png_input(),
        );
        assert!(parse_raw_payload(&traversal).is_ok());
        let traversal_request = parse_raw_payload(&traversal).unwrap();
        let traversal_error = resolve_preflight_output_path(&traversal_request).unwrap_err();
        assert!(traversal_error.starts_with("[preflight_output_path_invalid]"));

        let reserved = raw_payload(
            r#"{"fileName":"sample.png","outputFormat":"webp","outputPath":"CON.webp"}"#,
            &png_input(),
        );
        let reserved_request = parse_raw_payload(&reserved).unwrap();
        assert!(resolve_preflight_output_path(&reserved_request)
            .unwrap_err()
            .starts_with("[preflight_output_path_invalid]"));

        let missing_directory = crate::commands::test_temp_dir()
            .join(format!("embedpix-preflight-missing-{}", uuid_like_id()));
        let missing_output = missing_directory.join("image.webp");
        let missing_request = CompressionRequest {
            metadata: CompressionMetadata {
                schema_version: COMPRESSION_SCHEMA_VERSION,
                file_name: "sample.png".into(),
                output_file_name: None,
                output_format: "webp".into(),
                output_path: Some(missing_output.to_string_lossy().into_owned()),
                output_location: Some("path".into()),
                source_path: None,
                output_directory: None,
                output_subdirectory: None,
                overwrite_existing: false,
                replace_original: false,
                delete_source: false,
                auto_sequence: false,
                auto_rename: false,
                jpeg_quality: None,
                jpeg_background: None,
                jpeg_progressive: false,
                jpeg_optimize_huffman: false,
                webp_method: None,
                webp_alpha_quality: None,
                webp_pass: None,
                webp_near_lossless: None,
                webp_lossless_method: None,
                lossless: Some(true),
                skip_if_larger: true,
                max_output_bytes: None,
                max_candidates: None,
                max_rgb_mae: None,
                target_resize_percent: None,
                auto_resize_to_target: false,
                max_input_bytes: None,
                png_optimization_level: Some(2),
                png_optimize_alpha: false,
                metadata_policy: MetadataPolicy::Strip,
                job_id: None,
            },
            input: png_input(),
            format: CompressionFormat::Webp,
            lossless: true,
            target_bytes: None,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            png_optimization_level: 2,
            png_optimize_alpha: false,
        };
        let missing_output = resolve_output_path(&missing_request).unwrap();
        validate_preflight_output_directory(&missing_output).unwrap();
        assert!(!missing_directory.exists());

        let invalid_parent = missing_directory.with_extension("file");
        fs::write(&invalid_parent, b"parent is not a directory").unwrap();
        let invalid_output = invalid_parent.join("image.webp");
        let invalid_error = validate_preflight_output_directory(&invalid_output).unwrap_err();
        assert!(invalid_error.starts_with("[preflight_output_directory_invalid]"));
        fs::remove_file(invalid_parent).unwrap();
    }

    #[test]
    fn preflight_detects_read_only_output_directory_without_mutating_it() {
        let directory = crate::commands::test_temp_dir()
            .join(format!("embedpix-preflight-readonly-{}", uuid_like_id()));
        fs::create_dir_all(&directory).unwrap();
        let original_permissions = fs::metadata(&directory).unwrap().permissions();
        let mut readonly_permissions = original_permissions.clone();
        readonly_permissions.set_readonly(true);
        fs::set_permissions(&directory, readonly_permissions).unwrap();

        let output = directory.join("image.webp");
        let error = validate_preflight_output_directory(&output).unwrap_err();
        assert!(error.starts_with("[preflight_output_directory_not_writable]"));
        assert!(!output.exists());

        fs::set_permissions(&directory, original_permissions).unwrap();
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn custom_output_file_name_is_safe_unicode_and_forces_target_extension() {
        assert_eq!(
            normalize_custom_output_file_name("旅行照片", CompressionFormat::Webp).unwrap(),
            "旅行照片.webp"
        );
        assert_eq!(
            normalize_custom_output_file_name("旅行照片.WEBP", CompressionFormat::Webp).unwrap(),
            "旅行照片.webp"
        );
        for invalid in [
            "",
            "   ",
            "../escape",
            r"nested\escape",
            "..",
            ".jpg",
            "CON.webp",
            "report.jpg",
            "unsafe:name.webp",
            "trailing.",
            "control\nname",
        ] {
            assert!(
                normalize_custom_output_file_name(invalid, CompressionFormat::Webp).is_err(),
                "expected custom output file name to be rejected: {invalid:?}"
            );
        }
    }

    #[test]
    fn custom_output_file_name_is_in_the_strict_metadata_contract() {
        let valid = raw_payload(
            r#"{"fileName":"sample.png","outputFormat":"webp","outputLocation":"directory","outputDirectory":".","outputFileName":"旅行照片"}"#,
            &png_input(),
        );
        let request = parse_raw_payload(&valid).unwrap();
        assert_eq!(
            request.metadata.output_file_name.as_deref(),
            Some("旅行照片")
        );

        let unknown = raw_payload(
            r#"{"fileName":"sample.png","outputFormat":"webp","outputLocation":"directory","outputDirectory":".","unexpected":true}"#,
            &png_input(),
        );
        assert!(parse_raw_payload(&unknown)
            .unwrap_err()
            .contains("unknown field"));
    }

    #[test]
    fn custom_output_file_name_resolves_without_writing_and_auto_sequences() {
        let directory = crate::commands::test_temp_dir()
            .join(format!("embedpix-custom-name-{}", uuid_like_id()));
        fs::create_dir_all(&directory).unwrap();
        let base = directory.join("旅行照片.webp");
        fs::write(&base, b"existing output").unwrap();

        let mut request = path_request(&directory.join("ignored.webp"));
        request.metadata.output_location = Some("directory".into());
        request.metadata.output_directory = Some(directory.to_string_lossy().into_owned());
        request.metadata.output_file_name = Some("旅行照片".into());
        request.metadata.auto_sequence = true;
        let resolved = resolve_preflight_output_path(&request).unwrap();

        assert_eq!(resolved, directory.join("旅行照片_1.webp"));
        assert!(!resolved.exists());
        assert_eq!(fs::read(&base).unwrap(), b"existing output");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn custom_output_file_name_rejects_path_and_original_replacement_modes() {
        let mut path_output_request = path_request(Path::new("output.webp"));
        path_output_request.metadata.output_file_name = Some("custom.webp".into());
        assert!(resolve_output_path(&path_output_request)
            .unwrap_err()
            .contains("outputFileName cannot be combined with outputPath"));

        let mut original_request = path_request(Path::new("output.webp"));
        original_request.metadata.output_location = Some("original".into());
        original_request.metadata.source_path = Some("source.webp".into());
        original_request.metadata.output_file_name = Some("custom.webp".into());
        assert!(resolve_output_path(&original_request)
            .unwrap_err()
            .contains("outputFileName cannot change the target"));

        let mut unknown_location_request = path_request(Path::new("output.webp"));
        unknown_location_request.metadata.output_location = Some("mystery".into());
        assert!(resolve_output_path(&unknown_location_request)
            .unwrap_err()
            .starts_with("[output_location_invalid]"));
    }

    #[test]
    fn preflight_space_guard_has_stable_error_and_allows_unknown_space() {
        let output = Path::new("compression-output.webp");
        assert!(ensure_preflight_available_space(output, None).is_ok());
        assert!(evaluate_preflight_available_space(None, u64::MAX).is_ok());
        assert!(evaluate_preflight_available_space(Some(100), 100).is_ok());

        let error = evaluate_preflight_available_space(Some(99), 100).unwrap_err();
        assert!(error.starts_with(PREFLIGHT_SPACE_ERROR_CODE));
        assert!(error.contains("required at least"));
        assert!(error.contains("available"));
    }

    #[test]
    fn preflight_required_space_uses_input_and_candidate_bounds() {
        let request = path_request(Path::new("compression-output.webp"));
        let required = estimate_preflight_required_space(&request).unwrap();
        let expected = request.input.len() as u64
            + (MAX_OUTPUT_BYTES as u64) * (request.max_candidates as u64 + 1);
        assert_eq!(required, expected);
    }

    #[test]
    fn available_space_query_does_not_create_or_modify_files() {
        let marker = crate::commands::test_temp_dir().join(format!(
            "embedpix-preflight-space-marker-{}",
            uuid_like_id()
        ));
        fs::write(&marker, b"keep me").unwrap();
        let before = fs::read(&marker).unwrap();
        let _ = query_available_space(marker.parent().unwrap());
        assert_eq!(fs::read(&marker).unwrap(), before);
        fs::remove_file(marker).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_available_space_query_is_supported_or_degrades_to_unknown() {
        let _ = query_available_space(Path::new("."));
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_available_space_query_is_supported_or_degrades_to_unknown() {
        let _ = query_available_space(Path::new("."));
    }

    #[test]
    fn preflight_preserves_existing_target_conflict_and_replace_original_contract() {
        let directory = crate::commands::test_temp_dir()
            .join(format!("embedpix-preflight-existing-{}", uuid_like_id()));
        fs::create_dir_all(&directory).unwrap();
        let output = directory.join("image.webp");
        let original = b"existing target";
        fs::write(&output, original).unwrap();
        let metadata = format!(
            "{{\"fileName\":\"sample.png\",\"outputFormat\":\"webp\",\"outputPath\":\"{}\"}}",
            output.to_string_lossy().replace('\\', "/")
        );
        let request = parse_raw_payload(&raw_payload(&metadata, &png_input())).unwrap();
        let output_path = resolve_output_path(&request).unwrap();
        validate_preflight_output_directory(&output_path).unwrap();
        assert!(output_path.exists());
        assert_eq!(fs::read(&output_path).unwrap(), original);

        let replace_without_source = raw_payload(
            r#"{"fileName":"sample.png","outputFormat":"webp","replaceOriginal":true}"#,
            &png_input(),
        );
        assert!(parse_raw_payload(&replace_without_source)
            .unwrap_err()
            .contains("replaceOriginal requires sourcePath"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn auto_rename_returns_final_preflight_path_and_publishes_there() {
        let directory = crate::commands::test_temp_dir()
            .join(format!("embedpix-auto-rename-{}", uuid_like_id()));
        fs::create_dir_all(&directory).unwrap();
        let output = directory.join("sample.webp");
        let first = directory.join("sample_1.webp");
        fs::write(&output, b"existing output").unwrap();
        fs::write(&first, b"existing sequence").unwrap();

        let mut request = path_request(&output);
        request.metadata.auto_sequence = true;
        let preflight_path = resolve_preflight_output_path(&request).unwrap();
        let expected = directory.join("sample_2.webp");
        assert_eq!(preflight_path, expected);
        assert_eq!(fs::read(&output).unwrap(), b"existing output");
        assert_eq!(fs::read(&first).unwrap(), b"existing sequence");
        assert!(!expected.exists());

        let result = run_compression(&request, &test_job("auto-rename-publish-test")).unwrap();
        assert_eq!(PathBuf::from(result.output_path), expected);
        assert!(expected.is_file());
        assert_eq!(fs::read(&output).unwrap(), b"existing output");
        assert_eq!(fs::read(&first).unwrap(), b"existing sequence");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn auto_rename_defaults_off_and_is_disabled_for_overwrite_or_original() {
        let directory = crate::commands::test_temp_dir()
            .join(format!("embedpix-auto-rename-contract-{}", uuid_like_id()));
        fs::create_dir_all(&directory).unwrap();
        let output = directory.join("sample.webp");
        fs::write(&output, b"existing output").unwrap();

        let request = path_request(&output);
        assert_eq!(resolve_final_output_path(&request).unwrap(), output);
        let error =
            run_compression(&request, &test_job("auto-rename-default-off-test")).unwrap_err();
        assert!(error.contains("output file already exists"));
        assert_eq!(fs::read(&output).unwrap(), b"existing output");

        let mut overwrite_request = path_request(&output);
        overwrite_request.metadata.auto_rename = true;
        overwrite_request.metadata.overwrite_existing = true;
        assert_eq!(
            resolve_final_output_path(&overwrite_request).unwrap(),
            output
        );

        let source = directory.join("source.webp");
        fs::write(&source, b"source").unwrap();
        let mut original_request = path_request(&output);
        original_request.metadata.auto_sequence = true;
        original_request.metadata.output_location = Some("original".into());
        original_request.metadata.source_path = Some(source.to_string_lossy().into_owned());
        assert_eq!(
            resolve_final_output_path(&original_request).unwrap(),
            source
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn auto_rename_rejects_unsafe_candidates_and_limits_attempts() {
        let directory = crate::commands::test_temp_dir()
            .join(format!("embedpix-auto-rename-limit-{}", uuid_like_id()));
        fs::create_dir_all(&directory).unwrap();
        let output = directory.join("sample.webp");
        fs::write(&output, b"existing output").unwrap();
        for index in 1..=2 {
            fs::write(
                directory.join(format!("sample_{index}.webp")),
                b"existing sequence",
            )
            .unwrap();
        }
        let error = choose_auto_rename_path_with_limit(output, 2).unwrap_err();
        assert!(error.contains("exhausted"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn auto_rename_keeps_windows_reserved_names_rejected() {
        let request = parse_raw_payload(&raw_payload(
            r#"{"fileName":"sample.png","outputFormat":"webp","outputPath":"CON.webp","autoSequence":true}"#,
            &png_input(),
        ))
        .unwrap();
        let error = resolve_final_output_path(&request).unwrap_err();
        assert!(error.contains("InvalidPath") || error.contains("invalid compression output path"));
    }

    #[cfg(unix)]
    #[test]
    fn auto_rename_rejects_symlink_candidate() {
        use std::os::unix::fs::symlink;

        let directory = crate::commands::test_temp_dir()
            .join(format!("embedpix-auto-rename-symlink-{}", uuid_like_id()));
        fs::create_dir_all(&directory).unwrap();
        let output = directory.join("sample.webp");
        let candidate = directory.join("sample_1.webp");
        let target = directory.join("target.webp");
        fs::write(&output, b"existing output").unwrap();
        fs::write(&target, b"target").unwrap();
        symlink(&target, &candidate).unwrap();

        let error = choose_auto_rename_path(output).unwrap_err();
        assert!(error.contains("auto-rename") || error.contains("symlink"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn compression_decodes_bytes_instead_of_trusting_filename_extension() {
        let metadata = br#"{"fileName":"photo.jpg","outputFormat":"webp"}"#;
        let mut payload = Vec::from(*b"EGF1");
        payload.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
        payload.extend_from_slice(metadata);
        payload.extend_from_slice(&png_input());

        let request = parse_raw_payload(&payload).unwrap();
        assert_eq!(decode_image(&request.input).unwrap().dimensions(), (2, 2));
        assert!(encode_image(&request.input, request.format, 80, 2).is_ok());
    }

    #[test]
    fn compression_rejects_empty_corrupt_oversized_and_over_budget_images() {
        assert!(decode_image(&[]).unwrap_err().contains("between 1 and"));
        assert!(decode_image(b"not an image").is_err());

        let mut truncated = png_input();
        truncated.truncate(truncated.len() / 2);
        assert!(decode_image(&truncated).is_err());

        let oversized_input = vec![0u8; MAX_INPUT_BYTES + 1];
        assert!(decode_image(&oversized_input)
            .unwrap_err()
            .contains("between 1 and 32 MiB"));

        let oversized_dimension = luma_png_input(MAX_IMAGE_DIMENSION + 1, 1);
        assert!(decode_image(&oversized_dimension)
            .unwrap_err()
            .contains("dimensions exceed"));

        let over_pixel_budget = luma_png_input(4_097, 4_097);
        assert!(decode_image(&over_pixel_budget)
            .unwrap_err()
            .contains("dimensions exceed"));
    }

    #[test]
    fn corrupted_png_jpeg_and_gif_fail_before_publishing_with_decode_code() {
        let mut png = png_input();
        png.truncate(png.len() / 2);
        let mut jpeg = jpeg_input();
        jpeg.truncate(jpeg.len() / 2);
        let mut gif = static_gif_input();
        gif.truncate(gif.len() / 2);

        for (name, input) in [("png", png), ("jpeg", jpeg), ("gif", gif)] {
            let output_path = crate::commands::test_temp_dir().join(format!(
                "embedpix-corrupt-input-{name}-{}.webp",
                uuid_like_id()
            ));
            let sentinel = format!("existing-{name}");
            fs::write(&output_path, sentinel.as_bytes()).unwrap();
            let request = CompressionRequest {
                input,
                ..path_request(&output_path)
            };
            let expected_error = decode_image(&request.input).unwrap_err();
            let job = test_job(&format!("corrupt-input-{name}"));

            let error = run_compression(&request, &job).unwrap_err();

            assert_eq!(error, expected_error);
            assert_eq!(fs::read(&output_path).unwrap(), sentinel.as_bytes());
            let progress = job.progress.lock().unwrap();
            assert_eq!(progress.error.as_deref(), Some(expected_error.as_str()));
            assert_eq!(progress.code.as_deref(), Some("decode"));
            drop(progress);
            fs::remove_file(output_path).unwrap();
        }
    }

    #[test]
    fn formal_results_trace_published_files_for_png_jpeg_and_static_webp() {
        let directory = crate::commands::test_temp_dir()
            .join(format!("embedpix-formal-result-trace-{}", uuid_like_id()));
        fs::create_dir_all(&directory).unwrap();
        let input = png_input();
        for (index, (format, options)) in [
            ("png", r#""lossless":true"#),
            (
                "jpeg",
                r##""lossless":false,"jpegQuality":90,"jpegBackground":"#ffffff""##,
            ),
            ("webp", r#""lossless":true"#),
        ]
        .into_iter()
        .enumerate()
        {
            let extension = if format == "jpeg" { "jpg" } else { format };
            let output_path = directory.join(format!("output-{index}.{extension}"));
            let metadata = format!(
                "{{\"fileName\":\"sample.png\",\"outputFormat\":\"{format}\",{options},\"skipIfLarger\":false,\"outputPath\":\"{}\",\"metadataPolicy\":\"strip\"}}",
                output_path.to_string_lossy().replace('\\', "/")
            );
            let request = parse_raw_payload(&raw_payload(&metadata, &input)).unwrap();
            let result =
                run_compression(&request, &test_job(&format!("formal-trace-{format}"))).unwrap();
            assert_eq!(result.status, "completed");
            assert_eq!(
                result.output_path.replace('/', "\\"),
                output_path.to_string_lossy()
            );
            assert_eq!(result.input_bytes, input.len() as u64);
            assert_eq!(
                result.output_bytes,
                fs::metadata(&output_path).unwrap().len()
            );
            assert_eq!(result.metadata_policy, "strip");
            let decoded = decode_image(&fs::read(&output_path).unwrap()).unwrap();
            assert_eq!(decoded.dimensions(), (2, 2));
            fs::remove_file(output_path).unwrap();
        }
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn skipped_formal_result_leaves_no_temporary_output() {
        let directory = crate::commands::test_temp_dir()
            .join(format!("embedpix-formal-result-skip-{}", uuid_like_id()));
        fs::create_dir_all(&directory).unwrap();
        let output_path = directory.join("output.jpg");
        let metadata = format!(
            "{{\"fileName\":\"sample.png\",\"outputFormat\":\"jpeg\",\"lossless\":false,\"jpegQuality\":100,\"maxOutputBytes\":1,\"maxCandidates\":1,\"outputPath\":\"{}\",\"metadataPolicy\":\"strip\"}}",
            output_path.to_string_lossy().replace('\\', "/")
        );
        let request = parse_raw_payload(&raw_payload(&metadata, &png_input())).unwrap();
        let result = run_compression(&request, &test_job("formal-trace-skip")).unwrap();
        assert_eq!(result.status, "skipped");
        assert!(result.skipped_reason.is_some());
        assert!(!output_path.exists());
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn configurable_input_limit_is_bounded_and_checked_before_encoding() {
        assert!(validate_max_input_bytes(Some(1024 * 1024 - 1)).is_err());
        assert_eq!(validate_max_input_bytes(Some(1024 * 1024)), Ok(1024 * 1024));
        assert_eq!(
            validate_max_input_bytes(Some(32 * 1024 * 1024)),
            Ok(MAX_INPUT_BYTES)
        );
        assert!(validate_max_input_bytes(Some(32 * 1024 * 1024 + 1)).is_err());
        let output_path = crate::commands::test_temp_dir()
            .join(format!("embedpix-input-limit-{}.png", uuid_like_id()));
        let metadata = format!(
            "{{\"fileName\":\"sample.png\",\"outputFormat\":\"png\",\"maxInputBytes\":1048576,\"outputPath\":\"{}\"}}",
            output_path.to_string_lossy().replace('\\', "/")
        );
        let error =
            parse_raw_payload(&raw_payload(&metadata, &vec![0u8; 1024 * 1024 + 1])).unwrap_err();
        assert!(error.contains("configured maxInputBytes"));
        assert!(!output_path.exists());
    }

    #[test]
    fn corrupt_input_does_not_publish_or_modify_an_existing_output() {
        let output_path = crate::commands::test_temp_dir().join(format!(
            "embedpix-compression-corrupt-{}.webp",
            uuid_like_id()
        ));
        let original = b"existing output";
        fs::write(&output_path, original).unwrap();
        let request = CompressionRequest {
            metadata: CompressionMetadata {
                schema_version: COMPRESSION_SCHEMA_VERSION,
                file_name: "broken.png".into(),
                output_file_name: None,
                output_format: "webp".into(),
                output_path: Some(output_path.to_string_lossy().into_owned()),
                output_location: Some("path".into()),
                source_path: None,
                output_directory: None,
                output_subdirectory: None,
                overwrite_existing: false,
                replace_original: false,
                delete_source: false,
                auto_sequence: false,
                auto_rename: false,
                jpeg_quality: None,
                jpeg_background: None,
                jpeg_progressive: false,
                jpeg_optimize_huffman: false,
                webp_method: None,
                webp_alpha_quality: None,
                webp_pass: None,
                webp_near_lossless: None,
                webp_lossless_method: None,
                lossless: Some(true),
                skip_if_larger: true,
                max_output_bytes: None,
                max_candidates: None,
                max_rgb_mae: None,
                target_resize_percent: None,
                auto_resize_to_target: false,
                max_input_bytes: None,
                png_optimization_level: Some(2),
                png_optimize_alpha: false,
                metadata_policy: MetadataPolicy::Strip,
                job_id: Some("corrupt-input-test".into()),
            },
            input: b"truncated image".to_vec(),
            format: CompressionFormat::Webp,
            lossless: true,
            target_bytes: None,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            png_optimization_level: 2,
            png_optimize_alpha: false,
        };
        let job = Arc::new(CompressionJob {
            cancelled: AtomicBool::new(false),
            progress: Mutex::new(CompressionProgress {
                job_id: "corrupt-input-test".into(),
                status: "running".into(),
                stage: CompressionStage::Preflight.as_str().into(),
                output_path: None,
                error: None,
                code: None,
                input_bytes: None,
                output_bytes: None,
            }),
            terminal_at: Mutex::new(None),
        });

        assert!(run_compression(&request, &job).is_err());
        assert_eq!(fs::read(&output_path).unwrap(), original);
        assert_eq!(job.progress.lock().unwrap().status, "failed");
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn successful_compression_deletes_source_only_after_publishing_output() {
        let root = crate::commands::test_temp_dir();
        let source_path = root.join(format!(
            "embedpix-compression-delete-source-{}.png",
            uuid_like_id()
        ));
        let output_path = root.join(format!(
            "embedpix-compression-delete-output-{}.webp",
            uuid_like_id()
        ));
        let input = png_input();
        fs::write(&source_path, &input).unwrap();
        let mut request = path_request(&output_path);
        request.metadata.source_path = Some(source_path.to_string_lossy().into_owned());
        request.metadata.delete_source = true;
        request.metadata.job_id = Some("delete-source-success".into());

        let result = run_compression(&request, &test_job("delete-source-success")).unwrap();

        assert_eq!(result.status, "completed");
        assert!(result.source_deleted);
        assert!(output_path.is_file());
        assert!(!source_path.exists());
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn skips_larger_output_without_publishing_and_reports_statistics() {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_fn(64, 64, |x, y| {
            Rgba([
                (x.wrapping_mul(37) ^ y.wrapping_mul(19)) as u8,
                (x.wrapping_mul(13) ^ y.wrapping_mul(47)) as u8,
                (x.wrapping_mul(71) ^ y.wrapping_mul(23)) as u8,
                255,
            ])
        }));
        let mut input = Vec::new();
        JpegEncoder::new_with_quality(&mut input, 10)
            .encode_image(&image.to_rgb8())
            .unwrap();
        let output_path = crate::commands::test_temp_dir()
            .join(format!("embedpix-compression-skip-{}.png", uuid_like_id()));
        let mut request = CompressionRequest {
            metadata: CompressionMetadata {
                schema_version: COMPRESSION_SCHEMA_VERSION,
                file_name: "sample.jpg".into(),
                output_file_name: None,
                output_format: "png".into(),
                output_path: Some(output_path.to_string_lossy().into_owned()),
                output_location: Some("path".into()),
                source_path: None,
                output_directory: None,
                output_subdirectory: None,
                overwrite_existing: false,
                replace_original: false,
                delete_source: false,
                auto_sequence: false,
                auto_rename: false,
                jpeg_quality: None,
                jpeg_background: None,
                jpeg_progressive: false,
                jpeg_optimize_huffman: false,
                webp_method: None,
                webp_alpha_quality: None,
                webp_pass: None,
                webp_near_lossless: None,
                webp_lossless_method: None,
                lossless: Some(true),
                skip_if_larger: true,
                max_output_bytes: None,
                max_candidates: None,
                max_rgb_mae: None,
                target_resize_percent: None,
                auto_resize_to_target: false,
                max_input_bytes: None,
                png_optimization_level: Some(2),
                png_optimize_alpha: false,
                metadata_policy: MetadataPolicy::Strip,
                job_id: Some("skip-test".into()),
            },
            input,
            format: CompressionFormat::Png,
            lossless: true,
            target_bytes: None,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            png_optimization_level: 2,
            png_optimize_alpha: false,
        };
        let job = Arc::new(CompressionJob {
            cancelled: AtomicBool::new(false),
            progress: Mutex::new(CompressionProgress {
                job_id: "skip-test".into(),
                status: "running".into(),
                stage: CompressionStage::Preflight.as_str().into(),
                output_path: None,
                error: None,
                code: None,
                input_bytes: None,
                output_bytes: None,
            }),
            terminal_at: Mutex::new(None),
        });
        let result = run_compression(&request, &job).unwrap();
        assert_eq!(result.status, "skipped");
        assert!(result.skipped_reason.is_some());
        assert!(result.saved_bytes < 0);
        assert!(!output_path.exists());

        let delete_source_path = crate::commands::test_temp_dir().join(format!(
            "embedpix-compression-delete-skip-{}.jpg",
            uuid_like_id()
        ));
        let delete_output_path = crate::commands::test_temp_dir().join(format!(
            "embedpix-compression-delete-skip-{}.png",
            uuid_like_id()
        ));
        fs::write(&delete_source_path, &request.input).unwrap();
        let mut delete_request = request.clone();
        delete_request.metadata.output_path = Some(delete_output_path.to_string_lossy().into());
        delete_request.metadata.source_path = Some(delete_source_path.to_string_lossy().into());
        delete_request.metadata.delete_source = true;
        delete_request.metadata.job_id = Some("delete-source-skip-test".into());
        let skipped_delete =
            run_compression(&delete_request, &test_job("delete-source-skip-test")).unwrap();
        assert_eq!(skipped_delete.status, "skipped");
        assert!(!skipped_delete.source_deleted);
        assert!(delete_source_path.is_file());
        assert!(!delete_output_path.exists());
        fs::remove_file(delete_source_path).unwrap();

        let source_path = crate::commands::test_temp_dir().join(format!(
            "embedpix-compression-replace-skip-{}.png",
            uuid_like_id()
        ));
        fs::write(&source_path, &request.input).unwrap();
        request.metadata.output_path = None;
        request.metadata.output_location = Some("original".into());
        request.metadata.source_path = Some(source_path.to_string_lossy().into_owned());
        request.metadata.replace_original = true;
        request.metadata.job_id = Some("replace-original-skip-test".into());
        let original_source = fs::read(&source_path).unwrap();
        let skipped_replace =
            run_compression(&request, &test_job("replace-original-skip")).unwrap();
        assert_eq!(skipped_replace.status, "skipped");
        assert_eq!(fs::read(&source_path).unwrap(), original_source);

        request.metadata.skip_if_larger = false;
        request.metadata.job_id = Some("replace-original-publish-test".into());
        let published_replace =
            run_compression(&request, &test_job("replace-original-publish")).unwrap();
        assert_eq!(published_replace.status, "completed");
        assert_eq!(PathBuf::from(published_replace.output_path), source_path);
        assert!(decode_image(&fs::read(&source_path).unwrap()).is_ok());

        fs::remove_file(source_path).unwrap();
    }

    #[test]
    fn compression_statistics_are_signed_for_larger_outputs() {
        assert_eq!(compression_statistics(100, 80), (20, 20.0));
        assert_eq!(compression_statistics(100, 120), (-20, -20.0));
    }

    #[test]
    fn active_job_ids_cannot_replace_each_other() {
        let state = CompressionJobState::default();
        let job = || {
            Arc::new(CompressionJob {
                cancelled: AtomicBool::new(false),
                progress: Mutex::new(CompressionProgress {
                    job_id: "duplicate-test".into(),
                    status: "running".into(),
                    stage: "encoding".into(),
                    output_path: None,
                    error: None,
                    code: None,
                    input_bytes: None,
                    output_bytes: None,
                }),
                terminal_at: Mutex::new(None),
            })
        };
        state.register("duplicate-test".into(), job()).unwrap();
        assert!(state.register("duplicate-test".into(), job()).is_err());
    }

    #[test]
    fn dropping_job_state_requests_cancellation_for_active_jobs() {
        let state = CompressionJobState::default();
        let job = test_job("shutdown-cancel");
        state
            .register("shutdown-cancel".into(), Arc::clone(&job))
            .unwrap();
        drop(state);
        assert!(job.cancelled.load(Ordering::Acquire));
        assert_eq!(job.progress.lock().unwrap().status, "cancelling");
    }

    #[test]
    fn active_job_registry_has_a_bounded_queue_but_terminal_jobs_do_not_consume_capacity() {
        let state = CompressionJobState::default();
        for index in 0..MAX_ACTIVE_COMPRESSION_JOBS {
            let job_id = format!("capacity-{index}");
            state.register(job_id.clone(), test_job(&job_id)).unwrap();
        }
        let rejected = state
            .register("capacity-overflow".into(), test_job("capacity-overflow"))
            .unwrap_err();
        assert!(rejected.contains("too many compression jobs"));

        let terminal = state
            .jobs
            .lock()
            .unwrap()
            .get("capacity-0")
            .cloned()
            .unwrap();
        update_progress(&terminal, CompressionStage::Completed, None, None);
        assert!(state
            .register("capacity-terminal".into(), test_job("capacity-terminal"))
            .is_ok());
    }

    #[test]
    fn terminal_job_ids_can_be_reused_and_expired_jobs_are_pruned() {
        let state = CompressionJobState::default();
        let terminal_job = || {
            Arc::new(CompressionJob {
                cancelled: AtomicBool::new(false),
                progress: Mutex::new(CompressionProgress {
                    job_id: "reusable-test".into(),
                    status: "completed".into(),
                    stage: "completed".into(),
                    output_path: None,
                    error: None,
                    code: None,
                    input_bytes: None,
                    output_bytes: None,
                }),
                terminal_at: Mutex::new(Some(Instant::now())),
            })
        };
        state
            .register("reusable-test".into(), terminal_job())
            .unwrap();
        assert!(state
            .register("reusable-test".into(), terminal_job())
            .is_ok());

        let expired = Arc::new(CompressionJob {
            cancelled: AtomicBool::new(false),
            progress: Mutex::new(CompressionProgress {
                job_id: "expired-test".into(),
                status: "failed".into(),
                stage: "failed".into(),
                output_path: None,
                error: Some("test failure".into()),
                code: Some("encode".into()),
                input_bytes: None,
                output_bytes: None,
            }),
            terminal_at: Mutex::new(Some(
                Instant::now() - JOB_RETENTION - Duration::from_secs(1),
            )),
        });
        state.register("expired-test".into(), expired).unwrap();
        state.prune();
        let jobs = state.jobs.lock().unwrap();
        assert!(jobs.contains_key("reusable-test"));
        assert!(!jobs.contains_key("expired-test"));
    }

    #[test]
    fn cancelled_job_id_can_be_reused_after_reaching_terminal_state() {
        let state = CompressionJobState::default();
        let cancelled = test_job("cancel-reuse-test");
        state
            .register("cancel-reuse-test".into(), Arc::clone(&cancelled))
            .unwrap();

        assert_eq!(cancel_job(&cancelled).unwrap().status, "cancelling");
        assert!(state
            .register("cancel-reuse-test".into(), test_job("cancel-reuse-test"))
            .is_err());

        update_progress(
            &cancelled,
            CompressionStage::Cancelled,
            None,
            Some("compression cancelled".into()),
        );
        assert!(state
            .register("cancel-reuse-test".into(), test_job("cancel-reuse-test"))
            .is_ok());
    }

    #[test]
    fn repeated_compression_cancellation_is_idempotent_after_terminal_state() {
        let job = Arc::new(CompressionJob {
            cancelled: AtomicBool::new(false),
            progress: Mutex::new(CompressionProgress {
                job_id: "cancel-idempotent".into(),
                status: "running".into(),
                stage: "encoding".into(),
                output_path: None,
                error: None,
                code: None,
                input_bytes: None,
                output_bytes: None,
            }),
            terminal_at: Mutex::new(None),
        });

        assert_eq!(cancel_job(&job).unwrap().status, "cancelling");
        assert_eq!(cancel_job(&job).unwrap().status, "cancelling");
        update_progress(
            &job,
            CompressionStage::Completed,
            Some("output.webp".into()),
            None,
        );
        let progress = cancel_job(&job).unwrap();
        assert_eq!(progress.status, "completed");
        assert_eq!(progress.stage, "completed");
        assert_eq!(progress.output_path.as_deref(), Some("output.webp"));
    }

    #[test]
    fn preview_completion_is_terminal_and_job_id_can_be_reused() {
        let state = CompressionJobState::default();
        let job = test_job("preview-completed");
        state
            .register("preview-completed".into(), Arc::clone(&job))
            .unwrap();
        update_progress(&job, CompressionStage::Completed, None, None);

        assert_eq!(cancel_job(&job).unwrap().status, "completed");
        assert_eq!(cancel_job(&job).unwrap().status, "completed");
        assert!(state
            .register("preview-completed".into(), test_job("preview-completed"))
            .is_ok());
    }

    #[test]
    fn compression_semaphore_releases_slots_after_encoding() {
        let semaphore = Arc::new(CompressionSemaphore {
            available: Mutex::new(2),
            wake: Condvar::new(),
        });
        let first = semaphore.acquire();
        let second = semaphore.acquire();
        assert_eq!(*semaphore.available.lock().unwrap(), 0);
        drop(first);
        assert_eq!(*semaphore.available.lock().unwrap(), 1);
        drop(second);
        assert_eq!(*semaphore.available.lock().unwrap(), 2);
    }

    #[test]
    fn encoder_slot_helper_blocks_a_third_preview_or_estimate_task() {
        let semaphore = Arc::new(CompressionSemaphore {
            available: Mutex::new(2),
            wake: Condvar::new(),
        });
        let first = semaphore.acquire();
        let second = semaphore.acquire();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let worker_semaphore = Arc::clone(&semaphore);
        let worker = std::thread::spawn(move || {
            run_with_encoder_slot(worker_semaphore, || {
                started_tx.send(()).unwrap();
                7
            })
        });

        assert!(started_rx.recv_timeout(Duration::from_millis(50)).is_err());
        drop(first);
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        drop(second);
        assert_eq!(worker.join().unwrap(), 7);
    }

    #[test]
    fn queued_compression_slot_wait_honors_cancellation() {
        let semaphore = Arc::new(CompressionSemaphore {
            available: Mutex::new(0),
            wake: Condvar::new(),
        });
        let job = test_job("queued-cancel");
        let worker_semaphore = Arc::clone(&semaphore);
        let worker_job = Arc::clone(&job);
        let worker = std::thread::spawn(move || worker_semaphore.acquire_cancellable(&worker_job));

        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline {
            if job.progress.lock().unwrap().stage == "queued" {
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(job.progress.lock().unwrap().stage, "queued");
        assert_eq!(cancel_job(&job).unwrap().status, "cancelling");
        let result = worker.join().unwrap();
        match result {
            Err(error) => assert_eq!(error, "compression cancelled"),
            Ok(_) => panic!("queued compression slot unexpectedly acquired after cancellation"),
        }
        assert_eq!(job.progress.lock().unwrap().status, "cancelled");
    }

    #[test]
    fn cancelled_candidate_search_stops_before_encoding_and_keeps_terminal_state() {
        let mut request = path_request(Path::new("cancelled-candidate.webp"));
        request.input = lossy_webp_input();
        request.format = CompressionFormat::Webp;
        request.lossless = false;
        request.target_bytes = Some(1);
        request.max_candidates = MAX_CANDIDATES;
        request.metadata.output_format = "webp".into();
        request.metadata.lossless = Some(false);
        let job = test_job("cancelled-candidate-search");
        job.cancelled.store(true, Ordering::Release);

        let error =
            choose_encoded_output_with_cancellation(&request, 64, 48, Some(&job)).unwrap_err();
        assert_eq!(error, "compression cancelled");
        let progress = job.progress.lock().unwrap().clone();
        assert_eq!(progress.status, "cancelled");
        assert_eq!(progress.stage, "cancelled");
        assert!(progress.output_path.is_none());
    }

    #[test]
    fn cancelled_preview_slot_acquisition_returns_the_permit_for_reuse() {
        let semaphore = Arc::new(CompressionSemaphore {
            available: Mutex::new(1),
            wake: Condvar::new(),
        });
        let job = test_job("preview-slot-cancel");
        job.cancelled.store(true, Ordering::Release);

        assert!(semaphore.acquire_cancellable(&job).is_err());
        assert_eq!(*semaphore.available.lock().unwrap(), 1);
        let permit = semaphore.acquire();
        drop(permit);
        assert_eq!(*semaphore.available.lock().unwrap(), 1);
    }

    #[test]
    fn progress_error_codes_are_stable_without_changing_error_text() {
        assert_eq!(
            classify_error_code(CompressionStage::Failed, "failed to decode input image").as_str(),
            "decode"
        );
        for message in [
            "failed to inspect input image: unknown format",
            "failed to read image dimensions: invalid PNG signature",
            "failed to decode input image: invalid JPEG data",
            "failed to inspect GIF input: unexpected end of file",
            "input image dimensions exceed the compression limit",
        ] {
            assert_eq!(
                classify_error_code(CompressionStage::Failed, message).as_str(),
                "decode"
            );
        }
        for message in [
            "animated GIF input is not supported; provide a static GIF",
            "animated WebP input is not supported; provide a static WebP",
            "invalid WebP container length",
            "invalid WebP chunk layout",
            "invalid WebP chunk padding",
        ] {
            assert_eq!(
                classify_error_code(CompressionStage::Failed, message).as_str(),
                "decode"
            );
            let job = test_job("animated-input-error-code");
            assert_eq!(fail_message(&job, message.into()), message);
            assert_eq!(job.progress.lock().unwrap().code.as_deref(), Some("decode"));
        }
        assert_eq!(
            classify_error_code(CompressionStage::Failed, "failed to write output file").as_str(),
            "publish"
        );
        assert_eq!(
            classify_error_code(CompressionStage::Failed, "failed to optimize png").as_str(),
            "encode"
        );
        assert_eq!(
            classify_error_code(
                CompressionStage::Failed,
                "failed to inspect compressed output"
            )
            .as_str(),
            "encode"
        );
        assert_eq!(
            classify_error_code(CompressionStage::Cancelled, "compression cancelled").as_str(),
            "cancelled"
        );
        assert_eq!(
            classify_error_code(
                CompressionStage::Failed,
                "metadataPolicy=preserve is not supported by first-stage compression"
            )
            .as_str(),
            "metadata_policy_unsupported"
        );
        for policy in ["stripSafe", "stripAll"] {
            assert_eq!(
                classify_error_code(
                    CompressionStage::Failed,
                    &format!("metadataPolicy={policy} is not supported")
                )
                .as_str(),
                "metadata_policy_unsupported"
            );
        }
        let job = test_job("metadata-policy-error-code");
        let error = fail_message(
            &job,
            "metadataPolicy=stripSafe is not supported: safe ICC/EXIF/XMP copying requires a reviewed metadata copier".into(),
        );
        assert!(error.contains("metadataPolicy=stripSafe"));
        assert_eq!(
            job.progress.lock().unwrap().code.as_deref(),
            Some("metadata_policy_unsupported")
        );
        assert_eq!(
            classify_error_code(CompressionStage::Skipped, "target_unreachable").as_str(),
            "skipped"
        );
    }

    #[test]
    fn compression_reports_the_selected_mode_and_backend() {
        assert_eq!(CompressionMode::from_lossless(true).as_str(), "lossless");
        assert_eq!(CompressionMode::from_lossless(false).as_str(), "lossy");
        assert_eq!(
            CompressionEngine::for_format(CompressionFormat::Png).as_str(),
            "oxipng"
        );
        assert_eq!(
            CompressionEngine::for_format(CompressionFormat::Jpeg).as_str(),
            "image-jpeg"
        );
        assert_eq!(
            CompressionEngine::for_format(CompressionFormat::Webp).as_str(),
            "libwebp"
        );
    }

    #[test]
    fn typed_error_codes_keep_the_existing_wire_strings() {
        let codes = [
            CompressionErrorCode::Skipped,
            CompressionErrorCode::Cancelled,
            CompressionErrorCode::MetadataPolicyUnsupported,
            CompressionErrorCode::Decode,
            CompressionErrorCode::Publish,
            CompressionErrorCode::Encode,
        ];
        assert_eq!(
            codes.iter().map(|code| code.as_str()).collect::<Vec<_>>(),
            [
                "skipped",
                "cancelled",
                "metadata_policy_unsupported",
                "decode",
                "publish",
                "encode",
            ]
        );
    }

    #[test]
    fn progress_byte_metrics_accept_candidate_and_published_sizes() {
        let job = test_job("progress-bytes");
        update_progress_bytes(&job, Some(4096), Some(1536));
        let progress = job.progress.lock().unwrap().clone();
        assert_eq!(progress.input_bytes, Some(4096));
        assert_eq!(progress.output_bytes, Some(1536));

        update_progress_bytes(&job, None, Some(1400));
        let progress = job.progress.lock().unwrap().clone();
        assert_eq!(progress.input_bytes, Some(4096));
        assert_eq!(progress.output_bytes, Some(1400));
    }

    #[test]
    fn progress_byte_metrics_serialize_as_optional_camel_case_fields() {
        let progress = CompressionProgress {
            job_id: "progress-serialization".into(),
            status: "running".into(),
            stage: "encoding".into(),
            output_path: None,
            error: None,
            code: None,
            input_bytes: Some(4096),
            output_bytes: Some(1536),
        };
        let value = serde_json::to_value(progress).unwrap();
        assert_eq!(value.get("inputBytes"), Some(&serde_json::json!(4096)));
        assert_eq!(value.get("outputBytes"), Some(&serde_json::json!(1536)));
        assert!(value.get("input_bytes").is_none());
        assert!(value.get("output_bytes").is_none());

        let without_sizes = CompressionProgress {
            job_id: "progress-serialization-empty".into(),
            status: "queued".into(),
            stage: "queued".into(),
            output_path: None,
            error: None,
            code: None,
            input_bytes: None,
            output_bytes: None,
        };
        let value = serde_json::to_value(without_sizes).unwrap();
        assert!(value.get("inputBytes").is_none());
        assert!(value.get("outputBytes").is_none());
    }

    #[test]
    fn webp_quality_metrics_are_stable_and_report_alpha_differences() {
        let source = image::load_from_memory(&lossy_webp_input()).unwrap();
        let encoded =
            encode_image_with_mode(&lossy_webp_input(), CompressionFormat::Webp, 52, 2, false)
                .unwrap();
        let decoded = decode_image(&encoded).unwrap();
        let metrics = calculate_quality_metrics_with_checkpoint(&source, &decoded, None).unwrap();
        let repeated = calculate_quality_metrics_with_checkpoint(&source, &decoded, None).unwrap();
        assert_eq!(metrics.rgb_mae, repeated.rgb_mae);
        assert_eq!(metrics.psnr_db, repeated.psnr_db);
        assert_eq!(metrics.alpha_mismatch_pixels, 0);
        assert!(metrics.rgb_mae.is_finite());
        assert!(metrics.rgb_mae >= 0.0);
        assert!(metrics.psnr_db.is_some());

        let mut changed = decoded.to_rgba8();
        changed.get_pixel_mut(0, 0)[3] ^= 1;
        let changed_metrics = calculate_quality_metrics_with_checkpoint(
            &source,
            &DynamicImage::ImageRgba8(changed),
            None,
        )
        .unwrap();
        assert_eq!(changed_metrics.alpha_mismatch_pixels, 1);
    }

    #[test]
    fn webp_quality_metrics_honor_cancellation_during_pixel_scan() {
        let image =
            DynamicImage::ImageRgba8(ImageBuffer::from_pixel(128, 128, Rgba([8, 16, 32, 255])));
        let job = test_job("quality-metrics-cancel");
        job.cancelled.store(true, Ordering::Release);

        let error =
            calculate_quality_metrics_with_checkpoint(&image, &image, Some(&job)).unwrap_err();
        assert_eq!(error, "compression cancelled");
    }

    #[test]
    fn jpeg_max_rgb_mae_reports_metrics_after_background_compositing() {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(2, 2, Rgba([255, 0, 0, 0])));
        let mut input = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut input), ImageOutputFormat::Png)
            .unwrap();
        let request = parse_raw_payload(&raw_payload(
            r##"{"fileName":"transparent.png","outputFormat":"jpeg","lossless":false,"jpegQuality":82,"jpegBackground":"#123456","maxOutputBytes":100000,"maxCandidates":3,"maxRgbMae":255,"skipIfLarger":false}"##,
            &input,
        ))
        .unwrap();
        let estimate = run_estimate(&request).unwrap();
        assert_eq!(estimate.max_rgb_mae, Some(255.0));
        assert!(estimate.target_met);
        assert_eq!(estimate.candidate_count, Some(3));
        assert!(estimate.quality_metrics.is_some());
    }

    #[test]
    fn webp_quality_metrics_serialize_as_camel_case_in_preview_payload() {
        let preview = CompressionPreview {
            data: Vec::new(),
            width: 2,
            height: 2,
            format: "webp".into(),
            output_bytes: 12,
            lossless: false,
            compression_mode: "lossy",
            compression_engine: "libwebp",
            metadata_policy: "strip",
            status: "completed".into(),
            skipped_reason: None,
            original_input_bytes: None,
            prepared_input_bytes: None,
            target_bytes: None,
            target_met: false,
            selected_resize_percent: None,
            auto_resize_to_target: false,
            selected_quality: Some(82),
            candidate_search_ms: None,
            candidate_count: None,
            max_rgb_mae: None,
            quality_metrics: Some(CompressionQualityMetrics {
                rgb_mae: 1.25,
                psnr_db: Some(42.5),
                alpha_mismatch_pixels: 3,
            }),
        };
        let value = serde_json::to_value(preview).unwrap();
        assert_eq!(value["qualityMetrics"]["rgbMae"], 1.25);
        assert_eq!(value["qualityMetrics"]["psnrDb"], 42.5);
        assert_eq!(value["qualityMetrics"]["alphaMismatchPixels"], 3);
        assert!(value["qualityMetrics"].get("rgb_mae").is_none());
    }

    #[test]
    fn jpeg_target_search_returns_highest_quality_candidate_within_bound() {
        let input = png_input();
        let target = encode_image(&input, CompressionFormat::Jpeg, 50, 2)
            .unwrap()
            .len() as u64;
        let request = CompressionRequest {
            metadata: CompressionMetadata {
                schema_version: COMPRESSION_SCHEMA_VERSION,
                file_name: "sample.png".into(),
                output_file_name: None,
                output_format: "jpeg".into(),
                output_path: None,
                output_location: None,
                source_path: None,
                output_directory: None,
                output_subdirectory: None,
                overwrite_existing: false,
                replace_original: false,
                delete_source: false,
                auto_sequence: false,
                auto_rename: false,
                jpeg_quality: Some(100),
                jpeg_background: None,
                jpeg_progressive: false,
                jpeg_optimize_huffman: false,
                webp_method: None,
                webp_alpha_quality: None,
                webp_pass: None,
                webp_near_lossless: None,
                webp_lossless_method: None,
                lossless: Some(false),
                skip_if_larger: true,
                max_output_bytes: Some(target),
                max_candidates: Some(MAX_CANDIDATES),
                max_rgb_mae: None,
                target_resize_percent: None,
                auto_resize_to_target: false,
                max_input_bytes: None,
                png_optimization_level: Some(2),
                png_optimize_alpha: false,
                metadata_policy: MetadataPolicy::Strip,
                job_id: None,
            },
            input,
            format: CompressionFormat::Jpeg,
            lossless: false,
            target_bytes: Some(target),
            max_candidates: MAX_CANDIDATES,
            png_optimization_level: 2,
            png_optimize_alpha: false,
        };
        let selection = choose_encoded_output_with_cancellation(&request, 2, 2, None).unwrap();
        let repeated = choose_encoded_output_with_cancellation(&request, 2, 2, None).unwrap();
        assert!(selection.target_met);
        assert!(selection.selected_quality.unwrap() >= 50);
        assert!(selection.candidate_search_ms.is_some());
        assert_eq!(selection.selected_quality, repeated.selected_quality);
        assert_eq!(selection.candidate_count, repeated.candidate_count);
        assert_eq!(selection.bytes, repeated.bytes);
        assert!((selection.bytes.len() as u64) <= target);
    }

    #[test]
    fn webp_target_search_returns_highest_quality_candidate_within_bound() {
        let input = lossy_webp_input();
        let target = encode_image_with_webp_method(
            &input,
            CompressionFormat::Webp,
            50,
            2,
            false,
            None,
            Some(6),
            Some(60),
            Some(10),
            None,
        )
        .unwrap()
        .len() as u64;
        let request = CompressionRequest {
            metadata: CompressionMetadata {
                schema_version: COMPRESSION_SCHEMA_VERSION,
                file_name: "sample.png".into(),
                output_file_name: None,
                output_format: "webp".into(),
                output_path: None,
                output_location: None,
                source_path: None,
                output_directory: None,
                output_subdirectory: None,
                overwrite_existing: false,
                replace_original: false,
                delete_source: false,
                auto_sequence: false,
                auto_rename: false,
                jpeg_quality: Some(100),
                jpeg_background: None,
                jpeg_progressive: false,
                jpeg_optimize_huffman: false,
                webp_method: Some(6),
                webp_alpha_quality: Some(60),
                webp_pass: Some(10),
                webp_near_lossless: None,
                webp_lossless_method: None,
                lossless: Some(false),
                skip_if_larger: true,
                max_output_bytes: Some(target),
                max_candidates: Some(MAX_CANDIDATES),
                max_rgb_mae: None,
                target_resize_percent: None,
                auto_resize_to_target: false,
                max_input_bytes: None,
                png_optimization_level: Some(2),
                png_optimize_alpha: false,
                metadata_policy: MetadataPolicy::Strip,
                job_id: None,
            },
            input,
            format: CompressionFormat::Webp,
            lossless: false,
            target_bytes: Some(target),
            max_candidates: MAX_CANDIDATES,
            png_optimization_level: 2,
            png_optimize_alpha: false,
        };
        let selection = choose_encoded_output_with_cancellation(&request, 64, 48, None).unwrap();
        let repeated = choose_encoded_output_with_cancellation(&request, 64, 48, None).unwrap();
        assert!(selection.target_met);
        assert!(selection.selected_quality.unwrap() >= 50);
        assert!(selection.candidate_search_ms.is_some());
        assert_eq!(selection.selected_quality, repeated.selected_quality);
        assert_eq!(selection.candidate_count, repeated.candidate_count);
        assert_eq!(selection.bytes, repeated.bytes);
        assert!((selection.bytes.len() as u64) <= target);
    }

    #[test]
    fn webp_target_search_reports_target_unmet_and_respects_candidate_bound() {
        let input = lossy_webp_input();
        let request = CompressionRequest {
            metadata: CompressionMetadata {
                schema_version: COMPRESSION_SCHEMA_VERSION,
                file_name: "sample.png".into(),
                output_file_name: None,
                output_format: "webp".into(),
                output_path: None,
                output_location: None,
                source_path: None,
                output_directory: None,
                output_subdirectory: None,
                overwrite_existing: false,
                replace_original: false,
                delete_source: false,
                auto_sequence: false,
                auto_rename: false,
                jpeg_quality: Some(100),
                jpeg_background: None,
                jpeg_progressive: false,
                jpeg_optimize_huffman: false,
                webp_method: None,
                webp_alpha_quality: None,
                webp_pass: None,
                webp_near_lossless: None,
                webp_lossless_method: None,
                lossless: Some(false),
                skip_if_larger: true,
                max_output_bytes: Some(1),
                max_candidates: Some(1),
                max_rgb_mae: None,
                target_resize_percent: None,
                auto_resize_to_target: false,
                max_input_bytes: None,
                png_optimization_level: Some(2),
                png_optimize_alpha: false,
                metadata_policy: MetadataPolicy::Strip,
                job_id: None,
            },
            input,
            format: CompressionFormat::Webp,
            lossless: false,
            target_bytes: Some(1),
            max_candidates: 1,
            png_optimization_level: 2,
            png_optimize_alpha: false,
        };
        let selection = choose_encoded_output_with_cancellation(&request, 64, 48, None).unwrap();
        assert!(!selection.target_met);
        assert_eq!(selection.selected_quality, Some(100));
        assert!(selection
            .skipped_reason
            .as_deref()
            .is_some_and(|reason| reason.starts_with("target_unmet")));
    }

    #[test]
    fn webp_rgb_mae_target_search_is_shared_and_reports_quality_failure() {
        let input = lossy_webp_input();
        let target = encode_image_with_webp_method(
            &input,
            CompressionFormat::Webp,
            45,
            2,
            false,
            None,
            Some(4),
            None,
            None,
            None,
        )
        .unwrap()
        .len();
        let metadata = format!(
            "{{\"fileName\":\"sample.png\",\"outputFormat\":\"webp\",\"lossless\":false,\"maxOutputBytes\":{target},\"maxCandidates\":12,\"maxRgbMae\":255}}"
        );
        let request = parse_raw_payload(&raw_payload(&metadata, &input)).unwrap();
        let preview = run_preview(&request).unwrap();
        let estimate = run_estimate(&request).unwrap();
        assert!(preview.target_met);
        assert_eq!(preview.max_rgb_mae, Some(255.0));
        assert_eq!(preview.output_bytes, estimate.output_bytes);
        assert_eq!(preview.selected_quality, estimate.selected_quality);

        let unmet = raw_payload(
            &format!(
                "{{\"fileName\":\"sample.png\",\"outputFormat\":\"webp\",\"lossless\":false,\"maxOutputBytes\":{},\"maxCandidates\":3,\"maxRgbMae\":0}}",
                MAX_OUTPUT_BYTES
            ),
            &input,
        );
        let unmet_request = parse_raw_payload(&unmet).unwrap();
        let unmet_preview = run_preview(&unmet_request).unwrap();
        assert!(!unmet_preview.target_met);
        assert!(unmet_preview
            .skipped_reason
            .as_deref()
            .is_some_and(|reason| reason.starts_with("quality_threshold_unmet")));
        let output_path = crate::commands::test_temp_dir().join(format!(
            "embedpix-max-rgb-mae-unmet-{}.webp",
            uuid_like_id()
        ));
        let formal = raw_payload(
            &format!(
                "{{\"fileName\":\"sample.png\",\"outputFormat\":\"webp\",\"outputPath\":\"{}\",\"lossless\":false,\"maxOutputBytes\":{},\"maxCandidates\":3,\"maxRgbMae\":0}}",
                output_path.to_string_lossy().replace('\\', "/"),
                MAX_OUTPUT_BYTES
            ),
            &input,
        );
        let formal_request = parse_raw_payload(&formal).unwrap();
        let result = run_compression(&formal_request, &test_job("max-rgb-mae-unmet")).unwrap();
        assert_eq!(result.status, "skipped");
        assert!(result
            .skipped_reason
            .as_deref()
            .is_some_and(|reason| reason.starts_with("quality_threshold_unmet")));
        assert!(!output_path.exists());

        let cancelled = test_job("max-rgb-mae-cancel");
        cancelled.cancelled.store(true, Ordering::Release);
        assert_eq!(
            run_preview_with_cancellation(&request, &cancelled).unwrap_err(),
            "compression cancelled"
        );
    }

    #[test]
    fn lossless_target_reports_unreachable_without_publishing() {
        let input = png_input();
        let request = CompressionRequest {
            metadata: CompressionMetadata {
                schema_version: COMPRESSION_SCHEMA_VERSION,
                file_name: "sample.png".into(),
                output_file_name: None,
                output_format: "png".into(),
                output_path: None,
                output_location: None,
                source_path: None,
                output_directory: None,
                output_subdirectory: None,
                overwrite_existing: false,
                replace_original: false,
                delete_source: false,
                auto_sequence: false,
                auto_rename: false,
                jpeg_quality: None,
                jpeg_background: None,
                jpeg_progressive: false,
                jpeg_optimize_huffman: false,
                webp_method: None,
                webp_alpha_quality: None,
                webp_pass: None,
                webp_near_lossless: None,
                webp_lossless_method: None,
                lossless: Some(true),
                skip_if_larger: false,
                max_output_bytes: Some(1),
                max_candidates: Some(DEFAULT_MAX_CANDIDATES),
                max_rgb_mae: None,
                target_resize_percent: None,
                auto_resize_to_target: false,
                max_input_bytes: None,
                png_optimization_level: Some(2),
                png_optimize_alpha: false,
                metadata_policy: MetadataPolicy::Strip,
                job_id: None,
            },
            input,
            format: CompressionFormat::Png,
            lossless: true,
            target_bytes: Some(1),
            max_candidates: DEFAULT_MAX_CANDIDATES,
            png_optimization_level: 2,
            png_optimize_alpha: false,
        };
        let selection = choose_encoded_output_with_cancellation(&request, 2, 2, None).unwrap();
        assert!(!selection.target_met);
        assert!(selection
            .skipped_reason
            .as_deref()
            .is_some_and(|reason| reason.starts_with("target_unreachable")));
        let estimate = run_estimate(&request).unwrap();
        assert_eq!(estimate.status, "skipped");
        assert!(!estimate.target_met);
        assert!(estimate
            .skipped_reason
            .as_deref()
            .is_some_and(|reason| reason.starts_with("target_unreachable")));
    }

    #[test]
    fn preview_accepts_egf1_payload_and_never_publishes_output() {
        let target = crate::commands::test_temp_dir().join(format!(
            "embedpix-compression-preview-{}.png",
            uuid_like_id()
        ));
        let metadata = format!(
            "{{\"fileName\":\"sample.png\",\"outputFormat\":\"png\",\"outputPath\":\"{}\",\"lossless\":true}}",
            target.to_string_lossy().replace('\\', "/")
        );
        let input = png_input();
        let mut payload = Vec::from(*b"EGF1");
        payload.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
        payload.extend_from_slice(metadata.as_bytes());
        payload.extend_from_slice(&input);
        let request = parse_raw_payload(&payload).unwrap();
        let preview = run_preview(&request).unwrap();
        assert_eq!((preview.width, preview.height), (2, 2));
        assert_eq!(preview.output_bytes, preview.data.len() as u64);
        assert!(preview.lossless);
        assert_eq!(preview.metadata_policy, "strip");
        assert!(!target.exists());
    }

    #[test]
    fn preview_rejects_invalid_raw_payload_without_touching_disk() {
        assert!(parse_raw_payload(b"BAD\x00\x00\x00\x00").is_err());
        let mut oversized = Vec::from(*b"EGF1");
        oversized.extend_from_slice(&((MAX_METADATA_BYTES as u32) + 1).to_le_bytes());
        oversized.resize(8 + MAX_METADATA_BYTES + 1, 0);
        assert!(parse_raw_payload(&oversized)
            .unwrap_err()
            .contains("metadata"));
        let invalid_metadata =
            br#"{"fileName":"sample.png","outputFormat":"png","pngOptimizationLevel":7}"#;
        let mut invalid_level = Vec::from(*b"EGF1");
        invalid_level.extend_from_slice(&(invalid_metadata.len() as u32).to_le_bytes());
        invalid_level.extend_from_slice(invalid_metadata);
        invalid_level.extend_from_slice(&png_input());
        assert!(parse_raw_payload(&invalid_level)
            .unwrap_err()
            .contains("pngOptimizationLevel"));
    }

    #[test]
    fn estimate_covers_png_jpeg_webp_and_target_search_without_output_path() {
        for (format, lossless, quality, optimization_level) in [
            ("png", true, None, 6),
            ("jpeg", false, Some(1), 2),
            ("webp", false, Some(100), 2),
        ] {
            let quality = quality
                .map(|value| format!(",\"jpegQuality\":{value}"))
                .unwrap_or_default();
            let metadata = format!(
                "{{\"fileName\":\"sample.png\",\"outputFormat\":\"{format}\",\"lossless\":{lossless},\"pngOptimizationLevel\":{optimization_level}{quality}}}"
            );
            let request =
                parse_estimate_raw_payload(&raw_payload(&metadata, &png_input())).unwrap();
            let estimate = run_estimate(&request).unwrap();
            assert_eq!((estimate.width, estimate.height), (2, 2));
            assert_eq!(
                estimate.format,
                if format == "jpeg" { "jpeg" } else { format }
            );
            assert!(estimate.output_bytes > 0);
            assert!(estimate.saved_bytes <= estimate.input_bytes as i64);
            assert_eq!(estimate.metadata_policy, "strip");
            if format == "webp" {
                let metrics = estimate
                    .quality_metrics
                    .as_ref()
                    .expect("lossy WebP estimate metrics");
                assert!(metrics.rgb_mae >= 0.0);
                assert!(metrics.psnr_db.is_some());
            } else {
                assert!(estimate.quality_metrics.is_none());
            }
        }

        let target_metadata = r#"{"fileName":"sample.png","outputFormat":"png","lossless":true,"maxOutputBytes":1,"maxCandidates":1}"#;
        let target_request =
            parse_estimate_raw_payload(&raw_payload(target_metadata, &png_input())).unwrap();
        let target_estimate = run_estimate(&target_request).unwrap();
        assert_eq!(target_estimate.status, "skipped");
        assert!(!target_estimate.target_met);
        assert!(target_estimate
            .skipped_reason
            .as_deref()
            .is_some_and(|reason| reason.starts_with("target_unreachable")));
    }

    #[test]
    fn estimate_rejects_publish_fields_invalid_limits_and_transparency_without_disk_changes() {
        let output_path = crate::commands::test_temp_dir().join(format!(
            "embedpix-compression-estimate-{}.webp",
            uuid_like_id()
        ));
        let publish_metadata = format!(
            "{{\"fileName\":\"sample.png\",\"outputFormat\":\"webp\",\"outputPath\":\"{}\"}}",
            output_path.to_string_lossy().replace('\\', "/")
        );
        let publish_error =
            parse_estimate_raw_payload(&raw_payload(&publish_metadata, &png_input())).unwrap_err();
        assert!(publish_error.contains("unknown field") || publish_error.contains("outputPath"));
        assert!(!output_path.exists());

        for invalid_metadata in [
            r#"{"fileName":"sample.png","outputFormat":"jpeg","jpegQuality":0}"#,
            r#"{"fileName":"sample.png","outputFormat":"png","pngOptimizationLevel":7}"#,
            r#"{"fileName":"sample.png","outputFormat":"png","maxOutputBytes":0}"#,
            r#"{"fileName":"sample.png","outputFormat":"png","maxCandidates":13}"#,
            r#"{"fileName":"sample.png","outputFormat":"jpeg","lossless":true}"#,
        ] {
            assert!(
                parse_estimate_raw_payload(&raw_payload(invalid_metadata, &png_input())).is_err()
            );
        }
        let oversized_input = vec![0u8; MAX_INPUT_BYTES + 1];
        assert!(parse_estimate_raw_payload(&raw_payload(
            r#"{"fileName":"sample.png","outputFormat":"png"}"#,
            &oversized_input,
        ))
        .unwrap_err()
        .contains("32 MiB"));

        let transparent =
            DynamicImage::ImageRgba8(ImageBuffer::from_pixel(2, 2, Rgba([10, 20, 30, 64])));
        let mut transparent_input = Vec::new();
        transparent
            .write_to(
                &mut Cursor::new(&mut transparent_input),
                ImageOutputFormat::Png,
            )
            .unwrap();
        let transparent_request = parse_estimate_raw_payload(&raw_payload(
            r#"{"fileName":"transparent.png","outputFormat":"jpeg","jpegQuality":80,"lossless":false}"#,
            &transparent_input,
        ))
        .unwrap();
        let transparent_estimate = run_estimate(&transparent_request).unwrap();
        assert_eq!(transparent_estimate.format, "jpeg");
        assert!(transparent_estimate.output_bytes > 0);
        assert!(!output_path.exists());
    }

    #[test]
    fn cancellation_checkpoint_is_observable() {
        let job = Arc::new(CompressionJob {
            cancelled: AtomicBool::new(true),
            progress: Mutex::new(CompressionProgress {
                job_id: "x".into(),
                status: "running".into(),
                stage: "encoding".into(),
                output_path: None,
                error: None,
                code: None,
                input_bytes: None,
                output_bytes: None,
            }),
            terminal_at: Mutex::new(None),
        });
        assert!(checkpoint(&job).is_err());
        assert_eq!(job.progress.lock().unwrap().status, "cancelled");
    }

    #[test]
    fn candidate_search_honors_cancellation_before_encoding() {
        let job = Arc::new(CompressionJob {
            cancelled: AtomicBool::new(true),
            progress: Mutex::new(CompressionProgress {
                job_id: "candidate-cancel".into(),
                status: "running".into(),
                stage: "encoding".into(),
                output_path: None,
                error: None,
                code: None,
                input_bytes: None,
                output_bytes: None,
            }),
            terminal_at: Mutex::new(None),
        });
        let request = path_request(Path::new("candidate-cancel.webp"));

        let error =
            choose_encoded_output_with_cancellation(&request, 2, 2, Some(&job)).unwrap_err();

        assert_eq!(error, "compression cancelled");
        assert_eq!(job.progress.lock().unwrap().status, "cancelled");
    }
}
