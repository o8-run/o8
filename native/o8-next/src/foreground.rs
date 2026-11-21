//! Whether the o8 window is in front. Timed reads keep their interval while it
//! is and wait at least a minute while it is not, so a window left behind
//! another app stops asking the server for the same answers every few seconds.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static ACTIVE: AtomicBool = AtomicBool::new(true);
const BACKGROUND: Duration = Duration::from_secs(60);

pub(crate) fn set(active: bool) {
    ACTIVE.store(active, Ordering::Relaxed);
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
}
