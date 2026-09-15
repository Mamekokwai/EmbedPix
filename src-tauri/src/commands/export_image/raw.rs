use image::{Rgba, RgbaImage};

use super::MAX_OUTPUT_BYTES;

const MAX_C_ARRAY_NAME_CHARS: usize = 96;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ByteOrder {
    Little,
    Big,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ChannelOrder {
    Rgb,
    Bgr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RowOrder {
    TopDown,
    BottomUp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct RawOptions {
    pub(super) byte_order: ByteOrder,
    pub(super) channel_order: ChannelOrder,
    pub(super) row_order: RowOrder,
    pub(super) row_alignment: u8,
}

impl RawOptions {
    pub(super) fn parse(
        byte_order: Option<&str>,
        channel_order: Option<&str>,
        row_order: Option<&str>,
        row_alignment: Option<u8>,
    ) -> Result<Self, String> {
        let byte_order = match byte_order
            .unwrap_or("little")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "little" => ByteOrder::Little,
            "big" => ByteOrder::Big,
            value => {
                return Err(format!(
                    "byteOrder `{value}` is invalid; expected little or big"
                ))
            }
        };
        let channel_order = match channel_order
            .unwrap_or("rgb")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "rgb" => ChannelOrder::Rgb,
            "bgr" => ChannelOrder::Bgr,
            value => {
                return Err(format!(
                    "channelOrder `{value}` is invalid; expected rgb or bgr"
                ))
            }
        };
        let row_order = match row_order
            .unwrap_or("top-down")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "top-down" | "top_down" => RowOrder::TopDown,
            "bottom-up" | "bottom_up" => RowOrder::BottomUp,
            value => {
                return Err(format!(
                    "rowOrder `{value}` is invalid; expected top-down or bottom-up"
                ))
            }
        };
        let row_alignment = row_alignment.unwrap_or(1);
        if !matches!(row_alignment, 1 | 2 | 4) {
            return Err("rowAlignment must be 1, 2, or 4".to_string());
        }
        Ok(Self {
            byte_order,
            channel_order,
            row_order,
            row_alignment,
        })
    }
}

pub(super) fn encode_rgb565(
    image: &RgbaImage,
    background_color: Rgba<u8>,
    options: RawOptions,
) -> Result<(Vec<u8>, u16), String> {
    let width = image.width() as usize;
    let height = image.height() as usize;
    let row_bytes = width
        .checked_mul(2)
        .ok_or_else(|| "rgb565 row is too large".to_string())?;
    let alignment = usize::from(options.row_alignment);
    let row_stride = row_bytes
        .checked_add(alignment - 1)
        .map(|bytes| bytes / alignment * alignment)
        .ok_or_else(|| "rgb565 row is too large".to_string())?;
    let output_len = row_stride
        .checked_mul(height)
        .ok_or_else(|| "rgb565 output is too large".to_string())?;
    ensure_output_size(output_len)?;

    let mut output = vec![0_u8; output_len];
    for output_y in 0..height {
        let source_y = match options.row_order {
            RowOrder::TopDown => output_y,
            RowOrder::BottomUp => height - 1 - output_y,
        } as u32;
        let row_start = output_y * row_stride;
        for x in 0..width {
            let pixel = image.get_pixel(x as u32, source_y);
            let pixel = composite_pixel(*pixel, background_color);
            let (red, blue) = match options.channel_order {
                ChannelOrder::Rgb => (pixel[0], pixel[2]),
                ChannelOrder::Bgr => (pixel[2], pixel[0]),
            };
            let value = rgb565_pixel(red, pixel[1], blue);
            let bytes = match options.byte_order {
                ByteOrder::Little => value.to_le_bytes(),
                ByteOrder::Big => value.to_be_bytes(),
            };
            let offset = row_start + x * 2;
            output[offset..offset + 2].copy_from_slice(&bytes);
        }
    }
    Ok((output, 16))
}

