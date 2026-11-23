//! Reads on change, not on a timer. The sidebar's global event stream counts
//! every thread, agent and lane event (and each reconnect); window activation
//! counts too. A view remembers the count it last read at and reads again only
//! when the count moves, or on its old cadence while a thread is running. An
//! untouched window with no agent working then makes no timed reads.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

static REVISION: AtomicU64 = AtomicU64::new(1);
static WORKING: AtomicBool = AtomicBool::new(false);

/// Something the server reported may have changed what a view shows.
pub(crate) fn bump() {
    REVISION.fetch_add(1, Ordering::Relaxed);
}
pub(crate) fn revision() -> u64 {
    REVISION.load(Ordering::Relaxed)
}
/// Whether a listed thread is running; the sidebar keeps this current.
pub(crate) fn set_working(working: bool) {
    WORKING.store(working, Ordering::Relaxed);
}
pub(crate) fn working() -> bool {
    WORKING.load(Ordering::Relaxed)
}

/// One view's last read.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Follow {
    seen: u64,
    at: Option<Instant>,
}
impl Follow {
    /// Read now: never read, or `every` has passed and something changed
    /// since the last read or `busy` (work is running).
    pub(crate) fn due(&self, every: Duration, busy: bool) -> bool {
        self.due_at(revision(), crate::foreground::cadence(every), busy)
    }
    fn due_at(&self, revision: u64, every: Duration, busy: bool) -> bool {
        self.at.is_none_or(|at| {
            (self.seen != revision || busy) && at.elapsed() >= every
        })
    }
    /// A read starts: a change after this point reads again.
    pub(crate) fn read(&mut self) {
        self.seen = revision();
        self.at = Some(Instant::now());
    }
    /// The next due check reads at once.
    pub(crate) fn expire(&mut self) {
        self.at = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_untouched_view_reads_once_then_only_on_change_or_running_work() {
        let mut follow = Follow::default();
        assert!(follow.due_at(5, Duration::ZERO, false), "first read");
        follow.seen = 5;
        follow.at = Some(Instant::now());
        assert!(!follow.due_at(5, Duration::ZERO, false), "nothing changed");
        assert!(follow.due_at(6, Duration::ZERO, false), "an event arrived");
        assert!(follow.due_at(5, Duration::ZERO, true), "work is running");
        assert!(!follow.due_at(6, Duration::from_secs(60), false), "still within cadence");
        follow.expire();
        assert!(follow.due_at(5, Duration::from_secs(60), false), "expired");
    }
}
