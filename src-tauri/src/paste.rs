//! Clipboard + simulated paste for o8.
//!
//! This code originated in the aqua/Symon application, which o8's operator
//! acquired and owns outright. It captures the frontmost app before dictation
//! starts, then reactivates it and pastes on Fn release.

// Several helpers (read_selected_text_via_accessibility, simulate_cmd_c,
// read_clipboard_text, activate_frontmost_app, …) remain from the acquired
// aqua/Symon implementation but are not all wired into a caller in P0-P2. Keep
// them so the module's public API remains intact; allow dead_code rather than
// deleting it.
#![allow(dead_code)]

use std::process::Command;
use std::sync::Mutex;

/// o8's own bundle ID — used to exclude ourselves from "current frontmost" checks.
const O8_BUNDLE_ID: &str = "ai.o8.desktop";
// Focus settle (only applied when activation actually shifted focus — a cold
// app switch). A fixed sleep is wrong on both ends of the hardware range: the
// old 35ms was tuned on Apple Silicon and loses on Intel cold activation (the
// synthetic Cmd+V posts before the target owns key focus and vanishes,
// #1534); a fixed larger value would tax fast machines on every shifted
// paste. Instead poll the frontmost app until it reports the paste target
// (or the cap expires), then give the window server one short grace period
// to hand over key focus. Fast machines exit after one poll (~35ms total —
// parity with the old constant); slow Intel gets up to FOCUS_SETTLE_MAX_MS.
const FOCUS_SETTLE_POLL_MS: u64 = 10;
const FOCUS_SETTLE_MAX_MS: u64 = 250;
const FOCUS_SETTLE_GRACE_MS: u64 = 25;
const COMMAND_KEY_GAP_MS: u64 = 12;

/// Check if a bundle ID looks like o8 (or is invalid/garbage from the dev binary).
/// In dev mode, the raw `target/debug/o8` binary isn't a proper .app bundle so
/// System Events returns "missing value" for its bundle identifier. Any ID that
/// matches o8's real bundle ID or doesn't look like a valid reverse-DNS bundle
/// ID (no dot) is treated as "this is o8".
fn is_o8_or_invalid(bid: &str) -> bool {
    bid == O8_BUNDLE_ID || bid == "missing value" || bid.is_empty() || !bid.contains('.')
}

/// Stores the bundle ID and window info of the app active before dictation.
static PREVIOUS_APP: Mutex<Option<SavedApp>> = Mutex::new(None);

#[derive(Clone, Debug)]
struct SavedApp {
    bundle_id: String,
    process_id: i32,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug)]
struct FrontmostAppInfo {
    bundle_id: String,
    process_id: i32,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ActivationOutcome {
    FocusShifted,
    FocusUnchanged,
}

#[cfg(target_os = "macos")]
impl ActivationOutcome {
    fn needs_focus_settle(self) -> bool {
        matches!(self, Self::FocusShifted)
    }
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug)]
pub(crate) struct ClipboardSnapshot {
    pub(crate) text: Option<String>,
    pub(crate) change_count: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PasteOutcome {
    Pasted,
    ClipboardOnly,
    Failed(String),
}

impl PasteOutcome {
    pub fn did_paste(&self) -> bool {
        matches!(self, Self::Pasted)
    }
}

/// Cross-paste clipboard guard. Without this, a burst of dictation pastes
/// destroys the user's clipboard: each paste snapshots the clipboard at its
/// start, so paste N captures paste N-1's *Symon output* as "the user's
/// clipboard" — the real original is overwritten on the first paste and is
/// never recoverable. We instead remember the user's true clipboard and the
/// changeCount of our own last write, so we can tell "this is Symon's own
/// output" apart from "the user copied something" and only ever restore the
/// real original.
#[cfg(target_os = "macos")]
struct ClipboardGuard {
    user: Option<ClipboardSnapshot>,
    last_injected: i64,
}

#[cfg(target_os = "macos")]
static CLIPBOARD_GUARD: Mutex<ClipboardGuard> = Mutex::new(ClipboardGuard {
    user: None,
    last_injected: -1,
});

/// How long Symon's pasted text stays on the clipboard before we hand it back
/// to the user, for the synthetic-Cmd+V path. Long enough for normal fields +
/// webviews to consume the paste; short enough that the user's clipboard is
/// theirs again almost immediately (the old 5000ms made copy/paste unusable
/// while dictating). The poisoning fix above guarantees the real original is
/// the thing restored, so the worst case here is a rare slow app needing a
/// re-dictate — never a lost clipboard.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const CLIPBOARD_RESTORE_DELAY_MS: u64 = 700;

/// Intel story (#1534): on x86_64 Macs EVERY target app is a "slow app" — the
/// history comment above already concedes slow apps read the pasteboard
/// 400–1500ms after the synthetic Cmd+V, and 700ms let the restore thread
/// swap the user's old clipboard back UNDERNEATH an in-flight paste (stale
/// content or nothing lands). 1800ms keeps margin over the observed 1500ms
/// tail while still returning the clipboard promptly. Apple Silicon keeps
/// 700ms — do not flatten these into one constant.
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const CLIPBOARD_RESTORE_DELAY_MS: u64 = 1800;

/// Restore delay for the Accessibility-not-granted path: there is no synthetic
/// paste, so the user must press ⌘V themselves — keep the text on the clipboard
/// long enough for that manual paste.
#[cfg(target_os = "macos")]
const MANUAL_PASTE_RESTORE_MS: u64 = 5000;

/// Serializes ALL NSPasteboard access. paste_text (called from the dictation
/// finalize thread, agent edit threads, and a spawned ⌥-V thread), every
/// spawned restore thread (one per paste, all waking ~700ms later), and
/// grab_selection's Cmd+C poll otherwise hammer the general pasteboard from
/// multiple threads at once. NSPasteboard is NOT thread-safe — that concurrent
/// access wedges the macOS `pboard` server, which is the "I can't copy at all
/// (needs killall pboard)" hang. Every leaf pasteboard op takes this lock, so
/// o8 never touches the pasteboard from two threads simultaneously.
#[cfg(target_os = "macos")]
static PASTEBOARD_LOCK: Mutex<()> = Mutex::new(());

/// Take the pasteboard lock, recovering (not panicking) if a prior holder
/// panicked — a poisoned lock must never permanently break copy/paste.
#[cfg(target_os = "macos")]
fn pb_guard() -> std::sync::MutexGuard<'static, ()> {
    PASTEBOARD_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(target_os = "macos")]
type AXUIElementRef = core_foundation::base::CFTypeRef;

#[cfg(target_os = "macos")]
const AX_ERROR_SUCCESS: i32 = 0;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCreateApplication(pid: libc::pid_t) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: core_foundation::string::CFStringRef,
        value: *mut core_foundation::base::CFTypeRef,
    ) -> i32;
    fn AXUIElementPerformAction(
        element: AXUIElementRef,
        action: core_foundation::string::CFStringRef,
    ) -> i32;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout_in_seconds: f32) -> i32;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: core_foundation::string::CFStringRef,
        value: core_foundation::base::CFTypeRef,
    ) -> i32;
    // `Boolean` is an unsigned char in MacTypes.
    fn AXUIElementIsAttributeSettable(
        element: AXUIElementRef,
        attribute: core_foundation::string::CFStringRef,
        settable: *mut u8,
    ) -> i32;
    // Unwrap an AXValueRef (CGPoint / CGSize) into a plain C struct. Returns
    // false (0) if the value isn't the requested type.
    fn AXValueGetValue(
        value: core_foundation::base::CFTypeRef,
        the_type: u32,
        value_ptr: *mut std::ffi::c_void,
    ) -> u8;
}

// AXValueType discriminants (AXValueConstants.h): CGPoint = 1, CGSize = 2.
#[cfg(target_os = "macos")]
const K_AX_VALUE_TYPE_CGPOINT: u32 = 1;
#[cfg(target_os = "macos")]
const K_AX_VALUE_TYPE_CGSIZE: u32 = 2;

#[cfg(target_os = "macos")]
#[repr(C)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct CGSize {
    width: f64,
    height: f64,
}

