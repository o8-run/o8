//! Private, bounded snapshot transport. Only display data crosses these pipes.
use super::protocol::{MAX_HEIGHT, MIN_HEIGHT, UNAVAILABLE, valid_state};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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

pub const ARG: &str = "--render-visualization";
pub const TIMEOUT: Duration = Duration::from_secs(12);
pub const TIMEOUT_ERROR: &str = "The visualization did not finish loading. Try again.";
const MAX_INPUT: u64 = 16 * 1024 * 1024;
const MAX_OUTPUT: u64 = 32 * 1024 * 1024;
pub const MAX_WIDTH: u32 = 1600;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub document: String,
    pub nonce: String,
    pub width: u32,
    pub height: f64,
    pub theme: Value,
    pub state: Value,
}
impl Request {
    pub fn valid(&self) -> bool {
        !self.document.is_empty()
            && self.document.len() <= 12 * 1024 * 1024
            && (1..=MAX_WIDTH).contains(&self.width)
            && self.height.is_finite()
            && (MIN_HEIGHT..=MAX_HEIGHT).contains(&self.height)
            && (16..=128).contains(&self.nonce.len())
            && self
                .nonce
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && self.theme.to_string().len() <= 16 * 1024
            && valid_state(&self.state)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub height: f64,
    pub state: Option<Value>,
    pub png: String,
}
impl Response {
    pub fn picture(&self, width: u32) -> Result<Vec<u8>, String> {
        if !self.height.is_finite()
            || self.height.fract() != 0.
            || !(MIN_HEIGHT..=MAX_HEIGHT).contains(&self.height)
            || self.state.as_ref().is_some_and(|s| !valid_state(s))
        {
            return Err(UNAVAILABLE.into());
        }
        let png = STANDARD.decode(&self.png).map_err(|_| UNAVAILABLE)?;
        if png.len() < 24
            || &png[..16] != b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"
            || u32::from_be_bytes(png[16..20].try_into().unwrap()) != width
            || u32::from_be_bytes(png[20..24].try_into().unwrap()) != self.height as u32
        {
            return Err(UNAVAILABLE.into());
        }
        Ok(png)
    }
}

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
    // Unit tests run in a harness executable; the subprocess must be the built app.
    #[cfg(test)]
    if let Some(path) = std::env::var_os("O8_NEXT_NATIVE_BINARY") {
        return Ok(path.into());
    }
    std::env::current_exe().map_err(|_| UNAVAILABLE.into())
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
        .arg(ARG)
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

/// Called before GPUI or application clients are initialized. Stdin/stdout only.
pub fn entry() -> Result<(), String> {
    // A hard watchdog also bounds standalone invocations and blocked stdin.
    thread::spawn(|| {
        thread::sleep(TIMEOUT);
        std::process::exit(1);
    });
    let mut input = Vec::new();
    std::io::stdin()
        .take(MAX_INPUT + 1)
        .read_to_end(&mut input)
        .map_err(|_| UNAVAILABLE)?;
    if input.len() as u64 > MAX_INPUT {
        return Err(UNAVAILABLE.into());
    }
    let request: Request = serde_json::from_slice(&input).map_err(|_| UNAVAILABLE)?;
    if !request.valid() {
        return Err(UNAVAILABLE.into());
    }
    let response = super::linux_renderer::snapshot(request)?;
    serde_json::to_writer(std::io::stdout().lock(), &response).map_err(|_| UNAVAILABLE.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn renderer_uses_the_native_bus_or_a_private_bounded_session() {
        let executable = Path::new("/fixture/o8-next");
        let direct = command_for_bus(executable, Some("unix:path=/fixture/bus".into()));
        assert_eq!(direct.get_program(), executable.as_os_str());
        assert_eq!(direct.get_args().collect::<Vec<_>>(), [ARG]);
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
            ["--", "/fixture/o8-next", ARG]
        );
        assert!(
            private
                .get_envs()
                .all(|(key, _)| key != "DBUS_SESSION_BUS_ADDRESS")
        );
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
