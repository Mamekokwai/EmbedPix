pub mod commands;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(commands::update::UpdateProgressState::default())
        .manage(commands::update::UpdateCancellationState::default())
        .manage(commands::update::UpdateHealthState::default())
        .manage(commands::gif::GifExportJobState::default())
        .manage(commands::gif::GifFrameSpoolState::default())
        .manage(commands::compression::CompressionJobState::default())
        .invoke_handler(tauri::generate_handler![
            commands::gif::pick_gif_output,
            commands::gif::export_gif,
            commands::gif::create_gif_frame_spool,
            commands::gif::write_gif_frame_spool,
            commands::gif::discard_gif_frame_spool,
            commands::gif::cancel_gif_export,
            commands::gif::get_gif_export_progress,
            commands::gif::estimate_gif_size,
            commands::gif::plan_gif_compression,
            commands::gif::pick_gif_sequence_output,
            commands::gif::export_png_sequence,
            commands::gif::estimate_png_sequence_size,
            commands::gif::pick_animation_output,
            commands::gif::export_webp_animation,
            commands::gif::export_apng,
            commands::gif::estimate_animation_size,
            commands::export_image::export_image,
            commands::export_image::preview_image_export,
            commands::export_image::pick_image,
            commands::export_image::pick_images,
            commands::export_image::pick_image_directory,
            commands::export_image::read_image_file,
            commands::compression::compress_image,
            commands::compression::preflight_compression,
            commands::compression::preview_compression,
            commands::compression::estimate_image_compression,
            commands::compression::cancel_compression,
            commands::compression::get_compression_progress,
            commands::export_preflight::preflight_image_exports,
            commands::update::check_update,
            commands::update::get_update_download_progress,
            commands::update::download_update,
            commands::update::cancel_update_download,
            commands::update::install_update
        ])
        .setup(|app| {
            // 无边框窗口的最小尺寸必须在创建期交给系统（对齐 patina 的主窗口）：build 前调用 min_inner_size，
            // 拖拽途中系统才会拿 WM_GETMINMAXINFO 的 minTrack 当场拦下，而不是等松手后由事件回调顶回去。
            // tauri.conf 的 app.windows 已置空，Tauri 不再自动建窗，主窗口只能在这里创建。
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("EmbedPix")
                .inner_size(1100.0, 760.0)
                .min_inner_size(900.0, 636.0)
                .resizable(true)
                .decorations(false)
                .build()?;
            commands::update::mark_app_started(
                app.handle(),
                app.state::<commands::update::UpdateHealthState>(),
            );
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running EmbedPix");
}
