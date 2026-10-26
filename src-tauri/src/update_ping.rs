//! Update checks use a device-only identity, separate from entitlement and sign-in.
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, Manager, Runtime, Webview};
use tauri_plugin_store::StoreExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use uuid::Uuid;

const SERVICE_TIMEOUT: Duration = Duration::from_secs(2);
const FALLBACK_TIMEOUT: Duration = Duration::from_secs(15);

struct UpdateIdentity(String);
struct UpdateSettingsPath(PathBuf);

fn selected_channel<R: Runtime>(app: &AppHandle<R>) -> String {
    if let Some(path) = app.try_state::<UpdateSettingsPath>() {
        if let Ok(store) = app.store(&path.0) {
            if let Some(channel) = store
                .get("channel")
                .and_then(|value| value.as_str().map(str::to_owned))
            {
                return if channel == "beta" { "beta" } else { "stable" }.into();
            }
        }
    }
    if app
        .package_info()
        .version
        .pre
        .as_str()
        .starts_with("preview.")
    {
        "preview".into()
    } else {
        "stable".into()
    }
}

#[tauri::command]
pub fn get_update_channel<R: Runtime>(app: AppHandle<R>) -> String {
    if selected_channel(&app) == "beta" {
        "beta"
    } else {
        "stable"
    }
    .into()
}

#[tauri::command]
pub fn set_update_channel<R: Runtime>(
    app: AppHandle<R>,
    channel: String,
) -> Result<String, String> {
    if channel != "stable" && channel != "beta" {
        return Err("Update channel must be stable or beta.".into());
    }
    let path = app
        .try_state::<UpdateSettingsPath>()
        .ok_or("Update preferences unavailable.")?;
    let store = app
        .store(&path.0)
        .map_err(|_| "Update preferences unavailable.")?;
    let previous = store.get("channel");
    store.set("channel", serde_json::json!(channel));
    if store.save().is_err() {
        match previous {
            Some(value) => store.set("channel", value),
            None => {
                store.delete("channel");
            }
        }
        return Err("Update channel could not be saved.".into());
    }
    Ok(channel)
}

pub(crate) struct RestartRefused(pub String);

pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?;
    initialize_at(app, &path.join("update-ping.json"))
}

pub fn initialize_at<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<(), String> {
    app.manage(UpdateSettingsPath(path.to_path_buf()));
    let store = app
        .store_builder(path)
        .disable_auto_save()
        .build()
        .map_err(|e| e.to_string())?;
    let id = match store.get("installId") {
        Some(value) => {
            let id = value.as_str().ok_or("invalid update install identifier")?;
            let parsed = Uuid::parse_str(id).map_err(|e| e.to_string())?;
            if parsed.get_version_num() != 4 || parsed.get_variant() != uuid::Variant::RFC4122 {
                return Err("invalid update install identifier".into());
            }
            id.to_owned()
        }
        None => {
            let id = Uuid::new_v4().to_string();
            store.set("installId", serde_json::json!(id));
            store.save().map_err(|e| e.to_string())?;
            id
        }
    };
    app.manage(UpdateIdentity(id));
    Ok(())
}

fn macos_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let version = String::from_utf8(output.stdout).ok()?.trim().to_owned();
        if version.is_empty() || !version.chars().all(|c| c.is_ascii_digit() || c == '.') {
            return None;
        }
        Some(version)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

pub async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Update>, String> {
    let channel = selected_channel(app);
    let mut result = check_with(app, Arc::new(AtomicBool::new(false))).await?;
    if let Some(update) = result.as_mut() {
        update.raw_json["_o8Channel"] = serde_json::json!(channel);
    }
    Ok(result)
}

pub(crate) fn ensure_update_channel<R: Runtime>(
    app: &AppHandle<R>,
    update: &Update,
) -> Result<(), String> {
    if let Some(channel) = update
        .raw_json
        .get("_o8Channel")
        .and_then(|value| value.as_str())
    {
        if channel != selected_channel(app) {
            return Err("Update channel changed; check for updates again.".into());
        }
    }
    Ok(())
}

