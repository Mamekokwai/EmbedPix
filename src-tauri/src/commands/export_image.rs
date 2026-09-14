use std::{
    fs,
    io::{self, Cursor, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{
    imageops::FilterType, io::Reader as ImageReader, DynamicImage, GenericImage, ImageFormat, Rgba,
    RgbaImage,
};
use serde::{Deserialize, Serialize};

mod bmp;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 8_192;
const MAX_IMAGE_PIXELS: u64 = 16_777_216;
const MAX_DECODER_ALLOC_BYTES: u64 = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputFormat {
    Png,
    Jpg,
    Bmp,
}

impl OutputFormat {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "png" => Ok(Self::Png),
            "jpg" | "jpeg" => Ok(Self::Jpg),
            "bmp" => Ok(Self::Bmp),
            other => Err(format!(
                "unsupported output format `{other}`; expected png, jpg, or bmp"
            )),
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpg => "jpg",
            Self::Bmp => "bmp",
        }
    }

    fn name(self) -> &'static str {
        self.extension()
    }
}

#[derive(Debug, Clone)]
struct ExportRequest {
    input_data: String,
    source_file_name: String,
    output_format: OutputFormat,
    width: u32,
    height: u32,
    keep_aspect_ratio: bool,
    background_color: Rgba<u8>,
    bit_depth: u16,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportImageDto {
    input_data_base64: String,
    file_name: String,
    output_format: String,
    width: u32,
    height: u32,
    keep_aspect_ratio: bool,
    background_color: Option<String>,
    bit_depth: Option<u16>,
}

impl ExportImageDto {
    fn into_request(self) -> Result<ExportRequest, String> {
        Ok(ExportRequest {
            input_data: self.input_data_base64,
            source_file_name: self.file_name,
            output_format: OutputFormat::parse(&self.output_format)?,
            width: self.width,
            height: self.height,
            keep_aspect_ratio: self.keep_aspect_ratio,
            background_color: parse_background_color(self.background_color.as_deref())?,
            bit_depth: self.bit_depth.unwrap_or(24),
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

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
pub async fn export_image(
    input_data_base64: String,
    file_name: String,
    output_format: String,
    width: u32,
    height: u32,
    keep_aspect_ratio: bool,
    background_color: Option<String>,
    bit_depth: Option<u16>,
) -> Result<ExportImageResult, String> {
    let request = ExportImageDto {
        input_data_base64,
        file_name,
        output_format,
        width,
        height,
        keep_aspect_ratio,
        background_color,
        bit_depth,
    }
    .into_request()?;
    let conversion_request = request.clone();
    let (bytes, actual_bit_depth) =
        tauri::async_runtime::spawn_blocking(move || convert_image(&conversion_request))
            .await
            .map_err(|error| format!("image conversion task failed: {error}"))??;
    let output_path = choose_output_path(&request)?;
    let path_for_write = output_path.clone();
    tauri::async_runtime::spawn_blocking(move || fs::write(&path_for_write, bytes))
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
        width: request.width,
        height: request.height,
        format: request.output_format.name().to_string(),
        bit_depth: actual_bit_depth,
    })
}

fn convert_image(request: &ExportRequest) -> Result<(Vec<u8>, u16), String> {
    validate_dimensions(request.width, request.height)?;
    validate_bit_depth(request.output_format, request.bit_depth)?;

    let encoded_input = request.input_data.trim();
    let encoded_input = encoded_input
        .split_once(',')
        .filter(|(prefix, _)| prefix.trim_start().starts_with("data:"))
        .map(|(_, data)| data)
        .unwrap_or(encoded_input);
    validate_encoded_input_size(encoded_input.len())?;
    let input_bytes = STANDARD
        .decode(encoded_input)
        .map_err(|error| format!("invalid base64 image data: {error}"))?;
    if input_bytes.len() > MAX_INPUT_BYTES {
        return Err(format!(
            "input image is too large: decoded data is {} MiB, maximum is {} MiB",
            input_bytes.len() / (1024 * 1024),
            MAX_INPUT_BYTES / (1024 * 1024)
        ));
    }
    let source = decode_input(&input_bytes)?;
    let image = resize_image(
        source,
        request.width,
        request.height,
        request.keep_aspect_ratio,
        request.background_color,
    );

    match request.output_format {
        OutputFormat::Png => encode_png(image, request.bit_depth, request.background_color),
        OutputFormat::Jpg => encode_jpg(image, request.background_color),
        OutputFormat::Bmp => bmp::encode(&image, request.bit_depth, request.background_color),
    }
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

fn validate_encoded_input_size(encoded_len: usize) -> Result<(), String> {
    let max_encoded_len = MAX_INPUT_BYTES
        .checked_add(2)
        .and_then(|bytes| bytes.checked_div(3))
        .and_then(|bytes| bytes.checked_mul(4))
        .ok_or_else(|| "configured input image limit overflowed".to_string())?;
    if encoded_len > max_encoded_len {
        return Err(format!(
            "input image is too large: base64 data exceeds the {} MiB limit",
            MAX_INPUT_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
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

fn encode_jpg(image: RgbaImage, background_color: Rgba<u8>) -> Result<(Vec<u8>, u16), String> {
    let mut bytes = LimitedCursor::new(MAX_OUTPUT_BYTES);
    DynamicImage::ImageRgba8(composite_over_background(image, background_color))
        .write_to(&mut bytes, ImageFormat::Jpeg)
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

fn choose_output_path(request: &ExportRequest) -> Result<PathBuf, String> {
    let default_name = default_output_name(&request.source_file_name, request.output_format);
    let filter_name = request.output_format.name().to_ascii_uppercase();
    let path = rfd::FileDialog::new()
        .set_title("Export image")
        .set_file_name(default_name)
        .add_filter(&filter_name, &[request.output_format.extension()])
        .save_file()
        .ok_or_else(|| "image export cancelled".to_string())?;

    Ok(with_expected_extension(path, request.output_format))
}

fn default_output_name(source_file_name: &str, format: OutputFormat) -> String {
    let stem = Path::new(source_file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("image");
    format!("{stem}.{}", format.extension())
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
    fn frontend_dto_accepts_camel_case_contract_and_null_bit_depth() {
        let dto: ExportImageDto = serde_json::from_str(
            r##"{
                "inputDataBase64": "aW1hZ2U=",
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

        let request = dto.into_request().unwrap();
        assert_eq!(request.input_data, "aW1hZ2U=");
        assert_eq!(request.source_file_name, "source.png");
        assert_eq!(request.bit_depth, 24);
        assert_eq!(request.background_color, Rgba([16, 32, 48, 255]));
    }

    #[test]
    fn tauri_camel_case_contract_keeps_input_data_base64_key() {
        let dto = ExportImageDto {
            input_data_base64: "aW1hZ2U=".to_string(),
            file_name: "source.png".to_string(),
            output_format: "png".to_string(),
            width: 1,
            height: 1,
            keep_aspect_ratio: false,
            background_color: None,
            bit_depth: None,
        };
        let value = serde_json::to_value(dto).unwrap();

        assert_eq!(value["inputDataBase64"], "aW1hZ2U=");
        assert!(value.get("inputData").is_none());
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
        let (jpg, jpg_bit_depth) = encode_jpg(sample_image(), Rgba([255, 255, 255, 255])).unwrap();

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
    fn resource_limits_reject_large_encoded_inputs_and_source_dimensions() {
        let encoded_limit = MAX_INPUT_BYTES
            .checked_add(2)
            .unwrap()
            .checked_div(3)
            .unwrap()
            .checked_mul(4)
            .unwrap();
        assert!(validate_encoded_input_size(encoded_limit).is_ok());
        assert!(validate_encoded_input_size(encoded_limit + 1)
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
