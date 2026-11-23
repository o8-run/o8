//! Whether the o8 window is in front, and whether anyone can see it. Timed
//! reads keep their interval while it is in front and wait at least a minute
//! while it is visible behind another app, so a window left on a second display
//! stays current without asking every few seconds. While nobody can see it
//! (covered, minimized, hidden, on another Space or offscreen), timed reads
//! stop; the first tick after it shows again reads once, as every interval has
//! passed by then.
//!
//! A read the user did not cause carries `x-o8-foreground: 0`: every read made
//! behind another app, hidden, minimized or offscreen, and, in front, every read
//! that does not follow a click or keypress within a few seconds (timers and
//! socket events). The server's idle gate does not count those as someone
//! using o8, so an untouched window lets the server rest. Only reads carry the
//! header; writes always count.
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

static ACTIVE: AtomicBool = AtomicBool::new(true);
static VISIBLE: AtomicBool = AtomicBool::new(true);
const BACKGROUND: Duration = Duration::from_secs(60);
/// The header the server's idle gate reads; `0` marks a read the user did not cause.
pub(crate) const HEADER: &str = "x-o8-foreground";
/// How long after a click or keypress the window's reads count as the user's.
const INPUT_WINDOW: Duration = Duration::from_secs(3);
/// Milliseconds after `epoch()` of the last click or keypress, plus one; 0 is never.
static INPUT: AtomicU64 = AtomicU64::new(0);

fn epoch() -> Instant {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    *EPOCH.get_or_init(Instant::now)
}

/// Records a click or keypress in the window.
pub(crate) fn touched() {
    INPUT.store(epoch().elapsed().as_millis() as u64 + 1, Ordering::Relaxed);
}

fn recent_input() -> bool {
    recent_at(epoch().elapsed().as_millis() as u64 + 1, INPUT.load(Ordering::Relaxed))
}

fn recent_at(now: u64, input: u64) -> bool {
    input != 0 && now.saturating_sub(input) <= INPUT_WINDOW.as_millis() as u64
}

/// Records the window's state; returns true when it has just come back to the front.
pub(crate) fn set(active: bool) -> bool {
    !ACTIVE.swap(active, Ordering::Relaxed) && active
}

pub(crate) fn active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

/// Records whether any part of the window is on screen.
pub(crate) fn set_visible(visible: bool) {
    VISIBLE.store(visible, Ordering::Relaxed);
}

/// Nobody can see the window: timed reads wait until it shows again.
pub(crate) fn hidden() -> bool {
    hidden_for(active(), VISIBLE.load(Ordering::Relaxed))
}

fn hidden_for(active: bool, visible: bool) -> bool {
    !active && !visible
}

/// Whether AppKit draws any part of the window. Other platforms report no
/// occlusion, so a window there counts as visible.
#[cfg(target_os = "macos")]
pub(crate) fn on_screen(window: &gpui::Window) -> bool {
    use objc::{msg_send, sel, sel_impl};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    const VISIBLE_STATE: usize = 1 << 1;
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return true;
    };
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return true;
    };
    let view = handle.ns_view.as_ptr() as cocoa::base::id;
    // SAFETY: the view belongs to this live GPUI window on the main thread.
    unsafe {
        let ns_window: cocoa::base::id = msg_send![view, window];
        if ns_window.is_null() {
            return true;
        }
        let state: usize = msg_send![ns_window, occlusionState];
        state & VISIBLE_STATE != 0
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn on_screen(_: &gpui::Window) -> bool {
    true
}

/// A poll's interval: `front` while the window is in front, a minute behind.
pub(crate) fn cadence(front: Duration) -> Duration {
    cadence_for(active(), front)
}

fn cadence_for(active: bool, front: Duration) -> Duration {
    if active { front } else { front.max(BACKGROUND) }
}

/// Marks a read the user did not cause.
pub(crate) fn mark(request: ureq::Request, method: &str) -> ureq::Request {
    mark_for(active() && recent_input(), request, method)
}

fn mark_for(users: bool, request: ureq::Request, method: &str) -> ureq::Request {
    if !users && matches!(method, "GET" | "HEAD") {
        request.set(HEADER, "0")
    } else {
        request
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_window_behind_another_app_polls_at_most_once_a_minute() {
        assert_eq!(cadence_for(false, Duration::from_secs(3)), BACKGROUND);
        assert_eq!(
            cadence_for(false, Duration::from_secs(300)),
            Duration::from_secs(300)
        );
        assert_eq!(
            cadence_for(true, Duration::from_secs(3)),
            Duration::from_secs(3)
        );
    }

    #[test]
    fn only_a_window_nobody_can_see_stops_its_timed_reads() {
        assert!(hidden_for(false, false));
        assert!(!hidden_for(false, true), "visible behind another app keeps reading");
        assert!(!hidden_for(true, false));
        assert!(!hidden_for(true, true));
    }

    #[test]
    fn reads_count_as_the_users_only_for_seconds_after_a_click_or_keypress() {
        assert!(!recent_at(10_000, 0), "no input yet");
        assert!(recent_at(10_000, 9_000));
        assert!(recent_at(10_000, 7_000));
        assert!(!recent_at(10_000, 6_999));
    }

    #[test]
    fn only_reads_the_user_caused_go_unmarked() {
        let agent = ureq::agent();
        let header = |active, method: &str| {
            mark_for(active, agent.request(method, "http://127.0.0.1:1/"), method)
                .header(HEADER)
                .map(str::to_owned)
        };
        assert_eq!(header(false, "GET").as_deref(), Some("0"));
        assert_eq!(header(false, "HEAD").as_deref(), Some("0"));
        assert_eq!(header(false, "POST"), None);
        assert_eq!(header(false, "PATCH"), None);
        assert_eq!(header(true, "GET"), None);
    }
}
