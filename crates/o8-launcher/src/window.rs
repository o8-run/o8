//! With Next off, the launcher owns the native window (#6529).
//!
//! The window's stdin is its lifeline (`native/o8-next/src/app_parent.rs`):
//! it exits at EOF. When a WS server owned that pipe, every WS restart closed
//! the window. Here the launcher holds the lifeline, so the window outlives WS
//! and reconnects through o8d. Only Quit, which drops the lifeline, ends it.
//!
//! WS keeps the browser-agent control channel by attaching to a private,
//! owner-only socket with a launcher key, as Node attaches to o8d as producer.
//! Lines from WS go to the window's stdin. Result lines from the window go to
//! the WS attached at that moment. Each WS generation attaches again.
use super::Config;
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::unix::{
        fs::{FileTypeExt, MetadataExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex, PoisonError,
    },
    time::{Duration, Instant},
};

const READY: &str = "o8-next-ready";
const RESULT: &str = "o8-next-browser-result:";
/// The window's ⌘Q and app-menu Quit (#6532). Only this launcher reads the
/// window's stdout, so the request reaches this instance and no other.
const QUIT: &str = "o8-next-quit";
/// The same spawn-to-first-paint bound the server used (`app-window.ts`).
const READY_WITHIN: Duration = Duration::from_secs(15);
/// The window drops a control frame larger than this; so does the relay.
const FRAME_LIMIT: usize = 1024 * 1024;
/// Control frames waiting for the window. A full queue drops new frames, so a
/// window that stops reading never blocks WS, Show, reopen or Quit.
const QUEUED_FRAMES: usize = 32;
/// After the lifeline closes, how long a window may take to exit before it is
/// killed: the same one second the server gave it (`app-window.ts`). The rest
/// of the shared shutdown deadline stays with o8d and the servers.
const EXIT_WITHIN: Duration = Duration::from_secs(1);
/// Unauthenticated local handshakes in flight, as the o8d producer socket bounds them.
const HANDSHAKES: usize = 16;
/// The window only needs the variables that display a native window.
const DISPLAY: [&str; 14] = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "WINDIR",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
];

fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(super) fn control_socket(data_dir: &Path) -> Result<PathBuf, String> {
    let path = data_dir.join("window-control.sock");
    let address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if path.as_os_str().len() >= address.sun_path.len() {
        return Err("O8_DATA_DIR is too long for the private window socket; choose a shorter data directory".into());
    }
    Ok(path)
}

fn peer_is_owner(stream: &UnixStream) -> bool {
    use std::os::fd::AsRawFd;
    #[cfg(target_os = "linux")]
    {
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        (unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut length,
            )
        }) == 0
            && credentials.uid == unsafe { libc::geteuid() }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let (mut uid, mut gid) = (0, 0);
        (unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) }) == 0
            && uid == unsafe { libc::geteuid() }
    }
}

/// Binds the private socket under the o8d producer socket's rules (#6527).
/// Anything already at the path is kept unless it is an unchanged, dead socket
/// this user owns privately: a regular file, symlink, foreign or shared socket,
/// or a socket something still listens on is never unlinked. Returns the bound
/// socket's identity, so cleanup removes only this instance's socket.
fn bind_private(path: &Path) -> std::io::Result<(UnixListener, (u64, u64))> {
    use std::io::{Error, ErrorKind};
    if !path.is_absolute() {
        return Err(Error::other("absolute window socket required"));
    }
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if !meta.file_type().is_socket()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o077 != 0
        {
            return Err(Error::other("private window socket required"));
        }
        match UnixStream::connect(path) {
            Err(error) if error.kind() == ErrorKind::ConnectionRefused => {}
            _ => return Err(Error::other("window socket already owned")),
        }
        let current = std::fs::symlink_metadata(path)?;
        if (current.dev(), current.ino()) != (meta.dev(), meta.ino()) {
            return Err(Error::other("window socket changed"));
        }
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    let meta = std::fs::symlink_metadata(path)?;
    Ok((listener, (meta.dev(), meta.ino())))
}

/// Unlinks the path only while it is still the socket this instance bound.
/// Call it before the listener closes: the open listener pins the socket's
/// inode, so no replacement at the path can reuse its (dev, inode) meanwhile.
/// `Window` keeps the listener in its accept thread for the launcher's life.
fn unlink_if_bound(path: &Path, identity: (u64, u64)) {
    if std::fs::symlink_metadata(path)
        .ok()
        .is_some_and(|meta| (meta.dev(), meta.ino()) == identity)
    {
        let _ = std::fs::remove_file(path);
    }
}

