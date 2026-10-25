use std::sync::{Mutex, OnceLock};

#[cfg(windows)]
use crate::no_window::NoWindow;
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, HANDLE},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
    },
};

const SIDECAR_ENV_MARKER: &str = "O8_SIDECAR_PID=";

// The Tauri parent spawns Node children (Next.js + ws-server) but must own
// their lifecycle explicitly. Registry mutation and the shutdown flag share
// one lock so no supervisor can register a respawn after shutdown drained it.
#[derive(Default)]
struct ChildRegistry {
    pids: Vec<u32>,
    shutting_down: bool,
}

fn child_registry() -> &'static Mutex<ChildRegistry> {
    static CHILDREN: OnceLock<Mutex<ChildRegistry>> = OnceLock::new();
    CHILDREN.get_or_init(|| Mutex::new(ChildRegistry::default()))
}

#[cfg(test)]
pub(crate) struct ChildRegistryTestGuard {
    _serial: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl Drop for ChildRegistryTestGuard {
    fn drop(&mut self) {
        let pids = child_registry()
            .lock()
            .map(|mut registry| {
                registry.shutting_down = true;
                std::mem::take(&mut registry.pids)
            })
            .unwrap_or_default();
        if !pids.is_empty() {
            #[cfg(unix)]
            kill_tracked_children_unix(&pids);
            #[cfg(windows)]
            kill_tracked_children_windows(&pids);
        }
        if let Ok(mut registry) = child_registry().lock() {
            registry.pids.clear();
            registry.shutting_down = false;
        }
    }
}

#[cfg(test)]
pub(crate) fn lock_child_registry_for_test() -> ChildRegistryTestGuard {
    static TEST_SERIAL: OnceLock<Mutex<()>> = OnceLock::new();
    let serial = TEST_SERIAL
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("lock child registry test state");
    if let Ok(mut registry) = child_registry().lock() {
        assert!(
            registry.pids.is_empty(),
            "tracked children leaked into test"
        );
        registry.shutting_down = false;
    }
    ChildRegistryTestGuard { _serial: serial }
}

#[cfg(test)]
pub(crate) fn tracked_children_for_test() -> Vec<u32> {
    child_registry()
        .lock()
        .map(|registry| registry.pids.clone())
        .unwrap_or_default()
}

/// Track a freshly spawned child so we can kill it on quit. Returns false and
/// terminates the child when shutdown won the race with a supervisor respawn.
pub(crate) fn register_child(pid: u32) -> bool {
    let registered = if let Ok(mut registry) = child_registry().lock() {
        if registry.shutting_down {
            false
        } else {
            if !registry.pids.contains(&pid) {
                registry.pids.push(pid);
            }
            true
        }
    } else {
        false
    };
    if !registered {
        log::info!("[shutdown] refusing late sidecar PID {pid}");
        #[cfg(unix)]
        kill_tracked_children_unix(&[pid]);
        #[cfg(windows)]
        kill_tracked_children_windows(&[pid]);
        return false;
    }
    #[cfg(windows)]
    assign_child_to_kill_on_close_job(pid);
    true
}

/// Remove an exited child so shutdown cannot later signal a recycled PID.
pub(crate) fn unregister_child(pid: u32) {
    if let Ok(mut registry) = child_registry().lock() {
        registry.pids.retain(|candidate| *candidate != pid);
    }
}

pub(crate) fn is_shutting_down() -> bool {
    child_registry()
        .lock()
        .map(|registry| registry.shutting_down)
        .unwrap_or(true)
}

/// Atomically claim the transition into a fatal shutdown. Returns false when
/// an ordinary quit or relaunch already began, so supervisors stay silent.
pub(crate) fn begin_shutdown() -> bool {
    child_registry()
        .lock()
        .map(|mut registry| {
            if registry.shutting_down {
                false
            } else {
                registry.shutting_down = true;
                true
            }
        })
        .unwrap_or(false)
}

/// Windows Job Object that owns every bundled child process. The handle stays
/// open for the Tauri process lifetime; Windows terminates the full job tree if
/// the app exits normally, crashes, or is killed before Rust can run cleanup.
#[cfg(windows)]
fn sidecar_job_handle() -> Option<HANDLE> {
    static JOB_HANDLE: OnceLock<Mutex<Option<isize>>> = OnceLock::new();
    let storage = JOB_HANDLE.get_or_init(|| Mutex::new(None));
    let Ok(mut guard) = storage.lock() else {
        return None;
    };
    if let Some(handle) = *guard {
        return Some(handle as HANDLE);
    }

    unsafe {
        let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if handle.is_null() {
            log::warn!(
                "[sidecar-job] CreateJobObjectW failed with {}",
                GetLastError()
            );
            return None;
        }

        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if configured == 0 {
            log::warn!(
                "[sidecar-job] SetInformationJobObject failed with {}",
                GetLastError()
            );
            let _ = CloseHandle(handle);
            return None;
        }

        *guard = Some(handle as isize);
        Some(handle)
    }
}

#[cfg(windows)]
fn assign_child_to_kill_on_close_job(pid: u32) {
    let Some(job) = sidecar_job_handle() else {
        return;
    };
    unsafe {
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if process.is_null() {
            log::warn!(
                "[sidecar-job] OpenProcess({pid}) failed with {}",
                GetLastError()
            );
            return;
        }
        if AssignProcessToJobObject(job, process) == 0 {
            log::warn!(
                "[sidecar-job] AssignProcessToJobObject({pid}) failed with {}",
                GetLastError()
            );
        } else {
            log::info!("[sidecar-job] assigned PID {pid} to kill-on-close job");
        }
        let _ = CloseHandle(process);
    }
}

/// TERM + (after 1s) KILL every tracked child PID on Unix; force-kill the
/// full process tree via `taskkill` on Windows.
///
/// Idempotent: the registry is drained on first call, so repeated exit events
/// or a panic during shutdown cannot send another cleanup pass.
pub(crate) fn kill_tracked_children() {
    let pids = match child_registry().lock() {
        Ok(mut registry) => {
            registry.shutting_down = true;
            std::mem::take(&mut registry.pids)
        }
        Err(_) => return,
    };
    if pids.is_empty() {
        return;
    }

    log::info!(
        "[shutdown] terminating {} tracked child PIDs: {:?}",
        pids.len(),
        pids
    );

    #[cfg(unix)]
    kill_tracked_children_unix(&pids);

    #[cfg(windows)]
    kill_tracked_children_windows(&pids);
}

/// SIGTERM every PID, wait 1s, then SIGKILL any survivor.
#[cfg(unix)]
fn kill_tracked_children_unix(pids: &[u32]) {
    for pid in pids {
        let _ = crate::child_environment::command("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }

    std::thread::sleep(std::time::Duration::from_millis(1000));

    for pid in pids {
        let alive = crate::child_environment::command("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if alive {
            log::info!("[shutdown] PID {} survived TERM — sending KILL", pid);
            let _ = crate::child_environment::command("kill")
                .args(["-KILL", &pid.to_string()])
                .status();
        }
    }
}

/// Windows has no `kill(1)`/SIGTERM to escalate from, so `taskkill /T /F`
/// force-kills the PID and its entire child tree during an orderly shutdown.
/// The kill-on-close Job Object above covers crashes and forced parent exits.
#[cfg(windows)]
fn kill_tracked_children_windows(pids: &[u32]) {
    for pid in pids {
        match crate::child_environment::command("taskkill")
            .args(taskkill_tree_args(*pid))
            .no_window()
            .status()
        {
            Ok(status) if status.success() => {}
            Ok(status) => log::warn!(
                "[shutdown] taskkill /PID {} /T /F exited with {}",
                pid,
                status
            ),
            Err(e) => log::warn!("[shutdown] failed to spawn taskkill for PID {}: {}", pid, e),
        }
    }
}

/// Pure argv builder, kept un-gated so the Windows kill path has unit
/// coverage that runs on every host platform (#1739) even though the actual
/// `taskkill` spawn only happens under `cfg(windows)`.
#[cfg_attr(not(windows), allow(dead_code))]
fn taskkill_tree_args(pid: u32) -> [String; 4] {
    [
        "/PID".to_string(),
        pid.to_string(),
        "/T".to_string(),
        "/F".to_string(),
    ]
}

/// Install panic + Unix signal handlers before Tauri starts spawning children.
pub(crate) fn install_shutdown_handlers() {
    // The disposable pre-ship boot-gate child (#1161) runs with O8_PRESHIP_GATE=1.
    // Captured once (the env is fixed for the process lifetime) so the panic path
    // below stays allocation-free.
    let preship_gate = crate::env_flag_enabled("O8_PRESHIP_GATE");
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        prev(info);
        // Only reap children when the panic is on a thread whose death actually
        // brings down the process (the main thread, or an explicitly-named one).
        // tokio worker threads (`tokio-rt-worker`, `tokio-rt-blocking`) panicking
        // are isolated by tokio's task::Builder panic catching and do NOT cause
        // process exit — but our previous "panic == shutdown" rule killed the
        // bundled Next + WS sidecars anyway. See #1109 where an MCP plugin
        // screenshot panic on a tokio worker took the whole backend down.
        let on_main = std::thread::current().name() == Some("main");
        if on_main {
            kill_tracked_children();
            // A main-thread panic in the gate child is about to abort, which on
            // macOS raises SIGABRT and pops a "o8 quit unexpectedly" crash-report
            // dialog — making the operator think their REAL app died. The gate
            // reads the child's exit code / socket, not a crash dump, so exit
            // cleanly instead (#1161). Gated to the disposable child only; the
            // operator's real app still aborts + reports genuine crashes.
            if preship_gate {
                std::process::exit(70);
            }
        } else {
            log::warn!(
                "[panic-isolation] non-main thread {:?} panicked but the process is still running — NOT reaping children (see #1109)",
                std::thread::current().name().unwrap_or("<unnamed>")
            );
        }
    }));

