//! Ownership recovery after a launcher crash, through the real entry point.
//!
//! Servers here run a small compiled runtime, so the configured runtime is the
//! executable the kernel reports, as with the real Node binary.
mod support;
use std::{
    fs,
    net::TcpStream,
    os::unix::{fs::PermissionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::Command,
};
use support::*;

const RUNTIME: &str = r#"
use std::{env, fs, io::Write, net::TcpListener, path::Path, process::Command, thread, time::Duration};
extern "C" {
    fn fork() -> i32;
    fn setsid() -> i32;
    fn setpgid(pid: i32, group: i32) -> i32;
    fn _exit(code: i32) -> !;
}
// Double fork, then lead a new group: parent 1 and its own process group.
const FOREIGN: &str = "import os,sys,time\nif os.fork(): os._exit(0)\nos.setsid()\nif os.fork(): os._exit(0)\nos.setpgid(0,0)\nopen(sys.argv[1],'w').write(str(os.getpid()))\nwhile True: time.sleep(1)\n";
fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--version") {
        println!("v22.0.0");
        return;
    }
    if args.iter().any(|a| a == "-e") {
        return;
    }
    if args.get(1).map(String::as_str) == Some("daemon") {
        unsafe {
            if fork() != 0 { _exit(0) }
            setsid();
            if fork() != 0 { _exit(0) }
            setpgid(0, 0);
        }
        fs::write(&args[2], std::process::id().to_string()).unwrap();
        loop { thread::sleep(Duration::from_secs(1)) }
    }
    let api = args.get(1).is_some_and(|a| a.ends_with("server.js"));
    let port: u16 = env::var(if api { "PORT" } else { "WS_PORT" }).unwrap().parse().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    let data = env::var("O8_DATA_DIR").unwrap();
    let data = Path::new(&data);
    if api {
        // Both inherit the ownership descriptor, as any child of a server can.
        if data.join("daemon-runtime").exists() {
            Command::new(env::current_exe().unwrap()).arg("daemon").arg(data.join("runtime-daemon-pid")).status().unwrap();
        }
        if data.join("daemon-foreign").exists() {
            Command::new("python3").arg("-c").arg(FOREIGN).arg(data.join("foreign-daemon-pid")).status().unwrap();
        }
    }
    fs::OpenOptions::new().create(true).append(true)
        .open(data.join(if api { "api-starts" } else { "ws-starts" })).unwrap()
        .write_all(format!("{}\n", std::process::id()).as_bytes()).unwrap();
    for stream in listener.incoming() { drop(stream) }
}
"#;

/// Kills fixture daemons on every exit path. They lead their own groups.
struct Daemons<'a>(&'a Path);
impl Daemons<'_> {
    fn pid(&self, name: &str) -> u32 {
        until(|| {
            fs::read_to_string(self.0.join(name))
                .is_ok_and(|text| text.trim().parse::<u32>().is_ok())
        });
        fs::read_to_string(self.0.join(name))
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }
}
impl Drop for Daemons<'_> {
    fn drop(&mut self) {
        for name in ["runtime-daemon-pid", "foreign-daemon-pid"] {
            let Some(pid) = fs::read_to_string(self.0.join(name))
                .ok()
                .and_then(|text| text.trim().parse::<i32>().ok())
            else {
                continue;
            };
            let output = Command::new("ps")
                .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
                .output()
                .unwrap();
            if String::from_utf8_lossy(&output.stdout).contains(&*self.0.to_string_lossy()) {
                unsafe { libc::kill(pid, libc::SIGKILL) };
            }
        }
    }
}

