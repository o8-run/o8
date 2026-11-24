//! Reads on change, not on a timer. The sidebar's global event stream counts
//! every thread, agent and lane event (and each reconnect); window activation
//! counts too. A view remembers the count it last read at and reads again only
//! when the count moves, or on its old cadence while a thread is running. An
//! untouched window with no agent working then makes no timed reads.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

static REVISION: AtomicU64 = AtomicU64::new(1);
/// `{"channel":"changed","event":"update"}` notices seen: the update status.
static UPDATE: AtomicU64 = AtomicU64::new(0);
static WORKING: AtomicBool = AtomicBool::new(false);
/// Wakes threads parked in `wait` when the revision moves.
static CHANGED: (Mutex<()>, Condvar) = (Mutex::new(()), Condvar::new());

/// Something the server reported may have changed what a view shows.
pub(crate) fn bump() {
    // Bumped under the lock, so a waiter between its check and its wait
    // cannot miss it.
    let _guard = CHANGED.0.lock().unwrap_or_else(PoisonError::into_inner);
    REVISION.fetch_add(1, Ordering::Relaxed);
    CHANGED.1.notify_all();
}
/// Parks a reader thread until the revision moves past `seen` or `limit`
/// passes, instead of waking each second to look.
pub(crate) fn wait(seen: u64, limit: Duration) {
    let guard = CHANGED.0.lock().unwrap_or_else(PoisonError::into_inner);
    let _ = CHANGED
        .1
        .wait_timeout_while(guard, limit, |_| revision() == seen)
        .unwrap_or_else(PoisonError::into_inner);
}
pub(crate) fn revision() -> u64 {
    REVISION.load(Ordering::Relaxed)
}
/// A server notice that one resource changed (`channel: "changed"`).
pub(crate) fn notice(resource: &str) {
    if resource == "update" {
        UPDATE.fetch_add(1, Ordering::Relaxed);
    }
}
/// Update-status notices so far; a view reads again when this moves.
pub(crate) fn update_notices() -> u64 {
    UPDATE.load(Ordering::Relaxed)
}
/// Whether a listed thread is running; the sidebar keeps this current.
pub(crate) fn set_working(working: bool) {
    WORKING.store(working, Ordering::Relaxed);
}
pub(crate) fn working() -> bool {
    WORKING.load(Ordering::Relaxed)
}
/// For data that also changes outside o8 (git state, local ports, usage): a
/// thread is running, or the user clicked or typed in the last minute (a
/// command they ran may still be changing it).
pub(crate) fn lively() -> bool {
    working() || crate::foreground::touched_within(Duration::from_secs(60))
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
    /// How long until `due` could pass with no change: the cadence left after
    /// the last read. A change can make it due sooner; see `wait`.
    pub(crate) fn idle_for(&self, every: Duration) -> Duration {
        self.at.map_or(Duration::ZERO, |at| {
            crate::foreground::cadence(every).saturating_sub(at.elapsed())
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
    fn a_parked_reader_wakes_on_a_change_not_on_a_timer() {
        let seen = revision();
        let bumper = std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(50));
            bump();
        });
        let start = Instant::now();
        wait(seen, Duration::from_secs(30));
        bumper.join().unwrap();
        assert!(start.elapsed() < Duration::from_secs(10), "a bump ends the wait");
        // With no change, the wait ends at its limit.
        let start = Instant::now();
        wait(revision(), Duration::from_millis(30));
        assert!(start.elapsed() >= Duration::from_millis(30));
    }

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
