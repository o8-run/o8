//! Native updater for the launcher (step 4 of #6130). macOS only; every other
//! platform answers "unsupported" without touching anything.
//!
//! Release-side compatibility: the feeds, the minisign public key, the manifest
//! shape and the `.app.tar.gz` layout are the ones the classic shell's updater
//! (`tauri-plugin-updater` 2.10, configured in `src-tauri/tauri.conf.json` and
//! driven by `src-tauri/src/update_ping.rs`) consumes today, so the release
//! scripts need no change. See `UPDATER.md` next to the README.
//!
//! Order of an install: check, download to a private file under a size bound,
//! verify the minisign signature over the downloaded bytes, unpack into a
//! private staging directory beside the bundle (refusing traversal, absolute
//! paths, links that leave the bundle and special files), compare the staged
//! bundle's version with the feed, then, after the launcher's bounded shutdown
//! proved its servers stopped, swap the staged bundle with the installed one in
//! one `renamex_np(RENAME_SWAP)` call and relaunch. The installed path holds a
//! complete bundle at every instant; see [`recover`].
use crate::ownership::{private_write, sync_parent};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
    time::Duration,
};

/// The classic shell's updater public key (`plugins.updater.pubkey` in
/// `src-tauri/tauri.conf.json`), base64 of the minisign public key file.
/// A unit test keeps the two identical.
pub const PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDg2NTIxQTI4MjkyODVGQTcKUldTblh5Z3BLQnBTaHI4VWFFM1VMVG1ZTU0wOExQQmRiYlZyZUJ3UExSUWVyRFpvcFNKQkZ4Uy8K";
/// The classic shell's updater endpoints (`plugins.updater.endpoints`): the
/// update service first, then the static manifest mirror. Same order, same
/// templates.
pub const ENDPOINTS: [&str; 2] = [
    "https://api.o8.run/v1/update/{{target}}/{{arch}}/{{current_version}}",
    "https://github.com/hurttlocker/o8-releases/releases/latest/download/latest.json",
];
/// Identical to the classic updater's requests, so the service sees no change.
const USER_AGENT: &str = "tauri-plugin-updater/2.10.0";
/// The classic shell stores enrollment in its app config directory.
const SETTINGS_IDENTIFIER: &str = "ai.o8.desktop";
const SERVICE_TIMEOUT: Duration = Duration::from_secs(2);
const FALLBACK_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Largest archive accepted. Release archives are a few hundred megabytes.
pub const MAX_DOWNLOAD: u64 = 1 << 30;
const MAX_MANIFEST: u64 = 1 << 20;
/// Bounds on the unpacked bundle, against a compressed archive that expands without end.
const MAX_UNPACKED: u64 = 8 << 30;
const MAX_ENTRIES: u64 = 250_000;
const JOURNAL: &str = "update-journal.json";
const LAST: &str = "update-last.json";

/// Optional `update` block of the launcher configuration. Only `settings` is
/// honoured in release builds; the rest exist for fixtures and are refused
/// outside debug builds so a configuration file can never swap the key or feed.
#[derive(Clone, Default, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateConfig {
    /// Enrollment file (`update-ping.json`) shared with the classic shell.
    pub settings: Option<PathBuf>,
    /// Debug builds only: the installed bundle, instead of the running one.
    pub bundle: Option<PathBuf>,
    /// Debug builds only.
    pub endpoints: Option<Vec<String>>,
    /// Debug builds only.
    pub pubkey: Option<String>,
    /// Debug builds only.
    pub max_download_bytes: Option<u64>,
    /// Debug fixtures only: delay the first background check.
    pub background_delay_ms: Option<u64>,
}

/// How the replacement is started once installed: the launcher's own
/// arguments and the environment it was started with, before any change.
#[derive(Clone)]
pub struct Relaunch {
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
}

pub struct Updater {
    current: semver::Version,
    bundle: PathBuf,
    settings: PathBuf,
    endpoints: Vec<String>,
    pubkey: String,
    max_download: u64,
    data_dir: PathBuf,
    background_delay: Duration,
}

#[derive(Clone, Debug, Serialize)]
pub struct Release {
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
    #[serde(skip)]
    url: String,
    #[serde(skip)]
    signature: String,
}

/// A verified bundle unpacked beside the installed one, waiting for the
/// launcher to stop its servers.
pub struct Staged {
    pub release: Release,
    app: PathBuf,
    executable: String,
    installed: (u64, u64),
}

#[derive(Serialize, Deserialize)]
struct Journal {
    phase: String,
    bundle: PathBuf,
    from: String,
    to: String,
}

fn debug_only<T>(value: Option<T>, name: &str) -> Result<Option<T>, String> {
    if value.is_some() && !cfg!(debug_assertions) {
        return Err(format!("update.{name} is only accepted by debug builds"));
    }
    Ok(value)
}

fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    }
}

impl Updater {
    /// `Err` is the reason updates are unavailable; the launcher still runs.
    pub fn new(
        version: &str,
        data_dir: &Path,
        config: Option<&UpdateConfig>,
    ) -> Result<Self, String> {
        if !cfg!(target_os = "macos") {
            return Err("The native updater runs on macOS only".into());
        }
        let config = config.cloned().unwrap_or_default();
        let current = semver::Version::parse(version.trim_start_matches('v'))
            .map_err(|_| format!("Current version {version:?} is not a release version"))?;
        let bundle = match debug_only(config.bundle, "bundle")? {
            Some(bundle) => bundle,
            None => std::env::current_exe()
                .ok()
                .and_then(|exe| {
                    exe.ancestors()
                        .find(|path| path.extension().is_some_and(|ext| ext == "app"))
                        .map(Path::to_path_buf)
                })
                .ok_or("o8 is not running from an app bundle")?,
        };
        let settings = match config.settings {
            Some(path) => path,
            None => PathBuf::from(std::env::var_os("HOME").ok_or("Home directory unavailable")?)
                .join("Library/Application Support")
                .join(SETTINGS_IDENTIFIER)
                .join("update-ping.json"),
        };
        let endpoints = debug_only(config.endpoints, "endpoints")?
            .unwrap_or_else(|| ENDPOINTS.iter().map(|e| e.to_string()).collect());
        if endpoints.len() < 2 {
            return Err("Updater needs a service endpoint and a manifest mirror".into());
        }
        Ok(Self {
            current,
            bundle,
            settings,
            endpoints,
            pubkey: debug_only(config.pubkey, "pubkey")?.unwrap_or_else(|| PUBLIC_KEY.into()),
            max_download: debug_only(config.max_download_bytes, "max_download_bytes")?
                .unwrap_or(MAX_DOWNLOAD),
            data_dir: data_dir.to_path_buf(),
            background_delay: Duration::from_millis(
                debug_only(config.background_delay_ms, "background_delay_ms")?.unwrap_or(1000),
            ),
        })
    }

