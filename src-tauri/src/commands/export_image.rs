use std::{
    fs,
    io::{self, Cursor, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, io::Reader as ImageReader, DynamicImage,
    GenericImage, ImageFormat, Rgba, RgbaImage,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request};

mod bmp;
mod raw;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 64 * 1024;
const MAX_SOURCE_FILE_NAME_BYTES: usize = 1024;
const MAX_OUTPUT_PATH_BYTES: usize = 4096;
const MAX_OUTPUT_SUBDIRECTORY_BYTES: usize = 255;
const MAX_DEFAULT_STEM_CHARS: usize = 120;
const MAX_IMAGE_DIMENSION: u32 = 8_192;
const MAX_IMAGE_PIXELS: u64 = 16_777_216;
const MAX_DECODER_ALLOC_BYTES: u64 = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputFormat {
    Png,
    Jpg,
    Bmp,
    Rgb565,
    CArray,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputLocation {
    Dialog,
    Source,
    Subfolder,
    Directory,
}

impl OutputLocation {
    fn parse(value: Option<&str>) -> Result<Self, String> {
        match value
            .unwrap_or("dialog")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "dialog" => Ok(Self::Dialog),
            "source" => Ok(Self::Source),
            "subfolder" => Ok(Self::Subfolder),
            "directory" => Ok(Self::Directory),
            other => Err(format!(
                "unsupported output location `{other}`; expected source, subfolder, or directory"
            )),
        }
    }
}

impl OutputFormat {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "png" => Ok(Self::Png),
            "jpg" | "jpeg" => Ok(Self::Jpg),
            "bmp" => Ok(Self::Bmp),
            "rgb565" => Ok(Self::Rgb565),
            "c-array" | "c_array" => Ok(Self::CArray),
            other => Err(format!(
                "unsupported output format `{other}`; expected png, jpg, bmp, rgb565, or c-array"
            )),
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpg => "jpg",
            Self::Bmp => "bmp",
            Self::Rgb565 => "bin",
            Self::CArray => "h",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpg => "jpg",
            Self::Bmp => "bmp",
            Self::Rgb565 => "rgb565",
            Self::CArray => "c-array",
        }
    }
}

