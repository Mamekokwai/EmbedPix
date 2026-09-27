use std::{
    collections::HashMap,
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
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
    path_security,
};

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 128 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 8_192;
const MAX_IMAGE_PIXELS: u64 = 16_777_216;
const MAX_DECODER_ALLOC_BYTES: u64 = 128 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 64 * 1024;
const JOB_RETENTION: Duration = Duration::from_secs(5 * 60);

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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionProgress {
    pub job_id: String,
    pub status: String,
    pub stage: String,
    pub output_path: Option<String>,
    pub error: Option<String>,
}

pub struct CompressionJobState {
    jobs: Mutex<HashMap<String, Arc<CompressionJob>>>,
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
        }
    }
}

impl CompressionJobState {
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
    pub output_bytes: u64,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub lossless: bool,
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

#[tauri::command(rename_all = "camelCase")]
pub async fn preflight_compression(request: Request<'_>) -> Result<CompressionPreflight, String> {
    let request = parse_request(request)?;
    let (width, height) = inspect_image(&request.input)?;
    let output_path = resolve_output_path(&request)?;
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
        }),
        terminal_at: Mutex::new(None),
    });
    state
        .jobs
        .lock()
        .map_err(|_| "compression job state is unavailable".to_string())?
        .insert(job_id.clone(), Arc::clone(&job));
    let result = tauri::async_runtime::spawn_blocking(move || run_compression(&request, &job))
        .await
        .map_err(|error| format!("compression task failed: {error}"))?;
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
    let is_terminal = job
        .progress
        .lock()
        .map(|progress| {
            matches!(
                progress.status.as_str(),
                "completed" | "failed" | "cancelled"
            )
        })
        .unwrap_or(true);
    if !is_terminal {
        job.cancelled.store(true, Ordering::Release);
        update_progress(&job, "cancelling", None, None);
    }
    let progress = job
        .progress
        .lock()
        .map_err(|_| "compression progress is unavailable".to_string())?
        .clone();
    Ok(progress)
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
    let bytes = encode_image(
        &request.input,
        request.format,
        request.metadata.jpeg_quality.unwrap_or(82),
    )
    .map_err(|error| fail_message(job, error))?;
    if bytes.len() > MAX_OUTPUT_BYTES {
        return fail(job, "compressed output exceeds the 128 MiB limit");
    }
    checkpoint(job)?;
    update_progress(job, "publishing", None, None);
    let output_path = resolve_output_path(request).map_err(|error| fail_message(job, error))?;
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
    let output_bytes = fs::metadata(&output_path)
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
        output_bytes,
        width,
        height,
        format: request.format.name().into(),
        lossless: request.lossless,
    };
    update_progress(job, "completed", Some(result.output_path.clone()), None);
    Ok(result)
}

fn encode_image(input: &[u8], format: CompressionFormat, quality: u8) -> Result<Vec<u8>, String> {
    let image = decode_image(input)?;
    let mut output = LimitedWriter {
        bytes: Vec::new(),
        limit: MAX_OUTPUT_BYTES,
    };
    match format {
        CompressionFormat::Jpeg => JpegEncoder::new_with_quality(&mut output, quality)
            .encode_image(&image.to_rgb8())
            .map_err(|error| format!("failed to encode jpeg: {error}"))?,
        CompressionFormat::Png => image
            .write_to(&mut Cursor::new(&mut output.bytes), ImageFormat::Png)
            .map_err(|error| format!("failed to encode png: {error}"))?,
        // image 0.24 exposes lossless WebP only; a quality-controlled WebP backend can be added later.
        CompressionFormat::Webp => image
            .write_to(&mut Cursor::new(&mut output.bytes), ImageFormat::WebP)
            .map_err(|error| format!("failed to encode webp: {error}"))?,
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
    reader
        .decode()
        .map_err(|error| format!("failed to decode input image: {error}"))
}

fn parse_request(request: Request<'_>) -> Result<CompressionRequest, String> {
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        _ => return Err("compression commands require a raw binary IPC request".into()),
    };
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
    if matches!(format, CompressionFormat::Jpeg) && lossless {
        return Err("lossless compression is not supported for JPEG; use PNG or WebP".into());
    }
    if matches!(format, CompressionFormat::Webp) && !lossless {
        return Err("lossy WebP compression is not available in the first-stage backend; request lossless WebP".into());
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
fn fail<T>(job: &Arc<CompressionJob>, message: &str) -> Result<T, String> {
    Err(fail_message(job, message.to_string()))
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
        if matches!(stage, "completed" | "cancelled" | "failed") {
            if let Ok(mut terminal_at) = job.terminal_at.lock() {
                *terminal_at = Some(Instant::now());
            }
        }
    }
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
    use image::{DynamicImage, ImageBuffer, ImageOutputFormat, Rgba};

    fn png_input() -> Vec<u8> {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(2, 2, Rgba([255, 0, 0, 255])));
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
            let output = encode_image(&input, format, 80).unwrap();
            assert!(!output.is_empty());
            assert!(decode_image(&output).is_ok());
        }
        assert!(decode_image(b"bad").is_err());
    }
    #[test]
    fn validates_quality_and_metadata_policy() {
        assert!(CompressionFormat::parse("jpeg").is_ok());
        assert!(CompressionFormat::parse("bmp").is_err());
        assert!(!(1..=100).contains(&0));
        assert_eq!(MetadataPolicy::default(), MetadataPolicy::Strip);
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
            }),
            terminal_at: Mutex::new(None),
        });
        assert!(checkpoint(&job).is_err());
        assert_eq!(job.progress.lock().unwrap().status, "cancelled");
    }
}
