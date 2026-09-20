use std::{
    io::Cursor,
    path::{Path, PathBuf},
    time::Instant,
};

use image::{DynamicImage, ImageOutputFormat, Rgba, RgbaImage};
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
    pub elapsed_ms: u128,
    pub peak_memory_bytes: Option<u64>,
}

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
        elapsed_ms: started.elapsed().as_millis(),
        peak_memory_bytes: None,
    })
}

pub fn default_output_dir() -> PathBuf {
    PathBuf::from("benchmarks").join("gif")
}

fn encode_sample_frame(spec: &BenchmarkSpec, index: usize) -> Result<Vec<u8>, String> {
    let mut image = RgbaImage::new(spec.width, spec.height);
    for y in 0..spec.height {
        for x in 0..spec.width {
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
    }
}
