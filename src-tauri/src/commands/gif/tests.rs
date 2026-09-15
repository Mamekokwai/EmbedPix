use super::*;
use image::{
    codecs::gif::GifDecoder, AnimationDecoder, DynamicImage, ImageOutputFormat, Rgba, RgbaImage,
};
use std::{
    fs, io,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Barrier,
    },
};

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        loop {
            let path = std::env::temp_dir().join(format!(
                "embedpix-gif-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("{error}"),
            }
        }
    }

    fn output(&self) -> PathBuf {
        self.0.join("动画.GIF")
    }

    fn assert_files(&self, count: usize) {
        assert_eq!(fs::read_dir(&self.0).unwrap().count(), count);
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        assert!(self
            .0
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("embedpix-gif-test-"));
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn encoded_image(image: RgbaImage, format: ImageOutputFormat) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, format)
        .unwrap();
    bytes.into_inner()
}

fn frame(color: [u8; 4], duration_ms: u32) -> GifFrameRequest {
    GifFrameRequest {
        data: encoded_image(
            RgbaImage::from_pixel(2, 1, Rgba(color)),
            ImageOutputFormat::Png,
        ),
        duration_ms,
    }
}

fn request(path: &Path) -> GifExportRequest {
    GifExportRequest {
        output_path: path.to_string_lossy().into_owned(),
        width: 3,
        height: 2,
        loop_mode: "infinite".into(),
        loop_count: 0,
        overwrite_existing: false,
        frames: vec![
            frame([255, 0, 0, 255], 19),
            frame([0, 255, 0, 255], 25),
            frame([0, 0, 255, 255], 60_000),
        ],
    }
}

fn decode(data: &[u8]) -> Vec<Frame> {
    GifDecoder::new(Cursor::new(data))
        .unwrap()
        .into_frames()
        .collect_frames()
        .unwrap()
}

fn read_loop_and_trailer(data: &[u8]) -> u16 {
    assert_eq!(&data[..6], b"GIF89a");
    let mut offset = 13;
    if data[10] & 0x80 != 0 {
        offset += 3 * (1 << ((data[10] & 7) + 1));
    }
    let mut repeats = None;
    loop {
        let marker = data[offset];
        offset += 1;
        match marker {
            0x21 => {
                let label = data[offset];
                offset += 1;
                if label == 0xff
                    && data[offset] == 11
                    && &data[offset + 1..offset + 12] == b"NETSCAPE2.0"
                {
                    assert_eq!(&data[offset + 12..offset + 14], &[3, 1]);
                    repeats = Some(u16::from_le_bytes([data[offset + 14], data[offset + 15]]));
                }
            }
            0x2c => {
                let flags = data[offset + 8];
                offset += 9;
                if flags & 0x80 != 0 {
                    offset += 3 * (1 << ((flags & 7) + 1));
                }
                offset += 1;
            }
            0x3b => {
                assert_eq!(offset, data.len());
                return repeats.unwrap();
            }
            other => panic!("unexpected GIF block {other:x}"),
        }
        loop {
            let length = data[offset] as usize;
            offset += 1;
            if length == 0 {
                break;
            }
            offset += length;
        }
    }
}

#[test]
fn round_trip_preserves_order_canvas_quantized_delays_and_loop_extension() {
    let dir = TestDirectory::new();
    for (mode, count) in [("infinite", 0), ("finite", 1), ("finite", u16::MAX)] {
        let mut req = request(&dir.output());
        req.loop_mode = mode.into();
        req.loop_count = count;
        req.overwrite_existing = true;
        export_gif_blocking(req).unwrap();
        let data = fs::read(dir.output()).unwrap();
        assert_eq!(read_loop_and_trailer(&data), count);
        let frames = decode(&data);
        assert_eq!(frames.len(), 3);
        for (index, frame) in frames.iter().enumerate() {
            assert_eq!(frame.buffer().dimensions(), (3, 2));
            assert_eq!(frame.delay().numer_denom_ms(), ([10, 20, 60_000][index], 1));
            let expected = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]][index];
            assert!(frame.buffer().pixels().all(|pixel| pixel.0 == expected));
        }
        dir.assert_files(1);
    }
}

#[test]
fn transparent_frame_clears_previous_pixels() {
    let dir = TestDirectory::new();
    let mut req = request(&dir.output());
    req.width = 2;
    req.height = 1;
    let mut transparent = RgbaImage::new(2, 1);
    transparent.put_pixel(1, 0, Rgba([0, 0, 255, 255]));
    req.frames.truncate(1);
    req.frames.push(GifFrameRequest {
        data: encoded_image(transparent, ImageOutputFormat::Png),
        duration_ms: 100,
    });
    export_gif_blocking(req).unwrap();
    let frames = decode(&fs::read(dir.output()).unwrap());
    assert_eq!(frames[1].buffer().get_pixel(0, 0)[3], 0);
    assert_eq!(frames[1].buffer().get_pixel(1, 0).0, [0, 0, 255, 255]);
}