pub(super) fn encode_c_array(
    raw_bytes: &[u8],
    width: u32,
    height: u32,
    name: &str,
) -> Result<(Vec<u8>, u16), String> {
    let name = sanitize_c_array_name(name);
    let macro_name = name.to_ascii_uppercase();
    let rows = raw_bytes.len().div_ceil(12);
    let estimated_size = raw_bytes
        .len()
        .checked_mul(6)
        .and_then(|size| size.checked_add(rows.saturating_mul(4)))
        .and_then(|size| size.checked_add(1024))
        .ok_or_else(|| "C array output is too large".to_string())?;
    ensure_output_size(estimated_size)?;
    let mut output = String::with_capacity(estimated_size);
    output.push_str("#ifndef ");
    output.push_str(&macro_name);
    output.push_str("_H\n#define ");
    output.push_str(&macro_name);
    output.push_str("_H\n\n#include <stdint.h>\n\n");
    output.push_str(&format!("#define {macro_name}_WIDTH {width}u\n"));
    output.push_str(&format!("#define {macro_name}_HEIGHT {height}u\n"));
    output.push_str(&format!(
        "#define {macro_name}_DATA_LENGTH {}u\n\n",
        raw_bytes.len()
    ));
    output.push_str("static const uint8_t ");
    output.push_str(&name);
    output.push_str("[] = {\n");
    for (index, byte) in raw_bytes.iter().enumerate() {
        if index % 12 == 0 {
            output.push_str("    ");
        }
        output.push_str(&format!("0x{byte:02X}"));
        if index + 1 != raw_bytes.len() {
            output.push(',');
        }
        if index % 12 == 11 || index + 1 == raw_bytes.len() {
            output.push('\n');
        } else {
            output.push(' ');
        }
    }
    output.push_str("};\n\n#endif /* ");
    output.push_str(&macro_name);
    output.push_str("_H */\n");

    let bytes = output.into_bytes();
    ensure_output_size(bytes.len())?;
    Ok((bytes, 16))
}

pub(super) fn default_c_array_name(source_file_name: &str) -> String {
    let base_name = source_file_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(source_file_name);
    let stem = std::path::Path::new(base_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    sanitize_c_array_name(stem)
}

pub(super) fn sanitize_c_array_name(value: &str) -> String {
    let mut name: String = value
        .chars()
        .filter(|character| !character.is_control())
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' {
                character
            } else {
                '_'
            }
        })
        .take(MAX_C_ARRAY_NAME_CHARS)
        .collect();
    if name.is_empty() {
        name.push_str("image_data");
    }
    if !name.as_bytes()[0].is_ascii_alphabetic() {
        name.insert_str(0, "image_");
    }
    if is_c_keyword(&name) {
        name.push_str("_data");
    }
    name
}

fn is_c_keyword(value: &str) -> bool {
    matches!(
        value,
        "auto"
            | "break"
            | "case"
            | "char"
            | "const"
            | "continue"
            | "default"
            | "do"
            | "double"
            | "else"
            | "enum"
            | "extern"
            | "float"
            | "for"
            | "goto"
            | "if"
            | "inline"
            | "int"
            | "long"
            | "register"
            | "restrict"
            | "return"
            | "short"
            | "signed"
            | "sizeof"
            | "static"
            | "struct"
            | "switch"
            | "typedef"
            | "union"
            | "unsigned"
            | "void"
            | "volatile"
            | "while"
    )
}

fn composite_pixel(mut pixel: Rgba<u8>, background: Rgba<u8>) -> Rgba<u8> {
    let alpha = u32::from(pixel[3]);
    for (index, channel) in pixel.0.iter_mut().take(3).enumerate() {
        *channel = ((u32::from(*channel) * alpha + u32::from(background[index]) * (255 - alpha))
            / 255) as u8;
    }
    pixel[3] = 255;
    pixel
}

fn rgb565_pixel(red: u8, green: u8, blue: u8) -> u16 {
    let red = (u16::from(red) * 31 + 127) / 255;
    let green = (u16::from(green) * 63 + 127) / 255;
    let blue = (u16::from(blue) * 31 + 127) / 255;
    (red << 11) | (green << 5) | blue
}