    pub fn current(&self) -> String {
        self.current.to_string()
    }

    fn settings(&self) -> serde_json::Map<String, serde_json::Value> {
        fs::read(&self.settings)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Same resolution as the classic shell: an acknowledged pending choice,
    /// then the saved choice, then the build's own channel. Read-only: the
    /// enrollment file stays owned by the window that edits it.
    pub fn channel(&self) -> String {
        let settings = self.settings();
        for key in ["pendingChannel", "channel"] {
            if let Some(channel) = settings.get(key).and_then(|v| v.as_str()) {
                if channel == "stable" || channel == "beta" {
                    return channel.into();
                }
            }
        }
        if self.current.pre.as_str().starts_with("preview.") {
            "preview".into()
        } else {
            "stable".into()
        }
    }

    fn install_id(&self) -> Option<String> {
        let id = self.settings().get("installId")?.as_str()?.to_owned();
        let parsed = uuid::Uuid::parse_str(&id).ok()?;
        (parsed.get_version_num() == 4 && parsed.get_variant() == uuid::Variant::RFC4122)
            .then_some(id)
    }

    /// Why this install location cannot be updated in place, if it cannot.
    pub fn blocked(&self) -> Option<String> {
        installable(&self.bundle).err()
    }

    /// `Ok(None)`: no newer release on the enrolled channel.
    pub fn check(&self) -> Result<Option<Release>, String> {
        let channel = self.channel();
        if channel != "beta" {
            return self.check_channel(&channel, false);
        }
        // Beta enrollment also follows Stable, taking whichever is newer.
        let beta = self.check_channel("beta", true);
        let stable = self.check_channel("stable", false);
        match (beta, stable) {
            (Ok(Some(beta)), Ok(Some(stable))) => {
                let a = semver::Version::parse(&beta.version).map_err(|e| e.to_string())?;
                let b = semver::Version::parse(&stable.version).map_err(|e| e.to_string())?;
                Ok(Some(if a > b { beta } else { stable }))
            }
            (Ok(Some(update)), _) | (_, Ok(Some(update))) => Ok(Some(update)),
            (Ok(None), Ok(None)) => Ok(None),
            (Err(error), _) | (_, Err(error)) => Err(error),
        }
    }

    fn check_channel(
        &self,
        channel: &str,
        mirror_when_current: bool,
    ) -> Result<Option<Release>, String> {
        let service = &self.endpoints[0];
        let fallback = self.endpoints[1..]
            .iter()
            .map(|endpoint| channel_fallback(endpoint, channel))
            .collect::<Result<Vec<_>, _>>()?;
        if let Some(id) = self.install_id() {
            let mut headers = vec![("X-O8-Install-Id", id), ("X-O8-Channel", channel.into())];
            if let Some(version) = macos_version() {
                headers.push(("X-O8-Macos-Version", version));
            }
            // Any service failure, redirect or wrong identity falls back to the mirror.
            if let Ok(result) = self
                .fetch(service, SERVICE_TIMEOUT, &headers, true)
                .and_then(|result| validate_identity(result, channel))
            {
                if result.is_some() || !mirror_when_current {
                    return Ok(result);
                }
            }
        }
        let mut last = Err("No update manifest was found".to_string());
        for url in &fallback {
            match self.fetch(url, FALLBACK_TIMEOUT, &[], false) {
                Ok(result) => return validate_identity(result, channel),
                Err(error) => last = Err(error),
            }
        }
        last
    }

    fn fetch(
        &self,
        template: &str,
        timeout: Duration,
        headers: &[(&str, String)],
        stop_redirects: bool,
    ) -> Result<Option<(Release, serde_json::Value)>, String> {
        let url = template
            .replace(
                "{{current_version}}",
                &self.current.to_string().replace('+', "%2B"),
            )
            .replace("{{target}}", "darwin")
            .replace("{{arch}}", arch())
            .replace("{{bundle_type}}", "app");
        require_scheme(&url)?;
        let client = client(timeout, stop_redirects)?;
        let mut request = client.get(&url);
        for (name, value) in headers {
            request = request.header(*name, value);
        }
        let response = request
            .send()
            .map_err(|e| format!("Update check failed: {e}"))?;
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!("Update endpoint answered {}", response.status()));
        }
        let mut body = Vec::new();
        response
            .take(MAX_MANIFEST + 1)
            .read_to_end(&mut body)
            .map_err(|e| format!("Update manifest unreadable: {e}"))?;
        if body.len() as u64 > MAX_MANIFEST {
            return Err("Update manifest is too large".into());
        }
        let raw: serde_json::Value =
            serde_json::from_slice(&body).map_err(|e| format!("Update manifest invalid: {e}"))?;
        let release = parse_release(&raw)?;
        let version = semver::Version::parse(&release.version).map_err(|e| e.to_string())?;
        // Strictly newer only, as the classic updater: never a downgrade or a reinstall.
        Ok((version > self.current).then_some((release, raw)))
    }

    fn staging(&self) -> Result<PathBuf, String> {
        staging_for(&self.bundle)
    }

    /// Check, download, verify and unpack. Never touches the installed bundle.
    pub fn stage(&self) -> Result<Staged, String> {
        installable(&self.bundle)?;
        let installed = fs::symlink_metadata(&self.bundle)
            .map(|m| (m.dev(), m.ino()))
            .map_err(|e| format!("Installed app unavailable: {e}"))?;
        let release = self.check()?.ok_or("No newer update is available")?;
        let downloads = self.data_dir.join("updates");
        private_dir(&downloads)?;
        let archive_path = downloads.join(format!("{}.app.tar.gz", uuid::Uuid::new_v4().simple()));
        let staged = (|| {
            let mut archive = download(&release.url, &archive_path, self.max_download)?;
            // The signature covers these exact bytes; nothing is unpacked before it holds.
            verify(&mut archive, &release.signature, &self.pubkey)?;
            let staging = self.staging()?;
            private_dir(&staging)?;
            let unpack_root = staging.join("staged");
            remove_private(&unpack_root)?;
            private_dir(&unpack_root)?;
            let name = self.bundle.file_name().ok_or("Installed app has no name")?;
            let app = unpack_root.join(name);
            unpack(&mut archive, &app)?;
            let (version, executable) = bundle_info(&app)?;
            if semver::Version::parse(&version).ok()
                != semver::Version::parse(&release.version).ok()
            {
                return Err(format!(
                    "Archive holds version {version}, the feed announced {}",
                    release.version
                ));
            }
            Ok(Staged {
                release: release.clone(),
                app,
                executable,
                installed,
            })
        })();
        let _ = fs::remove_file(&archive_path);
        if staged.is_err() {
            if let Ok(staging) = self.staging() {
                let _ = remove_private(&staging.join("staged"));
            }
        }
        staged
    }

    /// Swaps the staged bundle in and starts it. Call only after the servers
    /// were proven stopped and the instance lock released.
    pub fn install(&self, staged: Staged, relaunch: &Relaunch) -> Result<(), String> {
        let from = self.current.to_string();
        let to = staged.release.version.clone();
        // Fails only before the swap: the installed bundle is untouched.
        if let Err(error) = self.swap_in(&staged, &from, &to) {
            if let Some(unpacked) = staged.app.parent() {
                let _ = remove_private(unpacked);
            }
            self.record("failed", &from, &to, Some(&error));
            return Err(error);
        }
        let executable = self.bundle.join("Contents/MacOS").join(&staged.executable);
        if let Err(error) = start(&executable, relaunch) {
            // The new bundle could not even be started: put the previous one back.
            let previous = self
                .staging()?
                .join("previous")
                .join(self.bundle.file_name().unwrap());
            let restored = rename_swap(&previous, &self.bundle).is_ok();
            let message = format!(
                "The new version could not be started ({error}); {}",
                if restored {
                    "the previous version was restored"
                } else {
                    "restoring the previous version failed"
                }
            );
            self.record("failed", &from, &to, Some(&message));
            if restored {
                if let Ok((_, executable)) = bundle_info(&self.bundle) {
                    let _ = start(
                        &self.bundle.join("Contents/MacOS").join(executable),
                        relaunch,
                    );
                }
            }
            return Err(message);
        }
        Ok(())
    }

    /// The servers could not be proven stopped: nothing is replaced.
    pub fn abandon(&self, staged: Staged, reason: &str) {
        if let Some(unpacked) = staged.app.parent() {
            let _ = remove_private(unpacked);
        }
        let message = format!("{reason}; the installed app was left unchanged");
        crate::note!("Update not installed: {message}");
        self.record(
            "failed",
            &self.current.to_string(),
            &staged.release.version,
            Some(&message),
        );
    }

    fn swap_in(&self, staged: &Staged, from: &str, to: &str) -> Result<(), String> {
        installable(&self.bundle)?;
        let now = fs::symlink_metadata(&self.bundle)
            .map(|m| (m.dev(), m.ino()))
            .map_err(|e| format!("Installed app unavailable: {e}"))?;
        if now != staged.installed {
            return Err("The installed app changed while the update was prepared".into());
        }
        let journal = |phase: &str| {
            let record = Journal {
                phase: phase.into(),
                bundle: self.bundle.clone(),
                from: from.into(),
                to: to.into(),
            };
            private_write(
                &self.data_dir.join(JOURNAL),
                &serde_json::to_vec(&record).unwrap_or_default(),
            )
            .map_err(|e| format!("Update journal unavailable: {e}"))
        };
        journal("swapping")?;
        fault("before-swap");
        if let Err(error) = rename_swap(&staged.app, &self.bundle) {
            let _ = fs::remove_file(self.data_dir.join(JOURNAL));
            return Err(format!("The app could not be replaced: {error}"));
        }
        let _ = sync_parent(&self.bundle);
        let _ = sync_parent(&staged.app);
        fault("after-swap");
        // The previous bundle now sits at the staged path. Failing to move it
        // aside never undoes the install; the next update clears the slot.
        if let Err(error) = self.keep_previous(&staged.app) {
            crate::note!("{error}");
        }
        self.record("installed", from, to, None);
        let _ = fs::remove_file(self.data_dir.join(JOURNAL));
        let _ = sync_parent(&self.data_dir.join(JOURNAL));
        Ok(())
    }

    fn keep_previous(&self, old: &Path) -> Result<(), String> {
        let previous = self.staging()?.join("previous");
        remove_private(&previous)?;
        private_dir(&previous)?;
        let name = self.bundle.file_name().ok_or("Installed app has no name")?;
        fs::rename(old, previous.join(name)).map_err(|e| format!("Previous app not kept: {e}"))?;
        let _ = remove_private(&self.staging()?.join("staged"));
        Ok(())
    }

    fn record(&self, outcome: &str, from: &str, to: &str, error: Option<&String>) {
        let record = serde_json::json!({
            "outcome": outcome, "from": from, "to": to, "error": error,
            "at": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        });
        let _ = private_write(&self.data_dir.join(LAST), record.to_string().as_bytes());
    }

    /// The last install outcome, kept across the relaunch.
    pub fn last(&self) -> Option<serde_json::Value> {
        fs::read(self.data_dir.join(LAST))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }

    /// Settles an install interrupted by a crash or power loss. The installed
    /// path is never empty or partial: unpacking happens in a separate
    /// directory, and the only change to the installed path is one atomic
    /// `RENAME_SWAP`, so it holds the old or the new bundle. Recovery only
    /// decides which by reading the installed version, records it, keeps the
    /// replaced bundle and removes leftovers.
    pub fn recover(&self) {
        let downloads = self.data_dir.join("updates");
        if let Ok(entries) = fs::read_dir(&downloads) {
            for entry in entries.flatten() {
                let _ = fs::remove_file(entry.path());
            }
        }
        let path = self.data_dir.join(JOURNAL);
        let Some(journal) = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Journal>(&bytes).ok())
        else {
            if fs::symlink_metadata(&path).is_ok() {
                crate::note!("Update journal unreadable; removed");
                let _ = fs::remove_file(&path);
            }
            if let Ok(staging) = self.staging() {
                let _ = remove_private(&staging.join("staged"));
            }
            return;
        };
        if journal.bundle != self.bundle {
            crate::note!("Update journal names another install; removed");
            let _ = fs::remove_file(&path);
            return;
        }
        let installed = bundle_info(&self.bundle).map(|(version, _)| version);
        let Ok(staging) = self.staging() else {
            return;
        };
        let staged = staging
            .join("staged")
            .join(self.bundle.file_name().unwrap_or_default());
        if installed.as_deref() == Ok(journal.to.as_str()) {
            // Swapped before the interruption: what sits in the staged slot is the old bundle.
            if fs::symlink_metadata(&staged).is_ok() {
                if let Err(error) = self.keep_previous(&staged) {
                    crate::note!("{error}");
                }
            }
            self.record("installed", &journal.from, &journal.to, None);
            crate::note!("Update to {} completed after an interruption", journal.to);
        } else {
            let _ = remove_private(&staging.join("staged"));
            self.record(
                "failed",
                &journal.from,
                &journal.to,
                Some(&"Interrupted before the swap; the installed version was kept".to_string()),
            );
            crate::note!(
                "Update to {} was interrupted; the installed version was kept",
                journal.to
            );
        }
        let _ = fs::remove_file(&path);
        let _ = sync_parent(&path);
    }
}

