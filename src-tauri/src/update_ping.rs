//! Update checks use a device-only identity, separate from entitlement and sign-in.
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::{path::Path, time::Duration};
use tauri::{AppHandle, Manager, Runtime, Webview};
use tauri_plugin_store::StoreExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use uuid::Uuid;

const SERVICE_TIMEOUT: Duration = Duration::from_secs(2);
const FALLBACK_TIMEOUT: Duration = Duration::from_secs(15);

struct UpdateIdentity(String);

struct UpdateSettingsPath(std::path::PathBuf);
struct UpdateCheckClock(Mutex<UpdateCheckClockState>);
struct UpdateCheckClockState {
    session: String,
    sequence: u64,
    generation: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckTicket {
    pub check_sequence: u64,
    pub check_session: String,
    pub channel: String,
    pub generation: u64,
}

fn clock<R: Runtime>(app: &AppHandle<R>) -> tauri::State<'_, UpdateCheckClock> {
    if app.try_state::<UpdateCheckClock>().is_none() {
        app.manage(UpdateCheckClock(Mutex::new(UpdateCheckClockState {
            session: Uuid::new_v4().to_string(),
            sequence: 0,
            generation: 0,
        })));
    }
    app.state::<UpdateCheckClock>()
}
fn epoch<R: Runtime>(app: &AppHandle<R>) -> u64 {
    clock(app).0.lock().unwrap().generation
}
fn ensure_epoch<R: Runtime>(app: &AppHandle<R>, expected: u64) -> Result<(), String> {
    if epoch(app) != expected {
        return Err("Update channel changed; check again.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn begin_update_check<R: Runtime>(app: AppHandle<R>) -> UpdateCheckTicket {
    let clock = clock(&app);
    let mut state = clock.0.lock().unwrap();
    state.sequence += 1;
    UpdateCheckTicket {
        check_sequence: state.sequence,
        check_session: state.session.clone(),
        channel: get_update_channel(app.clone()),
        generation: state.generation,
    }
}

#[tauri::command]
pub fn read_update_check_ticket<R: Runtime>(app: AppHandle<R>) -> Option<UpdateCheckTicket> {
    let clock = clock(&app);
    let state = clock.0.lock().unwrap();
    (state.sequence > 0).then(|| UpdateCheckTicket {
        check_sequence: state.sequence,
        check_session: state.session.clone(),
        channel: get_update_channel(app.clone()),
        generation: state.generation,
    })
}

pub(crate) fn is_current_check<R: Runtime>(app: &AppHandle<R>, ticket: &UpdateCheckTicket) -> bool {
    let clock = clock(app);
    let state = clock.0.lock().unwrap();
    state.session == ticket.check_session
        && state.sequence == ticket.check_sequence
        && state.generation == ticket.generation
        && ticket.channel == get_update_channel(app.clone())
}

pub(crate) fn with_current_check<R: Runtime, T>(
    app: &AppHandle<R>,
    ticket: &UpdateCheckTicket,
    action: impl FnOnce() -> T,
) -> Option<T> {
    let clock = clock(app);
    let state = clock.0.lock().unwrap();
    if state.session != ticket.check_session
        || state.sequence != ticket.check_sequence
        || state.generation != ticket.generation
        || ticket.channel != get_update_channel(app.clone())
    {
        return None;
    }
    Some(action())
}

fn ensure_current_check<R: Runtime>(
    app: &AppHandle<R>,
    ticket: &UpdateCheckTicket,
) -> Result<(), String> {
    if !is_current_check(app, ticket) {
        return Err("Update check was superseded; check again.".into());
    }
    Ok(())
}

pub(crate) fn is_current_report<R: Runtime>(
    app: &AppHandle<R>,
    report: &serde_json::Value,
) -> bool {
    serde_json::from_value::<UpdateCheckTicket>(report.clone())
        .is_ok_and(|ticket| is_current_check(app, &ticket))
}
pub fn get_update_channel<R: Runtime>(app: AppHandle<R>) -> String {
    if let Some(path) = app.try_state::<UpdateSettingsPath>() {
        if let Ok(store) = app.store_builder(&path.0).disable_auto_save().build() {
            if let Some(value) = store
                .get("channel")
                .and_then(|v| v.as_str().map(str::to_owned))
            {
                if value == "stable" || value == "beta" {
                    return value;
                }
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
        "preview"
    } else {
        "stable"
    }
    .into()
}
#[tauri::command]
pub fn read_update_channel<R: Runtime>(app: AppHandle<R>) -> String {
    get_update_channel(app)
}
#[tauri::command]
pub fn set_update_channel<R: Runtime>(
    app: AppHandle<R>,
    channel: String,
) -> Result<String, String> {
    if channel != "stable" && channel != "beta" {
        return Err("Unknown update channel.".into());
    }
    let clock = clock(&app);
    let mut state = clock.0.lock().unwrap();
    let path = app.state::<UpdateSettingsPath>();
    let store = app
        .store_builder(&path.0)
        .disable_auto_save()
        .build()
        .map_err(|e| e.to_string())?;
    let previous = store.get("channel");
    store.set("channel", serde_json::json!(channel));
    if let Err(error) = store.save() {
        match previous {
            Some(value) => {
                store.set("channel", value);
            }
            None => {
                store.delete("channel");
            }
        }
        return Err(error.to_string());
    }
    state.generation += 1;
    Ok(channel)
}

pub(crate) fn ensure_update_channel<R: Runtime>(
    app: &AppHandle<R>,
    update: &Update,
) -> Result<(), String> {
    if let Some(generation) = update.raw_json["_o8Epoch"].as_u64() {
        ensure_epoch(app, generation)?;
    }
    Ok(())
}
pub(crate) struct RestartRefused(pub String);

pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?;
    initialize_at(app, &path.join("update-ping.json"))
}

pub fn initialize_at<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<(), String> {
    app.manage(UpdateSettingsPath(path.to_path_buf()));
    let _ = clock(app);
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
    let ticket = begin_update_check(app.clone());
    check_for_ticket(app, &ticket).await
}

pub(crate) async fn check_for_ticket<R: Runtime>(
    app: &AppHandle<R>,
    ticket: &UpdateCheckTicket,
) -> Result<Option<Update>, String> {
    let mut result = check_with(app, Arc::new(AtomicBool::new(false)), ticket).await?;
    if let Some(update) = result.as_mut() {
        update.raw_json["_o8Epoch"] = serde_json::json!(ticket.generation);
    }
    Ok(result)
}

fn guarded_builder<R: Runtime>(
    app: &AppHandle<R>,
    builder: tauri_plugin_updater::UpdaterBuilder,
    force: Arc<AtomicBool>,
) -> tauri_plugin_updater::UpdaterBuilder {
    let app = app.clone();
    let generation = epoch(&app);
    builder.on_before_exit(move || {
        if let Err(error) = ensure_epoch(&app, generation) {
            std::panic::panic_any(RestartRefused(error));
        }
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
    ticket: &UpdateCheckTicket,
) -> Result<Option<Update>, String> {
    ensure_current_check(app, ticket)?;
    let result = match ticket.channel.as_str() {
        "beta" => check_beta(app, force).await,
        _ => check_channel(app, force, &ticket.channel, false).await,
    };
    ensure_current_check(app, ticket)?;
    result
}

async fn check_beta<R: Runtime>(
    app: &AppHandle<R>,
    force: Arc<AtomicBool>,
) -> Result<Option<Update>, String> {
    let candidate = check_channel(app, force.clone(), "beta", true).await;
    let stable = check_channel(app, force, "stable", false).await;
    match (candidate, stable) {
        (Ok(Some(beta)), Ok(Some(stable))) => {
            let a: semver::Version = beta
                .version
                .parse()
                .map_err(|e: semver::Error| e.to_string())?;
            let b: semver::Version = stable
                .version
                .parse()
                .map_err(|e: semver::Error| e.to_string())?;
            Ok(Some(if a > b { beta } else { stable }))
        }
        (Ok(Some(update)), _) | (_, Ok(Some(update))) => Ok(Some(update)),
        (Ok(None), Ok(None)) => Ok(None),
        (Err(error), _) | (_, Err(error)) => Err(error),
    }
}
fn validate_identity(result: Option<Update>, expected: &str) -> Result<Option<Update>, String> {
    if result
        .as_ref()
        .is_some_and(|update| update.raw_json["channel"].as_str() != Some(expected))
    {
        return Err("Update manifest channel identity does not match enrollment.".into());
    }
    Ok(result)
}
fn manifest_name(channel: &str) -> Result<&str, String> {
    match channel {
        "stable" => Ok("latest.json"),
        "beta" => Ok("beta.json"),
        "preview" => Ok("preview.json"),
        _ => Err("Unknown update channel.".into()),
    }
}

fn channel_fallback(endpoint: &reqwest::Url, channel: &str) -> Result<reqwest::Url, String> {
    let mut url = endpoint.clone();
    let path = if channel == "beta" {
        // GitHub's rolling Beta assets live on their own prerelease tag. Other
        // mirrors keep the ordinary sibling-manifest layout.
        if let Some(root) = url
            .path()
            .strip_suffix("/releases/latest/download/latest.json")
        {
            format!("{root}/releases/download/beta/beta.json")
        } else {
            let parent = url
                .path()
                .strip_suffix("latest.json")
                .ok_or("Updater fallback has no manifest sibling.")?;
            format!("{parent}beta.json")
        }
    } else {
        let parent = url
            .path()
            .strip_suffix("latest.json")
            .ok_or("Updater fallback has no manifest sibling.")?;
        format!("{parent}{}", manifest_name(channel)?)
    };
    url.set_path(&path);
    Ok(url)
}
async fn check_channel<R: Runtime>(
    app: &AppHandle<R>,
    force: Arc<AtomicBool>,
    channel: &str,
    mirror_when_current: bool,
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
    let fallback = fallback
        .iter()
        .map(|endpoint| channel_fallback(endpoint, channel))
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
            .header("X-O8-Channel", channel)
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
            if let Ok(result) = validate_identity(result, channel) {
                // Older services can return current for an unknown Beta enrollment.
                // The Beta sibling remains authoritative in that one case.
                if result.is_some() || !mirror_when_current {
                    return Ok(result.map(|mut update| {
                        update.headers.clear();
                        update
                    }));
                }
            }
        }
    }
    let result = guarded_builder(app, app.updater_builder(), force)
        .clear_headers()
        .endpoints(fallback.to_vec())
        .map_err(|e| e.to_string())?
        .timeout(FALLBACK_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    validate_identity(result, channel)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    rid: tauri::ResourceId,
    #[serde(flatten)]
    ticket: UpdateCheckTicket,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
    install_exits: bool,
}

pub(crate) struct CheckedUpdate {
    pub update: Update,
    generation: u64,
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
    ticket: Option<UpdateCheckTicket>,
) -> Result<Option<UpdateMetadata>, String> {
    let ticket = ticket.unwrap_or_else(|| begin_update_check(webview.app_handle().clone()));
    let generation = ticket.generation;
    let force = Arc::new(AtomicBool::new(false));
    let Some(update) = check_with(webview.app_handle(), force.clone(), &ticket).await? else {
        return Ok(None);
    };
    let metadata = UpdateMetadata {
        ticket,
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
            generation,
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
    ensure_epoch(webview.app_handle(), checked.generation)?;
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
    ensure_epoch(webview.app_handle(), downloaded.checked.generation)?;
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