/// An install directory holding a launcher copy and the fixture runtime as `node`.
fn install(f: &Fixture, root: &Path) {
    fs::create_dir_all(root).unwrap();
    let launcher = root.join("o8-launcher");
    fs::copy(env!("CARGO_BIN_EXE_o8-launcher"), &launcher).unwrap();
    fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).unwrap();
    let source = f.root.join("runtime.rs");
    fs::write(&source, RUNTIME).unwrap();
    let rustc = std::env::var_os("CARGO")
        .map(PathBuf::from)
        .map(|cargo| cargo.with_file_name("rustc"))
        .filter(|rustc| rustc.is_file())
        .unwrap_or_else(|| PathBuf::from("rustc"));
    let built = Command::new(rustc)
        .args(["--edition", "2021", "-o"])
        .arg(root.join("node"))
        .arg(&source)
        .status()
        .unwrap();
    assert!(built.success(), "fixture runtime did not compile");
    for name in ["server.js", "ws-server.mjs"] {
        fs::write(root.join(name), "fixture").unwrap();
    }
    write_config(f, root);
}
fn write_config(f: &Fixture, root: &Path) {
    let config = serde_json::json!({"data_dir":f.root,"server_dir":root,"node":root.join("node"),"window":f.root.join("window"),"api_port":0,"ws_port":0,"version":"fixture","dialog":f.root.join("dialog"),"probe":f.root.join("probe"),"focus":f.root.join("focus"),"native_lifecycle":false});
    fs::write(f.root.join("install-config.json"), config.to_string()).unwrap();
}
fn launch(f: &Fixture, root: &Path, extra: &[(&str, &str)], stderr: &str) -> std::process::Child {
    f.launch_with(
        &root.join("o8-launcher"),
        &f.root.join("install-config.json"),
        extra,
        stderr,
    )
}
fn running(f: &Fixture, api: usize, ws: usize) {
    until(|| {
        f.root.join("launcher-api.json").exists()
            && f.root.join("launcher-ws.json").exists()
            && f.starts("api-starts").len() == api
            && f.starts("ws-starts").len() == ws
            && TcpStream::connect(("127.0.0.1", f.port("api-port"))).is_ok()
            && TcpStream::connect(("127.0.0.1", f.port("ws-port"))).is_ok()
    });
}
fn crash_after_api_spawn(f: &Fixture, root: &Path) -> u32 {
    let mut crashed = launch(
        f,
        root,
        &[("O8_LAUNCHER_FAULT", "after-spawn:server.js")],
        "crashed-stderr",
    );
    until(|| crashed.try_wait().unwrap().is_some());
    assert_eq!(
        crashed.wait().unwrap().code(),
        Some(86),
        "fault not injected"
    );
    until(|| f.starts("api-starts").len() == 1);
    until(|| TcpStream::connect(("127.0.0.1", f.port("api-port"))).is_ok());
    assert!(!f.root.join("launcher-api.json").exists());
    assert!(f.root.join("launcher-api.pending.json").exists());
    f.starts("api-starts")[0]
}
fn alive(pid: u32) -> bool {
    !gone(pid)
}

#[test]
fn pending_recovery_stops_only_the_proven_server_not_inheriting_daemons() {
    let mut f = Fixture::new();
    let root = f.root.join("install");
    install(&f, &root);
    let daemons = Daemons(&f.root);
    fs::write(f.root.join("daemon-runtime"), "1").unwrap();
    fs::write(f.root.join("daemon-foreign"), "1").unwrap();
    let server = crash_after_api_spawn(&f, &root);
    // Both daemons inherited the descriptor, have parent 1 and lead their groups.
    let runtime_daemon = daemons.pid("runtime-daemon-pid");
    let foreign_daemon = daemons.pid("foreign-daemon-pid");
    for pid in [runtime_daemon, foreign_daemon] {
        assert_eq!(unsafe { libc::getpgid(pid as i32) }, pid as i32);
    }
    for name in ["daemon-runtime", "daemon-foreign"] {
        fs::remove_file(f.root.join(name)).unwrap();
    }
    f.launcher = Some(launch(&f, &root, &[], "launcher-stderr"));
    running(&f, 2, 1);
    until(|| gone(server));
    assert!(
        alive(runtime_daemon),
        "inheriting runtime daemon was signalled"
    );
    assert!(
        alive(foreign_daemon),
        "inheriting foreign daemon was signalled"
    );
    let log = f.log("launcher-stderr");
    assert!(log.contains(&format!(
        "Stopping process {server} from a pending server record"
    )));
    for pid in [runtime_daemon, foreign_daemon] {
        assert!(log.contains(&format!(
            "Process {pid} holds a server ownership file but is not the proven server"
        )));
    }
}