#[test]
fn accepts_real_png_jpeg_bmp_gif_and_static_webp_frames() {
    let dir = TestDirectory::new();
    let mut req = request(&dir.output());
    req.frames = [
        ImageOutputFormat::Png,
        ImageOutputFormat::Jpeg(95),
        ImageOutputFormat::Bmp,
        ImageOutputFormat::Gif,
        ImageOutputFormat::WebP,
    ]
    .into_iter()
    .map(|format| GifFrameRequest {
        data: encoded_image(RgbaImage::from_pixel(2, 1, Rgba([255, 0, 0, 255])), format),
        duration_ms: 100,
    })
    .collect();
    export_gif_blocking(req).unwrap();
    assert_eq!(decode(&fs::read(dir.output()).unwrap()).len(), 5);
}

#[test]
fn default_overwrite_refuses_existing_file_and_explicit_overwrite_succeeds() {
    let dir = TestDirectory::new();
    fs::write(dir.output(), b"old file").unwrap();
    let req = request(&dir.output());
    assert!(export_gif_blocking(req).unwrap_err().contains("已存在"));
    assert_eq!(fs::read(dir.output()).unwrap(), b"old file");
    let mut req = request(&dir.output());
    req.overwrite_existing = true;
    export_gif_blocking(req).unwrap();
    assert_eq!(decode(&fs::read(dir.output()).unwrap()).len(), 3);
    dir.assert_files(1);
}

#[test]
fn damaged_later_frame_leaves_no_output_and_preserves_old_file() {
    for existing in [false, true] {
        let dir = TestDirectory::new();
        if existing {
            fs::write(dir.output(), b"old file").unwrap();
        }
        let mut req = request(&dir.output());
        req.overwrite_existing = true;
        let mut damaged = encoded_image(RgbaImage::new(2, 1), ImageOutputFormat::Bmp);
        damaged.truncate(54);
        req.frames[1].data = damaged;
        assert!(export_gif_blocking(req)
            .unwrap_err()
            .contains("无法读取 GIF 帧"));
        if existing {
            assert_eq!(fs::read(dir.output()).unwrap(), b"old file");
        }
        dir.assert_files(usize::from(existing));
    }
}

struct FailingWriter<W> {
    inner: W,
    remaining: usize,
    zero: bool,
    flush_error: bool,
}

impl<W: Write> Write for FailingWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return if self.zero {
                Ok(0)
            } else {
                Err(io::Error::other("injected write failure"))
            };
        }
        let count = self
            .inner
            .write(&bytes[..bytes.len().min(self.remaining)])?;
        self.remaining -= count;
        Ok(count)
    }
    fn flush(&mut self) -> io::Result<()> {
        if self.flush_error {
            Err(io::Error::other("injected flush failure"))
        } else {
            self.inner.flush()
        }
    }
}

#[test]
fn write_trailer_write_zero_and_flush_errors_never_publish() {
    for existing in [false, true] {
        let dir = TestDirectory::new();
        if existing {
            fs::write(dir.output(), b"old file").unwrap();
        }
        let req = request(&dir.output());
        let mut complete = Vec::new();
        encode_gif(&mut complete, &req).unwrap();
        read_loop_and_trailer(&complete);
        for (remaining, zero, flush_error) in [
            (20, false, false),
            (complete.len() - 1, false, false),
            (complete.len() - 1, true, false),
            (usize::MAX, false, true),
        ] {
            let result = storage::write_output(&dir.output(), true, |file| {
                encode_gif(
                    FailingWriter {
                        inner: file,
                        remaining,
                        zero,
                        flush_error,
                    },
                    &req,
                )
            });
            assert!(result.is_err());
            if existing {
                assert_eq!(fs::read(dir.output()).unwrap(), b"old file");
            }
            dir.assert_files(usize::from(existing));
        }
    }
}

#[test]
fn colliding_temporary_file_is_not_removed() {
    let dir = TestDirectory::new();
    let other = dir
        .0
        .join(format!(".embedpix-gif-{}-0.tmp", std::process::id()));
    fs::write(&other, b"another export").unwrap();
    assert!(storage::write_output(&dir.output(), false, |_| Err("fail".into())).is_err());
    assert_eq!(fs::read(other).unwrap(), b"another export");
    dir.assert_files(1);
}

#[test]
fn concurrent_create_new_exports_have_exactly_one_winner() {
    let dir = TestDirectory::new();
    let barrier = Arc::new(Barrier::new(2));
    let workers: Vec<_> = (0..2)
        .map(|index| {
            let barrier = Arc::clone(&barrier);
            let path = dir.output();
            std::thread::spawn(move || {
                storage::write_output(&path, false, |file| {
                    file.write_all(&[index]).unwrap();
                    barrier.wait();
                    Ok(())
                })
            })
        })
        .collect();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(fs::read(dir.output()).unwrap().len(), 1);
    dir.assert_files(1);
}

