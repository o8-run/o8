//! Opt-in launcher. No bundle selects this executable yet.
use o8_launch_core::{next_main_startup, ports, preflight, restart::*};
use o8_launcher::ownership::{self, identity, private_write, Pending, Receipt};
use serde::Deserialize;
mod control;
mod native;
mod shutdown;
use control::{Instance, Request};
use shutdown::{Shutdown, SHUTDOWN_BOUND};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::{io::AsRawFd, process::CommandExt},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, PoisonError,
    },
    time::{Duration, Instant},
};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    data_dir: PathBuf,
    server_dir: PathBuf,
    node: PathBuf,
    window: PathBuf,
    #[serde(default = "default_api_port")]
    api_port: u16,
    #[serde(default = "default_ws_port")]
    ws_port: u16,
    version: String,
    // Explicit injection keeps fixture failures from showing a native alert.
    dialog: Option<PathBuf>,
    probe: Option<PathBuf>,
    focus: Option<PathBuf>,
    #[serde(default = "native_enabled")]
    native_lifecycle: bool,
}
struct Server {
    child: Child,
    receipt: PathBuf,
    pending: PathBuf,
    hold: PathBuf,
    tracker: RestartTracker,
    script: &'static str,
    port: u16,
    stopped: bool,
    /// Set after a crash: the next spawn waits for the restart delay while the
    /// main loop keeps pumping events.
    retry_at: Option<Instant>,
}
impl Server {
    fn stop(&mut self, deadline: Instant) -> Result<(), String> {
        if self.stopped {
            return Ok(());
        }
        self.stopped = true;
        // The exclusive Child handle remains unreaped until its group drains.
        ownership::stop_child(&mut self.child, self.port, deadline).map_err(|error| {
            o8_launcher::note!("Server shutdown incomplete: {error}");
            error
        })?;
        // Records stay on disk when stopping fails, so the next start can recover.
        for path in [&self.pending, &self.hold] {
            let _ = fs::remove_file(path);
        }
        fs::remove_file(&self.receipt).map_err(|_| {
            o8_launcher::note!("Server shutdown incomplete: ownership receipt unavailable");
            "Ownership receipt unavailable"
        })?;
        Ok(())
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        if let Err(error) = self.stop(Instant::now() + SHUTDOWN_BOUND) {
            o8_launcher::note!("{error}");
        }
    }
}
struct Servers {
    api: Option<Server>,
    ws: Option<Server>,
}
impl Servers {
    /// API before WS, both within one shared deadline.
    fn stop(&mut self, deadline: Instant) -> Result<(), String> {
        let api = self.api.as_mut().map_or(Ok(()), |api| api.stop(deadline));
        let ws = self.ws.as_mut().map_or(Ok(()), |ws| ws.stop(deadline));
        api.and(ws)
    }
}
impl Drop for Servers {
    fn drop(&mut self) {
        // Preserve the same order on every early return as on normal shutdown.
        if let Err(error) = self.stop(Instant::now() + SHUTDOWN_BOUND) {
            o8_launcher::note!("{error}");
        }
    }
}
fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value.lock().unwrap_or_else(PoisonError::into_inner)
}
fn spawn(
    config: &Config,
    script: &'static str,
    boot: &str,
    instance: &str,
    receipt_name: &str,
) -> Result<Server, String> {
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(config.data_dir.join("logs").join(if script == "server.js" {
            "next-server.log"
        } else {
            "ws-server.log"
        }))
        .map_err(|_| "Server log unavailable")?;
    let mut command = Command::new(&config.node);
    command
        .arg(config.server_dir.join(script))
        .current_dir(&config.server_dir)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|_| "Server log unavailable")?)
        .stderr(log);
    let executable = std::env::current_exe().map_err(|_| "Install unavailable")?;
    let pi_write = executable.with_file_name("o8-pi-write");
    let mcp = config.server_dir.join("operator-mcp-server.mjs");
    let environment = o8_launch_core::server_env::ServerEnvironment {
        data_dir: config.data_dir.to_string_lossy().into_owned(),
        node_bin: config.node.to_string_lossy().into_owned(),
        server_dir: config.server_dir.clone(),
        api_port: config.api_port,
        ws_port: config.ws_port,
        boot_id: boot.into(),
        instance_id: instance.into(),
        compile_cache: config
            .data_dir
            .join("compile-cache")
            .to_string_lossy()
            .into_owned(),
        pi_write: pi_write.is_file().then_some(pi_write),
        mcp: mcp.is_file().then_some(mcp),
        window: Some(config.window.clone()),
        codebase_memory: std::env::var("O8_CODEBASE_MEMORY_BIN")
            .ok()
            .filter(|value| !value.is_empty()),
        native_main: true,
        voice_only: o8_launch_core::server_env::voice_only(
            std::env::var("O8_VOICE_ONLY").ok().as_deref(),
        ),
        version: config.version.clone(),
        next_origin: format!("http://127.0.0.1:{}", config.api_port),
        ..Default::default()
    };
    if script == "server.js" {
        environment.api(&mut command);
    } else {
        environment.ws(&mut command);
    }
    let port = if script == "server.js" {
        config.api_port
    } else {
        config.ws_port
    };
    let receipt_path = config.data_dir.join(receipt_name);
    let pending_path = ownership::pending_path(&receipt_path);
    let hold_path = ownership::hold_path(&receipt_path);
    // The child inherits the hold file open. A later start proves ownership by
    // finding the process holding it, even if this launcher dies before the
    // receipt below is written or the install moves.
    let token = uuid::Uuid::new_v4().simple().to_string();
    let (hold_file, hold) =
        ownership::create_hold(&hold_path, &token).map_err(|_| "Ownership unavailable")?;
    let runtime = ownership::file_id(&config.node).ok_or("Server runtime unavailable")?;
    // The record's spawn time opens a two-second proof window, so it must be
    // read after the hold file and the record itself are flushed, right before
    // the fork. A reading is written, then confirmed against a fresh one; a
    // flush slower than the slack rewrites the record with the fresh reading.
    // A backward wall-clock step between reading and fork (macOS; Linux uses the
    // monotonic boot clock) makes the server look born too early: recovery then
    // fails closed, leaving the orphan and signalling nothing.
    let write_pending = |spawned: u64| {
        let pending = Pending {
            hold: hold.clone(),
            directory: config.data_dir.clone(),
            install: executable.clone(),
            port,
            spawned,
            runtime,
        };
        serde_json::to_vec(&pending)
            .ok()
            .is_some_and(|bytes| private_write(&pending_path, &bytes).is_ok())
    };
    let mut spawned = ownership::birth_clock();
    let mut confirmed = false;
    for _ in 0..3 {
        if !write_pending(spawned) {
            break;
        }
        let now = ownership::birth_clock();
        if now.saturating_sub(spawned) <= ownership::spawn_slack() {
            confirmed = true;
            break;
        }
        spawned = now;
    }
    if !confirmed {
        let _ = fs::remove_file(&pending_path);
        let _ = fs::remove_file(&hold_path);
        return Err("Ownership unavailable".into());
    }
    let inherited = hold_file.as_raw_fd();
    // The descriptor stays open in the server and anything it starts unless the
    // server marks it close-on-exec; its number lets the server do that. Proof
    // never depends on it: see ownership::proven_holder.
    command
        .env("O8_LAUNCH_TOKEN", &token)
        .env("O8_LAUNCH_HOLD_FD", inherited.to_string());
    // Runs in the forked child only: the parent's copy stays close-on-exec.
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(inherited, libc::F_SETFD, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            let _ = fs::remove_file(&pending_path);
            let _ = fs::remove_file(&hold_path);
            return Err("Server could not start".into());
        }
    };
    drop(hold_file);
    fault("after-spawn", script);
    let mut server = Server {
        child,
        script,
        receipt: receipt_path,
        pending: pending_path,
        hold: hold_path,
        tracker: RestartTracker::new(NEXT_RESTART_POLICY),
        port,
        stopped: false,
        retry_at: None,
    };
    let result = (|| {
        let receipt = Receipt {
            pid: server.child.id(),
            identity: identity(server.child.id()).ok_or("Server identity unavailable")?,
            directory: config.data_dir.clone(),
            install: executable,
            port: server.port,
            parent: std::process::id(),
            hold: Some(hold),
            spawned,
            runtime: Some(runtime),
        };
        private_write(
            &server.receipt,
            &serde_json::to_vec(&receipt).map_err(|_| "Ownership unavailable")?,
        )
        .map_err(|_| "Ownership unavailable")?;
        fs::remove_file(&server.pending).map_err(|_| "Ownership unavailable")?;
        ownership::sync_parent(&server.pending).map_err(|_| "Ownership unavailable")
    })();
    if let Err(error) = result {
        let _ = server.stop(Instant::now() + SHUTDOWN_BOUND);
        return Err(error.into());
    }
    Ok(server)
}
/// Records a failure against the restart budget and sets the next attempt time.
fn schedule_restart(config: &Config, server: &mut Server) -> Result<(), String> {
    let (attempt, delay) = match server.tracker.record_failure(Instant::now()) {
        RestartDecision::Exhausted { .. } => return Err("Server restart budget exhausted".into()),
        RestartDecision::Restart { attempt, delay } => (attempt, delay),
    };
    let log_name = if server.script == "server.js" {
        "next-server.log"
    } else {
        "ws-server.log"
    };
    if let Ok(mut log) = OpenOptions::new()
        .append(true)
        .open(config.data_dir.join("logs").join(log_name))
    {
        let _ = writeln!(log, "[o8-sidecar-supervisor] restart attempt {attempt}");
    }
    server.retry_at = Some(Instant::now() + delay);
    Ok(())
}
/// Debug-build crash injection for the real-entry recovery tests.
fn fault(point: &str, script: &str) {
    if cfg!(debug_assertions)
        && std::env::var("O8_LAUNCHER_FAULT").ok().as_deref() == Some(&format!("{point}:{script}"))
    {
        unsafe { libc::_exit(86) };
    }
}
// Injected failure dialogs still open at exit. Each entry is reaped under this
// lock, so a signal never reaches a reused PID.
static DIALOGS: Mutex<Vec<(u64, Child)>> = Mutex::new(Vec::new());
static DIALOG_IDS: AtomicU64 = AtomicU64::new(0);
fn present_async(config: &Config, reason: &str) {
    let config = config.clone();
    let reason = reason.to_owned();
    std::thread::spawn(move || present_with(&config, &reason, true));
}
fn show_dialog(dialog: &std::path::Path, message: &str, tracked: bool) {
    if !tracked {
        let _ = Command::new(dialog).arg(message).status();
        return;
    }
    let Ok(child) = Command::new(dialog).arg(message).spawn() else {
        return;
    };
    let id = DIALOG_IDS.fetch_add(1, Ordering::SeqCst);
    lock(&DIALOGS).push((id, child));
    loop {
        {
            let mut dialogs = lock(&DIALOGS);
            let Some(index) = dialogs.iter().position(|(entry, _)| *entry == id) else {
                return;
            };
            if !matches!(dialogs[index].1.try_wait(), Ok(None)) {
                dialogs.remove(index);
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
/// Ends and reaps dialog children before the launcher exits.
fn reap_dialogs(deadline: Instant) {
    for (_, child) in lock(&DIALOGS).iter() {
        unsafe {
            libc::kill(child.id() as i32, libc::SIGTERM);
        }
    }
    loop {
        let mut dialogs = lock(&DIALOGS);
        dialogs.retain_mut(|(_, child)| matches!(child.try_wait(), Ok(None)));
        if dialogs.is_empty() {
            return;
        }
        if Instant::now() >= deadline {
            for (_, mut child) in dialogs.drain(..) {
                let _ = child.kill();
                let _ = child.wait();
            }
            return;
        }
        drop(dialogs);
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn present(config: &Config, reason: &str) {
    present_with(config, reason, false);
}
fn present_with(config: &Config, reason: &str, tracked: bool) {
    o8_launcher::note!("{reason}");
    next_main_startup::report_failure_with_recovery(
        &config.window,
        &config.data_dir.join("logs/gpui-startup.log"),
        reason,
        "Details are also in standard error.",
        "Reopen o8 to retry the native window.",
        |message| {
            if let Some(dialog) = &config.dialog {
                show_dialog(dialog, &message, tracked);
                return;
            }
            native_alert(&message);
        },
    );
}
#[cfg(target_os = "macos")]
fn native_alert(message: &str) {
    use std::ffi::CString;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            allocator: *const libc::c_void,
            text: *const libc::c_char,
            encoding: u32,
        ) -> *const libc::c_void;
        fn CFUserNotificationDisplayAlert(
            timeout: f64,
            flags: usize,
            icon: *const libc::c_void,
            sound: *const libc::c_void,
            localization: *const libc::c_void,
            title: *const libc::c_void,
            message: *const libc::c_void,
            default: *const libc::c_void,
            alternate: *const libc::c_void,
            other: *const libc::c_void,
            response: *mut usize,
        ) -> i32;
        fn CFRelease(value: *const libc::c_void);
    }
    unsafe {
        let title = CString::new("o8 could not start").unwrap();
        let text = CString::new(message.replace('\0', "")).unwrap();
        let title = CFStringCreateWithCString(std::ptr::null(), title.as_ptr(), 0x08000100);
        let text = CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), 0x08000100);
        let mut response = 0;
        CFUserNotificationDisplayAlert(
            0.0,
            0,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            title,
            text,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            &mut response,
        );
        CFRelease(title);
        CFRelease(text);
    }
}
#[cfg(not(target_os = "macos"))]
fn native_alert(message: &str) {
    o8_launcher::note!("{message}");
}
fn default_api_port() -> u16 {
    ports::PROD_API_DEFAULT_PORT
}
fn default_ws_port() -> u16 {
    ports::PROD_WS_DEFAULT_PORT
}
fn native_enabled() -> bool {
    cfg!(target_os = "macos")
}
fn run(config: &mut Config) -> Result<(), String> {
    if !config.data_dir.is_absolute()
        || !config.server_dir.is_absolute()
        || !config.node.is_absolute()
        || !config.window.is_absolute()
    {
        return Err("Launch paths must be absolute".into());
    }
    fs::create_dir_all(config.data_dir.join("logs")).map_err(|_| "Data directory unavailable")?;
    let Some(instance_lock) = Instance::claim(&config.data_dir)
        .map_err(|error| format!("Instance unavailable: {error}"))?
    else {
        return Ok(());
    };
    ownership::cleanup(&config.data_dir, &config.server_dir)?;
    let stopped = Arc::new(AtomicBool::new(false));
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        signal_hook::flag::register(signal, stopped.clone())
            .map_err(|_| "Shutdown handler unavailable")?;
    }
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
    if stopped.load(Ordering::SeqCst) {
        return Ok(());
    }
    o8_launch_core::path_env::augment_process_path(&shell.path);
    for (key, value) in shell.keys {
        std::env::set_var(key, value);
    }
    let selected = preflight::run_node_preflight(config.node.to_str(), &config.server_dir)
        .map_err(|_| "Node runtime preflight failed")?;
    config.node = selected.into();
    if config.api_port == ports::PROD_API_DEFAULT_PORT {
        config.api_port = ports::find_free_port(ports::PROD_API_PORT_RANGE, None)
            .unwrap_or_else(|| ports::bind_ephemeral_port(None));
    }
    if config.api_port == 0 {
        config.api_port = ports::bind_ephemeral_port(None);
    }
    if config.ws_port == ports::PROD_WS_DEFAULT_PORT {
        config.ws_port = ports::find_free_port(ports::PROD_WS_PORT_RANGE, Some(config.api_port))
            .unwrap_or_else(|| ports::bind_ephemeral_port(Some(config.api_port)));
    }
    if config.ws_port == 0 {
        config.ws_port = ports::bind_ephemeral_port(Some(config.api_port));
    }
    if config.api_port == 0
        || config.ws_port == 0
        || config.api_port == config.ws_port
        || !ports::bundled_sidecar_port_available(config.api_port)
        || !ports::bundled_sidecar_port_available(config.ws_port)
    {
        return Err("Server ports unavailable".into());
    }
    std::env::set_var("O8_API_PORT", config.api_port.to_string());
    std::env::set_var("O8_WS_PORT", config.ws_port.to_string());
    std::env::set_var("O8_NODE_BIN", &config.node);
    std::env::set_var("CORTEX_IDE_API_PORT", config.api_port.to_string());
    std::env::set_var("CORTEX_IDE_WS_PORT", config.ws_port.to_string());
    if stopped.load(Ordering::SeqCst) {
        return Ok(());
    }
    let data_dir = config.data_dir.to_string_lossy();
    let identity = o8_launch_core::identity::read_or_create_boot_identity(&data_dir);
    let boot = identity.boot_id;
    let instance = identity.instance_id;
    std::env::set_var("O8_BOOT_ID", &boot);
    std::env::set_var("O8_INSTANCE_ID", &instance);
    if fs::read_to_string(config.data_dir.join("boot-id"))
        .ok()
        .as_deref()
        != Some(&boot)
        || fs::read_to_string(config.data_dir.join("instance-id"))
            .ok()
            .is_none_or(|value| value.trim() != instance)
    {
        return Err("Boot identity could not be published".into());
    }
    for (name, port) in [("api-port", config.api_port), ("ws-port", config.ws_port)] {
        o8_launch_core::identity::write_port_file(&data_dir, name, port)
            .map_err(|_| "Port publication failed")?;
    }
    for name in ["next-server.log", "ws-server.log"] {
        let path = config.data_dir.join("logs").join(name);
        let _ = fs::rename(&path, path.with_file_name(format!("{name}.prev")));
    }
    // Native termination and the headless exit share one bounded shutdown.
    let reopen = Arc::new(AtomicBool::new(false));
    let shutdown = Arc::new(Shutdown::new(SHUTDOWN_BOUND));
    let native = native::Native::new(
        config.native_lifecycle,
        stopped.clone(),
        reopen.clone(),
        shutdown.clone(),
    )?;
    let servers = Arc::new(Mutex::new(Some(Servers {
        api: None,
        ws: None,
    })));
    let control = Arc::new(Mutex::new(Some(instance_lock)));
    {
        let servers = servers.clone();
        let control = control.clone();
        shutdown.arm(
            move |deadline| {
                let taken = lock(&servers).take();
                match taken {
                    Some(mut servers) => servers.stop(deadline),
                    None => Ok(()),
                }
            },
            move || {
                // Dropping the instance closes the lock and removes the socket
                // file; AppKit exits right after the termination reply.
                drop(lock(&control).take());
                reap_dialogs(Instant::now() + Duration::from_millis(400));
            },
        );
    }
    // A failed start stops whatever did start under the coordinator's one bound.
    let started = (|| -> Result<(), String> {
        let api = spawn(config, "server.js", &boot, &instance, "launcher-api.json")?;
        if let Some(servers) = lock(&servers).as_mut() {
            servers.api = Some(api);
        }
        let ws = spawn(
            config,
            "ws-server.mjs",
            &boot,
            &instance,
            "launcher-ws.json",
        )?;
        if let Some(servers) = lock(&servers).as_mut() {
            servers.ws = Some(ws);
        }
        Ok(())
    })();
    if let Err(error) = started {
        let _ = shutdown.run();
        return Err(error);
    }
    let restart_stop = stopped.clone();
    let restart = o8_launch_core::restart_job_drain::guard(
        config.data_dir.clone(),
        config.api_port,
        move || {
            restart_stop.store(true, Ordering::SeqCst);
        },
    );
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|_| "Health client unavailable")?;
    let mut deadline = Instant::now() + Duration::from_secs(90);
    let voice_only =
        o8_launch_core::server_env::voice_only(std::env::var("O8_VOICE_ONLY").ok().as_deref());
    let mut opened = false;
    let mut pending_show = false;
    let mut window_failed = false;
    let mut launch: Option<std::sync::mpsc::Receiver<Result<(), String>>> = None;
    let outcome = (|| -> Result<(), String> {
        while !stopped.load(Ordering::SeqCst) {
            // Never call this while holding the server lock: a native quit waits in here.
            native.pump();
            pending_show |= reopen.swap(false, Ordering::SeqCst);
            let received = match lock(&control).as_ref() {
                Some(instance) => instance.receive().map_err(|_| "Instance control stopped")?,
                None => break,
            };
            if let Some((request, peer)) = received {
                let result = match request {
                    Request::Show => {
                        pending_show = true;
                        Ok(serde_json::json!({"ok": true}))
                    }
                    Request::PrepareRestart => restart
                        .prepare()
                        .map(|id| serde_json::json!({"ok": true, "reservation": id})),
                    Request::CancelRestart { reservation } => restart
                        .cancel(&reservation)
                        .map(|_| serde_json::json!({"ok": true})),
                    Request::Restart { reservation } => restart
                        .before_restart(Some(&reservation))
                        .map(|_| serde_json::json!({"ok": true, "admitted": true})),
                };
                let response = result.unwrap_or_else(
                |_| serde_json::json!({"ok": false, "error": "Restart is deferred or unavailable"}),
            );
                if let Some(mut peer) = peer {
                    let _ = writeln!(peer, "{response}");
                }
            }
            if stopped.load(Ordering::SeqCst) {
                break;
            }
            let mut guard = lock(&servers);
            let Some(Servers {
                api: Some(api),
                ws: Some(ws),
            }) = guard.as_mut()
            else {
                break;
            };
            for (server, receipt) in [
                (&mut *api, "launcher-api.json"),
                (&mut *ws, "launcher-ws.json"),
            ] {
                if let Some(at) = server.retry_at {
                    if Instant::now() < at || stopped.load(Ordering::SeqCst) {
                        continue;
                    }
                    match spawn(config, server.script, &boot, &instance, receipt) {
                        Ok(next) => {
                            let tracker = std::mem::replace(
                                &mut server.tracker,
                                RestartTracker::new(NEXT_RESTART_POLICY),
                            );
                            *server = next;
                            server.tracker = tracker;
                            if server.script == "server.js" {
                                opened = false;
                                window_failed = false;
                                launch = None;
                                deadline = Instant::now() + Duration::from_secs(90);
                            }
                        }
                        Err(_) => schedule_restart(config, server)?,
                    }
                    continue;
                }
                let mut status: libc::siginfo_t = unsafe { std::mem::zeroed() };
                if unsafe {
                    libc::waitid(
                        libc::P_PID,
                        server.child.id(),
                        &mut status,
                        libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                    )
                } != 0
                {
                    return Err("Server status unavailable".into());
                }
                if unsafe { status.si_pid() } != 0 {
                    // A completed child is never signaled by Drop after reaping.
                    server.stop(Instant::now() + SHUTDOWN_BOUND)?;
                    schedule_restart(config, server)?;
                }
            }
            if let Some(result) = launch
                .as_ref()
                .and_then(|receiver| receiver.try_recv().ok())
            {
                launch = None;
                match result {
                    Ok(()) => {
                        opened = true;
                        window_failed = false;
                    }
                    Err(reason) => {
                        present_async(config, &reason);
                        window_failed = true;
                    }
                }
            }
            if pending_show && window_failed {
                window_failed = false;
                deadline = Instant::now() + Duration::from_secs(90);
            }
            if voice_only {
                pending_show = false;
            }
            if !voice_only && launch.is_none() && !window_failed {
                if !opened {
                    let healthy = client
                        .get(format!(
                            "http://127.0.0.1:{}/api/setup/identity",
                            config.api_port
                        ))
                        .send()
                        .ok()
                        .and_then(|r| r.json::<serde_json::Value>().ok())
                        .is_some_and(|v| v["bootId"].as_str() == Some(&boot));
                    if healthy {
                        let token = fs::read_to_string(config.data_dir.join("ws-token"))
                            .map_err(|_| "Window credential unavailable")?;
                        let port = config.api_port;
                        let (send, receive) = std::sync::mpsc::channel();
                        std::thread::spawn(move || {
                            let _ =
                                send.send(next_main_startup::request_window(port, token.trim()));
                        });
                        launch = Some(receive);
                        pending_show = false;
                    } else if Instant::now() >= deadline {
                        present_async(config, "Server did not become healthy");
                        window_failed = true;
                        pending_show = false;
                    }
                } else if pending_show {
                    let focused = if let Some(focus) = &config.focus {
                        Command::new(focus)
                            .arg(api.child.id().to_string())
                            .status()
                            .is_ok_and(|s| s.success())
                    } else {
                        native.focus(api.child.id(), &config.window)
                    };
                    if !focused {
                        opened = false;
                        deadline = Instant::now() + Duration::from_secs(90);
                    }
                    pending_show = false;
                }
            }
            drop(guard);
            std::thread::sleep(Duration::from_millis(25));
        }
        Ok(())
    })();
    let stopped_cleanly = shutdown.run();
    outcome?;
    stopped_cleanly
}
fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 3 || args[1] != "--config" {
        o8_launcher::note!("usage: o8-launcher --config <file>");
        std::process::exit(2);
    }
    let mut config: Config = match fs::read(&args[2])
        .ok()
        .and_then(|s| serde_json::from_slice(&s).ok())
    {
        Some(c) => c,
        None => {
            o8_launcher::note!("Invalid launch configuration");
            std::process::exit(2);
        }
    };
    if let Err(reason) = run(&mut config) {
        present(&config, &reason);
        std::process::exit(1);
    }
}

#[cfg(test)]
mod configuration_tests {
    #[test]
    fn omitted_ports_use_the_shells_defaults_without_binding_them() {
        let config: super::Config = serde_json::from_value(serde_json::json!({"data_dir":"/fixture/data","server_dir":"/fixture/server","node":"/fixture/node","window":"/fixture/window","version":"fixture"})).unwrap();
        assert_eq!(
            config.api_port,
            o8_launch_core::ports::PROD_API_DEFAULT_PORT
        );
        assert_eq!(config.ws_port, o8_launch_core::ports::PROD_WS_DEFAULT_PORT);
    }
}
