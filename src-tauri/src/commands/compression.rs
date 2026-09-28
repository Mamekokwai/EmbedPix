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

use image::{
    codecs::jpeg::JpegEncoder, io::Reader as ImageReader, DynamicImage, GenericImageView,
    ImageFormat,
};
use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{InvokeBody, Request},
    State,
};

use super::{
    export_image::{write_exported_file, WriteOptions},
    image_orientation::normalize_jpeg_orientation,
    path_security,
    webp_static::encode_lossy_rgba,
};

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 128 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 8_192;
const MAX_IMAGE_PIXELS: u64 = 16_777_216;
const MAX_DECODER_ALLOC_BYTES: u64 = 128 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 64 * 1024;
const MAX_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_MAX_CANDIDATES: usize = 8;
const MAX_CANDIDATES: usize = 12;
const JOB_RETENTION: Duration = Duration::from_secs(5 * 60);
const MAX_COMPRESSION_CONCURRENCY: usize = 2;

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

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
enum MetadataPolicy {
    #[default]
    Strip,
    Preserve,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompressionMetadata {
    file_name: String,
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
    jpeg_quality: Option<u8>,
    #[serde(default)]
    lossless: Option<bool>,
    #[serde(default = "default_skip_if_larger")]
    skip_if_larger: bool,
    #[serde(default)]
    max_output_bytes: Option<u64>,
    #[serde(default)]
    max_candidates: Option<usize>,
    #[serde(default)]
    png_optimization_level: Option<u8>,
    #[serde(default)]
    metadata_policy: MetadataPolicy,
    #[serde(default)]
    job_id: Option<String>,
}

#[derive(Debug)]
struct CompressionRequest {
    metadata: CompressionMetadata,
    input: Vec<u8>,
    format: CompressionFormat,
    lossless: bool,
    target_bytes: Option<u64>,
    max_candidates: usize,
    png_optimization_level: u8,
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
}

impl Drop for CompressionPermit {
    fn drop(&mut self) {
        if let Ok(mut available) = self.semaphore.available.lock() {
            *available += 1;
            self.semaphore.wake.notify_one();
        }
    }
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
    pub output_bytes: u64,
    pub saved_bytes: i64,
    pub savings_percent: f64,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub lossless: bool,
    pub target_bytes: Option<u64>,
    pub target_met: bool,
    pub selected_quality: Option<u8>,
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
    pub status: String,
    pub skipped_reason: Option<String>,
    pub target_bytes: Option<u64>,
    pub target_met: bool,
    pub selected_quality: Option<u8>,
}

#[tauri::command(rename_all = "camelCase")]
pub async fn preflight_compression(request: Request<'_>) -> Result<CompressionPreflight, String> {
    let request = parse_request(request)?;
    let (width, height) = inspect_image(&request.input)?;
    let output_path = resolve_preflight_output_path(&request)?;
    Ok(CompressionPreflight {
        format: request.format.name().to_string(),
        width,
        height,
        input_bytes: request.input.len() as u64,
        overwrites_existing: output_path.exists(),
        lossless: request.lossless,
        output_path: output_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn preview_compression(request: Request<'_>) -> Result<CompressionPreview, String> {
    let request = parse_request(request)?;
    tauri::async_runtime::spawn_blocking(move || run_preview(&request))
        .await
        .map_err(|error| format!("compression preview task failed: {error}"))?
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
            stage: "preflight".into(),
            output_path: None,
            error: None,
            code: None,
        }),
        terminal_at: Mutex::new(None),
    });
    state.register(job_id.clone(), Arc::clone(&job))?;
    let encoder_slots = Arc::clone(&state.encoder_slots);
    let job_for_task = Arc::clone(&job);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _permit = encoder_slots.acquire();
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

fn run_compression(
    request: &CompressionRequest,
    job: &Arc<CompressionJob>,
) -> Result<CompressionResult, String> {
    checkpoint(job)?;
    let (width, height) =
        inspect_image(&request.input).map_err(|error| fail_message(job, error))?;
    update_progress(job, "encoding", None, None);
    let EncodedSelection {
        bytes,
        selected_quality,
        target_met,
        skipped_reason: selection_skipped_reason,
    } = choose_encoded_output(request, width, height).map_err(|error| fail_message(job, error))?;
    checkpoint(job)?;
    let output_path = resolve_output_path(request).map_err(|error| fail_message(job, error))?;
    let input_bytes = request.input.len() as u64;
    let output_bytes = bytes.len() as u64;
    let (saved_bytes, savings_percent) = compression_statistics(input_bytes, output_bytes);
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
        update_progress(job, "skipped", None, Some(skipped_reason.to_string()));
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
            output_bytes,
            saved_bytes,
            savings_percent,
            width,
            height,
            format: request.format.name().into(),
            lossless: request.lossless,
            target_bytes: request.target_bytes,
            target_met,
            selected_quality,
        });
    }
    update_progress(job, "publishing", None, None);
    let source_path = request.metadata.source_path.as_deref();
    write_exported_file(
        &output_path,
        bytes,
        source_path,
        WriteOptions {
            manage_existing_output: true,
            overwrite_existing: request.metadata.overwrite_existing,
            overwrite_same_name: false,
            delete_source: false,
            replace_original: request.metadata.replace_original
                || request.metadata.output_location.as_deref() == Some("original"),
        },
    )
    .map_err(|error| fail_message(job, error))?;
    let published_output_bytes = fs::metadata(&output_path)
        .map_err(|error| {
            fail_message(job, format!("failed to inspect compressed output: {error}"))
        })?
        .len();
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
        output_bytes: published_output_bytes,
        saved_bytes,
        savings_percent,
        width,
        height,
        format: request.format.name().into(),
        lossless: request.lossless,
        target_bytes: request.target_bytes,
        target_met,
        selected_quality,
    };
    update_progress(job, "completed", Some(result.output_path.clone()), None);
    Ok(result)
}

