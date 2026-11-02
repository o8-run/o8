//! Repairs the main WKWebView after a window crosses macOS displays with
//! different backing scale factors.
//!
//! AppKit can move an unchanged NSWindow frame from Retina to non-Retina without
//! resizing its content view. WKWebView then keeps the old physical-pixel frame
//! as its logical point frame until the user manually resizes the window. Fit the
//! webview back to its parent view's point-space bounds on the scale event, then
//! repeat once after AppKit finishes the monitor transition.

use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tauri::{AppHandle, Manager, WebviewWindow};

const SETTLE_DELAY_MS: u64 = 120;
static REPAIR_GENERATION: AtomicU64 = AtomicU64::new(0);

pub(crate) fn repair_main_webview_frame(window: &WebviewWindow) {
    if let Err(error) = window.with_webview(|webview| {
        use objc2_web_kit::WKWebView;

        // SAFETY: Tauri supplies the live main-thread WKWebView for this closure.
        // Its superview owns the point-space bounds the webview must fill.
        unsafe {
            let view: &WKWebView = &*webview.inner().cast();
            let Some(parent) = view.superview() else {
                return;
            };
            view.setFrame(parent.bounds());
            parent.setNeedsLayout(true);
            parent.layoutSubtreeIfNeeded();
            view.setNeedsDisplay(true);
        }
    }) {
        log::warn!("[display-scale] failed to schedule WKWebView frame repair: {error}");
    }
}

pub(crate) fn schedule_main_webview_frame_repair(app: &AppHandle) {
    let generation = REPAIR_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(SETTLE_DELAY_MS));
        if REPAIR_GENERATION.load(Ordering::Relaxed) != generation {
            return;
        }
        let app_for_repair = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            if let Some(window) = crate::voice_host::classic_window(&app_for_repair) {
                repair_main_webview_frame(&window);
            }
        }) {
            log::warn!("[display-scale] failed to dispatch settled WKWebView repair: {error}");
        }
    });
}