// ─── Main-thread dispatch for AX / NSRunningApplication calls ────────────────
// macOS 15.7+ enforces main-thread-only on NSWMWindowCoordinator, which both
// AXUIElementPerformAction(AXRaise) and NSRunningApplication.activate route
// through. Calling either from the STT-event background thread produces a
// SIGILL with "Must only be used from the main thread" (confirmed in Sydney's
// v0.1.4 crash report). Earlier macOS versions were lenient, so the bug was
// invisible on our dev machines until one user hit a newer build.
//
// We trampoline through libdispatch's main queue. dispatch_sync is safe to
// call from any non-main thread; we guard against the main-thread case to
// avoid deadlocking the run loop against itself.
#[cfg(target_os = "macos")]
extern "C" {
    // `dispatch_get_main_queue()` is an inline helper in modern SDK headers —
    // it doesn't exist as a linkable symbol. The real main queue is the
    // `_dispatch_main_q` global exported by libdispatch (libSystem).
    static _dispatch_main_q: std::ffi::c_void;
    fn dispatch_sync_f(
        queue: *mut std::ffi::c_void,
        context: *mut std::ffi::c_void,
        work: extern "C" fn(*mut std::ffi::c_void),
    );
    fn pthread_main_np() -> libc::c_int;
}

#[cfg(target_os = "macos")]
#[inline]
fn dispatch_main_queue() -> *mut std::ffi::c_void {
    unsafe { &_dispatch_main_q as *const _ as *mut _ }
}

#[cfg(target_os = "macos")]
fn run_on_main_thread<F, R>(work: F) -> R
where
    F: FnOnce() -> R,
    R: Default,
{
    // Fast path: already on main thread. No dispatch_sync — would deadlock.
    if unsafe { pthread_main_np() } != 0 {
        return work();
    }

    struct Ctx<F, R> {
        work: Option<F>,
        result: Option<R>,
    }

    extern "C" fn trampoline<F, R>(ctx_ptr: *mut std::ffi::c_void)
    where
        F: FnOnce() -> R,
    {
        // Safety: ctx_ptr is a valid &mut Ctx<F, R> from the dispatch_sync
        // call site; dispatch_sync blocks the caller until we return, so the
        // reference outlives the trampoline.
        let ctx = unsafe { &mut *(ctx_ptr as *mut Ctx<F, R>) };
        if let Some(f) = ctx.work.take() {
            ctx.result = Some(f());
        }
    }

    let mut ctx = Ctx::<F, R> {
        work: Some(work),
        result: None,
    };
    unsafe {
        dispatch_sync_f(
            dispatch_main_queue(),
            &mut ctx as *mut Ctx<F, R> as *mut _,
            trampoline::<F, R>,
        );
    }
    ctx.result.unwrap_or_default()
}

#[cfg(target_os = "macos")]
struct OwnedAxElement(AXUIElementRef);

#[cfg(target_os = "macos")]
impl OwnedAxElement {
    fn new(ptr: AXUIElementRef) -> Option<Self> {
        if ptr.is_null() {
            None
        } else {
            Some(Self(ptr))
        }
    }

    fn as_ptr(&self) -> AXUIElementRef {
        self.0
    }
}

#[cfg(target_os = "macos")]
impl Drop for OwnedAxElement {
    fn drop(&mut self) {
        unsafe {
            core_foundation::base::CFRelease(self.0);
        }
    }
}

#[cfg(target_os = "macos")]
fn ax_name(name: &'static str) -> core_foundation::string::CFString {
    core_foundation::string::CFString::from_static_string(name)
}

/// Get the bundle ID of the saved frontmost app, if available.
pub fn get_frontmost_bundle_id() -> Option<String> {
    PREVIOUS_APP
        .lock()
        .ok()?
        .as_ref()
        .map(|app| app.bundle_id.clone())
}

/// Query the CURRENT frontmost app's bundle ID right now (not the saved one).
/// Used at paste time to detect if the user clicked a different app during dictation.
#[cfg(target_os = "macos")]
fn get_current_frontmost_bundle_id() -> Option<String> {
    native_frontmost_app_info().map(|app| app.bundle_id)
}

/// Whether o8 ITSELF is the current frontmost app. Ctrl+Shift+S speak-selection uses this
/// to read o8's own webview selection (`window.getSelection()` via the frontend)
/// instead of the AX/Cmd+C path — a WKWebView does NOT expose web-content
/// selections through `AXSelectedText`, and the synthetic Cmd+C doesn't reliably
/// copy them either.
#[cfg(target_os = "macos")]
pub(crate) fn frontmost_is_o8() -> bool {
    native_frontmost_app_info()
        .map(|app| app.bundle_id == O8_BUNDLE_ID)
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
pub(crate) fn frontmost_is_o8() -> bool {
    crate::linux_ptt::o8_window_focused()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) fn frontmost_is_o8() -> bool {
    false
}

/// Save the currently focused app and its focused window (call BEFORE showing the pill).
/// Uses NSWorkspace to get the frontmost app — works correctly across multiple displays.
#[cfg(target_os = "macos")]
pub fn save_frontmost_app() {
    if let Some(app) = native_frontmost_app_info() {
        if is_o8_or_invalid(&app.bundle_id) {
            tracing::debug!(
                "paste: frontmost app is o8 ({}) — preserving previous paste target",
                app.bundle_id
            );
            return;
        }

        tracing::debug!(
            "paste: saved frontmost app: {} (pid={})",
            app.bundle_id,
            app.process_id
        );
        if let Ok(mut prev) = PREVIOUS_APP.lock() {
            *prev = Some(SavedApp {
                bundle_id: app.bundle_id,
                process_id: app.process_id,
            });
        }
    } else {
        tracing::warn!("paste: could not determine frontmost app");
    }
}

#[cfg(target_os = "macos")]
fn native_frontmost_app_info() -> Option<FrontmostAppInfo> {
    use objc2_app_kit::NSWorkspace;

    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    let bundle_id = app.bundleIdentifier()?;
    let process_id = app.processIdentifier();
    let bid = bundle_id.to_string();
    if bid.is_empty() || process_id <= 0 {
        None
    } else {
        Some(FrontmostAppInfo {
            bundle_id: bid,
            process_id,
        })
    }
}

#[cfg(target_os = "macos")]
fn ax_copy_attribute_value(
    element: AXUIElementRef,
    attribute: core_foundation::string::CFStringRef,
) -> Option<core_foundation::base::CFType> {
    use core_foundation::base::{CFType, TCFType};

    let mut value = std::ptr::null();
    let result = unsafe { AXUIElementCopyAttributeValue(element, attribute, &mut value) };
    if result != AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }
    Some(unsafe { CFType::wrap_under_create_rule(value) })
}