fn default_skip_if_larger() -> bool {
    true
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

struct EncodedSelection {
    bytes: Vec<u8>,
    selected_quality: Option<u8>,
    target_met: bool,
    skipped_reason: Option<String>,
}

fn choose_encoded_output(
    request: &CompressionRequest,
    width: u32,
    height: u32,
) -> Result<EncodedSelection, String> {
    let quality = request.metadata.jpeg_quality.unwrap_or(82);
    let Some(target_bytes) = request.target_bytes else {
        let bytes = encode_and_verify(
            &request.input,
            request.format,
            quality,
            request.png_optimization_level,
            width,
            height,
            request.lossless,
        )?;
        return Ok(EncodedSelection {
            bytes,
            selected_quality: (request.format == CompressionFormat::Jpeg
                || (request.format == CompressionFormat::Webp && !request.lossless))
                .then_some(quality),
            target_met: false,
            skipped_reason: None,
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
            width,
            height,
            request.lossless,
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
        });
    }

    let max_quality = quality;
    let mut low = 1u8;
    let mut high = max_quality;
    let mut candidates = Vec::new();
    let mut best: Option<(u8, Vec<u8>)> = None;
    let mut smallest: Option<(u8, Vec<u8>)> = None;
    while candidates.len() < request.max_candidates && low <= high {
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
            width,
            height,
            request.lossless,
        )?;
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
    })
}

fn encode_and_verify(
    input: &[u8],
    format: CompressionFormat,
    quality: u8,
    png_optimization_level: u8,
    width: u32,
    height: u32,
    lossless: bool,
) -> Result<Vec<u8>, String> {
    let bytes = encode_image_with_mode(input, format, quality, png_optimization_level, lossless)?;
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err("compressed output exceeds the 128 MiB limit".into());
    }
    let verified = decode_image(&bytes)
        .map_err(|error| format!("compressed output failed decode verification: {error}"))?;
    if verified.dimensions() != (width, height) {
        return Err("compressed output dimensions do not match the source image".into());
    }
    Ok(bytes)
}

