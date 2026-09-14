use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{imageops::FilterType, DynamicImage, ImageFormat, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

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

#[derive(Debug, Deserialize)]
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
pub fn export_image(
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
    let (bytes, actual_bit_depth) = convert_image(&request)?;
    let output_path = choose_output_path(&request)?;
    fs::write(&output_path, bytes).map_err(|error| {
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
    let input_bytes = STANDARD
        .decode(encoded_input)
        .map_err(|error| format!("invalid base64 image data: {error}"))?;
    let source = image::load_from_memory(&input_bytes)
        .map_err(|error| format!("failed to decode input image: {error}"))?;
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
        OutputFormat::Bmp => encode_bmp(&image, request.bit_depth, request.background_color),
    }
}

fn validate_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("target width and height must be greater than zero".to_string());
    }
    Ok(())
}

fn validate_bit_depth(format: OutputFormat, bit_depth: u16) -> Result<(), String> {
    let supported = match format {
        OutputFormat::Png => matches!(bit_depth, 24 | 32),
        OutputFormat::Jpg => bit_depth == 24,
        OutputFormat::Bmp => matches!(bit_depth, 1 | 4 | 8 | 16 | 24 | 32),
    };
    if supported {
        return Ok(());
    }

    let formats = match format {
        OutputFormat::Png => "24 or 32",
        OutputFormat::Jpg => "24",
        OutputFormat::Bmp => "1, 4, 8, 16, 24, or 32",
    };
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
        (
            ((source_width as f64 * scale).round() as u32).max(1),
            ((source_height as f64 * scale).round() as u32).max(1),
        )
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
    image::imageops::overlay(
        &mut canvas,
        &resized,
        i64::from(offset_x),
        i64::from(offset_y),
    );
    canvas
}