#[cfg(windows)]
#[test]
fn windows_replace_failure_preserves_old_file_and_cleans_temporary() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = TestDirectory::new();
    fs::write(dir.output(), b"old file").unwrap();
    let _locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(dir.output())
        .unwrap();
    let mut req = request(&dir.output());
    req.overwrite_existing = true;
    assert!(export_gif_blocking(req).unwrap_err().contains("无法保存"));
    assert_eq!(fs::read(dir.output()).unwrap(), b"old file");
    dir.assert_files(1);
}

#[test]
fn rejects_output_extension_invalid_durations_loop_and_canvas_limits() {
    let dir = TestDirectory::new();
    for duration in [0, 9, 60_001, u32::MAX] {
        let mut req = request(&dir.output());
        req.frames[0].duration_ms = duration;
        assert!(export_gif_blocking(req).unwrap_err().contains("帧时长"));
    }
    for size in [(0, 1), (4097, 1), (1, 4097)] {
        let mut req = request(&dir.output());
        req.width = size.0;
        req.height = size.1;
        assert!(export_gif_blocking(req).unwrap_err().contains("画布尺寸"));
    }
    let mut req = request(&dir.output());
    req.output_path = dir.0.join("bad.png").to_string_lossy().into_owned();
    assert!(export_gif_blocking(req).unwrap_err().contains(".gif"));
    let mut req = request(&dir.output());
    req.loop_mode = "finite".into();
    assert!(export_gif_blocking(req).unwrap_err().contains("大于 0"));
    let mut req = request(&dir.output());
    req.loop_mode = "invalid".into();
    assert!(export_gif_blocking(req).unwrap_err().contains("循环模式"));
    let mut req = request(&dir.output());
    req.width = 4096;
    req.height = 4096;
    req.frames = (0..5).map(|_| frame([0; 4], 10)).collect();
    assert!(export_gif_blocking(req)
        .unwrap_err()
        .contains("累计画布像素"));
    dir.assert_files(0);
}

#[test]
fn rejects_oversized_source_and_cumulative_source_pixels_before_decoding() {
    let dir = TestDirectory::new();
    let mut bmp = encoded_image(RgbaImage::new(1, 1), ImageOutputFormat::Bmp);
    bmp[18..22].copy_from_slice(&4096u32.to_le_bytes());
    bmp[22..26].copy_from_slice(&4096u32.to_le_bytes());
    let mut req = request(&dir.output());
    req.frames = (0..5)
        .map(|_| GifFrameRequest {
            data: bmp.clone(),
            duration_ms: 10,
        })
        .collect();
    assert!(export_gif_blocking(req)
        .unwrap_err()
        .contains("累计源图片像素"));
    bmp[18..22].copy_from_slice(&4097u32.to_le_bytes());
    let mut req = request(&dir.output());
    req.frames[0].data = bmp;
    assert!(export_gif_blocking(req)
        .unwrap_err()
        .contains("帧尺寸超出限制"));
    dir.assert_files(0);
}

#[test]
fn decoder_allocation_budget_is_enforced() {
    let data = frame([0; 4], 10).data;
    let mut reader = ImageReader::with_format(Cursor::new(data), ImageFormat::Png);
    let mut limits = decode_limits();
    limits.max_alloc = Some(1);
    reader.limits(limits);
    assert!(matches!(reader.decode(), Err(image::ImageError::Limits(_))));
}

#[test]
fn rejects_webp_huge_dimensions_and_animation_before_decoder_construction() {
    let mut data = encoded_image(RgbaImage::new(1, 1), ImageOutputFormat::WebP);
    assert_eq!(&data[12..16], b"VP8L");
    data[21..25].copy_from_slice(&(4096u32 | (4096 << 14)).to_le_bytes());
    assert!(webp::inspect_dimensions(&data)
        .unwrap_err()
        .contains("帧尺寸"));
    let mut animated = b"RIFF\x16\0\0\0WEBPVP8X\x0a\0\0\0".to_vec();
    animated.extend_from_slice(&[2, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert!(webp::inspect_dimensions(&animated)
        .unwrap_err()
        .contains("动画 WebP"));
}

#[test]
fn camel_case_request_defaults_to_no_overwrite_and_normalizes_suggested_name() {
    let req: GifExportRequest = serde_json::from_value(serde_json::json!({
        "outputPath": "test.gif", "width": 1, "height": 1, "loopMode": "infinite", "loopCount": 0,
        "frames": [{ "data": [1, 2], "durationMs": 10 }]
    }))
    .unwrap();
    assert!(!req.overwrite_existing);
    assert_eq!(req.frames[0].duration_ms, 10);
    assert_eq!(normalize_suggested_name(""), "animation.gif");
    assert_eq!(normalize_suggested_name("picture"), "picture.gif");
    assert_eq!(normalize_suggested_name(" picture.GIF "), "picture.GIF");
}
