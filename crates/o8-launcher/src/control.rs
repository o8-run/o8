//! Private, bounded instance control. Reopen remains responsive during preflight.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::{
        fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        io::AsRawFd,
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, TrySendError},
        Arc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
#[derive(Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Request {
    Show,
    PrepareRestart,
    CancelRestart { reservation: String },
    Restart { reservation: String },
}
struct Pending {
    request: Request,
    peer: UnixStream,
}
pub struct Instance {
    _lock: File,
    queue: Receiver<Pending>,
    show: Arc<AtomicBool>,
    halt: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    socket: PathBuf,
}
fn read_request(peer: &mut UnixStream) -> io::Result<Request> {
    // Accepted sockets inherit nonblocking mode on some Unix platforms.
    peer.set_nonblocking(false)?;
    peer.set_read_timeout(Some(Duration::from_millis(100)))?;
    peer.set_write_timeout(Some(Duration::from_millis(100)))?;
    let mut bytes = Vec::new();
    Read::by_ref(peer).take(4097).read_to_end(&mut bytes)?;
    if bytes.len() > 4096 {
        return Err(io::Error::other("Oversized launcher command"));
    }
    Ok(serde_json::from_slice(&bytes)?)
}
impl Instance {
    pub fn claim(directory: &Path) -> io::Result<Option<Self>> {
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(directory.join("launcher.lock"))?;
        let metadata = lock.metadata()?;
        if metadata.uid() != unsafe { libc::getuid() }
            || metadata.nlink() != 1
            || !metadata.is_file()
        {
            return Err(io::Error::other("Foreign instance lock"));
        }
        if unsafe { libc::fchmod(lock.as_raw_fd(), 0o600) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let socket = directory.join("launcher.sock");
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            if io::Error::last_os_error().kind() != io::ErrorKind::WouldBlock {
                return Err(io::Error::last_os_error());
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Ok(mut peer) = UnixStream::connect(&socket) {
                    peer.set_read_timeout(Some(Duration::from_secs(5)))?;
                    peer.write_all(b"{\"op\":\"show\"}\n")?;
                    peer.shutdown(std::net::Shutdown::Write)?;
                    let mut response = Vec::new();
                    peer.take(4096).read_to_end(&mut response)?;
                    let receipt: serde_json::Value = serde_json::from_slice(&response)?;
                    if receipt["ok"] != true {
                        return Err(io::Error::other("Existing launcher refused reopen"));
                    }
                    return Ok(None);
                }
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Existing launcher unavailable",
                    ));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
        if let Ok(metadata) = fs::symlink_metadata(&socket) {
            if !metadata.file_type().is_socket() || UnixStream::connect(&socket).is_ok() {
                return Err(io::Error::other("Foreign instance socket"));
            }
            fs::remove_file(&socket)?;
        }
        let listener = UnixListener::bind(&socket)?;
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        let (send, queue) = mpsc::sync_channel::<Pending>(16);
        let show = Arc::new(AtomicBool::new(false));
        let queued_show = show.clone();
        let halt = Arc::new(AtomicBool::new(false));
        let stopping = halt.clone();
        let worker = std::thread::Builder::new()
            .name("launcher-control".into())
            .spawn(move || {
                while !stopping.load(Ordering::SeqCst) {
                    let mut peer = match listener.accept() {
                        Ok((peer, _)) => peer,
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(10));
                            continue;
                        }
                        Err(_) => break,
                    };
                    let Ok(request) = read_request(&mut peer) else {
                        continue;
                    };
                    if matches!(request, Request::Show) {
                        // A bool coalesces repeated reopen requests without allocating a queue.
                        queued_show.store(true, Ordering::SeqCst);
                        let _ = peer.write_all(b"{\"ok\":true}\n");
                    } else if let Err(TrySendError::Full(mut pending)) =
                        send.try_send(Pending { request, peer })
                    {
                        let _ = pending
                            .peer
                            .write_all(b"{\"ok\":false,\"error\":\"Launcher is busy\"}\n");
                    }
                }
            })?;
        Ok(Some(Self {
            _lock: lock,
            queue,
            show,
            halt,
            worker: Some(worker),
            socket,
        }))
    }
    pub fn receive(&self) -> io::Result<Option<(Request, Option<UnixStream>)>> {
        if self.show.swap(false, Ordering::SeqCst) {
            return Ok(Some((Request::Show, None)));
        }
        match self.queue.try_recv() {
            Ok(pending) => Ok(Some((pending.request, Some(pending.peer)))),
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => {
                Err(io::Error::other("Instance control stopped"))
            }
        }
    }
}
impl Drop for Instance {
    fn drop(&mut self) {
        self.halt.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        let _ = fs::remove_file(&self.socket);
    }
}
