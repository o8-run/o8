//! Test-only barrier at the real state writer boundary.
use super::State;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

static ACTIVE: OnceLock<Mutex<HashMap<PathBuf, Arc<Barrier>>>> = OnceLock::new();

struct Barrier {
    released: Mutex<bool>,
    wake: Condvar,
    forced: AtomicBool,
    writes: Mutex<Vec<[f32; 4]>>,
    started: Mutex<Option<mpsc::Sender<()>>>,
}

pub(crate) struct Hold {
    file: PathBuf,
    barrier: Arc<Barrier>,
    started: Option<mpsc::Receiver<()>>,
}

pub(crate) fn hold(file: &Path) -> Hold {
    let (sender, receiver) = mpsc::channel();
    let barrier = Arc::new(Barrier {
        released: Mutex::new(false),
        wake: Condvar::new(),
        forced: AtomicBool::new(false),
        writes: Mutex::new(vec![]),
        started: Mutex::new(Some(sender)),
    });
    assert!(
        ACTIVE
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(file.to_owned(), barrier.clone())
            .is_none()
    );
    Hold {
        file: file.to_owned(),
        barrier,
        started: Some(receiver),
    }
}

impl Hold {
    pub(crate) fn input_watchdog(&mut self) -> (mpsc::Sender<()>, thread::JoinHandle<()>) {
        let started = self.started.take().unwrap();
        let barrier = self.barrier.clone();
        let (sender, receiver) = mpsc::channel();
        let task = thread::spawn(move || {
            if started.recv_timeout(Duration::from_secs(5)).is_err()
                || receiver.recv_timeout(Duration::from_secs(30)).is_err()
            {
                barrier.forced.store(true, Ordering::SeqCst);
                *barrier.released.lock().unwrap() = true;
                barrier.wake.notify_all();
            }
        });
        (sender, task)
    }
    pub(crate) fn forced(&self) -> bool {
        self.barrier.forced.load(Ordering::SeqCst)
    }
    pub(crate) fn writes(&self) -> Vec<[f32; 4]> {
        self.barrier.writes.lock().unwrap().clone()
    }
    pub(crate) fn release(&self) {
        *self.barrier.released.lock().unwrap() = true;
        self.barrier.wake.notify_all();
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        self.release();
        ACTIVE.get().unwrap().lock().unwrap().remove(&self.file);
    }
}

pub(crate) fn before_save(file: &Path, state: &State) {
    let barrier = ACTIVE
        .get()
        .and_then(|active| active.lock().unwrap().get(file).cloned());
    let Some(barrier) = barrier else {
        return;
    };
    barrier.writes.lock().unwrap().push(state.bounds);
    if let Some(sender) = barrier.started.lock().unwrap().take() {
        let _ = sender.send(());
    }
    let mut released = barrier.released.lock().unwrap();
    while !*released {
        released = barrier.wake.wait(released).unwrap();
    }
}