fn ensure_output_size(size: usize) -> Result<(), String> {
    if size > MAX_OUTPUT_BYTES {
        return Err(format!(
            "encoded output exceeds the {} MiB limit",
            MAX_OUTPUT_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_image() -> RgbaImage {
        let mut image = RgbaImage::new(2, 2);
        image.put_pixel(0, 0, Rgba([255, 0, 0, 255]));
        image.put_pixel(1, 0, Rgba([0, 255, 0, 255]));
        image.put_pixel(0, 1, Rgba([0, 0, 255, 255]));
        image.put_pixel(1, 1, Rgba([255, 255, 255, 255]));
        image
    }

    #[test]
    fn rgb565_golden_bytes_are_top_down_little_endian() {
        let options =
            RawOptions::parse(Some("little"), Some("rgb"), Some("top-down"), Some(2)).unwrap();
        let (bytes, depth) = encode_rgb565(&sample_image(), Rgba([0, 0, 0, 255]), options).unwrap();

        assert_eq!(depth, 16);
        assert_eq!(bytes, [0x00, 0xF8, 0xE0, 0x07, 0x1F, 0x00, 0xFF, 0xFF]);
    }

    #[test]
    fn rgb565_honors_channel_order_row_order_byte_order_and_alignment() {
        let options =
            RawOptions::parse(Some("big"), Some("bgr"), Some("bottom-up"), Some(4)).unwrap();
        let (bytes, _) = encode_rgb565(&sample_image(), Rgba([0, 0, 0, 255]), options).unwrap();

        assert_eq!(bytes, [0xF8, 0x00, 0xFF, 0xFF, 0x00, 0x1F, 0x07, 0xE0]);
    }

    #[test]
    fn rgb565_alignment_zero_fills_each_row() {
        let mut image = RgbaImage::new(1, 1);
        image.put_pixel(0, 0, Rgba([255, 0, 0, 255]));
        let options = RawOptions::parse(None, None, None, Some(4)).unwrap();
        let (bytes, _) = encode_rgb565(&image, Rgba([0, 0, 0, 255]), options).unwrap();

        assert_eq!(bytes, [0x00, 0xF8, 0x00, 0x00]);
    }

    #[test]
    fn c_array_is_a_guarded_independent_header() {
        let (bytes, depth) = encode_c_array(&[0x00, 0xF8, 0xE0, 0x07], 2, 1, "1 bad-name").unwrap();
        let header = String::from_utf8(bytes).unwrap();

        assert_eq!(depth, 16);
        assert!(header.contains("#ifndef IMAGE_1_BAD_NAME_H"));
        assert!(header.contains("#include <stdint.h>"));
        assert!(header.contains("#define IMAGE_1_BAD_NAME_WIDTH 2u"));
        assert!(header.contains("#define IMAGE_1_BAD_NAME_HEIGHT 1u"));
        assert!(header.contains("#define IMAGE_1_BAD_NAME_DATA_LENGTH 4u"));
        assert!(header.contains("static const uint8_t image_1_bad_name[]"));
        assert!(header.contains("0x00, 0xF8, 0xE0, 0x07"));
        assert!(header.ends_with("#endif /* IMAGE_1_BAD_NAME_H */\n"));
    }

    #[test]
    fn raw_options_reject_invalid_values() {
        assert!(RawOptions::parse(Some("middle"), None, None, None)
            .unwrap_err()
            .contains("byteOrder"));
        assert!(RawOptions::parse(None, Some("argb"), None, None)
            .unwrap_err()
            .contains("channelOrder"));
        assert!(RawOptions::parse(None, None, Some("left"), None)
            .unwrap_err()
            .contains("rowOrder"));
        assert!(RawOptions::parse(None, None, None, Some(8))
            .unwrap_err()
            .contains("rowAlignment"));
    }

    #[test]
    fn c_array_names_are_strictly_cleaned() {
        assert_eq!(sanitize_c_array_name("9 bad-name"), "image_9_bad_name");
        assert_eq!(sanitize_c_array_name("_private"), "image__private");
        assert_eq!(sanitize_c_array_name("static"), "static_data");
        assert_eq!(sanitize_c_array_name("屏幕图标"), "image_____");
        assert_eq!(default_c_array_name("folder/屏幕.png"), "image___");
    }
}