#[derive(Debug, Clone)]
struct ExportRequest {
    input_data: Vec<u8>,
    source_file_name: String,
    output_format: OutputFormat,
    width: u32,
    height: u32,
    keep_aspect_ratio: bool,
    background_color: Rgba<u8>,
    bit_depth: u16,
    jpeg_quality: u8,
    raw_options: raw::RawOptions,
    c_array_name: String,
    output_location: OutputLocation,
    source_path: Option<String>,
    output_subdirectory: Option<String>,
    output_directory: Option<String>,
    overwrite_existing: bool,
    delete_source: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct ExportMetadata {
    file_name: String,
    output_format: String,
    width: u32,
    height: u32,
    keep_aspect_ratio: bool,
    background_color: Option<String>,
    bit_depth: Option<u16>,
    #[serde(default)]
    jpeg_quality: Option<u8>,
    #[serde(default)]
    byte_order: Option<String>,
    #[serde(default)]
    channel_order: Option<String>,
    #[serde(default)]
    row_order: Option<String>,
    #[serde(default)]
    row_alignment: Option<u8>,
    #[serde(default)]
    c_array_name: Option<String>,
    #[serde(default)]
    output_location: Option<String>,
    #[serde(default)]
    source_path: Option<String>,
    #[serde(default)]
    output_subdirectory: Option<String>,
    #[serde(default)]
    output_directory: Option<String>,
    #[serde(default)]
    overwrite_existing: bool,
    #[serde(default)]
    delete_source: bool,
}

impl ExportMetadata {
    fn into_request(self, input_data: Vec<u8>) -> Result<ExportRequest, String> {
        let source_file_name = self.file_name;
        validate_source_file_name(&source_file_name)?;
        validate_input_size(&input_data)?;
        let output_format = OutputFormat::parse(&self.output_format)?;
        let output_location = OutputLocation::parse(self.output_location.as_deref())?;
        let source_path = normalize_optional_path(self.source_path, "sourcePath")?;
        let output_directory = normalize_optional_path(self.output_directory, "outputDirectory")?;
        let output_subdirectory = normalize_optional_subdirectory(self.output_subdirectory)?;
        let bit_depth = self.bit_depth.unwrap_or(match output_format {
            OutputFormat::Rgb565 | OutputFormat::CArray => 16,
            _ => 24,
        });
        let jpeg_quality = self.jpeg_quality.unwrap_or(85);
        if !(1..=100).contains(&jpeg_quality) {
            return Err("jpegQuality must be between 1 and 100".to_string());
        }
        Ok(ExportRequest {
            input_data,
            source_file_name: source_file_name.clone(),
            output_format,
            width: self.width,
            height: self.height,
            keep_aspect_ratio: self.keep_aspect_ratio,
            background_color: parse_background_color(self.background_color.as_deref())?,
            bit_depth,
            jpeg_quality,
            raw_options: raw::RawOptions::parse(
                self.byte_order.as_deref(),
                self.channel_order.as_deref(),
                self.row_order.as_deref(),
                self.row_alignment,
            )?,
            c_array_name: self
                .c_array_name
                .as_deref()
                .map(raw::sanitize_c_array_name)
                .unwrap_or_else(|| raw::default_c_array_name(&source_file_name)),
            output_location,
            source_path,
            output_subdirectory,
            output_directory,
            overwrite_existing: self.overwrite_existing,
            delete_source: self.delete_source,
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportImageResult {
    pub output_path: String,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub bit_depth: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeImageFile {
    pub path: String,
    pub file_name: String,
    pub data: Vec<u8>,
}

#[tauri::command(rename_all = "camelCase")]
pub async fn pick_image() -> Result<Option<NativeImageFile>, String> {
    let path = rfd::FileDialog::new()
        .set_title("选择图片")
        .add_filter("图片", &["png", "jpg", "jpeg", "bmp", "gif", "webp"])
        .pick_file();
    let Some(path) = path else {
        return Ok(None);
    };

    tauri::async_runtime::spawn_blocking(move || read_image_file_from_path(path))
        .await
        .map_err(|error| format!("image read task failed: {error}"))?
        .map(Some)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn read_image_file(path: String) -> Result<NativeImageFile, String> {
    tauri::async_runtime::spawn_blocking(move || read_image_file_from_path(PathBuf::from(path)))
        .await
        .map_err(|error| format!("image read task failed: {error}"))?
}

fn read_image_file_from_path(path: PathBuf) -> Result<NativeImageFile, String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "selected image has no valid file name".to_string())?
        .to_string();
    validate_source_file_name(&file_name)?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("failed to inspect selected image: {error}"))?;
    if metadata.len() > MAX_INPUT_BYTES as u64 {
        return Err(format!(
            "image file cannot exceed {} MiB",
            MAX_INPUT_BYTES / (1024 * 1024)
        ));
    }
    let data =
        fs::read(&path).map_err(|error| format!("failed to read selected image: {error}"))?;
    Ok(NativeImageFile {
        path: path.to_string_lossy().into_owned(),
        file_name,
        data,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn export_image(request: Request<'_>) -> Result<ExportImageResult, String> {
    let request = parse_raw_request(request)?;
    let source_file_name = request.source_file_name.clone();
    let output_format = request.output_format;
    let width = request.width;
    let height = request.height;
    let conversion_request = request.clone();
    let (bytes, actual_bit_depth) =
        tauri::async_runtime::spawn_blocking(move || convert_image(&conversion_request))
            .await
            .map_err(|error| format!("image conversion task failed: {error}"))??;
    let output_path = choose_output_path(&request, &source_file_name, output_format)?;
    let path_for_write = output_path.clone();
    let source_path = request.source_path.clone();
    let manage_existing_output = request.output_location != OutputLocation::Dialog;
    let overwrite_existing = request.overwrite_existing;
    let delete_source = request.delete_source;
    tauri::async_runtime::spawn_blocking(move || {
        write_exported_file(
            &path_for_write,
            bytes,
            source_path.as_deref(),
            manage_existing_output,
            overwrite_existing,
            delete_source,
        )
    })
    .await
    .map_err(|error| format!("image write task failed: {error}"))?
    .map_err(|error| {
        format!(
            "failed to write exported image `{}`: {error}",
            output_path.display()
        )
    })?;

    Ok(ExportImageResult {
        output_path: output_path.to_string_lossy().into_owned(),
        width,
        height,
        format: output_format.name().to_string(),
        bit_depth: actual_bit_depth,
    })
}

fn convert_image(request: &ExportRequest) -> Result<(Vec<u8>, u16), String> {
    validate_dimensions(request.width, request.height)?;
    validate_bit_depth(request.output_format, request.bit_depth)?;

    validate_input_size(&request.input_data)?;
    let source = decode_input(&request.input_data)?;
    let image = resize_image(
        source,
        request.width,
        request.height,
        request.keep_aspect_ratio,
        request.background_color,
    );

    match request.output_format {
        OutputFormat::Png => encode_png(image, request.bit_depth, request.background_color),
        OutputFormat::Jpg => encode_jpg(image, request.background_color, request.jpeg_quality),
        OutputFormat::Bmp => bmp::encode(&image, request.bit_depth, request.background_color),
        OutputFormat::Rgb565 => {
            raw::encode_rgb565(&image, request.background_color, request.raw_options)
        }
        OutputFormat::CArray => {
            let (bytes, _) =
                raw::encode_rgb565(&image, request.background_color, request.raw_options)?;
            raw::encode_c_array(&bytes, image.width(), image.height(), &request.c_array_name)
        }
    }
}

fn normalize_optional_path(value: Option<String>, field: &str) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > MAX_OUTPUT_PATH_BYTES {
        return Err(format!(
            "{field} cannot exceed {MAX_OUTPUT_PATH_BYTES} UTF-8 bytes"
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{field} cannot contain control characters"));
    }
    Ok(Some(value))
}

fn normalize_optional_subdirectory(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > MAX_OUTPUT_SUBDIRECTORY_BYTES {
        return Err(format!(
            "outputSubdirectory cannot exceed {MAX_OUTPUT_SUBDIRECTORY_BYTES} UTF-8 bytes"
        ));
    }
    if value == "." || value == ".." {
        return Err("outputSubdirectory cannot be . or ..".to_string());
    }
    if value.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            )
    }) {
        return Err(
            "outputSubdirectory cannot contain path separators or Windows reserved characters"
                .to_string(),
        );
    }
    Ok(Some(value))
}

fn validate_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("target width and height must be greater than zero".to_string());
    }
    if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        return Err(format!(
            "target dimensions cannot exceed {MAX_IMAGE_DIMENSION}x{MAX_IMAGE_DIMENSION}"
        ));
    }
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| "target dimensions overflow the pixel limit".to_string())?;
    if pixels > MAX_IMAGE_PIXELS {
        return Err(format!(
            "target image has too many pixels ({pixels}); maximum is {MAX_IMAGE_PIXELS}"
        ));
    }
    Ok(())
}

fn validate_image_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("source image has an invalid zero dimension".to_string());
    }
    if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        return Err(format!(
            "source image dimensions cannot exceed {MAX_IMAGE_DIMENSION}x{MAX_IMAGE_DIMENSION}"
        ));
    }
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| "source image dimensions overflow the pixel limit".to_string())?;
    if pixels > MAX_IMAGE_PIXELS {
        return Err(format!(
            "source image has too many pixels ({pixels}); maximum is {MAX_IMAGE_PIXELS}"
        ));
    }
    Ok(())
}

