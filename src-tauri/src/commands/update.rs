use std::cmp::Ordering;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

use super::path_security;

const UPDATE_PROGRESS_EVENT: &str = "update-download-progress";
const RELEASE_HOST: &str = "github.com";
const API_HOST: &str = "api.github.com";
const RELEASE_OWNER: &str = "Mamekokwai";
const RELEASE_REPOSITORY: &str = "EmbedPix";
const MAX_UPDATE_BYTES: u64 = 128 * 1024 * 1024;
const UPDATE_CACHE_DIR: &str = "updates";
const UPDATE_FILE_PREFIX: &str = "EmbedPix-update-";
const UPDATE_PUBLIC_KEY: &str = include_str!("../../update-public-key.txt");

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

struct VerifiedPackage {
    path: PathBuf,
    _file: File,
}

fn decode_signature_text(value: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|_| "更新安装包签名编码无效。".to_string())?;
    String::from_utf8(bytes).map_err(|_| "更新安装包签名内容无效。".to_string())
}

fn verify_signature(
    data: &[u8],
    encoded_signature: &str,
    encoded_public_key: &str,
) -> Result<(), String> {
    let public_key = PublicKey::decode(&decode_signature_text(encoded_public_key)?)
        .map_err(|_| "更新公钥配置无效。".to_string())?;
    let signature = Signature::decode(&decode_signature_text(encoded_signature)?)
        .map_err(|_| "更新安装包签名无效。".to_string())?;
    public_key
        .verify(data, &signature, true)
        .map_err(|_| "更新安装包签名验证失败。".to_string())
}

fn updater_public_key() -> Result<String, String> {
    Ok(UPDATE_PUBLIC_KEY.to_string())
}

fn verify_update_signature(data: &[u8], encoded_signature: &str) -> Result<(), String> {
    let public_key = updater_public_key()?;
    verify_signature(data, encoded_signature, &public_key)
}

