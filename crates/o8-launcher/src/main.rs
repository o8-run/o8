//! Opt-in launcher. No bundle selects this executable yet.
use o8_launch_core::{next_main_startup, ports, preflight, restart::*};
use serde::{Deserialize, Serialize};
use std::{fs::{self, File, OpenOptions}, io::{self, Write}, os::unix::{fs::OpenOptionsExt, io::AsRawFd, net::{UnixListener, UnixStream}, process::CommandExt}, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    data_dir: PathBuf,
    server_dir: PathBuf,
    node: PathBuf,
    window: PathBuf,
    api_port: u16,
    ws_port: u16,
    version: String,
    // Explicit injection keeps fixture failures from showing a native alert.
    dialog: Option<PathBuf>,
}
#[derive(Serialize, Deserialize)]
struct Receipt { pid: u32, identity: String, directory: PathBuf, install: PathBuf }
fn identity(pid: u32) -> Option<String> {
    let output = Command::new("ps").args(["-p", &pid.to_string(), "-o", "uid=,lstart=,command="]).output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string()).filter(|s| !s.is_empty())
}
fn parent(pid: u32) -> Option<u32> {
    let output = Command::new("ps").args(["-p", &pid.to_string(), "-o", "ppid="]).output().ok()?;
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}
fn private_write(path: &Path, data: &[u8]) -> io::Result<()> {
    let mut f = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(path)?;
    f.write_all(data)?; f.sync_all()
}
struct Instance { _lock: File, listener: UnixListener, socket: PathBuf }
impl Instance {
    fn claim(directory: &Path) -> io::Result<Option<Self>> {
        let lock = OpenOptions::new().read(true).write(true).create(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(directory.join("launcher.lock"))?;
        let socket = directory.join("launcher.sock");
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            if io::Error::last_os_error().kind() != io::ErrorKind::WouldBlock { return Err(io::Error::last_os_error()); }
            // The first instance may still be binding its socket.
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Ok(mut peer) = UnixStream::connect(&socket) { peer.write_all(b"show\n")?; return Ok(None); }
                if Instant::now() >= deadline { return Err(io::Error::new(io::ErrorKind::TimedOut, "Existing launcher unavailable")); }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
        if socket.exists() { fs::remove_file(&socket)?; }
        let listener = UnixListener::bind(&socket)?;
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        Ok(Some(Self { _lock: lock, listener, socket }))
    }
    fn show_requested(&self) -> bool { self.listener.accept().is_ok() }
}
impl Drop for Instance { fn drop(&mut self) { let _ = fs::remove_file(&self.socket); } }
struct Server { child: Child, receipt: PathBuf, tracker: RestartTracker, script: &'static str, stopped: bool }
impl Server {
    fn stop(&mut self) {
        if self.stopped { return; }
        self.stopped = true;
        // This child stays unreaped until the entire stop operation is finished.
        // Its PID therefore cannot be recycled into a foreign process group.
        unsafe { libc::kill(-(self.child.id() as i32), libc::SIGTERM); }
        std::thread::sleep(Duration::from_secs(1));
        unsafe { libc::kill(-(self.child.id() as i32), libc::SIGKILL); }
        let _ = self.child.wait(); let _ = fs::remove_file(&self.receipt);
    }
}
impl Drop for Server { fn drop(&mut self) { self.stop(); } }
fn cleanup(config: &Config) -> Result<(), String> {
    for name in ["launcher-api.json", "launcher-ws.json"] {
        let path = config.data_dir.join(name);
        let Ok(raw) = fs::read(&path) else { continue; };
        let receipt: Receipt = serde_json::from_slice(&raw).map_err(|_| "Invalid ownership receipt")?;
        // No global process enumeration. Both the install and full kernel-observed
        // process identity must still match, and only init-parented leaders qualify.
        let expected_script = if name == "launcher-api.json" { "server.js" } else { "ws-server.mjs" };
        let observed = &receipt.identity;
        if !observed.starts_with(&unsafe { libc::getuid() }.to_string()) || !observed.contains(&config.node.to_string_lossy().to_string()) || !observed.contains(&config.server_dir.join(expected_script).to_string_lossy().to_string()) { return Err("Foreign server ownership".into()); }
        if receipt.install != std::env::current_exe().map_err(|_| "Install unavailable")? || receipt.directory != config.data_dir { return Err("Foreign ownership receipt".into()); }
        if identity(receipt.pid).as_deref() == Some(&receipt.identity) {
            if parent(receipt.pid) != Some(1) { return Err("Prior server still actively parented".into()); }
            if unsafe { libc::getpgid(receipt.pid as i32) } != receipt.pid as i32 { return Err("Prior server group changed".into()); }
            unsafe { libc::kill(-(receipt.pid as i32), libc::SIGTERM); }
            std::thread::sleep(Duration::from_secs(1));
            if identity(receipt.pid).as_deref() == Some(&receipt.identity) {
                unsafe { libc::kill(-(receipt.pid as i32), libc::SIGKILL); }
            }
        }
        fs::remove_file(path).map_err(|_| "Ownership receipt unavailable")?;
    }
    Ok(())
}
fn spawn(config: &Config, script: &'static str, boot: &str, instance: &str, receipt_name: &str) -> Result<Server, String> {
    let log = OpenOptions::new().create(true).append(true).open(config.data_dir.join("logs").join(if script == "server.js" { "next-server.log" } else { "ws-server.log" })).map_err(|_| "Server log unavailable")?;
    let mut command = Command::new(&config.node);
    command.arg(config.server_dir.join(script)).current_dir(&config.server_dir).process_group(0)
        .env("O8_DATA_DIR", &config.data_dir).env("CORTEX_IDE_DATA_DIR", &config.data_dir)
        .env("PORT", config.api_port.to_string()).env("HOSTNAME", ports::sidecar_listen_host())
        .env("NODE_ENV", "production").env("O8_PACKAGED_APP", "1").env("O8_NODE_BIN", &config.node)
        .env("O8_API_PORT", config.api_port.to_string()).env("O8_WS_PORT", config.ws_port.to_string()).env("WS_PORT", config.ws_port.to_string())
        .env("NEXT_ORIGIN", format!("http://127.0.0.1:{}", config.api_port)).env("O8_APP_VERSION", &config.version)
        .env("O8_BOOT_ID", boot).env("O8_INSTANCE_ID", instance).env("O8_SIDECAR_PID", std::process::id().to_string())
        .env("O8_NEXT_MAIN_WINDOW", "1").env("O8_NEXT_BIN", &config.window)
        .env("NODE_COMPILE_CACHE", config.data_dir.join("node-compile-cache"))
        .stdin(Stdio::null()).stdout(log.try_clone().map_err(|_| "Server log unavailable")?).stderr(log);
    if config.server_dir.join("operator-mcp-server.mjs").exists() {
        command.env("O8_BUNDLED_MCP_DIR", &config.server_dir).env("O8_BUNDLED_MCP_PATH", config.server_dir.join("operator-mcp-server.mjs"));
    }
    let child = command.spawn().map_err(|_| "Server could not start")?;
    let mut server = Server { child, script, receipt: config.data_dir.join(receipt_name), tracker: RestartTracker::new(NEXT_RESTART_POLICY), stopped: false };
    let result = (|| {
        let receipt = Receipt { pid: server.child.id(), identity: identity(server.child.id()).ok_or("Server identity unavailable")?, directory: config.data_dir.clone(), install: std::env::current_exe().map_err(|_| "Install unavailable")? };
        private_write(&server.receipt, &serde_json::to_vec(&receipt).map_err(|_| "Ownership unavailable")?).map_err(|_| "Ownership unavailable")
    })();
    if let Err(error) = result { server.stop(); return Err(error.into()); }
    Ok(server)
}
fn show(config: &Config) -> Result<(), String> {
    let token = fs::read_to_string(config.data_dir.join("ws-token")).map_err(|_| "Window credential unavailable")?;
    next_main_startup::request_window(config.api_port, token.trim())
}
fn present(config: &Config, reason: &str) {
    next_main_startup::report_failure(&config.window, &config.data_dir.join("logs/gpui-startup.log"), reason, |message| {
        if let Some(dialog) = &config.dialog { let _ = Command::new(dialog).arg(&message).status(); return; }
        native_alert(&message);
    });
}
#[cfg(target_os = "macos")]
fn native_alert(message: &str) {
    use std::ffi::CString;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(allocator: *const libc::c_void, text: *const libc::c_char, encoding: u32) -> *const libc::c_void;
        fn CFUserNotificationDisplayAlert(timeout: f64, flags: usize, icon: *const libc::c_void, sound: *const libc::c_void, localization: *const libc::c_void, title: *const libc::c_void, message: *const libc::c_void, default: *const libc::c_void, alternate: *const libc::c_void, other: *const libc::c_void, response: *mut usize) -> i32;
        fn CFRelease(value: *const libc::c_void);
    }
    unsafe {
        let title = CString::new("o8 could not start").unwrap();
        let text = CString::new(message.replace('\0', "")).unwrap();
        let title = CFStringCreateWithCString(std::ptr::null(), title.as_ptr(), 0x08000100);
        let text = CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), 0x08000100);
        let mut response = 0;
        CFUserNotificationDisplayAlert(0.0, 0, std::ptr::null(), std::ptr::null(), std::ptr::null(), title, text, std::ptr::null(), std::ptr::null(), std::ptr::null(), &mut response);
        CFRelease(title); CFRelease(text);
    }
}
#[cfg(not(target_os = "macos"))]
fn native_alert(message: &str) { eprintln!("{message}"); }
fn run(config: &mut Config) -> Result<(), String> {
    if !config.data_dir.is_absolute() || !config.server_dir.is_absolute() || !config.node.is_absolute() || !config.window.is_absolute() { return Err("Launch paths must be absolute".into()); }
    fs::create_dir_all(config.data_dir.join("logs")).map_err(|_| "Data directory unavailable")?;
    let Some(instance_lock) = Instance::claim(&config.data_dir).map_err(|_| "Instance unavailable")? else { return Ok(()); };
    cleanup(config)?;
    let stopped = Arc::new(AtomicBool::new(false));
    for signal in [libc::SIGTERM, libc::SIGINT] { signal_hook::flag::register(signal, stopped.clone()).map_err(|_| "Shutdown handler unavailable")?; }
    let selected = preflight::run_node_preflight(config.node.to_str(), &config.server_dir).map_err(|_| "Node runtime preflight failed")?;
    config.node = selected.into();
    if config.api_port == 0 { config.api_port = ports::bind_ephemeral_port(None); }
    if config.ws_port == 0 { config.ws_port = ports::bind_ephemeral_port(Some(config.api_port)); }
    if config.api_port == 0 || config.ws_port == 0 || config.api_port == config.ws_port || !ports::bundled_sidecar_port_available(config.api_port) || !ports::bundled_sidecar_port_available(config.ws_port) { return Err("Server ports unavailable".into()); }
    let persistent = config.data_dir.join("instance-id");
    let instance = fs::read_to_string(&persistent).ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    fs::write(persistent, &instance).map_err(|_| "Instance identity unavailable")?;
    let boot = uuid::Uuid::new_v4().to_string();
    for (name, value) in [("boot-id", boot.clone()), ("api-port", config.api_port.to_string()), ("ws-port", config.ws_port.to_string())] { fs::write(config.data_dir.join(name), value).map_err(|_| "Boot publication failed")?; }
    let mut api = spawn(config, "server.js", &boot, &instance, "launcher-api.json")?;
    let mut ws = spawn(config, "ws-server.mjs", &boot, &instance, "launcher-ws.json")?;
    let client = reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_millis(500)).build().map_err(|_| "Health client unavailable")?;
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut opened = false;
    while !stopped.load(Ordering::SeqCst) {
        for (server, receipt) in [(&mut api, "launcher-api.json"), (&mut ws, "launcher-ws.json")] {
            let mut status: libc::siginfo_t = unsafe { std::mem::zeroed() };
            if unsafe { libc::waitid(libc::P_PID, server.child.id(), &mut status, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) } != 0 { return Err("Server status unavailable".into()); }
            if unsafe { status.si_pid() } != 0 {
                server.stop();
                // A completed child is never signaled by Drop after reaping.
                let decision = server.tracker.record_failure(Instant::now());
                match decision {
                    RestartDecision::Exhausted { .. } => return Err("Server restart budget exhausted".into()),
                    RestartDecision::Restart { delay, .. } => {
                        let until = Instant::now() + delay;
                        while Instant::now() < until && !stopped.load(Ordering::SeqCst) { std::thread::sleep(Duration::from_millis(25)); }
                        if stopped.load(Ordering::SeqCst) { break; }
                        let next = spawn(config, server.script, &boot, &instance, receipt)?;
                        // Preserve the same budget across child replacements.
                        let tracker = std::mem::replace(&mut server.tracker, RestartTracker::new(NEXT_RESTART_POLICY));
                        *server = next;
                        server.tracker = tracker;
                    }
                }
            }
        }
        if !opened {
            if client.get(format!("http://127.0.0.1:{}/api/setup/identity", config.api_port)).send().ok().and_then(|r| r.json::<serde_json::Value>().ok()).is_some_and(|v| v["bootId"].as_str() == Some(&boot)) {
                show(config)?; opened = true;
            } else if Instant::now() >= deadline { return Err("Server did not become healthy".into()); }
        } else if instance_lock.show_requested() { show(config)?; }
        std::thread::sleep(Duration::from_millis(25));
    }
    ws.stop(); api.stop();
    Ok(())
}
fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 3 || args[1] != "--config" { eprintln!("usage: o8-launcher --config <file>"); std::process::exit(2); }
    let mut config: Config = match fs::read(&args[2]).ok().and_then(|s| serde_json::from_slice(&s).ok()) { Some(c) => c, None => { eprintln!("Invalid launch configuration"); std::process::exit(2); } };
    if let Err(reason) = run(&mut config) { present(&config, &reason); std::process::exit(1); }
}