    #[cfg(unix)]
    {
        use signal_hook::consts::{SIGINT, SIGTERM};
        use signal_hook::iterator::Signals;
        match Signals::new([SIGTERM, SIGINT]) {
            Ok(mut signals) => {
                std::thread::spawn(move || {
                    if let Some(sig) = signals.forever().next() {
                        log::info!("[shutdown] received signal {} — killing children", sig);
                        kill_tracked_children();
                        unsafe {
                            libc::signal(sig, libc::SIG_DFL);
                            libc::raise(sig);
                        }
                    }
                });
            }
            Err(e) => {
                log::warn!("[shutdown] could not install signal handler: {}", e);
            }
        }
    }
}

/// Reap a launchd-parented o8 child that is still listening on `port`.
///
/// This is intentionally narrower than "kill whatever owns the port": the
/// stale-UI failure comes from o8's own bundled Next/ws-server children being
/// orphaned after the Tauri parent exits. Unrelated local services must survive.
pub(crate) fn kill_o8_orphans_on_port(port: u16) {
    #[cfg(unix)]
    {
        kill_o8_orphans_on_port_unix(port);
    }

    #[cfg(not(unix))]
    {
        let _ = port;
    }
}

#[cfg(unix)]
fn kill_o8_orphans_on_port_unix(port: u16) {
    if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_err() {
        return;
    }

    let pids = listening_pids(port);
    if pids.is_empty() {
        log::warn!(
            "[port-orphan-reap] :{} appears bound but lsof returned no PIDs — skipping",
            port
        );
        return;
    }

    let mut killed = Vec::new();
    for pid in pids {
        if pid == std::process::id() {
            continue;
        }

        let ppid = process_ppid(pid);
        let cwd = process_cwd(pid);
        if ppid != 1 {
            log::info!(
                "[port-orphan-reap] :{} pid={} ppid={} is actively parented (cwd={:?}) — skipping",
                port,
                pid,
                ppid,
                cwd
            );
            continue;
        }

        if !cwd_looks_o8_owned(&cwd) {
            log::info!(
                "[port-orphan-reap] :{} pid={} cwd={:?} not o8-owned — skipping",
                port,
                pid,
                cwd
            );
            continue;
        }

        log::info!(
            "[port-orphan-reap] reaping o8 orphan on :{} pid={} cwd={:?}",
            port,
            pid,
            cwd
        );
        term_then_kill(pid);
        killed.push(pid);
    }

    if killed.is_empty() {
        return;
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(3000);
    while std::time::Instant::now() < deadline {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            log::info!(
                "[port-orphan-reap] :{} released after killing {:?}",
                port,
                killed
            );
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    log::warn!(
        "[port-orphan-reap] :{} still held after reaping {:?} — sidecar will probe higher port",
        port,
        killed
    );
}

#[cfg(unix)]
fn listening_pids(port: u16) -> Vec<u32> {
    match crate::child_environment::command("lsof")
        .args(["-ti", &format!(":{}", port), "-sTCP:LISTEN"])
        .output()
    {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|s| s.trim().parse::<u32>().ok())
            .collect(),
        Ok(out) if !out.stderr.is_empty() => {
            log::warn!(
                "[port-orphan-reap] lsof for :{} failed: {}",
                port,
                String::from_utf8_lossy(&out.stderr).trim()
            );
            Vec::new()
        }
        _ => Vec::new(),
    }
}

/// Boot-time orphan reaper for stale bundled children on any allocated port.
/// Called once from `pub fn run()` before the Tauri builder is constructed.
/// No-ops on non-unix platforms.
/// Kill stale next-server / ws-server processes left by a previous crash.
///
/// SLOW (~73ms: three `pgrep` spawns, plus `ps`/`lsof` per candidate), and it
/// does NOT need to run before the Tauri builder — so it is started on a worker
/// thread and joined before the first sidecar spawn. See `start_orphan_reap` /
/// `join_orphan_reap` in lib.rs for the ordering contract.
pub(crate) fn reap_o8_orphan_processes() {
    #[cfg(unix)]
    {
        reap_o8_orphan_processes_unix();
    }
}

/// Remove a stale `/tmp/tauri-mcp-o8-<user>.sock`.
///
/// This one CANNOT be deferred: `tauri-plugin-mcp` binds the socket during
/// builder setup and throws if the file lingers, so it must happen before
/// `Builder::build()`. It is only a stat + unlink — microseconds — so keeping it
/// on the synchronous path costs nothing.
pub(crate) fn clean_stale_mcp_socket() {
    #[cfg(unix)]
    {
        clean_stale_tauri_mcp_socket();
    }
}

#[cfg(unix)]
fn reap_o8_orphan_processes_unix() {
    // Patterns chosen to catch every shape o8 spawns its node children as.
    // `next-server` is what Next.js renames the process title to after boot.
    // `ws-server.mjs` and `ws-server.ts` cover the bundled and dev forms of
    // our WebSocket multiplexer.
    let patterns: &[&str] = &["next-server", "ws-server.mjs", "ws-server.ts"];
    let mut candidates: Vec<u32> = Vec::new();
    for p in patterns {
        for pid in pgrep_pids(p) {
            if !candidates.contains(&pid) {
                candidates.push(pid);
            }
        }
    }

    if candidates.is_empty() {
        log::info!("[orphan-reap] no candidate next/ws-server processes found");
    } else {
        log::info!("[orphan-reap] candidates: {:?}", candidates);
    }

    for pid in candidates {
        let ppid = process_ppid(pid);
        let cwd = process_cwd(pid);
        let command = process_command_with_env(pid);
        let has_sidecar_marker = command.contains(SIDECAR_ENV_MARKER);

        // Ownership filter — must look like an o8 install/checkout or carry
        // our explicit sidecar marker. This is the catastrophic-false-positive
        // guard for unrelated Next.js apps.
        if !has_sidecar_marker && !cwd_looks_o8_owned(&cwd) {
            log::info!(
                "[orphan-reap] pid={} cwd={:?} marker={} not o8-owned — skipping",
                pid,
                cwd,
                has_sidecar_marker
            );
            continue;
        }

        // Orphan signal: parent reparented to launchd/init (pid 1). If the
        // parent is still alive (a running terminal `npm run dev` or another
        // live o8 sidecar), we leave it alone — the user is actively using it.
        if ppid != 1 {
            log::info!(
                "[orphan-reap] pid={} ppid={} is actively parented (cwd={:?}) — skipping",
                pid,
                ppid,
                cwd
            );
            continue;
        }

        log::info!(
            "[orphan-reap] reaping orphan pid={} ppid=1 cwd={:?} marker={}",
            pid,
            cwd,
            has_sidecar_marker
        );
        term_then_kill(pid);
    }
}

/// Fast PID enumeration via `pgrep -f <pattern>`. Returns Vec<u32> on success,
/// empty Vec if pgrep is missing or finds nothing (both are non-fatal).
#[cfg(unix)]
fn pgrep_pids(pattern: &str) -> Vec<u32> {
    let out = match crate::child_environment::command("pgrep").args(["-f", pattern]).output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    // pgrep exits 1 when no match (stdout + stderr both empty) — not an error.
    // A real failure produces something on stderr (e.g. permission denied).
    if !out.status.success() && !out.stderr.is_empty() {
        log::warn!(
            "[orphan-reap] pgrep -f {:?} failed: {}",
            pattern,
            String::from_utf8_lossy(&out.stderr).trim()
        );
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|s| s.trim().parse::<u32>().ok())
        .filter(|pid| *pid != std::process::id())
        .collect()
}

/// Best-effort cwd lookup via `lsof -p PID -a -d cwd -F n`. Returns the path
/// or empty string. macOS lsof is part of the base system; Linux ships it on
/// most distros. If lsof is missing we treat cwd as unknown and the candidate
/// is rejected by the ownership filter (safer than a false-positive kill).
#[cfg(unix)]
pub(crate) fn process_cwd(pid: u32) -> String {
    let out = match crate::child_environment::command("lsof")
        .args(["-p", &pid.to_string(), "-a", "-d", "cwd", "-F", "n"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return String::new(),
    };
    // lsof -F n format: each record line starts with a single-char field
    // marker; the cwd path is on a line starting with 'n'.
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n').map(|s| s.to_string()))
        .unwrap_or_default()
}

/// Parent PID via `ps -o ppid=`. Returns 0 on failure (treat as "unknown
/// parent" — unsafe to assume orphan, so caller skips).
#[cfg(unix)]
pub(crate) fn process_ppid(pid: u32) -> u32 {
    crate::child_environment::command("ps")
        .args(["-p", &pid.to_string(), "-o", "ppid="])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .parse::<u32>()
                .ok()
        })
        .unwrap_or(0)
}

