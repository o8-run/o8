//! One in-flight save and one replaceable pending snapshot per shell.
use crate::shell_state::State;
use async_channel::{Receiver, Sender};
use std::{
    path::PathBuf,
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};

type Saved = Result<(), String>;
const COALESCE_DELAY: Duration = Duration::from_millis(50);

struct Queue {
    pending: Option<State>,
    changed: Instant,
    writing: bool,
    stopping: bool,
    flushes: Vec<Sender<Saved>>,
}

struct Shared {
    queue: Mutex<Queue>,
    wake: Condvar,
}

pub(crate) struct Writer {
    shared: Arc<Shared>,
}

impl Writer {
    pub(crate) fn new(file: PathBuf) -> (Self, Receiver<String>) {
        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue {
                pending: None,
                changed: Instant::now(),
                writing: false,
                stopping: false,
                flushes: vec![],
            }),
            wake: Condvar::new(),
        });
        let worker = shared.clone();
        // Reporting a slow or failed disk must not create another backlog.
        let (errors, receiver) = async_channel::bounded(1);
        std::thread::Builder::new()
            .name("shell-state-writer".into())
            .spawn(move || {
                loop {
                    let state = {
                        let mut queue = worker.queue.lock().unwrap();
                        loop {
                            if queue.pending.is_none() {
                                if queue.stopping {
                                    return;
                                }
                                queue = worker.wake.wait(queue).unwrap();
                                continue;
                            }
                            // A close flush and shutdown bypass the debounce.
                            if !queue.stopping && queue.flushes.is_empty() {
                                let delay = COALESCE_DELAY.saturating_sub(queue.changed.elapsed());
                                if !delay.is_zero() {
                                    queue = worker.wake.wait_timeout(queue, delay).unwrap().0;
                                    continue;
                                }
                            }
                            queue.writing = true;
                            break queue.pending.take().unwrap();
                        }
                    };
                    // Never hold the queue lock across serialization or disk I/O.
                    let result = state.save(&file);
                    if let Err(error) = &result {
                        let _ = errors.try_send(error.clone());
                    }
                    let flushes = {
                        let mut queue = worker.queue.lock().unwrap();
                        queue.writing = false;
                        if queue.pending.is_none() {
                            std::mem::take(&mut queue.flushes)
                        } else {
                            vec![]
                        }
                    };
                    for flush in flushes {
                        let _ = flush.try_send(result.clone());
                    }
                }
            })
            .expect("start shell state writer");
        (Self { shared }, receiver)
    }

    pub(crate) fn submit(&self, state: State) {
        self.enqueue(state, None);
    }

    pub(crate) fn flush(&self, state: State) -> Receiver<Saved> {
        let (sender, receiver) = async_channel::bounded(1);
        self.enqueue(state, Some(sender));
        receiver
    }

    fn enqueue(&self, state: State, flush: Option<Sender<Saved>>) {
        let mut queue = self.shared.queue.lock().unwrap();
        queue.pending = Some(state);
        queue.changed = Instant::now();
        if let Some(flush) = flush {
            queue.flushes.push(flush);
        }
        self.shared.wake.notify_one();
    }

    pub(crate) fn is_idle(&self) -> bool {
        let queue = self.shared.queue.lock().unwrap();
        !queue.writing && queue.pending.is_none()
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        let mut queue = self.shared.queue.lock().unwrap();
        queue.stopping = true;
        self.shared.wake.notify_one();
    }
}
