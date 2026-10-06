#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if has_explicit_arguments(&args) {
        if !prepare_cli_console() {
            std::process::exit(2);
        }
        match args.get(1).map(String::as_str) {
            Some("--help" | "-h") => {
                println!("{}", cli_help());
                std::process::exit(0);
            }
            Some("--version" | "-V") => {
                println!("EmbedPix {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            _ => {
                eprintln!(
                    "EmbedPix GUI 不接收图片处理参数；请使用同目录的 embedpix-cli，通过 JSON/JSONL stdin 调用。收到参数：{}",
                    args.iter().skip(1).cloned().collect::<Vec<_>>().join(" ")
                );
                std::process::exit(2);
            }
        }
    }

    embedpix_lib::run();
}

fn has_explicit_arguments(args: &[String]) -> bool {
    args.len() > 1
}

fn cli_help() -> &'static str {
    "EmbedPix GUI\n\n用法：直接启动 EmbedPix.exe 打开图形界面。\n命令行处理：使用同目录的 embedpix-cli，将 JSON 或 JSONL 请求写入 stdin。\n选项：\n  -h, --help       显示帮助\n  -V, --version    显示版本"
}

#[cfg(windows)]
fn prepare_cli_console() -> bool {
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;

    // A GUI-subsystem process does not inherit a console automatically, so explicit CLI use
    // needs to attach to the caller before writing diagnostics.
    unsafe { AttachConsole(ATTACH_PARENT_PROCESS) != 0 || AllocConsole() != 0 }
}

#[cfg(not(windows))]
fn prepare_cli_console() -> bool {
    true
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn AllocConsole() -> i32;
    fn AttachConsole(process_id: u32) -> i32;
}

#[cfg(test)]
mod tests {
    use super::{cli_help, has_explicit_arguments};

    #[test]
    fn gui_argument_contract_is_explicit() {
        assert!(!has_explicit_arguments(&["embedpix".into()]));
        assert!(has_explicit_arguments(&[
            "embedpix".into(),
            "--help".into()
        ]));
        assert!(cli_help().contains("embedpix-cli"));
        assert!(cli_help().contains("JSONL"));
    }
}