enum Outcome {
    Checked(Result<Option<Release>, String>),
    Staged(Box<Result<Staged, String>>),
}

/// Drives the updater from the launcher's main loop without blocking it:
/// network and disk work run on one worker thread at a time.
pub struct Controller {
    updater: Result<std::sync::Arc<Updater>, String>,
    job: Option<std::sync::mpsc::Receiver<Outcome>>,
    waiting: Vec<std::os::unix::net::UnixStream>,
    state: &'static str,
    available: Option<Release>,
    error: Option<String>,
    ready: Option<Staged>,
    install_requested: bool,
    background_check: bool,
    next_check: std::time::Instant,
}

impl Controller {
    /// Settles any interrupted install before anything else starts.
    pub fn new(updater: Result<Updater, String>) -> Self {
        if let Ok(updater) = &updater {
            updater.recover();
        }
        let delay = updater
            .as_ref()
            .map_or(Duration::from_secs(3600), |u| u.background_delay);
        Self {
            state: if updater.is_ok() {
                "idle"
            } else {
                "unsupported"
            },
            updater: updater.map(std::sync::Arc::new),
            job: None,
            waiting: Vec::new(),
            available: None,
            error: None,
            ready: None,
            install_requested: false,
            background_check: false,
            next_check: std::time::Instant::now() + delay,
        }
    }

