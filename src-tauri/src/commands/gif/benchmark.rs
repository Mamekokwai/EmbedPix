use std::{
    io::Cursor,
    path::{Path, PathBuf},
    time::Instant,
};

use image::{
    codecs::gif::GifDecoder, AnimationDecoder, DynamicImage, ImageOutputFormat, Rgba, RgbaImage,
};
use serde::{Deserialize, Serialize};

use super::{export_gif_blocking_with_job, GifExportRequest, GifFrameRequest};

#[derive(Clone, Copy, Debug)]
pub struct BenchmarkSpec {
    pub name: &'static str,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub color_count: u16,
    pub frames: usize,
    pattern: Pattern,
}

#[derive(Clone, Copy, Debug)]
enum Pattern {
    Landscape,
    Portrait,
    TransparentPng,
    GameRecording,
    LongVideo,
    MixedSizes,
}

pub const CASES: &[BenchmarkSpec] = &[
    BenchmarkSpec {
        name: "landscape",
        width: 320,
        height: 180,
        fps: 15,
        color_count: 256,
        frames: 30,
        pattern: Pattern::Landscape,
    },
    BenchmarkSpec {
        name: "portrait",
        width: 180,
        height: 320,
        fps: 15,
        color_count: 128,
        frames: 30,
        pattern: Pattern::Portrait,
    },
    BenchmarkSpec {
        name: "transparent-png",
        width: 320,
        height: 180,
        fps: 10,
        color_count: 256,
        frames: 20,
        pattern: Pattern::TransparentPng,
    },
    BenchmarkSpec {
        name: "game-recording",
        width: 640,
        height: 360,
        fps: 30,
        color_count: 256,
        frames: 60,
        pattern: Pattern::GameRecording,
    },
    BenchmarkSpec {
        name: "long-video",
        width: 640,
        height: 360,
        fps: 24,
        color_count: 128,
        frames: 120,
        pattern: Pattern::LongVideo,
    },
    BenchmarkSpec {
        name: "large-image",
        width: 2048,
        height: 2048,
        fps: 1,
        color_count: 256,
        frames: 1,
        pattern: Pattern::Landscape,
    },
    BenchmarkSpec {
        name: "two-hundred-frames",
        width: 640,
        height: 360,
        fps: 24,
        color_count: 128,
        frames: 200,
        pattern: Pattern::LongVideo,
    },
    BenchmarkSpec {
        name: "mixed-sizes",
        width: 640,
        height: 360,
        fps: 15,
        color_count: 128,
        frames: 40,
        pattern: Pattern::MixedSizes,
    },
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkSample {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub color_count: u16,
    pub frames: usize,
    pub output_bytes: u64,
    pub peak_disk_bytes: u64,
    pub elapsed_ms: u128,
    pub peak_memory_bytes: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentSample {
    pub sample: String,
    pub dither_mode: String,
    pub output_bytes: u64,
    pub elapsed_ms: u128,
    pub quality_mae_rgb: u64,
    pub peak_memory_bytes: Option<u64>,
}

pub const EXPERIMENT_DITHER_MODES: &[&str] = &["none", "floydSteinberg", "atkinson"];

pub fn run_case(name: &str, output_dir: &Path) -> Result<BenchmarkSample, String> {
    let spec = CASES
        .iter()
        .find(|candidate| candidate.name == name)
        .copied()
        .ok_or_else(|| format!("未知 GIF 基准样本：{name}"))?;
    std::fs::create_dir_all(output_dir)
        .map_err(|error| format!("无法创建基准输出目录：{error}"))?;

    let duration_ms = (1000 / spec.fps / 10 * 10).max(10);
    let frames = (0..spec.frames)
        .map(|index| {
            Ok(GifFrameRequest {
                data: encode_sample_frame(&spec, index)?,
                duration_ms,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let output_path = output_dir.join(format!("{}.gif", spec.name));
    let request = GifExportRequest {
        output_path: output_path.to_string_lossy().into_owned(),
        output_location: None,
        source_path: None,
        output_subdirectory: None,
        output_directory: None,
        file_name: None,
        width: spec.width,
        height: spec.height,
        loop_mode: "infinite".to_string(),
        loop_count: 0,
        encoding_speed: 10,
        color_count: spec.color_count,
        dither_mode: "none".to_string(),
        frames,
        spool_id: None,
        spool_durations: Vec::new(),
        overwrite_existing: true,
        job_id: None,
    };

    let started = Instant::now();
    export_gif_blocking_with_job(request, None)?;
    let metadata = std::fs::metadata(&output_path)
        .map_err(|error| format!("无法读取基准 GIF 体积：{error}"))?;
    Ok(BenchmarkSample {
        name: spec.name.to_string(),
        width: spec.width,
        height: spec.height,
        fps: spec.fps,
        color_count: spec.color_count,
        frames: spec.frames,
        output_bytes: metadata.len(),
        peak_disk_bytes: metadata.len(),
        elapsed_ms: started.elapsed().as_millis(),
        peak_memory_bytes: None,
    })
}

pub fn run_experiment_case(
    name: &str,
    dither_mode: &str,
    output_dir: &Path,
) -> Result<ExperimentSample, String> {
    let spec = CASES
        .iter()
        .find(|candidate| candidate.name == name)
        .copied()
        .ok_or_else(|| format!("未知 GIF 实验样本：{name}"))?;
    if !EXPERIMENT_DITHER_MODES.contains(&dither_mode) {
        return Err(format!("未知 GIF 抖动模式：{dither_mode}"));
    }
    std::fs::create_dir_all(output_dir)
        .map_err(|error| format!("无法创建实验输出目录：{error}"))?;
    let duration_ms = (1000 / spec.fps / 10 * 10).max(10);
    let source_first = encode_sample_frame(&spec, 0)?;
    let frames = (0..spec.frames)
        .map(|index| {
            Ok(GifFrameRequest {
                data: encode_sample_frame(&spec, index)?,
                duration_ms,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let output_path = output_dir.join(format!("{}-{}.gif", spec.name, dither_mode));
    let request = GifExportRequest {
        output_path: output_path.to_string_lossy().into_owned(),
        output_location: None,
        source_path: None,
        output_subdirectory: None,
        output_directory: None,
        file_name: None,
        width: spec.width,
        height: spec.height,
        loop_mode: "infinite".to_string(),
        loop_count: 0,
        encoding_speed: 10,
        color_count: spec.color_count,
        dither_mode: dither_mode.to_string(),
        frames,
        spool_id: None,
        spool_durations: Vec::new(),
        overwrite_existing: true,
        job_id: None,
    };
    let started = Instant::now();
    export_gif_blocking_with_job(request, None)?;
    let output =
        std::fs::read(&output_path).map_err(|error| format!("无法读取实验 GIF：{error}"))?;
    let decoded = GifDecoder::new(Cursor::new(output.clone()))
        .map_err(|error| format!("无法解码实验 GIF：{error}"))?
        .into_frames()
        .next()
        .ok_or_else(|| "实验 GIF 没有首帧。".to_string())?
        .map_err(|error| format!("无法读取实验 GIF 首帧：{error}"))?
        .into_buffer();
    let source = image::load_from_memory(&source_first)
        .map_err(|error| format!("无法解码实验源帧：{error}"))?
        .to_rgba8();
    let quality_mae_rgb = source
        .pixels()
        .zip(decoded.pixels())
        .map(|(left, right)| {
            u64::from(left[0].abs_diff(right[0]))
                + u64::from(left[1].abs_diff(right[1]))
                + u64::from(left[2].abs_diff(right[2]))
        })
        .sum::<u64>()
        / u64::from(spec.width * spec.height * 3);
    Ok(ExperimentSample {
        sample: spec.name.to_string(),
        dither_mode: dither_mode.to_string(),
        output_bytes: output.len() as u64,
        elapsed_ms: started.elapsed().as_millis(),
        quality_mae_rgb,
        peak_memory_bytes: current_peak_memory_bytes(),
    })
}

#[cfg(target_os = "linux")]
fn current_peak_memory_bytes() -> Option<u64> {
    let status = std::fs::read_to_string(format!("/proc/{}/status", std::process::id())).ok()?;
    status.lines().find_map(|line| {
        line.strip_prefix("VmHWM:")?
            .trim()
            .strip_suffix("kB")?
            .trim()
            .parse::<u64>()
            .ok()
            .map(|value| value * 1024)
    })
}

#[cfg(windows)]
fn current_peak_memory_bytes() -> Option<u64> {
    use std::mem::size_of;
    #[repr(C)]
    struct Counters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }
    #[link(name = "psapi")]
    unsafe extern "system" {
        fn GetProcessMemoryInfo(
            process: *mut std::ffi::c_void,
            counters: *mut Counters,
            size: u32,
        ) -> i32;
    }
    let mut counters = Counters {
        cb: size_of::<Counters>() as u32,
        page_fault_count: 0,
        peak_working_set_size: 0,
        working_set_size: 0,
        quota_peak_paged_pool_usage: 0,
        quota_paged_pool_usage: 0,
        quota_peak_non_paged_pool_usage: 0,
        quota_non_paged_pool_usage: 0,
        pagefile_usage: 0,
        peak_pagefile_usage: 0,
    };
    let ok = unsafe {
        GetProcessMemoryInfo(
            (-1isize) as *mut _,
            &mut counters,
            size_of::<Counters>() as u32,
        ) != 0
    };
    ok.then_some(counters.peak_working_set_size as u64)
}

#[cfg(not(any(target_os = "linux", windows)))]
fn current_peak_memory_bytes() -> Option<u64> {
    None
}

pub fn default_output_dir() -> PathBuf {
    PathBuf::from("benchmarks").join("gif")
}

fn encode_sample_frame(spec: &BenchmarkSpec, index: usize) -> Result<Vec<u8>, String> {
    let (width, height) = if matches!(spec.pattern, Pattern::MixedSizes) {
        if index.is_multiple_of(2) {
            (spec.width, spec.height)
        } else {
            (spec.height, spec.width)
        }
    } else {
        (spec.width, spec.height)
    };
    let mut image = RgbaImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            image.put_pixel(x, y, Rgba(sample_pixel(spec, index, x, y)));
        }
    }
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut output, ImageOutputFormat::Png)
        .map_err(|error| format!("无法生成基准 PNG 帧：{error}"))?;
    Ok(output.into_inner())
}

fn sample_pixel(spec: &BenchmarkSpec, index: usize, x: u32, y: u32) -> [u8; 4] {
    let phase = index as u32;
    let horizontal = (x.saturating_mul(255) / spec.width.max(1)) as u8;
    let vertical = (y.saturating_mul(255) / spec.height.max(1)) as u8;
    match spec.pattern {
        Pattern::Landscape => {
            if y < spec.height / 2 {
                [30, horizontal.saturating_add(20), 150, 255]
            } else {
                [40, 110u8.saturating_add(vertical / 3), 45, 255]
            }
        }
        Pattern::Portrait => [
            horizontal.saturating_add((phase % 32) as u8),
            vertical,
            180u8.saturating_sub(horizontal / 3),
            255,
        ],
        Pattern::TransparentPng => {
            let cx = spec.width as i32 / 2 + (phase as i32 % 21) - 10;
            let cy = spec.height as i32 / 2;
            let dx = x as i32 - cx;
            let dy = y as i32 - cy;
            let radius = (spec.height.min(spec.width) / 3) as i32;
            let alpha = if dx.saturating_mul(dx) + dy.saturating_mul(dy) < radius * radius {
                220
            } else {
                0
            };
            [220, 80u8.saturating_add(horizontal / 4), 240, alpha]
        }
        Pattern::GameRecording => {
            let grid = if x % 40 < 2 || y % 40 < 2 { 35 } else { 20 };
            let player_x = (phase.saturating_mul(7)) % spec.width.max(1);
            let player_y = (phase.saturating_mul(3)) % spec.height.max(1);
            if x.abs_diff(player_x) < 18 && y.abs_diff(player_y) < 12 {
                [240, 190, 40, 255]
            } else {
                [grid, 45u8.saturating_add(horizontal / 5), 70, 255]
            }
        }
        Pattern::LongVideo => [
            horizontal.saturating_add((phase % 17) as u8),
            vertical.saturating_add((phase % 11) as u8),
            ((x / 16 + y / 16 + phase) % 256) as u8,
            255,
        ],
        Pattern::MixedSizes => [
            horizontal.saturating_add((phase % 23) as u8),
            vertical.saturating_add((phase % 13) as u8),
            ((x / 12 + y / 12 + phase) % 256) as u8,
            255,
        ],
    }
}
