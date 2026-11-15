//! Composer speech without the desktop shell. o8 next runs the Swift speech
//! helper (`src-tauri/helpers/speech_recognizer.swift`, daemon mode) as its own
//! child process and finishes each recording through the server's dictation
//! routes:
//!
//! - Apple's live transcript streams as full snapshots (`Update::Partial`).
//! - On stop, Apple's final text is used. When it is empty, the recorded WAV
//!   goes to `/api/dictation/transcribe` (the Whisper fallback).
//! - The text is polished by `/api/dictation/polish` and handed back once as
//!   `Update::Done`. Polish is best effort: if it fails, the raw text goes out.
//!
//! - Each text that goes out is appended to Voice History
//!   (`dictation-history.json`), as the shell does.
//!
//! One recording at a time. A start while another recording is listening or
//! finishing is refused, so o8 next has a single microphone owner here. The
//! helper starts on the first recording, stays alive between recordings and is
//! started again by the next recording after it exits.
// The composer adopts the client in the next change.
#![allow(dead_code, unused_imports)]

mod engine;
#[cfg(test)]
pub(crate) mod fake;
mod helper;
mod history;
mod prefs;
mod server;
#[cfg(test)]
mod server_tests;
#[cfg(test)]
mod tests;

use std::sync::{Arc, mpsc};

pub(crate) use helper::{Launch, helper_path};
pub(crate) use prefs::VoicePrefs;
pub(crate) use server::ServerFinish;

/// Where a recording is. `Idle` follows a cancel; the terminal updates
/// (`Done`, `Empty`, `Dropped`, `Failed`) also leave the recording idle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    Idle,
    /// Waiting for the helper to boot or to confirm the microphone.
    Starting,
    Listening,
    /// Stopped; waiting for Apple's final text and the recording.
    Finishing,
    /// Apple heard nothing; the recording is with Whisper.
    Transcribing,
    Polishing,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Update {
    Phase(Phase),
    /// Microphone level, 0 to 1.
    Level(f32),
    /// The whole transcript so far; it replaces the previous snapshot.
    Partial(String),
    /// The polished text, ready to send.
    Done(String),
    /// Nothing was heard.
    Empty,
    /// A spoken cancel ("scratch that"); nothing is sent.
    Dropped,
    Failed(String),
}

/// An update for the recording `id` that `Speech::start` returned.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Event {
    pub id: u64,
    pub update: Update,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Polished {
    pub text: String,
    /// The transcript was a spoken cancel.
    pub cancelled: bool,
}

/// The server half of finishing a recording; tests stub it.
pub(crate) trait Finish: Send + Sync {
    fn transcribe(&self, wav: &std::path::Path) -> Result<String, String>;
    /// `prefs` carries the saved dictionary and instructions; the client
    /// applies the replacements itself.
    fn polish(
        &self,
        transcript: &str,
        repo: Option<&str>,
        prefs: &VoicePrefs,
    ) -> Result<Polished, String>;
}

/// The handle the composer holds. Dropping it quits the helper.
pub(crate) struct Speech {
    input: mpsc::Sender<engine::Input>,
    events: async_channel::Receiver<Event>,
    next: u64,
}

impl Speech {
    pub(crate) fn new(launch: Launch, finish: Arc<dyn Finish>) -> Self {
        let (sender, events) = async_channel::unbounded();
        Self {
            input: engine::spawn(launch, finish, sender),
            events,
            next: 0,
        }
    }
    pub(crate) fn events(&self) -> async_channel::Receiver<Event> {
        self.events.clone()
    }
    /// Starts a recording; every update for it carries the returned id. `repo`
    /// is the polish context's active repository.
    pub(crate) fn start(&mut self, repo: Option<String>) -> u64 {
        self.next += 1;
        let id = self.next;
        let _ = self.input.send(engine::Input::Start { id, repo });
        id
    }
    /// Stops recording `id` and finishes it into `Update::Done`.
    pub(crate) fn stop(&self, id: u64) {
        let _ = self.input.send(engine::Input::Stop(id));
    }
    /// Ends recording `id` without a result, in any phase; late text is dropped.
    pub(crate) fn cancel(&self, id: u64) {
        let _ = self.input.send(engine::Input::Cancel(id));
    }
}

impl Drop for Speech {
    fn drop(&mut self) {
        let _ = self.input.send(engine::Input::Shutdown);
    }
}