fn validate_input_size(input: &[u8]) -> Result<(), String> {
    validate_input_len(input.len())
}

fn validate_input_len(input_len: usize) -> Result<(), String> {
    if input_len == 0 {
        return Err("input image data must not be empty".to_string());
    }
    if input_len > MAX_INPUT_BYTES {
        return Err(format!(
            "input image is too large: raw data exceeds the {} MiB limit",
            MAX_INPUT_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

fn validate_source_file_name(file_name: &str) -> Result<(), String> {
    if file_name.is_empty() {
        return Err("source file name must not be empty".to_string());
    }
    if file_name.len() > MAX_SOURCE_FILE_NAME_BYTES {
        return Err(format!(
            "source file name is too long: maximum is {MAX_SOURCE_FILE_NAME_BYTES} UTF-8 bytes"
        ));
    }
    if file_name.chars().any(char::is_control) {
        return Err("source file name must not contain control characters".to_string());
    }
    Ok(())
}

fn parse_raw_request(request: Request<'_>) -> Result<ExportRequest, String> {
    let payload = match request.body() {
        InvokeBody::Raw(payload) => payload,
        InvokeBody::Json(_) => {
            return Err("export_image requires a raw binary IPC request".to_string());
        }
    };
    parse_raw_payload(payload)
}

fn parse_raw_payload(payload: &[u8]) -> Result<ExportRequest, String> {
    if payload.len() < 8 {
        return Err("raw request must contain an 8-byte header".to_string());
    }
    if &payload[..4] != b"EGF1" {
        return Err("raw request has invalid magic; expected EGF1".to_string());
    }

    let metadata_len = u32::from_le_bytes(
        payload[4..8]
            .try_into()
            .expect("the minimum payload length was checked"),
    ) as usize;
    if metadata_len > MAX_METADATA_BYTES {
        return Err(format!(
            "metadata is too large: maximum is {MAX_METADATA_BYTES} bytes"
        ));
    }
    let metadata_end = 8_usize
        .checked_add(metadata_len)
        .ok_or_else(|| "raw request metadata length overflowed".to_string())?;
    if metadata_end > payload.len() {
        return Err("raw request metadata length exceeds payload size".to_string());
    }

    let input_len = payload.len() - metadata_end;
    validate_input_len(input_len)?;

    let metadata = serde_json::from_slice::<ExportMetadata>(&payload[8..metadata_end])
        .map_err(|error| format!("invalid metadata JSON: {error}"))?;
    let input_data = payload[metadata_end..].to_vec();
    metadata.into_request(input_data)
}

fn decode_input(input_bytes: &[u8]) -> Result<DynamicImage, String> {
    let reader = ImageReader::new(Cursor::new(input_bytes))
        .with_guessed_format()
        .map_err(|error| format!("failed to inspect input image format: {error}"))?;
    let format = reader
        .format()
        .map(|format| format!("{format:?}"))
        .unwrap_or_else(|| "unknown".to_string());
    let (width, height) = reader
        .into_dimensions()
        .map_err(|error| format!("failed to read input image dimensions ({format}): {error}"))?;
    validate_image_dimensions(width, height)?;

    let mut reader = ImageReader::new(Cursor::new(input_bytes))
        .with_guessed_format()
        .map_err(|error| format!("failed to inspect input image format: {error}"))?;
    let mut limits = image::io::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODER_ALLOC_BYTES);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|error| format!("failed to decode input image ({format}): {error}"))
}

fn validate_bit_depth(format: OutputFormat, bit_depth: u16) -> Result<(), String> {
    let (supported, formats) = match format {
        OutputFormat::Png => (matches!(bit_depth, 24 | 32), "24 or 32"),
        OutputFormat::Jpg => (bit_depth == 24, "24"),
        OutputFormat::Bmp => return bmp::validate_bit_depth(bit_depth),
        OutputFormat::Rgb565 | OutputFormat::CArray => (bit_depth == 16, "16"),
    };
    if supported {
        return Ok(());
    }

    Err(format!(
        "{}-bit {} output is not supported; supported bit depths are {}",
        bit_depth,
        format.name(),
        formats
    ))
}

fn parse_background_color(value: Option<&str>) -> Result<Rgba<u8>, String> {
    let value = value.unwrap_or("#FFFFFFFF").trim();
    let value = value.strip_prefix('#').unwrap_or(value);
    if value.len() != 6 && value.len() != 8 {
        return Err("backgroundColor must be #RRGGBB or #RRGGBBAA".to_string());
    }

    let mut channels = [0_u8; 4];
    for (index, channel) in channels.iter_mut().enumerate() {
        if index == 3 && value.len() == 6 {
            *channel = 255;
            continue;
        }
        let offset = index * 2;
        *channel = u8::from_str_radix(&value[offset..offset + 2], 16)
            .map_err(|_| "backgroundColor contains non-hex characters".to_string())?;
    }
    Ok(Rgba(channels))
}

fn resize_image(
    source: DynamicImage,
    target_width: u32,
    target_height: u32,
    keep_aspect_ratio: bool,
    background_color: Rgba<u8>,
) -> RgbaImage {
    let source = source.to_rgba8();
    let (source_width, source_height) = source.dimensions();
    let (scaled_width, scaled_height) = if keep_aspect_ratio {
        let scale = (target_width as f64 / source_width as f64)
            .min(target_height as f64 / source_height as f64);
        let scaled_width = ((source_width as f64 * scale).round() as u32)
            .max(1)
            .min(target_width);
        let scaled_height = ((source_height as f64 * scale).round() as u32)
            .max(1)
            .min(target_height);
        (scaled_width, scaled_height)
    } else {
        (target_width, target_height)
    };

    let resized =
        image::imageops::resize(&source, scaled_width, scaled_height, FilterType::Lanczos3);
    if !keep_aspect_ratio {
        return resized;
    }

    let mut canvas = RgbaImage::from_pixel(target_width, target_height, background_color);
    let offset_x = (target_width - scaled_width) / 2;
    let offset_y = (target_height - scaled_height) / 2;
    canvas
        .copy_from(&resized, offset_x, offset_y)
        .expect("resized image must fit inside the target canvas");
    canvas
}

fn encode_png(
    image: RgbaImage,
    bit_depth: u16,
    background_color: Rgba<u8>,
) -> Result<(Vec<u8>, u16), String> {
    let mut bytes = LimitedCursor::new(MAX_OUTPUT_BYTES);
    let image = if bit_depth == 24 {
        DynamicImage::ImageRgb8(
            DynamicImage::ImageRgba8(composite_over_background(image, background_color)).to_rgb8(),
        )
    } else {
        DynamicImage::ImageRgba8(image)
    };
    image
        .write_to(&mut bytes, ImageFormat::Png)
        .map_err(|error| format!("failed to encode png: {error}"))?;
    Ok((bytes.into_inner(), bit_depth))
}

fn encode_jpg(
    image: RgbaImage,
    background_color: Rgba<u8>,
    quality: u8,
) -> Result<(Vec<u8>, u16), String> {
    let mut bytes = LimitedCursor::new(MAX_OUTPUT_BYTES);
    let image = DynamicImage::ImageRgba8(composite_over_background(image, background_color));
    let mut encoder = JpegEncoder::new_with_quality(&mut bytes, quality);
    encoder
        .encode_image(&image)
        .map_err(|error| format!("failed to encode jpg: {error}"))?;
    Ok((bytes.into_inner(), 24))
}

fn composite_over_background(image: RgbaImage, background_color: Rgba<u8>) -> RgbaImage {
    let mut output = image;
    for pixel in output.pixels_mut() {
        let alpha = u32::from(pixel[3]);
        for (index, channel) in pixel.0.iter_mut().take(3).enumerate() {
            *channel = ((u32::from(*channel) * alpha
                + u32::from(background_color[index]) * (255 - alpha))
                / 255) as u8;
        }
        pixel[3] = 255;
    }
    output
}

fn choose_output_path(
    request: &ExportRequest,
    source_file_name: &str,
    output_format: OutputFormat,
) -> Result<PathBuf, String> {
    let default_name = default_output_name(source_file_name, output_format);
    let directory = match request.output_location {
        OutputLocation::Dialog => {
            let path = rfd::FileDialog::new()
                .set_title("Export image")
                .set_file_name(default_name)
                .add_filter(
                    &output_format.name().to_ascii_uppercase(),
                    &[output_format.extension()],
                )
                .save_file()
                .ok_or_else(|| "image export cancelled".to_string())?;

            return Ok(with_expected_extension(path, output_format));
        }
        OutputLocation::Source | OutputLocation::Subfolder => {
            let source_path = request.source_path.as_deref().ok_or_else(|| {
                "source folder output requires the original file path; choose a specified directory instead"
                    .to_string()
            })?;
            let source_path = Path::new(source_path);
            source_path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."))
        }
        OutputLocation::Directory => PathBuf::from(
            request
                .output_directory
                .as_deref()
                .ok_or_else(|| "output directory is required".to_string())?,
        ),
    };

    let directory = if request.output_location == OutputLocation::Subfolder {
        directory.join(
            request
                .output_subdirectory
                .as_deref()
                .ok_or_else(|| "output subdirectory is required".to_string())?,
        )
    } else {
        directory
    };
    fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "failed to create output directory `{}`: {error}",
            directory.display()
        )
    })?;

    let output_path = with_expected_extension(directory.join(default_name), output_format);
    Ok(if request.overwrite_existing {
        output_path
    } else {
        avoid_source_overwrite(output_path, request.source_path.as_deref())
    })
}

