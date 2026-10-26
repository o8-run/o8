#[path = "update_scheduler.rs"]
pub(crate) mod scheduler;
use serde::Serialize;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_notification::NotificationExt;

const UPDATE_AVAILABLE_EVENT: &str = "o8://update-available";
const UPDATE_CLEAR_EVENT: &str = "o8://update-clear";
const BUNDLE_SIGNATURE_INVALID_EVENT: &str = "o8://bundle-signature-invalid";
const REINSTALL_URL: &str = "https://github.com/o8-run/o8/releases/latest";
const REINSTALL_INSTRUCTION: &str = "Quit o8, move /Applications/o8.app to /Applications/o8.app.damaged, then download and reinstall the latest release.";

static LAUNCH_UPDATE_CHECK_STARTED: AtomicBool = AtomicBool::new(false);
static RUNNING_BUNDLE_INTEGRITY: OnceLock<BundleIntegrityStatus> = OnceLock::new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchUpdatePayload {
    channel: String,
    version: String,
    current_version: String,
    notes: Option<String>,
    date: Option<String>,
    release_url: Option<String>,
    checked_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchUpdateCheckPayload {
    channel: String,
    outcome: &'static str,
    checked_at: String,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleIntegrityStatus {
    status: BundleIntegrityState,
    detail: Option<String>,
    reinstall_url: Option<String>,
    instruction: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum BundleIntegrityState {
    Verified,
    Invalid,
    Skipped,
}

impl BundleIntegrityStatus {
    fn verified() -> Self {
        Self {
            status: BundleIntegrityState::Verified,
            detail: None,
            reinstall_url: None,
            instruction: None,
        }
    }

    fn invalid(detail: String) -> Self {
        Self {
            status: BundleIntegrityState::Invalid,
            detail: Some(detail),
            reinstall_url: Some(REINSTALL_URL.to_string()),
            instruction: Some(REINSTALL_INSTRUCTION.to_string()),
        }
    }

    fn skipped(detail: impl Into<String>) -> Self {
        Self {
            status: BundleIntegrityState::Skipped,
            detail: Some(detail.into()),
            reinstall_url: None,
            instruction: None,
        }
    }

    fn is_invalid(&self) -> bool {
        self.status == BundleIntegrityState::Invalid
    }
}

pub fn running_bundle_integrity() -> BundleIntegrityStatus {
    RUNNING_BUNDLE_INTEGRITY
        .get_or_init(check_running_bundle_integrity)
        .clone()
}

fn check_running_bundle_integrity() -> BundleIntegrityStatus {
    #[cfg(not(target_os = "macos"))]
    {
        return BundleIntegrityStatus::skipped("bundle signature verification is macOS-only");
    }

    #[cfg(target_os = "macos")]
    {
        let executable = match std::env::current_exe() {
            Ok(path) => path,
            Err(err) => {
                return BundleIntegrityStatus::skipped(format!(
                    "running executable path unavailable: {err}"
                ));
            }
        };
        let Some(bundle_path) = app_bundle_from_executable(&executable) else {
            return BundleIntegrityStatus::skipped("running outside a macOS app bundle");
        };

        match verify_bundle_with(&bundle_path, run_verification_command) {
            Ok(()) => BundleIntegrityStatus::verified(),
            Err(err) => BundleIntegrityStatus::invalid(err),
        }
    }
}

fn app_bundle_from_executable(executable: &Path) -> Option<PathBuf> {
    executable
        .ancestors()
        .find(|path| path.extension() == Some(OsStr::new("app")))
        .map(Path::to_path_buf)
}

fn verify_bundle_with<F>(bundle_path: &Path, mut run: F) -> Result<(), String>
where
    F: FnMut(&str, &[&str], &Path) -> Result<(), String>,
{
    run("codesign", &["--verify", "--deep", "--strict"], bundle_path)
        .map_err(|err| format!("codesign verification failed: {err}"))?;
    run("spctl", &["-a", "-vv"], bundle_path)
        .map_err(|err| format!("Gatekeeper assessment failed: {err}"))?;
    Ok(())
}

fn run_verification_command(
    program: &str,
    args: &[&str],
    bundle_path: &Path,
) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .arg(bundle_path)
        .output()
        .map_err(|err| format!("could not run {program}: {err}"))?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if !stderr.trim().is_empty() {
        stderr.trim()
    } else if !stdout.trim().is_empty() {
        stdout.trim()
    } else {
        "command exited unsuccessfully"
    };
    Err(detail.chars().take(600).collect())
}

fn emit_bundle_integrity_warning<R: Runtime>(app: &AppHandle<R>) {
    let status = running_bundle_integrity();
    if !status.is_invalid() {
        return;
    }

    log::error!(
        "[launch-updater] running app bundle failed signature verification: {}",
        status
            .detail
            .as_deref()
            .unwrap_or("unknown verification error")
    );
    if let Err(err) = app.emit(BUNDLE_SIGNATURE_INVALID_EVENT, status.clone()) {
        log::warn!(
            "[launch-updater] emit bundle-signature-invalid failed: {}",
            err
        );
    }
    if let Err(err) = app
        .notification()
        .builder()
        .title("o8 needs to be reinstalled")
        .body(REINSTALL_INSTRUCTION)
        .show()
    {
        log::warn!(
            "[launch-updater] bundle signature notification failed: {}",
            err
        );
    }
}

pub fn start_launch_update_check<R: Runtime>(app: AppHandle<R>) {
    if LAUNCH_UPDATE_CHECK_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }

    scheduler::observe_wake();
    tauri::async_runtime::spawn(async move {
        emit_bundle_integrity_warning(&app);

        scheduler::run(app).await;
    });
}

pub(super) async fn run_check<R: Runtime>(app: &AppHandle<R>) -> serde_json::Value {
    match crate::update_ping::check(app).await {
        Ok(Some(update)) => {
            let payload = LaunchUpdatePayload {
                channel: crate::update_ping::get_update_channel(app.clone()),
                version: update.version.clone(),
                current_version: update.current_version.clone(),
                notes: update.body.clone(),
                date: update.date.map(|date| date.to_string()),
                release_url: release_url_from_raw_json(&update.raw_json),
                checked_at: checked_at(),
            };
            let report = serde_json::json!({ "updatePending": true, "version": payload.version,
                    "channel": payload.channel, "checkOutcome": "available", "checkedAt": payload.checked_at, "info": payload });
            if let Err(err) = app.emit(UPDATE_AVAILABLE_EVENT, payload) {
                log::warn!("[launch-updater] emit update-available failed: {}", err);
            }
            report
        }
        Ok(None) => emit_clear(app, "current", None),
        Err(err) => {
            log::warn!("[launch-updater] check failed: {}", err);
            emit_clear(app, "failed", Some(bounded_check_error(err)))
        }
    }
}

fn emit_clear<R: Runtime>(
    app: &AppHandle<R>,
    outcome: &'static str,
    error: Option<String>,
) -> serde_json::Value {
    let payload = LaunchUpdateCheckPayload {
        channel: crate::update_ping::get_update_channel(app.clone()),
        outcome,
        checked_at: checked_at(),
        error,
    };
    let report = serde_json::json!({ "updatePending": false, "channel": payload.channel, "checkOutcome": outcome,
        "checkedAt": payload.checked_at, "checkError": payload.error });
    if let Err(err) = app.emit(UPDATE_CLEAR_EVENT, payload) {
        log::warn!("[launch-updater] emit update-clear failed: {}", err);
    }
    report
}

fn checked_at() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn bounded_check_error(error: impl std::fmt::Display) -> String {
    error.to_string().chars().take(1_000).collect()
}

fn release_url_from_raw_json(raw_json: &serde_json::Value) -> Option<String> {
    ["releaseUrl", "release_url", "url"]
        .iter()
        .find_map(|key| raw_json.get(key)?.as_str())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::{app_bundle_from_executable, verify_bundle_with};
    use std::path::{Path, PathBuf};

    #[test]
    fn finds_the_running_app_bundle_from_its_executable() {
        assert_eq!(
            app_bundle_from_executable(Path::new("/Applications/o8.app/Contents/MacOS/o8")),
            Some(PathBuf::from("/Applications/o8.app"))
        );
        assert_eq!(
            app_bundle_from_executable(Path::new("/tmp/o8/target/debug/o8")),
            None
        );
    }

    #[test]
    fn requires_codesign_before_gatekeeper_assessment() {
        let mut calls = Vec::new();
        let result =
            verify_bundle_with(Path::new("/Applications/o8.app"), |program, args, path| {
                calls.push((
                    program.to_string(),
                    args.iter()
                        .map(|arg| (*arg).to_string())
                        .collect::<Vec<_>>(),
                    path.to_path_buf(),
                ));
                Ok(())
            });

        assert_eq!(result, Ok(()));
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, "codesign");
        assert_eq!(calls[0].1, ["--verify", "--deep", "--strict"]);
        assert_eq!(calls[1].0, "spctl");
        assert_eq!(calls[1].1, ["-a", "-vv"]);
        assert_eq!(calls[1].2, PathBuf::from("/Applications/o8.app"));
    }

    #[test]
    fn aborts_before_gatekeeper_when_codesign_fails() {
        let mut calls = Vec::new();
        let result = verify_bundle_with(Path::new("/Applications/o8.app"), |program, _, _| {
            calls.push(program.to_string());
            Err("a sealed resource is missing or invalid".to_string())
        });

        assert_eq!(calls, ["codesign"]);
        assert_eq!(
            result,
            Err(
                "codesign verification failed: a sealed resource is missing or invalid".to_string()
            )
        );
    }
}