fn encode_png(
    image: RgbaImage,
    bit_depth: u16,
    background_color: Rgba<u8>,
) -> Result<(Vec<u8>, u16), String> {
    let mut bytes = Cursor::new(Vec::new());
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
    let mut bytes = Cursor::new(Vec::new());
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

fn encode_bmp(
    image: &RgbaImage,
    bit_depth: u16,
    background_color: Rgba<u8>,
) -> Result<(Vec<u8>, u16), String> {
    validate_bit_depth(OutputFormat::Bmp, bit_depth)?;
    let width = i32::try_from(image.width()).map_err(|_| "BMP width is too large".to_string())?;
    let height =
        i32::try_from(image.height()).map_err(|_| "BMP height is too large".to_string())?;
    let image = if bit_depth <= 24 {
        composite_over_background(image.clone(), background_color)
    } else {
        image.clone()
    };
    let palette = bmp_palette(bit_depth);
    let row_bits = (image.width() as usize)
        .checked_mul(usize::from(bit_depth))
        .ok_or_else(|| "BMP row is too large".to_string())?;
    let row_stride = row_bits
        .checked_add(31)
        .and_then(|bits| (bits / 32).checked_mul(4))
        .ok_or_else(|| "BMP row is too large".to_string())?;
    let pixel_bytes = row_stride
        .checked_mul(image.height() as usize)
        .ok_or_else(|| "BMP pixel data is too large".to_string())?;
    let dib_header_bytes = if bit_depth == 32 { 56 } else { 40 };
    let mask_bytes = if bit_depth == 16 { 12 } else { 0 };
    let header_bytes = 14_usize
        .checked_add(dib_header_bytes)
        .and_then(|size| size.checked_add(palette.len() * 4))
        .and_then(|size| size.checked_add(mask_bytes))
        .ok_or_else(|| "BMP header is too large".to_string())?;
    let file_size = header_bytes
        .checked_add(pixel_bytes)
        .ok_or_else(|| "BMP file is too large".to_string())?;
    if file_size > u32::MAX as usize {
        return Err("BMP file is too large".to_string());
    }

    let mut output = Vec::with_capacity(file_size);
    output.extend_from_slice(b"BM");
    push_u32(&mut output, file_size as u32);
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u32(&mut output, header_bytes as u32);
    push_u32(&mut output, dib_header_bytes as u32);
    push_i32(&mut output, width);
    push_i32(&mut output, height);
    push_u16(&mut output, 1);
    push_u16(&mut output, bit_depth);
    push_u32(
        &mut output,
        if matches!(bit_depth, 16 | 32) { 3 } else { 0 },
    );
    push_u32(&mut output, pixel_bytes as u32);
    push_i32(&mut output, 2835);
    push_i32(&mut output, 2835);
    push_u32(&mut output, palette.len() as u32);
    push_u32(&mut output, 0);

    for [red, green, blue] in &palette {
        output.extend_from_slice(&[*blue, *green, *red, 0]);
    }
    if bit_depth == 16 {
        push_u32(&mut output, 0xF800);
        push_u32(&mut output, 0x07E0);
        push_u32(&mut output, 0x001F);
    } else if bit_depth == 32 {
        push_u32(&mut output, 0x00FF0000);
        push_u32(&mut output, 0x0000FF00);
        push_u32(&mut output, 0x000000FF);
        push_u32(&mut output, 0xFF000000);
    }

    for y in (0..image.height()).rev() {
        let row_start = output.len();
        output.resize(row_start + row_stride, 0);
        for x in 0..image.width() {
            let pixel = image.get_pixel(x, y);
            let x = x as usize;
            match bit_depth {
                1 => {
                    let index = bmp_palette_index(pixel, &palette);
                    if index != 0 {
                        output[row_start + x / 8] |= 1 << (7 - (x % 8));
                    }
                }
                4 => {
                    let index = bmp_palette_index(pixel, &palette);
                    let byte = &mut output[row_start + x / 2];
                    if x.is_multiple_of(2) {
                        *byte |= index << 4;
                    } else {
                        *byte |= index;
                    }
                }
                8 => {
                    output[row_start + x] = bmp_palette_index(pixel, &palette);
                }
                16 => {
                    let value = bmp_565_pixel(pixel);
                    let offset = row_start + x * 2;
                    output[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
                }
                24 => {
                    let offset = row_start + x * 3;
                    output[offset..offset + 3].copy_from_slice(&[pixel[2], pixel[1], pixel[0]]);
                }
                32 => {
                    let offset = row_start + x * 4;
                    output[offset..offset + 4]
                        .copy_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
                }
                _ => unreachable!("BMP bit depth was validated before encoding"),
            }
        }
    }
    Ok((output, bit_depth))
}

fn bmp_palette(bit_depth: u16) -> Vec<[u8; 3]> {
    match bit_depth {
        1 => vec![[0, 0, 0], [255, 255, 255]],
        4 => (0..16)
            .map(|value| [value * 17, value * 17, value * 17])
            .collect(),
        8 => (0_u8..=255_u8)
            .map(|value| {
                [
                    (u16::from((value >> 5) & 0x07) * 255 / 7) as u8,
                    (u16::from((value >> 2) & 0x07) * 255 / 7) as u8,
                    (u16::from(value & 0x03) * 255 / 3) as u8,
                ]
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn bmp_palette_index(pixel: &Rgba<u8>, palette: &[[u8; 3]]) -> u8 {
    palette
        .iter()
        .enumerate()
        .min_by_key(|(_, color)| {
            let red = i32::from(pixel[0]) - i32::from(color[0]);
            let green = i32::from(pixel[1]) - i32::from(color[1]);
            let blue = i32::from(pixel[2]) - i32::from(color[2]);
            (red * red + green * green + blue * blue) as u32
        })
        .map(|(index, _)| index as u8)
        .unwrap_or(0)
}

fn bmp_565_pixel(pixel: &Rgba<u8>) -> u16 {
    let red = (u16::from(pixel[0]) * 31 + 127) / 255;
    let green = (u16::from(pixel[1]) * 63 + 127) / 255;
    let blue = (u16::from(pixel[2]) * 31 + 127) / 255;
    (red << 11) | (green << 5) | blue
}

fn push_u16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn push_i32(output: &mut Vec<u8>, value: i32) {
    output.extend_from_slice(&value.to_le_bytes());
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_image() -> RgbaImage {
        let mut image = RgbaImage::new(2, 1);
        image.put_pixel(0, 0, Rgba([255, 0, 0, 255]));
        image.put_pixel(1, 0, Rgba([0, 255, 0, 255]));
        image
    }

    #[test]
    fn bmp_24_header_and_bottom_up_pixels_are_little_endian() {
        let (bytes, bit_depth) =
            encode_bmp(&sample_image(), 24, Rgba([255, 255, 255, 255])).unwrap();

        assert_eq!(bit_depth, 24);
        assert_eq!(&bytes[0..2], b"BM");
        assert_eq!(u32::from_le_bytes(bytes[2..6].try_into().unwrap()), 62);
        assert_eq!(u32::from_le_bytes(bytes[10..14].try_into().unwrap()), 54);
        assert_eq!(u32::from_le_bytes(bytes[18..22].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(bytes[22..26].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(bytes[26..28].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(bytes[28..30].try_into().unwrap()), 24);
        assert_eq!(u32::from_le_bytes(bytes[34..38].try_into().unwrap()), 8);
        assert_eq!(&bytes[54..62], &[0, 0, 255, 0, 255, 0, 0, 0]);
    }

    #[test]
    fn bmp_24_transparent_pixels_are_composited_before_encoding() {
        let mut image = RgbaImage::new(1, 1);
        image.put_pixel(0, 0, Rgba([255, 0, 0, 0]));

        let (bytes, _) = encode_bmp(&image, 24, Rgba([0, 255, 0, 255])).unwrap();

        assert_eq!(&bytes[54..58], &[0, 255, 0, 0]);
    }

    #[test]
    fn bmp_32_uses_bgra_bitfields_and_matching_pixel_layout() {
        let (bytes, bit_depth) =
            encode_bmp(&sample_image(), 32, Rgba([255, 255, 255, 255])).unwrap();

        assert_eq!(bit_depth, 32);
        assert_eq!(u32::from_le_bytes(bytes[2..6].try_into().unwrap()), 78);
        assert_eq!(u32::from_le_bytes(bytes[10..14].try_into().unwrap()), 70);
        assert_eq!(u32::from_le_bytes(bytes[14..18].try_into().unwrap()), 56);
        assert_eq!(u32::from_le_bytes(bytes[30..34].try_into().unwrap()), 3);
        assert_eq!(
            &bytes[54..70],
            &[0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 255]
        );
        assert_eq!(&bytes[70..78], &[0, 0, 255, 255, 0, 255, 0, 255]);
    }

    #[test]
    fn bmp_supported_bit_depths_have_standard_headers() {
        for bit_depth in [1, 4, 8, 16, 24, 32] {
            let (bytes, actual_bit_depth) =
                encode_bmp(&sample_image(), bit_depth, Rgba([255, 255, 255, 255])).unwrap();
            let palette_bytes = if bit_depth <= 8 {
                (1_u32 << bit_depth) * 4
            } else {
                0
            };
            let mask_bytes = if bit_depth == 16 { 12 } else { 0 };
            let dib_header_bytes = if bit_depth == 32 { 56 } else { 40 };
            let expected_offset = 14 + dib_header_bytes + palette_bytes + mask_bytes;

            assert_eq!(actual_bit_depth, bit_depth);
            assert_eq!(
                u16::from_le_bytes(bytes[28..30].try_into().unwrap()),
                bit_depth
            );
            assert_eq!(
                u32::from_le_bytes(bytes[10..14].try_into().unwrap()),
                expected_offset
            );
            assert_eq!(
                u32::from_le_bytes(bytes[2..6].try_into().unwrap()),
                bytes.len() as u32
            );
            if bit_depth == 16 {
                assert_eq!(u32::from_le_bytes(bytes[30..34].try_into().unwrap()), 3);
                assert_eq!(&bytes[54..66], &[0, 248, 0, 0, 224, 7, 0, 0, 31, 0, 0, 0]);
            }
            if bit_depth == 32 {
                assert_eq!(u32::from_le_bytes(bytes[14..18].try_into().unwrap()), 56);
                assert_eq!(u32::from_le_bytes(bytes[30..34].try_into().unwrap()), 3);
            }
        }
    }

    #[test]
    fn bmp_1_bit_pixels_are_msb_first_and_row_aligned() {
        let mut image = RgbaImage::new(9, 1);
        image.put_pixel(8, 0, Rgba([255, 255, 255, 255]));

        let (bytes, _) = encode_bmp(&image, 1, Rgba([0, 0, 0, 255])).unwrap();

        assert_eq!(&bytes[62..66], &[0, 128, 0, 0]);
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
}
