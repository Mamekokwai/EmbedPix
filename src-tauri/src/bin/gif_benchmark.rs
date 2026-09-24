use std::{
    env, fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

use embedpix_lib::commands::gif::benchmark::{
    default_output_dir, run_case, run_quality_preset_case, BenchmarkSample, QualityPresetSample,
    CASES, QUALITY_PRESETS,
};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Baseline {
    schema_version: u32,
    environment: Environment,
    case_count: usize,
    failure_count: usize,
    failure_rate: f64,
    samples: Vec<BenchmarkSample>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Environment {
    os: &'static str,
    arch: &'static str,
    pointer_width: &'static str,
    generator: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QualityReport {
    schema_version: u32,
    environment: Environment,
    source_width: u32,
    source_height: u32,
    source_fps: u32,
    source_frames: usize,
    presets: Vec<QualityPresetSample>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("gif benchmark failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = env::args().collect::<Vec<_>>();
    let output_dir = argument(&args, "--output-dir")
        .map(PathBuf::from)
        .unwrap_or_else(default_output_dir);
    if let Some(quality_dir) = argument(&args, "--quality-output-dir") {
        return run_quality_report(PathBuf::from(quality_dir));
    }
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("cannot create benchmark directory: {error}"))?;

    if let Some(case) = argument(&args, "--worker-case") {
        let sample = run_case(&case, &output_dir)?;
        println!(
            "{}",
            serde_json::to_string(&sample).map_err(|error| error.to_string())?
        );
        return Ok(());
    }

    let mut samples = Vec::with_capacity(CASES.len());
    let mut failure_count = 0usize;
    for case in CASES {
        let mut sample = match run_worker(case.name, &output_dir) {
            Ok(sample) => sample,
            Err(error) => {
                failure_count += 1;
                eprintln!("{}: failed: {error}", case.name);
                continue;
            }
        };
        println!(
            "{}: {}x{} @ {} FPS, {} colors, {} frames, {} bytes, {} ms, peak memory {} bytes, peak disk {} bytes",
            sample.name,
            sample.width,
            sample.height,
            sample.fps,
            sample.color_count,
            sample.frames,
            sample.output_bytes,
            sample.elapsed_ms,
            sample
                .peak_memory_bytes
                .map_or_else(|| "unsupported".to_string(), |bytes| bytes.to_string()),
            sample.peak_disk_bytes,
        );
        if sample.peak_memory_bytes.is_none() {
            sample.peak_memory_bytes = peak_memory_bytes(std::process::id());
        }
        samples.push(sample);
    }

    let baseline = Baseline {
        schema_version: 2,
        environment: Environment {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            pointer_width: if cfg!(target_pointer_width = "64") {
                "64"
            } else {
                "32"
            },
            generator: "deterministic-rgba-frame-generator",
        },
        case_count: CASES.len(),
        failure_count,
        failure_rate: failure_count as f64 / CASES.len() as f64,
        samples,
    };
    let json = serde_json::to_string_pretty(&baseline).map_err(|error| error.to_string())?;
    fs::write(output_dir.join("baseline.json"), format!("{json}\n"))
        .map_err(|error| format!("cannot write baseline JSON: {error}"))?;
    write_csv(&output_dir, &baseline.samples)?;
    Ok(())
}

fn run_quality_report(output_dir: PathBuf) -> Result<(), String> {
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("cannot create quality directory: {error}"))?;
    let mut presets = Vec::with_capacity(QUALITY_PRESETS.len());
    for preset in QUALITY_PRESETS {
        let sample = run_quality_preset_case(preset.name, &output_dir)?;
        println!(
            "{}: {}x{} @ {} FPS, {} colors, {} frames, speed {}, {} bytes, {} ms, MAE {}, peak {} bytes",
            sample.preset,
            sample.width,
            sample.height,
            sample.fps,
            sample.color_count,
            sample.frames,
            sample.encoding_speed,
            sample.output_bytes,
            sample.elapsed_ms,
            sample.quality_mae_rgb,
            sample
                .peak_memory_bytes
                .map_or_else(|| "unsupported".to_string(), |bytes| bytes.to_string()),
        );
        presets.push(sample);
    }
    let report = QualityReport {
        schema_version: 1,
        environment: Environment {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            pointer_width: if cfg!(target_pointer_width = "64") {
                "64"
            } else {
                "32"
            },
            generator: "deterministic-rgba-frame-generator",
        },
        source_width: 640,
        source_height: 360,
        source_fps: 15,
        source_frames: 120,
        presets,
    };
    let json = serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?;
    fs::write(output_dir.join("quality-report.json"), format!("{json}\n"))
        .map_err(|error| format!("cannot write quality JSON: {error}"))?;
    let mut csv = String::from("preset,width,height,fps,color_count,frames,sampling_every,encoding_speed,dither_mode,output_bytes,elapsed_ms,peak_memory_bytes,quality_mae_rgb\n");
    for sample in &report.presets {
        csv.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
            sample.preset,
            sample.width,
            sample.height,
            sample.fps,
            sample.color_count,
            sample.frames,
            sample.sampling_every,
            sample.encoding_speed,
            sample.dither_mode,
            sample.output_bytes,
            sample.elapsed_ms,
            sample
                .peak_memory_bytes
                .map_or_else(String::new, |bytes| bytes.to_string()),
            sample.quality_mae_rgb,
        ));
    }
    fs::write(output_dir.join("quality-report.csv"), csv)
        .map_err(|error| format!("cannot write quality CSV: {error}"))
}

