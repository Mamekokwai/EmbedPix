use std::{
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use apng::image_png::{BitDepth, ColorType, FilterType};
use apng::{BlendOp, DisposeOp, Frame as ApngFrame, PNGImage};
use image::{imageops::FilterType as ResizeFilter, io::Reader as ImageReader};
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use webp_animation::{AnimParams, Encoder as WebpEncoder, EncoderOptions, EncodingConfig};

use super::{
    decode_limits, detect_format, inspect_frame_dimensions, job_begin_publish, job_checkpoint,
    job_mark_published, job_report, EncodingSemaphore, ExportJob, GifFrameRequest,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimationExportRequest {
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
    pub(super) frames: Vec<GifFrameRequest>,
    #[serde(default)]
    overwrite_existing: bool,
    #[serde(default)]
    pub(super) job_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AnimationSizeEstimateResult {
    pub bytes: u64,
}

pub(super) async fn pick_animation_output(
    format: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let extension = normalize_format(&format)?;
    let file_name = normalize_suggested_name(&suggested_name, extension);
    Ok(FileDialog::new()
        .add_filter(
            if extension == "webp" {
                "WebP 动图"
            } else {
                "APNG 动图"
            },
            &[extension],
        )
        .set_file_name(&file_name)
        .save_file()
        .map(|path| path.to_string_lossy().into_owned()))
}

pub(super) async fn export_webp_animation(
    request: AnimationExportRequest,
    job: ExportJob,
    encoder_slots: Arc<EncodingSemaphore>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _encoding_permit = encoder_slots.acquire();
        export_animation_blocking_with_job(request, "webp", job)
    })
    .await
    .map_err(|error| format!("WebP 动图导出任务失败：{error}"))?
}

pub(super) async fn export_apng(
    request: AnimationExportRequest,
    job: ExportJob,
    encoder_slots: Arc<EncodingSemaphore>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _encoding_permit = encoder_slots.acquire();
        export_animation_blocking_with_job(request, "apng", job)
    })
    .await
    .map_err(|error| format!("APNG 导出任务失败：{error}"))?
}

pub(super) async fn estimate_animation_size(
    format: String,
    request: AnimationExportRequest,
    encoder_slots: Arc<EncodingSemaphore>,
) -> Result<AnimationSizeEstimateResult, String> {
    let format = normalize_format(&format)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _encoding_permit = encoder_slots.acquire();
        estimate_animation_size_blocking(request, format)
    })
    .await
    .map_err(|error| format!("{format} 体积测量任务失败：{error}"))?
}

#[cfg(test)]
fn export_animation_blocking(
    request: AnimationExportRequest,
    format: &str,
) -> Result<String, String> {
    export_animation_blocking_with_job(request, format, None)
}

fn export_animation_blocking_with_job(
    request: AnimationExportRequest,
    format: &str,
    job: ExportJob,
) -> Result<String, String> {
    job_report(&job, "validating", 0);
    job_checkpoint(&job)?;
    validate_request(&request, format)?;
    let output_path = resolve_output_path(&request, format)?;
    let publish_job = job.clone();
    let completed_job = job.clone();
    let completed_path = output_path.to_string_lossy().into_owned();
    storage::write_output_with_publish(
        &output_path,
        request.overwrite_existing,
        storage::MAX_OUTPUT_BYTES,
        |file| {
            if format == "webp" {
                encode_webp_with_job(file, &request, &job)
            } else {
                encode_apng_with_job(file, &request, &job)
            }
        },
        || job_checkpoint(&job),
        move || job_begin_publish(&publish_job),
        move || job_mark_published(&completed_job, completed_path),
    )?;
    Ok(output_path.to_string_lossy().into_owned())
}

