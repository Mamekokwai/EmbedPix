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
    let items = request
        .target_paths
        .iter()
        .map(|target| inspect_target(Path::new(target)))
        .collect();
    Ok(ExportPreflightResult {
        supported: true,
        disk_space_checked: false,
        available_bytes: None,
        disk_space_sufficient: None,
        items,
    })
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

    fn tempfile_dir() -> PathBuf {
        let path =
            test_temp_dir().join(format!("embedpix-preflight-fixture-{}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }
}
