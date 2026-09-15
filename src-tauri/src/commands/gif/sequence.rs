use std::{
    fs::{self, File, OpenOptions},
    io::{Cursor, Write},
    path::{Path, PathBuf},
};

use image::{io::Reader as ImageReader, ImageOutputFormat};
use rfd::FileDialog;
use serde::Deserialize;

const MAX_SEQUENCE_FRAMES: usize = 200;
const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;
const MAX_TOTAL_FRAME_BYTES: usize = 128 * 1024 * 1024;
const MAX_BASE_NAME_CHARS: usize = 120;
const MAX_PREFIX_ATTEMPTS: usize = 10_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PngSequenceExportRequest {
    output_dir: String,
    base_name: String,
    frames: Vec<PngSequenceFrameRequest>,
    #[serde(default)]
    overwrite_existing: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PngSequenceFrameRequest {
    data: Vec<u8>,
    #[serde(rename = "durationMs", default)]
    _duration_ms: u32,
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

pub async fn export_png_sequence(request: PngSequenceExportRequest) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || export_png_sequence_blocking(request))
        .await
        .map_err(|error| format!("PNG 帧序列导出任务失败：{error}"))?
}

fn export_png_sequence_blocking(request: PngSequenceExportRequest) -> Result<Vec<String>, String> {
    let directory = validate_output_directory(&request.output_dir)?;
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
        let mut temporary = TemporaryFile::create(&directory, index)?;
        encode_png_frame(
            temporary.file.as_mut().expect("temporary file is open"),
            frame,
        )?;
        temporary
            .file
            .as_mut()
            .expect("temporary file is open")
            .sync_all()
            .map_err(|error| format!("无法完成第 {} 帧 PNG 写入：{error}", index + 1))?;
        temporary_files.push(temporary);
    }

    publish_files(
        &output_paths,
        &mut temporary_files,
        request.overwrite_existing,
    )?;
    Ok(output_paths
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

fn validate_output_directory(value: &str) -> Result<PathBuf, String> {
    let directory = PathBuf::from(value.trim());
    if directory.as_os_str().is_empty() {
        return Err("PNG 帧序列输出目录不能为空。".to_string());
    }
    let metadata = fs::symlink_metadata(&directory)
        .map_err(|error| format!("无法访问 PNG 帧序列输出目录：{error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("PNG 帧序列输出路径必须是普通目录。".to_string());
    }
    Ok(directory)
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
    frames.iter().try_fold(0usize, |total, frame| {
        if frame.data.is_empty() || frame.data.len() > MAX_FRAME_BYTES {
            return Err("单帧图片不能为空且不能超过 32 MiB。".to_string());
        }
        total
            .checked_add(frame.data.len())
            .filter(|value| *value <= MAX_TOTAL_FRAME_BYTES)
            .ok_or_else(|| "PNG 帧序列图片数据不能超过 128 MiB。".to_string())
    })?;
    Ok(())
}

fn encode_png_frame(writer: &mut File, frame: &PngSequenceFrameRequest) -> Result<(), String> {
    let reader = ImageReader::new(Cursor::new(&frame.data))
        .with_guessed_format()
        .map_err(|error| format!("无法识别 PNG 帧输入格式：{error}"))?;
    let image = reader
        .decode()
        .map_err(|error| format!("无法读取 PNG 帧：{error}"))?;
    image
        .write_to(writer, ImageOutputFormat::Png)
        .map_err(|error| format!("无法编码 PNG 帧：{error}"))?;
    writer
        .flush()
        .map_err(|error| format!("无法完成 PNG 帧编码：{error}"))
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
                if let Ok(metadata) = fs::symlink_metadata(path) {
                    if !metadata.is_file() || metadata.file_type().is_symlink() {
                        return Err(format!(
                            "PNG 帧序列输出路径已存在但不是普通文件：{}",
                            path.display()
                        ));
                    }
                }
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

fn publish_files(
    output_paths: &[PathBuf],
    temporary_files: &mut [TemporaryFile],
    overwrite_existing: bool,
) -> Result<(), String> {
    let directory = output_paths
        .first()
        .and_then(|path| path.parent())
        .ok_or_else(|| "PNG 帧序列输出目录无效。".to_string())?;
    let mut backups = Vec::new();
    let mut published = Vec::new();
    let result = (|| {
        if overwrite_existing {
            for (index, output) in output_paths.iter().enumerate() {
                if fs::symlink_metadata(output).is_ok() {
                    let backup = reserve_backup_path(directory, index)?;
                    fs::rename(output, &backup)
                        .map_err(|error| format!("无法暂存原 PNG 帧 {}：{error}", index + 1))?;
                    backups.push((output.clone(), backup));
                }
            }
        }
        for (temporary, output) in temporary_files.iter_mut().zip(output_paths) {
            temporary.file.take();
            fs::rename(&temporary.path, output)
                .map_err(|error| format!("无法发布 PNG 帧 {}：{error}", published.len() + 1))?;
            temporary.cleanup = false;
            published.push(output.clone());
        }
        Ok::<(), String>(())
    })();

    if result.is_ok() {
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
                base_name: "frame".to_string(),
                frames: frames
                    .into_iter()
                    .map(|data| PngSequenceFrameRequest {
                        data,
                        _duration_ms: 100,
                    })
                    .collect(),
                overwrite_existing: false,
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
            Rgba([0, 255, 0, 255]).into()
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
            Rgba([5, 6, 7, 255]).into()
        );
        assert_eq!(
            image::open(directory.0.join("frame-002.png"))
                .unwrap()
                .get_pixel(0, 0),
            Rgba([8, 9, 10, 255]).into()
        );
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
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
    fn normalizes_png_suffix_and_rejects_path_escape_names() {
        assert_eq!(normalize_base_name(" frame.png ").unwrap(), "frame");
        assert!(normalize_base_name("../frame").is_err());
        assert!(normalize_base_name("frame\\other").is_err());
    }
}