fn estimate_animation_size_blocking(
    request: AnimationExportRequest,
    format: &str,
) -> Result<AnimationSizeEstimateResult, String> {
    validate_animation_request(&request, format)?;
    let mut output = Vec::new();
    if format == "webp" {
        encode_webp(&mut output, &request)?;
    } else {
        encode_apng(&mut output, &request)?;
    }
    Ok(AnimationSizeEstimateResult {
        bytes: output.len() as u64,
    })
}

fn prepare_frame(request: &AnimationExportRequest, index: usize) -> Result<Vec<u8>, String> {
    let frame = &request.frames[index];
    let mut reader =
        ImageReader::with_format(Cursor::new(&frame.data), detect_format(&frame.data)?);
    reader.limits(decode_limits());
    let image = reader
        .decode()
        .map_err(|error| format!("无法读取第 {} 帧：{error}", index + 1))?;
    let image = if image.width() == request.width && image.height() == request.height {
        image.into_rgba8()
    } else {
        image
            .resize_exact(request.width, request.height, ResizeFilter::Lanczos3)
            .into_rgba8()
    };
    Ok(image.into_raw())
}

fn encode_webp<W: Write>(writer: &mut W, request: &AnimationExportRequest) -> Result<(), String> {
    encode_webp_with_job(writer, request, &None)
}

fn encode_webp_with_job<W: Write>(
    writer: &mut W,
    request: &AnimationExportRequest,
    job: &ExportJob,
) -> Result<(), String> {
    let mut options = EncoderOptions {
        anim_params: AnimParams {
            loop_count: if request.loop_mode == "finite" {
                request.loop_count as i32
            } else {
                0
            },
        },
        minimize_size: true,
        ..Default::default()
    };
    options.encoding_config = Some(EncodingConfig::new_lossy(90.0));
    let mut encoder = WebpEncoder::new_with_options((request.width, request.height), options)
        .map_err(|error| format!("无法创建 WebP 动图编码器：{error}"))?;
    let mut timestamp = 0u64;
    for (index, frame) in request.frames.iter().enumerate() {
        job_checkpoint(job)?;
        let pixels = prepare_frame(request, index)?;
        let timestamp_ms =
            i32::try_from(timestamp).map_err(|_| "WebP 动图总时长超出编码器限制。".to_string())?;
        encoder
            .add_frame(&pixels, timestamp_ms)
            .map_err(|error| format!("无法编码第 {} 帧 WebP 动图：{error}", index + 1))?;
        timestamp = timestamp
            .checked_add(u64::from(super::quantize_duration_ms(frame.duration_ms)))
            .ok_or_else(|| "WebP 动图总时长超出编码器限制。".to_string())?;
        job_report(job, "encoding", index + 1);
    }
    let final_timestamp =
        i32::try_from(timestamp).map_err(|_| "WebP 动图总时长超出编码器限制。".to_string())?;
    let encoded = encoder
        .finalize(final_timestamp)
        .map_err(|error| format!("无法完成 WebP 动图编码：{error}"))?;
    writer
        .write_all(encoded.as_ref())
        .map_err(|error| format!("无法写入 WebP 动图：{error}"))?;
    writer
        .flush()
        .map_err(|error| format!("无法完成 WebP 动图写入：{error}"))?;
    job_checkpoint(job)
}

fn encode_apng<W: Write>(writer: &mut W, request: &AnimationExportRequest) -> Result<(), String> {
    encode_apng_with_job(writer, request, &None)
}