#[cfg(target_os = "macos")]
fn native_raise_front_window(process_id: i32) -> bool {
    // AXUIElementPerformAction(AXRaise) routes through NSWMWindowCoordinator
    // which macOS 15.7+ refuses to run off the main thread (SIGILL). Hop over.
    run_on_main_thread(move || {
        use core_foundation::base::TCFType;

        let Some(app) = OwnedAxElement::new(unsafe { AXUIElementCreateApplication(process_id) })
        else {
            return false;
        };
        unsafe {
            let _ = AXUIElementSetMessagingTimeout(app.as_ptr(), 0.2);
        }
        let focused_window_attr = ax_name("AXFocusedWindow");
        let main_window_attr = ax_name("AXMainWindow");
        let window =
            ax_copy_attribute_value(app.as_ptr(), focused_window_attr.as_concrete_TypeRef())
                .or_else(|| {
                    ax_copy_attribute_value(app.as_ptr(), main_window_attr.as_concrete_TypeRef())
                });
        let Some(window) = window else {
            return false;
        };
        let raise_action = ax_name("AXRaise");
        unsafe {
            AXUIElementPerformAction(window.as_CFTypeRef(), raise_action.as_concrete_TypeRef())
                == AX_ERROR_SUCCESS
        }
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn read_selected_text_via_accessibility() -> Option<String> {
    use core_foundation::base::TCFType;

    let system = OwnedAxElement::new(unsafe { AXUIElementCreateSystemWide() })?;
    unsafe {
        let _ = AXUIElementSetMessagingTimeout(system.as_ptr(), 0.2);
    }
    let focused_attr = ax_name("AXFocusedUIElement");
    let focused_element =
        ax_copy_attribute_value(system.as_ptr(), focused_attr.as_concrete_TypeRef())?;
    let selected_attr = ax_name("AXSelectedText");
    let selected_text = ax_copy_attribute_value(
        focused_element.as_CFTypeRef(),
        selected_attr.as_concrete_TypeRef(),
    )?;
    selected_text
        .downcast::<core_foundation::string::CFString>()
        .map(|value| value.to_string())
        .filter(|text| !text.trim().is_empty())
}

/// Snapshot of the focused EDITABLE element (the in-place edit lane —
/// "rewrite this more professionally" with no selection reads the whole
/// field the user is typing in).
#[cfg(target_os = "macos")]
#[derive(Debug, Default, Clone)]
pub struct FocusedField {
    pub value: String,
    pub role: String,
    /// Whether AXValue is writable — the clean replacement path. When false,
    /// the fallback is select-all + paste.
    pub settable: bool,
    /// Stable-enough identity for an immediate edit/revert transaction. The
    /// identifier wins when an app exposes one; frame + role are the fallback.
    pub process_id: i32,
    pub identifier: Option<String>,
    pub frame: Option<(f64, f64, f64, f64)>,
}

#[cfg(target_os = "macos")]
fn focused_field_snapshot(
    element: AXUIElementRef,
    process_id: i32,
) -> Option<FocusedField> {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;

    let role = ax_copy_attribute_value(element, ax_name("AXRole").as_concrete_TypeRef())
        .and_then(|value| value.downcast::<CFString>().map(|value| value.to_string()))
        .unwrap_or_default();
    let value_attr = ax_name("AXValue");
    let value = ax_copy_attribute_value(element, value_attr.as_concrete_TypeRef())?
        .downcast::<CFString>()
        .map(|value| value.to_string())?;
    if value.trim().is_empty() || value.len() > 12 * 1024 {
        return None;
    }

    let mut settable_raw = 0_u8;
    let settable = unsafe {
        AXUIElementIsAttributeSettable(
            element,
            value_attr.as_concrete_TypeRef(),
            &mut settable_raw,
        ) == AX_ERROR_SUCCESS
            && settable_raw != 0
    };
    let texty = matches!(role.as_str(), "AXTextArea" | "AXTextField" | "AXComboBox");
    if !texty && !settable {
        return None;
    }

    let identifier = ax_copy_attribute_value(
        element,
        ax_name("AXIdentifier").as_concrete_TypeRef(),
    )
    .and_then(|value| value.downcast::<CFString>().map(|value| value.to_string()))
    .filter(|value| !value.is_empty());
    let frame = (|| {
        let position = ax_copy_attribute_value(
            element,
            ax_name("AXPosition").as_concrete_TypeRef(),
        )?;
        let size = ax_copy_attribute_value(element, ax_name("AXSize").as_concrete_TypeRef())?;
        let mut point = CGPoint { x: 0.0, y: 0.0 };
        let mut size_value = CGSize {
            width: 0.0,
            height: 0.0,
        };
        let got_position = unsafe {
            AXValueGetValue(
                position.as_CFTypeRef(),
                K_AX_VALUE_TYPE_CGPOINT,
                &mut point as *mut _ as *mut std::ffi::c_void,
            )
        };
        let got_size = unsafe {
            AXValueGetValue(
                size.as_CFTypeRef(),
                K_AX_VALUE_TYPE_CGSIZE,
                &mut size_value as *mut _ as *mut std::ffi::c_void,
            )
        };
        (got_position != 0 && got_size != 0).then_some((
            point.x,
            point.y,
            size_value.width,
            size_value.height,
        ))
    })();

    Some(FocusedField {
        value,
        role,
        settable,
        process_id,
        identifier,
        frame,
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn same_focused_field(expected: &FocusedField, current: &FocusedField) -> bool {
    if expected.process_id != current.process_id || expected.role != current.role {
        return false;
    }
    if let Some(identifier) = expected.identifier.as_deref() {
        return current.identifier.as_deref() == Some(identifier);
    }
    match (expected.frame, current.frame) {
        (Some(a), Some(b)) => {
            (a.0 - b.0).abs() < 2.0
                && (a.1 - b.1).abs() < 2.0
                && (a.2 - b.2).abs() < 2.0
                && (a.3 - b.3).abs() < 2.0
        }
        _ => false,
    }
}

/// Read the focused element's text value + role + writability. Returns None
/// unless the element looks editable: a text-ish AX role, or a settable
/// AXValue (settable implies editable even for exotic roles). Value capped at
/// 12KB — bigger fields are not voice-rewrite material.
#[cfg(target_os = "macos")]
pub(crate) fn read_focused_field() -> Option<FocusedField> {
    run_on_main_thread(|| {
        use core_foundation::base::TCFType;

        let process_id = native_frontmost_app_info()?.process_id;

        let system = OwnedAxElement::new(unsafe { AXUIElementCreateSystemWide() })?;
        unsafe {
            let _ = AXUIElementSetMessagingTimeout(system.as_ptr(), 0.2);
        }
        let focused_attr = ax_name("AXFocusedUIElement");
        let focused = ax_copy_attribute_value(system.as_ptr(), focused_attr.as_concrete_TypeRef())?;
        focused_field_snapshot(focused.as_CFTypeRef(), process_id)
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn focused_field_matches(expected: &FocusedField, expected_value: &str) -> bool {
    read_focused_field()
        .map(|current| same_focused_field(expected, &current) && current.value == expected_value)
        .unwrap_or(false)
}

/// Replace AXValue only when the process, field identity, and current value
/// still match the captured edit transaction.
#[cfg(target_os = "macos")]
pub(crate) fn write_focused_field_value_if_matches(
    expected: &FocusedField,
    expected_value: &str,
    text: &str,
) -> bool {
    let expected = expected.clone();
    let expected_value = expected_value.to_string();
    let text = text.to_string();
    run_on_main_thread(move || {
        use core_foundation::base::TCFType;
        use core_foundation::string::CFString;

        let Some(frontmost) = native_frontmost_app_info() else {
            return false;
        };
        let Some(system) = OwnedAxElement::new(unsafe { AXUIElementCreateSystemWide() }) else {
            return false;
        };
        unsafe {
            let _ = AXUIElementSetMessagingTimeout(system.as_ptr(), 0.2);
        }
        let Some(focused) = ax_copy_attribute_value(
            system.as_ptr(),
            ax_name("AXFocusedUIElement").as_concrete_TypeRef(),
        ) else {
            return false;
        };
        let Some(current) = focused_field_snapshot(focused.as_CFTypeRef(), frontmost.process_id)
        else {
            return false;
        };
        if !same_focused_field(&expected, &current) || current.value != expected_value {
            return false;
        }
        let new_value = CFString::new(&text);
        unsafe {
            AXUIElementSetAttributeValue(
                focused.as_CFTypeRef(),
                ax_name("AXValue").as_concrete_TypeRef(),
                new_value.as_CFTypeRef(),
            ) == AX_ERROR_SUCCESS
        }
    })
}

/// Replace the focused element's AXValue wholesale (the clean in-place write).
/// Returns false when the element refuses — caller falls back to
/// select-all + paste.
#[cfg(target_os = "macos")]
pub(crate) fn write_focused_field_value(text: &str) -> bool {
    let text = text.to_string();
    run_on_main_thread(move || {
        use core_foundation::base::TCFType;
        use core_foundation::string::CFString;

        let Some(system) = OwnedAxElement::new(unsafe { AXUIElementCreateSystemWide() }) else {
            return false;
        };
        unsafe {
            let _ = AXUIElementSetMessagingTimeout(system.as_ptr(), 0.2);
        }
        let focused_attr = ax_name("AXFocusedUIElement");
        let Some(focused) =
            ax_copy_attribute_value(system.as_ptr(), focused_attr.as_concrete_TypeRef())
        else {
            return false;
        };
        let value_attr = ax_name("AXValue");
        let new_value = CFString::new(&text);
        let set_err = unsafe {
            AXUIElementSetAttributeValue(
                focused.as_CFTypeRef(),
                value_attr.as_concrete_TypeRef(),
                new_value.as_CFTypeRef(),
            )
        };
        set_err == AX_ERROR_SUCCESS
    })
}

/// Select-all inside the focused element (Cmd+A, keycode 0x00 = 'a') — the
/// write fallback: select-all then paste replaces the field content.
#[cfg(target_os = "macos")]
pub(crate) fn select_all_in_focused() {
    simulate_command_keypress(0x00, "select-all");
}

/// Current frontmost app bundle id, queried NOW (not the saved paste target).
/// The edit lane uses this to refuse a write when focus moved mid-task.
#[cfg(target_os = "macos")]
pub(crate) fn current_frontmost_bundle_id() -> Option<String> {
    get_current_frontmost_bundle_id()
}

/// Text context gathered from the focused app via macOS Accessibility APIs.
/// Feeds Gemini polish so it can spell on-screen names, resolve pronouns,
/// and match the surrounding conversation's tone — without a screenshot.
#[derive(Debug, Default, Clone)]
pub struct WindowContext {
    /// Title of the focused window (e.g. "Messages — Sydney", "lib.rs — o8").
    pub window_title: Option<String>,
    /// Whatever the user has highlighted in the focused element. Gold signal
    /// when present — the user explicitly told us what matters.
    pub selected_text: Option<String>,
    /// A compact dump of visible text from the focused window's AX tree.
    /// Capped at MAX_EXCERPT bytes and depth ~4 to keep the prompt small.
    /// Empty for canvas/Electron apps that don't expose AX text; callers
    /// can fall back to a screenshot in that case.
    pub ax_excerpt: Option<String>,
}

/// Hard budget on the AX text excerpt. Anything over this gets truncated —
/// Gemini has a context window but our polish latency is dominated by upload
/// bytes, so smaller is faster.
#[cfg(target_os = "macos")]
const MAX_EXCERPT: usize = 3000;

/// Max depth we'll descend when walking the AX tree. A focused chat window
/// typically surfaces useful text within 3-4 levels; deeper tends to be
/// sidebar/toolbar chrome we don't care about.
#[cfg(target_os = "macos")]
const MAX_AX_DEPTH: usize = 4;

/// Gather text context from the currently-frontmost app. Must run on the
/// main thread (AX APIs assert this on macOS 15.7+). Called from the Fn-press
/// worker thread, so we hop via run_on_main_thread.
#[cfg(target_os = "macos")]
pub fn gather_window_context() -> WindowContext {
    run_on_main_thread(|| {
        use core_foundation::base::{CFType, TCFType};
        use core_foundation::string::CFString;

        let system = match OwnedAxElement::new(unsafe { AXUIElementCreateSystemWide() }) {
            Some(s) => s,
            None => return WindowContext::default(),
        };
        unsafe {
            let _ = AXUIElementSetMessagingTimeout(system.as_ptr(), 0.2);
        }

        // Focused element → for selected_text
        let focused_attr = ax_name("AXFocusedUIElement");
        let focused = ax_copy_attribute_value(system.as_ptr(), focused_attr.as_concrete_TypeRef());
        let selected_text = focused.as_ref().and_then(|focused_el| {
            let selected_attr = ax_name("AXSelectedText");
            let raw = ax_copy_attribute_value(
                focused_el.as_CFTypeRef(),
                selected_attr.as_concrete_TypeRef(),
            )?;
            raw.downcast::<CFString>()
                .map(|v| v.to_string())
                .filter(|t| !t.trim().is_empty())
        });

        // Focused window of the frontmost app → for title + AX tree walk
        let focused_app_attr = ax_name("AXFocusedApplication");
        let focused_app =
            ax_copy_attribute_value(system.as_ptr(), focused_app_attr.as_concrete_TypeRef());
        let window = focused_app.as_ref().and_then(|app| {
            let focused_window_attr = ax_name("AXFocusedWindow");
            ax_copy_attribute_value(
                app.as_CFTypeRef(),
                focused_window_attr.as_concrete_TypeRef(),
            )
            .or_else(|| {
                let main_window_attr = ax_name("AXMainWindow");
                ax_copy_attribute_value(app.as_CFTypeRef(), main_window_attr.as_concrete_TypeRef())
            })
        });

        let window_title = window.as_ref().and_then(|w| {
            let title_attr = ax_name("AXTitle");
            let raw = ax_copy_attribute_value(w.as_CFTypeRef(), title_attr.as_concrete_TypeRef())?;
            raw.downcast::<CFString>()
                .map(|v| v.to_string())
                .filter(|t| !t.trim().is_empty())
        });

        // AX tree text walk. Depth-first, collects AXStaticText values and any
        // AXValue strings we stumble on. Caps at MAX_EXCERPT bytes to keep the
        // payload small. Returns None when the tree yields nothing useful
        // (canvas apps, Electron with opaque AX) — caller can fall back to
        // the screenshot path.
        fn walk(element: &CFType, depth: usize, out: &mut String) {
            if out.len() >= MAX_EXCERPT || depth > MAX_AX_DEPTH {
                return;
            }
            let role_attr = ax_name("AXRole");
            let role =
                ax_copy_attribute_value(element.as_CFTypeRef(), role_attr.as_concrete_TypeRef())
                    .and_then(|r| r.downcast::<CFString>().map(|v| v.to_string()))
                    .unwrap_or_default();

            let is_text_bearing = matches!(
                role.as_str(),
                "AXStaticText" | "AXTextField" | "AXTextArea" | "AXValueIndicator"
            );
            if is_text_bearing {
                let value_attr = ax_name("AXValue");
                if let Some(raw) = ax_copy_attribute_value(
                    element.as_CFTypeRef(),
                    value_attr.as_concrete_TypeRef(),
                ) {
                    if let Some(s) = raw.downcast::<CFString>().map(|v| v.to_string()) {
                        let trimmed = s.trim();
                        if !trimmed.is_empty() && out.len() + trimmed.len() < MAX_EXCERPT {
                            if !out.is_empty() {
                                out.push('\n');
                            }
                            out.push_str(trimmed);
                        }
                    }
                }
            }

            let children_attr = ax_name("AXChildren");
            if let Some(raw_children) =
                ax_copy_attribute_value(element.as_CFTypeRef(), children_attr.as_concrete_TypeRef())
            {
                // The raw children array is a CFArray of AXUIElementRef
                // pointers (i.e. CFType-erased). core-foundation's
                // CFArray<T> only works for T: ConcreteCFType, which
                // CFType itself is not. Drop to the untyped CFArray and
                // pull child refs directly via CFArrayGetValueAtIndex.
                use core_foundation::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
                let arr_ref = raw_children.as_CFTypeRef() as CFArrayRef;
                let count = unsafe { CFArrayGetCount(arr_ref) };
                for i in 0..count {
                    if out.len() >= MAX_EXCERPT {
                        break;
                    }
                    let ptr = unsafe { CFArrayGetValueAtIndex(arr_ref, i) };
                    if ptr.is_null() {
                        continue;
                    }
                    let child = unsafe {
                        CFType::wrap_under_get_rule(ptr as core_foundation::base::CFTypeRef)
                    };
                    walk(&child, depth + 1, out);
                }
            }
        }

        let ax_excerpt = window.as_ref().and_then(|w| {
            let mut buf = String::new();
            walk(w, 0, &mut buf);
            let trimmed = buf.trim();
            if trimmed.len() < 40 {
                None
            } else {
                Some(trimmed.to_string())
            }
        });

        WindowContext {
            window_title,
            selected_text,
            ax_excerpt,
        }
    })
}

#[cfg(not(target_os = "macos"))]
pub fn gather_window_context() -> WindowContext {
    WindowContext::default()
}

/// Reactivate the previously saved app and raise its window.
/// Uses `activate` + `set index of window 1` to ensure the correct window
/// comes to front, even on multi-display setups.
#[cfg(target_os = "macos")]
fn reactivate_previous_app() -> ActivationOutcome {
    let saved = {
        // Recover from poisoning like every other lock in the crate — the
        // guarded data is a plain clone-able value, safe to take as-is.
        let prev = PREVIOUS_APP.lock().unwrap_or_else(|p| p.into_inner());
        prev.clone()
    };

    if let Some(app) = saved {
        if native_activate_app(&app) {
            if native_raise_front_window(app.process_id) {
                tracing::debug!(
                    "paste: raised {} via AX (pid={})",
                    app.bundle_id,
                    app.process_id
                );
            }
            tracing::debug!(
                "paste: reactivated {} via NSRunningApplication (pid={})",
                app.bundle_id,
                app.process_id
            );
            return ActivationOutcome::FocusShifted;
        }

        let fallback = format!(r#"tell application id "{}" to activate"#, app.bundle_id);
        match Command::new("osascript").args(["-e", &fallback]).output() {
            Ok(out) if out.status.success() => {
                tracing::debug!(
                    "paste: reactivated {} via AppleScript fallback",
                    app.bundle_id
                );
                return ActivationOutcome::FocusShifted;
            }
            Ok(out) => {
                tracing::warn!(
                    "paste: AppleScript activate fallback failed for {}: {}",
                    app.bundle_id,
                    String::from_utf8_lossy(&out.stderr)
                );
            }
            Err(e) => {
                tracing::warn!("paste: failed to reactivate {}: {e}", app.bundle_id);
            }
        }
    }
    ActivationOutcome::FocusUnchanged
}

#[cfg(target_os = "macos")]
fn native_activate_app(app: &SavedApp) -> bool {
    // NSRunningApplication.activateWithOptions is also main-thread-only on
    // macOS 15.7+ (same NSWMWindowCoordinator path as AXRaise). Copy the
    // SavedApp fields the closure needs — `app` is borrowed but the closure
    // needs 'static data for dispatch_sync.
    let process_id = app.process_id;
    let bundle_id = app.bundle_id.clone();
    run_on_main_thread(move || {
        use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
        use objc2_foundation::NSString;

        if let Some(app_ref) =
            NSRunningApplication::runningApplicationWithProcessIdentifier(process_id)
        {
            let _ = app_ref.unhide();
            if app_ref.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows) {
                return true;
            }
        }

        let ns_bundle_id = NSString::from_str(&bundle_id);
        let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&ns_bundle_id);
        if apps.count() == 0 {
            return false;
        }

        let app_ref = apps.objectAtIndex(0);
        let _ = app_ref.unhide();
        app_ref.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows)
    })
}

/// Reactivate one explicit app for a short-lived edit transaction. Unlike the
/// general dictation paste path, this never consults PREVIOUS_APP, so clicking
/// Symon's Revert chip cannot redirect the restore into a stale dictation app.
#[cfg(target_os = "macos")]
pub(crate) fn activate_app_target(bundle_id: &str, process_id: i32) -> bool {
    if native_frontmost_app_info()
        .map(|current| current.bundle_id == bundle_id && current.process_id == process_id)
        .unwrap_or(false)
    {
        return true;
    }
    let target = SavedApp {
        bundle_id: bundle_id.to_string(),
        process_id,
    };
    if !native_activate_app(&target) {
        return false;
    }
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(FOCUS_SETTLE_MAX_MS);
    while std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(FOCUS_SETTLE_POLL_MS));
        if native_frontmost_app_info()
            .map(|current| current.bundle_id == bundle_id && current.process_id == process_id)
            .unwrap_or(false)
        {
            std::thread::sleep(std::time::Duration::from_millis(FOCUS_SETTLE_GRACE_MS));
            return true;
        }
    }
    false
}

/// Wait for a shifted activation to actually land before posting Cmd+V: poll
/// the frontmost app until it reports the saved paste target (or the cap
/// expires), then one short grace sleep for key-focus handover. See the
/// FOCUS_SETTLE_* constants for the Intel story.
#[cfg(target_os = "macos")]
fn wait_for_focus_settle() {
    let target = get_frontmost_bundle_id();
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(FOCUS_SETTLE_MAX_MS);
    loop {
        std::thread::sleep(std::time::Duration::from_millis(FOCUS_SETTLE_POLL_MS));
        let current = get_current_frontmost_bundle_id();
        match (&current, &target) {
            (Some(cur), Some(tgt)) if cur == tgt => break,
            _ => {}
        }
        if std::time::Instant::now() >= deadline {
            log::warn!(
                "[paste] focus settle timed out after {FOCUS_SETTLE_MAX_MS}ms \
                 (frontmost={current:?}, target={target:?}) — posting Cmd+V anyway"
            );
            break;
        }
    }
    std::thread::sleep(std::time::Duration::from_millis(FOCUS_SETTLE_GRACE_MS));
}

/// Determine the correct paste target and activate it.
///
/// If the user clicked a different app or window during dictation, paste there
/// instead of re-activating the stale target from Fn-press time.
#[cfg(target_os = "macos")]
fn smart_activate() -> ActivationOutcome {
    let current_info = native_frontmost_app_info();
    let current = current_info.as_ref().map(|app| app.bundle_id.clone());
    let saved = get_frontmost_bundle_id();

    match (&current, &saved) {
        // The user is in o8's OWN window (real prod bundle id) — they clicked an
        // o8 input (canvas composer, orchestrator field) and want to dictate
        // THERE. Paste into o8; do NOT bounce focus back to the previous app.
        // (The dev binary reports an invalid bundle id and keeps the old
        // reactivate-previous behavior below.)
        (Some(cur), _) if cur == O8_BUNDLE_ID => {
            // log:: too — if o8's own dock/pill ever steals frontmost at paste
            // time, this branch pastes into o8 itself while reporting success;
            // the prod log line is how we'd catch that in the field.
            log::info!("[paste] o8 is frontmost — pasting into o8's own focused field");
            tracing::info!("paste: o8 is frontmost — pasting into o8's own focused field");
            ActivationOutcome::FocusUnchanged
        }
        // Current frontmost is a real app (not o8) and differs from saved:
        // user clicked somewhere new during dictation — paste there.
        (Some(cur), Some(sav)) if cur != sav && !is_o8_or_invalid(cur) => {
            tracing::info!(
                "paste: user clicked {cur} during dictation (saved was {sav}) — preserving current focused window"
            );
            ActivationOutcome::FocusUnchanged
        }
        // Current frontmost is the dev binary (invalid bundle id) — use saved app.
        (Some(cur), _) if is_o8_or_invalid(cur) => {
            tracing::debug!("paste: frontmost is the dev binary ({cur}) — reactivating saved app");
            reactivate_previous_app()
        }
        // Current already matches the saved target — keep the app where it is.
        (Some(cur), Some(sav)) if cur == sav && !is_o8_or_invalid(cur) => {
            tracing::debug!(
                "paste: target app already frontmost ({cur}) — preserving current focused window"
            );
            ActivationOutcome::FocusUnchanged
        }
        // Current matches saved, or we can't tell — normal reactivation.
        _ => reactivate_previous_app(),
    }
}

/// Activate the saved frontmost app (bring to front) WITHOUT pasting.
///
/// Call this at the moment polish starts so macOS can complete activation
/// in parallel with Gemini inference. If the user has already clicked a
/// different app, skip pre-activation to avoid a visible focus-jump back
/// to the stale target — `paste_text()` will sort it out at paste time.
#[cfg(target_os = "macos")]
pub fn activate_frontmost_app() -> bool {
    let current = get_current_frontmost_bundle_id();
    let saved = get_frontmost_bundle_id();

    match (&current, &saved) {
        // o8's own window is frontmost — user wants to dictate into an o8 field.
        // Don't pre-activate anything; paste_text() keeps focus on o8.
        (Some(cur), _) if cur == O8_BUNDLE_ID => true,
        (Some(cur), Some(sav)) if cur != sav && !is_o8_or_invalid(cur) => {
            tracing::info!("paste: skipping pre-activate — user clicked {cur} (saved was {sav})");
            true
        }
        (Some(cur), Some(sav)) if cur == sav && !is_o8_or_invalid(cur) => true,
        _ => matches!(reactivate_previous_app(), ActivationOutcome::FocusShifted),
    }
}

/// No-op on non-macOS platforms.
#[cfg(not(target_os = "macos"))]
pub fn activate_frontmost_app() -> bool {
    false
}

/// Copy `text` to the macOS pasteboard, activate the correct target app, and simulate Cmd+V.
///
/// Smart target resolution: if the user clicked a different app during the
/// Fn hold (or during polishing), paste goes to THAT app instead of the
/// stale target saved at Fn-press time.
///
/// Clipboard is saved before and restored after (plain-text only) so we
/// don't clobber whatever the user had copied previously.
#[cfg(target_os = "macos")]
/// Paste `text` into the focused field. Returns `true` if the synthetic Cmd+V
/// was actually posted, `false` if it was skipped (empty text, clipboard error,
/// or — importantly — Accessibility not granted). On `false` the text is still
/// on the clipboard, so the caller can tell the user to press ⌘V.
pub fn paste_text(text: &str) -> bool {
    paste_text_with_status(text).did_paste()
}

/// Same as `paste_text`, but preserves why the paste did not land so callers
/// can surface a truthful dock error instead of a silent or misleading success.
#[cfg(target_os = "macos")]
pub fn paste_text_with_status(text: &str) -> PasteOutcome {
    paste_text_impl(text, true)
}

/// Paste into the field that is focused right now without consulting the
/// general dictation target. Callers must verify and reactivate their exact
/// target first; this is used by the anchored edit Revert transaction.
#[cfg(target_os = "macos")]
pub(crate) fn paste_text_in_current_field(text: &str) -> PasteOutcome {
    paste_text_impl(text, false)
}

#[cfg(target_os = "macos")]
fn paste_text_impl(text: &str, activate_dictation_target: bool) -> PasteOutcome {
    if text.is_empty() {
        tracing::debug!("paste: skipping — empty text");
        return PasteOutcome::Failed("No text was transcribed.".to_string());
    }

    // Step 0: Preserve the user's REAL clipboard. capture_clipboard_snapshot()
    // can grab Symon's OWN previous paste output mid-dictation-burst, so only
    // treat the clipboard as the user's when its changeCount isn't one we wrote
    // — otherwise a chained paste saves Symon's text as "the user's clipboard"
    // and the original is gone for good (the operator's core bug). We always
    // restore the preserved real original, never Symon's output.
    let saved_clipboard = {
        let current = capture_clipboard_snapshot();
        let mut guard = CLIPBOARD_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        if current.change_count != guard.last_injected {
            guard.user = Some(current.clone());
        }
        guard.user.clone().unwrap_or(current)
    };

    // Step 1: Write text to clipboard.
    let injected_change_count = match copy_to_clipboard(text) {
        Ok(change_count) => change_count,
        Err(e) => {
            log::warn!("[paste] outcome=failed — clipboard write rejected: {e}");
            tracing::error!("paste: failed to copy to clipboard: {e}");
            return PasteOutcome::Failed(format!("Could not copy dictation to the clipboard: {e}"));
        }
    };
    CLIPBOARD_GUARD
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .last_injected = injected_change_count;

    // Accessibility gate: the synthetic Cmd+V below is a CGEvent the OS silently
    // ignores unless o8 is a trusted Accessibility client. When untrusted — e.g.
    // running translocated from a disk image (the app never appears in the
    // Accessibility list), or simply not granted yet — skip the doomed keystroke.
    // The text is already on the clipboard, so the caller surfaces "copied —
    // press ⌘V" instead of a false "pasted".
    if !crate::mac_perms::accessibility_permission_granted(false) {
        log::warn!(
            "[paste] outcome=clipboard_only chars={} — Accessibility gate failed at paste time",
            text.len()
        );
        tracing::warn!(
            "paste: Accessibility not granted — {} chars copied to clipboard but synthetic Cmd+V skipped \
             (grant o8 in System Settings → Privacy & Security → Accessibility, or move o8 to /Applications if it is running from a disk image)",
            text.len()
        );
        restore_clipboard_delayed(
            saved_clipboard,
            injected_change_count,
            MANUAL_PASTE_RESTORE_MS,
        );
        return PasteOutcome::ClipboardOnly;
    }

    // Step 2: Activate the correct paste target. If the user clicked a
    // different app during dictation, smart_activate() detects this and
    // pastes there instead of the stale saved target.
    let activation = if activate_dictation_target {
        smart_activate()
    } else {
        ActivationOutcome::FocusUnchanged
    };

    // Step 3: Make sure keyboard focus is live before we post the synthetic
    // Cmd+V. Pre-activation already handled the slow part; this poll exits
    // after ~35ms on a fast machine and only stretches (capped) when a cold
    // Intel activation is still in flight — a fixed short sleep here is how
    // pastes silently vanished on Intel (#1534).
    if activation.needs_focus_settle() {
        wait_for_focus_settle();
    }

    // Step 4: Simulate Cmd+V.
    simulate_cmd_v();

    // log:: (not tracing::) so the outcome reaches o8.log in packaged builds —
    // tracing goes to stdout, which a bundled .app discards. #1534 shipped
    // "Pasted" outcomes with zero field evidence of which activation branch
    // ran or whether the restore raced the target app.
    log::info!(
        "[paste] outcome=pasted chars={} activation={:?} target={:?}",
        text.len(),
        activation,
        get_frontmost_bundle_id()
    );
    tracing::debug!("paste: wrote {} chars to clipboard and pasted", text.len());

    // Step 5: Hand the user's clipboard back, fast.
    //
    // History: a 300ms delay once let slow-paste apps (Terminal, Slack, some
    // Electron) paste stale content because they read the clipboard 400-1500ms
    // after the synthetic Cmd+V; the fix over-corrected to 5000ms, which made
    // the user's clipboard unusable for a full 5s every dictation (the operator
    // hit this 3×/5min). CLIPBOARD_RESTORE_DELAY_MS is the balance: long enough
    // for the common field/webview paste to land, short enough that copy/paste
    // is the user's again almost immediately. The change_count guard in
    // restore_clipboard_if_match still skips the restore if the user copied
    // something new in the window, and the ClipboardGuard above guarantees the
    // thing we restore is the user's REAL original, not Symon's own output.
    restore_clipboard_delayed(
        saved_clipboard,
        injected_change_count,
        CLIPBOARD_RESTORE_DELAY_MS,
    );
    PasteOutcome::Pasted
}

/// Write text to the system clipboard.
#[cfg(target_os = "macos")]
pub(crate) fn copy_to_clipboard(text: &str) -> Result<i64, String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    let _pb = pb_guard();
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let text = NSString::from_str(text);
    let string_type = unsafe { NSPasteboardTypeString };
    if pasteboard.setString_forType(&text, string_type) {
        Ok(pasteboard.changeCount() as i64)
    } else {
        Err("NSPasteboard rejected string write".to_string())
    }
}

/// Save the current clipboard contents (plain text only).
#[cfg(target_os = "macos")]
pub(crate) fn capture_clipboard_snapshot() -> ClipboardSnapshot {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};

    let _pb = pb_guard();
    let pasteboard = NSPasteboard::generalPasteboard();
    let string_type = unsafe { NSPasteboardTypeString };
    ClipboardSnapshot {
        text: pasteboard
            .stringForType(string_type)
            .map(|text| text.to_string())
            .filter(|s| !s.is_empty()),
        change_count: pasteboard.changeCount() as i64,
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn clipboard_change_count() -> i64 {
    use objc2_app_kit::NSPasteboard;

    let _pb = pb_guard();
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.changeCount() as i64
}

#[cfg(target_os = "macos")]
pub(crate) fn read_clipboard_text() -> Option<String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};

    let _pb = pb_guard();
    let pasteboard = NSPasteboard::generalPasteboard();
    let string_type = unsafe { NSPasteboardTypeString };
    pasteboard
        .stringForType(string_type)
        .map(|text| text.to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(target_os = "macos")]
fn clear_clipboard() -> i64 {
    use objc2_app_kit::NSPasteboard;

    let _pb = pb_guard();
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    pasteboard.changeCount() as i64
}

#[cfg(target_os = "macos")]
pub(crate) fn restore_clipboard_if_match(
    snapshot: &ClipboardSnapshot,
    expected_change_count: i64,
) -> bool {
    if clipboard_change_count() != expected_change_count {
        return false;
    }
    match &snapshot.text {
        Some(text) => copy_to_clipboard(text).is_ok(),
        None => {
            clear_clipboard();
            true
        }
    }
}

/// Restore previously saved clipboard contents after a delay.
/// Spawns a background thread so it doesn't block the paste flow.
#[cfg(target_os = "macos")]
fn restore_clipboard_delayed(saved: ClipboardSnapshot, expected_change_count: i64, delay_ms: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        if !restore_clipboard_if_match(&saved, expected_change_count) {
            tracing::debug!("paste: clipboard changed since paste, skipping restore");
            return;
        }
        tracing::debug!(
            "paste: clipboard restored ({} chars)",
            saved.text.as_ref().map(|text| text.len()).unwrap_or(0)
        );
    });
}

/// Simulate a Command-modified keystroke using Core Graphics events.
///
/// CRITICAL (stuck-modifier bug): synthesize a REAL chord — press the Command
/// KEY, tap the target key, release the target key, then RELEASE Command with
/// cleared flags. The old version posted only the target key with the Command
/// FLAG set (and never a Command key-up), which could leave macOS's HID modifier
/// state believing Command was still held: every later keypress then read as a
/// Cmd-chord and BEEPED system-wide — and it survived o8's death (only a logout
/// cleared it). A balanced Command down/up keeps the modifier state from ever
/// sticking.
#[cfg(target_os = "macos")]
fn simulate_command_keypress(keycode: u16, label: &str) {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    const CMD_KEYCODE: u16 = 0x37; // kVK_Command (left ⌘)

    let source = match CGEventSource::new(CGEventSourceStateID::CombinedSessionState) {
        Ok(s) => s,
        Err(()) => {
            tracing::error!("{label}: failed to create CGEventSource");
            return;
        }
    };

    // Post one keyboard event (down/up) for `kc` with `flags`; log + skip on err.
    let post = |kc: u16, down: bool, flags: CGEventFlags| match CGEvent::new_keyboard_event(
        source.clone(),
        kc,
        down,
    ) {
        Ok(e) => {
            e.set_flags(flags);
            e.post(CGEventTapLocation::HID);
        }
        Err(()) => tracing::error!("{label}: failed to create key event (kc={kc}, down={down})"),
    };

    let gap = std::time::Duration::from_millis(COMMAND_KEY_GAP_MS);
    // ⌘ down → key down → key up → ⌘ up (flags cleared). The balanced Command
    // press/release is the fix — it can never strand "Command held".
    post(CMD_KEYCODE, true, CGEventFlags::CGEventFlagCommand);
    std::thread::sleep(gap);
    post(keycode, true, CGEventFlags::CGEventFlagCommand);
    std::thread::sleep(gap);
    post(keycode, false, CGEventFlags::CGEventFlagCommand);
    std::thread::sleep(gap);
    post(CMD_KEYCODE, false, CGEventFlags::empty());
}

/// Simulate Cmd+V keystroke using Core Graphics events.
#[cfg(target_os = "macos")]
pub(crate) fn simulate_cmd_v() {
    simulate_command_keypress(0x09, "paste");
}

/// Simulate Cmd+C keystroke using Core Graphics events.
#[cfg(target_os = "macos")]
pub(crate) fn simulate_cmd_c() {
    simulate_command_keypress(0x08, "selection");
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceFlagsState(state_id: i32) -> u64;
}

/// Wait (≤700ms) for the Ctrl and Shift modifiers to be physically released
/// before we synthesize Cmd+C. Posting Cmd+C while the Ctrl+Shift+S chord is
/// still held can merge held modifiers into the event so the copy never happens.
/// Matters for AX-opaque surfaces (o8's own WKWebView) where Strategy 1 returns
/// None and we depend on the Cmd+C fallback. A tap releases in tens of ms; a
/// long hold times out and we proceed best-effort.
#[cfg(target_os = "macos")]
fn wait_for_chord_release() {
    // kCGEventFlagMaskControl (1<<18) | kCGEventFlagMaskShift (1<<17).
    const CHORD_MASK: u64 = 0x40000 | 0x20000;
    // kCGEventSourceStateCombinedSessionState is 0, NOT 1 — the old constant
    // here said "combined = 1", but 1 is kCGEventSourceStateHIDSystemState:
    // HARDWARE-only modifier state. A chord typed through a remote-control
    // session (Chrome Remote Desktop injects synthetic events) never registers
    // in hardware state, so this poll returned "released" instantly, the
    // synthetic Cmd+C merged with the still-held Ctrl+Shift, and
    // speak-selection read "no selection to speak" every time the operator
    // drove the machine remotely (#1534 field evidence, 2026-07-10 04:40).
    // The COMBINED state covers both hardware and synthetic sources.
    const CG_STATE_COMBINED_SESSION: i32 = 0;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(700);
    while std::time::Instant::now() < deadline {
        let held = unsafe { CGEventSourceFlagsState(CG_STATE_COMBINED_SESSION) } & CHORD_MASK;
        if held == 0 {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// Read the user's current text selection (voice P4 "say" / speak-selection).
/// Strategy 1: Accessibility `AXSelectedText` (no clipboard touch). Strategy 2:
/// synthesize Cmd+C, poll the clipboard ≤180ms (10ms cadence), read it, then
/// restore the user's original clipboard. Adapted from the owned aqua/Symon
/// `reading.rs::grab_selection`; the 180ms/10ms/accept-rule values are unchanged.
#[cfg(target_os = "macos")]
/// Read the frontmost terminal's VISIBLE text tail via AX — the "read what
/// Claude just said" path. In a Claude Code TUI, mouse reporting eats
/// drag-select so a selection rarely exists; the read chord's useful meaning
/// there is "speak the latest output". Returns the trailing content block of
/// the focused text area's AXValue with TUI chrome (box-drawing frames,
/// status/shortcut lines) stripped, capped to TTS size. Raw AX — the CALLER
/// must hop to the main thread (same rule as read_selected_text_via_accessibility).
#[cfg(target_os = "macos")]
pub(crate) fn read_terminal_tail_via_accessibility() -> Option<String> {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;

    let system = OwnedAxElement::new(unsafe { AXUIElementCreateSystemWide() })?;
    unsafe {
        let _ = AXUIElementSetMessagingTimeout(system.as_ptr(), 0.3);
    }
    let focused_attr = ax_name("AXFocusedUIElement");
    let focused = ax_copy_attribute_value(system.as_ptr(), focused_attr.as_concrete_TypeRef())?;
    let value_attr = ax_name("AXValue");
    let value = ax_copy_attribute_value(focused.as_CFTypeRef(), value_attr.as_concrete_TypeRef())?
        .downcast::<CFString>()
        .map(|v| v.to_string())?;

    // Terminal.app's AXValue can be the entire scrollback (megabytes). Only
    // the tail matters — slice to the last 16KB on a char boundary first.
    let mut start = value.len().saturating_sub(16 * 1024);
    while start > 0 && !value.is_char_boundary(start) {
        start -= 1;
    }
    let tail = &value[start..];

    // A line is TUI chrome when it is mostly box-drawing/frame characters or
    // a known status line — not prose worth speaking.
    fn is_chrome_line(line: &str) -> bool {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return true;
        }
        let lower = trimmed.to_lowercase();
        // Claude Code footer/status vocabulary (live-hit 2026-07-14: the
        // model|Ctx|cost line and "bypass permissions on · 1 shell" were
        // collected as content and spoken as "the last message").
        if lower.contains("? for shortcuts")
            || lower.contains("esc to interrupt")
            || lower.contains("auto-accept")
            || lower.contains("bypass permissions")
            || lower.contains("accept edits on")
            || lower.contains("plan mode on")
            || lower.contains("/clear to save")
            || lower.contains("how is claude doing this session")
            || lower.contains("0: dismiss")
            || (trimmed.contains('|') && lower.contains("ctx:"))
            || trimmed.starts_with('›')
        {
            return true;
        }
        let chrome_chars = trimmed.chars().filter(|c| {
            matches!(c, '─' | '│' | '╭' | '╮' | '╰' | '╯' | '┌' | '┐' | '└' | '┘'
                | '═' | '║' | '╔' | '╗' | '╚' | '╝' | '━' | '┃' | '▔' | '▁' | '·' | '>' | '·')
                || c.is_whitespace()
        }).count();
        chrome_chars * 10 >= trimmed.chars().count() * 6
    }

    // Walk lines from the end: skip trailing chrome (the composer frame +
    // status bar), then collect the contiguous content block above it.
    let lines: Vec<&str> = tail.lines().collect();
    let mut idx = lines.len();
    while idx > 0 && is_chrome_line(lines[idx - 1]) {
        idx -= 1;
    }
    let mut collected: Vec<&str> = Vec::new();
    let mut chars = 0usize;
    const MAX_SPEAK_CHARS: usize = 1_600;
    while idx > 0 && chars < MAX_SPEAK_CHARS {
        let line = lines[idx - 1];
        if is_chrome_line(line) && !collected.is_empty() {
            // One blank/chrome line inside a paragraph is fine; a second
            // consecutive one ends the block.
            if collected.first().map(|l: &&str| is_chrome_line(l)).unwrap_or(false) {
                break;
            }
        }
        // Strip a leading/trailing box-drawing gutter (│ text │).
        let cleaned = line.trim().trim_matches(|c| matches!(c, '│' | '┃' | '║')).trim();
        collected.insert(0, cleaned);
        chars += cleaned.len() + 1;
        idx -= 1;
    }
    let text = collected
        .into_iter()
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    if text.is_empty() { None } else { Some(text) }
}

#[cfg(target_os = "macos")]
pub(crate) fn grab_selection() -> Option<String> {
    // ── Strategy 1: Accessibility (no clipboard clobber) ──
    // AX APIs SIGILL/return-nothing off the main thread on macOS 15.7+ (same
    // rule as gather_window_context). grab_selection is called from a worker
    // thread (the Ctrl+Shift+S handler spawns it for the Cmd+C sleeps), so the AX read
    // MUST hop to the main thread or it silently fails and we fall through to
    // the held-modifier-broken Cmd+C path.
    if let Some(text) = run_on_main_thread(read_selected_text_via_accessibility) {
        log::info!(
            "[tts] grab_selection: AXSelectedText got {} chars",
            text.len()
        );
        return Some(text);
    }

    // ── Terminal no-selection gate (#1545, the "boop") ──
    // Terminal.app and iTerm2 expose real selections through AXSelectedText,
    // so Strategy 1 returning nothing means there genuinely IS no selection —
    // and a synthetic Cmd+C on an empty terminal selection rings the system
    // bell (audible on every read-chord press inside a Claude Code TUI, where
    // mouse reporting eats drag-select so a selection rarely exists). Skip the
    // beeping fallback for those AX-authoritative terminals; every other app
    // keeps the Cmd+C path (real selections there copy silently).
    if let Some(bundle_id) = get_current_frontmost_bundle_id() {
        const AX_AUTHORITATIVE_TERMINALS: [&str; 2] =
            ["com.apple.Terminal", "com.googlecode.iterm2"];
        if AX_AUTHORITATIVE_TERMINALS.contains(&bundle_id.as_str()) {
            // One retry before falling to the tail: a TUI redraw tick can
            // transiently blank AXSelectedText while a real selection exists.
            std::thread::sleep(std::time::Duration::from_millis(80));
            if let Some(text) = run_on_main_thread(read_selected_text_via_accessibility) {
                log::info!(
                    "[tts] grab_selection: AXSelectedText got {} chars on retry",
                    text.len()
                );
                return Some(text);
            }
            // No selection in a terminal → speak the VISIBLE TAIL instead
            // (operator ruling 2026-07-13: the read chord's best home is a
            // Claude Code TUI, where mouse reporting eats drag-select so a
            // selection almost never exists — "read what Claude just said"
            // is the useful meaning). Chrome lines (box frames, status bar)
            // are stripped; the Cmd+C fallback stays skipped so the chord
            // still never rings the terminal bell (#1545).
            if let Some(tail) = run_on_main_thread(read_terminal_tail_via_accessibility) {
                log::info!(
                    "[tts] grab_selection: no selection in {bundle_id} — speaking terminal tail ({} chars)",
                    tail.len()
                );
                return Some(tail);
            }
            log::info!(
                "[tts] grab_selection: {bundle_id} has no AX selection or readable tail — skipping Cmd+C fallback (terminal bell)"
            );
            return None;
        }
    }

    // ── Strategy 2: simulate Cmd+C → poll clipboard → restore ──
    // Wait for the Ctrl+Shift+S chord to release first so the synthetic Cmd+C
    // isn't polluted by still-held modifiers (the held-modifier bug that left
    // o8's own webview selection uncopyable).
    wait_for_chord_release();
    let saved = capture_clipboard_snapshot();
    simulate_cmd_c();

    // 400ms: Chrome/Electron under load can beat the old 180ms window, which
    // read as "no selection" on a copy that was still in flight.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(400);
    let mut copied_change_count = None;
    while std::time::Instant::now() < deadline {
        let current = clipboard_change_count();
        if current != saved.change_count {
            copied_change_count = Some(current);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    let new_clipboard = copied_change_count.and_then(|_| read_clipboard_text());
    // ALWAYS restore the user's clipboard. We synthesized a Cmd+C purely to READ
    // the selection — it must never be left sitting in the clipboard. The old
    // change-count-gated restore SKIPPED on any race (slow copy, undetected
    // change, a concurrent write), which is exactly how a grab clobbered the
    // user's copy and made "Cmd+C stopped working" system-wide. Put their
    // clipboard back unconditionally; the grabbed text is returned below.
    match &saved.text {
        Some(text) => {
            let _ = copy_to_clipboard(text);
        }
        None => {
            clear_clipboard();
        }
    }

    // `new_clipboard` is only Some when the pasteboard changeCount MOVED — a
    // fresh Cmd+C write provably landed. The selection may legitimately EQUAL
    // the prior clipboard text (selecting text you just copied or dictated,
    // or pressing the chord twice on one selection); the old `new != old`
    // guard read exactly those as "no selection" and made speak-selection
    // feel dead whenever the operator re-read their own text (2026-07-07).
    match &new_clipboard {
        Some(new) if !new.trim().is_empty() => {
            log::info!("[tts] grab_selection: Cmd+C got {} chars", new.len());
            new_clipboard
        }
        _ => {
            log::warn!("[tts] grab_selection: clipboard unchanged — no selection to speak");
            None
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn grab_selection() -> Option<String> {
    None
}

/// No-op on non-macOS platforms.
/// Linux types into the focused X11 window with xdotool (`linux_ptt`).
#[cfg(target_os = "linux")]
pub fn paste_text(text: &str) -> bool {
    paste_text_with_status(text).did_paste()
}

#[cfg(target_os = "linux")]
pub fn paste_text_with_status(text: &str) -> PasteOutcome {
    crate::linux_ptt::type_text(text)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn paste_text(_text: &str) -> bool {
    tracing::warn!("paste: not supported on this platform");
    false
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn paste_text_with_status(_text: &str) -> PasteOutcome {
    tracing::warn!("paste: not supported on this platform");
    PasteOutcome::Failed("System paste is only available on macOS.".to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn save_frontmost_app() {}

#[cfg(not(target_os = "macos"))]
#[derive(Clone, Debug, Default)]
pub(crate) struct ClipboardSnapshot {
    pub(crate) text: Option<String>,
    pub(crate) change_count: i64,
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn read_selected_text_via_accessibility() -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn capture_clipboard_snapshot() -> ClipboardSnapshot {
    ClipboardSnapshot::default()
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn clipboard_change_count() -> i64 {
    0
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn read_clipboard_text() -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn restore_clipboard_if_match(
    _snapshot: &ClipboardSnapshot,
    _expected_change_count: i64,
) -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn copy_to_clipboard(_text: &str) -> Result<i64, String> {
    Err("paste: clipboard unsupported on this platform".to_string())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn simulate_cmd_v() {}

#[cfg(not(target_os = "macos"))]
pub(crate) fn simulate_cmd_c() {}

#[cfg(test)]
mod tests {
    use super::PasteOutcome;

    #[cfg(target_os = "macos")]
    use super::{same_focused_field, FocusedField};

    #[test]
    fn paste_outcome_reports_only_real_paste_as_pasted() {
        assert!(PasteOutcome::Pasted.did_paste());
        assert!(!PasteOutcome::ClipboardOnly.did_paste());
        assert!(!PasteOutcome::Failed("clipboard unavailable".to_string()).did_paste());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn edit_field_identity_prefers_identifier_and_rejects_other_processes() {
        let field = |process_id, identifier: Option<&str>, x| FocusedField {
            value: "draft".to_string(),
            role: "AXTextArea".to_string(),
            settable: false,
            process_id,
            identifier: identifier.map(str::to_string),
            frame: Some((x, 20.0, 300.0, 120.0)),
        };
        let expected = field(42, Some("composer"), 10.0);
        assert!(same_focused_field(
            &expected,
            &field(42, Some("composer"), 999.0)
        ));
        assert!(!same_focused_field(
            &expected,
            &field(43, Some("composer"), 10.0)
        ));
        assert!(!same_focused_field(
            &expected,
            &field(42, Some("subject"), 10.0)
        ));
        assert!(same_focused_field(
            &field(42, None, 10.0),
            &field(42, None, 10.8)
        ));
    }
}
