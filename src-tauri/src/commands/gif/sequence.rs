use std::{
    fs::{self, File, OpenOptions},
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use image::{io::Reader as ImageReader, DynamicImage, ImageOutputFormat};
use rfd::FileDialog;
use serde::{Deserialize, Serialize};

use super::{
    decode_limits, detect_format, inspect_frame_dimensions, job_begin_publish, job_checkpoint,
    job_mark_published, job_report, validate_frame_dimensions, EncodingSemaphore, ExportJob,
};

use super::storage;

const MAX_SEQUENCE_FRAMES: usize = 200;
const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;
const MAX_TOTAL_FRAME_BYTES: usize = 128 * 1024 * 1024;
const MAX_BASE_NAME_CHARS: usize = 120;
const MAX_PREFIX_ATTEMPTS: usize = 10_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PngSequenceExportRequest {
    #[serde(default)]
    output_dir: String,
    #[serde(default)]
    output_location: Option<String>,
    #[serde(default)]
    source_path: Option<String>,
    #[serde(default)]
    output_subdirectory: Option<String>,
    #[serde(default)]
    output_directory: Option<String>,
    base_name: String,
    pub(super) frames: Vec<PngSequenceFrameRequest>,
    #[serde(default)]
    overwrite_existing: bool,
    #[serde(default)]
    pub(super) job_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PngSequenceFrameRequest {
    data: Vec<u8>,
    #[serde(rename = "durationMs", default)]
    _duration_ms: u32,
}

#[derive(Debug, Serialize)]
pub struct PngSequenceSizeEstimateResult {
    pub bytes: u64,
    pub frames: usize,
}

struct TemporaryFile {
    path: PathBuf,
    file: Option<File>,
    cleanup: bool,
}

impl TemporaryFile {
    fn create(directory: &Path, index: usize) -> Result<Self, String> {
        for attempt in 0..=MAX_PREFIX_ATTEMPTS {
            let path = directory.join(format!(
                ".embedpix-sequence-{}-{index}-{attempt}.tmp",
                std::process::id()
            ));
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => {
                    return Ok(Self {
                        path,
                        file: Some(file),
                        cleanup: true,
                    })
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("无法创建 PNG 帧临时文件：{error}")),
            }
        }
        Err("无法分配 PNG 帧临时文件。".to_string())
    }
}

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        self.file.take();
        if self.cleanup {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub async fn pick_gif_sequence_output() -> Result<Option<String>, String> {
    Ok(FileDialog::new()
        .set_title("选择 PNG 帧序列输出目录")
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned()))
}

pub async fn export_png_sequence(
    request: PngSequenceExportRequest,
    job: ExportJob,
    encoder_slots: Arc<EncodingSemaphore>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _encoding_permit = encoder_slots.acquire();
        export_png_sequence_blocking_with_job(request, job)
    })
    .await
    .map_err(|error| format!("PNG 帧序列导出任务失败：{error}"))?
}

pub async fn estimate_png_sequence_size(
    request: PngSequenceExportRequest,
    encoder_slots: Arc<EncodingSemaphore>,
) -> Result<PngSequenceSizeEstimateResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _encoding_permit = encoder_slots.acquire();
        estimate_png_sequence_size_blocking(request)
    })
    .await
    .map_err(|error| format!("PNG 帧序列体积测量任务失败：{error}"))?
}

fn export_png_sequence_blocking(request: PngSequenceExportRequest) -> Result<Vec<String>, String> {
    export_png_sequence_blocking_with_job(request, None)
}

pub fn export_png_sequence_cli(request: PngSequenceExportRequest) -> Result<Vec<String>, String> {
    export_png_sequence_blocking(request)
}

fn export_png_sequence_blocking_with_job(
    request: PngSequenceExportRequest,
    job: ExportJob,
) -> Result<Vec<String>, String> {
    export_png_sequence_blocking_with_limit_and_job(request, storage::MAX_OUTPUT_BYTES, job)
}

