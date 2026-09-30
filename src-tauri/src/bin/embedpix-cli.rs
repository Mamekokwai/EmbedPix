use std::{
    io::{self, Read},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use base64::Engine;
use embedpix_lib::commands::{compression, export_image, gif};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliRequest {
    id: Option<String>,
    op: String,
    #[serde(flatten)]
    payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PathFrame {
    path: String,
    duration_ms: u32,
}

#[derive(Debug, Serialize)]
struct Event<'a> {
    #[serde(rename = "type")]
    event_type: &'a str,
    id: Option<String>,
    code: &'a str,
    message: String,
    output: Option<Value>,
}

fn main() {
    let interrupted = Arc::new(AtomicBool::new(false));
    let signal_state = Arc::clone(&interrupted);
    if ctrlc::set_handler(move || signal_state.store(true, Ordering::SeqCst)).is_err() {
        emit(
            None,
            "error",
            "signal_setup_error",
            "无法安装 Ctrl+C 处理器",
            None,
        );
        std::process::exit(2);
    }
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        emit(None, "error", "input_read_error", "无法读取 stdin", None);
        std::process::exit(2);
    }
    let requests = match parse_requests(&input) {
        Ok(requests) => requests,
        Err(error) => {
            emit(None, "error", "invalid_json", &error, None);
            std::process::exit(2);
        }
    };
    if requests.is_empty() {
        emit(None, "error", "empty_input", "stdin 未提供 JSON 请求", None);
        std::process::exit(2);
    }
    let mut succeeded = 0usize;
    let mut failed = 0usize;
    for request in requests {
        if interrupted.load(Ordering::SeqCst) {
            emit(
                None,
                "error",
                "interrupted",
                "已收到中断信号，未开始后续请求",
                None,
            );
            break;
        }
        let id = request.id.clone();
        emit(id.clone(), "progress", "started", "请求已接收", None);
        match execute(request) {
            Ok(output) => {
                succeeded += 1;
                emit(id, "success", "ok", "请求完成", Some(output));
            }
            Err((code, message)) => {
                failed += 1;
                emit(id, "error", code, &message, None);
            }
        }
    }
    let code = classify_exit_code(succeeded, failed, interrupted.load(Ordering::SeqCst));
    if code != 0 {
        std::process::exit(code);
    }
}

fn classify_exit_code(succeeded: usize, failed: usize, interrupted: bool) -> i32 {
    if interrupted || (succeeded > 0 && failed > 0) {
        2
    } else if failed > 0 {
        1
    } else {
        0
    }
}

fn parse_requests(input: &str) -> Result<Vec<CliRequest>, String> {
    if let Ok(request) = serde_json::from_str::<CliRequest>(input.trim()) {
        return Ok(vec![request]);
    }
    input
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(|error| format!("JSONL 请求无效：{error}")))
        .collect()
}

fn execute(request: CliRequest) -> Result<Value, (&'static str, String)> {
    match request.op.as_str() {
        "image" => execute_image(request.payload),
        "compress" | "compression" => execute_compression(request.payload),
        "gif" => execute_gif(request.payload),
        "pngSequence" => execute_png_sequence(request.payload),
        _ => Err((
            "unsupported_operation",
            format!("不支持的操作：{}", request.op),
        )),
    }
}

