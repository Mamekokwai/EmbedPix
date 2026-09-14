use image::{Rgba, RgbaImage};

use super::{composite_over_background, validate_dimensions};

pub(super) fn validate_bit_depth(bit_depth: u16) -> Result<(), String> {
    if matches!(bit_depth, 1 | 4 | 8 | 16 | 24 | 32) {
        return Ok(());
    }

    Err(format!(
        "{}-bit bmp output is not supported; supported bit depths are 1, 4, 8, 16, 24, or 32",
        bit_depth
    ))
}

pub(super) fn encode(
    image: &RgbaImage,
    bit_depth: u16,
    background_color: Rgba<u8>,
) -> Result<(Vec<u8>, u16), String> {
    validate_bit_depth(bit_depth)?;
    validate_dimensions(image.width(), image.height())?;
    let width = i32::try_from(image.width()).map_err(|_| "BMP width is too large".to_string())?;
    let height =
        i32::try_from(image.height()).map_err(|_| "BMP height is too large".to_string())?;
    let image = if bit_depth <= 24 {
        composite_over_background(image.clone(), background_color)
    } else {
        image.clone()
    };
    let palette = palette(bit_depth);
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
                    let index = palette_index(pixel, &palette);
                    if index != 0 {
                        output[row_start + x / 8] |= 1 << (7 - (x % 8));
                    }
                }
                4 => {
                    let index = palette_index(pixel, &palette);
                    let byte = &mut output[row_start + x / 2];
                    if x.is_multiple_of(2) {
                        *byte |= index << 4;
                    } else {
                        *byte |= index;
                    }
                }
                8 => {
                    output[row_start + x] = palette_index(pixel, &palette);
                }
                16 => {
                    let value = rgb565_pixel(pixel);
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

fn palette(bit_depth: u16) -> Vec<[u8; 3]> {
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

fn palette_index(pixel: &Rgba<u8>, palette: &[[u8; 3]]) -> u8 {
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

fn rgb565_pixel(pixel: &Rgba<u8>) -> u16 {
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
        let (bytes, bit_depth) = encode(&sample_image(), 24, Rgba([255, 255, 255, 255])).unwrap();

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

        let (bytes, _) = encode(&image, 24, Rgba([0, 255, 0, 255])).unwrap();

        assert_eq!(&bytes[54..58], &[0, 255, 0, 0]);
    }

    #[test]
    fn bmp_32_uses_bgra_bitfields_and_matching_pixel_layout() {
        let (bytes, bit_depth) = encode(&sample_image(), 32, Rgba([255, 255, 255, 255])).unwrap();

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
                encode(&sample_image(), bit_depth, Rgba([255, 255, 255, 255])).unwrap();
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

        let (bytes, _) = encode(&image, 1, Rgba([0, 0, 0, 255])).unwrap();

        assert_eq!(&bytes[62..66], &[0, 128, 0, 0]);
    }

    #[test]
    fn bmp_4_bit_palette_and_nibbles_are_encoded_in_order() {
        let mut image = RgbaImage::new(2, 1);
        image.put_pixel(0, 0, Rgba([0, 0, 0, 255]));
        image.put_pixel(1, 0, Rgba([255, 255, 255, 255]));

        let (bytes, _) = encode(&image, 4, Rgba([0, 0, 0, 255])).unwrap();

        assert_eq!(u32::from_le_bytes(bytes[10..14].try_into().unwrap()), 118);
        assert_eq!(&bytes[54..58], &[0, 0, 0, 0]);
        assert_eq!(&bytes[58..62], &[17, 17, 17, 0]);
        assert_eq!(&bytes[118..122], &[0x0F, 0, 0, 0]);
    }

    #[test]
    fn bmp_8_bit_palette_and_rgb332_indices_are_encoded() {
        let (bytes, _) = encode(&sample_image(), 8, Rgba([255, 255, 255, 255])).unwrap();
        let pixel_offset = u32::from_le_bytes(bytes[10..14].try_into().unwrap()) as usize;
        let red_palette_offset = 54 + 224 * 4;
        let green_palette_offset = 54 + 28 * 4;

        assert_eq!(bytes.len(), pixel_offset + 4);
        assert_eq!(&bytes[54..58], &[0, 0, 0, 0]);
        assert_eq!(
            &bytes[red_palette_offset..red_palette_offset + 4],
            &[0, 0, 255, 0]
        );
        assert_eq!(
            &bytes[green_palette_offset..green_palette_offset + 4],
            &[0, 255, 0, 0]
        );
        assert_eq!(&bytes[pixel_offset..], &[224, 28, 0, 0]);
    }

    #[test]
    fn bmp_16_bit_pixels_use_rgb565_masks_and_values() {
        let (bytes, _) = encode(&sample_image(), 16, Rgba([255, 255, 255, 255])).unwrap();
        let pixel_offset = u32::from_le_bytes(bytes[10..14].try_into().unwrap()) as usize;

        assert_eq!(&bytes[54..66], &[0, 248, 0, 0, 224, 7, 0, 0, 31, 0, 0, 0]);
        assert_eq!(&bytes[pixel_offset..pixel_offset + 4], &[0, 248, 224, 7]);
    }

    #[test]
    fn bmp_24_bit_row_padding_is_zeroed() {
        let mut image = RgbaImage::new(1, 1);
        image.put_pixel(0, 0, Rgba([1, 2, 3, 255]));

        let (bytes, _) = encode(&image, 24, Rgba([0, 0, 0, 255])).unwrap();

        assert_eq!(u32::from_le_bytes(bytes[34..38].try_into().unwrap()), 4);
        assert_eq!(&bytes[54..58], &[3, 2, 1, 0]);
    }
}
