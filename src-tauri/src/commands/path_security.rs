use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub(crate) const MAX_OUTPUT_PATH_BYTES: usize = 4096;
pub(crate) const MAX_OUTPUT_SUBDIRECTORY_BYTES: usize = 255;

#[derive(Debug)]
pub(crate) enum PathSecurityError {
    Empty,
    TooLong,
    ControlCharacters,
    InvalidPath,
    InvalidSubdirectory,
    ReservedName,
    SymlinkOrReparse,
    NotDirectory,
    NotFile,
    Missing,
    Io(String),
}

pub(crate) fn normalize_path(value: &str) -> Result<PathBuf, PathSecurityError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(PathSecurityError::Empty);
    }
    if value.len() > MAX_OUTPUT_PATH_BYTES {
        return Err(PathSecurityError::TooLong);
    }
    if value.chars().any(char::is_control) {
        return Err(PathSecurityError::ControlCharacters);
    }
    if value.split(['/', '\\']).any(|component| {
        component == "."
            || component == ".."
            || component.ends_with('.')
            || component.ends_with(' ')
            || is_reserved_windows_name(component)
    }) {
        return Err(PathSecurityError::InvalidPath);
    }
    Ok(PathBuf::from(value))
}

pub(crate) fn normalize_subdirectory(
    value: Option<&str>,
) -> Result<Option<String>, PathSecurityError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > MAX_OUTPUT_SUBDIRECTORY_BYTES
        || value == "."
        || value == ".."
        || value.ends_with('.')
        || value.ends_with(' ')
        || value.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
    {
        return Err(PathSecurityError::InvalidSubdirectory);
    }
    if is_reserved_windows_name(value) {
        return Err(PathSecurityError::ReservedName);
    }
    Ok(Some(value.to_string()))
}

pub(crate) fn is_reserved_windows_name(value: &str) -> bool {
    let base = value
        .split('.')
        .next()
        .unwrap_or(value)
        .trim_end_matches([' ', '.']);
    let uppercase = base.to_ascii_uppercase();
    matches!(uppercase.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || uppercase
            .strip_prefix("COM")
            .or_else(|| uppercase.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
}

pub(crate) fn validate_source_file(value: Option<&str>) -> Result<PathBuf, PathSecurityError> {
    let path = normalize_path(value.ok_or(PathSecurityError::Empty)?)?;
    validate_source_path(&path)?;
    Ok(path)
}

pub(crate) fn validate_source_path(path: &Path) -> Result<(), PathSecurityError> {
    validate_path_components(path)?;
    validate_path_chain(path, true)?;
    Ok(())
}

pub(crate) fn validate_path_chain(
    path: &Path,
    require_final: bool,
) -> Result<(), PathSecurityError> {
    let mut ancestors = path
        .ancestors()
        .filter(|ancestor| !ancestor.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    ancestors.reverse();
    for (index, ancestor) in ancestors.iter().enumerate() {
        let is_final = index + 1 == ancestors.len();
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || has_reparse_point(&metadata) {
                    return Err(PathSecurityError::SymlinkOrReparse);
                }
                if !is_final && !metadata.is_dir() {
                    return Err(PathSecurityError::NotDirectory);
                }
                if is_final && !metadata.is_file() {
                    return Err(PathSecurityError::NotFile);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound && !require_final => {
                return Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(PathSecurityError::Missing)
            }
            Err(error) => return Err(PathSecurityError::Io(error.to_string())),
        }
    }
    Ok(())
}

pub(crate) fn validate_existing_file(path: &Path) -> Result<(), PathSecurityError> {
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || has_reparse_point(&metadata) =>
        {
            Err(PathSecurityError::SymlinkOrReparse)
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(PathSecurityError::Io(error.to_string())),
    }
}

pub(crate) fn validate_output_directory(directory: &Path) -> Result<(), PathSecurityError> {
    if directory.as_os_str().is_empty() {
        return Err(PathSecurityError::Empty);
    }
    if directory != Path::new(".") {
        validate_path_components(directory)?;
    }
    let mut ancestors = directory
        .ancestors()
        .filter(|ancestor| !ancestor.as_os_str().is_empty())
        .collect::<Vec<_>>();
    ancestors.reverse();
    for ancestor in ancestors {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || has_reparse_point(&metadata) {
                    return Err(PathSecurityError::SymlinkOrReparse);
                }
                if !metadata.is_dir() {
                    return Err(PathSecurityError::NotDirectory);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => return Err(PathSecurityError::Io(error.to_string())),
        }
    }
    Ok(())
}

pub(crate) fn validate_output_path(path: &Path) -> Result<(), PathSecurityError> {
    if path.as_os_str().is_empty() {
        return Err(PathSecurityError::Empty);
    }
    validate_path_components(path)?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    validate_output_directory(parent)?;
    validate_existing_file(path)
}

fn validate_path_components(path: &Path) -> Result<(), PathSecurityError> {
    let value = path.to_string_lossy();
    if value.len() > MAX_OUTPUT_PATH_BYTES {
        return Err(PathSecurityError::TooLong);
    }
    if value.chars().any(char::is_control) {
        return Err(PathSecurityError::ControlCharacters);
    }
    if value.split(['/', '\\']).any(|component| {
        component == "."
            || component == ".."
            || component.ends_with('.')
            || component.ends_with(' ')
            || is_reserved_windows_name(component)
    }) {
        return Err(PathSecurityError::InvalidPath);
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn has_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
pub(crate) fn has_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}
