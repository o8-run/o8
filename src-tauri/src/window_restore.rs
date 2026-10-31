use serde::Deserialize;
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};

const MIN_WIDTH: f64 = 400.0;
const MIN_HEIGHT: f64 = 300.0;
const MAX_WORK_AREA_RATIO: f64 = 0.8;
const LAUNCH_CLAMP_DELAYS_MS: [u64; 3] = [75, 250, 750];
const EVENT_CLAMP_DELAY_MS: u64 = 150;

static EVENT_CLAMP_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClampIntent {
    Launch { baseline_generation: u64 },
    LiveEvent,
}

/// Read the current geometry-activity generation without advancing it —
/// the baseline a launch clamp checks itself against when it finally runs.
fn capture_geometry_activity_generation() -> u64 {
    EVENT_CLAMP_GENERATION.load(Ordering::Relaxed)
}

/// Record a live Moved/Resized/ScaleFactorChanged event, advancing the
/// shared generation counter, and return the new value.
fn note_geometry_activity() -> u64 {
    EVENT_CLAMP_GENERATION.fetch_add(1, Ordering::Relaxed) + 1
}

/// True once geometry activity newer than `generation` has been recorded —
/// i.e. a timer holding `generation` was queued before that activity and
/// must not act on stale geometry.
fn geometry_activity_advanced_past(generation: u64) -> bool {
    EVENT_CLAMP_GENERATION.load(Ordering::Relaxed) != generation
}

#[derive(Clone, Copy, Debug, Deserialize)]
struct SavedWindowState {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
}

#[derive(Clone, Copy, Debug)]
struct LogicalRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Debug)]
struct RestoreDecision {
    rect: LogicalRect,
    changed: bool,
    clear_zoom_state: bool,
}

fn clamp_main_window(app: &AppHandle, window: &WebviewWindow, intent: ClampIntent) {
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    if monitors.is_empty() {
        return;
    }

    let saved = read_saved_main_state(app);
    let Ok(current_pos) = window.outer_position() else {
        return;
    };
    let Ok(current_size) = window.outer_size() else {
        return;
    };

    let saved_physical =
        saved.map(|state| (state.x, state.y, state.width.max(1), state.height.max(1)));
    let current_physical = (
        current_pos.x,
        current_pos.y,
        current_size.width.max(1),
        current_size.height.max(1),
    );
    let probe = clamp_probe(intent, saved_physical, current_physical);
    let (target, disconnected) = target_monitor(window, &monitors, probe);
    let Some(target) = target else { return };

    let scale = target.scale_factor().max(1.0);
    let work = target.work_area();
    let work_physical = (
        work.position.x,
        work.position.y,
        work.size.width,
        work.size.height,
    );
    let work_rect = logical_rect(work_physical, scale);
    let current_rect = logical_rect(current_physical, scale);

    let decision = decide_restore_rect(current_rect, work_rect, disconnected);
    if decision.clear_zoom_state {
        if window.is_fullscreen().unwrap_or(false) {
            let _ = window.set_fullscreen(false);
        }
        if window.is_maximized().unwrap_or(false) {
            let _ = window.unmaximize();
        }
    }
    if decision.changed {
        let _ = window.set_size(LogicalSize::new(decision.rect.width, decision.rect.height));
        let _ = window.set_position(LogicalPosition::new(decision.rect.x, decision.rect.y));
        log::info!(
            "[window-restore] clamped main window to {:.0}x{:.0} at {:.0},{:.0}",
            decision.rect.width,
            decision.rect.height,
            decision.rect.x,
            decision.rect.y
        );
    }
}

pub(crate) fn schedule_launch_clamps(app: &AppHandle) {
    let baseline_generation = capture_geometry_activity_generation();
    for delay_ms in LAUNCH_CLAMP_DELAYS_MS {
        schedule_clamp_after(
            app.clone(),
            Duration::from_millis(delay_ms),
            ClampIntent::Launch {
                baseline_generation,
            },
        );
    }
}