fn guarded_builder<R: Runtime>(
    app: &AppHandle<R>,
    builder: tauri_plugin_updater::UpdaterBuilder,
    force: Arc<AtomicBool>,
) -> tauri_plugin_updater::UpdaterBuilder {
    let app = app.clone();
    builder.on_before_exit(move || {
        // Windows invokes this after extraction and before launching its installer.
        // Its infallible hook must unwind to our command rather than exit on refusal.
        if let Err(error) = crate::launch_updater::scheduler::auto_apply::commit_restart_with_work(
            &app,
            force.load(Ordering::Acquire),
        ) {
            std::panic::panic_any(RestartRefused(error));
        }
        app.cleanup_before_exit();
    })
}

async fn check_with<R: Runtime>(
    app: &AppHandle<R>,
    force: Arc<AtomicBool>,
) -> Result<Option<Update>, String> {
    let config: tauri_plugin_updater::Config = serde_json::from_value(
        app.config()
            .plugins
            .0
            .get("updater")
            .cloned()
            .ok_or("updater config missing")?,
    )
    .map_err(|e| e.to_string())?;
    let (service, fallback) = config
        .endpoints
        .split_first()
        .ok_or("updater endpoints missing")?;
    let channel = selected_channel(app);
    let fallback = fallback
        .iter()
        .map(|endpoint| {
            let mut endpoint = endpoint.clone();
            if channel != "stable" {
                let path = endpoint
                    .path()
                    .strip_suffix("latest.json")
                    .ok_or("Channel fallback must have a stable manifest sibling.")?;
                let path = format!("{path}{channel}.json");
                endpoint.set_path(&path);
            }
            Ok(endpoint)
        })
        .collect::<Result<Vec<_>, String>>()?;
    if let Some(identity) = app.try_state::<UpdateIdentity>() {
        let primary_host = service.host_str().unwrap_or_default().to_owned();
        let mut builder = app
            .updater_builder()
            .clear_headers()
            .endpoints(vec![service.clone()])
            .map_err(|e| e.to_string())?
            .timeout(SERVICE_TIMEOUT)
            .header("X-O8-Install-Id", identity.0.as_str())
            .map_err(|e| e.to_string())?
            .header("X-O8-Channel", channel.as_str())
            .map_err(|e| e.to_string())?
            // A service redirect means fail over locally, without forwarding the ID.
            // Artifact download redirects still use the updater's normal transport.
            .configure_client(move |client| {
                let host = primary_host.clone();
                client.redirect(reqwest::redirect::Policy::custom(move |attempt| {
                    if attempt.previous().first().and_then(|url| url.host_str())
                        == Some(host.as_str())
                    {
                        attempt.stop()
                    } else if attempt.previous().len() >= 10 {
                        attempt.error("too many redirects")
                    } else {
                        attempt.follow()
                    }
                }))
            });
        if let Some(version) = macos_version() {
            builder = builder
                .header("X-O8-Macos-Version", version)
                .map_err(|e| e.to_string())?;
        }
        let updater = guarded_builder(app, builder, force.clone())
            .build()
            .map_err(|e| e.to_string())?;
        // Also bound response-body parsing, including a stalled successful response.
        if let Ok(Ok(result)) = tokio::time::timeout(SERVICE_TIMEOUT, updater.check()).await {
            if channel != selected_channel(app) {
                return Err("Update channel changed during check; retry.".into());
            }
            // An older service may ignore enrollment, including returning no update.
            // Require beta identity before trusting it; otherwise read the beta mirror.
            let channel_proven = channel != "beta"
                || result
                    .as_ref()
                    .is_some_and(|update| update.raw_json["channel"] == "beta");
            if channel_proven {
                return Ok(result.map(|mut update| {
                    update.headers.clear();
                    update
                }));
            }
        }
    }
    let result = guarded_builder(app, app.updater_builder(), force)
        .clear_headers()
        .endpoints(fallback)
        .map_err(|e| e.to_string())?
        .timeout(FALLBACK_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    if channel != selected_channel(app) {
        return Err("Update channel changed during check; retry.".into());
    }
    if channel == "beta"
        && result
            .as_ref()
            .is_some_and(|update| update.raw_json["channel"] != "beta")
    {
        return Err("Beta manifest identity is missing.".into());
    }
    Ok(result)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    rid: tauri::ResourceId,
    channel: String,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
    install_exits: bool,
}

pub(crate) struct CheckedUpdate {
    pub update: Update,
    channel: String,
    force: Arc<AtomicBool>,
    installing: Mutex<()>,
}
impl tauri::Resource for CheckedUpdate {}

struct DownloadedUpdate {
    checked: Arc<CheckedUpdate>,
    bytes: Vec<u8>,
}
impl tauri::Resource for DownloadedUpdate {}

#[tauri::command]
pub async fn check_app_update<R: Runtime>(
    webview: Webview<R>,
) -> Result<Option<UpdateMetadata>, String> {
    let force = Arc::new(AtomicBool::new(false));
    let channel = selected_channel(webview.app_handle());
    let Some(update) = check_with(webview.app_handle(), force.clone()).await? else {
        return Ok(None);
    };
    let metadata = UpdateMetadata {
        channel: channel.clone(),
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date: update
            .date
            .map(|date| date.format(&time::format_description::well_known::Rfc3339))
            .transpose()
            .map_err(|e| e.to_string())?,
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        install_exits: cfg!(target_os = "windows"),
        rid: webview.resources_table().add(CheckedUpdate {
            update,
            channel,
            force,
            installing: Mutex::new(()),
        }),
    };
    Ok(Some(metadata))
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

#[tauri::command]
pub async fn download_app_update<R: Runtime>(
    webview: Webview<R>,
    rid: tauri::ResourceId,
    on_event: tauri::ipc::Channel<DownloadEvent>,
) -> Result<tauri::ResourceId, String> {
    let checked = webview
        .resources_table()
        .take::<CheckedUpdate>(rid)
        .map_err(|error| error.to_string())?;
    if checked.channel != selected_channel(webview.app_handle()) {
        return Err("Update channel changed; check for updates again.".into());
    }
    let mut started = false;
    let bytes = crate::launch_updater::scheduler::auto_apply::download(
        &checked.update,
        |chunk_length, content_length| {
            if !started {
                started = true;
                let _ = on_event.send(DownloadEvent::Started { content_length });
            }
            let _ = on_event.send(DownloadEvent::Progress { chunk_length });
        },
        || {
            let _ = on_event.send(DownloadEvent::Finished);
        },
    )
    .await?;
    Ok(webview
        .resources_table()
        .add(DownloadedUpdate { checked, bytes }))
}

#[tauri::command]
pub fn discard_app_update_download<R: Runtime>(
    webview: Webview<R>,
    rid: tauri::ResourceId,
) -> Result<(), String> {
    webview
        .resources_table()
        .take::<DownloadedUpdate>(rid)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn install_app_update<R: Runtime>(
    webview: Webview<R>,
    rid: tauri::ResourceId,
    force: Option<bool>,
) -> Result<(), String> {
    let downloaded = webview
        .resources_table()
        .take::<DownloadedUpdate>(rid)
        .map_err(|error| error.to_string())?;
    if downloaded.checked.channel != selected_channel(webview.app_handle()) {
        return Err("Update channel changed; check for updates again.".into());
    }
    let _installing = downloaded
        .checked
        .installing
        .try_lock()
        .map_err(|_| "Update installation is already in progress.")?;
    downloaded
        .checked
        .force
        .store(force == Some(true), Ordering::Release);
    // Never let the plugin's infallible Windows hook strand an IPC promise on
    // refusal. Other platforms keep their normal stage-then-restart behavior.
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        downloaded.checked.update.install(&downloaded.bytes)
    }))
    .map_err(|error| {
        error
            .downcast_ref::<RestartRefused>()
            .map(|error| error.0.clone())
            .unwrap_or_else(|| "Native installer stopped before restart.".into())
    })?
    .map_err(|error| error.to_string())
}
