//! Native automatic installs never depend on a webview listener or timer.
#[path = "update_install_journal.rs"]
pub(crate) mod install_journal;
#[path = "update_task.rs"]
mod task;
use reqwest::Client;
use serde_json::{json, Value};
use std::future::Future;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime};

#[cfg(not(test))]
pub(crate) const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);
#[cfg(test)]
pub(crate) const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(1);

pub(crate) async fn download(
    update: &tauri_plugin_updater::Update,
    on_chunk: impl FnMut(usize, Option<u64>),
    on_finish: impl FnOnce(),
) -> Result<Vec<u8>, String> {
    // The updater's check timeout is not inherited by its artifact transport.
    tokio::time::timeout(DOWNLOAD_TIMEOUT, update.download(on_chunk, on_finish))
        .await
        .map_err(|_| "Update artifact download timed out. Retry installation.".to_string())?
        .map_err(|error| error.to_string())
}

// Verified artifacts belong to this process only. Quitting drops the bytes.
#[derive(Default)]
pub(crate) struct HeldUpdate(std::sync::Mutex<Option<Held>>);
struct Held {
    update: tauri_plugin_updater::Update,
    bytes: Option<Vec<u8>>,
    phase: &'static str,
    error: Option<String>,
}
pub(crate) fn hold<R: Runtime>(app: &AppHandle<R>, update: tauri_plugin_updater::Update) {
    if app.try_state::<HeldUpdate>().is_none() {
        app.manage(HeldUpdate::default());
    }
    let state = app.state::<HeldUpdate>();
    let mut held = state.0.lock().unwrap();
    if held.as_ref().is_some_and(|h| {
        h.phase != "failed"
            && h.update.version == update.version
            && h.update.raw_json["_o8Epoch"] == update.raw_json["_o8Epoch"]
    }) {
        return;
    }
    *held = Some(Held {
        update,
        bytes: None,
        phase: "available",
        error: None,
    });
}
pub(crate) fn clear_held<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<HeldUpdate>() {
        *state.0.lock().unwrap() = None;
    }
}
pub(crate) fn held_status<R: Runtime>(app: &AppHandle<R>) -> Value {
    let snapshot = app.try_state::<HeldUpdate>().and_then(|state| {
        state.0.lock().unwrap().as_ref().map(|h| {
            (
                h.update.clone(),
                json!({"phase":h.phase,"version":h.update.version,"error":h.error}),
            )
        })
    });
    snapshot
        .filter(|(update, _)| crate::update_ping::ensure_update_channel(app, update).is_ok())
        .map(|(_, status)| status)
        .unwrap_or(Value::Null)
}
pub(crate) async fn stage<R: Runtime>(app: &AppHandle<R>, retry: bool) {
    let Some(state) = app.try_state::<HeldUpdate>() else {
        return;
    };
    let update = {
        let mut held = state.0.lock().unwrap();
        let Some(h) = held.as_mut() else { return };
        if h.phase != "available" && !(retry && h.phase == "failed") {
            return;
        }
        h.phase = "downloading";
        h.error = None;
        h.update.clone()
    };
    let result = match crate::update_ping::ensure_update_channel(app, &update) {
        Ok(()) => download(&update, |_, _| {}, || {}).await,
        Err(error) => Err(error),
    };
    let result = result.and_then(|bytes| {
        crate::update_ping::ensure_update_channel(app, &update)?;
        Ok(bytes)
    });
    let mut held = state.0.lock().unwrap();
    // A check may have cleared or replaced the held update while this one
    // downloaded; its bytes then belong to nothing and are dropped.
    let Some(h) = held.as_mut().filter(|h| {
        h.phase == "downloading"
            && h.update.version == update.version
            && h.update.raw_json["_o8Epoch"] == update.raw_json["_o8Epoch"]
    }) else {
        return;
    };
    match result {
        Ok(bytes) => {
            h.bytes = Some(bytes);
            h.phase = "ready";
        }
        Err(error) => {
            h.phase = "failed";
            h.error = Some(error);
        }
    }
}

