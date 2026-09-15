use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

const UPDATE_PROGRESS_EVENT: &str = "update-download-progress";
const RELEASE_HOST: &str = "github.com";
const API_HOST: &str = "api.github.com";
const RELEASE_OWNER: &str = "Mamekokwai";
const RELEASE_REPOSITORY: &str = "EmbedPix";
const MAX_UPDATE_BYTES: u64 = 128 * 1024 * 1024;
const UPDATE_CACHE_DIR: &str = "updates";
const UPDATE_FILE_PREFIX: &str = "EmbedPix-update-";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadProgress {
    pub status: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedUpdate {
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub release_notes: Option<String>,
    pub release_date: Option<String>,
    pub release_url: String,
    pub asset_download_url: Option<String>,
    pub asset_sha256: Option<String>,
    pub asset_size_bytes: Option<u64>,
    pub update_available: bool,
}

#[derive(Debug)]
struct ProgressSnapshot {
    active: bool,
    progress: UpdateDownloadProgress,
}

#[derive(Debug)]
pub struct UpdateProgressState(Mutex<ProgressSnapshot>);

impl Default for UpdateProgressState {
    fn default() -> Self {
        Self(Mutex::new(ProgressSnapshot {
            active: false,
            progress: UpdateDownloadProgress {
                status: "idle".to_string(),
                downloaded_bytes: 0,
                total_bytes: None,
                error: None,
            },
        }))
    }
}

#[derive(Debug, Deserialize)]
struct ReleaseResponse {
    tag_name: String,
    body: Option<String>,
    published_at: Option<String>,
    html_url: Option<String>,
    draft: bool,
    prerelease: bool,
    assets: Vec<ReleaseAsset>,
}

#[derive(Clone, Debug, Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
    size: u64,
}

#[derive(Clone, Debug)]
struct TrustedAsset {
    url: Url,
    digest_text: String,
    size: u64,
}

async fn fetch_latest_release(client: &reqwest::Client) -> Result<ReleaseResponse, String> {
    let response = client
        .get(format!(
            "https://{API_HOST}/repos/{RELEASE_OWNER}/{RELEASE_REPOSITORY}/releases/latest"
        ))
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("无法连接更新服务：{error}"))?;
    if response.url().scheme() != "https" || response.url().host_str() != Some(API_HOST) {
        return Err("更新服务地址不受信任。".to_string());
    }
    if !response.status().is_success() {
        return Err(format!(
            "更新服务暂时不可用（HTTP {}）。",
            response.status()
        ));
    }
    response
        .json::<ReleaseResponse>()
        .await
        .map_err(|error| format!("无法解析更新服务返回的数据：{error}"))
}

#[tauri::command]
pub async fn check_update(current_version: String) -> Result<UpdateCheckResult, String> {
    let current_version = normalize_version(&current_version)?;
    let client = reqwest::Client::builder()
        .user_agent(format!("EmbedPix/{current_version}"))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("无法初始化更新检查：{error}"))?;
    let release = fetch_latest_release(&client).await?;
    if release.draft || release.prerelease {
        return Err("更新服务返回了不可用的发布版本。".to_string());
    }

    let latest_version = normalize_version(&release.tag_name)?;
    let asset = select_trusted_asset(&release.assets, &latest_version);
    let release_url = release
        .html_url
        .filter(|url| is_trusted_release_page_url(url, &latest_version))
        .unwrap_or_else(|| {
            format!(
                "https://{RELEASE_HOST}/{RELEASE_OWNER}/{RELEASE_REPOSITORY}/releases/tag/v{latest_version}"
            )
        });

    Ok(UpdateCheckResult {
        update_available: compare_versions(&latest_version, &current_version) > 0,
        current_version,
        latest_version,
        release_notes: release.body.filter(|body| !body.trim().is_empty()),
        release_date: release.published_at,
        release_url,
        asset_download_url: asset.as_ref().map(|asset| asset.url.to_string()),
        asset_sha256: asset.as_ref().map(|asset| asset.digest_text.clone()),
        asset_size_bytes: asset.map(|asset| asset.size),
    })
}

