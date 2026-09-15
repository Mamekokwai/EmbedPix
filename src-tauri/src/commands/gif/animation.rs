use std::{
    io::{Cursor, Write},
    path::{Path, PathBuf},
};

use apng::image_png::{BitDepth, ColorType, FilterType};
use apng::{BlendOp, DisposeOp, Frame as ApngFrame, PNGImage};
use image::{imageops::FilterType as ResizeFilter, io::Reader as ImageReader};
use rfd::FileDialog;
use serde::Deserialize;
use webp_animation::{AnimParams, Encoder as WebpEncoder, EncoderOptions, EncodingConfig};

use super::{decode_limits, detect_format, inspect_frame_dimensions, GifFrameRequest};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimationExportRequest {
    output_path: String,
    width: u32,
    height: u32,
    loop_mode: String,
    loop_count: u16,
    frames: Vec<GifFrameRequest>,
    #[serde(default)]
    overwrite_existing: bool,
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
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || export_animation_blocking(request, "webp"))
        .await
        .map_err(|error| format!("WebP 动图导出任务失败：{error}"))?
}

pub(super) async fn export_apng(request: AnimationExportRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || export_animation_blocking(request, "apng"))
        .await
        .map_err(|error| format!("APNG 导出任务失败：{error}"))?
}

fn export_animation_blocking(
    request: AnimationExportRequest,
    format: &str,
) -> Result<String, String> {
    validate_request(&request, format)?;
    let output_path = normalize_output_path(&request.output_path, format)?;
    storage::write_output(&output_path, request.overwrite_existing, |file| {
        let frames = prepare_frames(&request)?;
        if format == "webp" {
            encode_webp(file, &request, &frames)
        } else {
            encode_apng(file, &request, &frames)
        }
    })?;
    Ok(output_path.to_string_lossy().into_owned())
}

fn prepare_frames(request: &AnimationExportRequest) -> Result<Vec<Vec<u8>>, String> {
    request
        .frames
        .iter()
        .enumerate()
        .map(|(index, frame)| {
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
        })
        .collect()
}

fn encode_webp<W: Write>(
    writer: &mut W,
    request: &AnimationExportRequest,
    frames: &[Vec<u8>],
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
    for (index, (pixels, frame)) in frames.iter().zip(&request.frames).enumerate() {
        let timestamp_ms =
            i32::try_from(timestamp).map_err(|_| "WebP 动图总时长超出编码器限制。".to_string())?;
        encoder
            .add_frame(pixels, timestamp_ms)
            .map_err(|error| format!("无法编码第 {} 帧 WebP 动图：{error}", index + 1))?;
        timestamp = timestamp
            .checked_add(u64::from(super::quantize_duration_ms(frame.duration_ms)))
            .ok_or_else(|| "WebP 动图总时长超出编码器限制。".to_string())?;
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
        .map_err(|error| format!("无法完成 WebP 动图写入：{error}"))
}

fn encode_apng<W: Write>(
    writer: &mut W,
    request: &AnimationExportRequest,
    frames: &[Vec<u8>],
) -> Result<(), String> {
    let config = apng::Config {
        width: request.width,
        height: request.height,
        num_frames: frames.len() as u32,
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
    for (index, (pixels, frame)) in frames.iter().zip(&request.frames).enumerate() {
        let image = PNGImage {
            width: request.width,
            height: request.height,
            data: pixels.clone(),
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
    }
    encoder
        .finish_encode()
        .map_err(|error| format!("无法完成 APNG 编码：{error}"))?;
    writer
        .flush()
        .map_err(|error| format!("无法完成 APNG 写入：{error}"))
}

fn validate_request(request: &AnimationExportRequest, format: &str) -> Result<(), String> {
    normalize_output_path(&request.output_path, format)?;
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
    let mut total_bytes = 0usize;
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

fn normalize_output_path(value: &str, format: &str) -> Result<PathBuf, String> {
    let extension = normalize_format(format)?;
    let path = PathBuf::from(value.trim());
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "动图输出路径无效。".to_string())?;
    if !file_name
        .to_ascii_lowercase()
        .ends_with(&format!(".{extension}"))
    {
        return Err(format!(
            "{extension} 动图输出文件必须使用 .{extension} 扩展名。"
        ));
    }
    Ok(path)
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
            width: 2,
            height: 1,
            loop_mode: "infinite".to_string(),
            loop_count: 0,
            frames: vec![
                png_frame([255, 0, 0, 255], 100),
                png_frame([0, 255, 0, 255], 200),
            ],
            overwrite_existing: false,
        }
    }

    #[test]
    fn encodes_decodable_webp_animation_with_frame_timing() {
        let request = request();
        let frames = prepare_frames(&request).unwrap();
        let mut output = Vec::new();
        encode_webp(&mut output, &request, &frames).unwrap();

        assert_eq!(&output[..4], b"RIFF");
        assert_eq!(&output[8..12], b"WEBP");
        let decoder = webp_animation::Decoder::new(&output).unwrap();
        assert_eq!(decoder.dimensions(), (2, 1));
        assert_eq!(decoder.into_iter().count(), 2);
    }

    #[test]
    fn encodes_apng_with_animation_and_frame_controls() {
        let request = request();
        let frames = prepare_frames(&request).unwrap();
        let mut output = Vec::new();
        encode_apng(&mut output, &request, &frames).unwrap();

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
}