fn encode_apng_with_job<W: Write>(
    writer: &mut W,
    request: &AnimationExportRequest,
    job: &ExportJob,
) -> Result<(), String> {
    let config = apng::Config {
        width: request.width,
        height: request.height,
        num_frames: request.frames.len() as u32,
        num_plays: if request.loop_mode == "finite" {
            request.loop_count as u32
        } else {
            0
        },
        color: ColorType::Rgba,
        depth: BitDepth::Eight,
        filter: FilterType::NoFilter,
    };
    let mut encoder = apng::Encoder::new(writer, config)
        .map_err(|error| format!("无法创建 APNG 编码器：{error}"))?;
    for (index, frame) in request.frames.iter().enumerate() {
        job_checkpoint(job)?;
        let pixels = prepare_frame(request, index)?;
        let image = PNGImage {
            width: request.width,
            height: request.height,
            data: pixels,
            color_type: ColorType::Rgba,
            bit_depth: BitDepth::Eight,
        };
        let frame = ApngFrame {
            delay_num: Some(super::quantize_duration_ms(frame.duration_ms) as u16),
            delay_den: Some(1000),
            dispose_op: Some(DisposeOp::ApngDisposeOpBackground),
            blend_op: Some(BlendOp::ApngBlendOpSource),
            ..Default::default()
        };
        encoder
            .write_frame(&image, frame)
            .map_err(|error| format!("无法编码第 {} 帧 APNG：{error}", index + 1))?;
        job_report(job, "encoding", index + 1);
    }
    encoder
        .finish_encode()
        .map_err(|error| format!("无法完成 APNG 编码：{error}"))?;
    writer
        .flush()
        .map_err(|error| format!("无法完成 APNG 写入：{error}"))?;
    job_checkpoint(job)
}

fn validate_request(request: &AnimationExportRequest, format: &str) -> Result<(), String> {
    resolve_output_path(request, format)?;
    validate_animation_request(request, format)
}

fn validate_animation_request(
    request: &AnimationExportRequest,
    format: &str,
) -> Result<(), String> {
    normalize_format(format)?;
    if request.width == 0
        || request.height == 0
        || request.width > super::MAX_GIF_DIMENSION
        || request.height > super::MAX_GIF_DIMENSION
        || u64::from(request.width).saturating_mul(u64::from(request.height))
            > super::MAX_GIF_PIXELS
    {
        return Err("动图画布尺寸超出限制，最大为 4096 × 4096 且不超过 16 MP。".to_string());
    }
    if request.frames.is_empty() || request.frames.len() > super::MAX_GIF_FRAMES {
        return Err(format!(
            "动图帧数必须在 1 到 {} 之间。",
            super::MAX_GIF_FRAMES
        ));
    }
    if request.loop_mode != "infinite" && request.loop_mode != "finite" {
        return Err("动图循环模式无效。".to_string());
    }
    if request.loop_mode == "finite" && request.loop_count == 0 {
        return Err("有限循环次数必须大于 0。".to_string());
    }
    let canvas_pixels = u64::from(request.width).saturating_mul(u64::from(request.height));
    if canvas_pixels.saturating_mul(request.frames.len() as u64) > super::MAX_TOTAL_GIF_PIXELS {
        return Err("动图总像素量超出限制，请减少帧数或画布尺寸。".to_string());
    }
    let mut total_bytes = 0usize;
    let mut source_pixels = 0u64;
    for (index, frame) in request.frames.iter().enumerate() {
        if frame.data.is_empty() || frame.data.len() > super::MAX_FRAME_BYTES {
            return Err(format!("第 {} 帧不能为空且不能超过 32 MiB。", index + 1));
        }
        if !(super::MIN_FRAME_DURATION_MS..=super::MAX_FRAME_DURATION_MS)
            .contains(&frame.duration_ms)
        {
            return Err("帧时长必须在 10 到 60000 毫秒之间。".to_string());
        }
        total_bytes = total_bytes
            .checked_add(frame.data.len())
            .filter(|value| *value <= super::MAX_TOTAL_FRAME_BYTES)
            .ok_or_else(|| "动图所有帧的图片数据不能超过 128 MiB。".to_string())?;
        let dimensions = inspect_frame_dimensions(&frame.data)
            .map_err(|error| format!("第 {} 帧：{error}", index + 1))?;
        super::validate_frame_dimensions(dimensions.0, dimensions.1)?;
        source_pixels = source_pixels
            .checked_add(u64::from(dimensions.0).saturating_mul(u64::from(dimensions.1)))
            .filter(|value| *value <= super::MAX_TOTAL_GIF_PIXELS)
            .ok_or_else(|| "动图源帧总像素量超出限制。".to_string())?;
    }
    Ok(())
}