pub trait Effects: Send + Sync {
    fn retry_failed(&self, _version: &str) -> Result<(), String> {
        Ok(())
    }

    fn data_directory(&self) -> Result<Option<std::path::PathBuf>, String> {
        Ok(None)
    }
    fn install(
        &self,
        version: &str,
        attempt_id: &str,
    ) -> impl Future<Output = Result<bool, String>> + Send;
    fn restart(&self) -> Result<(), String>;
}

pub struct NativeEffects<R: Runtime> {
    pub app: AppHandle<R>,
    pub client: Client,
    pub base: String,
    pub token: String,
}

impl<R: Runtime> Effects for NativeEffects<R> {
    fn retry_failed(&self, version: &str) -> Result<(), String> {
        let directory = self
            .data_directory()?
            .ok_or("Native update storage is unavailable")?;
        install_journal::InstallJournal::new(directory).retry_failed(version)
    }

    fn data_directory(&self) -> Result<Option<std::path::PathBuf>, String> {
        self.app
            .try_state::<o8_restart_safety::RestartSafety>()
            .map(|guard| Some(guard.data_directory()))
            .ok_or_else(|| "Native update ownership storage is not ready. Retry shortly.".into())
    }
    async fn install(&self, version: &str, attempt_id: &str) -> Result<bool, String> {
        let directory = self
            .data_directory()?
            .ok_or("Native update storage is unavailable")?;
        install_journal::InstallJournal::new(directory).check(version)?;
        let Some(update) = crate::update_ping::check(&self.app).await? else {
            return Ok(false);
        };
        if update.version != version {
            return Err(
                "The available version changed; retry after the next recorded check.".into(),
            );
        }
        self.install_candidate(update, attempt_id).await
    }

    fn restart(&self) -> Result<(), String> {
        self.restart_with(|| self.app.restart())
    }
}

impl<R: Runtime> NativeEffects<R> {
    pub(crate) fn restart_with(
        &self,
        relaunch: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        commit_restart(&self.app)?;
        relaunch()
    }

    /// Downloads the update while reporting its bytes to the server twice a
    /// second, for the Update panel's progress bar.
    async fn download_reporting(
        &self,
        update: &tauri_plugin_updater::Update,
        attempt_id: &str,
    ) -> Result<Vec<u8>, String> {
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
        use std::sync::Arc;
        let received = Arc::new(AtomicU64::new(0));
        let total = Arc::new(AtomicU64::new(0));
        let done = Arc::new(AtomicBool::new(false));
        let reporter = tauri::async_runtime::spawn({
            let (client, token, attempt_id) = (
                self.client.clone(),
                self.token.clone(),
                attempt_id.to_string(),
            );
            let url = format!("{}/api/panel/app/update-state", self.base);
            let (received, total, done) = (received.clone(), total.clone(), done.clone());
            async move {
                let mut reported = None;
                while !done.load(Ordering::Acquire) {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    let bytes = received.load(Ordering::Relaxed);
                    if reported == Some(bytes) {
                        continue;
                    }
                    reported = Some(bytes);
                    let length = total.load(Ordering::Relaxed);
                    let progress = json!({ "action": "progress", "attemptId": attempt_id,
                        "receivedBytes": bytes, "totalBytes": (length > 0).then_some(length) });
                    let _ = control(&client, &url, &token, progress).await;
                }
            }
        });
        let result = download(
            update,
            |chunk, length| {
                received.fetch_add(chunk as u64, Ordering::Relaxed);
                if let Some(length) = length {
                    total.store(length, Ordering::Relaxed);
                }
            },
            || {},
        )
        .await;
        done.store(true, Ordering::Release);
        reporter.abort();
        result
    }