/// Best-effort command + environment read. macOS can expose env vars through
/// `ps -E` for same-user processes; when that is unavailable the result is
/// empty and callers fall back to cwd ownership checks.
#[cfg(unix)]
fn process_command_with_env(pid: u32) -> String {
    crate::child_environment::command("ps")
        .args(["-p", &pid.to_string(), "-wwE", "-o", "command="])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// True if the cwd looks like an o8 install or checkout. We accept:
///   - Any path containing `cortex-ide` (dev checkouts, worktrees)
///   - Any path containing `.app/Contents/Resources/server` (installed app)
///   - Any path ending in `/.o8` or containing `/o8/` (rebrand-friendly)
///
/// We deliberately do NOT match the bare token "o8" anywhere — too broad
/// (matches user dirs like ~/projects/o8-experiment).
#[cfg(unix)]
pub(crate) fn cwd_looks_o8_owned(cwd: &str) -> bool {
    if cwd.is_empty() {
        return false;
    }
    cwd.contains("cortex-ide")
        || cwd.contains(".app/Contents/Resources/server")
        || cwd.contains("/.o8")
        || cwd.contains("/o8/")
        || cwd.contains("/o8.app/")
}

/// Send SIGTERM, wait up to 2s for the process to exit, then SIGKILL if
/// still alive. `kill -0` is the standard "is this process alive" probe.
#[cfg(unix)]
pub(crate) fn term_then_kill(pid: u32) {
    let _ = crate::child_environment::command("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2000);
    while std::time::Instant::now() < deadline {
        let alive = crate::child_environment::command("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !alive {
            log::info!("[orphan-reap] pid={} exited after TERM", pid);
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    log::warn!(
        "[orphan-reap] pid={} did not exit after 2s — sending KILL",
        pid
    );
    let _ = crate::child_environment::command("kill")
        .args(["-KILL", &pid.to_string()])
        .status();
}

/// SIGKILL the orphan and poll until the port is released. Returns true if
/// the port became free within the timeout, false if the socket is still
/// held (caller should log + continue — launching anyway is worse than
/// trying to bind a free port higher up the range).
#[cfg(unix)]
pub(crate) fn kill_orphan_and_wait(pid: u32, port: u16) -> bool {
    log::info!("[orphan-check] Killing orphan pid={} on :{}", pid, port);
    let out = crate::child_environment::command("kill").args(["-9", &pid.to_string()]).output();
    match out {
        Ok(o) if o.status.success() => {
            log::info!("[orphan-check] kill -9 {} succeeded", pid);
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            log::warn!("[orphan-check] kill -9 {} non-zero: {}", pid, stderr.trim());
        }
        Err(e) => {
            log::warn!("[orphan-check] kill -9 {} failed to spawn: {}", pid, e);
            return false;
        }
    }

    // Poll the port for up to 3s. TcpListener::bind is the authoritative
    // signal that the port is free on Unix, even after the process is gone.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            log::info!("[orphan-check] Port :{} released after kill", port);
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    log::warn!(
        "[orphan-check] Port :{} still held 3s after killing pid={}; continuing",
        port,
        pid
    );
    false
}

#[cfg(not(unix))]
pub(crate) fn kill_orphan_and_wait(_pid: u32, _port: u16) -> bool {
    false
}

/// Clean a stale `/tmp/tauri-mcp-o8-<user>.sock` file. When the prior sidecar
/// crashed without unbinding, the socket file lingers and the next launch's
/// `tauri-plugin-mcp` plugin throws "Socket ... is in use by another instance".
///
/// We test "in-use" by attempting a Unix-domain stream connect to the socket.
/// If a process is actually listening, connect() succeeds → we leave it alone
/// (another live o8 instance owns it). If connect() fails with refused/no-such
/// the file is dead → safe to unlink.
#[cfg(unix)]
fn clean_stale_tauri_mcp_socket() {
    let user = std::env::var("USER").unwrap_or_else(|_| "default".into());
    let sock_path = format!("/tmp/tauri-mcp-o8-{}.sock", user);
    let path = std::path::Path::new(&sock_path);
    if !path.exists() {
        return;
    }
    // Best-effort liveness probe via UnixStream connect. A successful connect
    // means somebody is listening — leave the socket alone.
    use std::os::unix::net::UnixStream;
    match UnixStream::connect(&sock_path) {
        Ok(_) => {
            log::info!(
                "[orphan-reap] tauri-mcp socket at {} is live — leaving in place",
                sock_path
            );
        }
        Err(_) => {
            // Connect refused / no listener — socket file is dead.
            match std::fs::remove_file(&sock_path) {
                Ok(()) => log::info!("[orphan-reap] removed stale tauri-mcp socket {}", sock_path),
                Err(e) => log::warn!(
                    "[orphan-reap] could not remove stale tauri-mcp socket {}: {}",
                    sock_path,
                    e
                ),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::taskkill_tree_args;

    #[cfg(unix)]
    const TEST_LISTENER_PORT_ENV: &str = "O8_TEST_LISTENER_PORT";

    #[cfg(unix)]
    #[test]
    fn orphan_listener_child_process() {
        let Ok(port) = std::env::var(TEST_LISTENER_PORT_ENV) else {
            return;
        };
        let port = port.parse::<u16>().expect("parse listener port");
        let listener =
            std::net::TcpListener::bind(("127.0.0.1", port)).expect("bind child listener port");
        std::thread::sleep(std::time::Duration::from_secs(30));
        drop(listener);
    }

    #[cfg(unix)]
    #[test]
    fn kill_orphan_and_wait_releases_listener_port() {
        let probe =
            std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind ephemeral listener port");
        let port = probe.local_addr().expect("read listener address").port();
        drop(probe);

        let mut child = crate::child_environment::command(
            std::env::current_exe().expect("resolve current test executable"),
        )
        .args([
            "--exact",
            "sidecar_lifecycle::tests::orphan_listener_child_process",
            "--nocapture",
        ])
        .env(TEST_LISTENER_PORT_ENV, port.to_string())
        .spawn()
        .expect("spawn child listener process");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let listener_ready = loop {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break true;
            }
            if std::time::Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        if !listener_ready {
            let _ = child.kill();
            let _ = child.wait();
            panic!("child listener did not bind port {port}");
        }

        let reclaimed = super::kill_orphan_and_wait(child.id(), port);
        let rebound = std::net::TcpListener::bind(("127.0.0.1", port));
        let wait_result = child.wait();

        assert!(reclaimed, "orphan listener port was not reclaimed");
        assert!(rebound.is_ok(), "reclaimed listener port did not rebind");
        wait_result.expect("reap child listener process");
    }

    #[test]
    fn taskkill_tree_args_force_kills_pid_and_tree() {
        assert_eq!(
            taskkill_tree_args(4242),
            [
                "/PID".to_string(),
                "4242".to_string(),
                "/T".to_string(),
                "/F".to_string()
            ]
        );
    }
}
