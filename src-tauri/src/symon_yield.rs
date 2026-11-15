//! Yield the system voice keys to the standalone Symon app.
//!
//! Symon (bundle `com.misterlabs.symon`) carries o8's Fn dictation, read-back
//! and Right Option gestures as its own app. When both run, each one's
//! listen-only key tap sees every press, so one Fn hold would record twice and
//! paste twice. While Symon is running, o8's key tap ignores voice keys; when
//! Symon quits, o8 handles them again on the next poll.

use std::sync::atomic::{AtomicBool, Ordering};

/// Bundle identifier of the standalone Symon app.
pub const SYMON_BUNDLE_ID: &str = "com.misterlabs.symon";

static SYMON_ACTIVE: AtomicBool = AtomicBool::new(false);
static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

/// True while Symon is running, as of the last poll (at most ~2 s old).
pub fn symon_active() -> bool {
    SYMON_ACTIVE.load(Ordering::Relaxed)
}

/// Record a new poll result. Returns true when the state changed.
fn record(active: bool) -> bool {
    SYMON_ACTIVE.swap(active, Ordering::Relaxed) != active
}

#[cfg(target_os = "macos")]
fn symon_running() -> bool {
    use objc2_app_kit::NSRunningApplication;
    use objc2_foundation::NSString;

    crate::paste::run_on_main_thread(|| {
        let bundle_id = NSString::from_str(SYMON_BUNDLE_ID);
        NSRunningApplication::runningApplicationsWithBundleIdentifier(&bundle_id).count() > 0
    })
}

/// Start the 2 s poll. A second call is a no-op.
#[cfg(target_os = "macos")]
pub fn start_watcher() {
    if WATCHER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| loop {
        let active = symon_running();
        if record(active) {
            if active {
                log::info!("[symon-yield] Symon is running; o8 leaves the voice keys to it");
            } else {
                log::info!("[symon-yield] Symon is not running; o8 handles the voice keys");
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    });
}

#[cfg(not(target_os = "macos"))]
pub fn start_watcher() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_reports_only_changes() {
        record(false);
        assert!(!record(false));
        assert!(record(true));
        assert!(symon_active());
        assert!(!record(true));
        assert!(record(false));
        assert!(!symon_active());
    }
}
