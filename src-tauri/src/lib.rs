mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(commands::update::UpdateProgressState::default())
        .invoke_handler(tauri::generate_handler![
            commands::gif::pick_gif_output,
            commands::gif::export_gif,
            commands::gif::estimate_gif_size,
            commands::gif::pick_gif_sequence_output,
            commands::gif::export_png_sequence,
            commands::gif::pick_animation_output,
            commands::gif::export_webp_animation,
            commands::gif::export_apng,
            commands::export_image::export_image,
            commands::export_image::pick_image,
            commands::export_image::pick_images,
            commands::export_image::read_image_file,
            commands::update::check_update,
            commands::update::get_update_download_progress,
            commands::update::download_update,
            commands::update::install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running EmbedPix");
}
