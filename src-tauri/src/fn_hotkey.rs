//! Global Fn hotkey → system-wide push-to-talk dictation (macOS only).
//!
//! Lifted from aqua/Symon's `start_fn_key_monitor`. The live gesture map:
//!
//! - Hold Fn → push-to-talk dictation (paste at the caret on release).
//! - Double-tap Fn → long-form dictation (single Fn tap finishes, Esc cancels).
//! - Hold Right Option → Symon voice AGENT (tool-calling loop; release
//!   ≥120ms runs the command, a KeyDown mid-hold cancels so ⌥-chords stay safe).
//! - Optionally, bottom-left Control mirrors Fn on Windows-layout boards whose
//!   printed Fn key is firmware-only: hold to dictate, double-tap for long-form.
//! - Double-tap Right Option → long-form AGENT question (single Option tap
//!   finishes, Esc cancels).
//!
//! Implementation notes:
//!
//! - A raw `CGEventTap` at `CGEventTapLocation::HID` (Sequoia 15.7.x has a
//!   confirmed regression where SESSION-level taps silently stop delivering
//!   events; HID taps run earlier in the pipeline and are unaffected).
//! - Hold Fn → `paste::save_frontmost_app()` + `stt_engine::start()`.
//!   Release Fn → `stt_engine::stop()`; the finalize chain pastes (see the
//!   origin branch in `lib.rs::stt_engine::run_finalize`).
//! - A 40ms `CGEventSourceFlagsState` poll fallback for the dropped Fn-UP edge
//!   (the other half of the same Sequoia regression — the tap delivers the
//!   Fn-down FlagsChanged then goes silent, so the natural release never fires).
//! - `catch_unwind` around the entire callback body. The closure runs inside an
//!   extern "C" CGEvent tap callback; a panic cannot unwind across the C
//!   boundary — it ABORTS the whole o8 process (killing the Node sidecars). The
//!   catch converts any panic into a logged no-op so the app stays alive.
//!
//! The tap callback returns in microseconds: it only flips an `AtomicBool` edge
//! latch and spawns a worker thread. All STT / paste / activate work runs off
//! the tap thread — macOS auto-disables a tap whose callback runs too slowly.
//!
//! CRITICAL: this REUSES o8's existing `stt_engine` daemon. It NEVER spawns a
//! second recognizer — the Swift `speech_recognizer` sidecar is already owned by
//! `stt_engine::spawn` (called once from `setup()`).

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
#[cfg(target_os = "macos")]
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(target_os = "macos")]
use tauri::Emitter;

/// The app handle, stored once at `start()`, so the off-tap worker threads can
/// re-assert the always-on screen dock pill window + emit the `system-start`
/// event on Fn-down (system-wide Symon fold P3). Cloned per use; AppHandle is
/// cheap to clone.
#[cfg(target_os = "macos")]
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// True while a dictation was started by the global Fn hotkey (system path)
/// rather than the in-window mic button. `run_finalize` reads this to decide
/// whether to PASTE the polished text into the focused app (system origin) or
/// EMIT it to the composer (in-window origin). Set at Fn-down, cleared inside
/// `run_finalize` after the paste fires.
#[cfg(target_os = "macos")]
static SYSTEM_DICTATION_ORIGIN: AtomicBool = AtomicBool::new(false);

/// Mark the current dictation as system-originated (called at Fn-down).
#[cfg(target_os = "macos")]
pub fn set_system_origin(on: bool) {
    SYSTEM_DICTATION_ORIGIN.store(on, Ordering::SeqCst);
}

/// Whether the active dictation was started by the global Fn hotkey.
#[cfg(target_os = "macos")]
pub fn is_system_origin() -> bool {
    SYSTEM_DICTATION_ORIGIN.load(Ordering::SeqCst)
}

/// Linux: set by X11 push-to-talk (`linux_ptt.rs`), read by `run_finalize`.
#[cfg(target_os = "linux")]
static SYSTEM_DICTATION_ORIGIN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "linux")]
pub fn set_system_origin(on: bool) {
    SYSTEM_DICTATION_ORIGIN.store(on, std::sync::atomic::Ordering::SeqCst);
}

