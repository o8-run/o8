//! Idle policy for the macOS refresh driver. Time is supplied by the caller.
use std::time::{Duration, Instant};

pub(super) struct FrameClock {
    last_activity: Instant,
}

impl FrameClock {
    pub(super) fn new(now: Instant) -> Self {
        Self { last_activity: now }
    }

    pub(super) fn wake(&mut self, now: Instant) {
        self.last_activity = now;
    }

    pub(super) fn completed(&mut self, now: Instant, drew: bool) -> bool {
        if drew {
            self.wake(now);
        }
        now.saturating_duration_since(self.last_activity) >= Duration::from_millis(100)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_stop_at_100ms_without_a_draw() {
        let start = Instant::now();
        let mut clock = FrameClock::new(start);
        assert!(!clock.completed(start + Duration::from_millis(99), false));
        assert!(clock.completed(start + Duration::from_millis(100), false));
        assert!(clock.completed(start + Duration::from_secs(60), false));
    }

    #[test]
    fn idle_checks_do_not_extend_the_active_period() {
        let start = Instant::now();
        let mut clock = FrameClock::new(start);
        for milliseconds in [16, 32, 48, 64, 80, 96] {
            assert!(!clock.completed(start + Duration::from_millis(milliseconds), false));
        }
        assert!(clock.completed(start + Duration::from_millis(112), false));
    }

    #[test]
    fn a_draw_extends_the_grace_period() {
        let start = Instant::now();
        let mut clock = FrameClock::new(start);
        assert!(!clock.completed(start + Duration::from_millis(90), true));
        assert!(!clock.completed(start + Duration::from_millis(189), false));
        assert!(clock.completed(start + Duration::from_millis(190), false));
    }

    #[test]
    fn input_data_resize_and_animation_can_resume_a_paused_driver() {
        let start = Instant::now();
        let mut clock = FrameClock::new(start);
        for seconds in [1, 2, 3, 4] {
            let now = start + Duration::from_secs(seconds);
            assert!(clock.completed(now, false));
            clock.wake(now);
            assert!(!clock.completed(now + Duration::from_millis(16), false));
            assert!(!clock.completed(now + Duration::from_millis(32), true));
        }
    }
}
