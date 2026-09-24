pub mod export_image;
pub mod export_preflight;
pub mod gif;
pub(crate) mod path_security;
pub mod update;

#[cfg(test)]
pub(crate) fn test_temp_dir() -> std::path::PathBuf {
    std::fs::canonicalize(std::env::temp_dir()).expect("system temp directory must exist")
}