#[cfg(target_os = "linux")]
pub fn is_system_origin() -> bool {
    SYSTEM_DICTATION_ORIGIN.load(std::sync::atomic::Ordering::SeqCst)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn set_system_origin(_on: bool) {}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn is_system_origin() -> bool {
    false
}

/// Last polished system-dictation transcript, stashed at the end of
/// `run_finalize` so the ⌘⌥V global shortcut can re-paste it (voice P3). Holds
/// only the most recent entry — the trimmed equivalent of Symon's transcript
/// store, scoped to the single value ⌘⌥V needs.
#[cfg(target_os = "macos")]
static LAST_VOICE_TRANSCRIPT: Mutex<Option<String>> = Mutex::new(None);

/// Record the latest polished system transcript (called from `run_finalize`).
#[cfg(target_os = "macos")]
pub fn set_last_voice_transcript(text: &str) {
    if let Ok(mut g) = LAST_VOICE_TRANSCRIPT.lock() {
        *g = Some(text.to_string());
    }
}

/// The most recent polished system transcript, if any (⌘⌥V paste-last).
#[cfg(target_os = "macos")]
pub fn last_voice_transcript() -> Option<String> {
    LAST_VOICE_TRANSCRIPT.lock().ok().and_then(|g| g.clone())
}

#[cfg(not(target_os = "macos"))]
pub fn set_last_voice_transcript(_text: &str) {}

#[cfg(not(target_os = "macos"))]
pub fn last_voice_transcript() -> Option<String> {
    None
}

/// NSEventModifierFlagFunction = 1 << 23.
#[cfg(target_os = "macos")]
const FN_FLAG: u64 = 0x800000;

/// NSEventModifierFlagControl = 1 << 18. Holding Control with Fn turns the
/// captured speech into a screen-aware Smart Compose instruction instead of
/// inserting the instruction literally.
#[cfg(target_os = "macos")]
const CONTROL_FLAG: u64 = 0x40000;

#[cfg(target_os = "macos")]
static SMART_COMPOSE_MODE: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
pub fn take_smart_compose_mode() -> bool {
    SMART_COMPOSE_MODE.swap(false, Ordering::SeqCst)
}

#[cfg(not(target_os = "macos"))]
pub fn take_smart_compose_mode() -> bool {
    false
}

/// Minimum Fn hold before we treat the press as a real dictation. A brush under
/// this just flips the recognizer on and off with no paste — same failure mode
/// as aqua's FN_TAP_PRIMER_MAX_MS.
#[cfg(target_os = "macos")]
const FN_TAP_PRIMER_MAX_MS: u64 = 220;

/// Max gap between two Fn brushes for them to count as a DOUBLE-TAP (which
/// toggles long-form dictation). Verbatim from Symon's `LONG_FORM_FN_DOUBLE_TAP_MS`.
#[cfg(target_os = "macos")]
const LONG_FORM_FN_DOUBLE_TAP_MS: u64 = 480;

/// Hard cap on how long `begin_system_dictation` waits for the audio duck's
/// first volume-set before opening the mic (#1544). Long enough for a normal
/// osascript volume-set to land, short enough that a slow one can't delay the
/// felt start of dictation.
#[cfg(target_os = "macos")]
const DUCK_SETTLE_CAP_MS: u64 = 450;

/// macOS Escape key virtual keycode — cancels an active long-form dictation.
#[cfg(target_os = "macos")]
const ESCAPE_KEYCODE: i64 = 53;

/// NSEventModifierFlagOption = 1 << 19. Set when EITHER Option key is down (the
/// side-agnostic bit). Used only for physical-finger truth before selection copy.
#[cfg(target_os = "macos")]
const OPTION_FLAG: u64 = 0x80000;

/// Device-dependent RIGHT-Option mask (NX_DEVICERALTKEYMASK). The generic
/// `OPTION_FLAG` says only "an Option is down", not which side; this bit is set
/// for the RIGHT key specifically, so a held LEFT Option never reads as the
/// agent gesture. The keycode (61) also tells the keys apart, but on a
/// FlagsChanged event the device bit is the directly-comparable down/up signal.
#[cfg(target_os = "macos")]
const RIGHT_OPTION_DEVICE_FLAG: u64 = 0x40;

/// Virtual keycode for the RIGHT Option key (Left Option = 58). RIGHT Option,
/// held alone, drives the Symon voice AGENT: hold, speak a command or question,
/// release to run it through the tool-calling loop. Double-tap Right-Option =
/// long-form agent (open mic for a long question; single tap finishes, Escape
/// cancels). LEFT Option does NOT trigger the agent.
#[cfg(target_os = "macos")]
const RIGHT_OPTION_KEYCODE: i64 = 61;

/// Windows-layout keyboards put LEFT Control in the bottom-left position where
/// Apple keyboards put Fn. Some boards keep their printed Fn key entirely in
/// firmware, so macOS receives no key event o8 can bind. This observable key is
/// the opt-in substitute; Control chords still pass through because the tap is
/// ListenOnly and any KeyDown cancels the voice gesture.
#[cfg(target_os = "macos")]
const LEFT_CONTROL_KEYCODE: i64 = 59;
#[cfg(target_os = "macos")]
const LEFT_CONTROL_DEVICE_FLAG: u64 = 0x1;

#[cfg(target_os = "macos")]
const LEFT_CONTROL_CAPTURE_DELAY_MS: u64 = 80;

#[cfg(target_os = "macos")]
static EXTERNAL_LEFT_CONTROL_FN: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static LEFT_CONTROL_STATE: AtomicU8 = AtomicU8::new(0);

#[cfg(target_os = "macos")]
const LEFT_CONTROL_IDLE: u8 = 0;
#[cfg(target_os = "macos")]
const LEFT_CONTROL_PENDING: u8 = 1;
#[cfg(target_os = "macos")]
const LEFT_CONTROL_STARTING: u8 = 2;
#[cfg(target_os = "macos")]
const LEFT_CONTROL_CAPTURING: u8 = 3;
#[cfg(target_os = "macos")]
const LEFT_CONTROL_CANCEL_AFTER_START: u8 = 4;
#[cfg(target_os = "macos")]
const LEFT_CONTROL_FINISH_AFTER_START: u8 = 5;
#[cfg(target_os = "macos")]
const LEFT_CONTROL_FINISH_LONG_FORM: u8 = 6;
#[cfg(target_os = "macos")]
const LEFT_CONTROL_BEGIN_LONG_FORM: u8 = 7;

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LeftControlCompletionAction {
    None,
    Discard,
    End,
    FinishLongForm,
    BeginLongForm,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LeftControlTransition {
    next: u8,
    stamp_brush: bool,
    completion: LeftControlCompletionAction,
}

#[cfg(target_os = "macos")]
fn cancel_left_control_transition(state: u8) -> LeftControlTransition {
    match state {
        LEFT_CONTROL_PENDING | LEFT_CONTROL_FINISH_LONG_FORM | LEFT_CONTROL_BEGIN_LONG_FORM => {
            LeftControlTransition {
                next: LEFT_CONTROL_IDLE,
                stamp_brush: false,
                completion: LeftControlCompletionAction::None,
            }
        }
        LEFT_CONTROL_STARTING => LeftControlTransition {
            next: LEFT_CONTROL_CANCEL_AFTER_START,
            stamp_brush: false,
            completion: LeftControlCompletionAction::None,
        },
        LEFT_CONTROL_CAPTURING => LeftControlTransition {
            next: LEFT_CONTROL_IDLE,
            stamp_brush: false,
            completion: LeftControlCompletionAction::Discard,
        },
        _ => LeftControlTransition {
            next: state,
            stamp_brush: false,
            completion: LeftControlCompletionAction::None,
        },
    }
}

#[cfg(target_os = "macos")]
fn release_left_control_transition(state: u8, short: bool) -> LeftControlTransition {
    match state {
        LEFT_CONTROL_PENDING => LeftControlTransition {
            next: LEFT_CONTROL_IDLE,
            stamp_brush: short,
            completion: LeftControlCompletionAction::None,
        },
        LEFT_CONTROL_STARTING => LeftControlTransition {
            next: if short {
                LEFT_CONTROL_CANCEL_AFTER_START
            } else {
                LEFT_CONTROL_FINISH_AFTER_START
            },
            stamp_brush: short,
            completion: LeftControlCompletionAction::None,
        },
        LEFT_CONTROL_CAPTURING => LeftControlTransition {
            next: LEFT_CONTROL_IDLE,
            stamp_brush: short,
            completion: if short {
                LeftControlCompletionAction::Discard
            } else {
                LeftControlCompletionAction::End
            },
        },
        LEFT_CONTROL_FINISH_LONG_FORM => LeftControlTransition {
            next: LEFT_CONTROL_IDLE,
            stamp_brush: false,
            completion: LeftControlCompletionAction::FinishLongForm,
        },
        LEFT_CONTROL_BEGIN_LONG_FORM => LeftControlTransition {
            next: LEFT_CONTROL_IDLE,
            stamp_brush: false,
            completion: LeftControlCompletionAction::BeginLongForm,
        },
        _ => LeftControlTransition {
            next: state,
            stamp_brush: false,
            completion: LeftControlCompletionAction::None,
        },
    }
}

#[cfg(target_os = "macos")]
fn started_left_control_transition(state: u8) -> LeftControlTransition {
    match state {
        LEFT_CONTROL_STARTING => LeftControlTransition {
            next: LEFT_CONTROL_CAPTURING,
            stamp_brush: false,
            completion: LeftControlCompletionAction::None,
        },
        LEFT_CONTROL_CANCEL_AFTER_START => LeftControlTransition {
            next: LEFT_CONTROL_IDLE,
            stamp_brush: false,
            completion: LeftControlCompletionAction::Discard,
        },
        LEFT_CONTROL_FINISH_AFTER_START => LeftControlTransition {
            next: LEFT_CONTROL_IDLE,
            stamp_brush: false,
            completion: LeftControlCompletionAction::End,
        },
        _ => LeftControlTransition {
            next: state,
            stamp_brush: false,
            completion: LeftControlCompletionAction::None,
        },
    }
}

#[cfg(target_os = "macos")]
fn apply_left_control_transition(
    classify: impl Fn(u8) -> LeftControlTransition,
) -> LeftControlTransition {
    loop {
        let current = LEFT_CONTROL_STATE.load(Ordering::SeqCst);
        let transition = classify(current);
        if transition.next == current
            || LEFT_CONTROL_STATE
                .compare_exchange(current, transition.next, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            return transition;
        }
    }
}

#[cfg(target_os = "macos")]
fn run_left_control_completion(action: LeftControlCompletionAction) {
    match action {
        LeftControlCompletionAction::None => {}
        LeftControlCompletionAction::Discard => {
            std::thread::spawn(discard_brush);
        }
        LeftControlCompletionAction::End => {
            std::thread::spawn(end_system_dictation);
        }
        LeftControlCompletionAction::FinishLongForm => {
            LONG_FORM_ACTIVE.store(false, Ordering::SeqCst);
            std::thread::spawn(finish_long_form_dictation);
        }
        LeftControlCompletionAction::BeginLongForm => {
            LONG_FORM_ACTIVE.store(true, Ordering::SeqCst);
            std::thread::spawn(begin_long_form_dictation);
        }
    }
}

/// Arm or disarm the Control-as-Fn substitute in the live event tap. This takes
/// the EFFECTIVE value, not the operator's pref: `external_keyboard::apply` is
/// the only caller, and it has already ANDed the pref with "a non-Apple external
/// keyboard is attached" (#2158).
#[cfg(target_os = "macos")]
pub fn set_external_left_control_fn(enabled: bool) {
    EXTERNAL_LEFT_CONTROL_FN.store(enabled, Ordering::SeqCst);
}

#[cfg(not(target_os = "macos"))]
pub fn set_external_left_control_fn(_enabled: bool) {}

#[cfg(target_os = "macos")]
fn is_left_control_fn_event(enabled: bool, keycode: i64, flags: u64) -> bool {
    enabled && keycode == LEFT_CONTROL_KEYCODE && (flags & LEFT_CONTROL_DEVICE_FLAG) != 0
}

#[cfg(target_os = "macos")]
#[derive(Debug, Eq, PartialEq)]
enum SystemDictationPressAction {
    FinishLongForm,
    BeginSmartCompose,
    BeginLongForm,
    BeginPushToTalk,
}

#[cfg(target_os = "macos")]
fn classify_system_dictation_press(
    long_form_active: bool,
    long_form_session_id: u64,
    smart_compose: bool,
    double_tap: bool,
) -> SystemDictationPressAction {
    if long_form_active && long_form_session_id != 0 {
        SystemDictationPressAction::FinishLongForm
    } else if smart_compose {
        SystemDictationPressAction::BeginSmartCompose
    } else if double_tap {
        SystemDictationPressAction::BeginLongForm
    } else {
        SystemDictationPressAction::BeginPushToTalk
    }
}

/// Virtual keycode for the LEFT Option key. LEFT Option does NOT trigger the
/// agent. We still track its physical down/up so speak-selection can wait for a
/// stray held Option before the synthetic Cmd+C selection grab.
#[cfg(target_os = "macos")]
const LEFT_OPTION_KEYCODE: i64 = 58;

/// Right-Option hold under this is a brush (cancel, don't ask). Verbatim from
/// Symon's 120ms Ask brush guard.
#[cfg(target_os = "macos")]
const ASK_BRUSH_MS: u64 = 120;

/// True while an ASK dictation is recording a question. `run_finalize` takes
/// this to route the polished transcript to Gemini (speak the answer) instead
/// of pasting it. The Ask lane currently has NO keyboard binding — Right Option
/// drives the agent (which answers questions too, with tools). The plumbing
/// stays for a future dock-panel initiator.
#[cfg(target_os = "macos")]
static ASK_MODE: AtomicBool = AtomicBool::new(false);

/// Edge latch for the RIGHT-Option agent gesture. Keyed on the right-Option
/// device bit (not the side-agnostic OPTION_FLAG), so a held LEFT Option never
/// begins/ends the gesture.
#[cfg(target_os = "macos")]
static OPTION_HELD: AtomicBool = AtomicBool::new(false);

/// Raw physical state of the Option key, updated on every Option FlagsChanged.
/// Unlike `OPTION_HELD` (the gesture edge-latch, cleared early by the chord
/// guard), this tracks the actual finger. The speak-selection path polls it so
/// the synthetic Cmd+C selection grab never fires under a still-held Option.
#[cfg(target_os = "macos")]
static OPTION_PHYSICALLY_DOWN: AtomicBool = AtomicBool::new(false);

/// Block (≤`cap_ms`) until the user's finger leaves the Option key. Call from
/// a worker thread only — never the event tap.
#[cfg(target_os = "macos")]
pub(crate) fn wait_for_option_release(cap_ms: u64) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(cap_ms);
    while OPTION_PHYSICALLY_DOWN.load(Ordering::SeqCst) {
        if std::time::Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// The stt_engine session id of the active Ask dictation (0 = none). Fenced like
/// the long-form session id so a late teardown can't kill a newer session.
#[cfg(target_os = "macos")]
#[allow(dead_code)] // Ask lane unbound from keys; kept for a future initiator.
static ASK_SESSION_ID: AtomicU64 = AtomicU64::new(0);

/// True while an Option AGENT dictation is recording a command. `run_finalize`
/// takes this to route the polished transcript to the Symon voice agent. Distinct
/// from ASK_MODE and the paste/long-form flags.
#[cfg(target_os = "macos")]
static AGENT_MODE: AtomicBool = AtomicBool::new(false);

/// True while a DOUBLE-TAP-Option long-form AGENT dictation is active: open mic
/// for a long question, ended by a single Option tap (or Escape cancel). Mirrors
/// LONG_FORM_ACTIVE for the Fn dictation lane.
#[cfg(target_os = "macos")]
static AGENT_LONG_FORM_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Timestamp of the last sub-threshold Option brush release. The next Option-down
/// within `LONG_FORM_FN_DOUBLE_TAP_MS` is a double-tap (long-form agent start).
#[cfg(target_os = "macos")]
static LAST_OPTION_BRUSH: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// The stt_engine session id of the active agent dictation (0 = none).
#[cfg(target_os = "macos")]
static AGENT_SESSION_ID: AtomicU64 = AtomicU64::new(0);

/// The agent session whose STT events still belong to the Right-Option lane.
/// Unlike `AGENT_SESSION_ID`, this survives key-up so the recognizer's trailing
/// final/status/complete events retain `lane: "agent"` through teardown.
#[cfg(target_os = "macos")]
static AGENT_EVENT_SESSION_ID: AtomicU64 = AtomicU64::new(0);

/// NSEventModifierFlagCommand = 1 << 20.
#[cfg(target_os = "macos")]
const COMMAND_FLAG: u64 = 0x100000;

/// Virtual keycode for the RIGHT Command key (Left Command = 55). Right ⌘ is
/// unused by o8's other gestures (Fn + Option both drive dictation/agent), so a
/// clean DOUBLE-TAP of it toggles voice-to-voice (realtime) mode without
/// colliding with anything — the chosen trigger (operator, 2026-06-19).
#[cfg(target_os = "macos")]
const RIGHT_COMMAND_KEYCODE: i64 = 54;

/// Max hold for a right-⌘ press to count as a TAP (not a held shortcut modifier).
#[cfg(target_os = "macos")]
const CMD_BRUSH_MS: u64 = 300;

/// Edge latch for the right-Command key (the voice-toggle gesture).
#[cfg(target_os = "macos")]
static RIGHT_CMD_HELD: AtomicBool = AtomicBool::new(false);

/// Set true when any key is pressed while right-⌘ is held — i.e. a ⌘-shortcut
/// chord (⌘C, ⌘V, …), NOT a clean double-tap brush. The ⌘-release then no-ops,
/// so normal shortcuts never toggle voice mode.
#[cfg(target_os = "macos")]
static RIGHT_CMD_CHORDED: AtomicBool = AtomicBool::new(false);

/// Press time of the current right-⌘ hold, to classify brush vs hold.
#[cfg(target_os = "macos")]
static RIGHT_CMD_PRESS_TIME: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// Timestamp of the last clean right-⌘ brush release. A second brush within
/// `LONG_FORM_FN_DOUBLE_TAP_MS` is a double-tap → toggle realtime voice mode.
#[cfg(target_os = "macos")]
static LAST_RIGHT_CMD_BRUSH: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// Whether a Right-Option Ask dictation is currently recording. Read by
/// `run_finalize` (via take_ask_mode) to route the result to Gemini.
#[cfg(target_os = "macos")]
pub fn take_ask_mode() -> bool {
    ASK_MODE.swap(false, Ordering::SeqCst)
}

#[cfg(not(target_os = "macos"))]
pub fn take_ask_mode() -> bool {
    false
}

/// Whether a Right-Option agent dictation is currently recording. Read by
/// `run_finalize` (via take_agent_mode) to route the result to the voice agent.
#[cfg(target_os = "macos")]
pub fn take_agent_mode() -> bool {
    AGENT_MODE.swap(false, Ordering::SeqCst)
}

#[cfg(not(target_os = "macos"))]
pub fn take_agent_mode() -> bool {
    false
}

#[cfg(target_os = "macos")]
pub fn is_agent_event_session(session_id: Option<u64>) -> bool {
    let tracked = AGENT_EVENT_SESSION_ID.load(Ordering::SeqCst);
    (tracked != 0 && session_id.is_none_or(|session_id| session_id == tracked))
        || (tracked == 0 && AGENT_MODE.load(Ordering::SeqCst))
}

#[cfg(not(target_os = "macos"))]
pub fn is_agent_event_session(_session_id: Option<u64>) -> bool {
    false
}

#[cfg(target_os = "macos")]
pub fn clear_agent_event_session(session_id: Option<u64>) {
    if let Some(session_id) = session_id {
        let _ = AGENT_EVENT_SESSION_ID.compare_exchange(
            session_id,
            0,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
    } else {
        AGENT_EVENT_SESSION_ID.store(0, Ordering::SeqCst);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn clear_agent_event_session(_session_id: Option<u64>) {}

/// True while a DOUBLE-TAP-Fn long-form dictation is active. Unlike push-to-talk
/// (which ends on Fn release), long-form stays on until a single Fn tap finishes
/// it (or Escape cancels). Read by the tap callback + the poll fallback; written
/// synchronously in the tap callback (toggle edges) + the begin/finish helpers.
#[cfg(target_os = "macos")]
static LONG_FORM_ACTIVE: AtomicBool = AtomicBool::new(false);

/// The stt_engine session id of the active long-form dictation (0 = none). Set
/// when `begin_long_form_dictation` starts the recognizer; zeroed on finish /
/// cancel. The finish edge requires this to be non-zero so a double-tap that
/// raced a still-starting session can't finish a session that never began.
#[cfg(target_os = "macos")]
static LONG_FORM_SESSION_ID: AtomicU64 = AtomicU64::new(0);

/// Timestamp of the last sub-threshold Fn brush release. The next Fn-down within
/// `LONG_FORM_FN_DOUBLE_TAP_MS` is a double-tap. Consumed on read.
#[cfg(target_os = "macos")]
static LAST_FN_BRUSH: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// The dictation session id whose finalize must be DROPPED (long-form
/// Escape-cancel). 0 = none. Per-session (not a bare bool) so a concurrent,
/// non-cancelled finalize can't consume a discard meant for the cancelled one.
#[cfg(target_os = "macos")]
static DISCARD_FINALIZE_SESSION: AtomicU64 = AtomicU64::new(0);

/// The session id of the most recent push-to-talk / brush dictation. Lets the
/// brush + release teardown fence on its OWN session (`stop_session`) so a late
/// brush teardown can't kill a long-form session the user started right after.
#[cfg(target_os = "macos")]
static CURRENT_PTT_SESSION_ID: AtomicU64 = AtomicU64::new(0);

/// Request that session `sid`'s finalize be discarded (long-form Escape-cancel).
#[cfg(target_os = "macos")]
pub fn request_discard_finalize(sid: u64) {
    DISCARD_FINALIZE_SESSION.store(sid, Ordering::SeqCst);
}

/// Whether session `sid`'s finalize should be dropped. Clears the request on a
/// match (so ONLY that session is discarded). `run_finalize` calls this at its
/// top with its own session id.
#[cfg(target_os = "macos")]
pub fn take_discard_finalize(sid: u64) -> bool {
    sid != 0
        && DISCARD_FINALIZE_SESSION
            .compare_exchange(sid, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
}

#[cfg(not(target_os = "macos"))]
pub fn request_discard_finalize(_sid: u64) {}

#[cfg(not(target_os = "macos"))]
pub fn take_discard_finalize(_sid: u64) -> bool {
    false
}

/// Whether the just-arrived Fn-down completes a double-tap. Consumes the stored
/// brush timestamp on BOTH branches so a single stale brush can't match twice.
#[cfg(target_os = "macos")]
fn consume_double_tap_brush() -> bool {
    let mut guard = match LAST_FN_BRUSH.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let matched = matches!(
        *guard,
        Some(t) if t.elapsed() <= std::time::Duration::from_millis(LONG_FORM_FN_DOUBLE_TAP_MS)
    );
    *guard = None;
    matched
}

/// Whether the just-arrived Option-down completes a double-tap (long-form agent
/// start). Mirror of `consume_double_tap_brush` for the Option gesture.
#[cfg(target_os = "macos")]
fn consume_option_double_tap_brush() -> bool {
    let mut guard = match LAST_OPTION_BRUSH.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let matched = matches!(
        *guard,
        Some(t) if t.elapsed() <= std::time::Duration::from_millis(LONG_FORM_FN_DOUBLE_TAP_MS)
    );
    *guard = None;
    matched
}

/// Whether the just-released right-⌘ brush completes a double-tap (voice toggle).
/// Mirror of `consume_option_double_tap_brush` for the Command gesture.
#[cfg(target_os = "macos")]
fn consume_right_cmd_double_tap() -> bool {
    let mut guard = match LAST_RIGHT_CMD_BRUSH.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let matched = matches!(
        *guard,
        Some(t) if t.elapsed() <= std::time::Duration::from_millis(LONG_FORM_FN_DOUBLE_TAP_MS)
    );
    *guard = None;
    matched
}

/// CFMachPortRef of the Fn-key event tap, stored as raw pointer bits so the
/// callback can re-enable the tap when macOS auto-disables it
/// (`kCGEventTapDisabledByTimeout` / `kCGEventTapDisabledByUserInput`).
#[cfg(target_os = "macos")]
static FN_TAP_MACH_PORT: OnceLock<usize> = OnceLock::new();

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapEnable(tap: *mut std::ffi::c_void, enable: bool);
    fn CGEventSourceFlagsState(state_id: i32) -> u64;
}

/// Begin a system-origin dictation: remember the focused app, mark the origin,
/// then start the SHARED stt_engine daemon. Runs on a worker thread, never the
/// tap callback.
#[cfg(target_os = "macos")]
fn begin_system_dictation(smart_compose: bool) {
    let Some(input) = prepare_dictation_input() else {
        return;
    };
    // Fn is a barge-in gesture. Stop governed review speech before opening the
    // mic so interrupted audio can never drain as authorization.
    crate::tts::playback::stop();
    if smart_compose {
        // Boot Sonnet alongside capture. Spawning the CLI synchronously here can
        // take seconds on Intel and would open the mic late enough to lose the
        // operator's first words.
        std::thread::spawn(crate::agent::claude_pool::prewarm_smart_compose);
    }
    // Duck other system audio so the mic hears the operator clearly (#1207).
    // Keep the handle: we wait (bounded) for the first volume-set to land
    // before opening the mic below, so playing audio can't bleed into the
    // start of the message (#1544). This runs on a spawned worker thread (see
    // the `std::thread::spawn(begin_system_dictation)` call site), never the
    // CGEvent tap, so a short blocking wait here is safe.
    let duck = crate::audio_ducker::duck();
    // Kick the mic open IMMEDIATELY below — do NOT block on the duck first
    // (#1544 overlap). The duck's osascript runs on its own detached thread; we
    // hand the capture pump a shared "duck settled" flag and let it discard
    // captured audio until BOTH the warmup floor passes AND the duck lands (or
    // its cap expires), rather than serializing a fixed wait ahead of the device
    // open. A tiny waiter flips the flag when the handle resolves — which is
    // immediate when nothing needs ducking (SendOnDrop fires on every duck
    // early-exit), so the no-music case pays ZERO added latency.
    let duck_settled = Arc::new(AtomicBool::new(false));
    {
        let flag = Arc::clone(&duck_settled);
        std::thread::spawn(move || {
            duck.wait(std::time::Duration::from_millis(DUCK_SETTLE_CAP_MS));
            flag.store(true, Ordering::SeqCst);
        });
    }
    crate::sound::play_sound("Tink"); // start-listening cue (#1208)
    // Save the paste target BEFORE any focus could shift. Crucially this also
    // happens BEFORE the dock pill is ordered front — the dock window is
    // nonactivating so it shouldn't steal focus, but capturing the frontmost
    // app first is the belt-and-suspenders guarantee for the paste target.
    crate::paste::save_frontmost_app();
    let partials_surface = crate::live_dictation::begin(!smart_compose);
    let caret_anchor = crate::live_dictation::current_anchor();
    SMART_COMPOSE_MODE.store(smart_compose, Ordering::SeqCst);
    set_system_origin(true);

    // Morph the ALWAYS-ON screen dock pill into 'recording' (P3). The dock
    // window is created visible at boot and stays up — we do NOT show it from
    // hidden. `dock_window::show` here just RE-ASSERTS it (re-anchor to the
    // active monitor + re-order front nonactivating). The dock filters
    // `o8:stt-event` to origin==system; `system-start` morphs the idle capsule
    // into 'recording' immediately so the user sees the waveform the instant they
    // hold Fn, before the daemon's first partial lands. Both run on the main
    // thread (window + emit).
    // Visible partials follow the configured surface: cursor-local by default,
    // legacy screen bar when selected, or fully off. Tag visible starts with
    // `hud: true` so /agent-partials latches for plain Fn dictation too.
    if let Some(app) = APP_HANDLE.get() {
        let app = app.clone();
        let _ = app.run_on_main_thread({
            let app = app.clone();
            move || {
                crate::dock_window::show(&app);
                if partials_surface != crate::live_dictation::PartialsSurface::Off {
                    crate::agent_partials_window::show(&app, partials_surface, caret_anchor);
                }
                let payload = if partials_surface != crate::live_dictation::PartialsSurface::Off {
                    serde_json::json!({
                        "type": "system-start",
                        "origin": "system",
                        "hud": true,
                        "surface": partials_surface.as_str(),
                        "mode": if smart_compose { "smart-compose" } else { "dictation" },
                    })
                } else {
                    serde_json::json!({
                        "type": "system-start",
                        "origin": "system",
                        "surface": "off",
                        "mode": if smart_compose { "smart-compose" } else { "dictation" },
                    })
                };
                // Emit DIRECTLY to the dock window so the morph (idle → recording)
                // always lands — the broadcast `app.emit` can miss the second
                // (dock) webview. `emit_to(DOCK_LABEL, …)` is the reliable path.
                log::info!("[fn-hotkey] morph dock → recording (system-start → dock)");
                crate::stt_engine::emit_system_stt(&app, payload);
            }
        });
    }

    // Open the mic NOW, overlapping the duck. The pump discards captured audio
    // until the duck-settle gate opens (or its cap expires), so playing audio
    // still can't bleed into the message start (#1544) — but the device open no
    // longer waits behind a fixed duck delay, so the first words aren't lost.
    let duck_gate = crate::stt::capture::DuckGate {
        settled: duck_settled,
        cap: std::time::Duration::from_millis(DUCK_SETTLE_CAP_MS),
    };
    match crate::stt_engine::start_prepared(input, Some(duck_gate)) {
        Ok(sid) => {
            CURRENT_PTT_SESSION_ID.store(sid, Ordering::SeqCst);
            crate::live_dictation::bind_session(sid);
            tracing::info!("[fn-hotkey] system dictation started (session={sid})");
        }
        Err(e) => {
            tracing::error!("[fn-hotkey] failed to start dictation: {e}");
            crate::live_dictation::cancel_active();
            SMART_COMPOSE_MODE.store(false, Ordering::SeqCst);
            set_system_origin(false);
            // CURRENT_PTT_SESSION_ID is intentionally left at its previous value
            // here — a failed start has no live session to stop, and a later
            // release that loads the stale id will simply no-op in stop_session
            // (active_session() has already moved past it). Safe by the fence.
            // The session never started — surface WHY in the dock (mic permission
            // denied vs device open failed vs engine dead) instead of silently
            // morphing to idle, so a dead mic is never a mystery (#1537-adjacent).
            surface_dictation_start_error(&e);
        }
    }
}

#[cfg(target_os = "macos")]
fn prepare_dictation_input() -> Option<crate::voice_input::NativeInput> {
    match crate::stt_engine::prepare_input() {
        Ok(input) => Some(input),
        Err(error) => {
            surface_dictation_start_error(&error);
            None
        }
    }
}

/// Turn a raw `stt_engine::start()` failure string into a human-readable failure
/// class for the dock. Distinguishes the three things that actually go wrong at
/// capture start: Microphone permission, opening the input device, and the STT
/// engine/helper being unavailable.
#[cfg(target_os = "macos")]
fn classify_start_error(raw: &str) -> String {
    if raw == crate::voice_input::BUSY {
        return raw.to_string();
    }
    // Permission is the most common and most actionable — check TCC directly
    // rather than string-matching, since a denied grant surfaces as a generic
    // device-open failure downstream.
    match crate::mac_perms::mic_permission_granted() {
        Some(false) => {
            return "Microphone access is off. Turn on o8 under System Settings → Privacy & Security → Microphone.".to_string();
        }
        None => {
            return "Microphone access hasn't been granted yet. Allow o8 to use the microphone when macOS asks, then try again.".to_string();
        }
        Some(true) => {}
    }
    let lower = raw.to_lowercase();
    if lower.contains("input device")
        || lower.contains("input config")
        || lower.contains("input stream")
        || lower.contains("did not become ready")
        || lower.contains("sample format")
    {
        return "Couldn't open the microphone. Check your input device in Settings → Voice.".to_string();
    }
    if lower.contains("daemon")
        || lower.contains("not initialized")
        || lower.contains("recognizer unavailable")
        || lower.contains("respawn")
    {
        return "The dictation engine isn't responding. Try again, or restart o8.".to_string();
    }
    format!("Dictation couldn't start: {raw}")
}

/// Restore any ducked volume and morph the always-on dock into its error
/// capsule with a human failure message (the `/dictation-pill` route returns to
/// idle after its ERROR_FLASH). Reuses the existing `type:"error"` dock event so
/// no new surface is invented.
#[cfg(target_os = "macos")]
fn surface_dictation_start_error(raw: &str) {
    // Session never started — restore any ducked system volume (idempotent).
    crate::audio_ducker::restore();
    let message = classify_start_error(raw);
    log::warn!("[fn-hotkey] dictation start failed → dock error: {message}");
    if let Some(app) = APP_HANDLE.get() {
        let app = app.clone();
        let _ = app.run_on_main_thread({
            let app = app.clone();
            move || {
                let payload = serde_json::json!({
                    "type": "error",
                    "origin": "system",
                    "text": message,
                });
                crate::stt_engine::emit_system_stt(&app, payload);
            }
        });
    }
}

/// Morph the ALWAYS-ON screen dock pill back to its idle capsule from any worker
/// thread (hops to the main thread). Emits a `system-idle` event the
/// `/dictation-pill` route reduces back to idle — the dock window stays on
/// screen (it is never hidden on the normal flow). No-op if the app handle isn't
/// stored yet.
#[cfg(target_os = "macos")]
fn morph_dock_idle() {
    morph_dock_idle_for_lane(false);
}

#[cfg(target_os = "macos")]
fn morph_agent_dock_idle() {
    morph_dock_idle_for_lane(true);
}

#[cfg(target_os = "macos")]
fn morph_dock_idle_for_lane(agent_lane: bool) {
    // Dictation ended (discard / cancel / error) — restore any ducked system
    // volume. Idempotent: a no-op when nothing was ducked (#1207).
    crate::audio_ducker::restore();
    if let Some(app) = APP_HANDLE.get() {
        let app = app.clone();
        let _ = app.run_on_main_thread({
            let app = app.clone();
            move || {
                let payload =
                    serde_json::json!({ "type": "system-idle", "origin": "system" });
                // Direct-to-dock so the morph back to the idle capsule always lands.
                log::info!("[fn-hotkey] morph dock → idle (system-idle → dock)");
                if agent_lane {
                    crate::stt_engine::emit_agent_stt(&app, payload);
                } else {
                    crate::stt_engine::emit_system_stt(&app, payload);
                }
            }
        });
    }
}

#[cfg(target_os = "macos")]
fn resolve_system_dictation_session_id(recorded: u64, active: u64, system_origin: bool) -> u64 {
    if !system_origin || active == 0 {
        return 0;
    }
    if recorded == active {
        return recorded;
    }
    active
}

#[cfg(target_os = "macos")]
fn current_system_dictation_session_id() -> u64 {
    resolve_system_dictation_session_id(
        CURRENT_PTT_SESSION_ID.load(Ordering::SeqCst),
        crate::stt_engine::active_session_id(),
        is_system_origin(),
    )
}

/// End a system-origin dictation. The finalize chain (Whisper → polish → paste)
/// fires off the daemon's final/audio_file stdout events; the origin branch in
/// `run_finalize` routes the polished text to `paste::paste_text`.
#[cfg(target_os = "macos")]
fn end_system_dictation() {
    // Restore ducked volume the instant the user stops talking (#1207).
    crate::audio_ducker::restore();
    crate::sound::play_sound("Pop"); // stop-listening cue (#1208)
    // Fence on the push-to-talk session so a release that raced a newer session
    // (e.g. a double-tap that already promoted to long-form) can't stop the
    // wrong one. For a normal hold this is just the active session.
    let sid = current_system_dictation_session_id();
    if let Err(e) = crate::stt_engine::stop_session(sid) {
        tracing::warn!("[fn-hotkey] stop failed: {e}");
    }
}

/// Discard a too-short Fn brush: stop the recognizer and clear the origin so a
/// stray finalize doesn't paste an empty string into the focused app. Morph the
/// always-on dock back to its idle capsule (we emitted `system-start` on Fn-down,
/// so without this the brush would leave the dock stuck in 'recording'). The
/// dock is NEVER hidden — it morphs back to idle.
#[cfg(target_os = "macos")]
fn discard_brush() {
    crate::live_dictation::cancel_active();
    SMART_COMPOSE_MODE.store(false, Ordering::SeqCst);
    set_system_origin(false);
    // Fence on the brush's OWN session — if a double-tap already promoted to a
    // long-form session, this late brush teardown must NOT stop it (stop_session
    // no-ops when a newer session is active).
    let sid = CURRENT_PTT_SESSION_ID.load(Ordering::SeqCst);
    let _ = crate::stt_engine::stop_session(sid);
    morph_dock_idle();
}

/// Begin a DOUBLE-TAP-Fn long-form dictation. Like `begin_system_dictation` but
/// records the session id so a later single tap can finish it, and the recognizer
/// is NOT torn down on Fn release (the tap callback's up-edge + the poll skip it
/// while `LONG_FORM_ACTIVE`). Runs on a worker thread, never the tap callback.
/// `LONG_FORM_ACTIVE` is already set true synchronously by the tap callback.
#[cfg(target_os = "macos")]
fn begin_long_form_dictation() {
    let Some(input) = prepare_dictation_input() else {
        LONG_FORM_ACTIVE.store(false, Ordering::SeqCst);
        return;
    };
    crate::tts::playback::stop();
    let _ = crate::audio_ducker::duck();
    crate::sound::play_sound("Tink");
    crate::paste::save_frontmost_app();
    let partials_surface = crate::live_dictation::begin(true);
    let caret_anchor = crate::live_dictation::current_anchor();
    SMART_COMPOSE_MODE.store(false, Ordering::SeqCst);
    set_system_origin(true);

    // Morph the always-on dock into 'recording' (same surface as push-to-talk —
    // the user sees the waveform). Emit DIRECTLY to the dock window. The Fn
    // partials surface follows the same caret/screen/off setting as push-to-talk.
    if let Some(app) = APP_HANDLE.get() {
        let app = app.clone();
        let _ = app.run_on_main_thread({
            let app = app.clone();
            move || {
                crate::dock_window::show(&app);
                if partials_surface != crate::live_dictation::PartialsSurface::Off {
                    crate::agent_partials_window::show(&app, partials_surface, caret_anchor);
                }
                let payload = if partials_surface != crate::live_dictation::PartialsSurface::Off {
                    serde_json::json!({
                        "type": "system-start",
                        "origin": "system",
                        "hud": true,
                        "surface": partials_surface.as_str(),
                    })
                } else {
                    serde_json::json!({
                        "type": "system-start",
                        "origin": "system",
                        "surface": "off",
                    })
                };
                log::info!("[fn-hotkey] morph dock → recording (long-form start)");
                crate::stt_engine::emit_system_stt(&app, payload);
            }
        });
    }

    match crate::stt_engine::start_prepared(input, None) {
        Ok(sid) => {
            LONG_FORM_SESSION_ID.store(sid, Ordering::SeqCst);
            crate::live_dictation::bind_session(sid);
            tracing::info!("[fn-hotkey] long-form dictation started (session={sid})");
        }
        Err(e) => {
            tracing::error!("[fn-hotkey] failed to start long-form dictation: {e}");
            crate::live_dictation::cancel_active();
            // Roll the toggle back so a single tap doesn't try to finish a
            // session that never started.
            LONG_FORM_ACTIVE.store(false, Ordering::SeqCst);
            LONG_FORM_SESSION_ID.store(0, Ordering::SeqCst);
            set_system_origin(false);
            morph_dock_idle();
        }
    }
}

/// Finish an active long-form dictation (a single Fn tap toggled it off). Zero
/// the session id, then stop the recognizer — the finalize chain pastes the
/// polished text exactly like push-to-talk (origin is still system; the dock
/// flashes the words via `run_finalize`). `LONG_FORM_ACTIVE` was already cleared
/// synchronously by the tap callback.
#[cfg(target_os = "macos")]
fn finish_long_form_dictation() {
    crate::audio_ducker::restore();
    crate::sound::play_sound("Pop");
    // Fence on the long-form session so a finish that raced a brand-new
    // push-to-talk the user started right after can't stop the new session.
    let sid = LONG_FORM_SESSION_ID.swap(0, Ordering::SeqCst);
    if let Err(e) = crate::stt_engine::stop_session(sid) {
        tracing::warn!("[fn-hotkey] long-form finish stop failed: {e}");
    }
}

/// Finish whichever system-origin dictation is active. This is the shared
/// manual escape hatch for UI surfaces outside the raw Fn event tap.
#[cfg(target_os = "macos")]
pub fn finish_active_system_dictation() -> Result<(), String> {
    if LONG_FORM_ACTIVE.load(Ordering::SeqCst) && LONG_FORM_SESSION_ID.load(Ordering::SeqCst) != 0 {
        LONG_FORM_ACTIVE.store(false, Ordering::SeqCst);
        finish_long_form_dictation();
        return Ok(());
    }

    let sid = current_system_dictation_session_id();
    if sid == 0 || !is_system_origin() {
        return Err("No system dictation is currently listening.".to_string());
    }
    end_system_dictation();
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn finish_active_system_dictation() -> Result<(), String> {
    Err("System dictation is only available on macOS.".to_string())
}

/// Cancel an active long-form dictation (Escape) WITHOUT pasting. Clear the
/// origin AND request that the impending finalize be dropped entirely (no paste,
/// no composer emit) BEFORE stopping the recognizer, so the finalize that `stop`
/// triggers sees both flags. Morph the dock back to its idle capsule.
#[cfg(target_os = "macos")]
fn cancel_long_form_dictation() {
    let sid = LONG_FORM_SESSION_ID.swap(0, Ordering::SeqCst);
    crate::live_dictation::cancel_session(sid);
    set_system_origin(false);
    // Mark THIS session's finalize for discard, then stop it (fenced). Order
    // matters — the discard request must be set BEFORE stop() triggers the
    // daemon finalize that run_finalize handles.
    request_discard_finalize(sid);
    if let Err(e) = crate::stt_engine::stop_session(sid) {
        tracing::warn!("[fn-hotkey] long-form cancel stop failed: {e}");
    }
    log::info!("[fn-hotkey] long-form cancelled (Escape) — no paste");
    morph_dock_idle();
}

/// Begin a Right-Option ASK dictation: mark ASK_MODE, morph the dock to
/// 'recording' (so the user sees Ask is listening for the question), and start
/// the SHARED recognizer. `run_finalize` routes the polished transcript to
/// Gemini (speaks the answer) instead of pasting. Worker thread, never the tap.
#[cfg(target_os = "macos")]
#[allow(dead_code)] // Ask lane unbound from keys (both Options = agent); kept for a future initiator.
fn begin_ask_dictation() {
    let Some(input) = prepare_dictation_input() else {
        return;
    };
    let _ = crate::audio_ducker::duck();
    crate::sound::play_sound("Tink");
    // Ask takes the mic: the three voice modes (push-to-talk, long-form, ask)
    // share ONE recognizer + active_session, so abandon any in-flight session
    // first. Clear the competing flags and discard the prior session's finalize
    // (so it never pastes); the start() below supersedes active_session. Without
    // this, pressing Right-Option mid-Fn/long-form left the other mode's flags
    // set + an un-finishable session over the shared recognizer.
    LONG_FORM_ACTIVE.store(false, Ordering::SeqCst);
    LONG_FORM_SESSION_ID.store(0, Ordering::SeqCst);
    // Ask is a SYSTEM-origin session so its live partial transcript + audio
    // level reach the screen dock (emit_stt only forwards system-origin events
    // there) — the user sees their words + the waveform while asking. The
    // `is_ask` flag (consumed in run_finalize) still routes the question to
    // Gemini instead of pasting, so system-origin is safe here. Reset on the
    // Ask finalize branch.
    set_system_origin(true);
    let prev = crate::stt_engine::active_session_id();
    if prev != 0 {
        request_discard_finalize(prev);
    }

    ASK_MODE.store(true, Ordering::SeqCst);

    if let Some(app) = APP_HANDLE.get() {
        let app = app.clone();
        let _ = app.run_on_main_thread({
            let app = app.clone();
            move || {
                crate::dock_window::show(&app);
                let payload = serde_json::json!({ "type": "system-start", "origin": "system" });
                log::info!("[fn-hotkey] morph dock → recording (ask start)");
                crate::stt_engine::emit_system_stt(&app, payload);
                // Tell the dock's Ask answer panel to open (grow + show listening).
                // The panel itself calls dock_set_expanded to resize; this event is
                // the trigger. Dock-only — the in-window surface ignores it.
                let _ = app.emit_to(
                    crate::dock_window::DOCK_LABEL,
                    "o8:ask-open",
                    serde_json::json!({}),
                );
            }
        });
    }

    match crate::stt_engine::start_prepared(input, None) {
        Ok(sid) => {
            // A sub-120ms brush (discard_ask_dictation) may have cleared ASK_MODE
            // while we were starting — tear down the session we just started
            // rather than leave a dangling recorder nobody stops.
            if !ASK_MODE.load(Ordering::SeqCst) {
                let _ = crate::stt_engine::stop_session(sid);
                morph_dock_idle();
                return;
            }
            ASK_SESSION_ID.store(sid, Ordering::SeqCst);
            tracing::info!("[fn-hotkey] ask dictation started (session={sid})");
        }
        Err(e) => {
            tracing::error!("[fn-hotkey] failed to start ask dictation: {e}");
            ASK_MODE.store(false, Ordering::SeqCst);
            ASK_SESSION_ID.store(0, Ordering::SeqCst);
            morph_dock_idle();
        }
    }
}

/// Finish an Ask dictation (Right-Option released ≥120ms): stop the recognizer
/// (fenced) → the finalize chain polishes the question, and run_finalize routes
/// it to Gemini via take_ask_mode. ASK_MODE stays set until run_finalize takes it.
#[cfg(target_os = "macos")]
#[allow(dead_code)] // Ask lane unbound from keys (both Options = agent); kept for a future initiator.
fn end_ask_dictation() {
    crate::audio_ducker::restore();
    crate::sound::play_sound("Pop");
    let sid = ASK_SESSION_ID.swap(0, Ordering::SeqCst);
    if let Err(e) = crate::stt_engine::stop_session(sid) {
        tracing::warn!("[fn-hotkey] ask finish stop failed: {e}");
    }
}

/// Discard a too-short Right-Option brush: clear ASK_MODE, drop the finalize, and
/// stop the recognizer (fenced). Morph the dock back to its idle capsule.
#[cfg(target_os = "macos")]
#[allow(dead_code)] // Ask lane unbound from keys (both Options = agent); kept for a future initiator.
fn discard_ask_dictation() {
    let sid = ASK_SESSION_ID.swap(0, Ordering::SeqCst);
    ASK_MODE.store(false, Ordering::SeqCst);
    request_discard_finalize(sid);
    if let Err(e) = crate::stt_engine::stop_session(sid) {
        tracing::warn!("[fn-hotkey] ask cancel stop failed: {e}");
    }
    morph_dock_idle();
}

/// Begin a Right-Option AGENT dictation: mark AGENT_MODE, morph the dock to
/// 'recording' (so the user sees the agent is listening for a command), and
/// start the SHARED recognizer. `run_finalize` routes the polished transcript to
/// the Symon voice agent (`agent::spawn_agent`) instead of pasting or asking.
/// Mirror of `begin_ask_dictation`. Worker thread, never the tap.
#[cfg(target_os = "macos")]
fn begin_agent_dictation() {
    let Some(input) = prepare_dictation_input() else {
        AGENT_LONG_FORM_ACTIVE.store(false, Ordering::SeqCst);
        return;
    };
    // Right-Option is a barge-in gesture. Stop pending or active TTS before the
    // recognizer starts; a governed review completion then resolves false and
    // can never surface its confirmation card after the operator talked over it.
    crate::tts::playback::stop();
    // Pre-warm a `claude` session NOW (the Option down edge) so the CLI bootstrap
    // overlaps speech-to-text — by the time the prompt is assembled the proc is
    // booted and waiting, killing the turn-1 wait (#1252 speed pass). No-op when
    // the front brain isn't a Claude model.
    crate::agent::claude_pool::prewarm_agent();
    let _ = crate::audio_ducker::duck();
    crate::sound::play_sound("Tink");
    // The three voice modes share ONE recognizer — abandon any in-flight session.
    LONG_FORM_ACTIVE.store(false, Ordering::SeqCst);
    LONG_FORM_SESSION_ID.store(0, Ordering::SeqCst);
    // System-origin so the live partial transcript + waveform reach the dock; the
    // `is_agent` flag (taken in run_finalize) routes the command to the agent
    // instead of pasting, so system-origin is safe. Reset on the agent finalize.
    set_system_origin(true);
    let prev = crate::stt_engine::active_session_id();
    if prev != 0 {
        request_discard_finalize(prev);
    }

    AGENT_MODE.store(true, Ordering::SeqCst);
    SMART_COMPOSE_MODE.store(false, Ordering::SeqCst);

    let partials_surface = crate::live_dictation::configured_surface();
    let caret_anchor = if partials_surface == crate::live_dictation::PartialsSurface::Caret {
        crate::live_dictation::capture_caret_anchor()
    } else {
        None
    };

    if let Some(app) = APP_HANDLE.get() {
        let app = app.clone();
        // Arm the spatial-ink overlay FIRST: cover the cursor's monitor + CAPTURE
        // the mouse so the operator can draw while talking. Called before the
        // dock/partials show below so those re-order ABOVE the ink (arm orders
        // the ink front; the closure then re-fronts the dock + HUD over it).
        crate::spatial_ink_window::arm(&app);
        let _ = app.run_on_main_thread({
            let app = app.clone();
            move || {
                crate::dock_window::show(&app);
                // Re-assert the outside-the-window partials HUD too, so it
                // re-anchors to the MAIN window's current monitor and floats
                // above the frontmost app for this agent session.
                if partials_surface != crate::live_dictation::PartialsSurface::Off {
                    crate::agent_partials_window::show(&app, partials_surface, caret_anchor);
                }
                // `lane: agent` lets the dock distinguish this from a plain Fn
                // paste dictation — mid-conversation the panel keeps the dock
                // and renders the live transcript as a pending chat turn.
                let payload = serde_json::json!({
                    "type": "system-start",
                    "origin": "system",
                    "lane": "agent",
                    "surface": partials_surface.as_str(),
                });
                log::info!("[fn-hotkey] morph dock → recording (agent start)");
                crate::stt_engine::emit_agent_stt(&app, payload);
            }
        });
    }

    match crate::stt_engine::start_prepared(input, None) {
        Ok(sid) => {
            // A sub-120ms brush may have cleared AGENT_MODE while we were starting.
            if !AGENT_MODE.load(Ordering::SeqCst) {
                let _ = crate::stt_engine::stop_session(sid);
                morph_agent_dock_idle();
                return;
            }
            AGENT_SESSION_ID.store(sid, Ordering::SeqCst);
            AGENT_EVENT_SESSION_ID.store(sid, Ordering::SeqCst);
            tracing::info!("[fn-hotkey] agent dictation started (session={sid})");
        }
        Err(e) => {
            tracing::error!("[fn-hotkey] failed to start agent dictation: {e}");
            AGENT_MODE.store(false, Ordering::SeqCst);
            AGENT_LONG_FORM_ACTIVE.store(false, Ordering::SeqCst);
            AGENT_SESSION_ID.store(0, Ordering::SeqCst);
            AGENT_EVENT_SESSION_ID.store(0, Ordering::SeqCst);
            morph_agent_dock_idle();
        }
    }
}

/// Finish a Right-Option agent dictation (released ≥120ms): stop the recognizer
/// (fenced) → the finalize chain polishes the command, and run_finalize routes it
/// to the agent via take_agent_mode. Mirror of `end_ask_dictation`.
#[cfg(target_os = "macos")]
fn end_agent_dictation() {
    if !AGENT_MODE.load(Ordering::SeqCst) {
        return;
    }
    crate::audio_ducker::restore();
    crate::sound::play_sound("Pop");
    let sid = AGENT_SESSION_ID.swap(0, Ordering::SeqCst);
    if let Err(e) = crate::stt_engine::stop_session(sid) {
        tracing::warn!("[fn-hotkey] agent finish stop failed: {e}");
    }
}

/// Discard a too-short Right-Option brush: clear AGENT_MODE, drop the finalize,
/// and stop the recognizer (fenced). Mirror of `discard_ask_dictation`.
#[cfg(target_os = "macos")]
fn discard_agent_dictation() {
    if !AGENT_MODE.load(Ordering::SeqCst) {
        return;
    }
    let sid = AGENT_SESSION_ID.swap(0, Ordering::SeqCst);
    AGENT_MODE.store(false, Ordering::SeqCst);
    AGENT_LONG_FORM_ACTIVE.store(false, Ordering::SeqCst);
    clear_agent_event_session(Some(sid));
    request_discard_finalize(sid);
    if let Err(e) = crate::stt_engine::stop_session(sid) {
        tracing::warn!("[fn-hotkey] agent cancel stop failed: {e}");
    }
    // Teardown path — restore the ink overlay's click-through + clear any strokes
    // (a too-short brush never reaches finalize, so disarm here).
    if let Some(app) = APP_HANDLE.get() {
        crate::spatial_ink_window::disarm(app);
    }
    morph_agent_dock_idle();
}

/// Spawn the global Fn hotkey monitor. Call ONCE from `setup()` alongside
/// `stt_engine::spawn`. On non-macOS this is a no-op.
#[cfg(target_os = "macos")]
pub fn start(app: tauri::AppHandle) {
    use core_graphics::event::{
        CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
        EventField,
    };

    // #2158: the pref is now "remap Control while a non-Apple external keyboard
    // is attached", so it is handed to the device watcher rather than straight
    // into the tap atomic. The watcher owns every write to
    // EXTERNAL_LEFT_CONTROL_FN from here on, and re-evaluates on a 2s poll so a
    // keyboard swap re-arms or disarms Control without a Settings visit.
    crate::external_keyboard::set_pref_enabled(crate::stt::keys::config_bool(
        "external_symon_left_control",
        false,
    ));
    crate::external_keyboard::start_watcher();

    // Stash the app handle so the off-tap worker threads can drive the screen
    // dock pill window (show on Fn-down, hide on brush/error). Ignore a second
    // call — `start()` is invoked once from setup().
    let _ = APP_HANDLE.set(app.clone());

    // Trigger the native macOS Accessibility prompt if we don't already have
    // permission. CGEventTapCreate silently succeeds even without Accessibility
    // and Fn would never fire otherwise.
    if crate::mac_perms::accessibility_permission_granted(true) {
        tracing::info!("[fn-hotkey] Accessibility: granted");
    } else {
        tracing::error!(
            "[fn-hotkey] Accessibility NOT granted — the Fn hotkey will not work until you \
             enable o8 in System Settings → Privacy & Security → Accessibility, then relaunch."
        );
    }

    // Input Monitoring (#1537): a ListenOnly keyboard tap needs the SEPARATE
    // kTCCServiceListenEvent grant. Without it the tap installs successfully and
    // receives ZERO events ("Fn does nothing", no error) — and a listen-only tap
    // never triggers the TCC prompt by itself, so a fresh install can never
    // self-heal. IOHIDRequestAccess is the one call that actually presents the
    // prompt; when the user already denied it is a silent no-op returning false.
    if crate::mac_perms::input_monitoring_granted(false) {
        tracing::info!("[fn-hotkey] Input Monitoring: granted");
    } else if crate::mac_perms::input_monitoring_granted(true) {
        tracing::info!("[fn-hotkey] Input Monitoring: granted after prompt");
    } else {
        tracing::error!(
            "[fn-hotkey] Input Monitoring NOT granted — the keyboard tap will receive no \
             events (Fn/Right-Option hotkeys dead) until you enable o8 in System Settings → \
             Privacy & Security → Input Monitoring, then relaunch."
        );
    }

    // macOS Sequoia binds Fn to "Start Dictation" by default; Apple's dictation
    // intercepts the press before our tap can react. Surface it so onboarding
    // can nudge the user to set Fn → Do Nothing.
    match crate::mac_perms::fn_key_usage_type() {
        Some(0) => tracing::info!("[fn-hotkey] Fn key binding: Do Nothing ✓"),
        other => {
            let value = other.unwrap_or(3);
            let label = match value {
                1 => "Change Input Source",
                2 => "Show Emoji & Symbols",
                3 => "Start Dictation",
                _ => "unknown",
            };
            tracing::warn!(
                "[fn-hotkey] Fn key bound to '{label}' (AppleFnUsageType={value}); o8's Fn capture \
                 will be unreliable until you set System Settings → Keyboard → \
                 Press 🌐 key to → Do Nothing."
            );
        }
    }

    // Edge latch shared by the tap callback and the poll fallback. `true` means
    // a dictation is currently active (Fn held).
    let fn_held = Arc::new(AtomicBool::new(false));
    // Fn-down instant, used to reject sub-threshold brushes on release.
    let fn_press_time = Arc::new(Mutex::new(std::time::Instant::now()));
    // Right-Option-down instant, used to reject the sub-120ms agent brush.
    let agent_press_time = Arc::new(Mutex::new(std::time::Instant::now()));
    let left_control_press_time = Arc::new(Mutex::new(std::time::Instant::now()));

    // ── Poll fallback for the dropped Fn-UP edge (Sequoia regression) ──
    // The tap delivers ONE FlagsChanged (Fn-down) then goes silent; the Fn-up
    // transition never reaches the callback. Poll the hardware modifier state
    // every 40ms and run the same teardown when the FN bit drops while a
    // dictation is active. 40ms is imperceptible (a human Fn release is ≥80ms).
    {
        let fn_held_poll = fn_held.clone();
        // kCGEventSourceStateCombinedSessionState = 1.
        const CG_STATE_COMBINED_SESSION: i32 = 1;
        std::thread::spawn(move || {
            let mut was_held = false;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(40));
                let actual_held =
                    unsafe { (CGEventSourceFlagsState(CG_STATE_COMBINED_SESSION) & FN_FLAG) != 0 };

                if was_held && !actual_held {
                    // Long-form ignores Fn release — it ends only on a single tap,
                    // never from the poll. Skip the teardown entirely (otherwise
                    // the Fn-up after the double-tap would end the session).
                    if LONG_FORM_ACTIVE.load(Ordering::SeqCst) {
                        was_held = actual_held;
                        continue;
                    }
                    // Atomic claim against the tap's own Fn-up handler — whichever
                    // path swaps the latch first owns the release; the other skips.
                    if fn_held_poll.swap(false, Ordering::SeqCst) {
                        tracing::info!(
                            "[fn-hotkey] Fn release caught by poll fallback (tap missed up-edge)"
                        );
                        std::thread::spawn(end_system_dictation);
                    }
                }
                was_held = actual_held;
            }
        });
    }

    // ── The CGEventTap thread ──
    let fn_held_cb = fn_held.clone();
    let fn_press_time_cb = fn_press_time.clone();
    let agent_press_time_cb = agent_press_time.clone();
    let left_control_press_time_cb = left_control_press_time.clone();
    std::thread::spawn(move || {
        let tap = CGEventTap::new(
            CGEventTapLocation::HID,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            vec![CGEventType::FlagsChanged, CGEventType::KeyDown],
            move |_proxy, event_type, event| {
                // macOS auto-disables a tap whose callback runs too slowly
                // (kCGEventTapDisabledByTimeout) or in response to certain input
                // (kCGEventTapDisabledByUserInput). Re-enable immediately via the
                // stored mach_port; without this the tap dies after one slow call.
                if matches!(
                    event_type,
                    CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput
                ) {
                    tracing::warn!(
                        "[fn-hotkey] CGEventTap disabled by macOS ({event_type:?}); re-enabling"
                    );
                    if let Some(&port_bits) = FN_TAP_MACH_PORT.get() {
                        unsafe {
                            CGEventTapEnable(port_bits as *mut std::ffi::c_void, true);
                        }
                    }
                    return None;
                }

                // The entire body is wrapped in catch_unwind: a panic here would
                // unwind across the extern "C" tap boundary and ABORT all of o8
                // (killing the Node sidecars). Convert any panic into a logged
                // no-op so the app survives.
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    // KeyDown: the ONLY key we react to is Escape, and only to
                    // CANCEL an active long-form dictation. This is a ListenOnly
                    // tap — we never consume the key (always return None); the
                    // keycode is read purely to detect Escape. The read is gated on
                    // LONG_FORM_ACTIVE so the common case (no long-form) stays the
                    // same cheap early return as before.
                    if matches!(event_type, CGEventType::KeyDown) {
                        // A key pressed while right-⌘ is held is a ⌘-shortcut chord
                        // (⌘C, ⌘V, ⌘Z, …), not a clean double-tap — mark it so the
                        // eventual ⌘-release isn't counted as a voice-toggle brush.
                        if RIGHT_CMD_HELD.load(Ordering::SeqCst) {
                            RIGHT_CMD_CHORDED.store(true, Ordering::SeqCst);
                        }
                        // Option+<key> chords (⌥-arrow word jumps, special characters)
                        // are NOT push-to-talk: any KeyDown while the
                        // Option hold-gesture is recording cancels it. Clearing the
                        // latch here also makes the eventual Option-up CAS fail, so
                        // the release can't end/discard a second time. Long-form
                        // (Option already released) is unaffected — it ends on a
                        // tap or Escape only. ListenOnly: the chord still reaches
                        // the frontmost app untouched.
                        if OPTION_HELD
                            .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok()
                        {
                            std::thread::spawn(discard_agent_dictation);
                        }
                        let control_transition =
                            apply_left_control_transition(cancel_left_control_transition);
                        run_left_control_completion(control_transition.completion);

                        // Escape cancels an active long-form dictation (Fn or
                        // agent) AND stops active TTS playback. The atomic loads
                        // are cheap, so the common case (none active) stays the
                        // same early return; the keycode is only read when one is
                        // live.
                        let long_form = LONG_FORM_ACTIVE.load(Ordering::SeqCst);
                        let agent_long_form = AGENT_LONG_FORM_ACTIVE.load(Ordering::SeqCst);
                        let tts_active = crate::tts::playback::is_active();
                        // A running agent task that isn't (yet) speaking still
                        // needs Escape to stop it — else it grinds on and talks
                        // over the user when it finishes.
                        let agent_task = crate::agent::any_task_running();
                        if long_form || agent_long_form || tts_active || agent_task {
                            let keycode =
                                event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                            if keycode == ESCAPE_KEYCODE {
                                if long_form {
                                    // Clear the toggle synchronously; discard off-tap.
                                    LONG_FORM_ACTIVE.store(false, Ordering::SeqCst);
                                    std::thread::spawn(cancel_long_form_dictation);
                                }
                                if agent_long_form {
                                    AGENT_LONG_FORM_ACTIVE.store(false, Ordering::SeqCst);
                                    std::thread::spawn(discard_agent_dictation);
                                }
                                if agent_task {
                                    std::thread::spawn(|| {
                                        crate::agent::cancel_all_tasks();
                                    });
                                }
                                if tts_active {
                                    std::thread::spawn(crate::tts::playback::stop);
                                }
                            }
                        }
                        return None;
                    }

                    let flags = event.get_flags().bits();
                    if let Some(app) = APP_HANDLE.get() {
                        crate::managed_voice_window::caps_lock_changed(app,
                            event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE), flags);
                    }
                    let fn_is_down = (flags & FN_FLAG) != 0;
                    let smart_compose = (flags & CONTROL_FLAG) != 0;

                    // TEMP #1534 gesture debug — every Fn-relevant FlagsChanged,
                    // raw. log:: so it reaches the log file in any build.
                    if fn_is_down || fn_held_cb.load(Ordering::SeqCst) {
                        log::info!(
                            "[fn-edge] FlagsChanged fn={fn_is_down} raw_flags={flags:#x} latch={}",
                            fn_held_cb.load(Ordering::SeqCst)
                        );
                    }

                    // Edge-latch with compare-exchange so duplicate FlagsChanged
                    // events (macOS delivers them 2-3x on some keyboards) don't
                    // double-fire start/stop.
                    let down_edge = fn_is_down
                        && fn_held_cb
                            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok();
                    let up_edge = !fn_is_down
                        && fn_held_cb
                            .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok();

                    if down_edge {
                        // Offload ALL work — the tap callback must return in
                        // microseconds or macOS drops subsequent input events.
                        if let Ok(mut t) = fn_press_time_cb.lock() {
                            *t = std::time::Instant::now();
                        }
                        // Ordered branches (the ORDER is load-bearing):
                        //   (a) a single tap while long-form is active FINISHES it,
                        //   (b) two quick taps START long-form (double-tap),
                        //   (c) otherwise a normal push-to-talk hold.
                        let long_form_active = LONG_FORM_ACTIVE.load(Ordering::SeqCst);
                        let long_form_session_id = LONG_FORM_SESSION_ID.load(Ordering::SeqCst);
                        let finishing_long_form = long_form_active && long_form_session_id != 0;
                        let double_tap = !finishing_long_form
                            && !smart_compose
                            && consume_double_tap_brush();
                        match classify_system_dictation_press(
                            long_form_active,
                            long_form_session_id,
                            smart_compose,
                            double_tap,
                        ) {
                            SystemDictationPressAction::FinishLongForm => {
                                // Clear toggle + edge latch synchronously so this tap's
                                // impending Fn-up CAS fails (no brush/end) and the poll
                                // skips. The recognizer stop + paste run off-tap.
                                log::info!("[fn-edge] down → finish long-form");
                                LONG_FORM_ACTIVE.store(false, Ordering::SeqCst);
                                fn_held_cb.store(false, Ordering::SeqCst);
                                std::thread::spawn(finish_long_form_dictation);
                            }
                            SystemDictationPressAction::BeginSmartCompose => {
                                log::info!(
                                    "[fn-edge] down → begin Smart Compose dictation (Control+Fn)"
                                );
                                std::thread::spawn(|| begin_system_dictation(true));
                            }
                            SystemDictationPressAction::BeginLongForm => {
                                // Promote to long-form. Set the toggle + clear the edge
                                // latch synchronously so THIS tap's Fn-up no-ops.
                                log::info!("[fn-edge] down → double-tap promote to long-form");
                                LONG_FORM_ACTIVE.store(true, Ordering::SeqCst);
                                fn_held_cb.store(false, Ordering::SeqCst);
                                std::thread::spawn(begin_long_form_dictation);
                            }
                            SystemDictationPressAction::BeginPushToTalk => {
                                log::info!(
                                    "[fn-edge] down → begin system dictation (push-to-talk)"
                                );
                                std::thread::spawn(|| begin_system_dictation(false));
                            }
                        }
                    } else if up_edge {
                        // Fn release during long-form is a NO-OP — long-form ends
                        // only on a single tap (down-edge above), never on release.
                        // (begin_long_form already cleared fn_held, so this CAS
                        // usually won't even fire mid-long-form; guard anyway.)
                        if !LONG_FORM_ACTIVE.load(Ordering::SeqCst) {
                            let press_time = fn_press_time_cb
                                .lock()
                                .map(|t| *t)
                                .unwrap_or_else(|_| std::time::Instant::now());
                            let hold = std::time::Instant::now().duration_since(press_time);
                            if hold < std::time::Duration::from_millis(FN_TAP_PRIMER_MAX_MS) {
                                // Sub-threshold brush — tear down silently, no paste,
                                // and STAMP the brush so a quick second tap is read
                                // as a double-tap (long-form start).
                                log::info!(
                                    "[fn-edge] up after {}ms → BRUSH (< {FN_TAP_PRIMER_MAX_MS}ms) — discard + prime double-tap",
                                    hold.as_millis()
                                );
                                if !SMART_COMPOSE_MODE.load(Ordering::SeqCst) {
                                    if let Ok(mut g) = LAST_FN_BRUSH.lock() {
                                        *g = Some(std::time::Instant::now());
                                    }
                                }
                                std::thread::spawn(discard_brush);
                            } else {
                                log::info!(
                                    "[fn-edge] up after {}ms → end system dictation (finalize+paste)",
                                    hold.as_millis()
                                );
                                std::thread::spawn(end_system_dictation);
                            }
                        }
                    }

                    // ── Option → Symon voice AGENT (RIGHT Option ONLY) ──
                    // RIGHT Option (keycode 61), held alone, drives the agent
                    // gesture. LEFT Option (58) must NOT trigger the agent — so
                    // the edge-latch is keyed on the RIGHT-Option device bit, not
                    // the side-agnostic OPTION_FLAG. We still update
                    // OPTION_PHYSICALLY_DOWN for EITHER key, because
                    // wait_for_option_release needs the physical-finger truth
                    // regardless of side.
                    //
                    // Gestures (ORDER of branches is load-bearing, mirror of Fn):
                    //   (a) single tap while long-form is active FINISHES it,
                    //   (b) two quick brushes START long-form (double-tap → open
                    //       mic for a long question, Escape cancels),
                    //   (c) otherwise hold-to-talk: release ≥120ms runs the
                    //       command through the agent loop; a shorter brush is
                    //       discarded and stamped for double-tap detection.
                    {
                        let keycode =
                            event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                        if keycode == LEFT_OPTION_KEYCODE || keycode == RIGHT_OPTION_KEYCODE {
                            // Physical-key truth for EITHER Option key: the
                            // synthetic Cmd+C selection grab must wait until the
                            // user's finger leaves Option, or the held modifier
                            // merges into the synthetic event (⌥C — no copy).
                            // Side-agnostic OPTION_FLAG.
                            OPTION_PHYSICALLY_DOWN
                                .store((flags & OPTION_FLAG) != 0, Ordering::SeqCst);
                        }
                        // The agent gesture is RIGHT-Option-only. Key the edge
                        // latch on the right-Option device bit so a held LEFT
                        // Option never reads as "option_down" here.
                        if keycode == RIGHT_OPTION_KEYCODE {
                            let option_down = (flags & RIGHT_OPTION_DEVICE_FLAG) != 0;
                            let opt_down_edge = option_down
                                && OPTION_HELD
                                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                                    .is_ok();
                            let opt_up_edge = !option_down
                                && OPTION_HELD
                                    .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
                                    .is_ok();
                            if opt_down_edge {
                                if AGENT_LONG_FORM_ACTIVE.load(Ordering::SeqCst)
                                    && AGENT_SESSION_ID.load(Ordering::SeqCst) != 0
                                {
                                    // Single tap finishes long-form. Clear the toggle
                                    // + edge latch synchronously so this press's
                                    // Option-up CAS fails (no brush/end double-fire).
                                    AGENT_LONG_FORM_ACTIVE.store(false, Ordering::SeqCst);
                                    OPTION_HELD.store(false, Ordering::SeqCst);
                                    std::thread::spawn(end_agent_dictation);
                                } else if consume_option_double_tap_brush() {
                                    // Promote to long-form agent. Set the toggle +
                                    // clear the edge latch so THIS tap's up no-ops.
                                    AGENT_LONG_FORM_ACTIVE.store(true, Ordering::SeqCst);
                                    OPTION_HELD.store(false, Ordering::SeqCst);
                                    std::thread::spawn(begin_agent_dictation);
                                } else {
                                    if let Ok(mut t) = agent_press_time_cb.lock() {
                                        *t = std::time::Instant::now();
                                    }
                                    std::thread::spawn(begin_agent_dictation);
                                }
                            } else if opt_up_edge {
                                // Option release during long-form never fires here —
                                // the promotion cleared OPTION_HELD, so the CAS fails.
                                let press = agent_press_time_cb
                                    .lock()
                                    .map(|t| *t)
                                    .unwrap_or_else(|_| std::time::Instant::now());
                                let hold = std::time::Instant::now().duration_since(press);
                                if hold < std::time::Duration::from_millis(ASK_BRUSH_MS) {
                                    // Sub-threshold brush — discard, and STAMP it so a
                                    // quick second tap reads as a double-tap.
                                    if let Ok(mut g) = LAST_OPTION_BRUSH.lock() {
                                        *g = Some(std::time::Instant::now());
                                    }
                                    std::thread::spawn(discard_agent_dictation);
                                } else {
                                    std::thread::spawn(end_agent_dictation);
                                }
                            }
                        }
                    }

                    // ── Bottom-left Control → external-keyboard Fn substitute ──
                    // Mirrors Fn: hold dictates polished text; double-tap starts
                    // long-form dictation; a tap finishes long-form. The 80ms
                    // pending state lets ordinary Control chords cancel before the
                    // microphone opens, while the tap remains ListenOnly.
                    {
                        let keycode =
                            event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                        if keycode == LEFT_CONTROL_KEYCODE
                            && EXTERNAL_LEFT_CONTROL_FN.load(Ordering::SeqCst)
                        {
                            let control_down = is_left_control_fn_event(true, keycode, flags);
                            let control_down_edge = control_down
                                && LEFT_CONTROL_STATE
                                    .compare_exchange(
                                        LEFT_CONTROL_IDLE,
                                        LEFT_CONTROL_PENDING,
                                        Ordering::SeqCst,
                                        Ordering::SeqCst,
                                    )
                                    .is_ok();
                            if control_down_edge {
                                if let Ok(mut t) = left_control_press_time_cb.lock() {
                                    *t = std::time::Instant::now();
                                }
                                let long_form_active = LONG_FORM_ACTIVE.load(Ordering::SeqCst);
                                let long_form_session_id =
                                    LONG_FORM_SESSION_ID.load(Ordering::SeqCst);
                                let double_tap = !(long_form_active && long_form_session_id != 0)
                                    && consume_double_tap_brush();
                                match classify_system_dictation_press(
                                    long_form_active,
                                    long_form_session_id,
                                    false,
                                    double_tap,
                                ) {
                                    SystemDictationPressAction::FinishLongForm => {
                                        LEFT_CONTROL_STATE
                                            .store(LEFT_CONTROL_FINISH_LONG_FORM, Ordering::SeqCst);
                                    }
                                    SystemDictationPressAction::BeginLongForm => {
                                        LEFT_CONTROL_STATE
                                            .store(LEFT_CONTROL_BEGIN_LONG_FORM, Ordering::SeqCst);
                                    }
                                    SystemDictationPressAction::BeginPushToTalk => {
                                        std::thread::spawn(|| {
                                            std::thread::sleep(std::time::Duration::from_millis(
                                                LEFT_CONTROL_CAPTURE_DELAY_MS,
                                            ));
                                            if LEFT_CONTROL_STATE
                                                .compare_exchange(
                                                    LEFT_CONTROL_PENDING,
                                                    LEFT_CONTROL_STARTING,
                                                    Ordering::SeqCst,
                                                    Ordering::SeqCst,
                                                )
                                                .is_ok()
                                            {
                                                begin_system_dictation(false);
                                                let transition = apply_left_control_transition(
                                                    started_left_control_transition,
                                                );
                                                run_left_control_completion(transition.completion);
                                            }
                                        });
                                    }
                                    SystemDictationPressAction::BeginSmartCompose => {}
                                }
                            }

                            if !control_down {
                                let press = left_control_press_time_cb
                                    .lock()
                                    .map(|t| *t)
                                    .unwrap_or_else(|_| std::time::Instant::now());
                                let hold = std::time::Instant::now().duration_since(press);
                                let short =
                                    hold < std::time::Duration::from_millis(FN_TAP_PRIMER_MAX_MS);
                                let transition = apply_left_control_transition(|state| {
                                    release_left_control_transition(state, short)
                                });
                                if transition.stamp_brush {
                                    if let Ok(mut g) = LAST_FN_BRUSH.lock() {
                                        *g = Some(std::time::Instant::now());
                                    }
                                }
                                run_left_control_completion(transition.completion);
                            }
                        }
                    }

                    // ── Right Command (double-tap) → voice-to-voice toggle ──
                    // Right ⌘ is unused by o8's Fn/Option gestures, so a clean
                    // DOUBLE-TAP flips realtime voice mode on/off (the dashboard's
                    // RealtimeVoiceHost listens for `o8:realtime-toggle`). Guards: a
                    // hold ≥CMD_BRUSH_MS (held modifier) or a ⌘-shortcut chord (a key
                    // pressed while ⌘ is down) is NOT a brush — so ⌘C/⌘V and held
                    // shortcuts never toggle. Left ⌘ (keycode 55) is ignored entirely.
                    {
                        let keycode =
                            event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                        if keycode == RIGHT_COMMAND_KEYCODE {
                            let cmd_down = (flags & COMMAND_FLAG) != 0;
                            let cmd_down_edge = cmd_down
                                && RIGHT_CMD_HELD
                                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                                    .is_ok();
                            let cmd_up_edge = !cmd_down
                                && RIGHT_CMD_HELD
                                    .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
                                    .is_ok();
                            if cmd_down_edge {
                                RIGHT_CMD_CHORDED.store(false, Ordering::SeqCst);
                                if let Ok(mut t) = RIGHT_CMD_PRESS_TIME.lock() {
                                    *t = Some(std::time::Instant::now());
                                }
                            } else if cmd_up_edge {
                                let press = RIGHT_CMD_PRESS_TIME
                                    .lock()
                                    .ok()
                                    .and_then(|t| *t)
                                    .unwrap_or_else(std::time::Instant::now);
                                let hold = std::time::Instant::now().duration_since(press);
                                let chorded = RIGHT_CMD_CHORDED.load(Ordering::SeqCst);
                                if !chorded
                                    && hold < std::time::Duration::from_millis(CMD_BRUSH_MS)
                                {
                                    if consume_right_cmd_double_tap() {
                                        // Double-tap → toggle realtime voice mode.
                                        // Off-tap: the callback must return fast.
                                        std::thread::spawn(|| {
                                            if let Some(app) = APP_HANDLE.get() {
                                                let _ = app.emit(
                                                    "o8:realtime-toggle",
                                                    serde_json::json!({ "origin": "double-tap-right-cmd" }),
                                                );
                                            }
                                        });
                                    } else if let Ok(mut g) = LAST_RIGHT_CMD_BRUSH.lock() {
                                        // First clean brush — stamp it; a second
                                        // within the window completes the double-tap.
                                        *g = Some(std::time::Instant::now());
                                    }
                                }
                            }
                        }
                    }

                    None // never modify the event
                }));

                match result {
                    Ok(val) => val,
                    Err(e) => {
                        let msg = e
                            .downcast_ref::<String>()
                            .map(|s| s.as_str())
                            .or_else(|| e.downcast_ref::<&str>().copied())
                            .unwrap_or("unknown panic");
                        tracing::error!("[fn-hotkey] CGEvent tap PANIC: {msg}");
                        None
                    }
                }
            },
        );

        match tap {
            Ok(tap) => {
                use core_foundation::base::TCFType;
                // Stash the mach_port pointer bits so the callback can re-enable
                // the tap. Raw bits because *mut isn't Send.
                let _ = FN_TAP_MACH_PORT.set(tap.mach_port.as_concrete_TypeRef() as usize);
                tracing::info!("[fn-hotkey] CGEventTap (HID) created — entering runloop");
                unsafe {
                    let loop_source = tap
                        .mach_port
                        .create_runloop_source(0)
                        .expect("[fn-hotkey] failed to create run loop source");
                    core_foundation::runloop::CFRunLoop::get_current().add_source(
                        &loop_source,
                        core_foundation::runloop::kCFRunLoopCommonModes,
                    );
                    tap.enable();
                    core_foundation::runloop::CFRunLoop::run_current();
                }
            }
            Err(e) => {
                tracing::error!("[fn-hotkey] failed to create CGEvent tap for Fn key: {e:?}");
                tracing::error!(
                    "[fn-hotkey] grant Accessibility + Input Monitoring: System Settings → \
                     Privacy & Security"
                );
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn start(_app: tauri::AppHandle) {}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{
        cancel_left_control_transition, classify_system_dictation_press, is_left_control_fn_event,
        release_left_control_transition, resolve_system_dictation_session_id,
        started_left_control_transition, LeftControlCompletionAction, SystemDictationPressAction,
        LEFT_CONTROL_BEGIN_LONG_FORM, LEFT_CONTROL_CANCEL_AFTER_START, LEFT_CONTROL_CAPTURING,
        LEFT_CONTROL_DEVICE_FLAG, LEFT_CONTROL_FINISH_AFTER_START, LEFT_CONTROL_FINISH_LONG_FORM,
        LEFT_CONTROL_IDLE, LEFT_CONTROL_KEYCODE, LEFT_CONTROL_PENDING, LEFT_CONTROL_STARTING,
    };

    #[test]
    fn system_finish_uses_recorded_session_when_it_matches_active() {
        assert_eq!(resolve_system_dictation_session_id(12, 12, true), 12);
    }

    #[test]
    fn system_finish_falls_back_to_active_session_when_ptt_bookkeeping_is_stale() {
        assert_eq!(resolve_system_dictation_session_id(0, 44, true), 44);
        assert_eq!(resolve_system_dictation_session_id(12, 44, true), 44);
    }

    #[test]
    fn system_finish_refuses_when_origin_or_active_session_is_missing() {
        assert_eq!(resolve_system_dictation_session_id(12, 12, false), 0);
        assert_eq!(resolve_system_dictation_session_id(12, 0, true), 0);
    }

    #[test]
    fn external_fn_substitute_requires_enabled_left_control_down() {
        assert!(is_left_control_fn_event(
            true,
            LEFT_CONTROL_KEYCODE,
            LEFT_CONTROL_DEVICE_FLAG,
        ));
        assert!(!is_left_control_fn_event(
            false,
            LEFT_CONTROL_KEYCODE,
            LEFT_CONTROL_DEVICE_FLAG,
        ));
        assert!(!is_left_control_fn_event(
            true,
            62,
            LEFT_CONTROL_DEVICE_FLAG,
        ));
        assert!(!is_left_control_fn_event(true, LEFT_CONTROL_KEYCODE, 0));
    }

    #[test]
    fn external_fn_substitute_uses_the_system_dictation_gesture_map() {
        assert_eq!(
            classify_system_dictation_press(false, 0, false, false),
            SystemDictationPressAction::BeginPushToTalk,
        );
        assert_eq!(
            classify_system_dictation_press(false, 0, false, true),
            SystemDictationPressAction::BeginLongForm,
        );
        assert_eq!(
            classify_system_dictation_press(true, 42, false, false),
            SystemDictationPressAction::FinishLongForm,
        );
    }

    #[test]
    fn external_fn_chord_cancels_a_pending_long_form_finish() {
        let transition = cancel_left_control_transition(LEFT_CONTROL_FINISH_LONG_FORM);
        assert_eq!(transition.next, LEFT_CONTROL_IDLE);
        assert_eq!(transition.completion, LeftControlCompletionAction::None);

        let pending = cancel_left_control_transition(LEFT_CONTROL_PENDING);
        assert_eq!(pending.next, LEFT_CONTROL_IDLE);
        assert_eq!(pending.completion, LeftControlCompletionAction::None);

        let pending_start = cancel_left_control_transition(LEFT_CONTROL_BEGIN_LONG_FORM);
        assert_eq!(pending_start.next, LEFT_CONTROL_IDLE);
        assert_eq!(pending_start.completion, LeftControlCompletionAction::None);
    }

    #[test]
    fn external_fn_double_tap_starts_long_form_only_after_clean_release() {
        let release = release_left_control_transition(LEFT_CONTROL_BEGIN_LONG_FORM, true);
        assert_eq!(release.next, LEFT_CONTROL_IDLE);
        assert_eq!(release.completion, LeftControlCompletionAction::BeginLongForm);
    }

    #[test]
    fn external_fn_short_release_waits_for_start_then_discards_that_session() {
        let release = release_left_control_transition(LEFT_CONTROL_STARTING, true);
        assert_eq!(release.next, LEFT_CONTROL_CANCEL_AFTER_START);
        assert!(release.stamp_brush);

        let started = started_left_control_transition(release.next);
        assert_eq!(started.next, LEFT_CONTROL_IDLE);
        assert_eq!(started.completion, LeftControlCompletionAction::Discard);
    }

    #[test]
    fn external_fn_long_release_waits_for_start_then_finishes_that_session() {
        let release = release_left_control_transition(LEFT_CONTROL_STARTING, false);
        assert_eq!(release.next, LEFT_CONTROL_FINISH_AFTER_START);

        let started = started_left_control_transition(release.next);
        assert_eq!(started.next, LEFT_CONTROL_IDLE);
        assert_eq!(started.completion, LeftControlCompletionAction::End);

        let active = release_left_control_transition(LEFT_CONTROL_CAPTURING, false);
        assert_eq!(active.next, LEFT_CONTROL_IDLE);
        assert_eq!(active.completion, LeftControlCompletionAction::End);
    }
}
