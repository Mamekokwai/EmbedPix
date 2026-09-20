use std::{env, fs, path::PathBuf};

use embedpix_lib::commands::gif::benchmark::{
    default_output_dir, run_experiment_case, ExperimentSample, CASES, EXPERIMENT_DITHER_MODES,
};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExperimentReport {
    schema_version: u32,
    ffmpeg_available: bool,
    gifski_available: bool,
    samples: Vec<ExperimentSample>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("gif palette experiment failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let output_dir = env::args()
        .skip(1)
        .find_map(|arg| arg.strip_prefix("--output-dir=").map(PathBuf::from))
        .unwrap_or_else(|| default_output_dir().join("c4"));
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("cannot create experiment directory: {error}"))?;
    let mut samples = Vec::new();
    for case in CASES {
        for mode in EXPERIMENT_DITHER_MODES {
            let sample = run_experiment_case(case.name, mode, &output_dir)?;
            println!(
                "{} {}: {} bytes, {} ms, RGB MAE {}",
                sample.sample,
                sample.dither_mode,
                sample.output_bytes,
                sample.elapsed_ms,
                sample.quality_mae_rgb
            );
            samples.push(sample);
        }
    }
    let report = ExperimentReport {
        schema_version: 1,
        ffmpeg_available: command_available("ffmpeg"),
        gifski_available: command_available("gifski"),
        samples,
    };
    fs::write(
        output_dir.join("report.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
        ),
    )
    .map_err(|error| format!("cannot write report JSON: {error}"))?;
    let mut csv = String::from(
        "sample,dither_mode,output_bytes,elapsed_ms,quality_mae_rgb,peak_memory_bytes\n",
    );
    for sample in &report.samples {
        csv.push_str(&format!(
            "{},{},{},{},{},{}\n",
            sample.sample,
            sample.dither_mode,
            sample.output_bytes,
            sample.elapsed_ms,
            sample.quality_mae_rgb,
            sample
                .peak_memory_bytes
                .map_or_else(String::new, |value| value.to_string())
        ));
    }
    fs::write(output_dir.join("report.csv"), csv)
        .map_err(|error| format!("cannot write report CSV: {error}"))?;
    Ok(())
}

fn command_available(command: &str) -> bool {
    std::process::Command::new(command)
        .arg("-version")
        .output()
        .is_ok()
}