fn same_key(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

/// Reads one newline-terminated frame, or `None` at EOF, error or oversize.
fn frame(reader: &mut impl BufRead) -> Option<Vec<u8>> {
    let mut line = Vec::new();
    match reader
        .by_ref()
        .take(FRAME_LIMIT as u64 + 1)
        .read_until(b'\n', &mut line)
    {
        Ok(0) | Err(_) => None,
        Ok(_) if line.len() > FRAME_LIMIT || line.last() != Some(&b'\n') => None,
        Ok(_) => Some(line),
    }
}

#[derive(Default)]
struct Relay {
    /// Queue to the current window's writer thread, which alone owns the
    /// lifeline. The lock is held only for a non-blocking send, never a write.
    input: Mutex<Option<mpsc::SyncSender<Vec<u8>>>>,
    /// The WS generation attached now, which receives result lines.
    attached: Mutex<Option<(u64, UnixStream)>>,
    /// Set when the window asks to quit o8; the main loop answers it.
    quit: AtomicBool,
}

pub(super) struct Window {
    relay: Arc<Relay>,
    socket: PathBuf,
    identity: (u64, u64),
    key: String,
    child: Option<Child>,
    stopped: bool,
}

impl Window {
    /// Binds the control socket before WS starts, so WS can attach at boot.
    pub(super) fn bind(config: &Config) -> Result<Self, String> {
        let socket = control_socket(&config.data_dir)?;
        let (listener, identity) = bind_private(&socket).map_err(|_| {
            "Window control unavailable: another o8 or file holds window-control.sock"
        })?;
        let key = uuid::Uuid::new_v4().to_string();
        let relay = Arc::new(Relay::default());
        let (accepting, expected) = (relay.clone(), key.clone());
        std::thread::spawn(move || {
            let mut generation = 0u64;
            let pending = Arc::new(AtomicUsize::new(0));
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                if pending.load(Ordering::SeqCst) >= HANDSHAKES {
                    continue;
                }
                generation += 1;
                attach(
                    &accepting,
                    stream,
                    expected.as_bytes(),
                    generation,
                    &pending,
                );
            }
        });
        Ok(Self {
            relay,
            socket,
            identity,
            key,
            child: None,
            stopped: false,
        })
    }

    pub(super) fn socket(&self) -> &Path {
        &self.socket
    }

    pub(super) fn key(&self) -> &str {
        &self.key
    }

    /// True while this launcher's window process runs. Reaps one that exited.
    pub(super) fn running(&mut self) -> bool {
        let Some(child) = self.child.as_mut() else {
            return false;
        };
        if matches!(child.try_wait(), Ok(None)) {
            return true;
        }
        self.child = None;
        *lock(&self.relay.input) = None;
        false
    }

    /// Tells the running window that opened files are waiting, so it takes
    /// them now instead of asking every 250 ms. False when it cannot be told.
    pub(super) fn announce_documents(&self) -> bool {
        lock(&self.relay.input).as_ref().is_some_and(|input| {
            input
                .try_send(b"{\"type\":\"open-files\"}\n".to_vec())
                .is_ok()
        })
    }

    /// True once the window asked to quit o8 (#6532). The launcher's own
    /// bounded shutdown answers it, as it answers Dock Quit.
    pub(super) fn quit_requested(&self) -> bool {
        self.relay.quit.load(Ordering::SeqCst)
    }

    /// Starts the window and reports first paint without blocking the event loop.
    pub(super) fn open(
        &mut self,
        config: &Config,
        token: &str,
    ) -> mpsc::Receiver<Result<(), String>> {
        let (send, receive) = mpsc::channel();
        if self.running() {
            let _ = send.send(Ok(()));
            return receive;
        }
        let mut command = Command::new(&config.window);
        command
            .args(["--enable-next", "--app-shell", "--server"])
            .arg(format!("http://127.0.0.1:{}", config.api_port))
            .arg("--shell-state")
            .arg(config.data_dir.join("next-shell.json"))
            .current_dir(&config.data_dir)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for name in DISPLAY {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .env("O8_NEXT_API_TOKEN", token)
            .env("O8_NEXT_PARENT_PIPE", "1")
            // Quit belongs to this launcher, not to the window process (#6532).
            .env("O8_NEXT_QUIT_VIA_PARENT", "1");
        // Hands pages the window freed after start-up back to macOS; the window
        // drops it before it starts anything else.
        #[cfg(target_os = "macos")]
        command.env(o8_launch_core::server_env::MALLOC_SPACE_EFFICIENT, "1");
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                let _ = send.send(Err(
                    "o8 next (GPUI) could not start. The binary may be missing or unavailable."
                        .into(),
                ));
                return receive;
            }
        };
        let output = child.stdout.take();
        *lock(&self.relay.input) = child.stdin.take().map(writer);
        let pid = child.id();
        self.child = Some(child);
        let (ready, painted) = mpsc::channel();
        let relay = self.relay.clone();
        std::thread::spawn(move || {
            let Some(output) = output else { return };
            let mut output = BufReader::new(output);
            while let Some(line) = frame(&mut output) {
                let text = String::from_utf8_lossy(&line);
                if text.trim_end() == READY {
                    let _ = ready.send(());
                } else if text.trim_end() == QUIT {
                    relay.quit.store(true, Ordering::SeqCst);
                    crate::native::wake();
                } else if text.starts_with(RESULT) {
                    let mut attached = lock(&relay.attached);
                    if let Some((_, stream)) = attached.as_mut() {
                        if stream.write_all(&line).is_err() {
                            *attached = None;
                        }
                    }
                }
            }
            // Output ends as the window exits; `running` reaps it after this.
            super::wait_exited(pid);
            crate::native::wake();
        });
        std::thread::spawn(move || {
            let _ = send.send(match painted.recv_timeout(READY_WITHIN) {
                Ok(()) => Ok(()),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // Matches the server's startup bound: reap the window.
                    unsafe {
                        libc::kill(pid as i32, libc::SIGKILL);
                    }
                    Err("o8 next (GPUI) did not become ready within 15 seconds.".into())
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => Err(
                    "o8 next (GPUI) crashed or exited before its first window was ready.".into(),
                ),
            });
        });
        receive
    }

    /// Drops the lifeline so the window exits as it did when its server
    /// stopped, then escalates within the shared shutdown deadline.
    pub(super) fn stop(&mut self, deadline: Instant) -> Result<(), String> {
        if self.stopped {
            return Ok(());
        }
        self.stopped = true;
        // Closing the queue ends an idle writer and its lifeline. A writer
        // stuck on a window that stopped reading is never waited for: the
        // kill below closes that pipe.
        *lock(&self.relay.input) = None;
        // A result write is bounded by its timeout; never wait on it here.
        if let Ok(mut attached) = self.relay.attached.try_lock() {
            if let Some((_, stream)) = attached.take() {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        }
        unlink_if_bound(&self.socket, self.identity);
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        let grace = (Instant::now() + EXIT_WITHIN).min(
            deadline
                .checked_sub(Duration::from_millis(500))
                .unwrap_or(deadline),
        );
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Err(_) => return Err("Window reap failed".into()),
                Ok(None) if Instant::now() >= grace => break,
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        let _ = child.kill();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                _ => return Err("Window reap deadline".into()),
            }
        }
    }
}