pub(crate) fn schedule_event_clamp(app: &AppHandle) {
    let generation = note_geometry_activity();
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(EVENT_CLAMP_DELAY_MS));
        if geometry_activity_advanced_past(generation) {
            return;
        }
        run_clamp_on_main_thread(app, ClampIntent::LiveEvent);
    });
}

fn schedule_clamp_after(app: AppHandle, delay: Duration, intent: ClampIntent) {
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        run_clamp_on_main_thread(app, intent);
    });
}

fn run_clamp_on_main_thread(app: AppHandle, intent: ClampIntent) {
    let app_for_clamp = app.clone();
    let _ = app.run_on_main_thread(move || {
        run_clamp_callback(intent, move || {
            if let Some(window) = crate::voice_host::classic_window(&app_for_clamp) {
                clamp_main_window(&app_for_clamp, &window, intent);
            }
        });
    });
}

/// The freshness gate the main-thread callback runs through before it is
/// allowed to mutate the window. Re-checked here — at the moment the
/// callback actually executes on the main thread — so a launch callback
/// queued before a newer Moved/Resized/ScaleFactorChanged event can no
/// longer win after that event landed: `mutate` only runs when this
/// callback is still the newest word on window geometry.
fn run_clamp_callback(intent: ClampIntent, mutate: impl FnOnce()) {
    if let ClampIntent::Launch {
        baseline_generation,
    } = intent
    {
        if geometry_activity_advanced_past(baseline_generation) {
            log::info!(
                "[window-restore] skipping stale launch clamp; newer window geometry activity superseded it"
            );
            return;
        }
    }
    mutate();
}

fn clamp_probe(
    intent: ClampIntent,
    saved: Option<(i32, i32, u32, u32)>,
    current: (i32, i32, u32, u32),
) -> (i32, i32, u32, u32) {
    match intent {
        ClampIntent::Launch { .. } => saved.unwrap_or(current),
        ClampIntent::LiveEvent => current,
    }
}

fn logical_rect(rect: (i32, i32, u32, u32), scale: f64) -> LogicalRect {
    LogicalRect {
        x: rect.0 as f64 / scale,
        y: rect.1 as f64 / scale,
        width: rect.2 as f64 / scale,
        height: rect.3 as f64 / scale,
    }
}

fn read_saved_main_state(app: &AppHandle) -> Option<SavedWindowState> {
    let path = app
        .path()
        .app_config_dir()
        .ok()?
        .join(tauri_plugin_window_state::DEFAULT_FILENAME);
    let content = std::fs::read_to_string(path).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&content).ok()?;
    serde_json::from_value(json.get("main")?.clone()).ok()
}

fn target_monitor(
    window: &WebviewWindow,
    monitors: &[tauri::Monitor],
    rect: (i32, i32, u32, u32),
) -> (Option<tauri::Monitor>, bool) {
    let best = monitors
        .iter()
        .map(|monitor| (monitor, intersection_area(rect, monitor)))
        .max_by_key(|(_, area)| *area);
    if let Some((monitor, _area)) = best.filter(|(_, area)| *area > 0) {
        return (Some(monitor.clone()), false);
    }

    let fallback = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.first().cloned());
    (fallback, true)
}

fn intersection_area(rect: (i32, i32, u32, u32), monitor: &tauri::Monitor) -> i64 {
    let work = monitor.work_area();
    let left = (rect.0 as i64).max(work.position.x as i64);
    let top = (rect.1 as i64).max(work.position.y as i64);
    let right =
        (rect.0 as i64 + rect.2 as i64).min(work.position.x as i64 + work.size.width as i64);
    let bottom =
        (rect.1 as i64 + rect.3 as i64).min(work.position.y as i64 + work.size.height as i64);
    (right - left).max(0) * (bottom - top).max(0)
}