fn signature_url_for_asset(asset_url: &Url) -> Result<Url, String> {
    if asset_url.query().is_some() || asset_url.fragment().is_some() {
        return Err("更新安装包地址包含无效参数。".to_string());
    }
    let mut signature_url = asset_url.clone();
    signature_url.set_path(&format!("{}.sig", asset_url.path()));
    Ok(signature_url)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UpdateTarget {
    WindowsX64,
    WindowsArm64,
    MacosX64,
    MacosArm64,
    LinuxX64,
    LinuxArm64,
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
    let signature_url = signature_url_for_asset(&validated_url)?;
    begin_download(&state)?;

    let result = download_update_inner(
        &app,
        &state,
        validated_url,
        signature_url,
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
    signature_url: Url,
    expected_digest: Vec<u8>,
    version: &str,
    expected_size: Option<u64>,
) -> Result<DownloadedUpdate, String> {
    let cache_dir = update_cache_dir(app)?;
    path_security::validate_output_directory(&cache_dir)
        .map_err(|_| "更新缓存目录路径不安全。".to_string())?;
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|error| format!("无法创建更新缓存目录：{error}"))?;
    validate_update_cache_dir(&cache_dir)?;
    let path = cache_dir.join(update_file_name(version)?);
    let part_path = PathBuf::from(format!("{}.part", path.to_string_lossy()));
    let signature_path = PathBuf::from(format!("{}.sig", path.to_string_lossy()));
    let signature_part_path = PathBuf::from(format!("{}.part", signature_path.to_string_lossy()));
    // A previous process can leave only the temporary download marker behind; it is safe to replace it because downloads are serialized by the app state.
    let _ = tokio::fs::remove_file(&part_path).await;
    let _ = tokio::fs::remove_file(&signature_part_path).await;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&part_path)
        .await
        .map_err(|error| format!("无法创建更新临时文件：{error}"))?;
    let mut signature_committed = false;
    let mut package_committed = false;

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
        let signature_response = client
            .get(signature_url)
            .send()
            .await
            .map_err(|error| format!("无法下载更新签名：{error}"))?;
        let signature_response_url = signature_response.url().clone();
        if !signature_response.status().is_success()
            || !is_allowed_download_host(&signature_response_url)
        {
            return Err(format!(
                "更新签名服务返回 HTTP {}。",
                signature_response.status()
            ));
        }
        let signature_text = signature_response
            .text()
            .await
            .map_err(|error| format!("无法读取更新签名：{error}"))?;
        let _ = decode_signature_text(&signature_text)?;

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
        let package_bytes = tokio::fs::read(&part_path)
            .await
            .map_err(|error| format!("无法读取更新安装包进行签名验证：{error}"))?;
        verify_update_signature(&package_bytes, &signature_text)?;

        let mut signature_file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&signature_part_path)
            .await
            .map_err(|error| format!("无法保存更新签名：{error}"))?;
        signature_file
            .write_all(signature_text.trim().as_bytes())
            .await
            .map_err(|error| format!("无法保存更新签名：{error}"))?;
        signature_file
            .sync_all()
            .await
            .map_err(|error| format!("无法同步更新签名：{error}"))?;
        drop(signature_file);
        tokio::fs::rename(&signature_part_path, &signature_path)
            .await
            .map_err(|error| format!("无法原子提交更新签名：{error}"))?;
        signature_committed = true;
        tokio::fs::rename(&part_path, &path)
            .await
            .map_err(|error| format!("无法原子提交更新安装包：{error}"))?;
        package_committed = true;
        Ok(DownloadedUpdate {
            path: path.to_string_lossy().into_owned(),
            size_bytes: downloaded_bytes,
        })
    }
    .await;

    if result.is_err() {
        let _ = tokio::fs::remove_file(&part_path).await;
        let _ = tokio::fs::remove_file(&signature_part_path).await;
        if signature_committed {
            let _ = tokio::fs::remove_file(&signature_path).await;
        }
        if package_committed {
            let _ = tokio::fs::remove_file(&path).await;
        }
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
        let verified = open_verified_cached_package(
            &app_for_install,
            Path::new(&package_path),
            &version,
            &expected_digest,
            expected_size,
        )?;
        let package_path = &verified.path;

        #[cfg(windows)]
        {
            Command::new(package_path)
                .spawn()
                .map_err(|error| format!("无法启动更新安装程序：{error}"))?;
            Ok::<(), String>(())
        }
        #[cfg(not(windows))]
        {
            let _ = Command::new(package_path);
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
    if !is_trusted_release_asset_url_any_target(&url, version) {
        return Err("更新资产不是 EmbedPix 的受信任安装包。".to_string());
    }
    Ok(url)
}

fn is_trusted_release_asset_url(url: &Url, version: &str) -> bool {
    let Some(target) = current_update_target() else {
        return false;
    };
    is_trusted_release_asset_url_for_target(url, version, target)
}

fn is_trusted_release_asset_url_for_target(url: &Url, version: &str, target: UpdateTarget) -> bool {
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
    segments.len() == 6
        && segments[0] == RELEASE_OWNER
        && segments[1] == RELEASE_REPOSITORY
        && segments[2] == "releases"
        && segments[3] == "download"
        && normalize_version(segments[4]).is_ok_and(|tag| tag == version)
        && is_supported_asset_name(segments[5], &version, target)
}

fn is_trusted_release_asset_url_any_target(url: &Url, version: &str) -> bool {
    [
        UpdateTarget::WindowsX64,
        UpdateTarget::WindowsArm64,
        UpdateTarget::MacosX64,
        UpdateTarget::MacosArm64,
        UpdateTarget::LinuxX64,
        UpdateTarget::LinuxArm64,
    ]
    .into_iter()
    .any(|target| is_trusted_release_asset_url_for_target(url, version, target))
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
    current_update_target()
        .and_then(|target| select_trusted_asset_for_target(assets, version, target))
}

fn select_trusted_asset_for_target(
    assets: &[ReleaseAsset],
    version: &str,
    target: UpdateTarget,
) -> Option<TrustedAsset> {
    assets
        .iter()
        .enumerate()
        .filter_map(|(index, asset)| {
            if asset.size == 0
                || asset.size > MAX_UPDATE_BYTES
                || !is_supported_asset_name(&asset.name, version, target)
            {
                return None;
            }
            let url = Url::parse(&asset.browser_download_url).ok()?;
            if !is_trusted_release_asset_url_for_target(&url, version, target) {
                return None;
            }
            let digest_text = asset.digest.as_deref()?.to_ascii_lowercase();
            parse_sha256(&digest_text).ok()?;
            Some((
                asset_priority(&asset.name, version, target),
                index,
                TrustedAsset {
                    url,
                    digest_text,
                    size: asset.size,
                },
            ))
        })
        .min_by_key(|(priority, index, _)| (*priority, *index))
        .map(|(_, _, asset)| asset)
}

#[cfg(all(windows, target_arch = "x86_64"))]
fn current_update_target() -> Option<UpdateTarget> {
    Some(UpdateTarget::WindowsX64)
}

#[cfg(all(windows, target_arch = "aarch64"))]
fn current_update_target() -> Option<UpdateTarget> {
    Some(UpdateTarget::WindowsArm64)
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn current_update_target() -> Option<UpdateTarget> {
    Some(UpdateTarget::MacosX64)
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn current_update_target() -> Option<UpdateTarget> {
    Some(UpdateTarget::MacosArm64)
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn current_update_target() -> Option<UpdateTarget> {
    Some(UpdateTarget::LinuxX64)
}

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
fn current_update_target() -> Option<UpdateTarget> {
    Some(UpdateTarget::LinuxArm64)
}

#[cfg(not(any(
    all(windows, target_arch = "x86_64"),
    all(windows, target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "linux", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "aarch64"),
)))]
fn current_update_target() -> Option<UpdateTarget> {
    None
}

