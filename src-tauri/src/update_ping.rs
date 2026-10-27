//! Update checks use a device-only identity, separate from entitlement and sign-in.
use serde::Serialize;
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

pub(crate) struct RestartRefused(pub String);

pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?;
    initialize_at(app, &path.join("update-ping.json"))
}

pub fn initialize_at<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<(), String> {
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
    check_with(app, Arc::new(AtomicBool::new(false))).await
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
    if let Some(identity) = app.try_state::<UpdateIdentity>() {
        let channel = if app
            .package_info()
            .version
            .pre
            .as_str()
            .starts_with("preview.")
        {
            "preview"
        } else {
            "stable"
        };
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
            return Ok(result.map(|mut update| {
                update.headers.clear();
                update
            }));
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
    settle_check(result, tauri::utils::platform::bundle_type())
}

/// A .deb or .rpm install is updated by the system package manager, never in
/// place. When the release manifest has no entry for that package
/// (`linux-x86_64-deb`, `linux-x86_64`), the release ships no Linux build, so
/// there is nothing to offer: report "no update" instead of failing every
/// scheduled check with the same "None of the fallback platforms" warning.
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
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
    install_exits: bool,
}

pub(crate) struct CheckedUpdate {
    pub update: Update,
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
    let Some(update) = check_with(webview.app_handle(), force.clone()).await? else {
        return Ok(None);
    };
    let metadata = UpdateMetadata {
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
