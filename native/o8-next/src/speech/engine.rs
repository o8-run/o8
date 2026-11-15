//! The recording state machine. One thread owns the helper and the current
//! recording; commands, helper lines and finished server calls arrive on one
//! channel, so they are handled in order without locks.
use super::helper::{Helper, Launch, Line, remove_wav};
use super::history;
use super::prefs::{self, VoicePrefs, apply_replacements};
use super::{Event, Finish, Phase, Update};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        mpsc::{self, RecvTimeoutError, Sender},
    },
    time::{Duration, Instant},
};

/// Helper boot (including a first permission prompt) and microphone start.
const START_WITHIN: Duration = Duration::from_secs(20);
/// The helper's own finalize safety net is 1.5 seconds.
const FINAL_WITHIN: Duration = Duration::from_secs(10);

pub(super) const MIC_DENIED: &str =
    "o8 has no microphone access. Allow it in System Settings → Privacy & Security → Microphone.";
pub(super) const SPEECH_DENIED: &str = "Speech recognition is off for o8. Allow it in System Settings → Privacy & Security → Speech Recognition.";
pub(super) const HELPER_STOPPED: &str = "The speech helper stopped. Try again.";
pub(super) const ENDED_EARLY: &str = "Dictation ended before it was submitted.";
pub(super) const BUSY: &str = "Another dictation is still active.";
/// The locale a helper starts on (`currentLocaleIdentifier` in
/// `speech_recognizer.swift`); clearing the saved locale goes back to it.
const HELPER_LOCALE: &str = "en-US";

pub(crate) enum Input {
    Start {
        id: u64,
        repo: Option<String>,
    },
    Stop(u64),
    Cancel(u64),
    /// A helper line, tagged with the helper's generation.
    Line(u64, Line),
    Exited(u64),
    Progress(u64, Phase),
    Finished(u64, Update),
    Shutdown,
}

struct Run {
    id: u64,
    phase: Phase,
    repo: Option<String>,
    /// `start:<id>` reached the helper.
    sent: bool,
    partial: String,
    apple: String,
    audio: Option<PathBuf>,
    deadline: Option<Instant>,
}

struct Engine {
    launch: Launch,
    finish: Arc<dyn Finish>,
    events: async_channel::Sender<Event>,
    inputs: Sender<Input>,
    helper: Option<Helper>,
    generation: u64,
    /// The helper finished booting; a start before this is refused by it.
    ready: bool,
    /// The helper reported no microphone access; the next start relaunches it.
    mic_denied: bool,
    /// Why the helper is about to exit, when it said so.
    exit_reason: Option<&'static str>,
    /// The microphone and locale this helper was last told; a new helper
    /// starts on the system default microphone and its own locale.
    device: Option<String>,
    locale: Option<String>,
    run: Option<Run>,
}

pub(super) fn spawn(
    launch: Launch,
    finish: Arc<dyn Finish>,
    events: async_channel::Sender<Event>,
) -> Sender<Input> {
    let (inputs, received) = mpsc::channel();
    let engine = Engine {
        launch,
        finish,
        events,
        inputs: inputs.clone(),
        helper: None,
        generation: 0,
        ready: false,
        mic_denied: false,
        exit_reason: None,
        device: None,
        locale: None,
        run: None,
    };
    let _ = std::thread::Builder::new()
        .name("o8-speech".into())
        .spawn(move || engine.serve(received));
    inputs
}

