//! Orphan cleanup, the login-shell probe and Node preflight run in a helper
//! process (`--prepare`) in its own process group, so the launcher can bound
//! them, kill them whole, and keep its main thread answering events meanwhile.
//!
//! The helper is handed the launcher's instance-lock descriptor and the parsed
//! configuration on standard input. It refuses to run without a held lock, keeps
//! the lock held for as long as it lives, and kills its own group when standard
//! input closes: a force-quit launcher cannot leave it running cleanup against
//! a relaunched launcher's records.
use crate::{lock, native, ownership, Config, Instance};
use o8_launch_core::{preflight, shell_env::AI_KEYS};
use serde::Deserialize;
use std::{
    io::{BufRead, Read, Write},
    os::unix::{fs::MetadataExt, io::RawFd, process::CommandExt},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

/// Bound on orphan cleanup, the login-shell probe and Node preflight together.
const PREPARE_BOUND: Duration = Duration::from_secs(30);
/// Names the inherited instance-lock descriptor for the helper.
const LOCK_FD_ENV: &str = "O8_LAUNCHER_LOCK_FD";
/// Cap on the configuration line and on the helper's reply.
const MESSAGE_CAP: u64 = 256 * 1024;
fn prepare_bound() -> Duration {
    // Debug builds let the fixture tests shorten the bound.
    std::env::var("O8_LAUNCHER_PREPARE_BOUND_MS")
        .ok()
        .filter(|_| cfg!(debug_assertions))
        .and_then(|value| value.parse().ok())
        .map_or(PREPARE_BOUND, Duration::from_millis)
}
/// Debug builds only: the bound starts once this file exists, so a fixture can
/// start the clock when its probe is reached rather than at a guessed time.
fn bound_starts_after() -> Option<PathBuf> {
    std::env::var_os("O8_LAUNCHER_PREPARE_BOUND_AFTER")
        .filter(|_| cfg!(debug_assertions))
        .map(PathBuf::from)
}
/// Entry for `--prepare`. Reads the configuration from standard input, proves
/// it was handed the instance lock, then runs [`prepare_here`] and prints the
/// reply. Returns the exit status.
pub fn helper_main() -> i32 {
    let handed = std::env::var(LOCK_FD_ENV)
        .ok()
        .and_then(|value| value.parse::<RawFd>().ok());
    std::env::remove_var(LOCK_FD_ENV);
    // Nothing the helper starts may inherit the lock.
    let handed = handed
        .filter(|&fd| unsafe { fd > 2 && libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) == 0 });
    let mut line = Vec::new();
    let read = std::io::stdin()
        .lock()
        .take(MESSAGE_CAP)
        .read_until(b'\n', &mut line);
    let config = read
        .ok()
        .filter(|_| line.ends_with(b"\n"))
        .and_then(|_| serde_json::from_slice::<Config>(&line).ok());
    let answer = match (config, handed) {
        (Some(config), Some(fd)) if holds_instance_lock(fd, &config) => {
            watch_parent();
            prepare_here(&config).unwrap_or_else(|error| serde_json::json!({"error": error}))
        }
        (None, _) => serde_json::json!({"error": "Invalid launch configuration"}),
        _ => serde_json::json!({"error": "Startup checks need the launcher's instance lock"}),
    };
    let refused = answer.get("error").is_some();
    let answer = forged_reply().unwrap_or_else(|| format!("{answer}\n"));
    let _ = std::io::stdout().write_all(answer.as_bytes());
    i32::from(refused)
}
/// True when `fd` is this data directory's instance lock and its open file
/// description holds the exclusive lock. A description opened by another
/// process while a launcher runs cannot take it.
fn holds_instance_lock(fd: RawFd, config: &Config) -> bool {
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut stat) } != 0 {
        return false;
    }
    let Ok(expected) = std::fs::symlink_metadata(config.data_dir.join("launcher.lock")) else {
        return false;
    };
    expected.is_file()
        && expected.dev() == stat.st_dev as u64
        && expected.ino() == stat.st_ino
        && unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) } == 0
}
/// The launcher keeps the helper's standard input open while it waits. End of
/// input means it is gone: end the whole group, probe included.
fn watch_parent() {
    std::thread::spawn(|| {
        let mut sink = [0u8; 64];
        while matches!(std::io::stdin().read(&mut sink), Ok(count) if count > 0) {}
        unsafe {
            if libc::getpgrp() == libc::getpid() {
                libc::killpg(libc::getpgrp(), libc::SIGKILL);
            }
            libc::_exit(1);
        }
    });
}
/// Debug builds only: a fixture-supplied reply, optionally padded, in place of
/// the real one, so tests can exercise the launcher's checks on it.
fn forged_reply() -> Option<String> {
    let reply = std::env::var("O8_LAUNCHER_PREPARE_REPLY")
        .ok()
        .filter(|_| cfg!(debug_assertions))?;
    let pad = std::env::var("O8_LAUNCHER_PREPARE_REPLY_PAD")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    Some(format!("{}{reply}\n", " ".repeat(pad)))
}
/// `--prepare`: orphan cleanup, the login-shell probe and Node preflight, run in
/// a helper process so the launcher can bound them and kill them whole.
fn prepare_here(config: &Config) -> Result<serde_json::Value, String> {
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
    config: &Config,
    native: &native::Native,
    stopped: &AtomicBool,
    preparing: &Mutex<Option<Child>>,
    control: &Mutex<Option<Instance>>,
) -> Result<Option<Prepared>, String> {
    let mut line = serde_json::to_vec(config).map_err(|_| "Startup checks unavailable")?;
    line.push(b'\n');
    let mut command = Command::new(std::env::current_exe().map_err(|_| "Install unavailable")?);
    command
        .arg("--prepare")
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    // Held across the spawn so the release cannot close the descriptor first.
    let guard = lock(control);
    let Some(instance) = guard.as_ref() else {
        return Ok(None);
    };
    let held = instance.lock_fd();
    command.env(LOCK_FD_ENV, held.to_string());
    // Runs in the forked child only: the launcher's copy stays close-on-exec.
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(held, libc::F_SETFD, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let spawned = command.spawn();
    drop(guard);
    let mut child = spawned.map_err(|_| "Startup checks could not start")?;
    let stdout = child.stdout.take().ok_or("Startup checks unavailable")?;
    // The helper ends its group when this pipe closes, so it stays open in the
    // child handle until the helper is reaped.
    let sent = child
        .stdin
        .as_mut()
        .map(|stdin| stdin.write_all(&line))
        .is_some_and(|written| written.is_ok());
    let pid = child.id();
    *lock(preparing) = Some(child);
    if !sent {
        return Err("Startup checks unavailable".into());
    }
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        // One line, capped: a process left holding the pipe cannot stall this.
        let mut bytes = Vec::new();
        let _ = std::io::BufReader::new(stdout)
            .take(MESSAGE_CAP + 1)
            .read_until(b'\n', &mut bytes);
        let _ = send.send(bytes);
    });
    let starts_after = bound_starts_after();
    let mut deadline = starts_after
        .is_none()
        .then(|| Instant::now() + prepare_bound());
    loop {
        native.pump();
        if stopped.load(Ordering::SeqCst) {
            return Ok(None);
        }
        if deadline.is_none() && starts_after.as_ref().is_some_and(|path| path.exists()) {
            deadline = Some(Instant::now() + prepare_bound());
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
        if unsafe { status.si_pid() } != 0 {
            // A finished helper is only reaped: whatever a login profile left
            // running in its group keeps running.
            if let Some(mut child) = lock(preparing).take() {
                let _ = child.wait();
            }
            break;
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            // Anything the probe left behind in the group goes with it. A helper
            // stuck in the kernel is reaped later by the shutdown job, never here.
            let mut slot = lock(preparing);
            if let Some(child) = slot.as_mut() {
                unsafe {
                    libc::killpg(child.id() as i32, libc::SIGKILL);
                }
                if matches!(child.try_wait(), Ok(Some(_))) {
                    slot.take();
                }
            }
            return Err(format!(
                "Startup checks did not finish within {} s",
                prepare_bound().as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let bytes = receive
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "Startup checks unavailable")?;
    if bytes.len() as u64 > MESSAGE_CAP {
        return Err("Startup checks failed".into());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Startup checks failed")?;
    if let Some(error) = value["error"].as_str() {
        return Err(error.into());
    }
    let mut prepared: Prepared =
        serde_json::from_value(value).map_err(|_| "Startup checks failed")?;
    // The reply crosses a process boundary: only forwardable keys and an
    // absolute runtime survive it.
    prepared
        .keys
        .retain(|(key, _)| AI_KEYS.contains(&key.as_str()));
    if !prepared.node.is_absolute() {
        return Err("Startup checks failed".into());
    }
    Ok(Some(prepared))
}