fn execute_compression(payload: Value) -> Result<Value, (&'static str, String)> {
    let input_path = required_string(&payload, "inputPath")?;
    let output_path = required_string(&payload, "outputPath")?;
    let format = match payload.get("format") {
        None => "webp",
        Some(value) => value
            .as_str()
            .filter(|value| {
                matches!(
                    value.to_ascii_lowercase().as_str(),
                    "jpg" | "jpeg" | "png" | "webp"
                )
            })
            .ok_or((
                "request_error",
                "format 必须是 jpg、jpeg、png 或 webp".into(),
            ))?,
    };
    let quality = match payload.get("quality") {
        None => 82,
        Some(value) => value
            .as_u64()
            .filter(|value| (1..=100).contains(value))
            .ok_or((
                "request_error",
                "quality 必须是 1 到 100 的无符号整数".into(),
            ))?,
    };
    let max_input_bytes = match payload.get("maxInputBytes") {
        None => None,
        Some(value) => Some(value.as_u64().ok_or((
            "request_error",
            "maxInputBytes 必须是 1 到 32 MiB 的无符号整数".into(),
        ))?),
    };
    let max_output_bytes = match payload.get("maxOutputBytes") {
        None => None,
        Some(value) => Some(
            value
                .as_u64()
                .ok_or(("request_error", "maxOutputBytes 必须是无符号整数".into()))?,
        ),
    };
    let jpeg_progressive = match payload.get("jpegProgressive") {
        None => false,
        Some(value) => value
            .as_bool()
            .ok_or(("request_error", "jpegProgressive 必须是布尔值".into()))?,
    };
    let jpeg_optimize_huffman = match payload.get("jpegOptimizeHuffman") {
        None => false,
        Some(value) => value
            .as_bool()
            .ok_or(("request_error", "jpegOptimizeHuffman 必须是布尔值".into()))?,
    };
    let lossless = match payload.get("lossless") {
        None => format.eq_ignore_ascii_case("png"),
        Some(value) => value
            .as_bool()
            .ok_or(("request_error", "lossless 必须是布尔值".into()))?,
    };
    let webp_lossless_method = match payload.get("webpLosslessMethod") {
        None => None,
        Some(value) => Some(
            value
                .as_u64()
                .filter(|value| *value <= 6)
                .map(|value| value as u8)
                .ok_or((
                    "request_error",
                    "webpLosslessMethod 必须是 0 到 6 的无符号整数".into(),
                ))?,
        ),
    };
    let target_resize_percent = match payload.get("targetResizePercent") {
        None => None,
        Some(value) => Some(
            value
                .as_u64()
                .filter(|value| (10..=100).contains(value))
                .map(|value| value as u8)
                .ok_or((
                    "request_error",
                    "targetResizePercent 必须是 10 到 100 的无符号整数".into(),
                ))?,
        ),
    };
    let auto_resize_to_target = match payload.get("autoResizeToTarget") {
        None => false,
        Some(value) => value
            .as_bool()
            .ok_or(("request_error", "autoResizeToTarget 必须是布尔值".into()))?,
    };
    if target_resize_percent.is_some() && (!matches!(format, "jpg" | "jpeg" | "webp") || lossless) {
        return Err((
            "request_error",
            "targetResizePercent 仅支持 JPEG 或有损 WebP".into(),
        ));
    }
    if auto_resize_to_target {
        if max_output_bytes.is_none() {
            return Err((
                "request_error",
                "autoResizeToTarget requires maxOutputBytes".into(),
            ));
        }
        if !matches!(format, "jpg" | "jpeg" | "webp") || lossless {
            return Err((
                "request_error",
                "autoResizeToTarget 仅支持 JPEG 或有损 WebP".into(),
            ));
        }
        if target_resize_percent.is_some() {
            return Err((
                "request_error",
                "autoResizeToTarget 不能与 targetResizePercent 同时使用".into(),
            ));
        }
    }
    let result = compression::compress_file_cli_with_advanced_options(
        std::path::Path::new(&input_path),
        std::path::Path::new(&output_path),
        format,
        quality as u8,
        max_input_bytes,
        max_output_bytes,
        jpeg_progressive,
        jpeg_optimize_huffman,
        lossless,
        webp_lossless_method,
        target_resize_percent,
        auto_resize_to_target,
    )
    .map_err(|error| ("compression_error", error))?;
    serde_json::to_value(result).map_err(|error| ("response_error", error.to_string()))
}

