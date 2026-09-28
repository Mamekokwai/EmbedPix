use std::io::Cursor;

use exif::{In, Reader, Tag};
use image::{imageops, DynamicImage, ImageFormat};

pub(crate) fn normalize_jpeg_orientation(input: &[u8], image: DynamicImage) -> DynamicImage {
    let Some(orientation) = read_jpeg_orientation(input) else {
        return image;
    };

    let image = image.to_rgba8();
    let image = match orientation {
        2 => imageops::flip_horizontal(&image),
        3 => imageops::rotate180(&image),
        4 => imageops::flip_vertical(&image),
        5 => imageops::rotate270(&imageops::flip_horizontal(&image)),
        6 => imageops::rotate90(&image),
        7 => imageops::rotate90(&imageops::flip_horizontal(&image)),
        8 => imageops::rotate270(&image),
        _ => return DynamicImage::ImageRgba8(image),
    };
    DynamicImage::ImageRgba8(image)
}

fn read_jpeg_orientation(input: &[u8]) -> Option<u16> {
    if !matches!(image::guess_format(input), Ok(ImageFormat::Jpeg)) {
        return None;
    }

    let exif = Reader::new()
        .read_from_container(&mut Cursor::new(input))
        .ok()?;
    let value = exif
        .get_field(Tag::Orientation, In::PRIMARY)?
        .value
        .get_uint(0)?;
    (1..=8).contains(&value).then_some(value as u16)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, ImageBuffer, Rgba};

    fn exif_jpeg_marker(orientation: u16) -> Vec<u8> {
        let mut payload = Vec::from(*b"Exif\0\0II*\0\x08\0\0\0\x01\0");
        payload.extend_from_slice(&0x0112_u16.to_le_bytes());
        payload.extend_from_slice(&3_u16.to_le_bytes());
        payload.extend_from_slice(&1_u32.to_le_bytes());
        payload.extend_from_slice(&orientation.to_le_bytes());
        payload.extend_from_slice(&0_u16.to_le_bytes());
        payload.extend_from_slice(&0_u32.to_le_bytes());

        let length = u16::try_from(payload.len() + 2).unwrap();
        let mut marker = Vec::from([0xff, 0xe1]);
        marker.extend_from_slice(&length.to_be_bytes());
        marker.extend_from_slice(&payload);
        marker
    }

    fn fixture_for_orientation(orientation: u16) -> Vec<u8> {
        let mut fixture = Vec::from([0xff, 0xd8]);
        fixture.extend_from_slice(&exif_jpeg_marker(orientation));
        fixture.extend_from_slice(&[0xff, 0xd9]);
        fixture
    }

    #[test]
    fn applies_all_exif_orientation_transforms() {
        let image = DynamicImage::ImageRgba8(
            ImageBuffer::from_raw(
                2,
                3,
                vec![
                    1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255, 5, 0, 0, 255, 6, 0, 0,
                    255,
                ],
            )
            .unwrap(),
        );

        let expected = [
            vec![1, 2, 3, 4, 5, 6],
            vec![2, 1, 4, 3, 6, 5],
            vec![6, 5, 4, 3, 2, 1],
            vec![5, 6, 3, 4, 1, 2],
            vec![1, 3, 5, 2, 4, 6],
            vec![5, 3, 1, 6, 4, 2],
            vec![6, 4, 2, 5, 3, 1],
            vec![2, 4, 6, 1, 3, 5],
        ];

        for (index, expected_red) in expected.into_iter().enumerate() {
            let output = normalize_jpeg_orientation(
                &fixture_for_orientation((index + 1) as u16),
                image.clone(),
            )
            .to_rgba8();
            let actual_red = output.pixels().map(|pixel| pixel[0]).collect::<Vec<_>>();
            assert_eq!(actual_red, expected_red, "orientation {}", index + 1);
        }
    }

    #[test]
    fn ignores_missing_or_invalid_orientation() {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(2, 3, Rgba([1, 2, 3, 255])));
        assert_eq!(
            normalize_jpeg_orientation(b"not a jpeg", image.clone()).dimensions(),
            (2, 3)
        );
        assert_eq!(
            normalize_jpeg_orientation(&fixture_for_orientation(0), image).dimensions(),
            (2, 3)
        );
    }
}
