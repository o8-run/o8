//! The speech helper process: where it is, how it starts and how its JSON lines
//! reach the engine. The protocol is the daemon mode of
//! `src-tauri/helpers/speech_recognizer.swift`: `start:<id>`, `stop:<id>` and
//! `quit` on stdin; one `{"type","text","session_id"}` object per stdout line.
use super::engine::Input;
use super::spawn::{Process, Spawned, spawn};
use serde::Deserialize;
use std::{
    ffi::OsString,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    sync::mpsc::Sender,
    time::{Duration, Instant},
};

/// How to start the helper. Tests start a fake one.
#[derive(Clone, Debug)]
pub(crate) struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub envs: Vec<(OsString, OsString)>,
    /// The desktop's data directory, which holds the saved voice settings
    /// (`dictation.json`, `voice-prefs.json`); none means no saved settings.
    pub data: Option<PathBuf>,
}

impl Launch {
    /// The installed helper, when there is one.
    pub(crate) fn helper() -> Option<Self> {
        helper_path().map(|program| Self {
            program,
            args: Vec::new(),
            envs: Vec::new(),
            data: super::prefs::data_dir(),
        })
    }
}

/// `O8_SPEECH_RECOGNIZER` when set; otherwise, on macOS, the helper beside this
/// binary (the app bundle keeps both in Contents/MacOS), with or without the
/// sidecar's target suffix, then a source build's helper in debug builds.
pub(crate) fn helper_path() -> Option<PathBuf> {
    let source = cfg!(debug_assertions)
        .then(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/helpers"));
    resolve(
        std::env::var_os("O8_SPEECH_RECOGNIZER").map(PathBuf::from),
        std::env::current_exe().ok(),
        source,
        cfg!(target_os = "macos"),
    )
}

pub(super) fn resolve(
    explicit: Option<PathBuf>,
    exe: Option<PathBuf>,
    source: Option<PathBuf>,
    macos: bool,
) -> Option<PathBuf> {
    if let Some(path) = explicit {
        return path.is_file().then_some(path);
    }
    if !macos {
        return None;
    }
    let triple = if cfg!(target_arch = "x86_64") {
        "x86_64-apple-darwin"
    } else {
        "aarch64-apple-darwin"
    };
    let beside = exe.as_deref().and_then(Path::parent).map(Path::to_path_buf);
    [beside, source]
        .into_iter()
        .flatten()
        .flat_map(|dir| {
            [
                dir.join(format!("speech_recognizer-{triple}")),
                dir.join("speech_recognizer"),
            ]
        })
        .find(|path| path.is_file())
}

/// One helper output line.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Line {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub session_id: Option<u64>,
}

/// A running helper. Dropping it asks the helper to quit, then kills it.
pub(super) struct Helper {
    process: Process,
    stdin: Box<dyn Write + Send>,
}

impl Helper {
    /// Starts the helper; its lines and its exit reach `inputs` tagged with
    /// `generation`, so a replaced helper's late lines are ignored.
    pub(super) fn spawn(
        launch: &Launch,
        generation: u64,
        inputs: Sender<Input>,
    ) -> Result<Self, String> {
        let Spawned {
            mut process,
            stdin,
            stdout,
        } = spawn(launch)?;
        std::thread::Builder::new()
            .name("o8-speech-helper".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    // Anything that is not a helper object is diagnostics.
                    if let Ok(line) = serde_json::from_str::<Line>(&line)
                        && inputs.send(Input::Line(generation, line)).is_err()
                    {
                        return;
                    }
                }
                let _ = inputs.send(Input::Exited(generation));
            })
            .map_err(|_| {
                process.kill();
                "The speech helper could not start.".to_string()
            })?;
        Ok(Self { process, stdin })
    }

    pub(super) fn send(&mut self, command: &str) -> Result<(), String> {
        writeln!(self.stdin, "{command}")
            .and_then(|()| self.stdin.flush())
            .map_err(|_| "The speech helper is not running.".to_string())
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.send("quit");
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline {
            if self.process.exited() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        self.process.kill();
    }
}

/// Removes a recording the helper wrote. Only the helper's own WAV names are
/// ever removed, whatever path a line carried.
pub(super) fn remove_wav(path: &Path) {
    let ours = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("o8_dictation_") && name.ends_with(".wav"));
    if ours {
        let _ = std::fs::remove_file(path);
    }
}
