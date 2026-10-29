//! Desktop motion. Durations and the ease follow the framer-motion transitions
//! they mirror; callers request animation frames while `value` reports travel.
use std::time::{Duration, Instant};

/// cubic-bezier(0.22, 1, 0.36, 1), the desktop's panel and popover ease.
pub fn ease_out(t: f32) -> f32 {
    bezier(0.22, 1., 0.36, 1., t)
}

fn bezier(x1: f32, y1: f32, x2: f32, y2: f32, t: f32) -> f32 {
    let t = t.clamp(0., 1.);
    let curve = |a: f32, b: f32, s: f32| {
        let u = 1. - s;
        3. * u * u * s * a + 3. * u * s * s * b + s * s * s
    };
    // x(s) is monotonic for these control points, so bisection finds s for t.
    let (mut low, mut high) = (0f32, 1f32);
    for _ in 0..24 {
        let mid = (low + high) / 2.;
        if curve(x1, x2, mid) < t {
            low = mid;
        } else {
            high = mid;
        }
    }
    curve(y1, y2, (low + high) / 2.)
}

/// A two-state transition between closed (0) and open (1).
#[derive(Clone, Copy)]
pub struct Transition {
    open: bool,
    changed: Option<Instant>,
    duration: Duration,
}

impl Transition {
    pub const fn new(milliseconds: u64) -> Self {
        Self {
            open: false,
            changed: None,
            duration: Duration::from_millis(milliseconds),
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    /// Starts travel toward `open`. A reversal mid-flight continues from where
    /// the transition is rather than jumping to the far end.
    pub fn set(&mut self, open: bool) {
        if self.open == open {
            return;
        }
        let travelled = self.linear();
        self.open = open;
        let remaining = self.duration.mul_f32(1. - travelled);
        self.changed = Instant::now().checked_sub(remaining).or(Some(Instant::now()));
    }

    /// Linear progress toward the current state, 0 to 1.
    fn linear(&self) -> f32 {
        match self.changed {
            _ if self.duration.is_zero() => 1.,
            None => 1.,
            Some(changed) => {
                (changed.elapsed().as_secs_f32() / self.duration.as_secs_f32()).min(1.)
            }
        }
    }

    /// The eased position (0 closed, 1 open) and whether it is still moving.
    pub fn value(&self) -> (f32, bool) {
        let t = self.linear();
        let eased = ease_out(t);
        (if self.open { eased } else { 1. - eased }, t < 1.)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ease_runs_from_rest_to_rest_and_front_loads_travel() {
        assert!(ease_out(0.).abs() < 1e-4);
        assert!((ease_out(1.) - 1.).abs() < 1e-4);
        // A strong ease-out is most of the way there by a third of the time.
        assert!(ease_out(0.33) > 0.75);
    }

    #[test]
    fn a_settled_transition_reports_its_end_state() {
        let mut motion = Transition::new(0);
        assert_eq!(motion.value(), (0., false));
        motion.set(true);
        assert_eq!(motion.value().0, 1.);
        assert!(!motion.value().1);
    }
}