#[tauri::command]
pub fn get_update_download_progress(
    state: State<'_, UpdateProgressState>,
) -> Result<UpdateDownloadProgress, String> {
    state
        .0
        .lock()
        .map(|snapshot| snapshot.progress.clone())
        .map_err(|_| "更新进度状态不可用。".to_string())
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    state: State<'_, UpdateProgressState>,
    asset_url: String,
    expected_sha256: String,
    version: String,
    expected_size: Option<u64>,
) -> Result<DownloadedUpdate, String> {
    let version = normalize_version(&version)?;
    let validated_url = validate_asset_url(&asset_url, &version)?;
    let expected_digest = parse_sha256(&expected_sha256)?;
    let current_version = normalize_version(env!("CARGO_PKG_VERSION"))?;
    if compare_versions(&version, &current_version) <= 0 {
        return Err("更新版本不是高于当前版本的稳定版本。".to_string());
    }
    let client = reqwest::Client::builder()
        .user_agent(format!("EmbedPix/{current_version}"))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("无法初始化更新检查：{error}"))?;
    let release = fetch_latest_release(&client).await?;
    if release.draft || release.prerelease {
        return Err("更新服务返回了不可用的发布版本。".to_string());
    }
    let latest_version = normalize_version(&release.tag_name)?;
    let trusted_asset = select_trusted_asset(&release.assets, &latest_version)
        .ok_or_else(|| "最新 Release 没有可验证的 EmbedPix 安装包。".to_string())?;
    let trusted_digest = parse_sha256(&trusted_asset.digest_text)?;
    if latest_version != version
        || compare_versions(&latest_version, &current_version) <= 0
        || trusted_asset.url != validated_url
        || trusted_digest != expected_digest
        || expected_size.is_some_and(|size| size != trusted_asset.size)
    {
        return Err("更新元数据已变化，请重新检查更新。".to_string());
    }
    let expected_size = Some(trusted_asset.size);
    begin_download(&state)?;

    let result = download_update_inner(
        &app,
        &state,
        validated_url,
        expected_digest,
        &version,
        expected_size,
    )
    .await;
    match result {
        Ok(downloaded) => {
            finish_download(
                &app,
                &state,
                "complete",
                None,
                downloaded.size_bytes,
                Some(downloaded.size_bytes),
            );
            Ok(downloaded)
        }
        Err(error) => {
            finish_download(&app, &state, "error", Some(error.clone()), 0, expected_size);
            Err(error)
        }
    }
}

async fn download_update_inner(
    app: &AppHandle,
    state: &State<'_, UpdateProgressState>,
    validated_url: Url,
    expected_digest: Vec<u8>,
    version: &str,
    expected_size: Option<u64>,
) -> Result<DownloadedUpdate, String> {
    let cache_dir = update_cache_dir(app)?;
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|error| format!("无法创建更新缓存目录：{error}"))?;
    let path = cache_dir.join(update_file_name(version)?);
    let part_path = PathBuf::from(format!("{}.part", path.to_string_lossy()));
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&part_path)
        .await
        .map_err(|error| format!("无法创建更新临时文件：{error}"))?;

    let result = async {
        let client = reqwest::Client::builder()
            .user_agent(format!("EmbedPix/{version}"))
            .timeout(Duration::from_secs(120))
            .redirect(reqwest::redirect::Policy::custom({
                let version = version.to_string();
                move |attempt| {
                    if is_allowed_redirect_url(attempt.url(), &version) {
                        attempt.follow()
                    } else {
                        attempt.stop()
                    }
                }
            }))
            .build()
            .map_err(|error| format!("无法初始化更新下载器：{error}"))?;
        let response = client
            .get(validated_url)
            .send()
            .await
            .map_err(|error| format!("无法下载更新：{error}"))?;
        if !response.status().is_success()
            || !is_allowed_final_download_url(response.url(), version)
        {
            return Err(format!("更新下载服务返回 HTTP {}。", response.status()));
        }

        let response_size = response.content_length();
        validate_download_size(response_size, expected_size)?;
        let total_bytes = expected_size.or(response_size);
        let mut downloaded_bytes = 0_u64;
        let mut hasher = Sha256::new();
        let mut response = response;
        set_progress(app, state, "downloading", 0, total_bytes, None);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("更新下载中断：{error}"))?
        {
            downloaded_bytes = downloaded_bytes
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| "更新安装包大小无效。".to_string())?;
            if downloaded_bytes > MAX_UPDATE_BYTES {
                return Err("更新安装包超过安全大小限制。".to_string());
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("无法保存更新安装包：{error}"))?;
            set_progress(
                app,
                state,
                "downloading",
                downloaded_bytes,
                total_bytes,
                None,
            );
        }
        file.flush()
            .await
            .map_err(|error| format!("无法完成更新安装包写入：{error}"))?;
        file.sync_all()
            .await
            .map_err(|error| format!("无法同步更新安装包：{error}"))?;
        drop(file);

        if expected_size.is_some_and(|size| size != downloaded_bytes)
            || response_size.is_some_and(|size| size != downloaded_bytes)
        {
            return Err("更新安装包大小校验失败，请重新下载。".to_string());
        }
        let actual_digest = hasher.finalize();
        if actual_digest.as_slice() != expected_digest.as_slice() {
            return Err("更新安装包校验失败，请重新检查更新。".to_string());
        }
        tokio::fs::rename(&part_path, &path)
            .await
            .map_err(|error| format!("无法原子提交更新安装包：{error}"))?;
        Ok(DownloadedUpdate {
            path: path.to_string_lossy().into_owned(),
            size_bytes: downloaded_bytes,
        })
    }
    .await;

    if result.is_err() {
        let _ = tokio::fs::remove_file(&part_path).await;
    }
    result
}

