mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::export_image::export_image,
            commands::export_image::pick_image,
            commands::export_image::read_image_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running EmbedPix");
}
