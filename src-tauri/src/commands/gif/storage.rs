use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

const MAX_OUTPUT_PATH_BYTES: usize = 4096;
const MAX_OUTPUT_NAME_CHARS: usize = 120;
const MAX_OUTPUT_SUBDIRECTORY_BYTES: usize = 255;

struct TemporaryOutput {
    path: PathBuf,
    file: Option<File>,
    cleanup: bool,
}

impl TemporaryOutput {
    fn create(output: &Path) -> io::Result<Self> {
        let parent = output.parent().unwrap_or_else(|| Path::new("."));
        for index in 0..=10_000 {
            let path = parent.join(format!(".embedpix-gif-{}-{index}.tmp", std::process::id()));
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => {
                    return Ok(Self {
                        path,
                        file: Some(file),
                        cleanup: true,
                    })
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "无法分配 GIF 临时文件",
        ))
    }
}

impl Drop for TemporaryOutput {
    fn drop(&mut self) {
        self.file.take();
        if !self.cleanup {
            return;
        }
        // 只有 create_new 成功获得所有权的文件才能由本次导出清理。
        if let Err(error) = fs::remove_file(&self.path) {
            if error.kind() != io::ErrorKind::NotFound {
                eprintln!("无法清理 GIF 临时文件 {}：{error}", self.path.display());
            }
        }
    }
}

fn check_target(output: &Path, overwrite: bool) -> Result<(), String> {
    match fs::symlink_metadata(output) {
        Ok(metadata)
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || has_reparse_point(&metadata) =>
        {
            Err("GIF 输出路径已存在但不是普通文件。".into())
        }
        Ok(_) if !overwrite => Err("GIF 输出文件已存在，请启用覆盖同名文件后重试。".into()),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法检查 GIF 输出路径：{error}")),
    }
}

pub(super) fn validate_existing_output_file(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || has_reparse_point(&metadata) =>
        {
            Err(format!(
                "GIF 输出路径已存在但不是普通文件：{}",
                path.display()
            ))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法检查 GIF 输出路径：{error}")),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OutputLocation {
    Dialog,
    Source,
    Subfolder,
    Directory,
}

impl OutputLocation {
    fn parse(value: Option<&str>) -> Result<Self, String> {
        match value
            .unwrap_or("dialog")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "dialog" | "path" => Ok(Self::Dialog),
            "source" => Ok(Self::Source),
            "subfolder" => Ok(Self::Subfolder),
            "directory" => Ok(Self::Directory),
            other => Err(format!(
                "GIF 输出位置 `{other}` 无效，应为 dialog、source、subfolder 或 directory。"
            )),
        }
    }
}

pub(super) fn resolve_output_file_path(
    output_path: &str,
    output_location: Option<&str>,
    source_path: Option<&str>,
    output_subdirectory: Option<&str>,
    output_directory: Option<&str>,
    file_name: Option<&str>,
    extension: &str,
) -> Result<PathBuf, String> {
    match OutputLocation::parse(output_location)? {
        OutputLocation::Dialog => {
            let path = normalize_path(output_path, "GIF 输出路径")?;
            ensure_extension(&path, extension)?;
            Ok(path)
        }
        OutputLocation::Source | OutputLocation::Subfolder => {
            let source = validate_source_file(source_path)?;
            let parent = source
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            let directory = if OutputLocation::Subfolder == OutputLocation::parse(output_location)?
            {
                parent.join(
                    normalize_subdirectory(output_subdirectory)?
                        .ok_or_else(|| "GIF 源文件夹子目录不能为空。".to_string())?,
                )
            } else {
                parent.to_path_buf()
            };
            validate_output_directory(&directory)?;
            let default_stem = source.file_stem().and_then(|value| value.to_str());
            Ok(directory.join(normalize_output_name(file_name, default_stem, extension)?))
        }
        OutputLocation::Directory => {
            let directory = normalize_path(
                output_directory.ok_or_else(|| "GIF 输出目录不能为空。".to_string())?,
                "GIF 输出目录",
            )?;
            validate_output_directory(&directory)?;
            Ok(directory.join(normalize_output_name(file_name, None, extension)?))
        }
    }
}

