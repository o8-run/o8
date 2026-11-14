//! Ownership recovery after a launcher crash, through the real entry point.
mod support;
use std::{
    fs,
    net::TcpStream,
    os::unix::{fs::PermissionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::Command,
};
use support::*;

fn crash_after_api_spawn(f: &Fixture) -> u32 {
    let mut crashed = f.launch_with(
        Path::new(env!("CARGO_BIN_EXE_o8-launcher")),
        &f.root.join("config.json"),
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
    let pid = f.starts("api-starts")[0];
    until(|| TcpStream::connect(("127.0.0.1", f.port("api-port"))).is_ok());
    assert!(!f.root.join("launcher-api.json").exists());
    pid
}

#[test]
fn a_server_spawned_before_its_receipt_is_stopped_at_the_next_start() {
    let mut f = Fixture::new();
    let orphan = crash_after_api_spawn(&f);
    let port = f.port("api-port");
    f.start();
    until(|| f.starts("api-starts").len() == 2);
    until(|| gone(orphan));
    assert!(f.log("launcher-stderr").contains(&format!(
        "Stopping process {orphan} from a pending server record"
    )));
    f.ready();
    assert!(!f.root.join("launcher-api.pending.json").exists());
    assert!(f.root.join("launcher-api.hold").exists());
    let receipt: serde_json::Value =
        serde_json::from_slice(&fs::read(f.root.join("launcher-api.json")).unwrap()).unwrap();
    assert_eq!(receipt["pid"], f.starts("api-starts")[1]);
    if f.port("api-port") != port {
        assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok());
    }
}

#[test]
fn a_pending_record_with_no_live_holder_is_discarded_without_signalling() {
    let mut f = Fixture::new();
    let orphan = crash_after_api_spawn(&f);
    unsafe {
        libc::kill(-(orphan as i32), libc::SIGKILL);
    }
    until(|| gone(orphan));
    // An unrelated process in its own group must never be chosen.
    let mut bystander = Command::new("sleep")
        .arg("30")
        .process_group(0)
        .spawn()
        .unwrap();
    f.start();
    f.ready();
    assert!(f
        .log("launcher-stderr")
        .contains("Pending server record discarded: no live process holds its ownership file"));
    assert!(bystander.try_wait().unwrap().is_none());
    bystander.kill().unwrap();
    bystander.wait().unwrap();
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

/// A self-contained install whose servers run a real `node` executable inside it.
fn install(f: &Fixture, root: &Path) {
    let runtime = root.join("runtime");
    fs::create_dir_all(&runtime).unwrap();
    let launcher = root.join("o8-launcher");
    fs::copy(env!("CARGO_BIN_EXE_o8-launcher"), &launcher).unwrap();
    fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).unwrap();
    let output = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .expect("node on PATH");
    let node = fs::canonicalize(String::from_utf8(output.stdout).unwrap().trim()).unwrap();
    fs::copy(&node, runtime.join("node")).unwrap();
    // Some Node builds load a sibling libnode through @loader_path.
    if let Ok(entries) = fs::read_dir(node.parent().unwrap().join("../lib")) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with("libnode") {
                fs::copy(entry.path(), runtime.join(entry.file_name())).unwrap();
            }
        }
    }
    assert!(Command::new(runtime.join("node"))
        .args(["-e", "0"])
        .status()
        .unwrap()
        .success());
    // The launcher's configured node: passes preflight, then execs the real runtime.
    let wrapper = r#"#!/usr/bin/env python3
import os,sys
if '--version' in sys.argv: print('v22.0.0'); sys.exit(0)
if '-e' in sys.argv: sys.exit(0)
api=sys.argv[1].endswith('server.js')
port=os.environ['PORT' if api else 'WS_PORT']
open(os.path.join(os.environ['O8_DATA_DIR'],'api-starts' if api else 'ws-starts'),'a').write(str(os.getpid())+'\n')
exe=os.path.join(os.path.dirname(os.path.abspath(__file__)),'runtime','node')
os.execv(exe,[exe,'-e',"require('net').createServer().listen(Number(process.argv[1]),'127.0.0.1');setInterval(()=>{},1e9)",port])
"#;
    fs::write(root.join("node"), wrapper).unwrap();
    fs::set_permissions(root.join("node"), fs::Permissions::from_mode(0o700)).unwrap();
    for name in ["server.js", "ws-server.mjs"] {
        fs::write(root.join(name), "fixture").unwrap();
    }
    let config = serde_json::json!({"data_dir":f.root,"server_dir":root,"node":root.join("node"),"window":f.root.join("window"),"api_port":0,"ws_port":0,"version":"fixture","dialog":f.root.join("dialog"),"probe":f.root.join("probe"),"focus":f.root.join("focus"),"native_lifecycle":false});
    fs::write(f.root.join("moved-config.json"), config.to_string()).unwrap();
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
    let config = f.root.join("moved-config.json");
    let mut first = f.launch_with(&old.join("o8-launcher"), &config, &[], "first-stderr");
    until(|| {
        f.root.join("launcher-api.json").exists()
            && f.root.join("launcher-ws.json").exists()
            && f.starts("api-starts").len() == 1
            && f.starts("ws-starts").len() == 1
            && TcpStream::connect(("127.0.0.1", f.port("api-port"))).is_ok()
            && TcpStream::connect(("127.0.0.1", f.port("ws-port"))).is_ok()
    });
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
    install_config(&f, &new);
    f.launcher = Some(f.launch_with(&new.join("o8-launcher"), &config, &[], "launcher-stderr"));
    until(|| f.starts("api-starts").len() == 2 && f.starts("ws-starts").len() == 2);
    for pid in servers {
        until(|| gone(pid));
    }
    let log = f.log("launcher-stderr");
    for pid in servers {
        assert!(log.contains(&format!(
            "Stopping process {pid} started from moved install"
        )));
    }
    until(|| f.root.join("launcher-api.json").exists() && f.root.join("launcher-ws.json").exists());
    for name in ["launcher-api.json", "launcher-ws.json"] {
        let receipt: serde_json::Value =
            serde_json::from_slice(&fs::read(f.root.join(name)).unwrap()).unwrap();
        assert_eq!(
            receipt["install"],
            new.join("o8-launcher").to_string_lossy().as_ref()
        );
    }
    // Each start is recorded just before its wrapper execs into the runtime.
    for pid in [f.starts("api-starts")[1], f.starts("ws-starts")[1]] {
        until(|| executable(pid).starts_with(&canonical));
    }
}

fn install_config(f: &Fixture, root: &Path) {
    let path = f.root.join("moved-config.json");
    let mut config: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config["server_dir"] = root.to_string_lossy().as_ref().into();
    config["node"] = root.join("node").to_string_lossy().as_ref().into();
    fs::write(path, config.to_string()).unwrap();
}
