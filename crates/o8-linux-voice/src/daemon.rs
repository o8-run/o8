//! The speech helper daemon: the Linux side of the `speech_recognizer`
//! protocol (see [`crate::protocol`]).
//!
//! Lifecycle, matching the Swift helper:
//!
//! 1. Boot: emit `status capture:<source>` and `ready`, then warm the model on
//!    the worker thread (which may download it, see [`crate::model`]).
//! 2. `start:<id>`: open capture, emit `status listening`, stream `level`
//!    events and periodic `partial` transcripts.
//! 3. `stop:<id>` (a stale id is ignored): close capture, transcribe, then emit
//!    `final` (when non-empty), `audio_file` (a 16 kHz WAV), `complete`, and
//!    `ready`.
//! 4. `quit` or stdin EOF: finalize any active session, then exit.
//!
//! Transcription runs on one worker thread so a slow model never blocks the
//! command loop, and jobs stay ordered: a session's `final` always follows its
//! partials.

use crate::audio;
use crate::capture::{AudioSource, FailureSink, SampleSink};
use crate::protocol::{parse_command, whisper_language, Command, Event};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Partials are skipped once a session exceeds whisper's 30 s window; the
/// final pass still transcribes the whole recording.
const PARTIAL_MAX_SAMPLES: usize = 30 * audio::SAMPLE_RATE as usize;

/// Turns 16 kHz mono samples into text. Owned by the worker thread.
pub trait Transcriber: Send {
    /// Load (or download) whatever `language` needs. Called at boot and on
    /// locale changes; `notify` emits progress such as `model_downloading`.
    fn prepare(&mut self, _language: Option<&str>, _notify: &dyn Fn(Event)) -> Result<(), String> {
        Ok(())
    }

    fn transcribe(
        &mut self,
        samples: &[f32],
        language: Option<&str>,
        notify: &dyn Fn(Event),
    ) -> Result<String, String>;
}

pub struct DaemonOptions {
    /// Where per-session WAV files are written.
    pub wav_dir: PathBuf,
    /// How often to emit a partial transcript while recording. `None`
    /// disables partials.
    pub partial_interval: Option<Duration>,
    /// Level-meter cadence.
    pub tick: Duration,
    /// Initial recognition locale (e.g. `en-US`).
    pub locale: String,
}

impl Default for DaemonOptions {
    fn default() -> Self {
        Self {
            wav_dir: std::env::temp_dir(),
            partial_interval: Some(Duration::from_millis(1500)),
            tick: Duration::from_millis(100),
            locale: "en-US".into(),
        }
    }
}

/// Serialized writer for protocol lines, shared by the loop and the worker.
#[derive(Clone)]
struct Emitter(Arc<Mutex<Box<dyn Write + Send>>>);

impl Emitter {
    fn emit(&self, event: Event) {
        let mut out = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let _ = writeln!(out, "{}", event.to_line());
        let _ = out.flush();
    }
}

enum Msg {
    Line(String),
    Eof,
    CaptureFailed(u64, String),
}

enum Job {
    Prepare {
        language: Option<String>,
    },
    Partial {
        session_id: u64,
        samples: Vec<f32>,
        language: Option<String>,
    },
    Final {
        session_id: u64,
        samples: Vec<f32>,
        language: Option<String>,
    },
}

struct Session {
    id: u64,
    buffer: Arc<Mutex<Vec<f32>>>,
    metered: usize,
    partial_at: usize,
}

