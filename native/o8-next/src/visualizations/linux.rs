//! Private, bounded snapshot transport. Only display data crosses these pipes.
use super::linux_protocol::{MAX_INPUT, MAX_OUTPUT, TIMEOUT, TIMEOUT_ERROR};
pub use super::linux_protocol::{MAX_WIDTH, Request, Response};
use super::protocol::UNAVAILABLE;
use std::{
    io::{Read, Write},
    os::{fd::AsRawFd, unix::process::CommandExt},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

pub struct Job {
    pub result: mpsc::Receiver<Result<Response, String>>,
    cancel: Arc<AtomicBool>,
}
impl Job {
    pub fn start(request: Request, wake: impl FnOnce() + Send + 'static) -> Self {
        let (send, result) = mpsc::channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let stopping = cancel.clone();
        thread::spawn(move || {
            let executable = executable();
            let response = executable.and_then(|exe| render(&exe, &request, &stopping));
            let _ = send.send(response);
            wake();
        });
        Self { result, cancel }
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}
fn executable() -> Result<std::path::PathBuf, String> {
    // Unit tests run in a harness executable; the override names the built helper.
    #[cfg(test)]
    if let Some(path) = std::env::var_os("O8_NEXT_NATIVE_BINARY") {
        return Ok(path.into());
    }
    std::env::current_exe()
        .map(|path| path.with_file_name("o8-next-viz-render"))
        .map_err(|_| UNAVAILABLE.into())
}
struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        // Kill the private process group before reaping its leader, including
        // WebKit descendants and a helper stuck in pipe I/O or native code.
        unsafe {
            libc::kill(-(self.0.id() as i32), libc::SIGKILL);
        }
        let _ = self.0.wait();
    }
}
fn command(executable: &Path) -> Command {
    command_for_bus(
        executable,
        std::env::var_os("DBUS_SESSION_BUS_ADDRESS").filter(|v| !v.is_empty()),
    )
}
fn command_for_bus(executable: &Path, bus: Option<std::ffi::OsString>) -> Command {
    // GTK/WebKit needs native session-bus plumbing before it can load a page.
    // A minimal X11 session may have no bus. Keep its private daemon and the
    // renderer in the same process group, under the same parent watchdog.
    let mut command = if bus.is_some() {
        Command::new(executable)
    } else {
        let mut command = Command::new("dbus-run-session");
        command.arg("--").arg(executable);
        command
    };
    command
        .env_clear()
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(bus) = bus {
        command.env("DBUS_SESSION_BUS_ADDRESS", bus);
    }
    // Do not pass server credentials or WebKit sandbox-disabling variables.
    for key in [
        "DISPLAY",
        "XAUTHORITY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "LANG",
        "LC_ALL",
        "XDG_DATA_DIRS",
        "LIBGL_ALWAYS_SOFTWARE",
        "LD_LIBRARY_PATH",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
}
pub fn render(
    executable: &Path,
    request: &Request,
    cancel: &AtomicBool,
) -> Result<Response, String> {
    let started = Instant::now();
    if cancel.load(Ordering::Relaxed) {
        return Err(UNAVAILABLE.into());
    }
    if !request.valid() {
        return Err(UNAVAILABLE.into());
    }
    let bytes = serde_json::to_vec(request).map_err(|_| UNAVAILABLE)?;
    if bytes.len() as u64 > MAX_INPUT {
        return Err(UNAVAILABLE.into());
    }
    supervise(
        command(executable),
        bytes,
        cancel,
        TIMEOUT.saturating_sub(started.elapsed()),
    )
}
fn supervise(
    mut command: Command,
    bytes: Vec<u8>,
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<Response, String> {
    let started = Instant::now();
    let mut child = Process(command.spawn().map_err(|_| UNAVAILABLE)?);
    let input = child.0.stdin.take().ok_or(UNAVAILABLE)?;
    let mut output = child.0.stdout.take().ok_or(UNAVAILABLE)?;
    for fd in [input.as_raw_fd(), output.as_raw_fd()] {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(UNAVAILABLE.into());
        }
    }
    // Nonblocking pipes keep the watchdog in charge even if a native process
    // stops reading input or a descendant keeps stdout open after exit.
    let mut input = Some(input);
    let mut written = 0;
    let mut received = Vec::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(UNAVAILABLE.into());
        }
        if started.elapsed() >= timeout {
            return Err(TIMEOUT_ERROR.into());
        }
        if let Some(pipe) = &mut input {
            match pipe.write(&bytes[written..]) {
                Ok(0) => return Err(UNAVAILABLE.into()),
                Ok(count) => written += count,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        || error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return Err(UNAVAILABLE.into()),
            }
            if written == bytes.len() {
                input = None;
            }
        }
        for _ in 0..8 {
            match output.read(&mut buffer) {
                Ok(0) => return serde_json::from_slice(&received).map_err(|_| UNAVAILABLE.into()),
                Ok(count) => {
                    received.extend_from_slice(&buffer[..count]);
                    if received.len() as u64 > MAX_OUTPUT {
                        return Err(UNAVAILABLE.into());
                    }
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        || error.kind() == std::io::ErrorKind::Interrupted =>
                {
                    break;
                }
                Err(_) => return Err(UNAVAILABLE.into()),
            }
        }
        thread::sleep(Duration::from_millis(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn renderer_uses_the_native_bus_or_a_private_bounded_session() {
        let executable = Path::new("/fixture/o8-next-viz-render");
        let direct = command_for_bus(executable, Some("unix:path=/fixture/bus".into()));
        assert_eq!(direct.get_program(), executable.as_os_str());
        assert_eq!(direct.get_args().count(), 0);
        assert!(
            direct
                .get_envs()
                .any(|(key, value)| key == "DBUS_SESSION_BUS_ADDRESS"
                    && value == Some(std::ffi::OsStr::new("unix:path=/fixture/bus")))
        );
        let private = command_for_bus(executable, None);
        assert_eq!(private.get_program(), "dbus-run-session");
        assert_eq!(
            private.get_args().collect::<Vec<_>>(),
            ["--", "/fixture/o8-next-viz-render"]
        );
        assert!(
            private
                .get_envs()
                .all(|(key, _)| key != "DBUS_SESSION_BUS_ADDRESS")
        );
    }
    #[test]
    fn missing_helper_returns_unavailable_without_waiting_for_the_watchdog() {
        let request = Request {
            document: "<p>fixture</p>".into(),
            nonce: "linux-fixture-0123456789".into(),
            width: 728,
            height: 320.,
            theme: serde_json::json!({}),
            state: serde_json::json!({}),
        };
        let directory =
            std::env::temp_dir().join(format!("o8-missing-helper-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let missing = directory.join("o8-next-viz-render");
        let started = Instant::now();
        let result = render(&missing, &request, &AtomicBool::new(false));
        std::fs::remove_dir(directory).unwrap();
        assert!(matches!(result, Err(error) if error == UNAVAILABLE));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn watchdog_bounds_stalled_stdin_and_reaps_the_process_group() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 30"])
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let start = Instant::now();
        let result = supervise(
            command,
            vec![b'x'; 1024 * 1024],
            &AtomicBool::new(false),
            Duration::from_millis(100),
        );
        assert!(matches!(result, Err(error) if error == TIMEOUT_ERROR));
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
