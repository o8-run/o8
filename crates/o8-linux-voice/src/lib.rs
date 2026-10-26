//! Linux voice backends for o8.
//!
//! The macOS voice stack is built from native pieces that do not exist on
//! Linux: a Swift `speech_recognizer` helper (Apple Speech), the `say` binary,
//! and an `osascript` volume ducker. This crate supplies Linux counterparts
//! that keep the same contracts, so the desktop shell can adopt them without
//! changing its macOS code paths:
//!
//! - [`protocol`] and [`daemon`]: a speech helper that speaks the exact
//!   stdin/stdout line protocol of `src-tauri/helpers/speech_recognizer.swift`
//!   (`start:<id>` / `stop:<id>` in, `{"type":..,"text":..,"session_id":..}`
//!   out). The `o8-speech-recognizer` binary (feature `whisper`) runs it with
//!   whisper.cpp, downloading the model on demand ([`model`]).
//! - [`tts`]: a cancellable, single-flight speech fallback over `piper`
//!   (when a voice model is installed), `espeak-ng` or `spd-say`, in that
//!   order, mirroring `tts/native_say.rs`.
//! - [`ducker`]: output-volume ducking through `pactl` (PipeWire or
//!   PulseAudio), mirroring `audio_ducker.rs`.
//!
//! Every external tool is detected at runtime. A missing tool degrades to a
//! clear message (an `error` event, a `false` return, a no-op) and never a
//! panic.

pub mod audio;
pub mod capture;
pub mod daemon;
pub mod devices;
pub mod ducker;
pub mod model;
pub mod protocol;
pub mod tools;
pub mod tts;
#[cfg(feature = "whisper")]
pub mod whisper;