    pub fn updater(&self) -> Option<&Updater> {
        self.updater.as_ref().ok().map(|u| u.as_ref())
    }

    pub fn status(&self) -> serde_json::Value {
        match &self.updater {
            Err(reason) => {
                serde_json::json!({"ok": false, "state": "unsupported", "error": reason})
            }
            Ok(updater) => serde_json::json!({
                "ok": true,
                "state": self.state,
                "current": updater.current(),
                "channel": updater.channel(),
                "available": self.available,
                "error": self.error,
                "blocked": updater.blocked(),
                "last": updater.last(),
            }),
        }
    }

    fn busy(&self) -> Option<serde_json::Value> {
        (self.job.is_some() || self.ready.is_some()).then(
            || serde_json::json!({"ok": false, "state": self.state, "error": "An update is already in progress"}),
        )
    }

    /// The answer arrives when the check finishes; `None` when it is pending.
    pub fn check(&mut self) -> Option<serde_json::Value> {
        let updater = match &self.updater {
            Err(_) => return Some(self.status()),
            Ok(updater) => updater.clone(),
        };
        if let Some(refusal) = self.busy() {
            return Some(refusal);
        }
        self.state = "checking";
        self.error = None;
        self.spawn(move || Outcome::Checked(updater.check()));
        None
    }

    pub fn wait(&mut self, peer: std::os::unix::net::UnixStream) {
        self.waiting.push(peer);
    }

    /// Starts download, verification and staging. The install itself waits for
    /// restart admission and the bounded shutdown.
    pub fn apply(&mut self) -> serde_json::Value {
        let updater = match &self.updater {
            Err(_) => return self.status(),
            Ok(updater) => updater.clone(),
        };
        if self.ready.is_some() {
            self.install_requested = true;
            return serde_json::json!({"ok": true, "state": "staged"});
        }
        if let Some(refusal) = self.busy() {
            return refusal;
        }
        if let Some(reason) = updater.blocked() {
            // Reported before any download: nothing is changed.
            self.state = "failed";
            self.error = Some(reason.clone());
            return serde_json::json!({"ok": false, "state": "failed", "error": reason});
        }
        self.install_requested = true;
        self.state = "staging";
        self.error = None;
        self.spawn(move || Outcome::Staged(Box::new(updater.stage())));
        serde_json::json!({"ok": true, "state": "staging"})
    }

    fn spawn(&mut self, work: impl FnOnce() -> Outcome + Send + 'static) {
        let (send, receive) = std::sync::mpsc::channel();
        self.job = Some(receive);
        let spawned = std::thread::Builder::new()
            .name("launcher-update".into())
            .spawn(move || {
                let _ = send.send(work());
            });
        if spawned.is_err() {
            self.job = None;
            self.state = "failed";
            self.error = Some("Update worker unavailable".into());
        }
    }