fn normalize_format(value: &str) -> Result<&'static str, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "webp" => Ok("webp"),
        "apng" => Ok("apng"),
        _ => Err("动图输出格式必须为 WebP 或 APNG。".to_string()),
    }
}

fn resolve_output_path(request: &AnimationExportRequest, format: &str) -> Result<PathBuf, String> {
    storage::resolve_output_file_path(
        &request.output_path,
        request.output_location.as_deref(),
        request.source_path.as_deref(),
        request.output_subdirectory.as_deref(),
        request.output_directory.as_deref(),
        request.file_name.as_deref(),
        normalize_format(format)?,
    )
}

fn normalize_suggested_name(value: &str, extension: &str) -> String {
    let name = value.trim();
    let name = if name.is_empty() { "animation" } else { name };
    let name = Path::new(name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("animation");
    let suffix = format!(".{extension}");
    if name.to_ascii_lowercase().ends_with(&suffix) {
        name.to_string()
    } else {
        format!("{name}{suffix}")
    }
}

use super::storage;

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageOutputFormat, Rgba, RgbaImage};
    use std::{
        fs, io,
        sync::atomic::{AtomicUsize, Ordering},
    };

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            loop {
                let path = std::env::temp_dir().join(format!(
                    "embedpix-animation-test-{}-{}",
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

        fn request(&self, format: &str) -> AnimationExportRequest {
            let mut request = request();
            request.output_path = self
                .0
                .join(format!("animation.{format}"))
                .to_string_lossy()
                .into_owned();
            request.output_location = None;
            request.source_path = None;
            request.output_subdirectory = None;
            request.output_directory = None;
            request.file_name = None;
            request
        }

        fn assert_empty(&self) {
            assert_eq!(fs::read_dir(self.0.clone()).unwrap().count(), 0);
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn png_frame(color: [u8; 4], duration_ms: u32) -> GifFrameRequest {
        let image = DynamicImage::ImageRgba8(RgbaImage::from_pixel(2, 1, Rgba(color)));
        let mut output = Cursor::new(Vec::new());
        image.write_to(&mut output, ImageOutputFormat::Png).unwrap();
        GifFrameRequest {
            data: output.into_inner(),
            duration_ms,
        }
    }

    fn request() -> AnimationExportRequest {
        AnimationExportRequest {
            output_path: "animation.webp".to_string(),
            output_location: None,
            source_path: None,
            output_subdirectory: None,
            output_directory: None,
            file_name: None,
            width: 2,
            height: 1,
            loop_mode: "infinite".to_string(),
            loop_count: 0,
            frames: vec![
                png_frame([255, 0, 0, 255], 100),
                png_frame([0, 255, 0, 255], 200),
            ],
            overwrite_existing: false,
            job_id: None,
        }
    }

    #[test]
    fn encodes_decodable_webp_animation_with_frame_timing() {
        let request = request();
        let mut output = Vec::new();
        encode_webp(&mut output, &request).unwrap();

        assert_eq!(&output[..4], b"RIFF");
        assert_eq!(&output[8..12], b"WEBP");
        let decoder = webp_animation::Decoder::new(&output).unwrap();
        assert_eq!(decoder.dimensions(), (2, 1));
        assert_eq!(decoder.into_iter().count(), 2);
    }

    #[test]
    fn encodes_apng_with_animation_and_frame_controls() {
        let request = request();
        let mut output = Vec::new();
        encode_apng(&mut output, &request).unwrap();

        assert_eq!(&output[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(
            output.windows(4).filter(|chunk| *chunk == b"acTL").count(),
            1
        );
        assert_eq!(
            output.windows(4).filter(|chunk| *chunk == b"fcTL").count(),
            2
        );
        assert_eq!(
            output.windows(4).filter(|chunk| *chunk == b"fdAT").count(),
            1
        );
    }

    #[test]
    fn estimates_webp_and_apng_in_memory_without_publishing_output() {
        let directory = TestDirectory::new();
        for format in ["webp", "apng"] {
            let request = directory.request(format);
            let mut encoded = Vec::new();
            if format == "webp" {
                encode_webp(&mut encoded, &request).unwrap();
            } else {
                encode_apng(&mut encoded, &request).unwrap();
            }
            let measured =
                estimate_animation_size_blocking(directory.request(format), format).unwrap();
            assert_eq!(measured.bytes, encoded.len() as u64);
            assert!(!directory.0.join(format!("animation.{format}")).exists());
        }
        directory.assert_empty();
    }

    #[test]
    fn size_estimate_reuses_animation_validation_without_accepting_unknown_formats() {
        let directory = TestDirectory::new();
        let mut request = directory.request("webp");
        request.width = 0;
        assert!(estimate_animation_size_blocking(request, "webp")
            .unwrap_err()
            .contains("画布尺寸"));
        assert!(
            estimate_animation_size_blocking(directory.request("webp"), "gif")
                .unwrap_err()
                .contains("WebP 或 APNG")
        );
        directory.assert_empty();
    }

    #[test]
    fn finite_apng_preserves_loop_count_and_quantized_delays() {
        let mut request = request();
        request.loop_mode = "finite".to_string();
        request.loop_count = 3;
        request.frames[0].duration_ms = 19;
        request.frames[1].duration_ms = 25;
        let mut output = Vec::new();
        encode_apng(&mut output, &request).unwrap();

        let animation_control = png_chunks(&output, b"acTL").pop().unwrap();
        assert_eq!(
            u32::from_be_bytes(animation_control[4..8].try_into().unwrap()),
            3
        );
        let frame_controls = png_chunks(&output, b"fcTL");
        assert_eq!(frame_controls.len(), 2);
        assert_eq!(
            u16::from_be_bytes(frame_controls[0][20..22].try_into().unwrap()),
            10
        );
        assert_eq!(
            u16::from_be_bytes(frame_controls[1][20..22].try_into().unwrap()),
            20
        );
    }

    #[test]
    fn default_overwrite_refuses_existing_animation() {
        let directory = TestDirectory::new();
        let request = directory.request("apng");
        let output = PathBuf::from(&request.output_path);
        fs::write(&output, b"old animation").unwrap();

        assert!(export_animation_blocking(request, "apng").is_err());
        assert_eq!(fs::read(output).unwrap(), b"old animation");
        assert_eq!(fs::read_dir(directory.0.clone()).unwrap().count(), 1);
    }

    #[test]
    fn failed_later_animation_frame_preserves_existing_output_and_cleans_temp() {
        let directory = TestDirectory::new();
        let mut request = directory.request("webp");
        request.overwrite_existing = true;
        request.frames[1].data = b"not an image".to_vec();
        let output = PathBuf::from(&request.output_path);
        fs::write(&output, b"old animation").unwrap();

        assert!(export_animation_blocking(request, "webp").is_err());
        assert_eq!(fs::read(output).unwrap(), b"old animation");
        assert_eq!(fs::read_dir(directory.0.clone()).unwrap().count(), 1);
    }

    fn png_chunks(output: &[u8], wanted: &[u8; 4]) -> Vec<Vec<u8>> {
        let mut chunks = Vec::new();
        let mut offset = 8;
        while offset + 12 <= output.len() {
            let length =
                u32::from_be_bytes(output[offset..offset + 4].try_into().unwrap()) as usize;
            let data_start = offset + 8;
            let data_end = data_start + length;
            if data_end + 4 > output.len() {
                break;
            }
            if &output[offset + 4..offset + 8] == wanted {
                chunks.push(output[data_start..data_end].to_vec());
            }
            offset = data_end + 4;
        }
        chunks
    }
}