#[cfg(test)]
fn export_png_sequence_blocking_with_limit(
    request: PngSequenceExportRequest,
    max_output_bytes: u64,
) -> Result<Vec<String>, String> {
    export_png_sequence_blocking_with_limit_and_job(request, max_output_bytes, None)
}

fn export_png_sequence_blocking_with_limit_and_job(
    request: PngSequenceExportRequest,
    max_output_bytes: u64,
    job: ExportJob,
) -> Result<Vec<String>, String> {
    job_report(&job, "validating", 0);
    job_checkpoint(&job)?;
    let directory = storage::resolve_output_directory(
        &request.output_dir,
        request.output_location.as_deref(),
        request.source_path.as_deref(),
        request.output_subdirectory.as_deref(),
        request.output_directory.as_deref(),
    )?;
    if !directory.exists() {
        fs::create_dir_all(&directory)
            .map_err(|error| format!("无法创建 PNG 帧序列输出目录：{error}"))?;
        storage::validate_output_directory(&directory)?;
    }
    let base_name = normalize_base_name(&request.base_name)?;
    validate_frames(&request.frames)?;
    let output_paths = choose_output_paths(
        &directory,
        &base_name,
        request.frames.len(),
        request.overwrite_existing,
    )?;

    let mut temporary_files = Vec::with_capacity(request.frames.len());
    for (index, frame) in request.frames.iter().enumerate() {
        job_checkpoint(&job)?;
        job_report(&job, "encoding", index);
        let mut temporary = TemporaryFile::create(&directory, index)?;
        encode_png_frame(
            temporary.file.as_mut().expect("temporary file is open"),
            frame,
        )?;
        let file = temporary.file.as_mut().expect("temporary file is open");
        file.sync_all()
            .map_err(|error| format!("无法完成第 {} 帧 PNG 写入：{error}", index + 1))?;
        storage::validate_output_size(
            file,
            max_output_bytes,
            &format!("第 {} 帧 PNG ", index + 1),
        )?;
        temporary_files.push(temporary);
        job_report(&job, "encoding", index + 1);
    }

    job_checkpoint(&job)?;
    let publish_job = job.clone();
    let completed_job = job.clone();
    let completed_path = output_paths
        .first()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    publish_files(
        &output_paths,
        &mut temporary_files,
        request.overwrite_existing,
        || job_checkpoint(&job),
        move || job_begin_publish(&publish_job),
        move || job_mark_published(&completed_job, completed_path),
    )?;
    job_checkpoint(&job)?;
    Ok(output_paths
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

fn estimate_png_sequence_size_blocking(
    request: PngSequenceExportRequest,
) -> Result<PngSequenceSizeEstimateResult, String> {
    normalize_base_name(&request.base_name)?;
    validate_frames(&request.frames)?;

    let mut bytes = 0u64;
    for frame in &request.frames {
        let encoded = encode_png_frame_to_vec(frame)?;
        bytes = bytes
            .checked_add(encoded.len() as u64)
            .ok_or_else(|| "PNG 帧序列体积超出可测量范围。".to_string())?;
    }
    Ok(PngSequenceSizeEstimateResult {
        bytes,
        frames: request.frames.len(),
    })
}

fn normalize_base_name(value: &str) -> Result<String, String> {
    let mut base_name = value.trim().to_string();
    if base_name.is_empty() {
        return Err("PNG 帧序列基础文件名不能为空。".to_string());
    }
    if base_name.chars().count() > MAX_BASE_NAME_CHARS
        || base_name.chars().any(char::is_control)
        || base_name.chars().any(|character| {
            matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
        })
        || base_name.contains('/')
        || base_name.contains('\\')
        || base_name == "."
        || base_name == ".."
        || base_name.ends_with('.')
        || base_name.ends_with(' ')
    {
        return Err("PNG 帧序列基础文件名包含无效字符。".to_string());
    }
    if base_name.to_ascii_lowercase().ends_with(".png") {
        base_name.truncate(base_name.len() - 4);
    }
    if base_name.is_empty() || base_name == "." || base_name == ".." {
        return Err("PNG 帧序列基础文件名无效。".to_string());
    }
    Ok(base_name)
}

fn validate_frames(frames: &[PngSequenceFrameRequest]) -> Result<(), String> {
    if frames.is_empty() || frames.len() > MAX_SEQUENCE_FRAMES {
        return Err(format!(
            "PNG 帧序列数量必须在 1 到 {MAX_SEQUENCE_FRAMES} 之间。"
        ));
    }
    let mut total_bytes = 0usize;
    let mut source_pixels = 0u64;
    for (index, frame) in frames.iter().enumerate() {
        if frame.data.is_empty() || frame.data.len() > MAX_FRAME_BYTES {
            return Err("单帧图片不能为空且不能超过 32 MiB。".to_string());
        }
        total_bytes = total_bytes
            .checked_add(frame.data.len())
            .filter(|value| *value <= MAX_TOTAL_FRAME_BYTES)
            .ok_or_else(|| "PNG 帧序列图片数据不能超过 128 MiB。".to_string())?;
        let dimensions = inspect_frame_dimensions(&frame.data)
            .map_err(|error| format!("第 {} 帧：{error}", index + 1))?;
        validate_frame_dimensions(dimensions.0, dimensions.1)?;
        source_pixels = source_pixels
            .checked_add(u64::from(dimensions.0).saturating_mul(u64::from(dimensions.1)))
            .filter(|value| *value <= super::MAX_TOTAL_GIF_PIXELS)
            .ok_or_else(|| "PNG 帧序列源帧总像素量超出限制。".to_string())?;
    }
    Ok(())
}

fn encode_png_frame(writer: &mut File, frame: &PngSequenceFrameRequest) -> Result<(), String> {
    let image = decode_png_frame(frame)?;
    image
        .write_to(writer, ImageOutputFormat::Png)
        .map_err(|error| format!("无法编码 PNG 帧：{error}"))?;
    writer
        .flush()
        .map_err(|error| format!("无法完成 PNG 帧编码：{error}"))
}

fn encode_png_frame_to_vec(frame: &PngSequenceFrameRequest) -> Result<Vec<u8>, String> {
    let image = decode_png_frame(frame)?;
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageOutputFormat::Png)
        .map_err(|error| format!("无法编码 PNG 帧：{error}"))?;
    Ok(output.into_inner())
}

fn decode_png_frame(frame: &PngSequenceFrameRequest) -> Result<DynamicImage, String> {
    let mut reader = ImageReader::with_format(
        Cursor::new(&frame.data),
        detect_format(&frame.data).map_err(|error| format!("无法识别 PNG 帧输入格式：{error}"))?,
    );
    reader.limits(decode_limits());
    let image = reader
        .decode()
        .map_err(|error| format!("无法读取 PNG 帧：{error}"))?;
    Ok(image)
}

fn choose_output_paths(
    directory: &Path,
    base_name: &str,
    frame_count: usize,
    overwrite_existing: bool,
) -> Result<Vec<PathBuf>, String> {
    for prefix_index in 0..=MAX_PREFIX_ATTEMPTS {
        let prefix = if overwrite_existing || prefix_index == 0 {
            base_name.to_string()
        } else {
            format!("{base_name}-{prefix_index}")
        };
        let paths = (1..=frame_count)
            .map(|frame_index| directory.join(format!("{prefix}-{frame_index:03}.png")))
            .collect::<Vec<_>>();
        if overwrite_existing || paths.iter().all(|path| !path.exists()) {
            for path in &paths {
                storage::validate_existing_output_file(path)?;
            }
            return Ok(paths);
        }
    }
    Err("找不到不冲突的 PNG 帧序列文件名前缀。".to_string())
}

fn reserve_backup_path(directory: &Path, index: usize) -> Result<PathBuf, String> {
    for attempt in 0..=MAX_PREFIX_ATTEMPTS {
        let path = directory.join(format!(
            ".embedpix-sequence-backup-{}-{index}-{attempt}.tmp",
            std::process::id()
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                drop(file);
                fs::remove_file(&path)
                    .map_err(|error| format!("无法准备 PNG 帧序列回滚文件：{error}"))?;
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法准备 PNG 帧序列回滚文件：{error}")),
        }
    }
    Err("无法分配 PNG 帧序列回滚文件。".to_string())
}

fn publish_files<PublishGuard>(
    output_paths: &[PathBuf],
    temporary_files: &mut [TemporaryFile],
    overwrite_existing: bool,
    check_cancel: impl Fn() -> Result<(), String>,
    acquire_publish: impl FnOnce() -> Result<PublishGuard, String>,
    on_published: impl FnOnce(),
) -> Result<(), String> {
    let directory = output_paths
        .first()
        .and_then(|path| path.parent())
        .ok_or_else(|| "PNG 帧序列输出目录无效。".to_string())?;
    let mut backups = Vec::new();
    let mut published = Vec::new();
    check_cancel()?;
    let publish_guard = acquire_publish()?;
    let result = (|| {
        check_cancel()?;
        if overwrite_existing {
            for (index, output) in output_paths.iter().enumerate() {
                check_cancel()?;
                if fs::symlink_metadata(output).is_ok() {
                    let backup = reserve_backup_path(directory, index)?;
                    fs::rename(output, &backup)
                        .map_err(|error| format!("无法暂存原 PNG 帧 {}：{error}", index + 1))?;
                    backups.push((output.clone(), backup));
                }
            }
        }
        for (temporary, output) in temporary_files.iter_mut().zip(output_paths) {
            check_cancel()?;
            temporary.file.take();
            fs::rename(&temporary.path, output)
                .map_err(|error| format!("无法发布 PNG 帧 {}：{error}", published.len() + 1))?;
            temporary.cleanup = false;
            published.push(output.clone());
        }
        Ok::<(), String>(())
    })();

    if result.is_ok() {
        on_published();
        drop(publish_guard);
        for (_, backup) in backups {
            let _ = fs::remove_file(backup);
        }
        return Ok(());
    }

    for output in published.iter().rev() {
        let _ = fs::remove_file(output);
    }
    for (output, backup) in backups.into_iter().rev() {
        let _ = fs::rename(backup, output);
    }
    drop(publish_guard);
    Err(result.expect_err("publish result was checked"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, GenericImageView, ImageOutputFormat, Rgba, RgbaImage};
    use std::{
        io,
        sync::atomic::{AtomicUsize, Ordering},
    };

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            loop {
                let path = std::env::temp_dir().join(format!(
                    "embedpix-sequence-test-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("{error}"),
                }
            }
        }

        fn request(&self, frames: Vec<Vec<u8>>) -> PngSequenceExportRequest {
            PngSequenceExportRequest {
                output_dir: self.0.to_string_lossy().into_owned(),
                output_location: None,
                source_path: None,
                output_subdirectory: None,
                output_directory: None,
                base_name: "frame".to_string(),
                frames: frames
                    .into_iter()
                    .map(|data| PngSequenceFrameRequest {
                        data,
                        _duration_ms: 100,
                    })
                    .collect(),
                overwrite_existing: false,
                job_id: None,
            }
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn png(color: [u8; 4]) -> Vec<u8> {
        let image = DynamicImage::ImageRgba8(RgbaImage::from_pixel(2, 1, Rgba(color)));
        let mut output = Cursor::new(Vec::new());
        image.write_to(&mut output, ImageOutputFormat::Png).unwrap();
        output.into_inner()
    }

    #[test]
    fn exports_png_frames_with_padded_names_and_returns_paths() {
        let directory = TestDirectory::new();
        let paths = export_png_sequence_blocking(
            directory.request(vec![png([255, 0, 0, 255]), png([0, 255, 0, 255])]),
        )
        .unwrap();
        assert_eq!(paths.len(), 2);
        assert!(paths[0].ends_with("frame-001.png"));
        assert!(paths[1].ends_with("frame-002.png"));
        assert_eq!(image::open(&paths[0]).unwrap().dimensions(), (2, 1));
        assert_eq!(
            image::open(&paths[1]).unwrap().get_pixel(0, 0),
            Rgba([0, 255, 0, 255])
        );
    }

    #[test]
    fn non_overwrite_exports_choose_a_new_prefix() {
        let directory = TestDirectory::new();
        fs::write(directory.0.join("frame-001.png"), b"old").unwrap();
        let paths =
            export_png_sequence_blocking(directory.request(vec![png([1, 2, 3, 255])])).unwrap();
        assert!(paths[0].ends_with("frame-1-001.png"));
        assert_eq!(fs::read(directory.0.join("frame-001.png")).unwrap(), b"old");
    }

    #[test]
    fn overwrite_replaces_existing_sequence_after_encoding() {
        let directory = TestDirectory::new();
        fs::write(directory.0.join("frame-001.png"), b"old one").unwrap();
        fs::write(directory.0.join("frame-002.png"), b"old two").unwrap();
        let mut request = directory.request(vec![png([5, 6, 7, 255]), png([8, 9, 10, 255])]);
        request.overwrite_existing = true;
        export_png_sequence_blocking(request).unwrap();
        assert_eq!(
            image::open(directory.0.join("frame-001.png"))
                .unwrap()
                .get_pixel(0, 0),
            Rgba([5, 6, 7, 255])
        );
        assert_eq!(
            image::open(directory.0.join("frame-002.png"))
                .unwrap()
                .get_pixel(0, 0),
            Rgba([8, 9, 10, 255])
        );
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
    }

    #[test]
    fn source_subfolder_location_creates_a_safe_sequence_directory() {
        let directory = TestDirectory::new();
        let source = directory.0.join("source.png");
        fs::write(&source, b"source marker").unwrap();
        let mut request = directory.request(vec![png([11, 12, 13, 255])]);
        request.output_dir.clear();
        request.output_location = Some("subfolder".to_string());
        request.source_path = Some(source.to_string_lossy().into_owned());
        request.output_subdirectory = Some("exports".to_string());

        let paths = export_png_sequence_blocking(request).unwrap();
        assert_eq!(
            paths,
            vec![directory
                .0
                .join("exports")
                .join("frame-001.png")
                .to_string_lossy()
                .into_owned()]
        );
        assert_eq!(
            fs::read_dir(directory.0.join("exports")).unwrap().count(),
            1
        );
    }

    #[test]
    fn unified_output_locations_resolve_source_directory_and_path_safely() {
        let directory = TestDirectory::new();
        let source = directory.0.join("source.png");
        fs::write(&source, b"source marker").unwrap();

        let mut source_request = directory.request(vec![png([21, 22, 23, 255])]);
        source_request.output_dir.clear();
        source_request.output_location = Some("source".to_string());
        source_request.source_path = Some(source.to_string_lossy().into_owned());
        let source_paths = export_png_sequence_blocking(source_request).unwrap();
        assert!(source_paths[0].ends_with("frame-001.png"));

        let mut directory_request = directory.request(vec![png([24, 25, 26, 255])]);
        directory_request.output_dir.clear();
        directory_request.output_location = Some("directory".to_string());
        directory_request.output_directory =
            Some(directory.0.join("custom").to_string_lossy().into_owned());
        let directory_paths = export_png_sequence_blocking(directory_request).unwrap();
        assert!(
            directory_paths[0].ends_with("custom\\frame-001.png")
                || directory_paths[0].ends_with("custom/frame-001.png")
        );

        let mut path_request = directory.request(vec![png([27, 28, 29, 255])]);
        path_request.output_location = Some("path".to_string());
        let path_paths = export_png_sequence_blocking(path_request).unwrap();
        assert!(path_paths[0].ends_with("frame-1-001.png"));
    }

    #[test]
    fn unified_output_locations_reject_unsafe_subdirectories_before_writing() {
        let directory = TestDirectory::new();
        let source = directory.0.join("source.png");
        fs::write(&source, b"source marker").unwrap();
        let mut request = directory.request(vec![png([30, 31, 32, 255])]);
        request.output_dir.clear();
        request.output_location = Some("subfolder".to_string());
        request.source_path = Some(source.to_string_lossy().into_owned());
        request.output_subdirectory = Some("CON".to_string());
        assert!(export_png_sequence_blocking(request)
            .unwrap_err()
            .contains("保留设备名"));
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn failed_later_frame_leaves_no_partial_outputs_or_temporary_files() {
        let directory = TestDirectory::new();
        let mut request = directory.request(vec![png([1, 2, 3, 255]), b"not an image".to_vec()]);
        request.overwrite_existing = true;
        assert!(export_png_sequence_blocking(request).is_err());
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
    }

    #[test]
    fn rejects_oversized_source_frame_before_creating_outputs() {
        let directory = TestDirectory::new();
        let image = RgbaImage::new(super::super::MAX_GIF_DIMENSION + 1, 1);
        let mut output = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut output, ImageOutputFormat::Png)
            .unwrap();

        assert!(
            export_png_sequence_blocking(directory.request(vec![output.into_inner()])).is_err()
        );
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
    }

    #[test]
    fn normalizes_png_suffix_and_rejects_path_escape_names() {
        assert_eq!(normalize_base_name(" frame.png ").unwrap(), "frame");
        assert!(normalize_base_name("../frame").is_err());
        assert!(normalize_base_name("frame\\other").is_err());
    }

    #[test]
    fn estimates_png_sequence_size_in_memory_without_creating_output_paths() {
        let directory = TestDirectory::new();
        let custom_directory = directory.0.join("not-created");
        let mut request = directory.request(vec![png([41, 42, 43, 255]), png([44, 45, 46, 255])]);
        request.output_dir.clear();
        request.output_location = Some("directory".to_string());
        request.output_directory = Some(custom_directory.to_string_lossy().into_owned());

        let result = estimate_png_sequence_size_blocking(request).unwrap();

        assert_eq!(result.frames, 2);
        assert!(result.bytes > 0);
        assert!(!custom_directory.exists());
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
    }

    #[test]
    fn oversized_frame_is_removed_before_sequence_publish() {
        let directory = TestDirectory::new();
        let existing = directory.0.join("frame-001.png");
        fs::write(&existing, b"old frame").unwrap();
        let mut request = directory.request(vec![png([51, 52, 53, 255])]);
        request.overwrite_existing = true;

        let result = export_png_sequence_blocking_with_limit(request, 1);

        assert!(result.unwrap_err().contains("超过 1 字节 上限"));
        assert_eq!(fs::read(existing).unwrap(), b"old frame");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn failed_overwrite_publish_restores_originals_and_removes_backups() {
        let directory = TestDirectory::new();
        let first_output = directory.0.join("frame-001.png");
        let second_output = directory.0.join("frame-002.png");
        fs::write(&first_output, b"old one").unwrap();
        fs::write(&second_output, b"old two").unwrap();

        let mut first_temporary = TemporaryFile::create(&directory.0, 0).unwrap();
        first_temporary
            .file
            .as_mut()
            .unwrap()
            .write_all(b"new one")
            .unwrap();
        first_temporary.file.as_mut().unwrap().sync_all().unwrap();
        let second_temporary = TemporaryFile {
            path: directory.0.join("missing-frame.tmp"),
            file: None,
            cleanup: true,
        };
        let mut temporary_files = vec![first_temporary, second_temporary];

        let result = publish_files(
            &[first_output.clone(), second_output.clone()],
            &mut temporary_files,
            true,
            || Ok(()),
            || Ok(()),
            || {},
        );

        assert!(result.is_err());
        assert_eq!(fs::read(first_output).unwrap(), b"old one");
        assert_eq!(fs::read(second_output).unwrap(), b"old two");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
    }
}