#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    package_path: String,
    expected_sha256: String,
    version: String,
    expected_size: Option<u64>,
    user_confirmed: Option<bool>,
) -> Result<(), String> {
    if user_confirmed != Some(true) {
        return Err("启动更新前需要用户确认。".to_string());
    }
    let expected_digest = parse_sha256(&expected_sha256)?;
    let version = normalize_version(&version)?;
    let app_for_install = app.clone();
    tokio::task::spawn_blocking(move || {
        let package_path =
            validate_cached_package(&app_for_install, Path::new(&package_path), &version)?;
        let metadata = std::fs::metadata(&package_path)
            .map_err(|_| "更新安装包不可读，请重新下载。".to_string())?;
        let actual_size = metadata.len();
        validate_download_size(Some(actual_size), expected_size)?;
        let bytes = std::fs::read(&package_path)
            .map_err(|_| "更新安装包不可读，请重新下载。".to_string())?;
        let actual_digest = Sha256::digest(&bytes);
        if actual_digest.as_slice() != expected_digest.as_slice() {
            return Err("更新安装包已发生变化，请重新下载。".to_string());
        }

        #[cfg(windows)]
        {
            Command::new(&package_path)
                .spawn()
                .map_err(|error| format!("无法启动更新安装程序：{error}"))?;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = Command::new(&package_path);
            Err("当前平台暂不支持启动 Windows 更新安装程序。".to_string())
        }
    })
    .await
    .map_err(|error| format!("更新安装任务异常：{error}"))??;

    #[cfg(windows)]
    app.exit(0);
    Ok(())
}

fn begin_download(state: &State<'_, UpdateProgressState>) -> Result<(), String> {
    let mut snapshot = state
        .0
        .lock()
        .map_err(|_| "更新进度状态不可用。".to_string())?;
    if snapshot.active {
        return Err("已有更新正在下载，请稍候。".to_string());
    }
    snapshot.active = true;
    snapshot.progress = UpdateDownloadProgress {
        status: "starting".to_string(),
        downloaded_bytes: 0,
        total_bytes: None,
        error: None,
    };
    Ok(())
}

fn finish_download(
    app: &AppHandle,
    state: &State<'_, UpdateProgressState>,
    status: &str,
    error: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
) {
    set_progress(app, state, status, downloaded_bytes, total_bytes, error);
    if let Ok(mut snapshot) = state.0.lock() {
        snapshot.active = false;
    }
}

fn set_progress(
    app: &AppHandle,
    state: &State<'_, UpdateProgressState>,
    status: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    error: Option<String>,
) {
    let progress = UpdateDownloadProgress {
        status: status.to_string(),
        downloaded_bytes,
        total_bytes,
        error,
    };
    if let Ok(mut snapshot) = state.0.lock() {
        snapshot.progress = progress.clone();
    }
    if let Err(error) = app.emit(UPDATE_PROGRESS_EVENT, progress) {
        eprintln!("[updater] failed to emit download progress: {error}");
    }
}

fn validate_download_size(
    response_size: Option<u64>,
    expected_size: Option<u64>,
) -> Result<(), String> {
    if response_size.is_some_and(|size| size == 0 || size > MAX_UPDATE_BYTES)
        || expected_size.is_some_and(|size| size == 0 || size > MAX_UPDATE_BYTES)
        || matches!((response_size, expected_size), (Some(actual), Some(expected)) if actual != expected)
    {
        return Err("更新安装包大小校验失败。".to_string());
    }
    Ok(())
}

fn is_allowed_redirect_url(url: &Url, version: &str) -> bool {
    if !is_allowed_download_host(url) {
        return false;
    }
    url.host_str() != Some(RELEASE_HOST) || is_trusted_release_asset_url(url, version)
}

