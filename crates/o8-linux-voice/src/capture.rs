//! Microphone sources for the speech helper.
//!
//! Three sources share one trait:
//!
//! - [`RecorderSource`] spawns the first available command-line recorder
//!   (`pw-record`, `parecord`, `arecord`) per session and reads raw 16 kHz mono
//!   `f32` PCM from its stdout. Using the desktop's own recorder keeps the
//!   helper free of ALSA/PipeWire link dependencies.
//! - [`FifoSource`] reads the same PCM from `--audio-fifo`, the main-process
//!   capture path the shell already uses on macOS (#1540).
//! - [`WavFileSource`] replays a WAV file for each session. It exists for
//!   tests and for diagnosing the pipeline on a machine without a microphone.

use crate::audio;
use std::ffi::OsString;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Receives captured 16 kHz mono samples for the active session.
pub type SampleSink = Arc<dyn Fn(&[f32]) + Send + Sync>;

/// Reports an asynchronous capture failure (for example, a recorder that exits
/// because no input device exists). The daemon turns it into an `error` event.
pub type FailureSink = Arc<dyn Fn(String) + Send + Sync>;

pub trait AudioSource: Send {
    /// Start delivering samples to `sink`. An `Err` is a clear, user-facing
    /// reason the session cannot capture audio.
    fn start(&mut self, sink: SampleSink, on_failure: FailureSink) -> Result<(), String>;
    /// Stop capture and return once no more samples will reach the sink.
    fn stop(&mut self);
    /// Select an input device (`None` = system default) for later sessions.
    fn set_input_device(&mut self, _device: Option<String>) {}
    /// Short description for the startup status event.
    fn describe(&self) -> String;
}

/// A command-line recorder that can write raw 16 kHz mono `f32le` to stdout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recorder {
    PwRecord,
    Parecord,
    Arecord,
}

impl Recorder {
    pub const ALL: [Recorder; 3] = [Recorder::PwRecord, Recorder::Parecord, Recorder::Arecord];

    pub fn binary(self) -> &'static str {
        match self {
            Recorder::PwRecord => "pw-record",
            Recorder::Parecord => "parecord",
            Recorder::Arecord => "arecord",
        }
    }

    /// Arguments for raw 16 kHz mono float capture to stdout.
    pub fn args(self, device: Option<&str>) -> Vec<String> {
        let mut args: Vec<String> = match self {
            Recorder::PwRecord => [
                "--raw",
                "--rate",
                "16000",
                "--channels",
                "1",
                "--format",
                "f32",
            ]
            .map(String::from)
            .to_vec(),
            Recorder::Parecord => [
                "--raw",
                "--rate=16000",
                "--channels=1",
                "--format=float32le",
            ]
            .map(String::from)
            .to_vec(),
            Recorder::Arecord => [
                "-q", "-t", "raw", "-f", "FLOAT_LE", "-r", "16000", "-c", "1",
            ]
            .map(String::from)
            .to_vec(),
        };
        if let Some(device) = device {
            match self {
                Recorder::PwRecord => args.extend(["--target".into(), device.into()]),
                Recorder::Parecord => args.push(format!("--device={device}")),
                Recorder::Arecord => args.extend(["-D".into(), device.into()]),
            }
        }
        if self == Recorder::PwRecord {
            args.push("-".into());
        }
        args
    }

    /// The first recorder present on `search_path`.
    pub fn detect(search_path: &std::ffi::OsStr) -> Option<(Recorder, PathBuf)> {
        Self::ALL
            .iter()
            .find_map(|r| crate::tools::find_in(r.binary(), search_path).map(|p| (*r, p)))
    }
}

pub const NO_RECORDER_MESSAGE: &str = "microphone_unavailable: no audio recorder found. Install pipewire-bin (pw-record), pulseaudio-utils (parecord) or alsa-utils (arecord).";

struct RunningRecorder {
    child: Child,
    reader: Option<std::thread::JoinHandle<()>>,
    stopping: Arc<AtomicBool>,
}

/// Spawns a command-line recorder for each session.
pub struct RecorderSource {
    search_path: OsString,
    device: Option<String>,
    running: Option<RunningRecorder>,
}

impl RecorderSource {
    pub fn new(search_path: OsString) -> Self {
        Self {
            search_path,
            device: None,
            running: None,
        }
    }
}