#[test]
fn a_pid_reused_after_the_proof_is_never_signalled() {
    let mut f = Fixture::new();
    let root = f.root.join("install");
    install(&f, &root);
    let server = crash_after_api_spawn(&f, &root);
    // From the proof onward the launcher reads every PID as a process born at
    // another time, as when the proven server exits and its PID is reused.
    f.launcher = Some(launch(
        &f,
        &root,
        &[("O8_LAUNCHER_FAULT", "reuse-after-proof")],
        "launcher-stderr",
    ));
    running(&f, 2, 1);
    assert!(
        alive(server),
        "a process proven under another identity was signalled"
    );
    assert!(f.log("launcher-stderr").contains(&format!(
        "Pending server record discarded: process {server} changed identity after its proof; nothing was signalled"
    )));
}

#[test]
fn a_holder_with_a_live_parent_does_not_block_the_start() {
    let mut f = Fixture::new();
    let root = f.root.join("install");
    install(&f, &root);
    let server = crash_after_api_spawn(&f, &root);
    unsafe { libc::kill(-(server as i32), libc::SIGKILL) };
    until(|| gone(server));
    // This test process stays its parent; it leads its own group.
    let mut holder = Command::new("python3")
        .args(["-c", "import sys,time\nf=open(sys.argv[1])\nopen(sys.argv[2],'w').write('1')\nwhile True: time.sleep(1)"])
        .arg(f.root.join("launcher-api.hold"))
        .arg(f.root.join("holder-ready"))
        .process_group(0)
        .spawn()
        .unwrap();
    until(|| f.root.join("holder-ready").exists());
    f.launcher = Some(launch(&f, &root, &[], "launcher-stderr"));
    let started = std::time::Instant::now();
    while !(f.root.join("launcher-api.json").exists() && f.root.join("launcher-ws.json").exists()) {
        if f.launcher.as_mut().unwrap().try_wait().unwrap().is_some()
            || started.elapsed().as_secs() > 12
        {
            holder.kill().unwrap();
            holder.wait().unwrap();
            panic!("start blocked: {}", f.log("launcher-stderr"));
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    let alive = holder.try_wait().unwrap().is_none();
    holder.kill().unwrap();
    holder.wait().unwrap();
    assert!(alive, "live-parent holder was signalled");
}

#[test]
fn a_pending_record_with_no_live_holder_is_discarded_without_signalling() {
    let mut f = Fixture::new();
    let root = f.root.join("install");
    install(&f, &root);
    let server = crash_after_api_spawn(&f, &root);
    unsafe { libc::kill(-(server as i32), libc::SIGKILL) };
    until(|| gone(server));
    let mut bystander = Command::new("sleep")
        .arg("30")
        .process_group(0)
        .spawn()
        .unwrap();
    f.launcher = Some(launch(&f, &root, &[], "launcher-stderr"));
    running(&f, 2, 1);
    assert!(f
        .log("launcher-stderr")
        .contains("Pending server record discarded: no live process is proven to be its server"));
    assert!(bystander.try_wait().unwrap().is_none());
    bystander.kill().unwrap();
    bystander.wait().unwrap();
}

#[test]
fn empty_or_truncated_records_are_discarded_and_the_launcher_starts() {
    for name in ["launcher-api.json", "launcher-api.pending.json"] {
        for bytes in [&b""[..], &br#"{"hold":{"tok"#[..]] {
            let mut f = Fixture::new();
            let path = f.root.join(name);
            fs::write(&path, bytes).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            f.start();
            f.ready();
            assert!(
                f.log("launcher-stderr")
                    .contains("discarded: it is empty or damaged"),
                "{name}: {}",
                f.log("launcher-stderr")
            );
        }
    }
}

#[test]
fn a_moved_install_without_ownership_proof_is_left_running_and_logged() {
    let mut f = Fixture::new();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let mut stranger = Command::new(f.root.join("node"))
        .arg(f.root.join("server.js"))
        .current_dir(&f.root)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap())
        .env("PORT", port.to_string())
        .env("O8_BOOT_ID", "fixture")
        .process_group(0)
        .spawn()
        .unwrap();
    until(|| TcpStream::connect(("127.0.0.1", port)).is_ok());
    // An orphan parent would make it eligible on every other check.
    let receipt = o8_launcher::ownership::Receipt {
        pid: stranger.id(),
        identity: o8_launcher::ownership::identity(stranger.id()).unwrap(),
        directory: f.root.clone(),
        install: f.root.join("another-install/o8-launcher"),
        port,
        parent: 1,
        hold: None,
        spawned: 0,
        runtime: None,
    };
    o8_launcher::ownership::private_write(
        &f.root.join("launcher-api.json"),
        &serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    f.start();
    f.ready();
    assert!(stranger.try_wait().unwrap().is_none());
    assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
    assert!(f.log("launcher-stderr").contains(&format!(
        "Ownership receipt for process {} discarded: it was started from",
        stranger.id()
    )));
    stranger.kill().unwrap();
    stranger.wait().unwrap();
}

#[cfg(target_os = "macos")]
fn executable(pid: u32) -> PathBuf {
    let mut bytes = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let count =
        unsafe { libc::proc_pidpath(pid as i32, bytes.as_mut_ptr().cast(), bytes.len() as u32) };
    assert!(count > 0);
    PathBuf::from(String::from_utf8_lossy(&bytes[..count as usize]).into_owned())
}
#[cfg(target_os = "linux")]
fn executable(pid: u32) -> PathBuf {
    fs::read_link(format!("/proc/{pid}/exe")).unwrap()
}

#[test]
fn a_really_moved_install_stops_its_servers_and_restarts_from_the_new_location() {
    let mut f = Fixture::new();
    let old = f.root.join("install-a");
    let new = f.root.join("install-b");
    install(&f, &old);
    let daemons = Daemons(&f.root);
    fs::write(f.root.join("daemon-runtime"), "1").unwrap();
    let mut first = launch(&f, &old, &[], "first-stderr");
    running(&f, 1, 1);
    let daemon = daemons.pid("runtime-daemon-pid");
    fs::remove_file(f.root.join("daemon-runtime")).unwrap();
    let servers = [f.starts("api-starts")[0], f.starts("ws-starts")[0]];
    // The launcher crashes, leaving both servers running from the old location.
    first.kill().unwrap();
    first.wait().unwrap();
    fs::rename(&old, &new).unwrap();
    let canonical = fs::canonicalize(&new).unwrap();
    for pid in servers {
        // The kernel reports the moved path, so a path proof cannot hold.
        assert!(
            executable(pid).starts_with(&canonical),
            "{:?}",
            executable(pid)
        );
    }
    write_config(&f, &new);
    f.launcher = Some(launch(&f, &new, &[], "launcher-stderr"));
    running(&f, 2, 2);
    for pid in servers {
        until(|| gone(pid));
    }
    // It inherited the API server's descriptor and runs the same runtime.
    assert!(
        alive(daemon),
        "inheriting daemon was signalled after the move"
    );
    let log = f.log("launcher-stderr");
    for pid in servers {
        assert!(log.contains(&format!(
            "Stopping process {pid} started from moved install"
        )));
    }
    for name in ["launcher-api.json", "launcher-ws.json"] {
        let receipt: serde_json::Value =
            serde_json::from_slice(&fs::read(f.root.join(name)).unwrap()).unwrap();
        assert_eq!(
            receipt["install"],
            new.join("o8-launcher").to_string_lossy().as_ref()
        );
    }
    for pid in [f.starts("api-starts")[1], f.starts("ws-starts")[1]] {
        assert!(executable(pid).starts_with(&canonical));
    }
}