fn write_exported_file(
    output_path: &Path,
    bytes: Vec<u8>,
    source_path: Option<&str>,
    manage_existing_output: bool,
    overwrite_existing: bool,
    delete_source: bool,
) -> Result<(), String> {
    let backup_path = if output_path.exists() && manage_existing_output {
        if !overwrite_existing {
            return Err(
                "output file already exists; enable overwrite to move it into the bak folder"
                    .to_string(),
            );
        }
        Some(move_existing_output_to_backup(output_path)?)
    } else {
        None
    };

    if let Err(error) = fs::write(output_path, bytes) {
        if let Some(backup_path) = backup_path {
            let _ = fs::rename(&backup_path, output_path);
        }
        return Err(error.to_string());
    }

    if delete_source {
        if let Some(source_path) = source_path {
            let source_path = Path::new(source_path);
            if !paths_equal(source_path, output_path) && source_path.exists() {
                fs::remove_file(source_path)
                    .map_err(|error| format!("failed to delete source image: {error}"))?;
            }
        }
    }

    Ok(())
}

fn move_existing_output_to_backup(output_path: &Path) -> Result<PathBuf, String> {
    let parent = output_path.parent().unwrap_or_else(|| Path::new("."));
    let backup_directory = parent.join("bak");
    fs::create_dir_all(&backup_directory).map_err(|error| {
        format!(
            "failed to create backup directory `{}`: {error}",
            backup_directory.display()
        )
    })?;

    let file_name = output_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "output file has no valid file name".to_string())?;
    let backup_path = next_backup_path(&backup_directory, file_name);
    fs::rename(output_path, &backup_path).map_err(|error| {
        format!(
            "failed to move existing output into `{}`: {error}",
            backup_path.display()
        )
    })?;
    Ok(backup_path)
}