pub(super) fn resolve_output_directory(
    output_directory: &str,
    output_location: Option<&str>,
    source_path: Option<&str>,
    output_subdirectory: Option<&str>,
    specified_directory: Option<&str>,
) -> Result<PathBuf, String> {
    let directory = match OutputLocation::parse(output_location)? {
        OutputLocation::Dialog => normalize_path(output_directory, "PNG 帧序列输出目录")?,
        OutputLocation::Source | OutputLocation::Subfolder => {
            let source = validate_source_file(source_path)?;
            let parent = source
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            if OutputLocation::Subfolder == OutputLocation::parse(output_location)? {
                parent.join(
                    normalize_subdirectory(output_subdirectory)?
                        .ok_or_else(|| "PNG 帧序列源文件夹子目录不能为空。".to_string())?,
                )
            } else {
                parent.to_path_buf()
            }
        }
        OutputLocation::Directory => normalize_path(
            specified_directory.ok_or_else(|| "PNG 帧序列输出目录不能为空。".to_string())?,
            "PNG 帧序列输出目录",
        )?,
    };
    validate_output_directory(&directory)?;
    Ok(directory)
}

fn normalize_path(value: &str, label: &str) -> Result<PathBuf, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{label}不能为空。"));
    }
    if value.len() > MAX_OUTPUT_PATH_BYTES {
        return Err(format!("{label}过长。"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{label}不能包含控制字符。"));
    }
    Ok(PathBuf::from(value))
}

fn ensure_extension(path: &Path, extension: &str) -> Result<(), String> {
    let expected = format!(".{extension}");
    if path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase().ends_with(&expected))
        != Some(true)
    {
        return Err(format!("GIF 输出文件必须使用 {expected} 扩展名。"));
    }
    Ok(())
}

fn normalize_output_name(
    value: Option<&str>,
    default_stem: Option<&str>,
    extension: &str,
) -> Result<String, String> {
    let supplied = value.is_some();
    let mut name = value
        .unwrap_or(default_stem.unwrap_or("animation"))
        .trim()
        .to_string();
    if name.is_empty() {
        if supplied {
            return Err("GIF 输出文件名不能为空。".to_string());
        }
        name = "animation".to_string();
    }
    if name.chars().any(char::is_control)
        || name.chars().any(|character| {
            matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
        })
        || name == "."
        || name == ".."
        || name.ends_with('.')
        || name.ends_with(' ')
    {
        return Err("GIF 输出文件名包含无效字符。".to_string());
    }
    if name.chars().count() > MAX_OUTPUT_NAME_CHARS {
        return Err("GIF 输出文件名过长。".to_string());
    }
    if is_reserved_windows_name(&name) {
        return Err("GIF 输出文件名不能使用 Windows 保留设备名。".to_string());
    }
    let suffix = format!(".{extension}");
    let has_wrong_extension = Path::new(&name)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|existing| !existing.eq_ignore_ascii_case(extension));
    if has_wrong_extension {
        return Err(format!("GIF 输出文件必须使用 {suffix} 扩展名。"));
    }
    if name.to_ascii_lowercase().ends_with(&suffix) {
        Ok(name)
    } else {
        name.push_str(&suffix);
        Ok(name)
    }
}

fn normalize_subdirectory(value: Option<&str>) -> Result<Option<String>, String> {
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
        return Err("GIF 输出子目录名称包含无效字符或路径越界。".to_string());
    }
    if is_reserved_windows_name(value) {
        return Err("GIF 输出子目录不能使用 Windows 保留设备名。".to_string());
    }
    Ok(Some(value.to_string()))
}

fn is_reserved_windows_name(value: &str) -> bool {
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

fn validate_source_file(value: Option<&str>) -> Result<PathBuf, String> {
    let path = normalize_path(
        value.ok_or_else(|| "GIF 源文件路径不能为空。".to_string())?,
        "GIF 源文件路径",
    )?;
    validate_path_chain(&path, true)?;
    Ok(path)
}

fn validate_path_chain(path: &Path, require_final: bool) -> Result<(), String> {
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
                    return Err("GIF 路径目录组件不能是 symlink 或 junction。".to_string());
                }
                if !is_final && !metadata.is_dir() {
                    return Err("GIF 路径目录组件必须是普通目录。".to_string());
                }
                if is_final && !metadata.is_file() {
                    return Err("GIF 路径末端类型不正确。".to_string());
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound && !require_final => {
                return Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err("GIF 路径不存在。".to_string())
            }
            Err(error) => return Err(format!("无法检查 GIF 路径：{error}")),
        }
    }
    Ok(())
}