fn execute_image(payload: Value) -> Result<Value, (&'static str, String)> {
    let input_path = required_string(&payload, "inputPath")?;
    let output_path = required_string(&payload, "outputPath")?;
    let source =
        export_image::read_image_file_cli(&input_path).map_err(|error| ("input_error", error))?;
    let output = std::path::Path::new(&output_path);
    let output_directory = output
        .parent()
        .and_then(|path| path.to_str())
        .unwrap_or(".");
    let output_name = output
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(("request_error", "outputPath 文件名无效".into()))?;
    let mut metadata = json!({
        "fileName": output_name,
        "outputFormat": payload.get("format").and_then(Value::as_str).unwrap_or("png"),
        "width": payload.get("width").and_then(Value::as_u64).unwrap_or(0),
        "height": payload.get("height").and_then(Value::as_u64).unwrap_or(0),
        "keepAspectRatio": payload.get("keepAspectRatio").and_then(Value::as_bool).unwrap_or(true),
        "outputLocation": "directory",
        "outputDirectory": output_directory,
        "sourcePath": input_path,
        "overwriteExisting": payload.get("overwriteExisting").and_then(Value::as_bool).unwrap_or(false),
    });
    if let Some(object) = metadata.as_object_mut() {
        if let Some(value) = payload.get("bitDepth") {
            object.insert("bitDepth".into(), value.clone());
        }
    }
    let metadata_bytes =
        serde_json::to_vec(&metadata).map_err(|error| ("request_error", error.to_string()))?;
    let mut raw = b"EGF1".to_vec();
    raw.extend_from_slice(&(metadata_bytes.len() as u32).to_le_bytes());
    raw.extend_from_slice(&metadata_bytes);
    raw.extend_from_slice(&source.data);
    let result = export_image::export_image_cli(&raw).map_err(|error| ("export_error", error))?;
    serde_json::to_value(result).map_err(|error| ("response_error", error.to_string()))
}

fn execute_gif(payload: Value) -> Result<Value, (&'static str, String)> {
    let output_path = required_string(&payload, "outputPath")?;
    let frames =
        read_frames(payload.get("frames"), true).map_err(|error| ("input_error", error))?;
    let mut request = payload;
    let object = request
        .as_object_mut()
        .ok_or(("request_error", "请求必须是 JSON 对象".into()))?;
    object.insert("outputPath".into(), Value::String(output_path));
    object.insert("frames".into(), Value::Array(frames));
    let request: gif::GifExportRequest =
        serde_json::from_value(request).map_err(|error| ("request_error", error.to_string()))?;
    let output = gif::export_gif_cli(request).map_err(|error| ("export_error", error))?;
    Ok(json!({ "output": output }))
}

fn execute_png_sequence(payload: Value) -> Result<Value, (&'static str, String)> {
    let frames =
        read_frames(payload.get("frames"), false).map_err(|error| ("input_error", error))?;
    let mut request = payload;
    let object = request
        .as_object_mut()
        .ok_or(("request_error", "请求必须是 JSON 对象".into()))?;
    object.insert("frames".into(), Value::Array(frames));
    if let Some(directory) = object.remove("outputDirectory") {
        object.insert("outputDir".into(), directory);
    }
    let request: gif::PngSequenceExportRequest =
        serde_json::from_value(request).map_err(|error| ("request_error", error.to_string()))?;
    let output = gif::export_png_sequence_cli(request).map_err(|error| ("export_error", error))?;
    Ok(json!({ "output": output }))
}

fn read_frames(value: Option<&Value>, use_base64: bool) -> Result<Vec<Value>, String> {
    let frames: Vec<PathFrame> = serde_json::from_value(value.cloned().ok_or("frames 字段缺失")?)
        .map_err(|error| error.to_string())?;
    frames
        .into_iter()
        .map(|frame| {
            let source = export_image::read_image_file_cli(&frame.path)?;
            let data = if use_base64 {
                json!(base64::engine::general_purpose::STANDARD.encode(source.data))
            } else {
                json!(source.data)
            };
            Ok(if use_base64 {
                json!({ "dataBase64": data, "durationMs": frame.duration_ms })
            } else {
                json!({ "data": data, "durationMs": frame.duration_ms })
            })
        })
        .collect()
}