fn is_supported_asset_name(name: &str, version: &str, target: UpdateTarget) -> bool {
    asset_name_parts(name, version, target).is_some()
}

fn asset_name_parts<'a>(
    name: &'a str,
    version: &str,
    target: UpdateTarget,
) -> Option<(&'a str, u8)> {
    let prefix = format!("EmbedPix_{}", normalize_version(version).ok()?);
    let remainder = name.strip_prefix(&prefix)?.strip_prefix('_')?;
    let suffixes: &[(&str, u8)] = match target {
        UpdateTarget::WindowsX64 | UpdateTarget::WindowsArm64 => &[("-setup.exe", 0)],
        UpdateTarget::MacosX64 | UpdateTarget::MacosArm64 => &[(".dmg", 0), (".app.tar.gz", 1)],
        UpdateTarget::LinuxX64 | UpdateTarget::LinuxArm64 => {
            &[(".AppImage", 0), (".deb", 1), (".rpm", 2)]
        }
    };
    suffixes.iter().find_map(|(suffix, priority)| {
        remainder
            .strip_suffix(suffix)
            .filter(|arch| target_arch_aliases(target).contains(arch))
            .map(|arch| (arch, *priority))
    })
}

fn target_arch_aliases(target: UpdateTarget) -> &'static [&'static str] {
    match target {
        UpdateTarget::WindowsX64 | UpdateTarget::MacosX64 | UpdateTarget::LinuxX64 => {
            &["x64", "x86_64", "amd64"]
        }
        UpdateTarget::WindowsArm64 | UpdateTarget::MacosArm64 | UpdateTarget::LinuxArm64 => {
            &["arm64", "aarch64"]
        }
    }
}

fn asset_priority(name: &str, version: &str, target: UpdateTarget) -> u8 {
    asset_name_parts(name, version, target)
        .map(|(_, package_priority)| package_priority)
        .unwrap_or(u8::MAX)
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

fn validate_cached_package(
    app: &AppHandle,
    package_path: &Path,
    version: &str,
) -> Result<PathBuf, String> {
    let cache_dir = update_cache_dir(app)?;
    let canonical_cache = validate_update_cache_dir(&cache_dir)?;
    validate_cached_package_path(&canonical_cache, package_path, version)
}

fn validate_cached_package_path(
    canonical_cache: &Path,
    package_path: &Path,
    version: &str,
) -> Result<PathBuf, String> {
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
    if canonical_package.parent() != Some(canonical_cache)
        || !is_generated_update_file_name(file_name, version)
        || !file_name.ends_with(".exe")
    {
        return Err("更新安装包路径不安全。".to_string());
    }
    Ok(canonical_package)
}

fn signature_path_for_package(package_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.sig", package_path.to_string_lossy()))
}

fn verify_cached_package_signature(package_path: &Path) -> Result<(), String> {
    let signature_path = signature_path_for_package(package_path);
    let metadata = std::fs::symlink_metadata(&signature_path)
        .map_err(|_| "更新安装包签名不存在，请重新下载。".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || has_reparse_point(&metadata) {
        return Err("更新安装包签名路径不安全。".to_string());
    }
    let signature = std::fs::read_to_string(&signature_path)
        .map_err(|_| "更新安装包签名不可读，请重新下载。".to_string())?;
    let package =
        std::fs::read(package_path).map_err(|_| "更新安装包不可读，请重新下载。".to_string())?;
    verify_update_signature(&package, &signature)
}

fn open_verified_cached_package(
    app: &AppHandle,
    package_path: &Path,
    version: &str,
    expected_digest: &[u8],
    expected_size: Option<u64>,
) -> Result<VerifiedPackage, String> {
    let package_path = validate_cached_package(app, package_path, version)?;
    let file = open_verified_package_file(&package_path, expected_digest, expected_size)?;
    verify_cached_package_signature(&package_path)?;
    Ok(VerifiedPackage {
        path: package_path,
        _file: file,
    })
}

fn open_verified_package_file(
    package_path: &Path,
    expected_digest: &[u8],
    expected_size: Option<u64>,
) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x00000001;
        options.share_mode(FILE_SHARE_READ);
    }
    let mut file = options
        .open(package_path)
        .map_err(|_| "更新安装包不可读，请重新下载。".to_string())?;
    let actual_size = file
        .metadata()
        .map_err(|_| "更新安装包不可读，请重新下载。".to_string())?
        .len();
    validate_download_size(Some(actual_size), expected_size)?;
    let mut bytes = Vec::with_capacity(actual_size as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| "更新安装包不可读，请重新下载。".to_string())?;
    let actual_digest = Sha256::digest(&bytes);
    if actual_digest.as_slice() != expected_digest {
        return Err("更新安装包已发生变化，请重新下载。".to_string());
    }
    Ok(file)
}