fn decide_restore_rect(
    current: LogicalRect,
    work: LogicalRect,
    disconnected: bool,
) -> RestoreDecision {
    let exceeds_work = current.width > work.width || current.height > work.height;
    if disconnected || exceeds_work {
        let width = clamp_dimension(current.width, work.width, MIN_WIDTH);
        let height = clamp_dimension(current.height, work.height, MIN_HEIGHT);
        return RestoreDecision {
            rect: LogicalRect {
                x: work.x + (work.width - width).max(0.0) / 2.0,
                y: work.y + (work.height - height).max(0.0) / 2.0,
                width,
                height,
            },
            changed: true,
            clear_zoom_state: disconnected,
        };
    }

    let x = current
        .x
        .max(work.x)
        .min((work.x + work.width - current.width).max(work.x));
    let y = current
        .y
        .max(work.y)
        .min((work.y + work.height - current.height).max(work.y));
    RestoreDecision {
        rect: LogicalRect {
            x,
            y,
            width: current.width,
            height: current.height,
        },
        changed: (x - current.x).abs() > f64::EPSILON || (y - current.y).abs() > f64::EPSILON,
        clear_zoom_state: false,
    }
}

fn clamp_dimension(saved: f64, work: f64, min: f64) -> f64 {
    saved.min(work * MAX_WORK_AREA_RATIO).max(min.min(work))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// EVENT_CLAMP_GENERATION is a process-global static; serialize the
    /// handful of tests that advance it so parallel test threads can't
    /// interleave their generation bumps.
    static GENERATION_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock_generation_tests() -> std::sync::MutexGuard<'static, ()> {
        GENERATION_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn live_event_uses_current_geometry_across_negative_mixed_scale_displays() {
        let saved = (-2200, 100, 1600, 1200);
        let current = (400, 200, 1600, 1200);
        let probe = clamp_probe(ClampIntent::LiveEvent, Some(saved), current);
        assert_eq!(probe, current);
        let current_rect = logical_rect(current, 2.0);
        let work_rect = logical_rect((0, 0, 3840, 2160), 2.0);
        let decision = decide_restore_rect(current_rect, work_rect, false);
        assert!(!decision.changed);
        assert!(decision.rect.x >= 0.0);
    }

    #[test]
    fn centers_oversized_window_at_eighty_percent_of_work_area() {
        let decision = decide_restore_rect(
            LogicalRect {
                x: 10.0,
                y: 20.0,
                width: 4000.0,
                height: 1600.0,
            },
            LogicalRect {
                x: 0.0,
                y: 24.0,
                width: 1440.0,
                height: 876.0,
            },
            false,
        );

        assert!(decision.changed);
        assert!(!decision.clear_zoom_state);
        assert_eq!(decision.rect.width, 1152.0);
        assert!((decision.rect.height - 700.8).abs() < 0.001);
        assert_eq!(decision.rect.x, 144.0);
        assert!((decision.rect.y - 111.6).abs() < 0.001);
    }

    #[test]
    fn centers_disconnected_window_and_clears_zoom_state() {
        let probe = clamp_probe(
            ClampIntent::Launch {
                baseline_generation: 0,
            },
            Some((5000, 200, 900, 700)),
            (0, 0, 800, 600),
        );
        assert_eq!(probe.0, 5000);
        let decision = decide_restore_rect(
            LogicalRect {
                x: 5000.0,
                y: 200.0,
                width: 900.0,
                height: 700.0,
            },
            LogicalRect {
                x: 0.0,
                y: 0.0,
                width: 1200.0,
                height: 800.0,
            },
            true,
        );

        assert!(decision.changed);
        assert!(decision.clear_zoom_state);
        assert_eq!(decision.rect.width, 900.0);
        assert_eq!(decision.rect.height, 640.0);
        assert_eq!(decision.rect.x, 150.0);
        assert_eq!(decision.rect.y, 80.0);
    }

    #[test]
    fn clamps_position_without_resizing_when_window_fits() {
        let decision = decide_restore_rect(
            LogicalRect {
                x: -80.0,
                y: 10.0,
                width: 800.0,
                height: 600.0,
            },
            LogicalRect {
                x: 0.0,
                y: 24.0,
                width: 1440.0,
                height: 876.0,
            },
            false,
        );

        assert!(decision.changed);
        assert_eq!(decision.rect.width, 800.0);
        assert_eq!(decision.rect.height, 600.0);
        assert_eq!(decision.rect.x, 0.0);
        assert_eq!(decision.rect.y, 24.0);
    }

    #[test]
    fn launch_clamp_is_superseded_by_geometry_activity_after_it_was_scheduled() {
        let _guard = lock_generation_tests();

        // Simulate schedule_launch_clamps capturing a baseline generation at
        // launch, before spawning the delayed clamp attempts.
        let baseline_generation = capture_geometry_activity_generation();

        // No live geometry activity yet: a launch attempt checked against
        // this baseline must still be allowed to run, preserving #1405/#718
        // startup recovery when nothing has moved the window.
        assert!(!geometry_activity_advanced_past(baseline_generation));

        // A live Moved/Resized/ScaleFactorChanged event fires while the
        // launch callback is still queued (sleeping, or sitting in
        // run_on_main_thread's queue) - production calls
        // note_geometry_activity() for every such event.
        let live_generation = note_geometry_activity();

        // The already-queued launch callback must be recognized as stale the
        // instant it actually runs on the main thread, even though it was
        // scheduled before the move happened.
        assert!(geometry_activity_advanced_past(baseline_generation));

        // A fresh baseline captured *after* the move must not be considered
        // stale by that same event.
        let post_move_baseline = capture_geometry_activity_generation();
        assert!(!geometry_activity_advanced_past(post_move_baseline));
        assert_eq!(post_move_baseline, live_generation);

        // A live-event timer that itself goes stale because a newer live
        // event superseded it (existing EVENT_CLAMP_GENERATION behavior)
        // must still be detected via the same freshness helper.
        let stale_live_generation = note_geometry_activity();
        let _newer_live_generation = note_geometry_activity();
        assert!(geometry_activity_advanced_past(stale_live_generation));
    }

    /// Exercises the real `run_clamp_callback` — the exact function the
    /// main-thread closure in `run_clamp_on_main_thread` invokes — so this
    /// fails if the freshness guard is ever removed or bypassed, not just
    /// if the generation helpers it calls are removed.
    #[test]
    fn stale_launch_callback_skips_its_mutation_closure() {
        use std::sync::atomic::AtomicBool;

        let _guard = lock_generation_tests();

        // A launch timer captures its baseline at schedule time...
        let baseline_generation = capture_geometry_activity_generation();
        // ...then a live Moved/Resized/ScaleFactorChanged event lands before
        // the timer's queued callback actually runs on the main thread.
        note_geometry_activity();

        let invoked = AtomicBool::new(false);
        run_clamp_callback(
            ClampIntent::Launch {
                baseline_generation,
            },
            || {
                invoked.store(true, Ordering::Relaxed);
            },
        );

        assert!(
            !invoked.load(Ordering::Relaxed),
            "a launch callback superseded by newer geometry activity must not invoke its mutation closure"
        );
    }

    /// Paired with the test above: a launch callback with no newer geometry
    /// activity since its baseline must still mutate, preserving #1405/#718
    /// startup recovery when nothing has moved the window.
    #[test]
    fn fresh_launch_callback_still_invokes_its_mutation_closure() {
        use std::sync::atomic::AtomicBool;

        let _guard = lock_generation_tests();

        let baseline_generation = capture_geometry_activity_generation();

        let invoked = AtomicBool::new(false);
        run_clamp_callback(
            ClampIntent::Launch {
                baseline_generation,
            },
            || {
                invoked.store(true, Ordering::Relaxed);
            },
        );

        assert!(
            invoked.load(Ordering::Relaxed),
            "an unsuperseded launch callback must still invoke its mutation closure"
        );
    }

    #[test]
    fn leaves_valid_window_unchanged() {
        let decision = decide_restore_rect(
            LogicalRect {
                x: 80.0,
                y: 80.0,
                width: 900.0,
                height: 650.0,
            },
            LogicalRect {
                x: 0.0,
                y: 24.0,
                width: 1440.0,
                height: 876.0,
            },
            false,
        );

        assert!(!decision.changed);
        assert!(!decision.clear_zoom_state);
    }
}