pub(super) fn write_output(
    output: &Path,
    overwrite: bool,
    encode: impl FnOnce(&mut File) -> Result<(), String>,
) -> Result<(), String> {
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    validate_output_directory(parent)?;
    check_target(output, overwrite)?;
    if !parent.exists() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建 GIF 输出目录：{error}"))?;
        validate_output_directory(parent)?;
    }
    let mut temporary = TemporaryOutput::create(output)
        .map_err(|error| format!("无法创建 GIF 临时文件：{error}"))?;
    let file = temporary.file.as_mut().expect("temporary file is open");
    encode(file)?;
    file.sync_all()
        .map_err(|error| format!("无法完成 GIF 文件写入：{error}"))?;
    temporary.file.take();
    check_target(output, overwrite)?;
    let result = if overwrite {
        // 同目录 rename 在 Windows 使用 MoveFileExW(REPLACE_EXISTING)，失败时旧文件仍在原位。
        fs::rename(&temporary.path, output)
    } else {
        // hard_link 的 create-new 语义保护检查后才出现的同名目标；不支持硬链接时安全失败。
        fs::hard_link(&temporary.path, output)
    };
    if overwrite && result.is_ok() {
        temporary.cleanup = false;
    }
    result.map_err(|error| format!("无法保存 GIF 文件（同名目标可能已存在）：{error}"))
}

pub(super) fn validate_output_directory(directory: &Path) -> Result<(), String> {
    if directory.as_os_str().is_empty() {
        return Err("输出目录路径无效。".to_string());
    }
    let mut ancestors = directory
        .ancestors()
        .filter(|ancestor| !ancestor.as_os_str().is_empty())
        .collect::<Vec<_>>();
    ancestors.reverse();
    for ancestor in ancestors {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => validate_directory_metadata(ancestor)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => return Err(format!("无法检查输出目录：{error}")),
        }
    }
    Ok(())
}

fn validate_directory_metadata(directory: &Path) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(directory).map_err(|error| format!("无法检查输出目录：{error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || has_reparse_point(&metadata) {
        return Err("输出目录必须是普通目录，不能是 symlink 或 junction。".to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn has_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn has_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

pub(super) struct CheckedWriter<W> {
    inner: W,
    failure: Option<io::Error>,
}

impl<W: Write> CheckedWriter<W> {
    pub(super) fn new(inner: W) -> Self {
        Self {
            inner,
            failure: None,
        }
    }

    pub(super) fn finish(mut self) -> io::Result<()> {
        // image 0.24 只在 Drop 中写 trailer，底层 gif 会吞掉该次 I/O 错误。
        if let Some(error) = self.failure.take() {
            return Err(error);
        }
        self.inner.flush()
    }
}

impl<W: Write> Write for CheckedWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let result = match self.inner.write(buffer) {
            Ok(0) if !buffer.is_empty() => Err(io::ErrorKind::WriteZero.into()),
            result => result,
        };
        if let Err(error) = &result {
            if error.kind() != io::ErrorKind::Interrupted && self.failure.is_none() {
                self.failure = Some(io::Error::new(error.kind(), error.to_string()));
            }
        }
        result
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_output_name, normalize_subdirectory, validate_output_directory};
    use std::fs;

    #[test]
    fn rejects_a_file_as_an_output_directory() {
        let path = std::env::temp_dir().join(format!(
            "embedpix-output-directory-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        fs::write(&path, b"not a directory").expect("test output marker");
        assert!(validate_output_directory(&path).is_err());
        fs::remove_file(path).expect("remove test output marker");
    }

    #[test]
    fn rejects_a_file_in_an_output_directory_path() {
        let root = std::env::temp_dir().join(format!(
            "embedpix-output-directory-parent-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create test root");
        fs::write(root.join("not-a-directory"), b"test marker").expect("test output marker");

        let nested = root.join("not-a-directory").join("nested");
        assert!(validate_output_directory(&nested).is_err());

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn rejects_windows_device_names_for_output_names_and_subdirectories() {
        for name in ["CON", "NUL", "COM1", "LPT9", "CON.gif"] {
            assert!(normalize_output_name(Some(name), None, "gif").is_err());
        }
        for name in ["CON", "NUL", "COM1", "LPT9", "CON.backup"] {
            assert!(normalize_subdirectory(Some(name)).is_err());
        }
    }
}
