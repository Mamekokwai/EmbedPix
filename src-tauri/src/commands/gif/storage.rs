use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

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
    let mut existing = directory.to_path_buf();
    loop {
        match fs::symlink_metadata(&existing) {
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if !existing.pop() {
                    return Err("输出目录路径无效。".to_string());
                }
            }
            Err(error) => return Err(format!("无法检查输出目录：{error}")),
        }
    }
    validate_directory_metadata(&existing)?;
    match fs::symlink_metadata(directory) {
        Ok(_) => validate_directory_metadata(directory)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("无法检查输出目录：{error}")),
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
    use super::validate_output_directory;
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
}