    /// Collects a finished job; returns a staged update ready for admission.
    pub fn poll(&mut self) -> Option<&Release> {
        if self.install_requested && self.ready.is_some() {
            return self.ready.as_ref().map(|staged| &staged.release);
        }
        if self.job.is_none()
            && self.ready.is_none()
            && std::time::Instant::now() >= self.next_check
        {
            self.next_check = std::time::Instant::now() + Duration::from_secs(3600);
            if self.updater.is_ok() {
                self.background_check = true;
                self.check();
            }
        }
        let outcome = match self.job.as_ref().map(|job| job.try_recv()) {
            Some(Ok(outcome)) => outcome,
            Some(Err(std::sync::mpsc::TryRecvError::Disconnected)) => {
                Outcome::Checked(Err("Update worker stopped".into()))
            }
            _ => return None,
        };
        self.job = None;
        match outcome {
            Outcome::Checked(result) => {
                let answer = match result {
                    Ok(release) => {
                        self.state = if release.is_some() {
                            "available"
                        } else {
                            "current"
                        };
                        self.available = release;
                        self.status()
                    }
                    Err(error) => {
                        self.state = "failed";
                        self.error = Some(error);
                        let mut answer = self.status();
                        answer["ok"] = false.into();
                        answer
                    }
                };
                if self.background_check {
                    self.background_check = false;
                    if self.state == "available" {
                        self.apply();
                        self.install_requested = false;
                    }
                }
                for mut peer in self.waiting.drain(..) {
                    let _ = writeln!(peer, "{answer}");
                }
            }
            Outcome::Staged(result) => match *result {
                Ok(staged) => {
                    self.state = "staged";
                    self.available = Some(staged.release.clone());
                    self.ready = Some(staged);
                    if self.install_requested {
                        return self.ready.as_ref().map(|staged| &staged.release);
                    }
                }
                Err(error) => {
                    crate::note!("Update not staged: {error}");
                    self.state = "failed";
                    self.error = Some(error);
                }
            },
        }
        None
    }

    /// Admission refused: the staged bundle is discarded and the app is untouched.
    pub fn deferred(&mut self, error: String) {
        if let Some(staged) = self.ready.take() {
            if let Some(unpacked) = staged.app.parent() {
                let _ = remove_private(unpacked);
            }
        }
        self.state = "failed";
        self.error = Some(error);
    }

    /// Admission granted: the caller installs after the bounded shutdown.
    pub fn take_ready(&mut self) -> Option<Staged> {
        self.state = "installing";
        self.ready.take()
    }
}

fn require_scheme(url: &str) -> Result<(), String> {
    if url.starts_with("https://")
        || (cfg!(debug_assertions) && url.starts_with("http://127.0.0.1:"))
    {
        Ok(())
    } else {
        Err("Update URLs must use HTTPS".into())
    }
}

fn client(timeout: Duration, stop_redirects: bool) -> Result<reqwest::blocking::Client, String> {
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if stop_redirects {
            // A service redirect means fail over locally, as the classic updater does.
            attempt.stop()
        } else if attempt.previous().len() >= 10 {
            attempt.error("too many redirects")
        } else if require_scheme(attempt.url().as_str()).is_err() {
            attempt.error("redirect away from HTTPS")
        } else {
            attempt.follow()
        }
    });
    reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(15))
        .timeout(timeout)
        .redirect(policy)
        .build()
        .map_err(|e| format!("Update client unavailable: {e}"))
}

fn macos_version() -> Option<String> {
    let output = std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    let version = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (output.status.success()
        && !version.is_empty()
        && version.chars().all(|c| c.is_ascii_digit() || c == '.'))
    .then_some(version)
}

/// The classic shell's manifest name per channel, beside the mirror's `latest.json`.
pub fn channel_fallback(endpoint: &str, channel: &str) -> Result<String, String> {
    let name = match channel {
        "stable" => "latest.json",
        "beta" => "beta.json",
        "preview" => "preview.json",
        _ => return Err("Unknown update channel".into()),
    };
    if channel == "beta" {
        // GitHub keeps the rolling Beta manifest on its own prerelease tag.
        if let Some(root) = endpoint.strip_suffix("/releases/latest/download/latest.json") {
            return Ok(format!("{root}/releases/download/beta/beta.json"));
        }
    }
    let parent = endpoint
        .strip_suffix("latest.json")
        .ok_or("Updater fallback has no manifest sibling")?;
    Ok(format!("{parent}{name}"))
}

fn validate_identity(
    result: Option<(Release, serde_json::Value)>,
    expected: &str,
) -> Result<Option<Release>, String> {
    match result {
        Some((_, raw)) if raw["channel"].as_str() != Some(expected) => {
            Err("Update manifest channel identity does not match enrollment".into())
        }
        Some((release, _)) => Ok(Some(release)),
        None => Ok(None),
    }
}

#[derive(Deserialize)]
struct Platform {
    url: String,
    signature: String,
}

/// The classic updater's two manifest shapes: static (`platforms` keyed by
/// target) and the service's dynamic one (`url` and `signature` at the top).
pub fn parse_release(raw: &serde_json::Value) -> Result<Release, String> {
    #[derive(Deserialize)]
    struct Raw {
        #[serde(alias = "name")]
        version: String,
        notes: Option<String>,
        pub_date: Option<String>,
        platforms: Option<HashMap<String, Platform>>,
        url: Option<String>,
        signature: Option<String>,
    }
    let parsed: Raw =
        serde_json::from_value(raw.clone()).map_err(|e| format!("Update manifest invalid: {e}"))?;
    let version = parsed.version.trim_start_matches('v').to_owned();
    semver::Version::parse(&version).map_err(|e| format!("Update version invalid: {e}"))?;
    let platform = match parsed.platforms {
        Some(mut platforms) => {
            let targets = [
                format!("darwin-{}-app", arch()),
                format!("darwin-{}", arch()),
            ];
            targets
                .iter()
                .find_map(|target| platforms.remove(target))
                .ok_or_else(|| {
                    format!("Update manifest has no entry for {}", targets.join(" or "))
                })?
        }
        None => Platform {
            url: parsed.url.ok_or("Update manifest has no url")?,
            signature: parsed.signature.ok_or("Update manifest has no signature")?,
        },
    };
    Ok(Release {
        version,
        notes: parsed.notes,
        date: parsed.pub_date,
        url: platform.url,
        signature: platform.signature,
    })
}