impl Engine {
    fn serve(mut self, received: mpsc::Receiver<Input>) {
        loop {
            let deadline = self.run.as_ref().and_then(|run| run.deadline);
            let input = match deadline {
                Some(at) => {
                    match received.recv_timeout(at.saturating_duration_since(Instant::now())) {
                        Ok(input) => input,
                        Err(RecvTimeoutError::Timeout) => {
                            self.expire();
                            continue;
                        }
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
                None => match received.recv() {
                    Ok(input) => input,
                    Err(_) => break,
                },
            };
            match input {
                Input::Shutdown => break,
                Input::Start { id, repo } => self.start(id, repo),
                Input::Stop(id) => self.stop(id),
                Input::Cancel(id) => self.cancel(id),
                Input::Line(generation, line) if generation == self.generation => self.line(line),
                Input::Line(_, line) => {
                    if line.kind == "audio_file" {
                        remove_wav(line.text.as_ref());
                    }
                }
                Input::Exited(generation) if generation == self.generation => self.exited(),
                Input::Exited(_) => {}
                Input::Progress(id, phase) => {
                    if self.current(id).is_some_and(|run| run.phase != phase) {
                        self.set_phase(phase);
                    }
                }
                Input::Finished(id, update) => {
                    if self.current(id).is_some() {
                        // What goes out is kept in Voice History, as the shell does.
                        if let (Update::Done(text), Some(dir)) = (&update, &self.launch.data) {
                            history::record(dir, text);
                        }
                        self.end(update);
                    }
                }
            }
        }
        self.retire();
        // Dropping the helper asks it to quit.
        self.helper = None;
    }

    fn emit(&self, id: u64, update: Update) {
        let _ = self.events.try_send(Event { id, update });
    }

    fn current(&self, id: u64) -> Option<&Run> {
        self.run.as_ref().filter(|run| run.id == id)
    }

    fn set_phase(&mut self, phase: Phase) {
        if let Some(run) = &mut self.run {
            run.phase = phase;
            let id = run.id;
            self.emit(id, Update::Phase(phase));
        }
    }

    /// Ends the recording with a terminal update.
    fn end(&mut self, update: Update) {
        if let Some(id) = self.retire() {
            self.emit(id, update);
        }
    }

    /// Forgets the recording, releasing the microphone and its WAV.
    fn retire(&mut self) -> Option<u64> {
        let run = self.run.take()?;
        if run.sent && matches!(run.phase, Phase::Starting | Phase::Listening) {
            self.command(&format!("stop:{}", run.id));
        }
        if let Some(audio) = &run.audio {
            remove_wav(audio);
        }
        Some(run.id)
    }

    /// Writes to the helper; a dead pipe drops it so the next start relaunches.
    fn command(&mut self, command: &str) -> bool {
        let sent = self
            .helper
            .as_mut()
            .is_some_and(|helper| helper.send(command).is_ok());
        if !sent {
            self.drop_helper();
        }
        sent
    }

    fn drop_helper(&mut self) {
        self.helper = None;
        self.ready = false;
        self.device = None;
        self.locale = None;
        // Lines and the exit of the dropped helper are now stale.
        self.generation += 1;
    }

    fn start(&mut self, id: u64, repo: Option<String>) {
        if self.run.is_some() {
            self.emit(id, Update::Failed(BUSY.into()));
            return;
        }
        if self.mic_denied {
            // Access may have been granted since; a new helper asks again.
            self.mic_denied = false;
            self.drop_helper();
        }
        if self.helper.is_none() {
            self.drop_helper();
            self.exit_reason = None;
            match Helper::spawn(&self.launch, self.generation, self.inputs.clone()) {
                Ok(helper) => self.helper = Some(helper),
                Err(error) => {
                    self.emit(id, Update::Failed(error));
                    return;
                }
            }
        }
        self.run = Some(Run {
            id,
            phase: Phase::Starting,
            repo,
            sent: false,
            partial: String::new(),
            apple: String::new(),
            audio: None,
            deadline: Some(Instant::now() + START_WITHIN),
        });
        self.emit(id, Update::Phase(Phase::Starting));
        if self.ready {
            self.send_start();
        }
    }

    fn send_start(&mut self) {
        let Some(id) = self.run.as_ref().filter(|run| !run.sent).map(|run| run.id) else {
            return;
        };
        // The saved microphone and locale, as the shell sends them before a
        // start; only a change is sent. The helper itself retries on device
        // after Apple refuses the server path (errors 203 and 201).
        let saved = self
            .launch
            .data
            .as_deref()
            .map(prefs::read)
            .unwrap_or_default();
        let mut ready = true;
        if saved.microphone != self.device {
            let uid = saved.microphone.as_deref().unwrap_or("default");
            ready = self.command(&format!("input_device:{uid}"));
            self.device = saved.microphone;
        }
        if ready && saved.locale != self.locale {
            let locale = saved.locale.as_deref().unwrap_or(HELPER_LOCALE);
            ready = self.command(&format!("locale:{locale}"));
            self.locale = saved.locale;
        }
        if ready && self.command(&format!("start:{id}")) {
            if let Some(run) = &mut self.run {
                run.sent = true;
            }
        } else {
            self.end(Update::Failed(HELPER_STOPPED.into()));
        }
    }

    fn stop(&mut self, id: u64) {
        let Some(run) = self.current(id) else {
            return;
        };
        match (run.phase, run.sent) {
            // The microphone never opened.
            (Phase::Starting, false) => self.end(Update::Empty),
            (Phase::Starting | Phase::Listening, true) => {
                if self.command(&format!("stop:{id}")) {
                    if let Some(run) = &mut self.run {
                        run.deadline = Some(Instant::now() + FINAL_WITHIN);
                    }
                    self.set_phase(Phase::Finishing);
                } else {
                    self.end(Update::Failed(HELPER_STOPPED.into()));
                }
            }
            _ => {}
        }
    }

    fn cancel(&mut self, id: u64) {
        if self.current(id).is_some() {
            self.end(Update::Phase(Phase::Idle));
        }
    }

    fn line(&mut self, line: Line) {
        let ours = self
            .run
            .as_ref()
            .is_some_and(|run| line.session_id == Some(run.id));
        let phase = self.run.as_ref().map(|run| run.phase);
        match line.kind.as_str() {
            "ready" => {
                self.ready = true;
                if phase == Some(Phase::Starting) {
                    self.send_start();
                }
            }
            "status" => match line.text.as_str() {
                "listening" if ours && phase == Some(Phase::Starting) => {
                    if let Some(run) = &mut self.run {
                        run.deadline = None;
                    }
                    self.set_phase(Phase::Listening);
                }
                "microphone:denied" => {
                    self.mic_denied = true;
                    if matches!(phase, Some(Phase::Starting | Phase::Listening)) {
                        self.end(Update::Failed(MIC_DENIED.into()));
                    }
                }
                "speech_recognition:denied" | "speech_recognition:restricted" => {
                    self.exit_reason = Some(SPEECH_DENIED);
                }
                _ => {}
            },
            "partial" if ours && matches!(phase, Some(Phase::Starting | Phase::Listening)) => {
                let Some(run) = &mut self.run else { return };
                if run.partial == line.text {
                    return;
                }
                run.partial = line.text.clone();
                run.deadline = None;
                let id = run.id;
                if phase == Some(Phase::Starting) {
                    self.set_phase(Phase::Listening);
                }
                self.emit(id, Update::Partial(line.text));
            }
            "level" if ours && phase == Some(Phase::Listening) => {
                let level = line.text.trim().parse::<f32>().unwrap_or(0.0);
                self.emit(
                    line.session_id.unwrap_or(0),
                    Update::Level(level.clamp(0.0, 1.0)),
                );
            }
            "final" if ours && phase == Some(Phase::Finishing) => {
                if let Some(run) = &mut self.run {
                    run.apple = line.text;
                }
            }
            "audio_file" => match &mut self.run {
                Some(run) if ours && run.phase == Phase::Finishing => {
                    run.audio = Some(PathBuf::from(line.text));
                }
                // A cancelled or earlier recording's WAV.
                _ => remove_wav(line.text.as_ref()),
            },
            "complete" if ours => match phase {
                Some(Phase::Finishing) => self.finish(),
                Some(Phase::Starting | Phase::Listening) => {
                    self.end(Update::Failed(ENDED_EARLY.into()))
                }
                _ => {}
            },
            "error"
                if ours
                    && matches!(
                        phase,
                        Some(Phase::Starting | Phase::Listening | Phase::Finishing)
                    ) =>
            {
                let text = line.text.trim();
                let text = if text.is_empty() {
                    "Dictation failed."
                } else {
                    text
                };
                self.end(Update::Failed(text.to_owned()));
            }
            _ => {}
        }
    }

    fn exited(&mut self) {
        let reason = self.exit_reason.take().unwrap_or(HELPER_STOPPED);
        // The process has closed its output; reap it.
        self.drop_helper();
        let waiting = self.run.as_ref().is_some_and(|run| {
            matches!(
                run.phase,
                Phase::Starting | Phase::Listening | Phase::Finishing
            )
        });
        if waiting {
            if let Some(run) = &mut self.run {
                // The pipe is gone; nothing to stop.
                run.sent = false;
            }
            self.end(Update::Failed(reason.into()));
        }
    }

    fn expire(&mut self) {
        let Some(run) = &mut self.run else { return };
        run.deadline = None;
        match run.phase {
            Phase::Starting => self.end(Update::Failed(
                "The microphone did not start. Try again.".into(),
            )),
            // No final from the helper: finish with what arrived.
            Phase::Finishing => self.finish(),
            _ => {}
        }
    }

    /// Apple's final text, else Whisper on the recording, then polish, on a
    /// worker thread; its result comes back as `Input::Finished`.
    fn finish(&mut self) {
        let Some(run) = &mut self.run else { return };
        run.deadline = None;
        let apple = run.apple.trim().to_owned();
        let audio = run.audio.take();
        let repo = run.repo.clone();
        let id = run.id;
        if apple.is_empty() && audio.is_none() {
            self.end(Update::Empty);
            return;
        }
        self.set_phase(if apple.is_empty() {
            Phase::Transcribing
        } else {
            Phase::Polishing
        });
        let finish = self.finish.clone();
        let inputs = self.inputs.clone();
        let saved = self.launch.data.clone();
        let worker = std::thread::Builder::new()
            .name("o8-speech-finish".into())
            .spawn(move || {
                // Read now, so a settings change applies to the next recording.
                let prefs = saved.as_deref().map(prefs::read).unwrap_or_default();
                let progress = |phase| {
                    let _ = inputs.send(Input::Progress(id, phase));
                };
                let update = finish_text(
                    &*finish,
                    apple,
                    audio.as_deref(),
                    repo.as_deref(),
                    &prefs,
                    progress,
                );
                if let Some(audio) = &audio {
                    remove_wav(audio);
                }
                let _ = inputs.send(Input::Finished(id, update));
            });
        if worker.is_err() {
            self.end(Update::Failed("Dictation could not finish.".into()));
        }
    }
}

pub(super) fn finish_text(
    finish: &dyn Finish,
    apple: String,
    audio: Option<&std::path::Path>,
    repo: Option<&str>,
    prefs: &VoicePrefs,
    progress: impl Fn(Phase),
) -> Update {
    let mut text = apple;
    if text.is_empty()
        && let Some(audio) = audio
    {
        match finish.transcribe(audio) {
            Ok(heard) => text = heard.trim().to_owned(),
            Err(error) => return Update::Failed(error),
        }
    }
    if text.is_empty() {
        return Update::Empty;
    }
    // A spoken cancel never goes out, even when polish (which also checks
    // it) cannot be reached.
    if spoken_cancel(&text) {
        return Update::Dropped;
    }
    progress(Phase::Polishing);
    let text = match finish.polish(&text, repo, prefs) {
        Ok(polished) if polished.cancelled => return Update::Dropped,
        Ok(polished) if !polished.text.trim().is_empty() => polished.text.trim().to_owned(),
        // Polish is best effort; the raw text still goes out.
        _ => text,
    };
    // The saved replacements apply whether or not polish ran, as on the desktop.
    Update::Done(apply_replacements(&text, &prefs.replacements))
}

/// A whole recording that only cancels: the composer's own phrases
/// (`src/lib/dictation/voice-commands.ts`), with the period Apple may add.
pub(super) fn spoken_cancel(text: &str) -> bool {
    let text = text.trim();
    let text = text
        .strip_suffix('.')
        .unwrap_or(text)
        .trim_end()
        .to_lowercase();
    let words: Vec<&str> = text.split_whitespace().collect();
    matches!(
        words.as_slice(),
        ["cancel"]
            | ["nevermind"]
            | ["never", "mind"]
            | ["scratch", "that"]
            | ["forget", "that" | "it"]
    )
}
