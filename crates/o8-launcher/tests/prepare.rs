#![cfg(unix)]
//! The startup helper (`--prepare`) through the real launcher binary.
mod support;
use std::{
    fs,
    io::{Read, Write},
    os::unix::{io::AsRawFd, process::CommandExt},
    process::{Command, Stdio},
};
use support::{gone, until, Fixture};

/// Runs the helper directly, the configuration on standard input, optionally
/// handing it `lock` the way the launcher does. Standard input stays open
/// until the helper exits, as the launcher keeps it.
fn helper(f: &Fixture, args: &[&str], lock: Option<i32>) -> (Option<i32>, String) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_o8-launcher"));
    command
        .args(args)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap())
        .env("HOME", &f.root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(fd) = lock {
        command.env("O8_LAUNCHER_LOCK_FD", fd.to_string());
        unsafe {
            command.pre_exec(move || {
                if libc::fcntl(fd, libc::F_SETFD, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let mut child = command.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let _ = stdin.write_all(&fs::read(f.root.join("config.json")).unwrap());
    let _ = stdin.write_all(b"\n");
    let mut out = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut out)
        .unwrap();
    let status = child.wait().unwrap();
    drop(stdin);
    (status.code(), out)
}

fn open_lock(f: &Fixture) -> fs::File {
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(f.root.join("launcher.lock"))
        .unwrap()
}

#[test]
fn prepare_mode_refuses_unless_handed_the_held_instance_lock() {
    let f = Fixture::new();
    let config = f.root.join("config.json");
    // The file-argument form any same-user process could run.
    let (status, _) = helper(&f, &["--prepare", config.to_str().unwrap()], None);
    assert_ne!(status, Some(0));
    assert!(!f.root.join("probe-ran").exists(), "ran without a lock");
    // No descriptor at all.
    let (status, out) = helper(&f, &["--prepare"], None);
    assert_ne!(status, Some(0));
    assert!(out.contains("instance lock"), "{out}");
    // The right file, but a description that does not hold the lock.
    let holder = open_lock(&f);
    assert_eq!(
        unsafe { libc::flock(holder.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    let other = open_lock(&f);
    let (status, out) = helper(&f, &["--prepare"], Some(other.as_raw_fd()));
    assert_ne!(status, Some(0));
    assert!(out.contains("instance lock"), "{out}");
    // A held lock on some other file.
    let foreign = fs::File::open(&config).unwrap();
    assert_eq!(
        unsafe { libc::flock(foreign.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    let (status, _) = helper(&f, &["--prepare"], Some(foreign.as_raw_fd()));
    assert_ne!(status, Some(0));
    assert!(!f.root.join("probe-ran").exists(), "ran without the lock");
    // Handed the held lock, it runs from the configuration on standard input.
    let (status, out) = helper(&f, &["--prepare"], Some(holder.as_raw_fd()));
    assert_eq!(status, Some(0), "{out}");
    assert!(out.contains("\"node\""), "{out}");
    assert!(f.root.join("probe-ran").exists());
}

#[test]
fn a_force_quit_launcher_takes_its_startup_helper_and_lock_with_it() {
    let mut f = Fixture::new();
    fs::write(f.root.join("hold-probe"), "1").unwrap();
    f.start();
    until(|| f.log("probe-entered").parse::<u32>().is_ok());
    let probe: u32 = f.log("probe-entered").parse().unwrap();
    let mut launcher = f.launcher.take().unwrap();
    unsafe {
        libc::kill(launcher.id() as i32, libc::SIGKILL);
    }
    launcher.wait().unwrap();
    // The probe is still held: only the helper ending its group stops it.
    until(|| gone(probe));
    let lock = open_lock(&f);
    until(|| unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0);
    drop(lock);
    fs::remove_file(f.root.join("hold-probe")).unwrap();
    f.start();
    f.ready();
    assert_eq!(f.starts("api-starts").len(), 1);
    assert_eq!(f.starts("ws-starts").len(), 1);
}

#[test]
fn a_finished_startup_helper_leaves_login_profile_jobs_running() {
    let mut f = Fixture::new();
    fs::write(f.root.join("probe-background"), "1").unwrap();
    f.start();
    f.ready();
    until(|| f.log("background-pid").parse::<u32>().is_ok());
    let job: u32 = f.log("background-pid").parse().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert!(!gone(job), "a successful prepare killed a profile job");
}

fn launch_with_reply(f: &mut Fixture, reply: &serde_json::Value, pad: usize) {
    let reply = reply.to_string();
    let pad = pad.to_string();
    f.launcher = Some(f.launch_with(
        std::path::Path::new(env!("CARGO_BIN_EXE_o8-launcher")),
        &f.root.join("config.json"),
        &[
            ("O8_LAUNCHER_PREPARE_REPLY", &reply),
            ("O8_LAUNCHER_PREPARE_REPLY_PAD", &pad),
        ],
        "launcher-stderr",
    ));
}

fn reply(node: &str) -> serde_json::Value {
    serde_json::json!({
        "path": std::env::var("PATH").unwrap(),
        "keys": [["GEMINI_API_KEY", "fixture-key"], ["O8_FORGED_KEY", "forged"]],
        "node": node,
    })
}

fn startup_failure(f: &mut Fixture) -> String {
    let mut launcher = f.launcher.take().unwrap();
    until(|| launcher.try_wait().unwrap().is_some());
    assert_eq!(launcher.wait().unwrap().code(), Some(1));
    assert!(f.starts("api-starts").is_empty());
    f.log("dialog-reached")
}

#[test]
fn the_launcher_keeps_only_forwardable_keys_from_the_helpers_reply() {
    let mut f = Fixture::new();
    let reply = reply(f.root.join("node").to_str().unwrap());
    launch_with_reply(&mut f, &reply, 0);
    f.ready();
    let env: serde_json::Value = serde_json::from_str(&f.log("api-env")).unwrap();
    assert_eq!(env["GEMINI_API_KEY"], "fixture-key");
    assert!(env["O8_FORGED_KEY"].is_null(), "forged key forwarded");
}

#[test]
fn the_launcher_refuses_a_relative_runtime_from_the_helper() {
    let mut f = Fixture::new();
    let reply = reply("fixture-node");
    launch_with_reply(&mut f, &reply, 0);
    let message = startup_failure(&mut f);
    assert!(message.contains("Startup checks failed"), "{message}");
}

#[test]
fn the_launcher_refuses_an_oversized_helper_reply() {
    let mut f = Fixture::new();
    let reply = reply(f.root.join("node").to_str().unwrap());
    launch_with_reply(&mut f, &reply, 300 * 1024);
    let message = startup_failure(&mut f);
    assert!(message.contains("Startup checks failed"), "{message}");
}
