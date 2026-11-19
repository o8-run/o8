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
    os::unix::{fs::PermissionsExt, net::UnixListener, net::UnixStream},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

const READY: &str = "o8-next-ready";
const RESULT: &str = "o8-next-browser-result:";
/// The same spawn-to-first-paint bound the server used (`app-window.ts`).
const READY_WITHIN: Duration = Duration::from_secs(15);
/// The window drops a control frame larger than this; so does the relay.
const FRAME_LIMIT: usize = 1024 * 1024;
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
            && credentials.uid == unsafe { libc::getuid() }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let (mut uid, mut gid) = (0, 0);
        (unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) }) == 0
            && uid == unsafe { libc::getuid() }
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
    /// The current window's lifeline and control input.
    input: Mutex<Option<ChildStdin>>,
    /// The WS generation attached now, which receives result lines.
    attached: Mutex<Option<(u64, UnixStream)>>,
}

pub(super) struct Window {
    relay: Arc<Relay>,
    socket: PathBuf,
    key: String,
    child: Option<Child>,
    stopped: bool,
}

impl Window {
    /// Binds the control socket before WS starts, so WS can attach at boot.
    pub(super) fn bind(config: &Config) -> Result<Self, String> {
        let socket = control_socket(&config.data_dir)?;
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket).map_err(|_| "Window control unavailable")?;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "Window control unavailable")?;
        let key = uuid::Uuid::new_v4().to_string();
        let relay = Arc::new(Relay::default());
        let (accepting, expected) = (relay.clone(), key.clone());
        std::thread::spawn(move || {
            let mut generation = 0u64;
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                generation += 1;
                attach(&accepting, stream, expected.as_bytes(), generation);
            }
        });
        Ok(Self {
            relay,
            socket,
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
            .env("O8_NEXT_PARENT_PIPE", "1");
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
        *lock(&self.relay.input) = child.stdin.take();
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
                } else if text.starts_with(RESULT) {
                    let mut attached = lock(&relay.attached);
                    if let Some((_, stream)) = attached.as_mut() {
                        if stream.write_all(&line).is_err() {
                            *attached = None;
                        }
                    }
                }
            }
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

    pub(super) fn pid(&self) -> Option<u32> {
        self.child.as_ref().map(Child::id)
    }

    /// Drops the lifeline so the window exits as it did when its server
    /// stopped, then escalates within the shared shutdown deadline.
    pub(super) fn stop(&mut self, deadline: Instant) -> Result<(), String> {
        if self.stopped {
            return Ok(());
        }
        self.stopped = true;
        *lock(&self.relay.input) = None;
        if let Some((_, stream)) = lock(&self.relay.attached).take() {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        let _ = std::fs::remove_file(&self.socket);
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        // Leave the last second of the deadline for SIGKILL and the reap.
        let grace = deadline
            .checked_sub(Duration::from_secs(1))
            .unwrap_or(deadline);
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

/// One WS generation: same user, then the launcher key, then frames until it
/// leaves. A newer generation replaces an older one.
fn attach(relay: &Arc<Relay>, stream: UnixStream, key: &[u8], generation: u64) {
    if !peer_is_owner(&stream) {
        return;
    }
    let relay = relay.clone();
    let key = key.to_vec();
    std::thread::spawn(move || {
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
        if let Some((_, previous)) = lock(&relay.attached).replace((generation, results)) {
            let _ = previous.shutdown(std::net::Shutdown::Both);
        }
        while let Some(line) = frame(&mut reader) {
            // With no window, the request times out in WS as it did when the
            // window was gone. A frame is never queued or replayed.
            if let Some(input) = lock(&relay.input).as_mut() {
                let _ = input.write_all(&line).and_then(|_| input.flush());
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
}
