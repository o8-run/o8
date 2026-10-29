//! Symon Spatial Context — the draw-on-screen ink overlay window.
//!
//! A sibling of `agent_partials_window` / `dock_window`: a transparent,
//! all-spaces, always-on Tauri window — label **`spatial-ink`**, NEVER `main`
//! (same label-discipline invariant as the dock/HUD). It loads the bundled-Next
//! route `/spatial-ink` and lets the operator draw glowing strokes anywhere on
//! the LIVE screen while holding Right-Option (Symon push-to-talk). On release,
//! a screenshot + the strokes ride the brain turn with the spoken command, so
//! "why does THIS look off?" + a circle tells the model exactly where to look.
//!
//! Level 24 (one BELOW the partials HUD at 25) so the HUD bar reads OVER the
//! ink, but above normal app windows so the operator draws over everything.
//!
//! ── CRITICAL mouse-capture protocol ──
//! The window is CLICK-THROUGH (`set_ignore_cursor_events(true)`) at ALL times
//! EXCEPT during an agent hold. `begin_agent_dictation` calls `arm(&app)`
//! (capture ON — `set_ignore_cursor_events(false)` + orderFront nonactivating);
//! EVERY teardown path (finalize, error, cancel, session-idle) calls `disarm`
//! (capture OFF). A stuck non-click-through invisible full-screen window would
//! brick the operator's mouse, so disarm is belt-and-suspenders:
//!   1. Rust callers disarm on every terminal path (finalize / discard / error).
//!   2. The page requests disarm (`o8:spatial-ink-disarm-request`) on ANY
//!      terminal STT event.
//!   3. A 90s Rust safety timer from `arm` auto-disarms if nothing else did.
//! Any ONE of the three is sufficient; all three together make a stuck capture
//! effectively impossible.
//!
//! ── Capture + composite flow ──
//! On the FIRST stroke the page emits `o8:spatial-ink-first-stroke`; Rust
//! captures the marked monitor at full-res (before the ink renders — the screen
//! is what the operator is pointing at) and stashes it. On the STT `final`
//! event the page emits `o8:spatial-ink-strokes` with the normalized strokes.
//! At finalize, `take_spatial_context()` burns the strokes into the screenshot
//! and cuts a full-res crop of the marked region (see `screen::composite_strokes`).

#[cfg(target_os = "macos")]
pub const SPATIAL_INK_LABEL: &str = "spatial-ink";

#[cfg(target_os = "macos")]
mod imp {
    use super::SPATIAL_INK_LABEL;
    use crate::agent::screen;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    /// Placeholder frame at boot; `arm` sizes it to the cursor's monitor.
    const PLACEHOLDER_W: f64 = 800.0;
    const PLACEHOLDER_H: f64 = 600.0;
    /// Belt-and-suspenders: never let the capture-mouse state persist longer
    /// than this after an arm, no matter what fails downstream.
    const SAFETY_DISARM_SECS: u64 = 90;

    /// True while an agent hold has the ink window capturing the mouse.
    static ARMED: AtomicBool = AtomicBool::new(false);
    /// Bumped on every `arm`; the 90s safety thread only fires if its generation
    /// still matches (so a re-arm cancels the previous timer).
    static ARM_GEN: AtomicU64 = AtomicU64::new(0);
    static OVERLAY_CHANGE: Mutex<()> = Mutex::new(());

    /// Single-slot stash for the current (serial, push-to-talk) agent session:
    /// the full-res capture taken at first stroke + the normalized strokes the
    /// page reports at `final`. `arm` resets it; `take_spatial_context` drains it.
    struct Stash {
        /// Each inner Vec is one polyline of NORMALIZED (0..1) points.
        strokes: Option<Vec<Vec<(f64, f64)>>>,
        capture: Option<screen::RawCapture>,
        /// A capture subprocess is in flight (started on first stroke).
        capturing: bool,
        first_stroke_seen: bool,
        instruction: String,
        generation: u64,
        visual_id: Option<String>,
        monitor: Option<tauri::Monitor>,
    }

    impl Stash {
        const fn new() -> Self {
            Stash {
                strokes: None,
                capture: None,
                capturing: false,
                first_stroke_seen: false,
                instruction: String::new(),
                generation: 0,
                visual_id: None,
                monitor: None,
            }
        }
    }

    static STASH: Mutex<Stash> = Mutex::new(Stash::new());

