pub mod commands;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

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
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Resized(size) = event {
                let scale = window.scale_factor().unwrap_or(1.0);
                let min_width = (900.0 * scale).round() as u32;
                let min_height = (636.0 * scale).round() as u32;
                // 任何一次 resize 都作废排队中的纠正——否则用户已经拉大了，先前那次仍会执行，
                // 把窗口按回最小尺寸、与鼠标抢方向，看起来就是抽动。
                let generation =
                    RESIZE_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                if size.width >= min_width && size.height >= min_height {
                    return;
                }
                // 兼底，不是主手段：创建期的 min_inner_size 被系统采纳后这里永不触发（系统当场就拦住了）。
                // 只有当系统没采纳时才轮到它，而它只能在尺寸停下 180ms 后顶回去，代价就是先能拉小一段再弹回。
                let window = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(180));
                    if RESIZE_GENERATION.load(std::sync::atomic::Ordering::SeqCst) != generation {
                        return;
                    }
                    // 执行前再看一眼当前尺寸：期间用户可能已经拉大了，那就什么都不做。
                    let Ok(current) = window.inner_size() else {
                        return;
                    };
                    if current.width >= min_width && current.height >= min_height {
                        return;
                    }
                    let _ = window.set_size(tauri::PhysicalSize::new(
                        current.width.max(min_width),
                        current.height.max(min_height),
                    ));
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running EmbedPix");
}