    pub(crate) async fn install_candidate(
        &self,
        update: tauri_plugin_updater::Update,
        attempt_id: &str,
    ) -> Result<bool, String> {
        let version = &update.version;
        let generation = crate::update_ping::update_generation(&self.app, &update);
        let directory = self
            .data_directory()?
            .ok_or("Native update storage is unavailable")?;
        let journal = install_journal::InstallJournal::new(directory);
        journal.check(version)?;
        // Match the existing manual release-health kill switch, including fail-open transport.
        let mut health_url =
            reqwest::Url::parse(&format!("{}/api/panel/release-health", self.base))
                .map_err(|e| e.to_string())?;
        health_url.query_pairs_mut().append_pair("version", version);
        if let Ok(response) = self
            .client
            .get(health_url)
            .timeout(Duration::from_secs(4))
            .bearer_auth(&self.token)
            .send()
            .await
        {
            if response.status().is_success() {
                if let Ok(health) = response.json::<Value>().await {
                    if health["pulled"].as_bool() == Some(true) {
                        return Err("This release was paused. Waiting for a fixed build.".into());
                    }
                }
            }
        }
        crate::update_ping::ensure_update_channel(&self.app, &update)?;
        let cached = self.app.try_state::<HeldUpdate>().and_then(|state| {
            let mut held = state.0.lock().unwrap();
            held.as_mut()
                .filter(|h| {
                    h.update.version == update.version
                        && h.update.raw_json["_o8Epoch"] == update.raw_json["_o8Epoch"]
                })
                .and_then(|h| h.bytes.clone())
        });
        let bytes = match cached {
            Some(bytes) => bytes,
            None => self.download_reporting(&update, attempt_id).await?,
        };
        crate::update_ping::ensure_epoch(&self.app, generation)?;
        let admission = control(
            &self.client,
            &format!("{}/api/panel/app/update-state", self.base),
            &self.token,
            json!({ "action": "install", "attemptId": attempt_id }),
        )
        .await?;
        if admission["allowed"].as_bool() != Some(true) {
            return Ok(false);
        }
        crate::update_ping::ensure_update_channel(&self.app, &update)?;
        let installed = crate::update_ping::install_in_channel(&self.app, generation, || {
            journal.install_if_admitted(
                version,
                || match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    update.install(bytes)
                })) {
                    Ok(result) => result.map(|_| true).map_err(|error| error.to_string()),
                    Err(error) if error.is::<crate::update_ping::RestartRefused>() => Ok(false),
                    Err(_) => Err("Native installer stopped unexpectedly.".into()),
                },
                || Ok(()),
            )
        })?;
        // Windows success exits inside the plugin. Any returned error stays here,
        // and its durable marker prevents an unchanged launch from retrying it.
        Ok(installed)
    }
}

pub(crate) fn commit_restart<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    commit_restart_with_work(app, false)
}

pub(crate) fn commit_restart_with_work<R: Runtime>(
    app: &AppHandle<R>,
    force: bool,
) -> Result<(), String> {
    let guard = app
        .try_state::<o8_restart_safety::RestartSafety>()
        .ok_or("Native restart safety is unavailable")?;
    let reservation = guard.prepare_with_work(force)?;
    if let Err(error) = guard.before_restart(Some(&reservation)) {
        let _ = guard.cancel(&reservation);
        return Err(error);
    }
    Ok(())
}

struct Attempt {
    manual: bool,
    id: String,
    version: String,
    installed: bool,
}

pub struct AutoApply {
    interval: Duration,
    last_attempt: Option<Instant>,
    attempt: Option<Attempt>,
    pending_id: Option<String>,
    failure_report: Option<Value>,
    owner: Option<task::TaskOwner>,
}