impl Drop for Window {
    fn drop(&mut self) {
        let _ = self.stop(Instant::now() + super::SHUTDOWN_BOUND);
    }
}

/// The window's only stdin writer. Dropping the queue's last sender ends the
/// thread and closes the lifeline once no write is in progress.
fn writer(mut stdin: ChildStdin) -> mpsc::SyncSender<Vec<u8>> {
    let (send, frames) = mpsc::sync_channel::<Vec<u8>>(QUEUED_FRAMES);
    std::thread::spawn(move || {
        while let Ok(frame) = frames.recv() {
            if stdin.write_all(&frame).and_then(|_| stdin.flush()).is_err() {
                break;
            }
        }
    });
    send
}

/// One WS generation: same user, then the launcher key, then frames until it
/// leaves. A newer generation replaces an older one.
fn attach(
    relay: &Arc<Relay>,
    stream: UnixStream,
    key: &[u8],
    generation: u64,
    pending: &Arc<AtomicUsize>,
) {
    if !peer_is_owner(&stream) {
        return;
    }
    let relay = relay.clone();
    let key = key.to_vec();
    pending.fetch_add(1, Ordering::SeqCst);
    let pending = pending.clone();
    std::thread::spawn(move || {
        // Released when the handshake ends, accepted or not.
        struct Handshake(Arc<AtomicUsize>);
        impl Drop for Handshake {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        let mut handshake = Some(Handshake(pending));
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let Ok(results) = stream.try_clone() else {
            return;
        };
        // A stalled WS never holds the window's result reader indefinitely.
        let _ = results.set_write_timeout(Some(Duration::from_secs(2)));
        let mut reader = BufReader::new(stream);
        let Some(offered) = frame(&mut reader) else {
            return;
        };
        if !same_key(offered.strip_suffix(b"\n").unwrap_or(&offered), &key) {
            return;
        }
        let _ = reader.get_ref().set_read_timeout(None);
        handshake.take();
        if let Some((_, previous)) = lock(&relay.attached).replace((generation, results)) {
            let _ = previous.shutdown(std::net::Shutdown::Both);
        }
        while let Some(line) = frame(&mut reader) {
            // With no window, the request times out in WS as it did when the
            // window was gone. A frame is never queued or replayed.
            if let Some(input) = lock(&relay.input).as_ref() {
                let _ = input.try_send(line);
            }
        }
        let mut attached = lock(&relay.attached);
        if attached
            .as_ref()
            .is_some_and(|(current, _)| *current == generation)
        {
            *attached = None;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_stop_at_eof_oversize_and_unterminated_input() {
        let mut input = BufReader::new(&b"one\ntwo"[..]);
        assert_eq!(frame(&mut input).as_deref(), Some(&b"one\n"[..]));
        assert_eq!(frame(&mut input), None);
        let large = vec![b'x'; FRAME_LIMIT + 2];
        assert_eq!(frame(&mut BufReader::new(&large[..])), None);
    }

    #[test]
    fn keys_compare_whole_values() {
        assert!(same_key(b"abc", b"abc"));
        assert!(!same_key(b"abc", b"abd"));
        assert!(!same_key(b"ab", b"abc"));
    }

    fn root() -> PathBuf {
        let root = PathBuf::from("/tmp").join(format!("o8-window-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        root
    }

    #[test]
    fn binding_keeps_files_symlinks_shared_and_live_sockets() {
        let root = root();
        let path = root.join("window-control.sock");
        // A regular file is never removed.
        std::fs::write(&path, b"preserve").unwrap();
        assert!(bind_private(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"preserve");
        std::fs::remove_file(&path).unwrap();
        // Nor a symlink, nor its target.
        let target = root.join("target");
        std::fs::write(&target, b"target").unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(bind_private(&path).is_err());
        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(&target).unwrap(), b"target");
        std::fs::remove_file(&path).unwrap();
        // Nor a live owner's socket.
        let (live, identity) = bind_private(&path).unwrap();
        assert!(bind_private(&path).is_err());
        let meta = std::fs::symlink_metadata(&path).unwrap();
        assert_eq!((meta.dev(), meta.ino()), identity);
        assert_eq!(meta.mode() & 0o777, 0o600);
        drop(live);
        // A dead socket readable by others is not this launcher's to reclaim.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660)).unwrap();
        assert!(bind_private(&path).is_err());
        assert_eq!(
            std::fs::symlink_metadata(&path).unwrap().dev_ino(),
            identity
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_dead_private_socket_is_reclaimed_and_cleanup_spares_a_replacement() {
        let root = root();
        let path = root.join("window-control.sock");
        // A crashed launcher leaves its socket behind; the next start reclaims
        // it. Closing the stale listener frees its inode, so the new socket may
        // reuse the same inode number (Linux does): only liveness is asserted.
        let (stale, _) = bind_private(&path).unwrap();
        drop(stale);
        let (_listener, identity) = bind_private(&path).unwrap();
        assert!(UnixStream::connect(&path).is_ok());
        // Another owner replaced the path while this listener is open. The open
        // listener pins its inode, so the replacement cannot share its identity
        // and cleanup leaves it.
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"replacement").unwrap();
        unlink_if_bound(&path, identity);
        assert_eq!(std::fs::read(&path).unwrap(), b"replacement");
        // The socket this instance bound is removed.
        std::fs::remove_file(&path).unwrap();
        let (_again, identity) = bind_private(&path).unwrap();
        unlink_if_bound(&path, identity);
        assert!(std::fs::symlink_metadata(&path).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    trait DevIno {
        fn dev_ino(&self) -> (u64, u64);
    }
    impl DevIno for std::fs::Metadata {
        fn dev_ino(&self) -> (u64, u64) {
            (self.dev(), self.ino())
        }
    }
}