fn is_allowed_final_download_url(url: &Url, version: &str) -> bool {
    is_allowed_redirect_url(url, version)
}

fn is_allowed_download_host(url: &Url) -> bool {
    url.scheme() == "https"
        && matches!(
            url.host_str(),
            Some(RELEASE_HOST)
                | Some("release-assets.githubusercontent.com")
                | Some("objects.githubusercontent.com")
        )
}

fn validate_asset_url(value: &str, version: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "更新资产地址无效。".to_string())?;
    if !is_trusted_release_asset_url(&url, version) {
        return Err("更新资产不是 EmbedPix 的受信任安装包。".to_string());
    }
    Ok(url)
}

fn is_trusted_release_asset_url(url: &Url, version: &str) -> bool {
    if url.scheme() != "https"
        || url.host_str() != Some(RELEASE_HOST)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    let Ok(version) = normalize_version(version) else {
        return false;
    };
    let expected_name = format!("EmbedPix_{version}_x64-setup.exe");
    let Some(segments) = url.path_segments() else {
        return false;
    };
    let segments = segments.collect::<Vec<_>>();
    segments.len() == 6
        && segments[0] == RELEASE_OWNER
        && segments[1] == RELEASE_REPOSITORY
        && segments[2] == "releases"
        && segments[3] == "download"
        && normalize_version(segments[4]).is_ok_and(|tag| tag == version)
        && segments[5] == expected_name
}

fn is_trusted_release_page_url(value: &str, version: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https"
        || url.host_str() != Some(RELEASE_HOST)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    let Ok(version) = normalize_version(version) else {
        return false;
    };
    let Some(segments) = url.path_segments() else {
        return false;
    };
    let segments = segments.collect::<Vec<_>>();
    segments.len() == 5
        && segments[0] == RELEASE_OWNER
        && segments[1] == RELEASE_REPOSITORY
        && segments[2] == "releases"
        && segments[3] == "tag"
        && segments[4] == format!("v{version}")
}

fn select_trusted_asset(assets: &[ReleaseAsset], version: &str) -> Option<TrustedAsset> {
    let expected_name = release_asset_file_name(version).ok()?;
    assets.iter().find_map(|asset| {
        if asset.name != expected_name || asset.size == 0 || asset.size > MAX_UPDATE_BYTES {
            return None;
        }
        let url = validate_asset_url(&asset.browser_download_url, version).ok()?;
        let digest_text = asset.digest.as_deref()?.to_ascii_lowercase();
        parse_sha256(&digest_text).ok()?;
        Some(TrustedAsset {
            url,
            digest_text,
            size: asset.size,
        })
    })
}

fn update_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join(UPDATE_CACHE_DIR))
        .map_err(|error| format!("无法定位更新缓存目录：{error}"))
}

fn update_file_name(version: &str) -> Result<String, String> {
    let version = normalize_version(version)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时间无效。".to_string())?
        .as_millis();
    Ok(format!(
        "{UPDATE_FILE_PREFIX}{version}-{timestamp}-{}.exe",
        std::process::id()
    ))
}

fn release_asset_file_name(version: &str) -> Result<String, String> {
    Ok(format!(
        "EmbedPix_{}_x64-setup.exe",
        normalize_version(version)?
    ))
}

fn validate_cached_package(
    app: &AppHandle,
    package_path: &Path,
    version: &str,
) -> Result<PathBuf, String> {
    let cache_dir = update_cache_dir(app)?;
    let canonical_cache =
        std::fs::canonicalize(&cache_dir).map_err(|_| "更新缓存目录不可用。".to_string())?;
    let metadata = std::fs::symlink_metadata(package_path)
        .map_err(|_| "更新安装包不存在，请重新下载。".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || has_reparse_point(&metadata) {
        return Err("更新安装包路径不安全。".to_string());
    }
    let canonical_package = std::fs::canonicalize(package_path)
        .map_err(|_| "更新安装包不可用，请重新下载。".to_string())?;
    let file_name = canonical_package
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "更新安装包文件名无效。".to_string())?;
    if canonical_package.parent() != Some(canonical_cache.as_path())
        || !is_generated_update_file_name(file_name, version)
        || !file_name.ends_with(".exe")
    {
        return Err("更新安装包路径不安全。".to_string());
    }
    Ok(canonical_package)
}

