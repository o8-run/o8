//! Bounded, one-shot shutdown shared by native termination and the headless path.
//!
//! AppKit waits inside `terminate:` after a "terminate later" answer and runs no
//! further launcher code on the main thread. Cleanup therefore runs here, off the
//! main thread, and the caller-supplied reply hops back through the main queue.
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, PoisonError,
    },
    time::{Duration, Instant},
};

/// Total time from a termination request to its reply: half of launchd's
/// default 20-second exit timeout, so logout and restart are never the ones waiting.
pub const SHUTDOWN_BOUND: Duration = Duration::from_secs(10);
/// Kept after the server deadline for lock release and dialog reaping.
const RELEASE_RESERVE: Duration = Duration::from_millis(500);
/// Kept after the server deadline so a stop that ends exactly on time still reports.
const REPORT_RESERVE: Duration = Duration::from_millis(500);

type Job = Box<dyn FnOnce(Instant) -> Result<(), String> + Send>;
type Release = Box<dyn FnOnce() + Send>;
type Reply = Box<dyn FnOnce(bool) + Send>;

pub struct Shutdown {
    bound: Duration,
    job: Mutex<Option<Job>>,
    release: Mutex<Option<Release>>,
    begun: AtomicBool,
    failed: AtomicBool,
}

impl Shutdown {
    pub fn new(bound: Duration) -> Self {
        Self {
            bound,
            job: Mutex::new(None),
            release: Mutex::new(None),
            begun: AtomicBool::new(false),
            failed: AtomicBool::new(false),
        }
    }
    /// `job` stops servers and must escalate by the deadline it receives.
    /// `release` drops the instance lock and socket; it runs before any reply.
    pub fn arm(
        &self,
        job: impl FnOnce(Instant) -> Result<(), String> + Send + 'static,
        release: impl FnOnce() + Send + 'static,
    ) {
        *self.job.lock().unwrap_or_else(PoisonError::into_inner) = Some(Box::new(job));
        *self.release.lock().unwrap_or_else(PoisonError::into_inner) = Some(Box::new(release));
    }
    /// A stop failed or overran its bound. Native termination maps this to the exit status.
    pub fn failed(&self) -> bool {
        self.failed.load(Ordering::SeqCst)
    }
    /// Starts cleanup on its own thread. `reply(true)` runs exactly once after
    /// release, also on failure or timeout. A repeated request is absorbed.
    pub fn begin(self: &Arc<Self>, reply: impl FnOnce(bool) + Send + 'static) -> bool {
        if self.begun.swap(true, Ordering::SeqCst) {
            return false;
        }
        let slot: Arc<Mutex<Option<Reply>>> = Arc::new(Mutex::new(Some(Box::new(reply))));
        let this = self.clone();
        let worker = slot.clone();
        let spawned = std::thread::Builder::new()
            .name("launcher-shutdown".into())
            .spawn(move || {
                let _ = this.finish();
                if let Some(reply) = worker.lock().unwrap_or_else(PoisonError::into_inner).take() {
                    reply(true);
                }
            });
        if spawned.is_err() {
            let _ = self.finish();
            if let Some(reply) = slot.lock().unwrap_or_else(PoisonError::into_inner).take() {
                reply(true);
            }
        }
        true
    }
    /// Runs the same bounded cleanup on the calling thread.
    pub fn run(&self) -> Result<(), String> {
        if self.begun.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.finish()
    }
    fn finish(&self) -> Result<(), String> {
        let started = Instant::now();
        let reply_by = started + self.bound;
        let report_by = reply_by.checked_sub(RELEASE_RESERVE).unwrap_or(started);
        let escalate_by = report_by.checked_sub(REPORT_RESERVE).unwrap_or(started);
        let job = self
            .job
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let result = match job {
            None => Ok(()),
            Some(job) => {
                // The job runs on its own thread so a hung inspection cannot hold the reply.
                let (send, receive) = mpsc::sync_channel(1);
                let slot = Arc::new(Mutex::new(Some(job)));
                let worker = slot.clone();
                let spawned = std::thread::Builder::new()
                    .name("launcher-stop".into())
                    .spawn(move || {
                        let job = worker.lock().unwrap_or_else(PoisonError::into_inner).take();
                        if let Some(job) = job {
                            let _ = send.send(job(escalate_by));
                        }
                    });
                match spawned {
                    Ok(_) => receive
                        .recv_timeout(report_by.saturating_duration_since(Instant::now()))
                        .unwrap_or_else(|_| {
                            Err(format!(
                                "server stop exceeded the {} s shutdown bound",
                                self.bound.as_secs()
                            ))
                        }),
                    Err(_) => match slot.lock().unwrap_or_else(PoisonError::into_inner).take() {
                        Some(job) => job(escalate_by),
                        None => Err("Shutdown worker unavailable".into()),
                    },
                }
            }
        };
        if let Err(error) = &result {
            eprintln!("Shutdown incomplete: {error}");
            self.failed.store(true, Ordering::SeqCst);
        }
        let release = self
            .release
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(release) = release {
            release();
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn replies(shutdown: &Arc<Shutdown>) -> (Arc<AtomicUsize>, mpsc::Receiver<Instant>) {
        let count = Arc::new(AtomicUsize::new(0));
        let (send, receive) = mpsc::channel();
        for _ in 0..2 {
            let count = count.clone();
            let send = send.clone();
            shutdown.begin(move |allowed| {
                assert!(allowed);
                count.fetch_add(1, Ordering::SeqCst);
                let _ = send.send(Instant::now());
            });
        }
        (count, receive)
    }

    #[test]
    fn replies_once_after_a_successful_stop() {
        let shutdown = Arc::new(Shutdown::new(Duration::from_secs(2)));
        shutdown.arm(|_| Ok(()), || {});
        let (count, receive) = replies(&shutdown);
        receive.recv_timeout(Duration::from_secs(2)).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(!shutdown.failed());
    }

    #[test]
    fn replies_once_and_records_failure_when_stopping_fails() {
        let shutdown = Arc::new(Shutdown::new(Duration::from_secs(2)));
        shutdown.arm(|_| Err("stop failed".into()), || {});
        let (count, receive) = replies(&shutdown);
        receive.recv_timeout(Duration::from_secs(2)).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(shutdown.failed());
    }

    #[test]
    fn a_hung_stop_is_cut_off_at_the_bound_and_still_replies_once() {
        let bound = Duration::from_millis(1500);
        let shutdown = Arc::new(Shutdown::new(bound));
        let (escalation, deadline) = mpsc::channel();
        shutdown.arm(
            move |escalate_by| {
                let _ = escalation.send(escalate_by);
                std::thread::sleep(Duration::from_secs(30));
                Ok(())
            },
            || {},
        );
        let started = Instant::now();
        let (count, receive) = replies(&shutdown);
        let replied = receive.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(replied.duration_since(started) <= bound + Duration::from_millis(200));
        assert!(deadline.recv().unwrap() < started + bound);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(shutdown.failed());
    }

    #[test]
    fn the_real_stop_deadline_leaves_room_to_report_within_the_bound() {
        let shutdown = Shutdown::new(SHUTDOWN_BOUND);
        let (send, receive) = mpsc::channel();
        shutdown.arm(
            move |escalate_by| {
                let _ = send.send(escalate_by);
                Ok(())
            },
            || {},
        );
        let started = Instant::now();
        shutdown.run().unwrap();
        let finished = Instant::now();
        let escalate_by = receive.recv().unwrap();
        let headroom = RELEASE_RESERVE + REPORT_RESERVE;
        assert!(escalate_by <= finished + SHUTDOWN_BOUND - headroom);
        assert!(escalate_by >= started + SHUTDOWN_BOUND - headroom);
    }

    #[test]
    fn instance_lock_and_socket_are_released_before_the_reply() {
        use std::{fs, os::unix::io::AsRawFd};
        let root =
            std::path::PathBuf::from("/tmp").join(format!("o8-shutdown-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let instance = crate::control::Instance::claim(&root).unwrap().unwrap();
        let socket = root.join("launcher.sock");
        assert!(socket.exists());
        let held = Arc::new(Mutex::new(Some(instance)));
        let shutdown = Arc::new(Shutdown::new(Duration::from_secs(2)));
        let release = held.clone();
        shutdown.arm(
            |_| Err("stop failed".into()),
            move || {
                drop(release.lock().unwrap().take());
            },
        );
        let (send, receive) = mpsc::channel();
        let (lock_path, socket_path) = (root.join("launcher.lock"), socket.clone());
        shutdown.begin(move |_| {
            let lock = fs::File::open(&lock_path).unwrap();
            let free = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
            let _ = send.send((free, socket_path.exists()));
        });
        let (lock_free, socket_left) = receive.recv_timeout(Duration::from_secs(3)).unwrap();
        fs::remove_dir_all(&root).unwrap();
        assert!(lock_free, "instance lock still held at reply");
        assert!(!socket_left, "control socket still present at reply");
    }
}
