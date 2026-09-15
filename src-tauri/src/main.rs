#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if has_explicit_arguments(&args) {
        if !prepare_cli_console() {
            std::process::exit(2);
        }
        eprintln!(
            "EmbedPix CLI mode is not implemented yet; received arguments: {}",
            args.iter().skip(1).cloned().collect::<Vec<_>>().join(" ")
        );
        std::process::exit(2);
    }

    embedpix_lib::run();
}

fn has_explicit_arguments(args: &[String]) -> bool {
    args.len() > 1
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
