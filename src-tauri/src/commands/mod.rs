pub mod compression;
pub mod export_image;
pub mod export_preflight;
pub mod gif;
pub(crate) mod image_orientation;
pub(crate) mod path_security;
pub mod update;
pub(crate) mod webp_static;

#[cfg(test)]
pub(crate) fn test_temp_dir() -> std::path::PathBuf {
    std::fs::canonicalize(std::env::temp_dir()).expect("system temp directory must exist")
}
