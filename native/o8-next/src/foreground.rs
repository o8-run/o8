//! Whether the o8 window is in front. Timed reads keep their interval while it
//! is and wait at least a minute while it is not, so a window left behind
//! another app stops asking the server for the same answers every few seconds.
//!
//! Behind another app, hidden, minimized or offscreen, the window's reads also
//! carry `x-o8-foreground: 0`, and its sockets skip their keepalive messages:
//! the server's idle gate does not count either as someone using o8, so the
//! server can rest. Only reads carry the header. Anything the user does
//! happens with the window in front, so it never does.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static ACTIVE: AtomicBool = AtomicBool::new(true);
const BACKGROUND: Duration = Duration::from_secs(60);
/// The header the server's idle gate reads; `0` marks a background read.
pub(crate) const HEADER: &str = "x-o8-foreground";

/// Records the window's state; returns true when it has just come back to the front.
pub(crate) fn set(active: bool) -> bool {
    !ACTIVE.swap(active, Ordering::Relaxed) && active
}

pub(crate) fn active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

/// A poll's interval: `front` while the window is in front, a minute behind.
pub(crate) fn cadence(front: Duration) -> Duration {
    cadence_for(active(), front)
}

fn cadence_for(active: bool, front: Duration) -> Duration {
    if active { front } else { front.max(BACKGROUND) }
}

/// Marks a read made while the window is not in front.
pub(crate) fn mark(request: ureq::Request, method: &str) -> ureq::Request {
    mark_for(active(), request, method)
}

fn mark_for(active: bool, request: ureq::Request, method: &str) -> ureq::Request {
    if !active && matches!(method, "GET" | "HEAD") {
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
    fn only_reads_made_behind_another_app_carry_the_background_header() {
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