fn private_dir(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.uid() != unsafe { libc::getuid() } {
                return Err(format!("{} is not a private directory", path.display()));
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => fs::DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(|e| format!("{} could not be created: {e}", path.display())),
        Err(error) => Err(error.to_string()),
    }
}

/// Removes one of the updater's own directories. A link is removed, never followed.
fn remove_private(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => {
            if metadata.uid() != unsafe { libc::getuid() } {
                return Err(format!("{} is not ours to remove", path.display()));
            }
            fs::remove_dir_all(path).map_err(|e| e.to_string())
        }
        Ok(_) => fs::remove_file(path).map_err(|e| e.to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// The hidden sibling directory that holds the staged and the previous bundle.
/// It sits on the bundle's volume, which an atomic swap requires.
pub fn staging_for(bundle: &Path) -> Result<PathBuf, String> {
    let name = bundle.file_name().ok_or("Installed app has no name")?;
    let parent = bundle.parent().ok_or("Installed app has no parent")?;
    Ok(parent.join(format!(".{}.update", name.to_string_lossy())))
}

/// Why the bundle cannot be replaced in place: translocated, on a read-only
/// volume, not writable by this user, or not a plain app directory.
pub fn installable(bundle: &Path) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    if !bundle.is_absolute() || bundle.extension().is_none_or(|ext| ext != "app") {
        return Err("o8 is not running from an app bundle".into());
    }
    if bundle
        .components()
        .any(|part| part.as_os_str() == "AppTranslocation")
    {
        return Err("o8 is running from a temporary, translocated location. Move o8 to the Applications folder and open it again to update.".into());
    }
    let metadata =
        fs::symlink_metadata(bundle).map_err(|e| format!("Installed app unavailable: {e}"))?;
    if !metadata.is_dir() {
        return Err("The installed app is not a plain directory".into());
    }
    let parent = bundle.parent().ok_or("Installed app has no parent")?;
    let parent_metadata = fs::metadata(parent).map_err(|e| e.to_string())?;
    if parent_metadata.dev() != metadata.dev() {
        return Err("The installed app is a separate volume".into());
    }
    let parent_c =
        std::ffi::CString::new(parent.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let bundle_c =
        std::ffi::CString::new(bundle.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(parent_c.as_ptr(), &mut stats) } != 0 {
        return Err(format!(
            "Install volume unavailable: {}",
            io::Error::last_os_error()
        ));
    }
    if stats.f_flag & libc::ST_RDONLY != 0 {
        return Err("o8 is on a read-only volume (such as the disk image). Move o8 to the Applications folder to update.".into());
    }
    if unsafe { libc::access(parent_c.as_ptr(), libc::W_OK | libc::X_OK) } != 0
        || unsafe { libc::access(bundle_c.as_ptr(), libc::W_OK) } != 0
    {
        return Err(format!(
            "{} is not writable by this user. Update o8 from an administrator account or reinstall it.",
            parent.display()
        ));
    }
    Ok(())
}

/// Streams the archive into a new private file, refusing anything above the
/// bound or shorter than the announced length.
fn download(url: &str, path: &Path, limit: u64) -> Result<File, String> {
    require_scheme(url)?;
    let response = client(DOWNLOAD_TIMEOUT, false)?
        .get(url)
        .header(reqwest::header::ACCEPT, "application/octet-stream")
        .send()
        .map_err(|e| format!("Download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Download answered {}", response.status()));
    }
    let announced = response.content_length();
    if announced.is_some_and(|length| length > limit) {
        return Err(format!("Update archive exceeds the {limit}-byte bound"));
    }
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| format!("Download file unavailable: {e}"))?;
    let mut body = response.take(limit + 1);
    let written =
        io::copy(&mut body, &mut file).map_err(|e| format!("Download incomplete: {e}"))?;
    if written > limit {
        return Err(format!("Update archive exceeds the {limit}-byte bound"));
    }
    if announced.is_some_and(|length| length != written) {
        return Err("Download incomplete: truncated".into());
    }
    file.sync_all().map_err(|e| e.to_string())?;
    file.rewind().map_err(|e| e.to_string())?;
    Ok(file)
}

fn base64_text(value: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|_| "Signature encoding invalid")?;
    String::from_utf8(bytes).map_err(|_| "Signature encoding invalid".into())
}

/// The classic updater's check: base64-wrapped minisign public key and
/// signature, any key id mismatch refused, legacy signatures allowed.
pub fn verify(archive: &mut File, signature: &str, pubkey: &str) -> Result<(), String> {
    use minisign_verify::{PublicKey, Signature};
    let key =
        PublicKey::decode(&base64_text(pubkey)?).map_err(|e| format!("Public key invalid: {e}"))?;
    let signature = Signature::decode(&base64_text(signature)?)
        .map_err(|e| format!("Signature invalid: {e}"))?;
    archive.rewind().map_err(|e| e.to_string())?;
    let result = match key.verify_stream(&signature) {
        Ok(mut stream) => {
            let mut buffer = vec![0u8; 1 << 16];
            loop {
                let count = archive.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 {
                    break;
                }
                stream.update(&buffer[..count]);
            }
            stream.finalize()
        }
        Err(minisign_verify::Error::UnsupportedLegacyMode) => {
            let mut bytes = Vec::new();
            archive.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            key.verify(&bytes, &signature, true)
        }
        Err(error) => Err(error),
    };
    archive.rewind().map_err(|e| e.to_string())?;
    result.map_err(|e| format!("Update signature verification failed: {e}"))
}

