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
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
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
    check_target(output, overwrite)?;
    if let Some(parent) = output.parent().filter(|path| !path.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建 GIF 输出目录：{error}"))?;
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
