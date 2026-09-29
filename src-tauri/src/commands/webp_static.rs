use std::{
    ffi::{c_int, c_void},
    ptr, slice,
};

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
pub(crate) fn encode_lossy_rgba_with_method(
    image: &RgbaImage,
    quality: u8,
    method: u8,
) -> Result<Vec<u8>, String> {
    encode_lossy_rgba_with_method_and_alpha_quality(image, quality, method, None, None)
}

pub(crate) fn encode_lossy_rgba_with_method_and_alpha_quality(
    image: &RgbaImage,
    quality: u8,
    method: u8,
    alpha_quality: Option<u8>,
    pass: Option<u8>,
) -> Result<Vec<u8>, String> {
    if !(1..=100).contains(&quality) {
        return Err("WebP quality must be between 1 and 100".into());
    }
    if method > 6 {
        return Err("WebP method must be between 0 and 6".into());
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

    let mut config = unsafe { std::mem::zeroed::<webp::WebPConfig>() };
    let initialized = unsafe {
        webp::WebPConfigPreset(&mut config, webp::WEBP_PRESET_DEFAULT, f32::from(quality))
    } != 0;
    if !initialized {
        return Err("libwebp failed to initialize WebP configuration".into());
    }
    config.method = c_int::from(method);
    if let Some(pass) = pass {
        if !(1..=10).contains(&pass) {
            return Err("WebP pass must be between 1 and 10".into());
        }
        config.pass = c_int::from(pass);
    }
    if let Some(alpha_quality) = alpha_quality {
        if alpha_quality > 100 {
            return Err("WebP alpha quality must be between 0 and 100".into());
        }
        config.alpha_quality = c_int::from(alpha_quality);
    }
    if unsafe { webp::WebPValidateConfig(&config) } == 0 {
        return Err("libwebp rejected the WebP method configuration".into());
    }

    let mut picture = unsafe { std::mem::zeroed::<webp::WebPPicture>() };
    if unsafe { webp::WebPPictureInit(&mut picture) } == 0 {
        return Err("libwebp failed to initialize WebP picture".into());
    }
    let mut writer = unsafe { std::mem::zeroed::<webp::WebPMemoryWriter>() };
    unsafe { webp::WebPMemoryWriterInit(&mut writer) };
    picture.width = width;
    picture.height = height;
    picture.writer = Some(write_to_memory);
    picture.custom_ptr = (&mut writer as *mut webp::WebPMemoryWriter).cast::<c_void>();

    let imported = unsafe {
        if opaque {
            webp::WebPPictureImportRGB(&mut picture, input, stride)
        } else {
            webp::WebPPictureImportRGBA(&mut picture, input, stride)
        }
    } != 0;
    let encoded = imported && unsafe { webp::WebPEncode(&config, &mut picture) } != 0;
    let bytes = if encoded && !writer.mem.is_null() {
        unsafe { slice::from_raw_parts(writer.mem, writer.size).to_vec() }
    } else {
        Vec::new()
    };
    unsafe {
        webp::WebPPictureFree(&mut picture);
        webp::WebPMemoryWriterClear(&mut writer);
    }
    if !encoded || bytes.is_empty() {
        return Err(
            "libwebp failed to encode a static WebP image with the requested method".into(),
        );
    }
    Ok(bytes)
}

pub(crate) fn encode_near_lossless_rgba(
    image: &RgbaImage,
    near_lossless: u8,
    method: u8,
) -> Result<Vec<u8>, String> {
    if !(1..=99).contains(&near_lossless) {
        return Err("WebP near-lossless level must be between 1 and 99".into());
    }
    if method > 6 {
        return Err("WebP method must be between 0 and 6".into());
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

    let mut config = unsafe { std::mem::zeroed::<webp::WebPConfig>() };
    let initialized =
        unsafe { webp::WebPConfigPreset(&mut config, webp::WEBP_PRESET_DEFAULT, 75.0) } != 0;
    if !initialized {
        return Err("libwebp failed to initialize WebP near-lossless configuration".into());
    }
    config.lossless = 1;
    config.near_lossless = c_int::from(near_lossless);
    config.method = c_int::from(method);
    config.exact = 1;
    if unsafe { webp::WebPValidateConfig(&config) } == 0 {
        return Err("libwebp rejected the WebP near-lossless configuration".into());
    }

    let mut picture = unsafe { std::mem::zeroed::<webp::WebPPicture>() };
    if unsafe { webp::WebPPictureInit(&mut picture) } == 0 {
        return Err("libwebp failed to initialize WebP near-lossless picture".into());
    }
    let mut writer = unsafe { std::mem::zeroed::<webp::WebPMemoryWriter>() };
    unsafe { webp::WebPMemoryWriterInit(&mut writer) };
    picture.width = width;
    picture.height = height;
    picture.writer = Some(write_to_memory);
    picture.custom_ptr = (&mut writer as *mut webp::WebPMemoryWriter).cast::<c_void>();

    let imported = unsafe {
        if opaque {
            webp::WebPPictureImportRGB(&mut picture, input, stride)
        } else {
            webp::WebPPictureImportRGBA(&mut picture, input, stride)
        }
    } != 0;
    let encoded = imported && unsafe { webp::WebPEncode(&config, &mut picture) } != 0;
    let bytes = if encoded && !writer.mem.is_null() {
        unsafe { slice::from_raw_parts(writer.mem, writer.size).to_vec() }
    } else {
        Vec::new()
    };
    unsafe {
        webp::WebPPictureFree(&mut picture);
        webp::WebPMemoryWriterClear(&mut writer);
    }
    if !encoded || bytes.is_empty() {
        return Err("libwebp failed to encode a near-lossless WebP image".into());
    }
    Ok(bytes)
}

extern "C" fn write_to_memory(
    data: *const u8,
    data_size: usize,
    picture: *const webp::WebPPicture,
) -> c_int {
    unsafe { webp::WebPMemoryWrite(data, data_size, picture) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEFAULT_WEBP_METHOD: u8 = 4;
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

    #[test]
    fn alpha_quality_changes_transparent_webp_and_remains_decodable() {
        let image = sample_image(true);
        let low =
            encode_lossy_rgba_with_method_and_alpha_quality(&image, 75, 4, Some(0), None).unwrap();
        let high = encode_lossy_rgba_with_method_and_alpha_quality(&image, 75, 4, Some(100), None)
            .unwrap();
        assert_ne!(low, high);
        assert_eq!(
            image::load_from_memory(&low).unwrap().dimensions(),
            (64, 48)
        );
        assert_eq!(
            image::load_from_memory(&high).unwrap().dimensions(),
            (64, 48)
        );
    }

    #[test]
    fn combined_alpha_quality_and_analysis_passes_change_decodable_webp() {
        let image = sample_image(true);
        let baseline =
            encode_lossy_rgba_with_method_and_alpha_quality(&image, 75, 4, Some(0), Some(1))
                .unwrap();
        let tuned =
            encode_lossy_rgba_with_method_and_alpha_quality(&image, 75, 4, Some(100), Some(1))
                .unwrap();
        assert_ne!(baseline, tuned);
        assert_eq!(
            image::load_from_memory(&baseline).unwrap().dimensions(),
            (64, 48)
        );
        assert_eq!(
            image::load_from_memory(&tuned).unwrap().dimensions(),
            (64, 48)
        );
    }

    #[test]
    fn analysis_pass_changes_output_and_remains_decodable() {
        let image = sample_image(true);
        let fast =
            encode_lossy_rgba_with_method_and_alpha_quality(&image, 75, 4, None, Some(1)).unwrap();
        let thorough =
            encode_lossy_rgba_with_method_and_alpha_quality(&image, 75, 4, None, Some(10)).unwrap();
        assert_eq!(
            image::load_from_memory(&fast).unwrap().dimensions(),
            (64, 48)
        );
        assert_eq!(
            image::load_from_memory(&thorough).unwrap().dimensions(),
            (64, 48)
        );
    }

    #[test]
    fn explicit_default_method_matches_the_existing_webp_path() {
        for image in [sample_image(false), sample_image(true)] {
            assert_eq!(
                encode_lossy_rgba(&image, 75).unwrap(),
                encode_lossy_rgba_with_method(&image, 75, DEFAULT_WEBP_METHOD).unwrap()
            );
        }
    }

    #[test]
    fn supported_methods_produce_decodable_static_webp() {
        let image = sample_image(true);
        for method in 0..=6 {
            let output = encode_lossy_rgba_with_method(&image, 75, method).unwrap();
            assert_eq!(
                image::load_from_memory(&output).unwrap().dimensions(),
                (64, 48)
            );
            assert!(chunk_types(&output)
                .iter()
                .all(|kind| kind != b"ANIM" && kind != b"ANMF"));
        }
    }

    #[test]
    fn lossy_method_outputs_are_deterministic_and_observable() {
        let image = sample_image(false);
        let outputs = (0..=6)
            .map(|method| encode_lossy_rgba_with_method(&image, 75, method).unwrap())
            .collect::<Vec<_>>();
        for method in 0..=6 {
            assert_eq!(
                outputs[method as usize],
                encode_lossy_rgba_with_method(&image, 75, method).unwrap()
            );
        }
        assert!(outputs.windows(2).any(|pair| pair[0] != pair[1]));
    }

    #[test]
    fn rejects_webp_methods_outside_the_supported_range() {
        assert!(encode_lossy_rgba_with_method(&sample_image(false), 75, 7).is_err());
    }

    #[test]
    fn near_lossless_webp_is_decodable_and_preserves_alpha() {
        let source = sample_image(true);
        let output = encode_near_lossless_rgba(&source, 90, DEFAULT_WEBP_METHOD).unwrap();
        let decoded = image::load_from_memory(&output).unwrap().to_rgba8();
        assert_eq!(decoded.dimensions(), source.dimensions());
        for (actual, expected) in decoded.pixels().zip(source.pixels()) {
            assert_eq!(actual[3], expected[3]);
        }
        assert!(chunk_types(&output)
            .iter()
            .all(|kind| kind != b"ANIM" && kind != b"ANMF"));
    }

    #[test]
    fn rejects_invalid_near_lossless_levels() {
        let source = sample_image(false);
        assert!(encode_near_lossless_rgba(&source, 0, DEFAULT_WEBP_METHOD).is_err());
        assert!(encode_near_lossless_rgba(&source, 100, DEFAULT_WEBP_METHOD).is_err());
        assert!(encode_near_lossless_rgba(&source, 90, 7).is_err());
    }

    #[test]
    fn explicit_method_preserves_alpha_plane() {
        let source = sample_image(true);
        for method in 0..=6 {
            let output = encode_lossy_rgba_with_method(&source, 75, method).unwrap();
            let decoded = image::load_from_memory(&output).unwrap().to_rgba8();
            assert_eq!(decoded.dimensions(), source.dimensions());
            for (actual, expected) in decoded.pixels().zip(source.pixels()) {
                assert_eq!(actual[3], expected[3]);
            }
        }
    }
}