/// Unpacks the classic `.app.tar.gz` (one top directory holding the bundle)
/// into `app`, which must not exist. Refuses absolute paths, `..`, more than one
/// top directory, links whose target leaves the bundle, hard links and device
/// or pipe entries, writing through any existing link, and archives that expand
/// past the bounds.
pub fn unpack(archive: impl Read, app: &Path) -> Result<(), String> {
    if fs::symlink_metadata(app).is_ok() {
        return Err("Staging directory is not empty".into());
    }
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
    tar.set_preserve_permissions(false);
    tar.set_unpack_xattrs(false);
    tar.set_overwrite(false);
    let mut top: Option<OsString> = None;
    let (mut entries, mut total) = (0u64, 0u64);
    fs::DirBuilder::new()
        .mode(0o755)
        .create(app)
        .map_err(|e| e.to_string())?;
    for entry in tar
        .entries()
        .map_err(|e| format!("Archive unreadable: {e}"))?
    {
        let mut entry = entry.map_err(|e| format!("Archive unreadable: {e}"))?;
        entries += 1;
        total = total.saturating_add(entry.header().size().unwrap_or(u64::MAX));
        if entries > MAX_ENTRIES || total > MAX_UNPACKED {
            return Err("Archive expands past the unpack bound".into());
        }
        let path = entry
            .path()
            .map_err(|e| format!("Archive path invalid: {e}"))?
            .into_owned();
        let mut parts = Vec::new();
        for (index, component) in path.components().enumerate() {
            match component {
                Component::CurDir if index == 0 => {}
                Component::Normal(part) => parts.push(part.to_owned()),
                _ => {
                    return Err(format!(
                        "Archive entry {} leaves the bundle",
                        path.display()
                    ))
                }
            }
        }
        let Some((first, rest)) = parts.split_first() else {
            continue;
        };
        match &top {
            None => top = Some(first.clone()),
            Some(name) if name == first => {}
            Some(_) => return Err("Archive holds more than one top-level entry".into()),
        }
        let relative: PathBuf = rest.iter().collect();
        let kind = entry.header().entry_type();
        if relative.as_os_str().is_empty() {
            if !kind.is_dir() {
                return Err("Archive top-level entry is not a directory".into());
            }
            continue;
        }
        // Every parent must be a real directory created here, never a link.
        let mut parent = app.to_path_buf();
        for part in relative.parent().into_iter().flat_map(Path::components) {
            parent.push(part);
            match fs::symlink_metadata(&parent) {
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => {
                    return Err(format!(
                        "Archive entry {} passes through a link",
                        path.display()
                    ))
                }
                Err(_) => fs::DirBuilder::new()
                    .mode(0o755)
                    .create(&parent)
                    .map_err(|e| e.to_string())?,
            }
        }
        let target = app.join(&relative);
        let existing = fs::symlink_metadata(&target).ok();
        if kind.is_dir() {
            match existing {
                Some(metadata) if metadata.is_dir() => continue,
                Some(_) => return Err(format!("Archive entry {} is duplicated", path.display())),
                None => {}
            }
        } else if existing.is_some() {
            return Err(format!("Archive entry {} is duplicated", path.display()));
        } else if kind.is_symlink() {
            let link = entry
                .link_name()
                .map_err(|e| e.to_string())?
                .ok_or("Archive link has no target")?
                .into_owned();
            if !link_stays_inside(&relative, &link) {
                return Err(format!(
                    "Archive link {} points outside the bundle",
                    path.display()
                ));
            }
        } else if !kind.is_file() && kind != tar::EntryType::Continuous {
            return Err(format!(
                "Archive entry {} has an unsupported type",
                path.display()
            ));
        }
        entry.unpack(&target).map_err(|e| {
            format!(
                "Archive entry {} could not be unpacked: {e}",
                path.display()
            )
        })?;
    }
    if top.is_none() {
        return Err("Archive is empty".into());
    }
    Ok(())
}

/// A relative link target resolved from the link's own directory stays within the bundle.
pub fn link_stays_inside(entry: &Path, link: &Path) -> bool {
    if link.as_os_str().is_empty() || link.is_absolute() {
        return false;
    }
    let mut depth = entry.components().count() as i64 - 1;
    for component in link.components() {
        match component {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => return false,
        }
    }
    true
}

/// The release version recorded in a bundle's `Info.plist`.
pub fn bundle_version(app: &Path) -> Option<String> {
    plist_value(app, "CFBundleShortVersionString").ok()
}

/// A boolean Info.plist mark; absent or anything but `true` is off.
pub fn bundle_flag(app: &Path, key: &str) -> bool {
    plist_value(app, key).is_ok_and(|value| value == "true")
}

fn plist_value(app: &Path, key: &str) -> Result<String, String> {
    let output = std::process::Command::new("/usr/libexec/PlistBuddy")
        .arg("-c")
        .arg(format!("Print :{key}"))
        .arg(app.join("Contents/Info.plist"))
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("Info.plist unreadable: {e}"))?;
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !output.status.success() || value.is_empty() {
        return Err(format!("Info.plist has no {key}"));
    }
    Ok(value)
}

/// Version and main executable of a bundle; the executable must be a plain
/// file name present as a regular executable file.
fn bundle_info(app: &Path) -> Result<(String, String), String> {
    let version = plist_value(app, "CFBundleShortVersionString")?;
    let executable = plist_value(app, "CFBundleExecutable")?;
    if executable.contains('/') || executable.starts_with('.') {
        return Err("Bundle executable name is invalid".into());
    }
    let metadata = fs::symlink_metadata(app.join("Contents/MacOS").join(&executable))
        .map_err(|_| "Bundle executable is missing")?;
    if !metadata.is_file() || metadata.mode() & 0o111 == 0 {
        return Err("Bundle executable is not an executable file".into());
    }
    Ok((version, executable))
}

#[cfg(target_os = "macos")]
fn rename_swap(a: &Path, b: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let a = std::ffi::CString::new(a.as_os_str().as_bytes())?;
    let b = std::ffi::CString::new(b.as_os_str().as_bytes())?;
    if unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_SWAP) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn rename_swap(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::other("unsupported"))
}

/// Starts the bundle's executable detached, with the arguments and environment
/// this launcher was started with.
fn start(executable: &Path, relaunch: &Relaunch) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let mut command = std::process::Command::new(executable);
    command
        .args(&relaunch.args)
        .env_clear()
        .envs(relaunch.env.iter().cloned())
        .stdin(std::process::Stdio::null())
        .process_group(0);
    command.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Debug-build crash injection for the interrupted-install tests.
