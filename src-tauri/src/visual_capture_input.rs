// Modifier and pointer sampling adapted from Scrawl src/capture.rs.
// Copyright (c) 2026 Kit Langton. MIT; see ../third-party/visual-capture-MIT.txt.
use crate::visual_capture_packet::{Mark, Moment, Point};
use crate::visual_capture_session::Shared;
use std::ffi::c_void;
use std::sync::{atomic::Ordering, Arc};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

#[repr(C)]
struct Location {
    x: f64,
    y: f64,
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceFlagsState(state: i32) -> u64;
    fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
    fn CGEventCreate(source: *const c_void) -> *mut c_void;
    fn CGEventGetLocation(event: *const c_void) -> Location;
    fn CFRelease(value: *const c_void);
}

pub fn cursor() -> Option<[f64; 2]> {
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return None;
        }
        let location = CGEventGetLocation(event);
        CFRelease(event);
        (location.x.is_finite() && location.y.is_finite()).then_some([location.x, location.y])
    }
}

// Restrict local DOM evidence to the focused main webview on the primary display.
// Other displays and applications retain pixels without guessed element identities.
fn main_webview_rect(app: &tauri::AppHandle, screen: [f64; 4]) -> Option<[f64; 4]> {
    if screen[0].abs() > 1.0 || screen[1].abs() > 1.0 {
        return None;
    }
    let front = objc2_app_kit::NSWorkspace::sharedWorkspace().frontmostApplication()?;
    if front.processIdentifier() != std::process::id() as i32 {
        return None;
    }
    let window = crate::voice_host::classic_window(&app)?;
    if !window.is_focused().ok()? {
        return None;
    }
    let scale = window.scale_factor().ok()?;
    let position = window.inner_position().ok()?;
    let size = window.inner_size().ok()?;
    let rect = [
        position.x as f64 / scale,
        position.y as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale,
    ];
    (rect[0] >= 0.0
        && rect[1] >= 0.0
        && rect[0] + rect[2] <= screen[2]
        && rect[1] + rect[3] <= screen[3])
        .then_some(rect)
}

pub fn run(app: tauri::AppHandle, id: String, generation: u64, shared: Arc<Shared>) {
    let mut stroke: Vec<Point> = Vec::new();
    let mut frozen = None;
    let mut revision = 0;
    let mut webview_rect = None;
    let mut was_down = false;
    let mut interactive = true;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut point_count = 0;
    let publish = |phase: &str, point: &Point| {
        let _ = app.emit_to(
            "spatial-ink",
            "o8:visual-capture-ink",
            serde_json::json!({"id": id, "generation": generation, "phase": phase, "point": point}),
        );
    };
    while !shared.stopping.load(Ordering::Acquire)
        && crate::spatial_ink_window::generation() == generation
        && crate::spatial_ink_window::is_armed()
    {
        let Some([screen_x, screen_y]) = cursor() else {
            std::thread::sleep(Duration::from_millis(16));
            continue;
        };
        let [left, top, width, height] = shared.bounds;
        let x = (screen_x - left) / width;
        let y = (screen_y - top) / height;
        let inside = (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y);
        let at_ms = shared.started.elapsed().as_millis().min(90_000) as u64;
        let (over_widget, typing) = {
            let widget = shared
                .widget
                .lock()
                .unwrap_or_else(|value| value.into_inner());
            (
                widget.as_ref().is_some_and(|widget| {
                    widget.regions.iter().any(|rect| {
                        screen_x - left >= rect.left
                            && screen_x - left < rect.left + rect.width
                            && screen_y - top >= rect.top
                            && screen_y - top < rect.top + rect.height
                    })
                }),
                widget.as_ref().is_some_and(|widget| widget.typing),
            )
        };
        let flags = unsafe { CGEventSourceFlagsState(0) | CGEventSourceFlagsState(1) };
        let draw = flags & (1 << 17) != 0
            && flags & ((1 << 18) | (1 << 19) | (1 << 20)) == 0
            && !typing
            && !over_widget
            && inside;
        let next_interactive = draw || over_widget;
        if next_interactive != interactive {
            crate::spatial_ink_window::set_visual_interaction(&app, generation, next_interactive);
            interactive = next_interactive;
        }
        if draw
            && point_count < 8_192
            && shared
                .marks
                .lock()
                .unwrap_or_else(|value| value.into_inner())
                .len()
                < 128
        {
            let moved = stroke
                .last()
                .is_none_or(|previous| (previous.x - x).abs() + (previous.y - y).abs() > 0.0005);
            if moved && last_emit.elapsed() >= Duration::from_millis(16) {
                let point = Point { x, y, t: at_ms };
                if stroke.is_empty() {
                    revision = shared.snapshots.next_revision();
                    webview_rect = main_webview_rect(&app, shared.bounds);
                    let _ = app.emit_to("main", "o8:visual-capture-mark", serde_json::json!({"captureId":id,"generation":generation,"revision":revision,"phase":"start"}));
                }
                frozen = shared.snapshots.freeze(at_ms);
                publish(if stroke.is_empty() { "start" } else { "move" }, &point);
                stroke.push(point);
                point_count += 1;
                last_emit = Instant::now();
            }
        } else if !stroke.is_empty() {
            if let Some(point) = stroke.last() {
                publish("end", point);
            }
            let mark = Mark {
                points: std::mem::take(&mut stroke),
            };
            shared
                .marks
                .lock()
                .unwrap_or_else(|value| value.into_inner())
                .push(mark.clone());
            let _ = app.emit_to("main", "o8:visual-capture-mark", serde_json::json!({"captureId":id,"generation":generation,"revision":revision,"phase":"end"}));
            let current_rect = main_webview_rect(&app, shared.bounds);
            let local_rect = webview_rect.filter(|rect| Some(*rect) == current_rect);
            if !shared
                .snapshots
                .enqueue(mark, frozen.take(), revision, local_rect)
            {
                let _ = app.emit_to("main", "o8:visual-capture-observation-error", serde_json::json!({"captureId":id,"generation":generation,"revision":revision,"error":"Screen inspection is busy. The original recording is retained."}));
            }
        }
        let down = unsafe { CGEventSourceButtonState(1, 0) };
        if down && !was_down && !draw && !over_widget && !typing && inside {
            let mut events = shared
                .events
                .lock()
                .unwrap_or_else(|value| value.into_inner());
            if events.len() < 512 {
                events.push(Moment {
                    at_ms: at_ms.saturating_add(250).min(90_000),
                    kind: "click".into(),
                    x,
                    y,
                });
            }
        }
        was_down = down;
        std::thread::sleep(Duration::from_millis(16));
    }
    if !stroke.is_empty() {
        shared
            .marks
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .push(Mark { points: stroke });
    }
    crate::spatial_ink_window::set_visual_interaction(&app, generation, false);
}