fn validate_update_cache_dir(cache_dir: &Path) -> Result<PathBuf, String> {
    let metadata =
        std::fs::symlink_metadata(cache_dir).map_err(|_| "更新缓存目录不可用。".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() || has_reparse_point(&metadata) {
        return Err("更新缓存目录路径不安全。".to_string());
    }
    std::fs::canonicalize(cache_dir).map_err(|_| "更新缓存目录不可用。".to_string())
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
        compare_versions, is_trusted_release_page_url, normalize_version,
        open_verified_package_file, parse_sha256, select_trusted_asset_for_target,
        signature_url_for_asset, validate_asset_url, validate_cached_package_path,
        validate_update_cache_dir, verify_cached_package_signature, verify_signature, ReleaseAsset,
        UpdateTarget,
    };
    use base64::Engine;
    use sha2::Digest;

    #[test]
    fn verifies_minisign_signature_and_rejects_tampering() {
        let public_key = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let signature = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
        let encoded_public_key = base64::engine::general_purpose::STANDARD.encode(public_key);
        let encoded_signature = base64::engine::general_purpose::STANDARD.encode(signature);

        assert!(verify_signature(b"test", &encoded_signature, &encoded_public_key).is_ok());
        assert!(verify_signature(b"Test", &encoded_signature, &encoded_public_key).is_err());
    }

    #[test]
    fn derives_signature_url_from_trusted_asset_url() {
        let asset = reqwest::Url::parse(
            "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.1.9/EmbedPix_0.1.9_x64-setup.exe",
        )
        .unwrap();
        assert_eq!(
            signature_url_for_asset(&asset).unwrap().as_str(),
            "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.1.9/EmbedPix_0.1.9_x64-setup.exe.sig"
        );
    }

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
        let asset = select_trusted_asset_for_target(&assets, "0.1.2", UpdateTarget::WindowsX64)
            .expect("trusted asset");
        assert_eq!(asset.size, 1024);
        assert_eq!(asset.digest_text, digest);
        assert!(select_trusted_asset_for_target(
            &[ReleaseAsset {
                digest: None,
                ..assets[0].clone()
            }],
            "0.1.2",
            UpdateTarget::WindowsX64
        )
        .is_none());
    }

    #[test]
    fn selects_matching_assets_for_each_supported_platform_and_architecture() {
        let digest = format!("sha256:{}", "a".repeat(64));
        let assets = [
            ReleaseAsset {
                name: "EmbedPix_0.1.2_x64-setup.exe".to_string(),
                browser_download_url: "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.1.2/EmbedPix_0.1.2_x64-setup.exe".to_string(),
                digest: Some(digest.clone()),
                size: 1024,
            },
            ReleaseAsset {
                name: "EmbedPix_0.1.2_aarch64.dmg".to_string(),
                browser_download_url: "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.1.2/EmbedPix_0.1.2_aarch64.dmg".to_string(),
                digest: Some(digest.clone()),
                size: 2048,
            },
            ReleaseAsset {
                name: "EmbedPix_0.1.2_amd64.AppImage".to_string(),
                browser_download_url: "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.1.2/EmbedPix_0.1.2_amd64.AppImage".to_string(),
                digest: Some(digest),
                size: 4096,
            },
        ];

        assert_eq!(
            select_trusted_asset_for_target(&assets, "0.1.2", UpdateTarget::WindowsX64)
                .unwrap()
                .size,
            1024
        );
        assert_eq!(
            select_trusted_asset_for_target(&assets, "0.1.2", UpdateTarget::MacosArm64)
                .unwrap()
                .size,
            2048
        );
        assert_eq!(
            select_trusted_asset_for_target(&assets, "0.1.2", UpdateTarget::LinuxX64)
                .unwrap()
                .size,
            4096
        );
        assert!(
            select_trusted_asset_for_target(&assets, "0.1.2", UpdateTarget::LinuxArm64).is_none()
        );
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

    #[test]
    fn rejects_a_file_as_the_update_cache_directory() {
        let path = crate::commands::test_temp_dir()
            .join(format!("embedpix-update-cache-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::write(&path, b"not a directory").expect("test cache marker");
        assert!(validate_update_cache_dir(&path).is_err());
        std::fs::remove_file(path).expect("remove test cache marker");
    }

    #[test]
    fn verifies_cached_package_path_and_digest_before_install() {
        let root = crate::commands::test_temp_dir().join(format!(
            "embedpix-update-install-precheck-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let cache = std::fs::canonicalize(&root).unwrap();
        let package = cache.join("EmbedPix-update-0.1.2-123-456.exe");
        let bytes = b"trusted installer";
        std::fs::write(&package, bytes).unwrap();
        let digest = sha2::Sha256::digest(bytes);

        let validated = validate_cached_package_path(&cache, &package, "0.1.2").unwrap();
        assert_eq!(validated, package);
        {
            let _file =
                open_verified_package_file(&package, digest.as_slice(), Some(bytes.len() as u64))
                    .unwrap();
            assert!(
                open_verified_package_file(&package, &[0; 32], Some(bytes.len() as u64)).is_err()
            );
        }

        let outside = root.join("outside.exe");
        std::fs::write(&outside, bytes).unwrap();
        assert!(validate_cached_package_path(&cache, &outside, "0.1.2").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_cached_package_without_signature() {
        let root = crate::commands::test_temp_dir().join(format!(
            "embedpix-update-signature-precheck-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let package = root.join("EmbedPix-update-0.1.2-123-456.exe");
        std::fs::write(&package, b"trusted installer").unwrap();

        assert!(verify_cached_package_signature(&package).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_fixture_rechecks_asset_digest_path_and_signature_before_use() {
        let public_key = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let signature = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
        let encoded_public_key = base64::engine::general_purpose::STANDARD.encode(public_key);
        let encoded_signature = base64::engine::general_purpose::STANDARD.encode(signature);
        let bytes = b"test";
        assert!(verify_signature(bytes, &encoded_signature, &encoded_public_key).is_ok());

        let root = crate::commands::test_temp_dir().join(format!(
            "embedpix-update-local-fixture-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let package = root.join("EmbedPix-update-0.1.2-123-456.exe");
        std::fs::write(&package, bytes).unwrap();
        let digest = sha2::Sha256::digest(bytes);
        let cache = std::fs::canonicalize(&root).unwrap();
        let validated = validate_cached_package_path(&cache, &package, "0.1.2").unwrap();
        {
            let _file = open_verified_package_file(&validated, digest.as_slice(), Some(4)).unwrap();
        }
        verify_signature(bytes, &encoded_signature, &encoded_public_key).unwrap();
        std::fs::write(&package, b"tampered").unwrap();
        assert!(open_verified_package_file(&package, digest.as_slice(), Some(4)).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_http_fixture_runs_download_size_digest_and_signature_pipeline() {
        use std::io::{Read as _, Write as _};
        use std::net::TcpListener;
        use std::thread;

        let public_key = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let signature = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
        let encoded_public_key = base64::engine::general_purpose::STANDARD.encode(public_key);
        let encoded_signature = base64::engine::general_purpose::STANDARD.encode(signature);
        let package = b"test".to_vec();
        let digest = sha2::Sha256::digest(&package);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 1024];
                let size = stream.read(&mut request).unwrap();
                let path = String::from_utf8_lossy(&request[..size]);
                let (body, content_type) = if path.contains(".sig") {
                    (encoded_signature.as_bytes().to_vec(), "text/plain")
                } else {
                    (package.clone(), "application/octet-stream")
                };
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let client = reqwest::Client::new();
        let base = format!("http://{address}");
        runtime.block_on(async {
            let signature_text = client
                .get(format!("{base}/asset.exe.sig"))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            let package_response = client
                .get(format!("{base}/asset.exe"))
                .send()
                .await
                .unwrap();
            let bytes = package_response.bytes().await.unwrap();
            assert_eq!(bytes.len(), 4);
            assert_eq!(sha2::Sha256::digest(&bytes).as_slice(), digest.as_slice());
            verify_signature(&bytes, &signature_text, &encoded_public_key).unwrap();
        });
        server.join().unwrap();
        let tampered = sha2::Sha256::digest(b"tampered");
        assert_ne!(tampered.as_slice(), digest.as_slice());
    }
}