#[cfg(windows)]
fn has_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn has_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn is_generated_update_file_name(file_name: &str, version: &str) -> bool {
    let Ok(version) = normalize_version(version) else {
        return false;
    };
    let Some(remainder) = file_name
        .strip_prefix(&format!("{UPDATE_FILE_PREFIX}{version}-"))
        .and_then(|name| name.strip_suffix(".exe"))
    else {
        return false;
    };
    let mut components = remainder.split('-');
    let Some(timestamp) = components.next() else {
        return false;
    };
    let Some(process_id) = components.next() else {
        return false;
    };
    components.next().is_none()
        && !timestamp.is_empty()
        && timestamp
            .chars()
            .all(|character| character.is_ascii_digit())
        && !process_id.is_empty()
        && process_id
            .chars()
            .all(|character| character.is_ascii_digit())
}

fn normalize_version(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let normalized = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    let parts = normalized.split('.').collect::<Vec<_>>();
    if parts.len() != 3
        || parts.iter().any(|part| {
            part.is_empty()
                || !part.chars().all(|character| character.is_ascii_digit())
                || part.parse::<u64>().is_err()
        })
    {
        return Err("更新版本号无效。".to_string());
    }
    Ok(normalized.to_string())
}

fn compare_versions(left: &str, right: &str) -> i8 {
    let left = left.split('.').map(|part| part.parse::<u64>().unwrap_or(0));
    let right = right
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0));
    match left.cmp(right) {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    }
}

fn parse_sha256(value: &str) -> Result<Vec<u8>, String> {
    let hex = value.strip_prefix("sha256:").unwrap_or(value);
    if hex.len() != 64 || !hex.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err("更新安装包缺少有效校验摘要。".to_string());
    }
    (0..hex.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&hex[index..index + 2], 16)
                .map_err(|_| "更新安装包校验摘要无效。".to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        compare_versions, is_trusted_release_page_url, normalize_version, parse_sha256,
        select_trusted_asset, validate_asset_url, ReleaseAsset,
    };

    #[test]
    fn accepts_only_embedpix_release_installer_urls() {
        assert!(validate_asset_url(
            "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.1.2/EmbedPix_0.1.2_x64-setup.exe",
            "0.1.2"
        )
        .is_ok());
        assert!(validate_asset_url(
            "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.1.2/EmbedPix-update-0.1.2-1.exe",
            "0.1.2"
        )
        .is_err());
    }

    #[test]
    fn rejects_cross_repository_version_mismatch_and_parameters() {
        for url in [
            "https://github.com/other/EmbedPix/releases/download/v0.1.2/EmbedPix_0.1.2_x64-setup.exe",
            "http://github.com/Mamekokwai/EmbedPix/releases/download/v0.1.2/EmbedPix_0.1.2_x64-setup.exe",
            "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.1.3/EmbedPix_0.1.3_x64-setup.exe",
            "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.1.2/EmbedPix_0.1.2_x64-setup.exe?download=1",
        ] {
            assert!(validate_asset_url(url, "0.1.2").is_err());
        }
    }

    #[test]
    fn accepts_only_trusted_release_page() {
        assert!(is_trusted_release_page_url(
            "https://github.com/Mamekokwai/EmbedPix/releases/tag/v0.1.2",
            "0.1.2"
        ));
        assert!(!is_trusted_release_page_url(
            "https://example.com/Mamekokwai/EmbedPix/releases/tag/v0.1.2",
            "0.1.2"
        ));
    }

    #[test]
    fn requires_matching_asset_name_digest_and_size() {
        let digest = format!("sha256:{}", "a".repeat(64));
        let assets = vec![ReleaseAsset {
            name: "EmbedPix_0.1.2_x64-setup.exe".to_string(),
            browser_download_url: "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.1.2/EmbedPix_0.1.2_x64-setup.exe".to_string(),
            digest: Some(digest.clone()),
            size: 1024,
        }];
        let asset = select_trusted_asset(&assets, "0.1.2").expect("trusted asset");
        assert_eq!(asset.size, 1024);
        assert_eq!(asset.digest_text, digest);
        assert!(select_trusted_asset(
            &[ReleaseAsset {
                digest: None,
                ..assets[0].clone()
            }],
            "0.1.2"
        )
        .is_none());
    }

    #[test]
    fn validates_versions_and_sha256_digests() {
        assert_eq!(normalize_version("v1.2.3").unwrap(), "1.2.3");
        assert!(normalize_version("1.2").is_err());
        assert_eq!(
            parse_sha256(&format!("sha256:{}", "a".repeat(64)))
                .unwrap()
                .len(),
            32
        );
        assert!(parse_sha256("not-a-digest").is_err());
        assert_eq!(compare_versions("1.10.0", "1.2.0"), 1);
    }
}
