use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreflightRequest {
    pub target_paths: Vec<String>,
    pub estimated_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreflightItem {
    pub target_path: String,
    pub target_exists: bool,
    pub parent_exists: bool,
    pub parent_writable: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct DiskSpace {
    available_bytes: u64,
    sufficient: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreflightResult {
    pub supported: bool,
    pub disk_space_checked: bool,
    pub available_bytes: Option<u64>,
    pub disk_space_sufficient: Option<bool>,
    pub items: Vec<ExportPreflightItem>,
}

#[tauri::command]
pub fn preflight_image_exports(
    request: ExportPreflightRequest,
) -> Result<ExportPreflightResult, String> {
    let disk_space = if request.estimated_bytes == 0 {
        None
    } else {
        request
            .target_paths
            .iter()
            .filter_map(|target| disk_space_for_path(Path::new(target), request.estimated_bytes))
            .next()
    };
    let mut items = request
        .target_paths
        .iter()
        .map(|target| inspect_target(Path::new(target)))
        .collect::<Vec<_>>();
    if let Some(_space) = disk_space.filter(|space| !space.sufficient) {
        for item in &mut items {
            if item.parent_exists {
                item.reason = Some("可用磁盘空间不足。".to_string());
            }
        }
    }
    Ok(ExportPreflightResult {
        supported: true,
        disk_space_checked: disk_space.is_some(),
        available_bytes: disk_space.map(|space| space.available_bytes),
        disk_space_sufficient: disk_space.map(|space| space.sufficient),
        items,
    })
}

#[cfg(any(windows, test))]
#[allow(dead_code)]
fn evaluate_disk_space(available_bytes: u64, estimated_bytes: u64) -> DiskSpace {
    DiskSpace {
        available_bytes,
        sufficient: available_bytes >= estimated_bytes,
    }
}

fn disk_space_for_path(path: &Path, estimated_bytes: u64) -> Option<DiskSpace> {
    let mut existing = path.to_path_buf();
    while !existing.exists() {
        if !existing.pop() {
            return None;
        }
    }
    disk_space_for_existing_path(&existing, estimated_bytes)
}

#[cfg(windows)]
fn disk_space_for_existing_path(path: &Path, estimated_bytes: u64) -> Option<DiskSpace> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    wide.push(0);
    let mut available = 0u64;
    let success = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (success != 0).then_some(evaluate_disk_space(available, estimated_bytes))
}

#[cfg(not(windows))]
fn disk_space_for_existing_path(_path: &Path, _estimated_bytes: u64) -> Option<DiskSpace> {
    None
}

fn inspect_target(path: &Path) -> ExportPreflightItem {
    let target_path = path.to_string_lossy().into_owned();
    let target_exists = path.exists();
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent_exists = parent.is_dir();
    let parent_writable = parent_exists && can_create_temporary_file(parent);
    let reason = if !parent_exists {
        Some("输出目录不存在。".to_string())
    } else if !parent_writable {
        Some("输出目录不可写。".to_string())
    } else if target_exists {
        Some("输出文件已存在。".to_string())
    } else {
        None
    };
    ExportPreflightItem {
        target_path,
        target_exists,
        parent_exists,
        parent_writable,
        reason,
    }
}

fn can_create_temporary_file(parent: &Path) -> bool {
    let mut path = PathBuf::from(parent);
    path.push(format!(".embedpix-preflight-{}", std::process::id()));
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(_) => {
            let _ = fs::remove_file(path);
            true
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => false,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_temp_dir;

    #[test]
    fn reports_missing_parent_without_creating_it() {
        let root = test_temp_dir().join(format!("embedpix-preflight-{}", std::process::id()));
        let target = root.join("missing").join("image.png");
        let item = inspect_target(&target);
        assert!(!item.parent_exists);
        assert!(!root.exists());
        assert_eq!(item.reason.as_deref(), Some("输出目录不存在。"));
    }

    #[test]
    fn reports_existing_target_and_keeps_fixture_intact() {
        let root = tempfile_dir();
        let target = root.join("image.png");
        fs::write(&target, b"fixture").unwrap();
        let item = inspect_target(&target);
        assert!(item.target_exists);
        assert!(item.parent_writable);
        assert_eq!(item.reason.as_deref(), Some("输出文件已存在。"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn evaluates_low_and_high_space_estimates_without_touching_disk() {
        assert!(evaluate_disk_space(100, 99).sufficient);
        assert!(!evaluate_disk_space(100, 101).sufficient);
    }

    #[cfg(not(windows))]
    #[test]
    fn leaves_disk_space_unchecked_when_native_api_is_unavailable() {
        assert!(disk_space_for_existing_path(Path::new("."), 1).is_none());
    }

    fn tempfile_dir() -> PathBuf {
        let path =
            test_temp_dir().join(format!("embedpix-preflight-fixture-{}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }
}