impl AudioSource for RecorderSource {
    fn start(&mut self, sink: SampleSink, on_failure: FailureSink) -> Result<(), String> {
        self.stop();
        let (recorder, path) =
            Recorder::detect(&self.search_path).ok_or_else(|| NO_RECORDER_MESSAGE.to_string())?;
        let mut child = Command::new(&path)
            .args(recorder.args(self.device.as_deref()))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                format!(
                    "microphone_unavailable: {} failed to start: {e}",
                    recorder.binary()
                )
            })?;
        let mut stdout = child.stdout.take().ok_or("recorder stdout missing")?;
        let mut stderr = child.stderr.take();
        let stopping = Arc::new(AtomicBool::new(false));
        let stopping_reader = stopping.clone();
        let name = recorder.binary();
        let reader = std::thread::spawn(move || {
            let mut buf = vec![0u8; 4096];
            let mut carry: Vec<u8> = Vec::new();
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        carry.extend_from_slice(&buf[..n]);
                        let (samples, tail) = audio::decode_f32le(&carry);
                        let tail = tail.to_vec();
                        sink(&samples);
                        carry = tail;
                    }
                }
            }
            if !stopping_reader.load(Ordering::SeqCst) {
                let mut detail = String::new();
                if let Some(err) = stderr.as_mut() {
                    let _ = err.read_to_string(&mut detail);
                }
                let detail = detail
                    .lines()
                    .last()
                    .unwrap_or("no input device")
                    .trim()
                    .to_string();
                on_failure(format!("microphone_unavailable: {name} stopped: {detail}"));
            }
        });
        self.running = Some(RunningRecorder {
            child,
            reader: Some(reader),
            stopping,
        });
        Ok(())
    }

    fn stop(&mut self) {
        if let Some(mut running) = self.running.take() {
            running.stopping.store(true, Ordering::SeqCst);
            let _ = running.child.kill();
            let _ = running.child.wait();
            if let Some(reader) = running.reader.take() {
                let _ = reader.join();
            }
        }
    }

    fn set_input_device(&mut self, device: Option<String>) {
        self.device = device;
    }

    fn describe(&self) -> String {
        match Recorder::detect(&self.search_path) {
            Some((r, _)) => format!("capture:{}", r.binary()),
            None => "capture:none".into(),
        }
    }
}

impl Drop for RecorderSource {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Reads PCM from a FIFO written by the shell's main-process capture pump.
/// The FIFO is drained for the life of the helper; samples reach a sink only
/// while a session is active.
pub struct FifoSource {
    path: PathBuf,
    sink: Arc<Mutex<Option<SampleSink>>>,
    reader_started: bool,
}

impl FifoSource {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            sink: Arc::new(Mutex::new(None)),
            reader_started: false,
        }
    }

    fn ensure_reader(&mut self) {
        if self.reader_started {
            return;
        }
        self.reader_started = true;
        let path = self.path.clone();
        let slot = self.sink.clone();
        std::thread::spawn(move || loop {
            // Re-open on EOF: the pump closes its end between lingers.
            let Ok(mut file) = std::fs::File::open(&path) else {
                std::thread::sleep(std::time::Duration::from_millis(250));
                continue;
            };
            let mut buf = vec![0u8; 4096];
            let mut carry: Vec<u8> = Vec::new();
            loop {
                match file.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        carry.extend_from_slice(&buf[..n]);
                        let (samples, tail) = audio::decode_f32le(&carry);
                        let tail = tail.to_vec();
                        let sink = slot.lock().unwrap_or_else(|p| p.into_inner()).clone();
                        if let Some(sink) = sink {
                            sink(&samples);
                        }
                        carry = tail;
                    }
                }
            }
        });
    }
}

impl AudioSource for FifoSource {
    fn start(&mut self, sink: SampleSink, _on_failure: FailureSink) -> Result<(), String> {
        self.ensure_reader();
        *self.sink.lock().unwrap_or_else(|p| p.into_inner()) = Some(sink);
        Ok(())
    }

    fn stop(&mut self) {
        *self.sink.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    fn describe(&self) -> String {
        format!("capture:fifo:{}", self.path.display())
    }
}

/// Replays one WAV file per session, delivered immediately on start.
pub struct WavFileSource {
    samples: Arc<Vec<f32>>,
    label: String,
}

impl WavFileSource {
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        Ok(Self {
            samples: Arc::new(audio::read_wav_16k_mono(path)?),
            label: path.display().to_string(),
        })
    }
}

