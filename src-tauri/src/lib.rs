pub mod commands;

use tauri::Manager;

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
            // 无边框窗口下 tauri.conf 的 minWidth/minHeight 不一定生效（WM_GETMINMAXINFO 是靠系统边框走的），
            // 运行时再钉一次，保证窗口缩不到两栏工作区会压叠的宽度。
            if let Some(window) = app.get_webview_window("main") {
                if let Err(err) = window.set_min_size(Some(tauri::LogicalSize::new(900.0, 636.0))) {
                    eprintln!("pin main window min size failed: {err}");
                }
            }
            commands::update::mark_app_started(
                app.handle(),
                app.state::<commands::update::UpdateHealthState>(),
            );
            Ok(())
        })
        .on_window_event(|window, event| {
            // 无边框窗口下 set_min_size 不够用：实测该窗口的 WM_GETMINMAXINFO 回报 minTrack=0x0，
            // 拖拽时系统根本不拦。这里按物理尺寸在每次 resize 后顶回去，尺寸已达标就不再触发。
            if let tauri::WindowEvent::Resized(size) = event {
                let scale = window.scale_factor().unwrap_or(1.0);
                let min_width = (900.0 * scale).round() as u32;
                let min_height = (636.0 * scale).round() as u32;
                if size.width < min_width || size.height < min_height {
                    let _ = window.set_size(tauri::PhysicalSize::new(
                        size.width.max(min_width),
                        size.height.max(min_height),
                    ));
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running EmbedPix");
}