    fn lock_stash() -> std::sync::MutexGuard<'static, Stash> {
        STASH.lock().unwrap_or_else(|p| p.into_inner())
    }

    // ── Payload types (JS → Rust events) ──

    #[derive(serde::Deserialize, serde::Serialize)]
    struct InkPoint {
        x: f64,
        y: f64,
        #[serde(default)]
        t: f64,
        // `t` (timestamp) is reported but unused server-side.
    }

    #[derive(serde::Deserialize, serde::Serialize)]
    struct InkStroke {
        #[serde(default)]
        points: Vec<InkPoint>,
    }

    #[derive(serde::Deserialize)]
    struct StrokesPayload {
        #[serde(default, rename = "visualCaptureId")]
        visual_id: Option<String>,
        #[serde(default, rename = "visualCaptureGeneration")]
        visual_generation: Option<u64>,
        #[serde(default)]
        strokes: Vec<InkStroke>,
        #[serde(default)]
        instruction: String,
    }

    impl StrokesPayload {
        fn into_points(self) -> Vec<Vec<(f64, f64)>> {
            self.strokes
                .into_iter()
                .map(|s| s.points.into_iter().map(|p| (p.x, p.y)).collect())
                .filter(|v: &Vec<(f64, f64)>| !v.is_empty())
                .collect()
        }
    }

    // ── Window creation ──

    pub fn create(app: &tauri::AppHandle, api_port: u16) {
        use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

        if app.get_webview_window(SPATIAL_INK_LABEL).is_some() {
            return;
        }

        let base = match crate::dev_frontend::from_env() {
            Ok(Some(dev)) => {
                log::info!("[spatial-ink] dev-bridge: loading from {}", dev.origin());
                dev.origin().to_string()
            }
            _ => format!("http://127.0.0.1:{}", api_port),
        };
        let url = format!("{}/spatial-ink", base);
        let parsed = match url.parse() {
            Ok(u) => u,
            Err(e) => {
                log::warn!("[spatial-ink] bad url {url}: {e}");
                return;
            }
        };

        let window =
            WebviewWindowBuilder::new(app, SPATIAL_INK_LABEL, WebviewUrl::External(parsed))
                .title("o8 spatial ink")
                .inner_size(PLACEHOLDER_W, PLACEHOLDER_H)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .shadow(false)
                .skip_taskbar(true)
                .focused(false)
                .visible(true)
                .disable_drag_drop_handler()
                .build();

        let window = match window {
            Ok(w) => w,
            Err(e) => {
                log::warn!("[spatial-ink] failed to build window: {e}");
                return;
            }
        };

        apply_macos_recipe(&window);
        // CLICK-THROUGH at rest — every click passes through until `arm`.
        let _ = window.set_ignore_cursor_events(true);
        order_front_nonactivating(&window);
        log::info!("[spatial-ink] ink window created (always-on, click-through) → {url}");
    }

    /// Transparent + level-24 + nonactivating NSWindow recipe. Level 24 keeps it
    /// UNDER the partials HUD (25) so the HUD bar reads over the ink, and above
    /// normal app windows so the operator draws over everything. Main-thread only.
    fn apply_macos_recipe(window: &tauri::WebviewWindow) {
        let win = window.clone();
        let _ = window.run_on_main_thread(move || {
            use objc2_app_kit::{NSColor, NSWindow, NSWindowCollectionBehavior};
            let Ok(ptr) = win.ns_window() else {
                return;
            };
            let ptr = ptr as *mut NSWindow;
            if ptr.is_null() {
                return;
            }
            // Safety: Tauri guarantees a live NSWindow for the window's lifetime;
            // this closure runs on the main thread.
            unsafe {
                let ns_window = &*ptr;
                let clear = NSColor::clearColor();
                ns_window.setBackgroundColor(Some(&clear));
                ns_window.setOpaque(false);
                // One below the HUD (25) — ink renders UNDER the partials bar.
                ns_window.setLevel(24);
                ns_window.setHidesOnDeactivate(false);
                ns_window.setCollectionBehavior(
                    NSWindowCollectionBehavior::CanJoinAllSpaces
                        | NSWindowCollectionBehavior::Stationary
                        | NSWindowCollectionBehavior::FullScreenAuxiliary
                        | NSWindowCollectionBehavior::IgnoresCycle,
                );
            }
        });
    }

    fn order_front_nonactivating(window: &tauri::WebviewWindow) {
        let _ = window.show();
        let win = window.clone();
        let _ = window.run_on_main_thread(move || {
            use objc2_app_kit::NSWindow;
            if let Ok(ptr) = win.ns_window() {
                let ptr = ptr as *mut NSWindow;
                if !ptr.is_null() {
                    // Safety: live NSWindow, main thread.
                    unsafe {
                        (*ptr).orderFrontRegardless();
                    }
                }
            }
        });
    }

    /// Freeze the target once; window positioning and pixels share this monitor.
    pub fn cursor_monitor(app: &tauri::AppHandle) -> Option<tauri::Monitor> {
        let cursor = app.cursor_position().ok();
        let monitors = app.available_monitors().unwrap_or_default();
        cursor
            .and_then(|c| {
                monitors
                    .iter()
                    .find(|m| {
                        let p = m.position();
                        let size = m.size();
                        c.x >= p.x as f64
                            && c.x < (p.x + size.width as i32) as f64
                            && c.y >= p.y as f64
                            && c.y < (p.y + size.height as i32) as f64
                    })
                    .cloned()
            })
            .or_else(|| app.primary_monitor().ok().flatten())
            .or_else(|| monitors.first().cloned())
    }

    fn reposition_to_monitor(window: &tauri::WebviewWindow, monitor: tauri::Monitor) {
        let win = window.clone();
        let _ = window.run_on_main_thread(move || {
            let scale = monitor.scale_factor();
            let mon_x = monitor.position().x as f64 / scale;
            let mon_y = monitor.position().y as f64 / scale;
            let mon_w = monitor.size().width as f64 / scale;
            let mon_h = monitor.size().height as f64 / scale;
            let _ = win.set_size(tauri::LogicalSize::new(mon_w, mon_h));
            let _ = win.set_position(tauri::LogicalPosition::new(mon_x, mon_y));
        });
    }

    // ── Arm / disarm (mouse-capture protocol) ──

    /// Begin an agent hold: reset the stash, cover the cursor's monitor, CAPTURE
    /// the mouse, order front nonactivating, and arm the 90s safety auto-disarm.
    pub fn arm(app: &tauri::AppHandle) {
        let monitor = cursor_monitor(app);
        let _ = arm_owned(app, None, monitor);
    }

    pub fn arm_visual(app: &tauri::AppHandle, id: String, monitor: tauri::Monitor) -> Option<u64> {
        arm_owned(app, Some(id), Some(monitor))
    }

    fn arm_owned(
        app: &tauri::AppHandle,
        visual_id: Option<String>,
        monitor: Option<tauri::Monitor>,
    ) -> Option<u64> {
        use tauri::{Emitter, Manager};
        let _change = OVERLAY_CHANGE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // #2147 — quiet mode owns overlay visibility for its duration. Arming
        // would cover the presenter's whole monitor with a capture layer.
        if crate::presentation::overlay_show_blocked() {
            return None;
        }
        let (generation, superseded) = {
            let mut stash = lock_stash();
            if visual_id.is_some() && is_armed() {
                return None;
            }
            let generation = ARM_GEN.fetch_add(1, Ordering::SeqCst) + 1;
            let superseded = stash.visual_id.take();
            *stash = Stash {
                generation,
                visual_id,
                monitor: monitor.clone(),
                ..Stash::new()
            };
            ARMED.store(true, Ordering::SeqCst);
            (generation, superseded)
        };
        if let Some(id) = superseded {
            let payload = serde_json::json!({ "id": id });
            let _ = app.emit_to("main", "o8:visual-capture-superseded", &payload);
            let _ = app.emit_to(SPATIAL_INK_LABEL, "o8:visual-capture-superseded", &payload);
        }

        if let Some(win) = app.get_webview_window(SPATIAL_INK_LABEL) {
            if let Some(monitor) = monitor {
                reposition_to_monitor(&win, monitor);
            }
            apply_macos_recipe(&win);
            // CAPTURE the mouse — pointer events now reach the ink page.
            let _ = win.set_ignore_cursor_events(false);
            order_front_nonactivating(&win);
            log::info!("[spatial-ink] armed (mouse capture on)");
        } else {
            log::warn!("[spatial-ink] arm: window missing");
        }

        // Belt-and-suspenders 90s safety: a stuck non-click-through full-screen
        // window would brick the mouse — this can never let that persist.
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(SAFETY_DISARM_SECS));
            if ARMED.load(Ordering::SeqCst) && ARM_GEN.load(Ordering::SeqCst) == generation {
                log::warn!("[spatial-ink] 90s safety auto-disarm (no teardown fired)");
                disarm_visual(&app2, generation);
            }
        });
        Some(generation)
    }

    /// End the hold: restore click-through and tell the page to clear its canvas.
    /// Idempotent — safe to call from any teardown path, armed or not.
    pub fn disarm(app: &tauri::AppHandle) {
        let _ = disarm_owned(app, None);
    }

    pub fn disarm_visual(app: &tauri::AppHandle, expected: u64) -> bool {
        disarm_owned(app, Some(expected))
    }

    fn disarm_owned(app: &tauri::AppHandle, expected: Option<u64>) -> bool {
        use tauri::{Emitter, Manager};
        let _change = OVERLAY_CHANGE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if expected.is_some_and(|generation| generation != ARM_GEN.load(Ordering::SeqCst)) {
            return false;
        }
        let was_armed = ARMED.swap(false, Ordering::SeqCst);
        lock_stash().visual_id = None;
        if let Some(win) = app.get_webview_window(SPATIAL_INK_LABEL) {
            // RESTORE click-through — clicks pass through again.
            let _ = win.set_ignore_cursor_events(true);
        }
        // Clear the page canvas (also its belt for a missed terminal STT event).
        crate::next_main::forward_ui_event("o8:spatial-ink-clear", serde_json::json!({}));
        let _ = app.emit_to(
            SPATIAL_INK_LABEL,
            "o8:spatial-ink-clear",
            serde_json::json!({}),
        );
        if was_armed {
            log::info!("[spatial-ink] disarmed (mouse capture off)");
        }
        true
    }

    pub fn is_armed() -> bool {
        ARMED.load(Ordering::SeqCst)
    }

    pub fn set_visual_interaction(app: &tauri::AppHandle, expected: u64, interactive: bool) {
        use tauri::Manager;
        let _change = OVERLAY_CHANGE
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if generation() != expected || !is_armed() {
            return;
        }
        if let Some(window) = app.get_webview_window(SPATIAL_INK_LABEL) {
            let _ = window.set_ignore_cursor_events(!interactive);
        }
    }

    pub fn take_visual_instruction(expected: u64, id: &str) -> Result<String, String> {
        let deadline = Instant::now() + Duration::from_millis(1500);
        loop {
            let stash = lock_stash();
            if stash.generation != expected || stash.visual_id.as_deref() != Some(id) || !is_armed()
            {
                return Err("The drawing owner changed before the instruction was saved.".into());
            }
            if stash.strokes.is_some() {
                return Ok(stash.instruction.clone());
            }
            drop(stash);
            if Instant::now() >= deadline {
                return Err("The drawing surface did not confirm its instruction.".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn generation() -> u64 {
        ARM_GEN.load(Ordering::SeqCst)
    }

    // ── JS → Rust event handlers ──

    fn on_first_stroke(app: &tauri::AppHandle, expected: Option<u64>) {
        let mut capture_generation = None;
        {
            let mut s = lock_stash();
            if is_armed()
                && expected.map_or(true, |generation| generation == s.generation)
                && !s.first_stroke_seen
            {
                s.first_stroke_seen = true;
                s.capturing = true;
                capture_generation = Some((s.generation, s.monitor.clone()));
            }
        }
        let Some((generation, monitor)) = capture_generation else {
            return;
        };
        // Capture the marked monitor NOW (before ink renders), off the main
        // thread — the ~300-600ms screencapture subprocess overlaps the operator
        // still drawing + talking, so finalize pays no extra latency.
        let app2 = app.clone();
        std::thread::spawn(move || {
            let cap = screen::capture_full(&app2, monitor);
            let mut s = lock_stash();
            if s.generation == generation {
                s.capture = cap;
                s.capturing = false;
            }
        });
    }

    fn stash_strokes(payload: StrokesPayload) {
        let mut s = lock_stash();
        if !is_armed()
            || s.visual_id != payload.visual_id
            || (s.visual_id.is_some() && payload.visual_generation != Some(s.generation))
        {
            return;
        }
        let count: usize = payload
            .strokes
            .iter()
            .map(|stroke| stroke.points.len())
            .sum();
        if payload.instruction.chars().count() > 16_000
            || payload.strokes.len() > 128
            || count > 8192
            || payload.strokes.iter().any(|stroke| {
                stroke.points.iter().any(|point| {
                    !point.x.is_finite()
                        || !point.y.is_finite()
                        || !point.t.is_finite()
                        || !(0.0..=1.0).contains(&point.x)
                        || !(0.0..=1.0).contains(&point.y)
                        || !(0.0..=3_600_000.0).contains(&point.t)
                })
            })
        {
            return;
        }
        s.instruction = payload.instruction.clone();
        s.strokes = Some(payload.into_points());
    }

    /// Register the JS → Rust event listeners once, after windows exist.
    pub fn register_listeners(app: &tauri::AppHandle) {
        use tauri::Listener;
        {
            let a = app.clone();
            app.listen("o8:spatial-ink-first-stroke", move |event| {
                forward_ink_event("o8:spatial-ink-first-stroke", event.payload());
                on_first_stroke(&a, None);
            });
        }
        {
            app.listen("o8:spatial-ink-strokes", move |event| {
                forward_ink_event("o8:spatial-ink-strokes", event.payload());
                match serde_json::from_str::<StrokesPayload>(event.payload()) {
                    Ok(p) => stash_strokes(p),
                    Err(e) => log::warn!("[spatial-ink] bad strokes payload: {e}"),
                }
            });
        }
        {
            let a = app.clone();
            app.listen("o8:spatial-ink-disarm-request", move |event| {
                forward_ink_event("o8:spatial-ink-disarm-request", event.payload());
                disarm(&a);
            });
        }
        log::info!("[spatial-ink] event listeners registered");
    }

    fn forward_ink_event(event: &str, payload: &str) {
        if let Ok(data) = serde_json::from_str(payload) {
            crate::next_main::forward_ui_event(event, data);
        }
    }

    // ── Drain at finalize ──

    /// Drain the stash and build the spatial images for the finishing agent turn.
    /// Returns None when the operator drew nothing (or the capture failed) — the
    /// turn then proceeds exactly as today, text-only, zero behavior change.
    pub fn take_spatial_context() -> Option<screen::SpatialContext> {
        // Wait briefly for an in-flight first-stroke capture AND for the strokes
        // event to land (both are fast vs finalize's own Whisper+polish latency).
        let deadline = Instant::now() + Duration::from_millis(1500);
        loop {
            let ready = {
                let s = lock_stash();
                if !s.first_stroke_seen {
                    // No stroke was ever drawn this session — nothing to do.
                    return None;
                }
                !s.capturing && s.strokes.is_some()
            };
            if ready || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(40));
        }

        let (capture, strokes) = {
            let mut s = lock_stash();
            let c = s.capture.take();
            let st = s.strokes.take();
            s.capturing = false;
            s.first_stroke_seen = false;
            (c, st)
        };

        let strokes = strokes?;
        if strokes.is_empty() {
            return None;
        }
        let capture = match capture {
            Some(c) => c,
            None => {
                log::warn!("[spatial-ink] strokes drawn but screen capture missing/failed");
                return None;
            }
        };
        screen::composite_strokes(&capture, &strokes)
    }

    #[cfg(test)]
    mod visual_tests {
        use super::*;
        #[test]
        fn notes_handoff_rejects_a_reused_identity_from_an_older_generation() {
            let old_stash = std::mem::replace(
                &mut *lock_stash(),
                Stash {
                    generation: 42,
                    visual_id: Some("frame-owned".into()),
                    ..Stash::new()
                },
            );
            let old_armed = ARMED.swap(true, Ordering::SeqCst);
            let payload = |generation, instruction| StrokesPayload {
                visual_id: Some("frame-owned".into()),
                visual_generation: Some(generation),
                strokes: Vec::new(),
                instruction,
            };
            stash_strokes(payload(41, "stale words".into()));
            assert!(lock_stash().strokes.is_none());
            assert!(take_visual_instruction(41, "frame-owned").is_err());
            assert!(take_visual_instruction(42, "another-frame").is_err());
            stash_strokes(payload(42, "Keep these exact words.".into()));
            assert_eq!(
                take_visual_instruction(42, "frame-owned").unwrap(),
                "Keep these exact words."
            );
            assert_eq!(lock_stash().visual_id.as_deref(), Some("frame-owned"));
            *lock_stash() = old_stash;
            ARMED.store(old_armed, Ordering::SeqCst);
        }
    }
}

#[cfg(target_os = "macos")]
pub use imp::{
    arm, arm_visual, create, cursor_monitor, disarm, disarm_visual, generation, is_armed,
    register_listeners, set_visual_interaction, take_spatial_context, take_visual_instruction,
};

// ── Non-macOS no-ops ──
#[cfg(not(target_os = "macos"))]
pub fn create(_app: &tauri::AppHandle, _api_port: u16) {}
#[cfg(not(target_os = "macos"))]
pub fn register_listeners(_app: &tauri::AppHandle) {}
#[cfg(not(target_os = "macos"))]
pub fn arm(_app: &tauri::AppHandle) {}
#[cfg(not(target_os = "macos"))]
pub fn disarm(_app: &tauri::AppHandle) {}
// No non-macOS take_spatial_context stub: its return type lives in the
// macOS-gated agent module and its only caller is macOS-gated too (#1673).