impl AudioSource for WavFileSource {
    fn start(&mut self, sink: SampleSink, _on_failure: FailureSink) -> Result<(), String> {
        for chunk in self.samples.chunks(1600) {
            sink(chunk);
        }
        Ok(())
    }

    fn stop(&mut self) {}

    fn describe(&self) -> String {
        format!("capture:file:{}", self.label)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{fake_tool, TempDir};
    use std::time::{Duration, Instant};

    #[test]
    fn recorder_args_request_raw_16k_mono_float() {
        assert_eq!(
            Recorder::PwRecord.args(Some("mic")).join(" "),
            "--raw --rate 16000 --channels 1 --format f32 --target mic -"
        );
        assert_eq!(
            Recorder::Parecord.args(None).join(" "),
            "--raw --rate=16000 --channels=1 --format=float32le"
        );
        assert_eq!(
            Recorder::Arecord.args(Some("hw:1")).join(" "),
            "-q -t raw -f FLOAT_LE -r 16000 -c 1 -D hw:1"
        );
    }

    #[test]
    fn detection_prefers_pipewire_then_pulse_then_alsa() {
        let dir = TempDir::new("rec-detect");
        assert_eq!(Recorder::detect(dir.path().as_os_str()), None);
        fake_tool(dir.path(), "arecord", "exit 0");
        assert_eq!(
            Recorder::detect(dir.path().as_os_str()).unwrap().0,
            Recorder::Arecord
        );
        fake_tool(dir.path(), "parecord", "exit 0");
        assert_eq!(
            Recorder::detect(dir.path().as_os_str()).unwrap().0,
            Recorder::Parecord
        );
        fake_tool(dir.path(), "pw-record", "exit 0");
        assert_eq!(
            Recorder::detect(dir.path().as_os_str()).unwrap().0,
            Recorder::PwRecord
        );
    }

    fn collecting_sink() -> (SampleSink, Arc<Mutex<Vec<f32>>>) {
        let store = Arc::new(Mutex::new(Vec::new()));
        let s = store.clone();
        (
            Arc::new(move |chunk: &[f32]| s.lock().unwrap().extend_from_slice(chunk)),
            store,
        )
    }

    fn collecting_failures() -> (FailureSink, Arc<Mutex<Vec<String>>>) {
        let store = Arc::new(Mutex::new(Vec::new()));
        let s = store.clone();
        (
            Arc::new(move |msg: String| s.lock().unwrap().push(msg)),
            store,
        )
    }

    #[test]
    fn missing_recorder_is_a_clear_error() {
        let dir = TempDir::new("rec-none");
        let mut source = RecorderSource::new(dir.path().as_os_str().to_owned());
        let (sink, _) = collecting_sink();
        let (fail, _) = collecting_failures();
        assert_eq!(source.start(sink, fail).unwrap_err(), NO_RECORDER_MESSAGE);
        assert_eq!(source.describe(), "capture:none");
    }

    #[test]
    fn reads_pcm_from_a_recorder_and_stops_without_a_failure() {
        let dir = TempDir::new("rec-run");
        // 0.5f32 little-endian is 00 00 00 3f; emit 4 samples then keep running.
        fake_tool(
            dir.path(),
            "parecord",
            r"printf '\000\000\000\077\000\000\000\077\000\000\000\077\000\000\000\077'; exec sleep 30",
        );
        let mut source = RecorderSource::new(dir.path().as_os_str().to_owned());
        let (sink, store) = collecting_sink();
        let (fail, failures) = collecting_failures();
        source.start(sink, fail).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while store.lock().unwrap().len() < 4 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        source.stop();
        assert_eq!(*store.lock().unwrap(), vec![0.5; 4]);
        assert!(failures.lock().unwrap().is_empty());
    }

    #[test]
    fn a_recorder_that_dies_reports_why() {
        let dir = TempDir::new("rec-die");
        fake_tool(
            dir.path(),
            "arecord",
            "echo 'arecord: main:850: audio open error: No such file or directory' >&2; exit 1",
        );
        let mut source = RecorderSource::new(dir.path().as_os_str().to_owned());
        let (sink, _) = collecting_sink();
        let (fail, failures) = collecting_failures();
        source.start(sink, fail).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while failures.lock().unwrap().is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let failures = failures.lock().unwrap();
        assert_eq!(failures.len(), 1);
        assert!(
            failures[0].starts_with("microphone_unavailable: arecord stopped: arecord: main:850")
        );
    }
}