fn run_preview(request: &CompressionRequest) -> Result<CompressionPreview, String> {
    let (width, height) = inspect_image(&request.input)?;
    let EncodedSelection {
        bytes: data,
        selected_quality,
        target_met,
        skipped_reason,
    } = choose_encoded_output(request, width, height)?;
    if data.len() > MAX_PREVIEW_BYTES {
        return Err(format!(
            "compressed preview exceeds the {} MiB limit",
            MAX_PREVIEW_BYTES / (1024 * 1024)
        ));
    }
    let verified = decode_image(&data)?;
    if verified.dimensions() != (width, height) {
        return Err("compressed preview dimensions do not match the source image".into());
    }
    let output_bytes = data.len() as u64;
    Ok(CompressionPreview {
        data,
        width,
        height,
        format: request.format.name().into(),
        output_bytes,
        lossless: request.lossless,
        status: if skipped_reason.is_some() {
            "skipped"
        } else {
            "completed"
        }
        .into(),
        skipped_reason,
        target_bytes: request.target_bytes,
        target_met,
        selected_quality,
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

fn encode_image_with_mode(
    input: &[u8],
    format: CompressionFormat,
    quality: u8,
    png_optimization_level: u8,
    lossless: bool,
) -> Result<Vec<u8>, String> {
    let image = decode_image(input)?;
    if format == CompressionFormat::Jpeg && image.to_rgba8().pixels().any(|pixel| pixel[3] < 255) {
        return Err(
            "JPEG compression requires an opaque image; composite transparency before encoding"
                .into(),
        );
    }
    let mut output = LimitedWriter {
        bytes: Vec::new(),
        limit: MAX_OUTPUT_BYTES,
    };
    match format {
        CompressionFormat::Jpeg => JpegEncoder::new_with_quality(&mut output, quality)
            .encode_image(&image.to_rgb8())
            .map_err(|error| format!("failed to encode jpeg: {error}"))?,
        CompressionFormat::Png => {
            image
                .write_to(&mut Cursor::new(&mut output.bytes), ImageFormat::Png)
                .map_err(|error| format!("failed to encode png: {error}"))?;
            let optimized = oxipng::optimize_from_memory(
                &output.bytes,
                &oxipng::Options::from_preset(png_optimization_level),
            )
            .map_err(|error| format!("failed to optimize png: {error}"))?;
            output.bytes = optimized;
        }
        CompressionFormat::Webp if lossless => image
            .write_to(&mut Cursor::new(&mut output.bytes), ImageFormat::WebP)
            .map_err(|error| format!("failed to encode webp: {error}"))?,
        CompressionFormat::Webp => {
            output.bytes = encode_lossy_rgba(&image.to_rgba8(), quality)?;
        }
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
    if let Some(target_bytes) = metadata.max_output_bytes {
        if target_bytes == 0 || target_bytes > MAX_OUTPUT_BYTES as u64 {
            return Err(format!(
                "maxOutputBytes must be between 1 and {} MiB",
                MAX_OUTPUT_BYTES / (1024 * 1024)
            ));
        }
    }
    let target_bytes = metadata.max_output_bytes;
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
    if matches!(format, CompressionFormat::Jpeg) && lossless {
        return Err("lossless compression is not supported for JPEG; use PNG or WebP".into());
    }
    if metadata.metadata_policy == MetadataPolicy::Preserve {
        return Err(
            "metadataPolicy=preserve is not supported by first-stage compression; use strip".into(),
        );
    }
    if metadata.replace_original && metadata.source_path.is_none() {
        return Err("replaceOriginal requires sourcePath".into());
    }
    if let Some(source_path) = metadata.source_path.as_deref() {
        let source_path = path_security::normalize_path(source_path)
            .map_err(|error| format!("invalid sourcePath: {error:?}"))?;
        path_security::validate_source_path(&source_path)
            .map_err(|error| format!("invalid sourcePath: {error:?}"))?;
    }
    let input = body[end..].to_vec();
    if input.len() > MAX_INPUT_BYTES {
        return Err("input image exceeds the 32 MiB limit".into());
    }
    Ok(CompressionRequest {
        metadata,
        input,
        format,
        lossless,
        target_bytes,
        max_candidates,
        png_optimization_level,
    })
}

fn resolve_output_path(request: &CompressionRequest) -> Result<PathBuf, String> {
    let metadata = &request.metadata;
    let location = metadata
        .output_location
        .as_deref()
        .unwrap_or("path")
        .to_ascii_lowercase();
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
        .join(default_name(&metadata.file_name, request.format))
    };
    let path = with_extension(path, request.format.extension());
    path_security::validate_output_path(&path)
        .map_err(|error| format!("invalid compression output path: {error:?}"))?;
    Ok(path)
}

fn validate_preflight_output_directory(output_path: &Path) -> Result<(), String> {
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
        return Ok(());
    }
}

fn resolve_preflight_output_path(request: &CompressionRequest) -> Result<PathBuf, String> {
    let output_path = resolve_output_path(request)
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
        update_progress(job, "cancelling", None, None);
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
            "cancelled"
        } else {
            "failed"
        },
        None,
        Some(message.clone()),
    );
    message
}
fn update_progress(
    job: &Arc<CompressionJob>,
    stage: &str,
    output_path: Option<String>,
    error: Option<String>,
) {
    if let Ok(mut progress) = job.progress.lock() {
        if stage == "cancelling"
            && matches!(
                progress.status.as_str(),
                "completed" | "failed" | "cancelled"
            )
        {
            return;
        }
        progress.stage = stage.to_string();
        progress.status = match stage {
            "completed" => "completed",
            "skipped" => "skipped",
            "cancelled" => "cancelled",
            "failed" => "failed",
            "cancelling" => "cancelling",
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
            .map(|message| classify_error_code(stage, message));
        if matches!(stage, "completed" | "skipped" | "cancelled" | "failed") {
            if let Ok(mut terminal_at) = job.terminal_at.lock() {
                *terminal_at = Some(Instant::now());
            }
        }
    }
}

fn classify_error_code(stage: &str, message: &str) -> String {
    if stage == "skipped" {
        return "skipped".into();
    }
    if stage == "cancelled" || stage == "cancelling" {
        return "cancelled".into();
    }
    let lower = message.to_ascii_lowercase();
    if lower.contains("metadatapolicy=preserve") {
        return "metadata_policy_unsupported".into();
    }
    if lower.contains("decode")
        || lower.contains("inspect input")
        || lower.contains("dimensions")
        || lower.contains("opaque")
    {
        return "decode".into();
    }
    if lower.contains("path")
        || lower.contains("directory")
        || lower.contains("output file")
        || lower.contains("write")
        || lower.contains("bak")
        || lower.contains("publish")
    {
        return "publish".into();
    }
    "encode".into()
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

    fn raw_payload(metadata: &str, input: &[u8]) -> Vec<u8> {
        let mut payload = Vec::from(*b"EGF1");
        payload.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
        payload.extend_from_slice(metadata.as_bytes());
        payload.extend_from_slice(input);
        payload
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
    }

    #[test]
    fn jpeg_rejects_transparency_instead_of_dropping_alpha() {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(2, 2, Rgba([10, 20, 30, 64])));
        let mut input = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut input), ImageOutputFormat::Png)
            .unwrap();
        assert!(encode_image(&input, CompressionFormat::Jpeg, 80, 2)
            .unwrap_err()
            .contains("opaque"));
    }
    #[test]
    fn validates_quality_and_metadata_policy() {
        assert!(CompressionFormat::parse("jpeg").is_ok());
        assert!(CompressionFormat::parse("bmp").is_err());
        assert!(!(1..=100).contains(&0));
        assert_eq!(MetadataPolicy::default(), MetadataPolicy::Strip);
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
                file_name: "sample.png".into(),
                output_format: "webp".into(),
                output_path: Some(missing_output.to_string_lossy().into_owned()),
                output_location: Some("path".into()),
                source_path: None,
                output_directory: None,
                output_subdirectory: None,
                overwrite_existing: false,
                replace_original: false,
                jpeg_quality: None,
                lossless: Some(true),
                skip_if_larger: true,
                max_output_bytes: None,
                max_candidates: None,
                png_optimization_level: Some(2),
                metadata_policy: MetadataPolicy::Strip,
                job_id: None,
            },
            input: png_input(),
            format: CompressionFormat::Webp,
            lossless: true,
            target_bytes: None,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            png_optimization_level: 2,
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
    fn corrupt_input_does_not_publish_or_modify_an_existing_output() {
        let output_path = crate::commands::test_temp_dir().join(format!(
            "embedpix-compression-corrupt-{}.webp",
            uuid_like_id()
        ));
        let original = b"existing output";
        fs::write(&output_path, original).unwrap();
        let request = CompressionRequest {
            metadata: CompressionMetadata {
                file_name: "broken.png".into(),
                output_format: "webp".into(),
                output_path: Some(output_path.to_string_lossy().into_owned()),
                output_location: Some("path".into()),
                source_path: None,
                output_directory: None,
                output_subdirectory: None,
                overwrite_existing: false,
                replace_original: false,
                jpeg_quality: None,
                lossless: Some(true),
                skip_if_larger: true,
                max_output_bytes: None,
                max_candidates: None,
                png_optimization_level: Some(2),
                metadata_policy: MetadataPolicy::Strip,
                job_id: Some("corrupt-input-test".into()),
            },
            input: b"truncated image".to_vec(),
            format: CompressionFormat::Webp,
            lossless: true,
            target_bytes: None,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            png_optimization_level: 2,
        };
        let job = Arc::new(CompressionJob {
            cancelled: AtomicBool::new(false),
            progress: Mutex::new(CompressionProgress {
                job_id: "corrupt-input-test".into(),
                status: "running".into(),
                stage: "preflight".into(),
                output_path: None,
                error: None,
                code: None,
            }),
            terminal_at: Mutex::new(None),
        });

        assert!(run_compression(&request, &job).is_err());
        assert_eq!(fs::read(&output_path).unwrap(), original);
        assert_eq!(job.progress.lock().unwrap().status, "failed");
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
        let request = CompressionRequest {
            metadata: CompressionMetadata {
                file_name: "sample.jpg".into(),
                output_format: "png".into(),
                output_path: Some(output_path.to_string_lossy().into_owned()),
                output_location: Some("path".into()),
                source_path: None,
                output_directory: None,
                output_subdirectory: None,
                overwrite_existing: false,
                replace_original: false,
                jpeg_quality: None,
                lossless: Some(true),
                skip_if_larger: true,
                max_output_bytes: None,
                max_candidates: None,
                png_optimization_level: Some(2),
                metadata_policy: MetadataPolicy::Strip,
                job_id: Some("skip-test".into()),
            },
            input,
            format: CompressionFormat::Png,
            lossless: true,
            target_bytes: None,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            png_optimization_level: 2,
        };
        let job = Arc::new(CompressionJob {
            cancelled: AtomicBool::new(false),
            progress: Mutex::new(CompressionProgress {
                job_id: "skip-test".into(),
                status: "running".into(),
                stage: "preflight".into(),
                output_path: None,
                error: None,
                code: None,
            }),
            terminal_at: Mutex::new(None),
        });
        let result = run_compression(&request, &job).unwrap();
        assert_eq!(result.status, "skipped");
        assert!(result.skipped_reason.is_some());
        assert!(result.saved_bytes < 0);
        assert!(!output_path.exists());
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
                }),
                terminal_at: Mutex::new(None),
            })
        };
        state.register("duplicate-test".into(), job()).unwrap();
        assert!(state.register("duplicate-test".into(), job()).is_err());
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
            }),
            terminal_at: Mutex::new(None),
        });

        assert_eq!(cancel_job(&job).unwrap().status, "cancelling");
        assert_eq!(cancel_job(&job).unwrap().status, "cancelling");
        update_progress(&job, "completed", Some("output.webp".into()), None);
        let progress = cancel_job(&job).unwrap();
        assert_eq!(progress.status, "completed");
        assert_eq!(progress.stage, "completed");
        assert_eq!(progress.output_path.as_deref(), Some("output.webp"));
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
    fn progress_error_codes_are_stable_without_changing_error_text() {
        assert_eq!(
            classify_error_code("failed", "failed to decode input image"),
            "decode"
        );
        assert_eq!(
            classify_error_code("failed", "failed to write output file"),
            "publish"
        );
        assert_eq!(
            classify_error_code("failed", "failed to optimize png"),
            "encode"
        );
        assert_eq!(
            classify_error_code("cancelled", "compression cancelled"),
            "cancelled"
        );
        assert_eq!(
            classify_error_code(
                "failed",
                "metadataPolicy=preserve is not supported by first-stage compression"
            ),
            "metadata_policy_unsupported"
        );
        assert_eq!(
            classify_error_code("skipped", "target_unreachable"),
            "skipped"
        );
    }

    #[test]
    fn jpeg_target_search_returns_highest_quality_candidate_within_bound() {
        let input = png_input();
        let target = encode_image(&input, CompressionFormat::Jpeg, 50, 2)
            .unwrap()
            .len() as u64;
        let request = CompressionRequest {
            metadata: CompressionMetadata {
                file_name: "sample.png".into(),
                output_format: "jpeg".into(),
                output_path: None,
                output_location: None,
                source_path: None,
                output_directory: None,
                output_subdirectory: None,
                overwrite_existing: false,
                replace_original: false,
                jpeg_quality: Some(100),
                lossless: Some(false),
                skip_if_larger: true,
                max_output_bytes: Some(target),
                max_candidates: Some(MAX_CANDIDATES),
                png_optimization_level: Some(2),
                metadata_policy: MetadataPolicy::Strip,
                job_id: None,
            },
            input,
            format: CompressionFormat::Jpeg,
            lossless: false,
            target_bytes: Some(target),
            max_candidates: MAX_CANDIDATES,
            png_optimization_level: 2,
        };
        let selection = choose_encoded_output(&request, 2, 2).unwrap();
        assert!(selection.target_met);
        assert!(selection.selected_quality.unwrap() >= 50);
        assert!((selection.bytes.len() as u64) <= target);
    }

    #[test]
    fn webp_target_search_returns_highest_quality_candidate_within_bound() {
        let input = lossy_webp_input();
        let target = encode_image_with_mode(&input, CompressionFormat::Webp, 50, 2, false)
            .unwrap()
            .len() as u64;
        let request = CompressionRequest {
            metadata: CompressionMetadata {
                file_name: "sample.png".into(),
                output_format: "webp".into(),
                output_path: None,
                output_location: None,
                source_path: None,
                output_directory: None,
                output_subdirectory: None,
                overwrite_existing: false,
                replace_original: false,
                jpeg_quality: Some(100),
                lossless: Some(false),
                skip_if_larger: true,
                max_output_bytes: Some(target),
                max_candidates: Some(MAX_CANDIDATES),
                png_optimization_level: Some(2),
                metadata_policy: MetadataPolicy::Strip,
                job_id: None,
            },
            input,
            format: CompressionFormat::Webp,
            lossless: false,
            target_bytes: Some(target),
            max_candidates: MAX_CANDIDATES,
            png_optimization_level: 2,
        };
        let selection = choose_encoded_output(&request, 64, 48).unwrap();
        assert!(selection.target_met);
        assert!(selection.selected_quality.unwrap() >= 50);
        assert!((selection.bytes.len() as u64) <= target);
    }

    #[test]
    fn webp_target_search_reports_target_unmet_and_respects_candidate_bound() {
        let input = lossy_webp_input();
        let request = CompressionRequest {
            metadata: CompressionMetadata {
                file_name: "sample.png".into(),
                output_format: "webp".into(),
                output_path: None,
                output_location: None,
                source_path: None,
                output_directory: None,
                output_subdirectory: None,
                overwrite_existing: false,
                replace_original: false,
                jpeg_quality: Some(100),
                lossless: Some(false),
                skip_if_larger: true,
                max_output_bytes: Some(1),
                max_candidates: Some(1),
                png_optimization_level: Some(2),
                metadata_policy: MetadataPolicy::Strip,
                job_id: None,
            },
            input,
            format: CompressionFormat::Webp,
            lossless: false,
            target_bytes: Some(1),
            max_candidates: 1,
            png_optimization_level: 2,
        };
        let selection = choose_encoded_output(&request, 64, 48).unwrap();
        assert!(!selection.target_met);
        assert_eq!(selection.selected_quality, Some(100));
        assert!(selection
            .skipped_reason
            .as_deref()
            .is_some_and(|reason| reason.starts_with("target_unmet")));
    }

    #[test]
    fn lossless_target_reports_unreachable_without_publishing() {
        let input = png_input();
        let request = CompressionRequest {
            metadata: CompressionMetadata {
                file_name: "sample.png".into(),
                output_format: "png".into(),
                output_path: None,
                output_location: None,
                source_path: None,
                output_directory: None,
                output_subdirectory: None,
                overwrite_existing: false,
                replace_original: false,
                jpeg_quality: None,
                lossless: Some(true),
                skip_if_larger: true,
                max_output_bytes: Some(1),
                max_candidates: Some(DEFAULT_MAX_CANDIDATES),
                png_optimization_level: Some(2),
                metadata_policy: MetadataPolicy::Strip,
                job_id: None,
            },
            input,
            format: CompressionFormat::Png,
            lossless: true,
            target_bytes: Some(1),
            max_candidates: DEFAULT_MAX_CANDIDATES,
            png_optimization_level: 2,
        };
        let selection = choose_encoded_output(&request, 2, 2).unwrap();
        assert!(!selection.target_met);
        assert!(selection
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
            }),
            terminal_at: Mutex::new(None),
        });
        assert!(checkpoint(&job).is_err());
        assert_eq!(job.progress.lock().unwrap().status, "cancelled");
    }
}