fn fault(point: &str) {
    if cfg!(debug_assertions)
        && std::env::var("O8_LAUNCHER_FAULT").ok().as_deref() == Some(&format!("{point}:update"))
    {
        unsafe { libc::_exit(86) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_and_feeds_match_the_classic_shell() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../../src-tauri/tauri.conf.json")).unwrap();
        let updater = &config["plugins"]["updater"];
        assert_eq!(updater["pubkey"], PUBLIC_KEY);
        assert_eq!(updater["endpoints"], serde_json::json!(ENDPOINTS));
        assert_eq!(config["identifier"], SETTINGS_IDENTIFIER);
    }

    #[test]
    fn channel_manifests_follow_the_classic_layout() {
        let mirror = ENDPOINTS[1];
        assert_eq!(channel_fallback(mirror, "stable").unwrap(), mirror);
        assert_eq!(
            channel_fallback(mirror, "beta").unwrap(),
            "https://github.com/hurttlocker/o8-releases/releases/download/beta/beta.json"
        );
        assert!(channel_fallback(mirror, "preview")
            .unwrap()
            .ends_with("/preview.json"));
        assert_eq!(
            channel_fallback("http://127.0.0.1:1/feed/latest.json", "beta").unwrap(),
            "http://127.0.0.1:1/feed/beta.json"
        );
        assert!(channel_fallback(mirror, "nightly").is_err());
    }

    #[test]
    fn both_manifest_shapes_parse() {
        let key = format!("darwin-{}", arch());
        let release = parse_release(&serde_json::json!({"version":"v2.0.0","notes":"n",
            "platforms":{key:{"url":"https://x/o8.app.tar.gz","signature":"s"}}}))
        .unwrap();
        assert_eq!(
            (release.version.as_str(), release.url.as_str()),
            ("2.0.0", "https://x/o8.app.tar.gz")
        );
        let dynamic =
            parse_release(&serde_json::json!({"name":"2.1.0","url":"https://y","signature":"t"}))
                .unwrap();
        assert_eq!(dynamic.signature, "t");
        assert!(parse_release(&serde_json::json!({"version":"2.0.0","platforms":{"linux-x86_64":{"url":"u","signature":"s"}}})).is_err());
    }

    #[test]
    fn link_targets_must_stay_inside_the_bundle() {
        let entry = Path::new("Contents/Frameworks/A.framework/Current");
        assert!(link_stays_inside(entry, Path::new("Versions/A")));
        assert!(link_stays_inside(entry, Path::new("../../MacOS/o8")));
        assert!(!link_stays_inside(entry, Path::new("../../../../etc")));
        assert!(!link_stays_inside(entry, Path::new("/etc/passwd")));
        assert!(!link_stays_inside(Path::new("top"), Path::new("..")));
    }

    #[test]
    fn translocated_and_non_bundle_locations_are_refused() {
        assert!(installable(Path::new(
            "/private/var/folders/x/AppTranslocation/1/d/o8.app"
        ))
        .unwrap_err()
        .contains("translocated"));
        assert!(installable(Path::new("/Applications/o8")).is_err());
    }

    fn archive(entries: impl FnOnce(&mut tar::Builder<Vec<u8>>)) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        entries(&mut builder);
        let tar = builder.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&tar).unwrap();
        gz.finish().unwrap()
    }

    fn file(builder: &mut tar::Builder<Vec<u8>>, path: &str, data: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(0o755);
        header.set_entry_type(tar::EntryType::Regular);
        // Bypass the builder's own path checks to write hostile names.
        let name = &mut header.as_old_mut().name;
        name[..path.len()].copy_from_slice(path.as_bytes());
        header.set_cksum();
        builder.append(&header, data).unwrap();
    }

    fn link(builder: &mut tar::Builder<Vec<u8>>, path: &str, target: &str) {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        header.set_path(path).unwrap();
        header.as_old_mut().linkname[..target.len()].copy_from_slice(target.as_bytes());
        header.set_cksum();
        builder.append(&header, &[][..]).unwrap();
    }

    fn scratch() -> PathBuf {
        let root = PathBuf::from("/tmp").join(format!("o8-update-unit-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn unpack_keeps_links_inside_and_refuses_escapes() {
        let root = scratch();
        let good = archive(|b| {
            file(b, "o8.app/Contents/MacOS/o8", b"bin");
            link(b, "o8.app/Contents/Current", "MacOS");
        });
        unpack(&good[..], &root.join("good.app")).unwrap();
        assert_eq!(
            fs::read(root.join("good.app/Contents/Current/o8")).unwrap(),
            b"bin"
        );
        for (name, bytes) in [
            (
                "traversal",
                archive(|b| file(b, "o8.app/../../escape", b"x")),
            ),
            ("absolute", archive(|b| file(b, "/tmp/escape", b"x"))),
            (
                "link-out",
                archive(|b| link(b, "o8.app/Contents/out", "../../..")),
            ),
            (
                "link-abs",
                archive(|b| link(b, "o8.app/Contents/out", "/etc")),
            ),
            (
                "through-link",
                archive(|b| {
                    link(b, "o8.app/Contents/dir", "MacOS");
                    file(b, "o8.app/Contents/dir/x", b"x");
                }),
            ),
            (
                "two-tops",
                archive(|b| {
                    file(b, "o8.app/a", b"x");
                    file(b, "other.app/b", b"x");
                }),
            ),
        ] {
            let target = root.join(format!("{name}.app"));
            assert!(unpack(&bytes[..], &target).is_err(), "{name} was accepted");
        }
        assert!(!root.parent().unwrap().join("escape").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verification_reuses_minisign_and_refuses_tampering() {
        let root = scratch();
        let keys = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        use base64::Engine;
        let b64 = |s: String| base64::engine::general_purpose::STANDARD.encode(s);
        let pubkey = b64(keys.pk.to_box().unwrap().to_string());
        let data = b"archive bytes".to_vec();
        let signature = minisign::sign(None, &keys.sk, &data[..], None, None).unwrap();
        let signature = b64(signature.to_string());
        let path = root.join("a");
        fs::write(&path, &data).unwrap();
        let mut good = File::open(&path).unwrap();
        verify(&mut good, &signature, &pubkey).unwrap();
        fs::write(&path, b"archive bytez").unwrap();
        let mut bad = File::open(&path).unwrap();
        assert!(verify(&mut bad, &signature, &pubkey).is_err());
        // The release key never verifies a signature made by another key.
        let mut good = File::open(&path).unwrap();
        assert!(verify(&mut good, &signature, PUBLIC_KEY).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