fn run_worker(name: &str, output_dir: &PathBuf) -> Result<BenchmarkSample, String> {
    let executable = env::current_exe()
        .map_err(|error| format!("cannot resolve benchmark executable: {error}"))?;
    let mut child = Command::new(executable)
        .arg("--worker-case")
        .arg(name)
        .arg("--output-dir")
        .arg(output_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("cannot start benchmark worker {name}: {error}"))?;
    let pid = child.id();
    let mut peak = 0;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("cannot poll benchmark worker {name}: {error}"))?
        {
            if !status.success() {
                return Err(format!("benchmark worker {name} exited with {status}"));
            }
            break;
        }
        peak = peak.max(peak_memory_bytes(pid).unwrap_or(0));
        thread::sleep(Duration::from_millis(10));
    }
    peak = peak.max(peak_memory_bytes(pid).unwrap_or(0));
    let mut output = String::new();
    child
        .stdout
        .take()
        .ok_or_else(|| "benchmark worker stdout unavailable".to_string())?
        .read_to_string(&mut output)
        .map_err(|error| format!("cannot read benchmark worker output: {error}"))?;
    let line = output
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| format!("benchmark worker {name} returned no result"))?;
    let mut sample: BenchmarkSample = serde_json::from_str(line)
        .map_err(|error| format!("invalid benchmark worker result: {error}"))?;
    sample.peak_memory_bytes = (peak > 0).then_some(peak);
    Ok(sample)
}

fn write_csv(output_dir: &Path, samples: &[BenchmarkSample]) -> Result<(), String> {
    let mut csv = String::from(
        "name,width,height,fps,color_count,frames,output_bytes,peak_disk_bytes,elapsed_ms,peak_memory_bytes\n",
    );
    for sample in samples {
        csv.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{}\n",
            sample.name,
            sample.width,
            sample.height,
            sample.fps,
            sample.color_count,
            sample.frames,
            sample.output_bytes,
            sample.peak_disk_bytes,
            sample.elapsed_ms,
            sample
                .peak_memory_bytes
                .map_or_else(String::new, |bytes| bytes.to_string()),
        ));
    }
    fs::write(output_dir.join("baseline.csv"), csv)
        .map_err(|error| format!("cannot write baseline CSV: {error}"))
}

fn argument(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
}

#[cfg(target_os = "linux")]
fn peak_memory_bytes(pid: u32) -> Option<u64> {
    let status = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    status.lines().find_map(|line| {
        let value = line
            .strip_prefix("VmHWM:")?
            .trim()
            .strip_suffix("kB")?
            .trim();
        value.parse::<u64>().ok().map(|kilobytes| kilobytes * 1024)
    })
}

#[cfg(windows)]
fn peak_memory_bytes(pid: u32) -> Option<u64> {
    use std::mem::size_of;

    const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
    const PROCESS_VM_READ: u32 = 0x0010;
    #[repr(C)]
    struct ProcessMemoryCounters {
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
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(
            desired_access: u32,
            inherit_handle: i32,
            process_id: u32,
        ) -> *mut std::ffi::c_void;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }
    #[link(name = "psapi")]
    unsafe extern "system" {
        fn GetProcessMemoryInfo(
            process: *mut std::ffi::c_void,
            counters: *mut ProcessMemoryCounters,
            size: u32,
        ) -> i32;
    }

    let process = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
    if process.is_null() {
        return None;
    }
    let mut counters = ProcessMemoryCounters {
        cb: size_of::<ProcessMemoryCounters>() as u32,
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
            process,
            &mut counters,
            size_of::<ProcessMemoryCounters>() as u32,
        ) != 0
    };
    unsafe {
        CloseHandle(process);
    }
    ok.then_some(counters.peak_working_set_size as u64)
}

#[cfg(not(any(target_os = "linux", windows)))]
fn peak_memory_bytes(_pid: u32) -> Option<u64> {
    None
}
