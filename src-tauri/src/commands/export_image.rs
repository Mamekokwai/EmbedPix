use std::{
    fs,
    io::{self, Cursor, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, io::Reader as ImageReader, DynamicImage,
    GenericImage, GenericImageView, ImageFormat, Rgba, RgbaImage,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request};

use super::path_security;

mod bmp;
mod raw;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 64 * 1024;
const MAX_SOURCE_FILE_NAME_BYTES: usize = 1024;
const MAX_DEFAULT_STEM_CHARS: usize = 120;
const MAX_WATERMARK_TEXT_BYTES: usize = 256;
const MAX_IMAGE_DIMENSION: u32 = 8_192;
const MAX_IMAGE_PIXELS: u64 = 16_777_216;
const MAX_DECODER_ALLOC_BYTES: u64 = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 128 * 1024 * 1024;
const MAX_PREVIEW_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputFormat {
    Png,
    Webp,
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
    Original,
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
            "original" => Ok(Self::Original),
            other => Err(format!(
                "unsupported output location `{other}`; expected source, subfolder, directory, or original"
            )),
        }
    }
}

impl OutputFormat {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "png" => Ok(Self::Png),
            "webp" => Ok(Self::Webp),
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
            Self::Webp => "webp",
            Self::Jpg => "jpg",
            Self::Bmp => "bmp",
            Self::Rgb565 => "bin",
            Self::CArray => "h",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Webp => "webp",
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
    overwrite_same_name: bool,
    transform: ImageTransformOptions,
    watermark: Option<WatermarkOptions>,
    delete_source: bool,
    metadata_policy: MetadataPolicy,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
enum MetadataPolicy {
    #[default]
    Strip,
    Preserve,
}

impl MetadataPolicy {
    fn parse(value: Option<&str>) -> Result<Self, String> {
        match value
            .unwrap_or("strip")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "strip" => Ok(Self::Strip),
            "preserve" => Ok(Self::Preserve),
            other => Err(format!(
                "unsupported metadataPolicy `{other}`; expected strip or preserve"
            )),
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum WatermarkPosition {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

#[derive(Debug, Clone)]
struct WatermarkOptions {
    text: String,
    position: WatermarkPosition,
    opacity: u8,
    font_size: u16,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageTransformOptions {
    #[serde(default)]
    rotation: u16,
    #[serde(default)]
    flip_horizontal: bool,
    #[serde(default)]
    flip_vertical: bool,
    #[serde(default)]
    crop: Option<CropRect>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CropRect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

impl ImageTransformOptions {
    fn validate(&self) -> Result<(), String> {
        if matches!(self.rotation, 0 | 90 | 180 | 270) {
            Ok(())
        } else {
            Err("transform.rotation must be 0, 90, 180, or 270".to_string())
        }
    }
}

impl WatermarkPosition {
    fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("bottom-right").trim().to_ascii_lowercase().as_str() {
            "top-left" => Ok(Self::TopLeft),
            "top-right" => Ok(Self::TopRight),
            "bottom-left" => Ok(Self::BottomLeft),
            "bottom-right" => Ok(Self::BottomRight),
            other => Err(format!(
                "unsupported watermarkPosition `{other}`; expected top-left, top-right, bottom-left, or bottom-right"
            )),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct WriteOptions {
    manage_existing_output: bool,
    overwrite_existing: bool,
    overwrite_same_name: bool,
    delete_source: bool,
    replace_original: bool,
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
    overwrite_same_name: bool,
    #[serde(default)]
    transform: Option<ImageTransformOptions>,
    #[serde(default)]
    watermark_text: Option<String>,
    #[serde(default)]
    watermark_position: Option<String>,
    #[serde(default)]
    watermark_opacity: Option<u8>,
    #[serde(default)]
    watermark_font_size: Option<u16>,
    #[serde(default)]
    delete_source: bool,
    #[serde(default)]
    metadata_policy: Option<String>,
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
        let watermark = parse_watermark(
            output_format,
            self.watermark_text,
            self.watermark_position,
            self.watermark_opacity,
            self.watermark_font_size,
        )?;
        let transform = self.transform.unwrap_or_default();
        transform.validate()?;
        let metadata_policy = MetadataPolicy::parse(self.metadata_policy.as_deref())?;
        if metadata_policy == MetadataPolicy::Preserve {
            return Err("metadataPolicy=preserve is not supported yet; use strip to remove EXIF/ICC metadata safely".to_string());
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
            overwrite_same_name: self.overwrite_same_name,
            transform,
            watermark,
            delete_source: self.delete_source,
            metadata_policy,
        })
    }
}

fn parse_watermark(
    output_format: OutputFormat,
    text: Option<String>,
    position: Option<String>,
    opacity: Option<u8>,
    font_size: Option<u16>,
) -> Result<Option<WatermarkOptions>, String> {
    let has_any_setting =
        text.is_some() || position.is_some() || opacity.is_some() || font_size.is_some();
    let Some(text) = text else {
        if has_any_setting {
            return Err(
                "watermarkText is required when watermark options are provided".to_string(),
            );
        }
        return Ok(None);
    };
    if matches!(output_format, OutputFormat::Rgb565 | OutputFormat::CArray) {
        return Err("watermark is supported only for PNG, JPG, and BMP outputs".to_string());
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("watermarkText must not be empty".to_string());
    }
    if text.len() > MAX_WATERMARK_TEXT_BYTES {
        return Err(format!(
            "watermarkText cannot exceed {MAX_WATERMARK_TEXT_BYTES} UTF-8 bytes"
        ));
    }
    if text.chars().any(char::is_control) {
        return Err("watermarkText cannot contain control characters".to_string());
    }
    if text.chars().count() > 80 {
        return Err("watermarkText cannot exceed 80 characters".to_string());
    }
    let opacity = opacity.unwrap_or(60);
    if !(1..=100).contains(&opacity) {
        return Err("watermarkOpacity must be between 1 and 100".to_string());
    }
    let font_size = font_size.unwrap_or(16);
    if !(8..=72).contains(&font_size) {
        return Err("watermarkFontSize must be between 8 and 72".to_string());
    }
    Ok(Some(WatermarkOptions {
        text,
        position: WatermarkPosition::parse(position.as_deref())?,
        opacity,
        font_size,
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportImageResult {
    pub output_path: String,
    pub output_bytes: u64,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub bit_depth: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePreviewResult {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub bit_depth: u16,
    pub output_bytes: u64,
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
pub async fn pick_images() -> Result<Vec<NativeImageFile>, String> {
    let paths = rfd::FileDialog::new()
        .set_title("选择图片")
        .add_filter("图片", &["png", "jpg", "jpeg", "bmp", "gif", "webp"])
        .pick_files()
        .unwrap_or_default();

    tauri::async_runtime::spawn_blocking(move || {
        paths.into_iter().map(read_image_file_from_path).collect()
    })
    .await
    .map_err(|error| format!("image read task failed: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn read_image_file(path: String) -> Result<NativeImageFile, String> {
    tauri::async_runtime::spawn_blocking(move || read_image_file_from_path(PathBuf::from(path)))
        .await
        .map_err(|error| format!("image read task failed: {error}"))?
}

pub fn read_image_file_cli(path: &str) -> Result<NativeImageFile, String> {
    read_image_file_from_path(PathBuf::from(path))
}

fn read_image_file_from_path(path: PathBuf) -> Result<NativeImageFile, String> {
    path_security::validate_source_path(&path)
        .map_err(|error| format_image_path_error(error, "selected image path"))?;
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
    let write_options = WriteOptions {
        manage_existing_output: request.output_location != OutputLocation::Dialog,
        overwrite_existing: request.overwrite_existing,
        overwrite_same_name: request.overwrite_same_name,
        delete_source: request.delete_source,
        replace_original: request.output_location == OutputLocation::Original,
    };
    tauri::async_runtime::spawn_blocking(move || {
        write_exported_file(
            &path_for_write,
            bytes,
            source_path.as_deref(),
            write_options,
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

    let output_bytes = fs::metadata(&output_path)
        .map_err(|error| {
            format!(
                "failed to inspect published output `{}`: {error}",
                output_path.display()
            )
        })?
        .len();

    Ok(ExportImageResult {
        output_path: output_path.to_string_lossy().into_owned(),
        output_bytes,
        width,
        height,
        format: output_format.name().to_string(),
        bit_depth: actual_bit_depth,
    })
}

#[tauri::command]
pub async fn preview_image_export(request: Request<'_>) -> Result<ImagePreviewResult, String> {
    let request = parse_raw_request(request)?;
    let preview_request = request.clone();
    tauri::async_runtime::spawn_blocking(move || build_image_preview(&preview_request))
        .await
        .map_err(|error| format!("image preview task failed: {error}"))?
}

fn build_image_preview(request: &ExportRequest) -> Result<ImagePreviewResult, String> {
    let (data, bit_depth) = convert_image(request)?;
    enforce_preview_limit(&data)?;
    let output_bytes = data.len() as u64;
    Ok(ImagePreviewResult {
        data,
        width: request.width,
        height: request.height,
        format: request.output_format.name().to_string(),
        bit_depth,
        output_bytes,
    })
}

fn enforce_preview_limit(data: &[u8]) -> Result<(), String> {
    if data.len() > MAX_PREVIEW_BYTES {
        return Err(format!(
            "image preview exceeds the {} MiB limit",
            MAX_PREVIEW_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

pub fn export_image_cli(payload: &[u8]) -> Result<ExportImageResult, String> {
    let request = parse_raw_payload(payload)?;
    let source_file_name = request.source_file_name.clone();
    let output_format = request.output_format;
    let (bytes, actual_bit_depth) = convert_image(&request)?;
    let output_path = choose_output_path(&request, &source_file_name, output_format)?;
    write_exported_file(
        &output_path,
        bytes,
        request.source_path.as_deref(),
        WriteOptions {
            manage_existing_output: request.output_location != OutputLocation::Dialog,
            overwrite_existing: request.overwrite_existing,
            overwrite_same_name: request.overwrite_same_name,
            delete_source: request.delete_source,
            replace_original: request.output_location == OutputLocation::Original,
        },
    )?;
    let output_bytes = fs::metadata(&output_path)
        .map_err(|error| {
            format!(
                "failed to inspect published output `{}`: {error}",
                output_path.display()
            )
        })?
        .len();
    Ok(ExportImageResult {
        output_path: output_path.to_string_lossy().into_owned(),
        output_bytes,
        width: request.width,
        height: request.height,
        format: output_format.name().to_string(),
        bit_depth: actual_bit_depth,
    })
}

fn convert_image(request: &ExportRequest) -> Result<(Vec<u8>, u16), String> {
    if request.metadata_policy == MetadataPolicy::Preserve {
        return Err("metadataPolicy=preserve is not supported yet; use strip to remove EXIF/ICC metadata safely".to_string());
    }
    validate_dimensions(request.width, request.height)?;
    validate_bit_depth(request.output_format, request.bit_depth)?;

    validate_input_size(&request.input_data)?;
    let source = apply_image_transform(decode_input(&request.input_data)?, &request.transform)?;
    let mut image = resize_image(
        source,
        request.width,
        request.height,
        request.keep_aspect_ratio,
        request.background_color,
    );

    if let Some(watermark) = request.watermark.as_ref() {
        apply_watermark(&mut image, watermark);
    }

    match request.output_format {
        OutputFormat::Png => encode_png(image, request.bit_depth, request.background_color),
        OutputFormat::Webp => encode_webp(image, request.bit_depth, request.background_color),
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
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    path_security::normalize_path(value)
        .map(|path| path.to_string_lossy().into_owned())
        .map(Some)
        .map_err(|error| format_image_path_error(error, field))
}

fn normalize_optional_subdirectory(value: Option<String>) -> Result<Option<String>, String> {
    path_security::normalize_subdirectory(value.as_deref())
        .map_err(|error| format_image_path_error(error, "outputSubdirectory"))
}

fn format_image_path_error(error: path_security::PathSecurityError, field: &str) -> String {
    match error {
        path_security::PathSecurityError::Empty => format!("{field} cannot be empty"),
        path_security::PathSecurityError::TooLong => {
            format!(
                "{field} cannot exceed {} UTF-8 bytes",
                path_security::MAX_OUTPUT_PATH_BYTES
            )
        }
        path_security::PathSecurityError::ControlCharacters => {
            format!("{field} cannot contain control characters")
        }
        path_security::PathSecurityError::InvalidPath => {
            format!("{field} cannot contain path traversal or Windows reserved device names")
        }
        path_security::PathSecurityError::InvalidSubdirectory => {
            format!("{field} cannot contain path separators or Windows reserved characters")
        }
        path_security::PathSecurityError::ReservedName => {
            format!("{field} cannot use Windows reserved device names")
        }
        path_security::PathSecurityError::SymlinkOrReparse => {
            format!("{field} cannot contain symlink or reparse-point components")
        }
        path_security::PathSecurityError::NotDirectory => {
            format!("{field} must contain only directory components")
        }
        path_security::PathSecurityError::NotFile => format!("{field} must be a regular file"),
        path_security::PathSecurityError::Missing => format!("{field} does not exist"),
        path_security::PathSecurityError::Io(error) => {
            format!("failed to inspect {field}: {error}")
        }
    }
}

fn validate_image_source(value: Option<&str>) -> Result<PathBuf, String> {
    path_security::validate_source_file(value).map_err(|error| match error {
        path_security::PathSecurityError::Empty | path_security::PathSecurityError::Missing => {
            "original output requires an existing source image".to_string()
        }
        error => format_image_path_error(error, "sourcePath"),
    })
}

fn validate_image_output_directory(directory: &Path) -> Result<(), String> {
    path_security::validate_output_directory(directory)
        .map_err(|error| format_image_path_error(error, "output directory"))
}

fn ensure_image_output_directory(directory: &Path) -> Result<(), String> {
    validate_image_output_directory(directory)?;
    if !directory.exists() {
        fs::create_dir_all(directory).map_err(|error| {
            format!(
                "failed to create output directory `{}`: {error}",
                directory.display()
            )
        })?;
    }
    validate_image_output_directory(directory)
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
        OutputFormat::Webp => (matches!(bit_depth, 24 | 32), "24 or 32"),
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

fn apply_image_transform(
    mut image: DynamicImage,
    transform: &ImageTransformOptions,
) -> Result<DynamicImage, String> {
    transform.validate()?;
    let (source_width, source_height) = image.dimensions();
    if let Some(crop) = transform.crop {
        validate_crop(crop, source_width, source_height)?;
        image = image.crop_imm(crop.x, crop.y, crop.width, crop.height);
    }
    image = match transform.rotation {
        0 => image,
        90 => image.rotate90(),
        180 => image.rotate180(),
        270 => image.rotate270(),
        _ => unreachable!("transform rotation was validated"),
    };
    if transform.flip_horizontal {
        image = image.fliph();
    }
    if transform.flip_vertical {
        image = image.flipv();
    }
    Ok(image)
}

fn validate_crop(crop: CropRect, source_width: u32, source_height: u32) -> Result<(), String> {
    if crop.width == 0 || crop.height == 0 {
        return Err("transform.crop width and height must be greater than zero".to_string());
    }
    let right = crop
        .x
        .checked_add(crop.width)
        .ok_or_else(|| "transform.crop exceeds the source image bounds".to_string())?;
    let bottom = crop
        .y
        .checked_add(crop.height)
        .ok_or_else(|| "transform.crop exceeds the source image bounds".to_string())?;
    if right > source_width || bottom > source_height {
        return Err(format!(
            "transform.crop must stay within the source image bounds ({source_width}x{source_height})"
        ));
    }
    Ok(())
}

fn apply_watermark(image: &mut RgbaImage, options: &WatermarkOptions) {
    let width = image.width();
    let height = image.height();
    let character_count = options.text.chars().count() as u32;
    let requested_scale = u32::from(options.font_size).div_ceil(7).max(1);
    let width_limited_scale = width
        .saturating_sub(8)
        .checked_div(character_count.saturating_mul(6).max(1))
        .unwrap_or(1)
        .max(1);
    let scale = requested_scale.min(width_limited_scale);
    let advance = scale.saturating_mul(6);
    let text_width = character_count
        .saturating_mul(advance)
        .saturating_sub(scale);
    let text_height = scale.saturating_mul(7);
    let padding = scale.saturating_mul(2).max(4);
    let x = match options.position {
        WatermarkPosition::TopLeft | WatermarkPosition::BottomLeft => padding,
        WatermarkPosition::TopRight | WatermarkPosition::BottomRight => {
            width.saturating_sub(text_width.saturating_add(padding))
        }
    };
    let y = match options.position {
        WatermarkPosition::TopLeft | WatermarkPosition::TopRight => padding,
        WatermarkPosition::BottomLeft | WatermarkPosition::BottomRight => {
            height.saturating_sub(text_height.saturating_add(padding))
        }
    };
    let foreground_alpha = ((u16::from(options.opacity) * 255) / 100) as u8;
    let shadow_alpha = foreground_alpha / 2;

    for (character_index, character) in options.text.chars().enumerate() {
        let glyph_x = x.saturating_add((character_index as u32).saturating_mul(advance));
        let rows = watermark_glyph_rows(character);
        for (row_index, row) in rows.iter().enumerate() {
            for column_index in 0..5_u32 {
                if row & (1 << (4 - column_index)) == 0 {
                    continue;
                }
                for offset_y in 0..scale {
                    for offset_x in 0..scale {
                        let pixel_x = glyph_x
                            .saturating_add(column_index.saturating_mul(scale))
                            .saturating_add(offset_x);
                        let pixel_y = y
                            .saturating_add((row_index as u32).saturating_mul(scale))
                            .saturating_add(offset_y);
                        if pixel_x >= width || pixel_y >= height {
                            continue;
                        }
                        if shadow_alpha > 0 {
                            let shadow_x = pixel_x.saturating_add(scale / 2 + 1);
                            let shadow_y = pixel_y.saturating_add(scale / 2 + 1);
                            if shadow_x < width && shadow_y < height {
                                blend_watermark_pixel(
                                    image.get_pixel_mut(shadow_x, shadow_y),
                                    [0, 0, 0],
                                    shadow_alpha,
                                );
                            }
                        }
                        blend_watermark_pixel(
                            image.get_pixel_mut(pixel_x, pixel_y),
                            [255, 255, 255],
                            foreground_alpha,
                        );
                    }
                }
            }
        }
    }
}

fn blend_watermark_pixel(pixel: &mut Rgba<u8>, color: [u8; 3], source_alpha: u8) {
    let source_alpha = u32::from(source_alpha);
    let destination_alpha = u32::from(pixel[3]);
    let inverse_source_alpha = 255 - source_alpha;
    let output_alpha = source_alpha + destination_alpha * inverse_source_alpha / 255;
    if output_alpha == 0 {
        return;
    }
    for (index, channel) in pixel.0.iter_mut().take(3).enumerate() {
        let source = u32::from(color[index]) * source_alpha;
        let destination = u32::from(*channel) * destination_alpha * inverse_source_alpha / 255;
        *channel = ((source + destination) / output_alpha) as u8;
    }
    pixel[3] = output_alpha as u8;
}

fn watermark_glyph_rows(character: char) -> [u8; 7] {
    let character = if character == '·' {
        '.'
    } else {
        character.to_ascii_uppercase()
    };
    match character {
        'A' => [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
        'B' => [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
        'C' => [0x0F, 0x10, 0x10, 0x10, 0x10, 0x10, 0x0F],
        'D' => [0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E],
        'E' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
        'F' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
        'G' => [0x0F, 0x10, 0x10, 0x17, 0x11, 0x11, 0x0F],
        'H' => [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
        'I' => [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x1F],
        'J' => [0x01, 0x01, 0x01, 0x01, 0x11, 0x11, 0x0E],
        'K' => [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
        'L' => [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
        'M' => [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
        'N' => [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
        'O' => [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
        'P' => [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
        'Q' => [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D],
        'R' => [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
        'S' => [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
        'T' => [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
        'U' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
        'V' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
        'W' => [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0A],
        'X' => [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
        'Y' => [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04],
        'Z' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
        '0' => [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
        '1' => [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
        '2' => [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
        '3' => [0x1E, 0x01, 0x01, 0x0E, 0x01, 0x01, 0x1E],
        '4' => [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
        '5' => [0x1F, 0x10, 0x10, 0x1E, 0x01, 0x01, 0x1E],
        '6' => [0x0E, 0x10, 0x10, 0x1E, 0x11, 0x11, 0x0E],
        '7' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
        '8' => [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
        '9' => [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x01, 0x0E],
        '.' => [0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C],
        ':' => [0x00, 0x0C, 0x0C, 0x00, 0x0C, 0x0C, 0x00],
        '-' => [0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00],
        '_' => [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F],
        '/' => [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
        ' ' => [0x00; 7],
        _ => [0x1F, 0x11, 0x15, 0x11, 0x15, 0x11, 0x1F],
    }
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

fn encode_webp(
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
        .write_to(&mut bytes, ImageFormat::WebP)
        .map_err(|error| format!("failed to encode webp: {error}"))?;
    Ok((bytes.into_inner(), bit_depth))
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
    if request.output_location == OutputLocation::Original {
        let source_path = validate_image_source(request.source_path.as_deref())?;
        let output_path = with_expected_extension(source_path.to_path_buf(), output_format);
        path_security::validate_output_path(&output_path)
            .map_err(|error| format_image_path_error(error, "image output path"))?;
        return Ok(output_path);
    }

    let directory = match request.output_location {
        OutputLocation::Dialog => {
            let path = rfd::FileDialog::new()
                .set_title("Export image")
                .set_file_name(default_name)
                .add_filter(
                    output_format.name().to_ascii_uppercase(),
                    &[output_format.extension()],
                )
                .save_file()
                .ok_or_else(|| "image export cancelled".to_string())?;

            let output_path = with_expected_extension(path, output_format);
            path_security::validate_output_path(&output_path)
                .map_err(|error| format_image_path_error(error, "image output path"))?;
            return Ok(output_path);
        }
        OutputLocation::Source | OutputLocation::Subfolder => {
            let source_path = validate_image_source(request.source_path.as_deref()).map_err(
                |error| {
                    if error == "original output requires an existing source image" {
                        "source folder output requires the original file path; choose a specified directory instead"
                            .to_string()
                    } else {
                        error
                    }
                },
            )?;
            source_path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."))
        }
        OutputLocation::Directory => path_security::normalize_path(
            request
                .output_directory
                .as_deref()
                .ok_or_else(|| "output directory is required".to_string())?,
        )
        .map_err(|error| format_image_path_error(error, "outputDirectory"))?,
        OutputLocation::Original => unreachable!("original output handled above"),
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
    validate_image_output_directory(&directory)?;

    let output_path = with_expected_extension(directory.join(default_name), output_format);
    path_security::validate_output_path(&output_path)
        .map_err(|error| format_image_path_error(error, "image output path"))?;
    Ok(
        if request.overwrite_existing || request.overwrite_same_name {
            output_path
        } else {
            avoid_source_overwrite(output_path, request.source_path.as_deref())
        },
    )
}

fn write_exported_file(
    output_path: &Path,
    bytes: Vec<u8>,
    source_path: Option<&str>,
    options: WriteOptions,
) -> Result<(), String> {
    if options.replace_original {
        return replace_original_file(output_path, bytes, source_path);
    }

    let parent = output_path.parent().unwrap_or_else(|| Path::new("."));
    ensure_image_output_directory(parent)?;
    path_security::validate_existing_file(output_path)
        .map_err(|error| format_image_path_error(error, "image output path"))?;
    let output_existed_before_write = fs::symlink_metadata(output_path).is_ok();
    let backup_path = if output_existed_before_write && options.manage_existing_output {
        if options.overwrite_same_name {
            Some(move_existing_output_to_temporary_backup(output_path)?)
        } else if !options.overwrite_existing {
            return Err(
                "output file already exists; enable overwrite to move it into the bak folder"
                    .to_string(),
            );
        } else {
            Some(move_existing_output_to_backup(output_path)?)
        }
    } else {
        None
    };

    if let Err(error) = write_file_atomically(output_path, &bytes) {
        return Err(format_write_failure(
            output_path,
            error,
            backup_path.as_ref(),
            backup_path.is_some() || !output_existed_before_write,
        ));
    }

    if options.delete_source {
        if let Some(source_path) = source_path {
            let source_path = Path::new(source_path);
            if !paths_equal(source_path, output_path) && source_path.exists() {
                if let Err(error) = fs::remove_file(source_path) {
                    let rollback_error = rollback_written_output(
                        output_path,
                        backup_path.as_ref(),
                        backup_path.is_some() || !output_existed_before_write,
                    );
                    return Err(match rollback_error {
                        Ok(()) => format!("failed to delete source image: {error}"),
                        Err(rollback_error) => format!(
                            "failed to delete source image: {error}; export rollback also failed: {rollback_error}"
                        ),
                    });
                }
            }
        }
    }

    if options.overwrite_same_name {
        if let Some(backup_path) = backup_path.as_ref() {
            if let Err(error) = fs::remove_file(backup_path) {
                eprintln!(
                    "failed to remove temporary overwrite backup `{}`: {error}",
                    backup_path.display()
                );
            }
        }
    }

    Ok(())
}

fn replace_original_file(
    output_path: &Path,
    bytes: Vec<u8>,
    source_path: Option<&str>,
) -> Result<(), String> {
    let source_path = validate_image_source(source_path)?;
    let output_parent = output_path.parent().unwrap_or_else(|| Path::new("."));
    validate_image_output_directory(output_parent)?;
    path_security::validate_existing_file(output_path)
        .map_err(|error| format_image_path_error(error, "image output path"))?;

    let mut backups = Vec::new();
    let source_backup = move_existing_output_to_backup(&source_path)?;
    backups.push((source_path.clone(), source_backup));

    if output_path.exists() && !paths_equal(&source_path, output_path) {
        match move_existing_output_to_backup(output_path) {
            Ok(output_backup) => backups.push((output_path.to_path_buf(), output_backup)),
            Err(error) => {
                return Err(with_rollback_error(error, restore_backups(&backups)));
            }
        }
    }

    if let Err(error) = write_file_atomically(output_path, &bytes) {
        let rollback_error = rollback_written_output(output_path, None, true);
        let restore_error = restore_backups(&backups);
        return Err(with_rollback_error(
            format_write_error(error, rollback_error),
            restore_error,
        ));
    }

    Ok(())
}

fn format_write_failure(
    output_path: &Path,
    error: io::Error,
    backup_path: Option<&PathBuf>,
    remove_incomplete_output: bool,
) -> String {
    let rollback_error =
        rollback_written_output(output_path, backup_path, remove_incomplete_output);
    format_write_error(error, rollback_error)
}

fn format_write_error(error: io::Error, rollback_error: Result<(), String>) -> String {
    match rollback_error {
        Ok(()) => error.to_string(),
        Err(rollback_error) => {
            format!("{error}; export rollback also failed: {rollback_error}")
        }
    }
}

fn rollback_written_output(
    output_path: &Path,
    backup_path: Option<&PathBuf>,
    remove_incomplete_output: bool,
) -> Result<(), String> {
    let mut errors = Vec::new();
    if remove_incomplete_output && output_path.exists() {
        if let Err(error) = fs::remove_file(output_path) {
            errors.push(format!("failed to remove incomplete output: {error}"));
        }
    }
    if let Some(backup_path) = backup_path {
        if !output_path.exists() {
            if let Err(error) = fs::rename(backup_path, output_path) {
                errors.push(format!("failed to restore previous output: {error}"));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn restore_backups(backups: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    let mut errors = Vec::new();
    for (original_path, backup_path) in backups.iter().rev() {
        if !original_path.exists() {
            if let Err(error) = fs::rename(backup_path, original_path) {
                errors.push(format!(
                    "failed to restore `{}`: {error}",
                    original_path.display()
                ));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn with_rollback_error(operation_error: String, rollback_error: Result<(), String>) -> String {
    match rollback_error {
        Ok(()) => operation_error,
        Err(rollback_error) => {
            format!("{operation_error}; export rollback also failed: {rollback_error}")
        }
    }
}

fn move_existing_output_to_backup(output_path: &Path) -> Result<PathBuf, String> {
    let parent = output_path.parent().unwrap_or_else(|| Path::new("."));
    let backup_directory = parent.join("bak");
    ensure_image_output_directory(&backup_directory)?;

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

fn move_existing_output_to_temporary_backup(output_path: &Path) -> Result<PathBuf, String> {
    let parent = output_path.parent().unwrap_or_else(|| Path::new("."));
    validate_image_output_directory(parent)?;
    let file_name = output_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "output file has no valid file name".to_string())?;
    let prefix = format!(".{file_name}.embedpix-overwrite-{}", std::process::id());
    for index in 0..=10_000 {
        let backup_path = parent.join(format!("{prefix}-{index}.tmp"));
        match fs::rename(output_path, &backup_path) {
            Ok(()) => return Ok(backup_path),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "failed to move existing output into temporary backup `{}`: {error}",
                    backup_path.display()
                ));
            }
        }
    }
    Err("failed to allocate a temporary overwrite backup path".to_string())
}

fn write_file_atomically(output_path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = output_path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = output_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "output file has no name"))?;
    let prefix = format!(".{file_name}.embedpix-write-{}", std::process::id());
    let mut temporary_path = None;
    for index in 0..=10_000 {
        let candidate = parent.join(format!("{prefix}-{index}.tmp"));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
                    let _ = fs::remove_file(&candidate);
                    return Err(error);
                }
                temporary_path = Some(candidate);
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    let temporary_path = temporary_path.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "failed to allocate a temporary output path",
        )
    })?;
    let result = fs::rename(&temporary_path, output_path);
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn next_backup_path(directory: &Path, file_name: &str) -> PathBuf {
    let first_path = directory.join(file_name);
    if is_absent_path(&first_path) {
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
        if is_absent_path(&candidate) {
            return candidate;
        }
    }
    directory.join(format!("{stem}_backup{extension}"))
}

fn is_absent_path(path: &Path) -> bool {
    matches!(
        fs::symlink_metadata(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound
    )
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

    fn preview_request(output_format: OutputFormat, bit_depth: u16) -> ExportRequest {
        let (input_data, _) = encode_png(sample_image(), 32, Rgba([255, 255, 255, 255])).unwrap();
        ExportRequest {
            input_data,
            source_file_name: "preview.png".to_string(),
            output_format,
            width: 2,
            height: 1,
            keep_aspect_ratio: false,
            background_color: Rgba([255, 255, 255, 255]),
            bit_depth,
            jpeg_quality: 90,
            raw_options: raw::RawOptions::parse(None, None, None, None).unwrap(),
            c_array_name: "preview".to_string(),
            output_location: OutputLocation::Dialog,
            source_path: None,
            output_subdirectory: None,
            output_directory: None,
            overwrite_existing: false,
            overwrite_same_name: false,
            transform: ImageTransformOptions::default(),
            watermark: None,
            delete_source: false,
            metadata_policy: MetadataPolicy::Strip,
        }
    }

    #[test]
    fn raw_metadata_parses_image_transform_options() {
        let metadata: ExportMetadata = serde_json::from_str(
            r##"{
                "fileName": "source.png",
                "outputFormat": "png",
                "width": 20,
                "height": 10,
                "keepAspectRatio": true,
                "backgroundColor": null,
                "transform": {
                    "rotation": 90,
                    "flipHorizontal": true,
                    "flipVertical": true,
                    "crop": { "x": 1, "y": 2, "width": 3, "height": 4 }
                }
            }"##,
        )
        .unwrap();

        let request = metadata.into_request(vec![1]).unwrap();
        assert_eq!(
            request.transform,
            ImageTransformOptions {
                rotation: 90,
                flip_horizontal: true,
                flip_vertical: true,
                crop: Some(CropRect {
                    x: 1,
                    y: 2,
                    width: 3,
                    height: 4,
                }),
            }
        );
    }

    #[test]
    fn image_transform_rejects_invalid_rotation_and_crop() {
        let invalid_rotation: ExportMetadata = serde_json::from_str(
            r##"{
                "fileName": "source.png",
                "outputFormat": "png",
                "width": 1,
                "height": 1,
                "keepAspectRatio": false,
                "backgroundColor": null,
                "transform": { "rotation": 45 }
            }"##,
        )
        .unwrap();
        assert!(invalid_rotation
            .into_request(vec![1])
            .unwrap_err()
            .contains("rotation"));

        let source = DynamicImage::ImageRgba8(RgbaImage::new(4, 3));
        for crop in [
            CropRect {
                x: 0,
                y: 0,
                width: 0,
                height: 1,
            },
            CropRect {
                x: 3,
                y: 0,
                width: 2,
                height: 1,
            },
            CropRect {
                x: 0,
                y: 2,
                width: 1,
                height: 2,
            },
            CropRect {
                x: u32::MAX,
                y: 0,
                width: 1,
                height: 1,
            },
        ] {
            let transform = ImageTransformOptions {
                crop: Some(crop),
                ..Default::default()
            };
            assert!(apply_image_transform(source.clone(), &transform).is_err());
        }
    }

    #[test]
    fn image_transform_preserves_alpha_and_applies_crop_rotation_and_flips() {
        let source = DynamicImage::ImageRgba8(
            RgbaImage::from_raw(
                3,
                2,
                vec![
                    10, 0, 0, 0, 20, 0, 0, 255, 30, 0, 0, 255, 40, 0, 0, 255, 50, 0, 0, 255, 60, 0,
                    0, 255,
                ],
            )
            .unwrap(),
        );
        let transform = ImageTransformOptions {
            rotation: 90,
            flip_horizontal: true,
            flip_vertical: true,
            crop: Some(CropRect {
                x: 1,
                y: 0,
                width: 2,
                height: 1,
            }),
        };

        let transformed = apply_image_transform(source, &transform).unwrap();
        assert_eq!(transformed.dimensions(), (1, 2));
        let pixels = transformed.to_rgba8();
        assert!(pixels
            .pixels()
            .any(|pixel| pixel[0] == 20 && pixel[3] == 255));
        assert!(pixels
            .pixels()
            .any(|pixel| pixel[0] == 30 && pixel[3] == 255));

        let flipped = apply_image_transform(
            DynamicImage::ImageRgba8(
                RgbaImage::from_raw(2, 1, vec![1, 2, 3, 0, 4, 5, 6, 127]).unwrap(),
            ),
            &ImageTransformOptions {
                flip_horizontal: true,
                flip_vertical: true,
                ..Default::default()
            },
        )
        .unwrap()
        .to_rgba8();
        assert_eq!(flipped.get_pixel(0, 0), &Rgba([4, 5, 6, 127]));
        assert_eq!(flipped.get_pixel(1, 0), &Rgba([1, 2, 3, 0]));
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
        assert!(image::load_from_memory(&low_quality).is_ok());
        assert!(image::load_from_memory(&high_quality).is_ok());
    }

    #[test]
    fn preview_contract_keeps_transparent_png_alpha_and_rejects_oversized_payloads() {
        let mut image = RgbaImage::new(1, 1);
        image.put_pixel(0, 0, Rgba([20, 40, 60, 17]));
        let (input_data, _) = encode_png(image, 32, Rgba([255, 255, 255, 255])).unwrap();
        let mut request = preview_request(OutputFormat::Png, 32);
        request.input_data = input_data;
        request.width = 1;
        request.height = 1;
        let preview = build_image_preview(&request).unwrap();
        let bit_depth = preview.bit_depth;
        let bytes = preview.data;
        let decoded = image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!(bit_depth, 32);
        assert_eq!(decoded.get_pixel(0, 0)[3], 17);
        assert_eq!(enforce_preview_limit(&bytes), Ok(()));
        let oversized = vec![0; MAX_PREVIEW_BYTES + 1];
        assert!(enforce_preview_limit(&oversized).is_err());
    }

    #[test]
    fn preview_contract_encodes_bmp_with_requested_bit_depth() {
        let request = preview_request(OutputFormat::Bmp, 24);
        let preview = build_image_preview(&request).unwrap();
        let bit_depth = preview.bit_depth;
        let bytes = preview.data;
        assert_eq!(bit_depth, 24);
        assert_eq!(&bytes[0..2], b"BM");
        assert_eq!(u16::from_le_bytes([bytes[28], bytes[29]]), 24);
    }

    #[test]
    fn preview_contract_encodes_rgb565_with_golden_length_and_samples() {
        let request = preview_request(OutputFormat::Rgb565, 16);
        let preview = build_image_preview(&request).unwrap();
        let bit_depth = preview.bit_depth;
        let bytes = preview.data;
        assert_eq!(bit_depth, 16);
        assert_eq!(bytes.len(), 4);
        assert_eq!(&bytes[0..2], &[0x00, 0xF8]);
        assert_eq!(&bytes[2..4], &[0xE0, 0x07]);
    }

    #[test]
    fn srgb_png_and_jpeg_outputs_do_not_emit_icc_or_exif_markers() {
        let (png, _) = encode_png(sample_image(), 32, Rgba([255, 255, 255, 255])).unwrap();
        assert!(!png
            .windows(4)
            .any(|chunk| chunk == b"iCCP" || chunk == b"eXIf"));

        let (jpeg, _) = encode_jpg(sample_image(), Rgba([255, 255, 255, 255]), 90).unwrap();
        assert!(!jpeg.windows(4).any(|marker| marker == b"ICC_"));
        assert!(!jpeg.windows(2).any(|marker| marker == [0xFF, 0xE1]));
    }

    #[test]
    fn metadata_policy_preserve_is_rejected_while_legacy_requests_default_to_strip() {
        let preserve: ExportMetadata = serde_json::from_str(
            r#"{
                "fileName":"source.png","outputFormat":"png","width":1,"height":1,
                "keepAspectRatio":false,"metadataPolicy":"preserve"
            }"#,
        )
        .unwrap();
        assert!(preserve
            .into_request(vec![1])
            .unwrap_err()
            .contains("metadataPolicy=preserve"));

        let legacy: ExportMetadata = serde_json::from_str(
            r#"{"fileName":"source.png","outputFormat":"png","width":1,"height":1,"keepAspectRatio":false}"#,
        )
        .unwrap();
        assert_eq!(
            legacy.into_request(vec![1]).unwrap().metadata_policy,
            MetadataPolicy::Strip
        );
    }

    #[test]
    fn watermark_defaults_trim_text_and_validate_output_formats() {
        let watermark = parse_watermark(
            OutputFormat::Png,
            Some("  Author  ".to_string()),
            None,
            None,
            None,
        )
        .unwrap()
        .unwrap();
        assert_eq!(watermark.text, "Author");
        assert!(matches!(watermark.position, WatermarkPosition::BottomRight));
        assert_eq!(watermark.opacity, 60);
        assert_eq!(watermark.font_size, 16);

        assert!(parse_watermark(
            OutputFormat::Rgb565,
            Some("Author".to_string()),
            None,
            None,
            None,
        )
        .unwrap_err()
        .contains("PNG, JPG, and BMP"));
        assert!(
            parse_watermark(OutputFormat::Png, Some("   ".to_string()), None, None, None,)
                .unwrap_err()
                .contains("must not be empty")
        );
        assert!(parse_watermark(
            OutputFormat::Png,
            Some("Author".to_string()),
            Some("middle".to_string()),
            Some(0),
            Some(100),
        )
        .unwrap_err()
        .contains("watermarkOpacity"));
    }

    #[test]
    fn watermark_changes_supported_raster_pixels_and_preserves_transparency_elsewhere() {
        let mut image = RgbaImage::from_pixel(64, 32, Rgba([20, 30, 40, 255]));
        let original = image.clone();
        let options = WatermarkOptions {
            text: "A".to_string(),
            position: WatermarkPosition::TopLeft,
            opacity: 100,
            font_size: 8,
        };
        apply_watermark(&mut image, &options);

        assert_ne!(image, original);
        assert_eq!(image.get_pixel(63, 31), original.get_pixel(63, 31));

        let mut transparent = RgbaImage::from_pixel(64, 32, Rgba([20, 30, 40, 0]));
        apply_watermark(&mut transparent, &options);
        assert!(transparent
            .pixels()
            .any(|pixel| pixel[3] > 0 && pixel[0] >= pixel[1]));
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
            overwrite_same_name: false,
            transform: None,
            watermark_text: None,
            watermark_position: None,
            watermark_opacity: None,
            watermark_font_size: None,
            delete_source: false,
            metadata_policy: None,
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
            overwrite_same_name: false,
            transform: None,
            watermark_text: None,
            watermark_position: None,
            watermark_opacity: None,
            watermark_font_size: None,
            delete_source: false,
            metadata_policy: None,
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
            overwrite_same_name: false,
            transform: None,
            watermark_text: None,
            watermark_position: None,
            watermark_opacity: None,
            watermark_font_size: None,
            delete_source: false,
            metadata_policy: None,
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
            overwrite_same_name: false,
            transform: None,
            watermark_text: None,
            watermark_position: None,
            watermark_opacity: None,
            watermark_font_size: None,
            delete_source: false,
            metadata_policy: None,
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
                "outputSubdirectory": "export",
                "overwriteSameName": true
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
        assert!(request.overwrite_same_name);
    }

    #[test]
    fn output_subdirectories_reject_path_escape_characters() {
        assert!(normalize_optional_subdirectory(Some("..".to_string())).is_err());
        assert!(normalize_optional_subdirectory(Some(r"nested\folder".to_string())).is_err());
        assert!(normalize_optional_subdirectory(Some("CON".to_string())).is_err());
        assert!(normalize_optional_subdirectory(Some("export".to_string())).is_ok());
    }

    fn output_path_test_request(
        output_location: OutputLocation,
        source_path: Option<String>,
        output_subdirectory: Option<String>,
        output_directory: Option<String>,
    ) -> ExportRequest {
        ExportRequest {
            input_data: vec![1],
            source_file_name: "source.png".to_string(),
            output_format: OutputFormat::Png,
            width: 1,
            height: 1,
            keep_aspect_ratio: false,
            background_color: Rgba([255, 255, 255, 255]),
            bit_depth: 24,
            jpeg_quality: 85,
            raw_options: raw::RawOptions::parse(None, None, None, None).unwrap(),
            c_array_name: "source".to_string(),
            output_location,
            source_path,
            output_subdirectory,
            output_directory,
            overwrite_existing: false,
            overwrite_same_name: true,
            transform: ImageTransformOptions::default(),
            watermark: None,
            delete_source: false,
            metadata_policy: MetadataPolicy::Strip,
        }
    }

    #[test]
    fn output_path_selection_supports_safe_locations_without_eager_directory_creation() {
        let root = crate::commands::test_temp_dir().join(format!(
            "embedpix-image-output-path-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.png");
        fs::write(&source, b"source").unwrap();
        let source_path = Some(source.to_string_lossy().into_owned());

        let source_output = choose_output_path(
            &output_path_test_request(OutputLocation::Source, source_path.clone(), None, None),
            "source.png",
            OutputFormat::Png,
        )
        .unwrap();
        assert_eq!(source_output, source);

        let subfolder = root.join("export");
        let subfolder_output = choose_output_path(
            &output_path_test_request(
                OutputLocation::Subfolder,
                source_path.clone(),
                Some("export".to_string()),
                None,
            ),
            "source.png",
            OutputFormat::Png,
        )
        .unwrap();
        assert_eq!(subfolder_output, subfolder.join("source.png"));
        assert!(!subfolder.exists());

        let specified_directory = root.join("specified");
        let directory_output = choose_output_path(
            &output_path_test_request(
                OutputLocation::Directory,
                None,
                None,
                Some(specified_directory.to_string_lossy().into_owned()),
            ),
            "source.png",
            OutputFormat::Png,
        )
        .unwrap();
        assert_eq!(directory_output, specified_directory.join("source.png"));
        assert!(!specified_directory.exists());

        let original_output = choose_output_path(
            &output_path_test_request(OutputLocation::Original, source_path, None, None),
            "source.png",
            OutputFormat::Png,
        )
        .unwrap();
        assert_eq!(original_output, source);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn output_paths_reject_traversal_and_reserved_device_names() {
        assert!(normalize_optional_path(Some("../escape".to_string()), "outputDirectory").is_err());
        assert!(normalize_optional_path(Some("CON".to_string()), "sourcePath").is_err());
        assert!(normalize_optional_subdirectory(Some("LPT9".to_string())).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn output_paths_reject_symlinked_directories_without_creating_children() {
        use std::os::unix::fs::symlink;

        let root = crate::commands::test_temp_dir().join(format!(
            "embedpix-image-output-symlink-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let real = root.join("real");
        fs::create_dir(&real).unwrap();
        let link = root.join("link");
        symlink(&real, &link).unwrap();

        let request = output_path_test_request(
            OutputLocation::Directory,
            None,
            None,
            Some(link.join("new").to_string_lossy().into_owned()),
        );
        let error = choose_output_path(&request, "source.png", OutputFormat::Png).unwrap_err();
        assert!(error.contains("symlink") || error.contains("reparse"));
        assert!(!real.join("new").exists());

        let real_source = real.join("source.png");
        fs::write(&real_source, b"source").unwrap();
        let source_link = root.join("source-link.png");
        symlink(&real_source, &source_link).unwrap();
        let source_request = output_path_test_request(
            OutputLocation::Source,
            Some(source_link.to_string_lossy().into_owned()),
            None,
            None,
        );
        assert!(choose_output_path(&source_request, "source.png", OutputFormat::Png).is_err());

        let output_link = root.join("source.png");
        symlink(&real_source, &output_link).unwrap();
        let output_request = output_path_test_request(
            OutputLocation::Directory,
            None,
            None,
            Some(root.to_string_lossy().into_owned()),
        );
        assert!(choose_output_path(&output_request, "source.png", OutputFormat::Png).is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn overwrite_moves_old_output_to_bak_and_deletes_source_after_write() {
        let directory = crate::commands::test_temp_dir()
            .join(format!("embedpix-output-test-{}", std::process::id()));
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
            WriteOptions {
                manage_existing_output: true,
                overwrite_existing: true,
                overwrite_same_name: false,
                delete_source: true,
                replace_original: false,
            },
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
    fn overwrite_same_name_replaces_output_without_persisting_a_backup() {
        let directory = crate::commands::test_temp_dir().join(format!(
            "embedpix-direct-overwrite-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let output = directory.join("screen.png");
        fs::write(&output, b"old-output").unwrap();

        write_exported_file(
            &output,
            b"new-output".to_vec(),
            None,
            WriteOptions {
                manage_existing_output: true,
                overwrite_existing: false,
                overwrite_same_name: true,
                delete_source: false,
                replace_original: false,
            },
        )
        .unwrap();

        assert_eq!(fs::read(&output).unwrap(), b"new-output");
        assert!(!directory.join("bak/screen.png").exists());
        assert!(fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| entry.file_name() == "screen.png"));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn overwrite_same_name_restores_output_when_source_deletion_fails() {
        let directory = crate::commands::test_temp_dir().join(format!(
            "embedpix-direct-overwrite-rollback-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("source-directory");
        let output = directory.join("screen.png");
        fs::create_dir(&source).unwrap();
        fs::write(&output, b"old-output").unwrap();

        let error = write_exported_file(
            &output,
            b"new-output".to_vec(),
            source.to_str(),
            WriteOptions {
                manage_existing_output: true,
                overwrite_existing: false,
                overwrite_same_name: true,
                delete_source: true,
                replace_original: false,
            },
        )
        .unwrap_err();

        assert!(error.contains("failed to delete source image"));
        assert_eq!(fs::read(&output).unwrap(), b"old-output");
        assert!(source.is_dir());
        assert!(!directory.join("bak/screen.png").exists());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn deleting_source_does_not_delete_replacement_output() {
        let directory = crate::commands::test_temp_dir().join(format!(
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
            WriteOptions {
                manage_existing_output: true,
                overwrite_existing: true,
                overwrite_same_name: false,
                delete_source: true,
                replace_original: false,
            },
        )
        .unwrap();

        assert_eq!(fs::read(&source).unwrap(), b"new-source");
        assert_eq!(
            fs::read(directory.join("bak/source.png")).unwrap(),
            b"old-source"
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn original_output_backs_up_source_and_existing_new_extension() {
        let directory = crate::commands::test_temp_dir().join(format!(
            "embedpix-original-output-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("screen.png");
        let output = directory.join("screen.bmp");
        fs::write(&source, b"old-source").unwrap();
        fs::write(&output, b"old-bmp").unwrap();

        replace_original_file(&output, b"new-bmp".to_vec(), source.to_str()).unwrap();

        assert!(!source.exists());
        assert_eq!(fs::read(&output).unwrap(), b"new-bmp");
        assert_eq!(
            fs::read(directory.join("bak/screen.png")).unwrap(),
            b"old-source"
        );
        assert_eq!(
            fs::read(directory.join("bak/screen.bmp")).unwrap(),
            b"old-bmp"
        );
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn original_output_restores_source_when_write_fails() {
        let directory = crate::commands::test_temp_dir().join(format!(
            "embedpix-original-rollback-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("screen.png");
        let output = directory.join("missing").join("screen.bmp");
        fs::write(&source, b"old-source").unwrap();

        let error =
            replace_original_file(&output, b"new-bmp".to_vec(), source.to_str()).unwrap_err();

        assert!(!error.is_empty());
        assert_eq!(fs::read(&source).unwrap(), b"old-source");
        assert!(!output.exists());
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn original_output_same_extension_backs_up_source_before_writeback() {
        let directory = crate::commands::test_temp_dir().join(format!(
            "embedpix-original-same-extension-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("screen.png");
        fs::write(&source, b"old-source").unwrap();

        replace_original_file(&source, b"new-source".to_vec(), source.to_str()).unwrap();

        assert_eq!(fs::read(&source).unwrap(), b"new-source");
        assert_eq!(
            fs::read(directory.join("bak/screen.png")).unwrap(),
            b"old-source"
        );
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn failed_source_deletion_rolls_back_new_output_and_previous_output() {
        let directory = crate::commands::test_temp_dir().join(format!(
            "embedpix-source-delete-rollback-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("source-directory");
        let output = directory.join("screen.png");
        fs::create_dir(&source).unwrap();
        fs::write(&output, b"old-output").unwrap();

        let error = write_exported_file(
            &output,
            b"new-output".to_vec(),
            source.to_str(),
            WriteOptions {
                manage_existing_output: true,
                overwrite_existing: true,
                overwrite_same_name: false,
                delete_source: true,
                replace_original: false,
            },
        )
        .unwrap_err();

        assert!(error.contains("failed to delete source image"));
        assert!(source.is_dir());
        assert_eq!(fs::read(&output).unwrap(), b"old-output");
        assert!(!directory.join("bak/screen.png").exists());
        let _ = fs::remove_dir_all(&directory);
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
