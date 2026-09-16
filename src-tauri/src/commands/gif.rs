use std::{
    io::{Cursor, Write},
    path::{Path, PathBuf},
};

use color_quant::NeuQuant;
use gif::{DisposalMethod, Encoder, Frame as GifFrame, Repeat};
use image::{
    imageops::FilterType,
    io::{Limits, Reader as ImageReader},
    ImageFormat,
};
use rfd::FileDialog;
use serde::{Deserialize, Serialize};

mod animation;
mod dither;
mod sequence;
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

#[derive(Debug, Deserialize)]
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
    frames: Vec<GifFrameRequest>,
    #[serde(default)]
    overwrite_existing: bool,
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
            overwrite_existing: false,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifFrameRequest {
    data: Vec<u8>,
    duration_ms: u32,
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
pub async fn export_gif(request: GifExportRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || export_gif_blocking(request))
        .await
        .map_err(|error| format!("GIF 导出任务失败：{error}"))?
}

#[tauri::command]
pub async fn estimate_gif_size(
    request: GifSizeEstimateRequest,
) -> Result<GifSizeEstimateResult, String> {
    tauri::async_runtime::spawn_blocking(move || estimate_gif_size_blocking(request))
        .await
        .map_err(|error| format!("GIF 体积测量任务失败：{error}"))?
}

#[tauri::command]
pub async fn pick_gif_sequence_output() -> Result<Option<String>, String> {
    sequence::pick_gif_sequence_output().await
}

#[tauri::command]
pub async fn export_png_sequence(
    request: sequence::PngSequenceExportRequest,
) -> Result<Vec<String>, String> {
    sequence::export_png_sequence(request).await
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
    request: animation::AnimationExportRequest,
) -> Result<String, String> {
    animation::export_webp_animation(request).await
}

#[tauri::command]
pub async fn export_apng(request: animation::AnimationExportRequest) -> Result<String, String> {
    animation::export_apng(request).await
}

fn export_gif_blocking(request: GifExportRequest) -> Result<String, String> {
    validate_request(&request)?;
    let output_path = resolve_output_path(&request)?;
    storage::write_output(&output_path, request.overwrite_existing, |file| {
        encode_gif(file, &request)
    })?;
    Ok(output_path.to_string_lossy().into_owned())
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

        for frame in &request.frames {
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
        }
    }
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