fn next_backup_path(directory: &Path, file_name: &str) -> PathBuf {
    let first_path = directory.join(file_name);
    if !first_path.exists() {
        return first_path;
    }

    let source = Path::new(file_name);
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    for index in 1..=10_000 {
        let candidate = directory.join(format!("{stem}_{index}{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{stem}_backup{extension}"))
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    let normalized_left = fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let normalized_right = fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    if cfg!(windows) {
        normalized_left
            .to_string_lossy()
            .eq_ignore_ascii_case(&normalized_right.to_string_lossy())
    } else {
        normalized_left == normalized_right
    }
}

fn avoid_source_overwrite(output_path: PathBuf, source_path: Option<&str>) -> PathBuf {
    let Some(source_path) = source_path else {
        return output_path;
    };

    let source_path = Path::new(source_path);
    if !paths_equal(source_path, &output_path) {
        return output_path;
    }

    let stem = output_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let extension = output_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    output_path.with_file_name(format!("{stem}_converted{extension}"))
}

fn default_output_name(source_file_name: &str, format: OutputFormat) -> String {
    let base_name = source_file_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(source_file_name);
    let stem = Path::new(base_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("image");
    let safe_stem: String = stem
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .take(MAX_DEFAULT_STEM_CHARS)
        .collect();
    let mut safe_stem = safe_stem.trim_matches([' ', '.']).to_string();
    if safe_stem.is_empty() {
        safe_stem = "image".to_string();
    }
    let uppercase = safe_stem.to_ascii_uppercase();
    let is_reserved = matches!(uppercase.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || uppercase
            .strip_prefix("COM")
            .or_else(|| uppercase.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            });
    if is_reserved {
        safe_stem.insert(0, '_');
    }
    format!("{safe_stem}.{}", format.extension())
}

fn with_expected_extension(mut path: PathBuf, format: OutputFormat) -> PathBuf {
    path.set_extension(format.extension());
    path
}

struct LimitedCursor {
    cursor: Cursor<Vec<u8>>,
    max_bytes: usize,
}

impl LimitedCursor {
    fn new(max_bytes: usize) -> Self {
        Self {
            cursor: Cursor::new(Vec::new()),
            max_bytes,
        }
    }

    fn into_inner(self) -> Vec<u8> {
        self.cursor.into_inner()
    }
}

impl Write for LimitedCursor {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let position = usize::try_from(self.cursor.position())
            .map_err(|_| io::Error::other("encoded output position is too large"))?;
        let end = position
            .checked_add(buffer.len())
            .ok_or_else(|| io::Error::other("encoded output is too large"))?;
        if end > self.max_bytes {
            return Err(io::Error::other(format!(
                "encoded output exceeds the {} MiB limit",
                self.max_bytes / (1024 * 1024)
            )));
        }
        self.cursor.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.cursor.flush()
    }
}

impl Seek for LimitedCursor {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.cursor.seek(position)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;

    fn sample_image() -> RgbaImage {
        let mut image = RgbaImage::new(2, 1);
        image.put_pixel(0, 0, Rgba([255, 0, 0, 255]));
        image.put_pixel(1, 0, Rgba([0, 255, 0, 255]));
        image
    }

    #[test]
    fn raw_metadata_accepts_camel_case_contract_and_null_bit_depth() {
        let metadata: ExportMetadata = serde_json::from_str(
            r##"{
                "fileName": "source.png",
                "outputFormat": "png",
                "width": 20,
                "height": 10,
                "keepAspectRatio": true,
                "backgroundColor": "#102030",
                "bitDepth": null
            }"##,
        )
        .unwrap();

        let request = metadata.into_request(vec![1, 2, 3]).unwrap();
        assert_eq!(request.input_data, vec![1, 2, 3]);
        assert_eq!(request.source_file_name, "source.png");
        assert_eq!(request.bit_depth, 24);
        assert_eq!(request.jpeg_quality, 85);
        assert_eq!(
            request.raw_options,
            raw::RawOptions::parse(None, None, None, None).unwrap()
        );
        assert_eq!(request.background_color, Rgba([16, 32, 48, 255]));
    }

    #[test]
    fn raw_metadata_parses_new_output_options_and_raw_defaults() {
        let metadata: ExportMetadata = serde_json::from_str(
            r##"{
                "fileName": "screen.png",
                "outputFormat": "rgb565",
                "width": 2,
                "height": 1,
                "keepAspectRatio": false,
                "backgroundColor": "#000000",
                "jpegQuality": 42,
                "byteOrder": "big",
                "channelOrder": "bgr",
                "rowOrder": "bottom-up",
                "rowAlignment": 4,
                "cArrayName": "screen_pixels"
            }"##,
        )
        .unwrap();
        let request = metadata.into_request(vec![1]).unwrap();

        assert_eq!(request.output_format, OutputFormat::Rgb565);
        assert_eq!(request.bit_depth, 16);
        assert_eq!(request.jpeg_quality, 42);
        assert_eq!(request.raw_options.byte_order, raw::ByteOrder::Big);
        assert_eq!(request.raw_options.channel_order, raw::ChannelOrder::Bgr);
        assert_eq!(request.raw_options.row_order, raw::RowOrder::BottomUp);
        assert_eq!(request.raw_options.row_alignment, 4);
        assert_eq!(request.c_array_name, "screen_pixels");

        let c_array_metadata: ExportMetadata = serde_json::from_str(
            r##"{
                "fileName": "screen.png",
                "outputFormat": "c-array",
                "width": 1,
                "height": 1,
                "keepAspectRatio": false,
                "backgroundColor": null
            }"##,
        )
        .unwrap();
        let c_array_request = c_array_metadata.into_request(vec![1]).unwrap();
        assert_eq!(c_array_request.bit_depth, 16);
        assert_eq!(c_array_request.c_array_name, "screen");
    }

    #[test]
    fn jpeg_quality_and_raw_output_parameters_reject_invalid_values() {
        let metadata: ExportMetadata = serde_json::from_str(
            r##"{
                "fileName": "screen.png",
                "outputFormat": "jpg",
                "width": 1,
                "height": 1,
                "keepAspectRatio": false,
                "backgroundColor": null,
                "jpegQuality": 0
            }"##,
        )
        .unwrap();
        assert!(metadata
            .into_request(vec![1])
            .unwrap_err()
            .contains("jpegQuality"));
        assert!(validate_bit_depth(OutputFormat::Rgb565, 24)
            .unwrap_err()
            .contains("supported bit depths are 16"));
    }

    #[test]
    fn jpeg_quality_changes_encoded_output() {
        let (low_quality, _) = encode_jpg(sample_image(), Rgba([255, 255, 255, 255]), 10).unwrap();
        let (high_quality, _) =
            encode_jpg(sample_image(), Rgba([255, 255, 255, 255]), 100).unwrap();

        assert_ne!(low_quality, high_quality);
    }

    #[test]
    fn raw_metadata_rejects_removed_base64_field() {
        let error = serde_json::from_str::<ExportMetadata>(
            r##"{
                "inputDataBase64": "aW1hZ2U=",
                "fileName": "source.png",
                "outputFormat": "png",
                "width": 1,
                "height": 1,
                "keepAspectRatio": false,
                "backgroundColor": null,
                "bitDepth": null
            }"##,
        )
        .unwrap_err();

        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn raw_payload_owns_image_bytes_and_preserves_unicode_metadata() {
        let metadata = ExportMetadata {
            file_name: "source.png".to_string(),
            output_format: "png".to_string(),
            width: 1,
            height: 1,
            keep_aspect_ratio: false,
            background_color: None,
            bit_depth: None,
            jpeg_quality: None,
            byte_order: None,
            channel_order: None,
            row_order: None,
            row_alignment: None,
            c_array_name: None,
            output_location: None,
            source_path: None,
            output_subdirectory: None,
            output_directory: None,
            overwrite_existing: false,
            delete_source: false,
        };
        let payload = raw_payload(&metadata, &[0x89, 0x50, 0x4e, 0x47]);
        let request = parse_raw_payload(&payload).unwrap();

        assert_eq!(request.source_file_name, "source.png");
        assert_eq!(request.input_data, vec![0x89, 0x50, 0x4e, 0x47]);
    }

    #[test]
    fn raw_payload_preserves_unicode_file_name() {
        let metadata = ExportMetadata {
            file_name: "界面/图标.png".to_string(),
            output_format: "bmp".to_string(),
            width: 1,
            height: 1,
            keep_aspect_ratio: false,
            background_color: Some("#102030".to_string()),
            bit_depth: Some(16),
            jpeg_quality: None,
            byte_order: None,
            channel_order: None,
            row_order: None,
            row_alignment: None,
            c_array_name: None,
            output_location: None,
            source_path: None,
            output_subdirectory: None,
            output_directory: None,
            overwrite_existing: false,
            delete_source: false,
        };
        let request = parse_raw_payload(&raw_payload(&metadata, &[1, 2, 3])).unwrap();

        assert_eq!(request.source_file_name, "界面/图标.png");
        assert_eq!(request.output_format, OutputFormat::Bmp);
        assert_eq!(request.background_color, Rgba([16, 32, 48, 255]));
        assert_eq!(request.bit_depth, 16);
    }

    #[test]
    fn raw_payload_rejects_short_and_invalid_headers() {
        assert!(parse_raw_payload(&[])
            .unwrap_err()
            .contains("8-byte header"));
        assert!(parse_raw_payload(b"EGF1")
            .unwrap_err()
            .contains("8-byte header"));
        assert!(parse_raw_payload(b"NOPE\0\0\0\0")
            .unwrap_err()
            .contains("invalid magic"));
    }

    #[test]
    fn raw_payload_rejects_metadata_length_errors() {
        let mut oversized = b"EGF1".to_vec();
        oversized.extend_from_slice(&((MAX_METADATA_BYTES as u32) + 1).to_le_bytes());
        assert!(parse_raw_payload(&oversized)
            .unwrap_err()
            .contains("metadata is too large"));

        let mut truncated = b"EGF1".to_vec();
        truncated.extend_from_slice(&4_u32.to_le_bytes());
        truncated.extend_from_slice(b"{}");
        assert!(parse_raw_payload(&truncated)
            .unwrap_err()
            .contains("exceeds payload size"));
    }

    #[test]
    fn raw_payload_rejects_invalid_json_empty_image_and_large_image() {
        let mut invalid_json = b"EGF1".to_vec();
        invalid_json.extend_from_slice(&3_u32.to_le_bytes());
        invalid_json.extend_from_slice(b"no!");
        invalid_json.push(1);
        assert!(parse_raw_payload(&invalid_json)
            .unwrap_err()
            .contains("invalid metadata JSON"));

        let metadata = ExportMetadata {
            file_name: "source.png".to_string(),
            output_format: "png".to_string(),
            width: 1,
            height: 1,
            keep_aspect_ratio: false,
            background_color: None,
            bit_depth: None,
            jpeg_quality: None,
            byte_order: None,
            channel_order: None,
            row_order: None,
            row_alignment: None,
            c_array_name: None,
            output_location: None,
            source_path: None,
            output_subdirectory: None,
            output_directory: None,
            overwrite_existing: false,
            delete_source: false,
        };
        assert!(parse_raw_payload(&raw_payload(&metadata, &[]))
            .unwrap_err()
            .contains("must not be empty"));
        assert!(validate_input_len(MAX_INPUT_BYTES + 1)
            .unwrap_err()
            .contains("raw data"));
    }

    #[test]
    fn raw_metadata_rejects_unsafe_source_file_names() {
        let create_metadata = |file_name: String| ExportMetadata {
            file_name,
            output_format: "png".to_string(),
            width: 1,
            height: 1,
            keep_aspect_ratio: false,
            background_color: None,
            bit_depth: None,
            jpeg_quality: None,
            byte_order: None,
            channel_order: None,
            row_order: None,
            row_alignment: None,
            c_array_name: None,
            output_location: None,
            source_path: None,
            output_subdirectory: None,
            output_directory: None,
            overwrite_existing: false,
            delete_source: false,
        };

        assert!(create_metadata(String::new())
            .into_request(vec![1])
            .unwrap_err()
            .contains("must not be empty"));
        assert!(create_metadata("bad\0name.png".to_string())
            .into_request(vec![1])
            .unwrap_err()
            .contains("control characters"));
        assert!(create_metadata("界".repeat(MAX_SOURCE_FILE_NAME_BYTES))
            .into_request(vec![1])
            .unwrap_err()
            .contains("too long"));
    }

    #[test]
    fn default_output_names_are_portable_and_preserve_unicode() {
        assert_eq!(
            default_output_name("folder/屏幕 图标.png", OutputFormat::Bmp),
            "屏幕 图标.bmp"
        );
        assert_eq!(
            default_output_name(r"folder\bad:name?.png", OutputFormat::Png),
            "bad_name_.png"
        );
        assert_eq!(
            default_output_name("CON.png", OutputFormat::Jpg),
            "_CON.jpg"
        );
        assert_eq!(
            default_output_name("...png", OutputFormat::Bmp),
            "image.bmp"
        );
        assert_eq!(
            default_output_name("screen.png", OutputFormat::Rgb565),
            "screen.bin"
        );
        assert_eq!(
            default_output_name("screen.png", OutputFormat::CArray),
            "screen.h"
        );

        let output = default_output_name(&format!("{}.png", "x".repeat(200)), OutputFormat::Png);
        assert_eq!(
            output,
            format!("{}.png", "x".repeat(MAX_DEFAULT_STEM_CHARS))
        );
    }

    #[test]
    fn output_location_metadata_preserves_directory_preferences() {
        let metadata: ExportMetadata = serde_json::from_str(
            r##"{
                "fileName": "screen.png",
                "outputFormat": "png",
                "width": 2,
                "height": 1,
                "keepAspectRatio": false,
                "backgroundColor": null,
                "outputLocation": "subfolder",
                "sourcePath": "C:\\Images\\screen.png",
                "outputSubdirectory": "export"
            }"##,
        )
        .unwrap();
        let request = metadata.into_request(vec![1]).unwrap();

        assert_eq!(request.output_location, OutputLocation::Subfolder);
        assert_eq!(
            request.source_path.as_deref(),
            Some(r"C:\Images\screen.png")
        );
        assert_eq!(request.output_subdirectory.as_deref(), Some("export"));
    }

    #[test]
    fn output_subdirectories_reject_path_escape_characters() {
        assert!(normalize_optional_subdirectory(Some("..".to_string())).is_err());
        assert!(normalize_optional_subdirectory(Some(r"nested\folder".to_string())).is_err());
        assert!(normalize_optional_subdirectory(Some("export".to_string())).is_ok());
    }

    #[test]
    fn overwrite_moves_old_output_to_bak_and_deletes_source_after_write() {
        let directory =
            std::env::temp_dir().join(format!("embedpix-output-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("source.png");
        let output = directory.join("screen.png");
        fs::write(&source, b"source").unwrap();
        fs::write(&output, b"old-output").unwrap();

        write_exported_file(
            &output,
            b"new-output".to_vec(),
            source.to_str(),
            true,
            true,
            true,
        )
        .unwrap();

        assert_eq!(fs::read(&output).unwrap(), b"new-output");
        assert_eq!(
            fs::read(directory.join("bak/screen.png")).unwrap(),
            b"old-output"
        );
        assert!(!source.exists());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn deleting_source_does_not_delete_replacement_output() {
        let directory = std::env::temp_dir().join(format!(
            "embedpix-source-replacement-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("source.png");
        fs::write(&source, b"old-source").unwrap();

        write_exported_file(
            &source,
            b"new-source".to_vec(),
            source.to_str(),
            true,
            true,
            true,
        )
        .unwrap();

        assert_eq!(fs::read(&source).unwrap(), b"new-source");
        assert_eq!(
            fs::read(directory.join("bak/source.png")).unwrap(),
            b"old-source"
        );
        let _ = fs::remove_dir_all(directory);
    }

    fn raw_payload(metadata: &ExportMetadata, input_data: &[u8]) -> Vec<u8> {
        let metadata = serde_json::to_vec(metadata).unwrap();
        let mut payload = b"EGF1".to_vec();
        payload.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
        payload.extend_from_slice(&metadata);
        payload.extend_from_slice(input_data);
        payload
    }

    #[test]
    fn aspect_ratio_resize_pads_to_target_dimensions() {
        let image = resize_image(
            DynamicImage::ImageRgba8(sample_image()),
            4,
            4,
            true,
            Rgba([1, 2, 3, 255]),
        );

        assert_eq!(image.dimensions(), (4, 4));
        assert_eq!(image.get_pixel(0, 0), &Rgba([1, 2, 3, 255]));
    }

    #[test]
    fn aspect_ratio_resize_preserves_source_alpha_in_letterbox_region() {
        let mut source = RgbaImage::new(1, 1);
        source.put_pixel(0, 0, Rgba([255, 0, 0, 128]));

        let resized = resize_image(
            DynamicImage::ImageRgba8(source),
            2,
            4,
            true,
            Rgba([1, 2, 3, 255]),
        );

        assert_eq!(resized.get_pixel(0, 0), &Rgba([1, 2, 3, 255]));
        assert_eq!(resized.get_pixel(0, 1), &Rgba([255, 0, 0, 128]));
    }

    #[test]
    fn png_and_jpg_outputs_have_expected_signatures() {
        let (png, bit_depth) = encode_png(sample_image(), 24, Rgba([255, 255, 255, 255])).unwrap();
        let (jpg, jpg_bit_depth) =
            encode_jpg(sample_image(), Rgba([255, 255, 255, 255]), 85).unwrap();

        assert_eq!(bit_depth, 24);
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(jpg_bit_depth, 24);
        assert_eq!(&jpg[..3], &[0xFF, 0xD8, 0xFF]);
        assert_eq!(decode_input(&png).unwrap().dimensions(), (2, 1));
        assert_eq!(decode_input(&jpg).unwrap().dimensions(), (2, 1));
    }

    #[test]
    fn png_24_composites_alpha_after_aspect_ratio_resize() {
        let mut source = RgbaImage::new(1, 1);
        source.put_pixel(0, 0, Rgba([255, 0, 0, 128]));
        let resized = resize_image(
            DynamicImage::ImageRgba8(source),
            2,
            4,
            true,
            Rgba([1, 2, 3, 255]),
        );

        let (bytes, _) = encode_png(resized, 24, Rgba([0, 255, 0, 255])).unwrap();
        let output = decode_input(&bytes).unwrap().to_rgba8();

        assert_eq!(output.get_pixel(0, 1), &Rgba([128, 127, 0, 255]));
        assert_eq!(output.get_pixel(0, 0), &Rgba([1, 2, 3, 255]));
    }

    #[test]
    fn invalid_parameters_have_explicit_errors() {
        assert!(validate_dimensions(0, 1)
            .unwrap_err()
            .contains("greater than zero"));
        assert!(validate_dimensions(MAX_IMAGE_DIMENSION + 1, 1)
            .unwrap_err()
            .contains("cannot exceed"));
        assert!(validate_dimensions(4_096, 4_097)
            .unwrap_err()
            .contains("too many pixels"));
        assert!(validate_bit_depth(OutputFormat::Jpg, 32)
            .unwrap_err()
            .contains("supported bit depths are 24"));
        assert!(parse_background_color(Some("#xyzxyz"))
            .unwrap_err()
            .contains("non-hex"));
    }

    #[test]
    fn resource_limits_reject_large_raw_inputs_and_source_dimensions() {
        assert!(validate_input_len(MAX_INPUT_BYTES).is_ok());
        assert!(validate_input_len(MAX_INPUT_BYTES + 1)
            .unwrap_err()
            .contains("too large"));
        assert!(validate_image_dimensions(MAX_IMAGE_DIMENSION + 1, 1)
            .unwrap_err()
            .contains("source image dimensions"));
        assert!(validate_image_dimensions(4_096, 4_097)
            .unwrap_err()
            .contains("source image has too many pixels"));
    }
}
