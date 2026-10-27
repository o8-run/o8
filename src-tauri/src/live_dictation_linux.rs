//! Linux stand-in for `live_dictation.rs` (#1672). Live caret streaming into
//! other apps rides the macOS Accessibility API; on Linux every system-origin
//! session reports `NotHandled`, so `stt_engine` takes its ordinary paste path.

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum FinishOutcome {
    Applied,
    NotHandled,
    Conflict(String),
}

pub(crate) fn queue_partial(_session_id: u64, _text: String) {}

pub(crate) fn finish(_session_id: u64, _text: &str) -> FinishOutcome {
    FinishOutcome::NotHandled
}

pub(crate) fn cancel_session(_session_id: u64) {}

pub(crate) fn cancel_active() {}
