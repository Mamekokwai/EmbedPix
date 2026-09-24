fn main() {
    tauri_build::build();

    if std::env::var_os("CARGO_CFG_WINDOWS").is_some() {
        println!("cargo:rustc-link-arg-bin=embedpix=/SUBSYSTEM:WINDOWS");
    }
}
