pub mod commands;

use tauri::Manager;

/// Resized 的代数：合并拖拽途中的连续 resize，只在尺寸停下来之后纠正最小尺寸。
static RESIZE_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

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
            if let tauri::WindowEvent::Resized(size) = event {
                let scale = window.scale_factor().unwrap_or(1.0);
                let min_width = (900.0 * scale).round() as u32;
                let min_height = (636.0 * scale).round() as u32;
                if size.width >= min_width && size.height >= min_height {
                    return;
                }
                // 无边框窗口下 set_min_size 不被系统采纳（实测 WM_GETMINMAXINFO 回报 minTrack=0x0），
                // 只能自己顶回去。但拖拽途中每次都顶会和系统抢尺寸、把窗口拽得一抖一抖，
                // 所以等尺寸停下 180ms 再纠正；期间又发生 resize 就交给后来者（代数不匹配即放弃）。
                let generation =
                    RESIZE_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                let window = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(180));
                    if RESIZE_GENERATION.load(std::sync::atomic::Ordering::SeqCst) != generation {
                        return;
                    }
                    let _ = window.set_size(tauri::PhysicalSize::new(min_width, min_height));
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running EmbedPix");
}
