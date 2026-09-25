use super::*;
use image::{
    codecs::gif::GifDecoder, AnimationDecoder, DynamicImage, Frame, ImageOutputFormat, Rgba,
    RgbaImage,
};
use std::{
    collections::HashSet,
    fs, io,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Barrier,
    },
    time::Duration,
};

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        loop {
            let path = crate::commands::test_temp_dir().join(format!(
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
        assert_eq!(
            self.0.parent(),
            Some(crate::commands::test_temp_dir().as_path())
        );
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
        output_location: None,
        source_path: None,
        output_subdirectory: None,
        output_directory: None,
        file_name: None,
        width: 3,
        height: 2,
        loop_mode: "infinite".into(),
        loop_count: 0,
        encoding_speed: 1,
        color_count: 256,
        dither_mode: "none".into(),
        spool_id: None,
        spool_durations: Vec::new(),
        overwrite_existing: false,
        job_id: None,
        target_bytes: None,
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
fn all_supported_color_counts_encode_decodable_gifs_with_each_dither_mode() {
    let dir = TestDirectory::new();
    for color_count in [2, 16, 32, 64, 128, 256] {
        for dither_mode in ["none", "floydSteinberg", "atkinson"] {
            let mut req = request(&dir.output());
            req.width = 4;
            req.height = 1;
            req.frames = (0..3).map(|_| colorful_frame(100)).collect();
            req.color_count = color_count;
            req.dither_mode = dither_mode.into();
            req.overwrite_existing = true;
            export_gif_blocking(req).unwrap();
            let decoded = decode(&fs::read(dir.output()).unwrap());
            assert_eq!(decoded.len(), 3);
            for frame in decoded {
                let colors = frame
                    .buffer()
                    .pixels()
                    .map(|pixel| pixel.0)
                    .collect::<HashSet<_>>();
                assert!(colors.len() <= usize::from(color_count));
            }
        }
    }
    dir.assert_files(1);
}

#[test]
fn resolves_source_subfolder_and_directory_output_locations_safely() {
    let dir = TestDirectory::new();
    let source = dir.0.join("source.png");
    fs::write(&source, b"source marker").unwrap();

    let mut req = request(&dir.output());
    req.output_path.clear();
    req.output_location = Some("source".into());
    req.source_path = Some(source.to_string_lossy().into_owned());
    assert_eq!(resolve_output_path(&req).unwrap(), dir.0.join("source.gif"));

    req.output_location = Some("subfolder".into());
    req.output_subdirectory = Some("exports".into());
    req.file_name = Some("custom".into());
    assert_eq!(
        resolve_output_path(&req).unwrap(),
        dir.0.join("exports").join("custom.gif")
    );

    req.output_location = Some("directory".into());
    req.output_directory = Some(dir.0.to_string_lossy().into_owned());
    req.output_subdirectory = None;
    req.file_name = Some("named.GIF".into());
    assert_eq!(resolve_output_path(&req).unwrap(), dir.0.join("named.GIF"));
}

#[test]
fn exports_gif_to_a_source_subfolder_with_a_safe_file_name() {
    let dir = TestDirectory::new();
    let source = dir.0.join("source.png");
    fs::write(&source, b"source marker").unwrap();
    let mut req = request(&dir.output());
    req.output_path.clear();
    req.output_location = Some("subfolder".into());
    req.source_path = Some(source.to_string_lossy().into_owned());
    req.output_subdirectory = Some("exports".into());
    req.file_name = Some("animation".into());

    let output = export_gif_blocking(req).unwrap();
    assert_eq!(
        PathBuf::from(output),
        dir.0.join("exports").join("animation.gif")
    );
    assert_eq!(
        decode(&fs::read(dir.0.join("exports/animation.gif")).unwrap()).len(),
        3
    );
}

#[test]
fn rejects_unsafe_gif_output_location_inputs() {
    let dir = TestDirectory::new();
    let source = dir.0.join("source.png");
    fs::write(&source, b"source marker").unwrap();
    let mut req = request(&dir.output());
    req.output_path.clear();
    req.output_location = Some("subfolder".into());
    req.source_path = Some(source.to_string_lossy().into_owned());

    for subdirectory in ["..", ".", "nested\\folder", "nested/folder"] {
        req.output_subdirectory = Some(subdirectory.to_string());
        assert!(resolve_output_path(&req).is_err(), "{subdirectory}");
    }
    req.output_subdirectory = Some("exports".into());
    req.source_path = Some(dir.0.to_string_lossy().into_owned());
    assert!(resolve_output_path(&req).is_err());
    req.source_path = Some(dir.0.join("missing.png").to_string_lossy().into_owned());
    assert!(resolve_output_path(&req).is_err());

    let file = dir.0.join("not-a-directory");
    fs::write(&file, b"not a directory").unwrap();
    req.output_location = Some("directory".into());
    req.source_path = None;
    req.output_directory = Some(file.join("child").to_string_lossy().into_owned());
    assert!(resolve_output_path(&req).is_err());
}

#[cfg(unix)]
#[test]
fn rejects_symlinked_source_path_components() {
    use std::os::unix::fs::symlink;

    let dir = TestDirectory::new();
    let real_source = dir.0.join("source.png");
    let linked_source = dir.0.join("linked.png");
    fs::write(&real_source, b"source marker").unwrap();
    symlink(&real_source, &linked_source).unwrap();

    let mut req = request(&dir.output());
    req.output_path.clear();
    req.output_location = Some("source".into());
    req.source_path = Some(linked_source.to_string_lossy().into_owned());
    assert!(resolve_output_path(&req).is_err());
}

fn colorful_frame(duration_ms: u32) -> GifFrameRequest {
    GifFrameRequest {
        data: encoded_image(
            RgbaImage::from_raw(
                4,
                1,
                vec![
                    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
                ],
            )
            .unwrap(),
            ImageOutputFormat::Png,
        ),
        duration_ms,
    }
}

#[test]
fn estimated_size_matches_actual_encoded_length_without_writing_output() {
    let dir = TestDirectory::new();
    let mut encoded = Vec::new();
    let actual_request = request(&dir.output());
    encode_gif(&mut encoded, &actual_request).unwrap();

    let measured_request: GifSizeEstimateRequest = serde_json::from_value(serde_json::json!({
        "width": 3,
        "height": 2,
        "loopMode": "infinite",
        "loopCount": 0,
        "frames": actual_request.frames.iter().map(|frame| serde_json::json!({
            "data": &frame.data,
            "durationMs": frame.duration_ms,
        })).collect::<Vec<_>>(),
    }))
    .unwrap();
    let measured = estimate_gif_size_blocking(measured_request).unwrap();

    assert_eq!(measured.bytes, encoded.len() as u64);
    assert_eq!(
        serde_json::to_value(measured).unwrap(),
        serde_json::json!({ "bytes": encoded.len() })
    );
    dir.assert_files(0);
}

#[test]
fn compression_planner_returns_real_candidate_estimates_and_target_selection() {
    let base = request(Path::new("estimate-only.gif"));
    let plan = plan_gif_compression_blocking(GifCompressionRequest {
        width: base.width,
        height: base.height,
        loop_mode: base.loop_mode,
        loop_count: base.loop_count,
        encoding_speed: base.encoding_speed,
        color_count: base.color_count,
        dither_mode: base.dither_mode,
        frames: base.frames,
        target_bytes: 10_000,
        max_candidates: Some(4),
    })
    .unwrap();
    assert_eq!(plan.candidates.len(), 4);
    assert!(plan
        .candidates
        .iter()
        .all(|candidate| candidate.estimated_bytes > 0));
    assert!(plan.selected.is_some());
}

#[test]
fn export_candidate_selection_changes_request_without_publishing() {
    let mut request = request(Path::new("not-written.gif"));
    request.target_bytes = Some(10_000);
    let selected = select_export_candidate(request, &None).unwrap();
    assert!(selected.width <= 3);
    assert!(selected.color_count <= 256);
    assert!(selected.target_bytes.is_none());
    assert!(!Path::new("not-written.gif").exists());
}

#[test]
fn export_candidate_selection_rejects_unreachable_target_before_publish() {
    let mut request = request(Path::new("not-written.gif"));
    request.target_bytes = Some(1);
    let error = select_export_candidate(request, &None).unwrap_err();
    assert!(error.contains("不可达"));
    assert!(!Path::new("not-written.gif").exists());
}

#[test]
fn size_estimate_request_has_no_output_side_effect_fields_and_uses_defaults() {
    let request: GifSizeEstimateRequest = serde_json::from_value(serde_json::json!({
        "width": 1,
        "height": 1,
        "loopMode": "infinite",
        "loopCount": 0,
        "frames": [{ "data": [1, 2], "durationMs": 10 }]
    }))
    .unwrap();

    assert_eq!(request.encoding_speed, 1);
    assert_eq!(request.color_count, 256);
    assert_eq!(request.dither_mode, "none");
    let internal: GifExportRequest = request.into();
    assert_eq!(internal.output_path, "estimate.gif");
    assert!(!internal.overwrite_existing);

    let with_output_fields = serde_json::json!({
        "width": 1,
        "height": 1,
        "loopMode": "infinite",
        "loopCount": 0,
        "outputPath": "should-not-be-accepted.gif",
        "overwriteExisting": true,
        "frames": [{ "data": [1, 2], "durationMs": 10 }]
    });
    assert!(serde_json::from_value::<GifSizeEstimateRequest>(with_output_fields).is_err());
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
    let blue = frames[1].buffer().get_pixel(1, 0).0;
    assert_eq!(blue[3], 255);
    assert!(blue[0] <= 8 && blue[1] <= 8 && blue[2] >= 247);
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
    for speed in [0, 31] {
        let mut req = request(&dir.output());
        req.encoding_speed = speed;
        assert!(export_gif_blocking(req).unwrap_err().contains("编码速度"));
    }
    for color_count in [1, 3, 8, 15, 17, 31, 33, 63, 65, 129, 255] {
        let mut req = request(&dir.output());
        req.color_count = color_count;
        assert!(export_gif_blocking(req).unwrap_err().contains("颜色数量"));
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

#[test]
fn accepts_base64_frame_data_without_changing_decoded_bytes() {
    let req: GifExportRequest = serde_json::from_value(serde_json::json!({
        "outputPath": "test.gif", "width": 1, "height": 1, "loopMode": "infinite", "loopCount": 0,
        "frames": [{ "dataBase64": "AH+A/w==", "durationMs": 10 }]
    }))
    .unwrap();
    assert_eq!(req.frames[0].data, vec![0, 127, 128, 255]);
}

#[test]
fn spool_accepts_200_ordered_frames_and_cleans_after_take() {
    let state = GifFrameSpoolState::default();
    let id = state.create().unwrap();
    for _ in 0..200 {
        state.write_frame(&id, "AQI=").unwrap();
    }
    let frames = state.take_frames(&id, &[10; 200]).unwrap();
    assert_eq!(frames.len(), 200);
    assert_eq!(frames[0].data, vec![1, 2]);
    assert!(state.take_frames(&id, &[10]).is_err());
}

#[test]
fn spool_rejects_unknown_and_mismatched_ids_without_path_access() {
    let state = GifFrameSpoolState::default();
    assert!(state.write_frame("..", "AQI=").is_err());
    assert!(state.take_frames("..", &[10]).is_err());
    let id = state.create().unwrap();
    state.write_frame(&id, "AQI=").unwrap();
    assert!(state.take_frames(&id, &[10, 10]).is_err());
    assert!(state.discard(&id).is_ok());
    assert!(state.discard(&id).is_ok());
}

#[test]
fn parses_safe_gif_output_location_fields_in_the_camel_case_contract() {
    let req: GifExportRequest = serde_json::from_value(serde_json::json!({
        "outputLocation": "subfolder",
        "sourcePath": "C:\\Images\\source.png",
        "outputSubdirectory": "exports",
        "fileName": "animation.gif",
        "width": 1,
        "height": 1,
        "loopMode": "infinite",
        "loopCount": 0,
        "frames": [{ "data": [1, 2], "durationMs": 10 }]
    }))
    .unwrap();
    assert_eq!(req.output_location.as_deref(), Some("subfolder"));
    assert_eq!(req.source_path.as_deref(), Some("C:\\Images\\source.png"));
    assert_eq!(req.output_subdirectory.as_deref(), Some("exports"));
    assert_eq!(req.file_name.as_deref(), Some("animation.gif"));
}

#[test]
fn export_job_reports_progress_and_cancellation() {
    let state = GifExportJobState::default();
    let job = state.register(Some("job-1"), "gif", 3).unwrap().unwrap();

    let progress = state.get("job-1").unwrap().progress();
    assert_eq!(progress.job_id, "job-1");
    assert_eq!(progress.format, "gif");
    assert_eq!(progress.status, "running");
    assert_eq!(progress.total_frames, 3);

    job_report(&Some(job.clone()), "encoding", 1);
    assert_eq!(job.progress().stage, "encoding");
    assert_eq!(job.progress().completed_frames, 1);

    let cancelled = state.get("job-1").unwrap().cancel();
    assert_eq!(cancelled.status, "cancelling");
    assert!(job_checkpoint(&Some(job)).is_err());
}

#[test]
fn job_registry_rejects_active_ids_and_reclaims_expired_terminal_jobs() {
    let state = GifExportJobState::default();
    let job = state
        .register(Some("reused-job"), "gif", 1)
        .unwrap()
        .unwrap();
    assert!(state.register(Some("reused-job"), "gif", 1).is_err());

    job.finish_ok("E:\\导出\\动画.gif".to_string());
    let replacement = state
        .register(Some("reused-job"), "gif", 2)
        .unwrap()
        .unwrap();
    assert_eq!(replacement.progress().total_frames, 2);
    replacement.finish_ok("E:\\导出\\动画-2.gif".to_string());
    assert!(state.get("reused-job").is_ok());

    replacement.expire_for_test();
    let error = match state.get("reused-job") {
        Ok(_) => panic!("expired job should be removed"),
        Err(error) => error,
    };
    assert!(error.contains("已过期"));
}

#[test]
fn encoding_semaphore_limits_parallel_work_to_two_slots() {
    let semaphore = Arc::new(EncodingSemaphore::new(2));
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let barrier = Arc::new(Barrier::new(2));
    let workers = (0..4)
        .map(|_| {
            let semaphore = Arc::clone(&semaphore);
            let active = Arc::clone(&active);
            let maximum = Arc::clone(&maximum);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let _permit = semaphore.acquire();
                let current = active.fetch_add(1, Ordering::AcqRel) + 1;
                maximum.fetch_max(current, Ordering::AcqRel);
                barrier.wait();
                std::thread::sleep(Duration::from_millis(5));
                active.fetch_sub(1, Ordering::AcqRel);
            })
        })
        .collect::<Vec<_>>();

    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(maximum.load(Ordering::Acquire), 2);
}

#[test]
fn cancellation_after_encoding_does_not_publish_output() {
    let dir = TestDirectory::new();
    let state = GifExportJobState::default();
    let job = state
        .register(Some("cancel-before-publish"), "gif", 1)
        .unwrap()
        .unwrap();
    let check_job = Some(job.clone());
    let publish_job = Some(job.clone());
    let completed_job = Some(job.clone());
    let checks = AtomicUsize::new(0);
    let output_path = dir.output();
    let output_path_text = output_path.to_string_lossy().into_owned();

    let result = storage::write_output_with_publish(
        &output_path,
        false,
        storage::MAX_OUTPUT_BYTES,
        |file| {
            file.write_all(b"encoded")
                .map_err(|error| format!("write test output: {error}"))
        },
        || {
            if checks.fetch_add(1, Ordering::Relaxed) == 1 {
                job.cancel();
                assert!(job_begin_publish(&check_job).is_err());
            }
            job_checkpoint(&check_job)
        },
        || job_begin_publish(&publish_job),
        || job_mark_published(&completed_job, output_path_text),
    );

    assert_eq!(result.unwrap_err(), "导出已取消。");
    job.finish_error("导出已取消。".to_string());
    let progress = job.progress();
    assert_eq!(progress.status, "cancelled");
    assert_eq!(progress.output_path, None);
    assert!(!output_path.exists());
}

#[test]
fn cancellation_during_and_after_publish_keeps_completed_output_consistent() {
    let dir = TestDirectory::new();
    let state = GifExportJobState::default();
    let job = state
        .register(Some("cancel-during-publish"), "gif", 1)
        .unwrap()
        .unwrap();
    let check_job = Some(job.clone());
    let publish_job = Some(job.clone());
    let completed_job = Some(job.clone());
    let output_path = dir.output();
    let output_path_text = output_path.to_string_lossy().into_owned();

    storage::write_output_with_publish(
        &output_path,
        false,
        storage::MAX_OUTPUT_BYTES,
        |file| {
            file.write_all(b"published")
                .map_err(|error| format!("write test output: {error}"))
        },
        || job_checkpoint(&check_job),
        || job_begin_publish(&publish_job),
        || {
            assert_eq!(job.cancel().status, "running");
            job_mark_published(&completed_job, output_path_text);
        },
    )
    .unwrap();

    let progress = job.progress();
    assert_eq!(progress.status, "completed");
    assert_eq!(progress.stage, "completed");
    assert_eq!(
        progress.output_path,
        Some(output_path.to_string_lossy().into_owned())
    );
    assert_eq!(job.cancel().status, "completed");
    assert_eq!(fs::read(output_path).unwrap(), b"published");
}

#[test]
fn failed_publish_lease_returns_job_to_cancellable_state() {
    let state = GifExportJobState::default();
    let job = state
        .register(Some("failed-publish"), "gif", 1)
        .unwrap()
        .unwrap();
    let publish_job = Some(job.clone());

    let lease = job_begin_publish(&publish_job).unwrap();
    assert!(lease.is_some());
    assert_eq!(job.progress().stage, "publishing");
    drop(lease);

    assert_eq!(job.cancel().status, "cancelling");
    assert!(job_checkpoint(&Some(job)).is_err());
}
