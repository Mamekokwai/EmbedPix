use std::{ffi::c_void, ptr, slice};

use image::RgbaImage;
use libwebp_sys as webp;

pub(crate) fn encode_lossy_rgba(image: &RgbaImage, quality: u8) -> Result<Vec<u8>, String> {
    if !(1..=100).contains(&quality) {
        return Err("WebP quality must be between 1 and 100".into());
    }

    let width = i32::try_from(image.width()).map_err(|_| "WebP width is too large")?;
    let height = i32::try_from(image.height()).map_err(|_| "WebP height is too large")?;
    let pixels = image.as_raw();
    let opaque = pixels.chunks_exact(4).all(|pixel| pixel[3] == 255);
    let rgb_pixels = opaque.then(|| {
        pixels
            .chunks_exact(4)
            .flat_map(|pixel| [pixel[0], pixel[1], pixel[2]])
            .collect::<Vec<_>>()
    });
    let (input, stride) = if let Some(rgb_pixels) = rgb_pixels.as_deref() {
        (
            rgb_pixels.as_ptr(),
            width
                .checked_mul(3)
                .ok_or_else(|| "WebP RGB stride is too large".to_string())?,
        )
    } else {
        (
            pixels.as_ptr(),
            width
                .checked_mul(4)
                .ok_or_else(|| "WebP RGBA stride is too large".to_string())?,
        )
    };
    let mut output = ptr::null_mut();
    let size = unsafe {
        if opaque {
            webp::WebPEncodeRGB(
                input,
                width,
                height,
                stride,
                f32::from(quality),
                &mut output,
            )
        } else {
            webp::WebPEncodeRGBA(
                input,
                width,
                height,
                stride,
                f32::from(quality),
                &mut output,
            )
        }
    };

    if size == 0 || output.is_null() {
        if !output.is_null() {
            unsafe { webp::WebPFree(output.cast::<c_void>()) };
        }
        return Err("libwebp failed to encode a static WebP image".into());
    }

    let bytes = unsafe { slice::from_raw_parts(output, size).to_vec() };
    unsafe { webp::WebPFree(output.cast::<c_void>()) };
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, GenericImageView, ImageBuffer, Rgba};

    fn sample_image(alpha: bool) -> RgbaImage {
        ImageBuffer::from_fn(64, 48, |x, y| {
            Rgba([
                (x.wrapping_mul(17) ^ y.wrapping_mul(11)) as u8,
                (x.wrapping_mul(7) ^ y.wrapping_mul(29)) as u8,
                (x.wrapping_mul(31) ^ y.wrapping_mul(3)) as u8,
                if alpha && x < 32 { 96 } else { 255 },
            ])
        })
    }

    fn chunk_types(bytes: &[u8]) -> Vec<[u8; 4]> {
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WEBP");
        let mut offset = 12;
        let mut chunks = Vec::new();
        while offset + 8 <= bytes.len() {
            let kind = bytes[offset..offset + 4].try_into().unwrap();
            let size =
                u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
            let end = offset.checked_add(8 + size).unwrap();
            assert!(end <= bytes.len());
            chunks.push(kind);
            offset = end + (size & 1);
        }
        assert_eq!(offset, bytes.len());
        chunks
    }

    #[test]
    fn encodes_static_lossy_webp_with_quality_and_no_animation_chunks() {
        let image = sample_image(false);
        let low = encode_lossy_rgba(&image, 25).unwrap();
        let high = encode_lossy_rgba(&image, 90).unwrap();
        assert_ne!(low, high);
        assert!(chunk_types(&low)
            .iter()
            .all(|kind| kind != b"ANIM" && kind != b"ANMF"));
        assert!(chunk_types(&high)
            .iter()
            .all(|kind| kind != b"ANIM" && kind != b"ANMF"));
        assert!(matches!(
            image::guess_format(&low),
            Ok(image::ImageFormat::WebP)
        ));
        assert_eq!(
            DynamicImage::ImageRgba8(image.clone()).dimensions(),
            (64, 48)
        );
        assert_eq!(
            image::load_from_memory(&low).unwrap().dimensions(),
            (64, 48)
        );
        let opaque_reference = ImageBuffer::from_fn(64, 48, |x, y| {
            Rgba([
                32u8.saturating_add((x / 2) as u8),
                48u8.saturating_add((y / 2) as u8),
                96u8.saturating_add(((x + y) / 4) as u8),
                255,
            ])
        });
        let reference_output = encode_lossy_rgba(&opaque_reference, 90).unwrap();
        let decoded = image::load_from_memory(&reference_output)
            .unwrap()
            .to_rgba8();
        assert!(decoded.pixels().all(|pixel| pixel[3] == 255));
        let source = opaque_reference.get_pixel(17, 23);
        let actual = decoded.get_pixel(17, 23);
        for channel in 0..3 {
            assert!((i16::from(source[channel]) - i16::from(actual[channel])).abs() <= 16);
        }
    }

    #[test]
    fn preserves_alpha_plane_for_lossy_webp() {
        let image = sample_image(true);
        let output = encode_lossy_rgba(&image, 75).unwrap();
        let decoded = image::load_from_memory(&output).unwrap().to_rgba8();
        for (source, actual) in image.pixels().zip(decoded.pixels()) {
            assert_eq!(actual[3], source[3]);
        }
    }
}
