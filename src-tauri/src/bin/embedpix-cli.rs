use std::io::{self, Read};

use base64::Engine;
use embedpix_lib::commands::{export_image, gif};
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
    let mut failed = false;
    for request in requests {
        let id = request.id.clone();
        emit(id.clone(), "progress", "started", "请求已接收", None);
        match execute(request) {
            Ok(output) => emit(id, "success", "ok", "请求完成", Some(output)),
            Err((code, message)) => {
                failed = true;
                emit(id, "error", code, &message, None);
            }
        }
    }
    if failed {
        std::process::exit(1);
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
        "gif" => execute_gif(request.payload),
        "pngSequence" => execute_png_sequence(request.payload),
        _ => Err((
            "unsupported_operation",
            format!("不支持的操作：{}", request.op),
        )),
    }
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
    println!(
        "{}",
        serde_json::to_string(&Event {
            event_type,
            id,
            code,
            message: message.to_string(),
            output
        })
        .unwrap()
    );
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
}