async fn control(client: &Client, url: &str, token: &str, action: Value) -> Result<Value, String> {
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(&json!({ "autoApply": action }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err("Automatic update admission is unavailable".into());
    }
    response.json().await.map_err(|e| e.to_string())
}

impl AutoApply {
    pub fn new(interval: Duration) -> Self {
        Self {
            interval,
            last_attempt: None,
            attempt: None,
            pending_id: None,
            failure_report: None,
            owner: None,
        }
    }
    /// The next tick admits immediately instead of waiting out the interval.
    pub fn expedite(&mut self) {
        self.last_attempt = None;
    }
    pub async fn tick(&mut self, client: &Client, url: &str, token: &str, effects: &impl Effects) {
        if self
            .last_attempt
            .is_some_and(|at| at.elapsed() < self.interval)
        {
            return;
        }
        let result = self.apply(client, url, token, effects).await;
        // A long download is not a wake event or a reason to retry immediately.
        self.last_attempt = Some(Instant::now());
        if let Err(error) = result {
            log::warn!("[updater] auto-apply deferred: {error}");
        }
    }

    async fn apply(
        &mut self,
        client: &Client,
        url: &str,
        token: &str,
        effects: &impl Effects,
    ) -> Result<(), String> {
        if let Some(report) = &self.failure_report {
            control(client, url, token, report.clone()).await?;
            self.failure_report = None;
            return Ok(());
        }
        if self.attempt.is_none() {
            let id = self
                .pending_id
                .get_or_insert_with(|| uuid::Uuid::new_v4().to_string());
            if self.owner.is_none() {
                if let Some(directory) = effects.data_directory()? {
                    self.owner = Some(task::TaskOwner::new(
                        directory.join("native-update-tasks"),
                        id,
                    )?);
                }
            }
            let admission = control(
                client,
                url,
                token,
                json!({ "action": "admit", "attemptId": id }),
            )
            .await?;
            if admission["allowed"].as_bool() != Some(true) {
                return Ok(());
            }
            let version = admission["version"]
                .as_str()
                .ok_or("Missing update version")?
                .to_string();
            self.attempt = Some(Attempt {
                manual: admission["manual"].as_bool() == Some(true),
                id: admission["attemptId"]
                    .as_str()
                    .ok_or("Missing update attempt")?
                    .into(),
                installed: admission["installed"].as_bool() == Some(true),
                version,
            });
        }
        let attempt = self.attempt.as_mut().unwrap();
        if !attempt.installed {
            let retry = if attempt.manual {
                effects.retry_failed(&attempt.version)
            } else {
                Ok(())
            };
            let outcome = match retry {
                Ok(()) => effects.install(&attempt.version, &attempt.id).await,
                Err(error) => Err(error),
            };
            match outcome {
                Ok(true) => {
                    attempt.installed = true;
                }
                outcome => {
                    self.failure_report = Some(match outcome {
                        Ok(false) => json!({ "action": "wait", "attemptId": attempt.id }),
                        Err(error) => {
                            json!({ "action": "failed", "attemptId": attempt.id, "error": error })
                        }
                        Ok(true) => unreachable!(),
                    });
                    self.attempt = None;
                    self.pending_id = None;
                    self.owner = None;
                    control(
                        client,
                        url,
                        token,
                        self.failure_report.as_ref().unwrap().clone(),
                    )
                    .await?;
                    self.failure_report = None;
                    return Ok(());
                }
            }
        }
        let admission = control(
            client,
            url,
            token,
            json!({ "action": "restart", "attemptId": attempt.id }),
        )
        .await?;
        if admission["attemptMissing"].as_bool() == Some(true) {
            self.attempt = None;
            self.pending_id = None;
            self.owner = None;
            return Ok(());
        }
        if admission["allowed"].as_bool() == Some(true) {
            if let Err(error) = effects.restart() {
                control(
                    client,
                    url,
                    token,
                    json!({ "action": "failed", "attemptId": attempt.id, "error": error }),
                )
                .await?;
                return Err(error);
            }
        }
        Ok(())
    }
}
