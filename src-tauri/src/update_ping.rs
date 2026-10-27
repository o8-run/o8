//! Update checks use a device-only identity, separate from entitlement and sign-in.
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::{path::Path, time::Duration};
use tauri::{AppHandle, Manager, Runtime, Webview};
use tauri_plugin_updater::{Update, UpdaterExt};
use uuid::Uuid;

const SERVICE_TIMEOUT: Duration = Duration::from_secs(2);
const FALLBACK_TIMEOUT: Duration = Duration::from_secs(15);
#[path = "update_channel_persistence.rs"]
mod channel_persistence;

struct UpdateIdentity(String);

struct UpdateSettingsPath(std::path::PathBuf);
struct UpdateCheckClock {
    state: Mutex<UpdateCheckClockState>,
    // Active enrollment and starting an installer are one serialized handoff.
    // Separate from state: the updater's exit hook reads the epoch itself.
    installation: Mutex<()>,
}
struct UpdateCheckClockState {
    session: String,
    sequence: u64,
    generation: u64,
    enrollment_revision: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChannelStatus {
    pub channel: String,
    pub outcome: String,
    pub revision: u64,
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
        app.manage(UpdateCheckClock {
            state: Mutex::new(UpdateCheckClockState {
                session: Uuid::new_v4().to_string(),
                sequence: 0,
                generation: 0,
                enrollment_revision: 0,
            }),
            installation: Mutex::new(()),
        });
    }
    app.state::<UpdateCheckClock>()
}
fn epoch<R: Runtime>(app: &AppHandle<R>) -> u64 {
    clock(app).state.lock().unwrap().generation
}
pub(crate) fn ensure_epoch<R: Runtime>(app: &AppHandle<R>, expected: u64) -> Result<(), String> {
    if epoch(app) != expected {
        return Err("Update channel changed; check again.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn begin_update_check<R: Runtime>(app: AppHandle<R>) -> UpdateCheckTicket {
    let _ = apply_pending_when_idle(&app);
    let clock = clock(&app);
    let mut state = clock.state.lock().unwrap();
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
    let state = clock.state.lock().unwrap();
    (state.sequence > 0).then(|| UpdateCheckTicket {
        check_sequence: state.sequence,
        check_session: state.session.clone(),
        channel: get_update_channel(app.clone()),
        generation: state.generation,
    })
}

pub(crate) fn is_current_check<R: Runtime>(app: &AppHandle<R>, ticket: &UpdateCheckTicket) -> bool {
    let clock = clock(app);
    let state = clock.state.lock().unwrap();
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
    let state = clock.state.lock().unwrap();
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
        if let Ok(store) = channel_persistence::load(&path.0) {
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
) -> Result<UpdateChannelStatus, String> {
    if channel != "stable" && channel != "beta" {
        return Err("Unknown update channel.".into());
    }
    let clock = clock(&app);
    let mut state = clock.state.lock().unwrap();
    // Nonblocking under state: installer callbacks may save on this thread.
    // The finishing installer releases its gate under the same state lock.
    let installation = clock.installation.try_lock();
    let deferred = installation.is_err();
    save_channel(&app, &channel, deferred)?;
    state.enrollment_revision += 1;
    if !deferred {
        state.generation += 1;
    }
    Ok(UpdateChannelStatus {
        channel,
        outcome: if deferred { "after-install" } else { "applied" }.into(),
        revision: state.enrollment_revision,
    })
}

fn pending_channel<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
    let Some(path) = app.try_state::<UpdateSettingsPath>() else {
        return Ok(None);
    };
    let store = channel_persistence::load(&path.0)?;
    Ok(store.get("pendingChannel").and_then(|value| {
        value
            .as_str()
            .filter(|channel| *channel == "stable" || *channel == "beta")
            .map(str::to_owned)
    }))
}

fn save_channel<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    deferred: bool,
) -> Result<(), String> {
    let path = app
        .try_state::<UpdateSettingsPath>()
        .ok_or("Update preferences are unavailable.")?;
    let mut store = channel_persistence::load(&path.0)?;
    if deferred {
        store.insert("pendingChannel".into(), serde_json::json!(channel));
    } else {
        store.insert("channel".into(), serde_json::json!(channel));
        store.remove("pendingChannel");
    }
    channel_persistence::save(&path.0, store)
}

fn apply_pending_when_idle<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let clock = clock(app);
    let Ok(installation) = clock.installation.try_lock() else {
        return Ok(());
    };
    let mut state = clock.state.lock().unwrap();
    let result = apply_pending_channel(app, &mut state);
    drop(installation);
    result
}

fn apply_pending_channel<R: Runtime>(
    app: &AppHandle<R>,
    state: &mut UpdateCheckClockState,
) -> Result<(), String> {
    if let Some(channel) = pending_channel(app)? {
        save_channel(app, &channel, false)?;
        state.generation += 1;
        state.enrollment_revision += 1;
    }
    Ok(())
}