/// Run the daemon until `quit` or EOF on `input`.
pub fn run<R, W>(
    input: R,
    output: W,
    mut source: Box<dyn AudioSource>,
    transcriber: Box<dyn Transcriber>,
    options: DaemonOptions,
) where
    R: BufRead + Send + 'static,
    W: Write + Send + 'static,
{
    let emitter = Emitter(Arc::new(Mutex::new(Box::new(output))));
    let (tx, rx) = mpsc::channel::<Msg>();

    let stdin_tx = tx.clone();
    std::thread::spawn(move || {
        for line in input.lines() {
            let Ok(line) = line else { break };
            if stdin_tx.send(Msg::Line(line)).is_err() {
                return;
            }
        }
        let _ = stdin_tx.send(Msg::Eof);
    });

    let current = Arc::new(AtomicU64::new(0));
    let partial_busy = Arc::new(AtomicBool::new(false));
    let (job_tx, worker) = spawn_worker(
        transcriber,
        emitter.clone(),
        current.clone(),
        partial_busy.clone(),
        options.wav_dir.clone(),
    );

    let mut language = whisper_language(&options.locale);
    emitter.emit(Event::status(source.describe(), None));
    emitter.emit(Event::ready());
    let _ = job_tx.send(Job::Prepare {
        language: language.clone(),
    });

    let partial_samples = options
        .partial_interval
        .map(|d| (d.as_secs_f64() * audio::SAMPLE_RATE as f64) as usize);
    let mut active: Option<Session> = None;

    let finalize = |active: &mut Option<Session>,
                    source: &mut Box<dyn AudioSource>,
                    language: &Option<String>| {
        let Some(session) = active.take() else { return };
        source.stop();
        current.store(0, Ordering::SeqCst);
        let samples =
            std::mem::take(&mut *session.buffer.lock().unwrap_or_else(|p| p.into_inner()));
        let _ = job_tx.send(Job::Final {
            session_id: session.id,
            samples,
            language: language.clone(),
        });
    };

    loop {
        let msg = match rx.recv_timeout(options.tick) {
            Ok(msg) => Some(msg),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => Some(Msg::Eof),
        };
        match msg {
            None => {}
            Some(Msg::Eof) => break,
            Some(Msg::CaptureFailed(id, text)) => {
                if active.as_ref().map(|s| s.id) == Some(id) {
                    emitter.emit(Event::error(text, Some(id)));
                }
            }
            Some(Msg::Line(line)) => match parse_command(&line) {
                None => {}
                Some(Command::Quit) => break,
                Some(Command::Start(id)) => {
                    finalize(&mut active, &mut source, &language);
                    let buffer = Arc::new(Mutex::new(Vec::new()));
                    let sink_buffer = buffer.clone();
                    let sink: SampleSink = Arc::new(move |chunk: &[f32]| {
                        sink_buffer
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .extend_from_slice(chunk)
                    });
                    let fail_tx = Mutex::new(tx.clone());
                    let on_failure: FailureSink = Arc::new(move |text: String| {
                        let _ = fail_tx
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .send(Msg::CaptureFailed(id, text));
                    });
                    current.store(id, Ordering::SeqCst);
                    active = Some(Session {
                        id,
                        buffer,
                        metered: 0,
                        partial_at: 0,
                    });
                    match source.start(sink, on_failure) {
                        Ok(()) => emitter.emit(Event::status("listening", Some(id))),
                        // Keep the session so its stop still completes cleanly.
                        Err(text) => emitter.emit(Event::error(text, Some(id))),
                    }
                }
                Some(Command::Stop(requested)) => {
                    let matches = match (requested, active.as_ref()) {
                        (_, None) => false,
                        (None, Some(_)) => true,
                        (Some(id), Some(session)) => id == session.id,
                    };
                    if matches {
                        finalize(&mut active, &mut source, &language);
                    }
                }
                Some(Command::Locale(locale)) => {
                    language = whisper_language(&locale);
                    emitter.emit(Event::status(format!("locale:{locale}"), None));
                    let _ = job_tx.send(Job::Prepare {
                        language: language.clone(),
                    });
                }
                Some(Command::OnDevice(_)) => {
                    // whisper.cpp always runs locally; report the effective mode.
                    emitter.emit(Event::status("on_device:true", None));
                }
                Some(Command::InputDevice(device)) => {
                    let label = device.clone().unwrap_or_else(|| "default".into());
                    source.set_input_device(device);
                    emitter.emit(Event::status(format!("input_device:{label}"), None));
                }
            },
        }

        // Meter and partial scheduling for the active session.
        if let Some(session) = active.as_mut() {
            let buffer = session.buffer.lock().unwrap_or_else(|p| p.into_inner());
            let len = buffer.len();
            if len > session.metered {
                let window = &buffer[len.saturating_sub(1600).max(session.metered)..];
                emitter.emit(Event::level(audio::level(window), session.id));
                session.metered = len;
            }
            if let Some(step) = partial_samples {
                if len <= PARTIAL_MAX_SAMPLES
                    && len >= session.partial_at + step
                    && !partial_busy.swap(true, Ordering::SeqCst)
                {
                    session.partial_at = len;
                    let _ = job_tx.send(Job::Partial {
                        session_id: session.id,
                        samples: buffer.clone(),
                        language: language.clone(),
                    });
                }
            }
        }
    }

    finalize(&mut active, &mut source, &language);
    drop(job_tx);
    let _ = worker.join();
}

fn spawn_worker(
    mut transcriber: Box<dyn Transcriber>,
    emitter: Emitter,
    current: Arc<AtomicU64>,
    partial_busy: Arc<AtomicBool>,
    wav_dir: PathBuf,
) -> (mpsc::Sender<Job>, std::thread::JoinHandle<()>) {
    let (job_tx, job_rx) = mpsc::channel::<Job>();
    let handle = std::thread::spawn(move || {
        let notify_emitter = emitter.clone();
        let notify = move |event: Event| notify_emitter.emit(event);
        for job in job_rx {
            match job {
                Job::Prepare { language } => {
                    if let Err(e) = transcriber.prepare(language.as_deref(), &notify) {
                        emitter.emit(Event::error(e, None));
                    }
                }
                Job::Partial {
                    session_id,
                    samples,
                    language,
                } => {
                    if current.load(Ordering::SeqCst) == session_id {
                        if let Ok(text) =
                            transcriber.transcribe(&samples, language.as_deref(), &notify)
                        {
                            let text = text.trim();
                            if !text.is_empty() && current.load(Ordering::SeqCst) == session_id {
                                emitter.emit(Event::new("partial", text, Some(session_id)));
                            }
                        }
                    }
                    partial_busy.store(false, Ordering::SeqCst);
                }
                Job::Final {
                    session_id,
                    samples,
                    language,
                } => {
                    let sid = Some(session_id);
                    if !samples.is_empty() {
                        match transcriber.transcribe(&samples, language.as_deref(), &notify) {
                            Ok(text) if !text.trim().is_empty() => {
                                emitter.emit(Event::new("final", text.trim(), sid))
                            }
                            Ok(_) => {}
                            Err(e) => emitter.emit(Event::error(e, sid)),
                        }
                        let path = audio::session_wav_path(&wav_dir, session_id);
                        match audio::write_wav(&path, &samples) {
                            Ok(()) => {
                                emitter.emit(Event::new("audio_file", path.to_string_lossy(), sid))
                            }
                            Err(e) => {
                                emitter.emit(Event::error(format!("audio_file_failed:{e}"), sid))
                            }
                        }
                    }
                    emitter.emit(Event::new("complete", "", sid));
                    emitter.emit(Event::ready());
                }
            }
        }
    });
    (job_tx, handle)
}