fn required_string(payload: &Value, field: &str) -> Result<String, (&'static str, String)> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or(("request_error", format!("缺少有效字段：{field}")))
}

fn emit(id: Option<String>, event_type: &str, code: &str, message: &str, output: Option<Value>) {
    let encoded = serde_json::to_string(&Event {
        event_type,
        id,
        code,
        message: message.to_string(),
        output,
    })
    .unwrap();
    if event_type == "error" {
        eprintln!("{encoded}");
    } else {
        println!("{encoded}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_single_json_and_jsonl_requests() {
        assert_eq!(
            parse_requests(r#"{"id":"one","op":"gif"}"#).unwrap().len(),
            1
        );
        assert_eq!(
            parse_requests("{\"id\":\"one\",\"op\":\"gif\"}\n{\"id\":\"two\",\"op\":\"image\"}")
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn event_contract_is_machine_readable() {
        let encoded = serde_json::to_value(Event {
            event_type: "success",
            id: Some("job-1".into()),
            code: "ok",
            message: "done".into(),
            output: Some(json!({"output": "x"})),
        })
        .unwrap();
        assert_eq!(encoded["type"], "success");
        assert_eq!(encoded["id"], "job-1");
        assert_eq!(encoded["output"]["output"], "x");
    }

    #[test]
    fn exit_code_contract_distinguishes_batch_results() {
        assert_eq!(classify_exit_code(2, 0, false), 0);
        assert_eq!(classify_exit_code(0, 2, false), 1);
        assert_eq!(classify_exit_code(1, 1, false), 2);
        assert_eq!(classify_exit_code(1, 0, true), 2);
    }

    #[test]
    fn compression_parameters_are_strict_when_present() {
        for (field, value) in [
            ("format", json!(true)),
            ("format", json!("tiff")),
            ("quality", json!(0)),
            ("quality", json!(-1)),
            ("quality", json!(82.5)),
            ("quality", json!("82")),
            ("maxInputBytes", json!(-1)),
            ("maxInputBytes", json!(1048576.5)),
            ("maxInputBytes", json!("1048576")),
        ] {
            let mut payload = json!({ "inputPath": "input.png", "outputPath": "output.webp" });
            payload[field] = value;
            assert_eq!(execute_compression(payload).unwrap_err().0, "request_error");
        }
        for field in ["jpegProgressive", "jpegOptimizeHuffman"] {
            let mut payload = json!({ "inputPath": "input.png", "outputPath": "output.jpg" });
            payload[field] = json!("true");
            assert_eq!(execute_compression(payload).unwrap_err().0, "request_error");
        }
        for (field, value) in [
            ("lossless", json!("true")),
            ("webpLosslessMethod", json!(7)),
            ("webpLosslessMethod", json!(6.5)),
            ("webpLosslessMethod", json!("6")),
            ("targetResizePercent", json!(9)),
            ("targetResizePercent", json!(101)),
            ("targetResizePercent", json!(50.5)),
            ("targetResizePercent", json!("50")),
        ] {
            let mut payload = json!({ "inputPath": "input.png", "outputPath": "output.webp" });
            payload[field] = value;
            assert_eq!(execute_compression(payload).unwrap_err().0, "request_error");
        }
        assert_eq!(
            execute_compression(json!({ "inputPath": "input.png", "outputPath": "output.png", "format": "png", "targetResizePercent": 50 }))
                .unwrap_err()
                .0,
            "request_error"
        );
        assert_eq!(
            execute_compression(json!({ "inputPath": "input.png", "outputPath": "output.webp", "format": "webp", "lossless": true, "targetResizePercent": 50 }))
                .unwrap_err()
                .0,
            "request_error"
        );
        assert_eq!(execute_compression(json!({ "inputPath": "missing.png", "outputPath": "output.webp", "format": "webp", "quality": 82 })).unwrap_err().0, "compression_error");
    }
}