#[tauri::command]
pub fn read_update_channel_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<UpdateChannelStatus, String> {
    let clock = clock(&app);
    let mut state = clock.state.lock().unwrap();
    // Retry a durable pending save if the installer returned during a temporary
    // store failure. Never claim an installation finished merely from a timer.
    let installation = clock.installation.try_lock();
    let waiting_for_save = installation.is_ok() && apply_pending_channel(&app, &mut state).is_err();
    let pending = pending_channel(&app)?;
    Ok(UpdateChannelStatus {
        channel: pending
            .clone()
            .unwrap_or_else(|| get_update_channel(app.clone())),
        outcome: if waiting_for_save {
            "waiting-for-save"
        } else if pending.is_some() {
            "after-install"
        } else {
            "applied"
        }
        .into(),
        revision: state.enrollment_revision,
    })
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
/// Capture even a directly constructed candidate before network or admission work.
pub(crate) fn update_generation<R: Runtime>(app: &AppHandle<R>, update: &Update) -> u64 {
    update.raw_json["_o8Epoch"]
        .as_u64()
        .unwrap_or_else(|| epoch(app))
}

/// No await and no clock guard may span the installer. The installation guard
/// holds saved enrollment choices until this synchronous effect has finished.
pub(crate) fn install_in_channel<R: Runtime, T>(
    app: &AppHandle<R>,
    generation: u64,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let clock = clock(app);
    let installation = clock
        .installation
        .try_lock()
        .map_err(|_| "Update installation is already in progress.")?;
    // An earlier install may have left a durable held choice after a failed
    // drain. Resolve it under this final gate before validating the candidate.
    {
        let mut state = clock.state.lock().unwrap();
        apply_pending_channel(app, &mut state)?;
    }
    ensure_epoch(app, generation)?;
    let result = operation();
    let mut state = clock.state.lock().unwrap();
    if let Err(error) = apply_pending_channel(app, &mut state) {
        log::warn!("Update installation finished; saved channel is waiting for preferences storage: {error}");
    }
    // A save waiting for state must observe the gate as free, rather than queue
    // itself after the final drain. The active installer epoch stays unchanged
    // through all plugin callbacks, including its Windows exit hook.
    drop(installation);
    result
}

pub(crate) struct RestartRefused(pub String);

pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?;
    initialize_at(app, &path.join("update-ping.json"))
}

pub fn initialize_at<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<(), String> {
    app.manage(UpdateSettingsPath(path.to_path_buf()));
    let _ = clock(app);
    let mut store = channel_persistence::load(path)?;
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
            store.insert("installId".into(), serde_json::json!(id));
            channel_persistence::save(path, store)?;
            id
        }
    };
    app.manage(UpdateIdentity(id));
    // An installer may exit the process before returning (or it may crash).
    // The durable held choice must be applied before any launch update check.
    let clock = clock(app);
    apply_pending_channel(app, &mut clock.state.lock().unwrap())?;
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
    // A previously acknowledged choice must be honored (or block transport)
    // even if its startup drain could not commit and Settings is not open.
    apply_pending_when_idle(app)?;
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
        .await;
    validate_identity(
        settle_check(result, tauri::utils::platform::bundle_type())?,
        channel,
    )
}

/// Package-managed installs report current when a release has no Linux target.
/// Keep other missing-target and transport errors visible.
fn settle_check(
    result: Result<Option<Update>, tauri_plugin_updater::Error>,
    bundle: Option<tauri::utils::config::BundleType>,
) -> Result<Option<Update>, String> {
    use tauri::utils::config::BundleType;
    match result {
        Err(tauri_plugin_updater::Error::TargetsNotFound(targets))
            if matches!(bundle, Some(BundleType::Deb | BundleType::Rpm)) =>
        {
            log::debug!(
                "[updater] release has no {:?} entry; package installs update through the package manager",
                targets
            );
            Ok(None)
        }
        other => other.map_err(|e| e.to_string()),
    }
}
#[cfg(test)]
mod settle_check_tests {
    use super::settle_check;
    use tauri::utils::config::BundleType;
    use tauri_plugin_updater::Error;
    fn targets_missing() -> Error {
        Error::TargetsNotFound(vec!["linux-x86_64-deb".into(), "linux-x86_64".into()])
    }
    #[test]
    fn package_installs_treat_a_release_without_linux_entries_as_no_update() {
        for bundle in [BundleType::Deb, BundleType::Rpm] {
            assert!(matches!(
                settle_check(Err(targets_missing()), Some(bundle)),
                Ok(None)
            ));
        }
    }
    #[test]
    fn other_installs_still_report_missing_targets() {
        for bundle in [Some(BundleType::AppImage), Some(BundleType::App), None] {
            let error = settle_check(Err(targets_missing()), bundle)
                .err()
                .expect("missing targets stay an error");
            assert!(error.contains("None of the fallback platforms"));
        }
    }
    #[test]
    fn package_installs_still_report_other_failures() {
        assert!(settle_check(Err(Error::ReleaseNotFound), Some(BundleType::Deb)).is_err());
    }
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
    ensure_epoch(webview.app_handle(), checked.generation)?;
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
    install_in_channel(webview.app_handle(), downloaded.checked.generation, || {
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
    })
}
