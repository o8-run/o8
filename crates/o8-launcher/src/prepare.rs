//! Orphan cleanup, the login-shell probe and Node preflight run in a helper
//! process (`--prepare`) in its own process group, so the launcher can bound
//! them, kill them whole, and keep its main thread answering events meanwhile.
use crate::{lock, native, ownership, Config};
use o8_launch_core::preflight;
use serde::Deserialize;
use std::{
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

/// Bound on orphan cleanup, the login-shell probe and Node preflight together.
const PREPARE_BOUND: Duration = Duration::from_secs(30);
fn prepare_bound() -> Duration {
    // Debug builds let the fixture tests shorten the bound.
    std::env::var("O8_LAUNCHER_PREPARE_BOUND_MS")
        .ok()
        .filter(|_| cfg!(debug_assertions))
        .and_then(|value| value.parse().ok())
        .map_or(PREPARE_BOUND, Duration::from_millis)
}
/// `--prepare`: orphan cleanup, the login-shell probe and Node preflight, run in
/// a helper process so the launcher can bound them and kill them whole.
pub fn prepare_here(config: &Config) -> Result<serde_json::Value, String> {
    ownership::cleanup(&config.data_dir, &config.server_dir)?;
    let shell = if let Some(probe) = &config.probe {
        let result = Command::new(probe)
            .output()
            .map_err(|_| "Login shell probe unavailable")?;
        if !result.status.success() {
            return Err("Login shell probe failed".into());
        }
        o8_launch_core::shell_env::parse_probe(&String::from_utf8_lossy(&result.stdout))
    } else {
        o8_launch_core::shell_env::probe_login_shell()
    };
    o8_launch_core::path_env::augment_process_path(&shell.path);
    for (key, value) in &shell.keys {
        std::env::set_var(key, value);
    }
    let selected = preflight::run_node_preflight(config.node.to_str(), &config.server_dir)
        .map_err(|_| "Node runtime preflight failed")?;
    Ok(serde_json::json!({"path": shell.path, "keys": shell.keys, "node": selected}))
}
#[derive(Deserialize)]
pub struct Prepared {
    pub path: String,
    pub keys: Vec<(String, String)>,
    pub node: PathBuf,
}
/// Kills a helper's whole process group, then reaps the helper. The group id
/// stays reserved until the reap, so the signal cannot reach a reused id.
pub fn kill_group(child: &mut Child) {
    unsafe {
        libc::killpg(child.id() as i32, libc::SIGKILL);
    }
    let _ = child.wait();
}
/// Runs `--prepare` in its own process group while the main thread keeps pumping
/// events. `None` means a stop was requested; the armed shutdown kills the helper.
pub fn prepare(
    config_path: &Path,
    native: &native::Native,
    stopped: &AtomicBool,
    preparing: &Mutex<Option<Child>>,
) -> Result<Option<Prepared>, String> {
    let mut child = Command::new(std::env::current_exe().map_err(|_| "Install unavailable")?)
        .arg("--prepare")
        .arg(config_path)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| "Startup checks could not start")?;
    let mut stdout = child.stdout.take().ok_or("Startup checks unavailable")?;
    let pid = child.id();
    *lock(preparing) = Some(child);
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stdout, &mut bytes);
        let _ = send.send(bytes);
    });
    let deadline = Instant::now() + prepare_bound();
    loop {
        native.pump();
        if stopped.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let mut status: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::waitid(
                libc::P_PID,
                pid,
                &mut status,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } != 0
        {
            return Err("Startup checks unavailable".into());
        }
        let done = unsafe { status.si_pid() } != 0;
        if done || Instant::now() >= deadline {
            // Anything the probe left behind in the group goes with it.
            if let Some(mut child) = lock(preparing).take() {
                kill_group(&mut child);
            }
            if !done {
                return Err(format!(
                    "Startup checks did not finish within {} s",
                    prepare_bound().as_secs()
                ));
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let bytes = receive
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "Startup checks unavailable")?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Startup checks failed")?;
    if let Some(error) = value["error"].as_str() {
        return Err(error.into());
    }
    serde_json::from_value(value)
        .map(Some)
        .map_err(|_| "Startup checks failed".into())
}
