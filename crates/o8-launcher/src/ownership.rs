//! Install-scoped ownership. Kernel birth identity survives exec and process-title changes.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};
#[derive(Debug, Serialize, Deserialize)]
pub struct Receipt {
    pub pid: u32,
    pub identity: String,
    pub directory: PathBuf,
    pub install: PathBuf,
    pub port: u16,
    pub parent: u32,
}
#[cfg(target_os = "macos")]
pub fn identity(pid: u32) -> Option<String> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let length = std::mem::size_of_val(&info);
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            length as i32,
        )
    };
    if read != length as i32 || info.pbi_uid != unsafe { libc::getuid() } {
        return None;
    }
    Some(format!(
        "{}:{}:{}:{}",
        info.pbi_uid, info.pbi_pid, info.pbi_start_tvsec, info.pbi_start_tvusec
    ))
}
#[cfg(target_os = "linux")]
pub fn identity(pid: u32) -> Option<String> {
    if fs::metadata(format!("/proc/{pid}")).ok()?.uid() != unsafe { libc::getuid() } {
        return None;
    }
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields = stat
        .rsplit_once(") ")?
        .1
        .split_whitespace()
        .collect::<Vec<_>>();
    Some(format!(
        "{}:{}:{}",
        fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .ok()?
            .trim(),
        pid,
        fields.get(19)?
    ))
}
pub fn parent(pid: u32) -> Option<u32> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "ppid="])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}
fn cwd(pid: u32) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        fs::read_link(format!("/proc/{pid}/cwd")).ok()
    }
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("/usr/sbin/lsof")
            .args(["-p", &pid.to_string(), "-a", "-d", "cwd", "-F", "n"])
            .output()
            .ok()?;
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .find_map(|line| line.strip_prefix('n').map(PathBuf::from))
    }
}
pub fn private_write(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if file.metadata()?.uid() != unsafe { libc::getuid() }
        || file.metadata()?.nlink() != 1
        || !file.metadata()?.is_file()
    {
        return Err(std::io::Error::other("Foreign ownership file"));
    }
    if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    file.set_len(0)?;
    file.write_all(data)?;
    file.sync_all()
}
fn same_directory(a: &Path, b: &Path) -> bool {
    fs::canonicalize(a)
        .ok()
        .zip(fs::canonicalize(b).ok())
        .is_some_and(|(a, b)| a == b)
}
fn matches(pid: u32, cookie: &str) -> bool {
    identity(pid).as_deref() == Some(cookie) && unsafe { libc::getpgid(pid as i32) } == pid as i32
}
fn port_free(port: u16) -> bool {
    o8_launch_core::ports::bundled_sidecar_port_available(port)
}
pub fn wait_for_port(port: u16) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !port_free(port) {
        if Instant::now() >= deadline {
            return Err("Owned server port did not become free".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Ok(())
}
fn group_members(group: u32) -> Vec<(u32, String)> {
    let Ok(output) = Command::new("ps").args(["-axo", "pid=,pgid="]).output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse::<u32>().ok()?;
            let pgid = fields.next()?.parse::<u32>().ok()?;
            (pgid == group)
                .then(|| identity(pid).map(|id| (pid, id)))
                .flatten()
        })
        .collect()
}
// o8d drains for five seconds plus 250 ms after its producer closes.
// Give the Node leader its existing one-second TERM budget before escalation.
const GROUP_DRAIN: Duration = Duration::from_secs(7);
fn group_running(group: u32) -> Result<bool, String> {
    let output = Command::new("ps")
        .args(["-axo", "pgid=,stat="])
        .output()
        .map_err(|_| "Process group inspection unavailable")?;
    if !output.status.success() {
        return Err("Process group inspection unavailable".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        let mut fields = line.split_whitespace();
        fields.next().and_then(|id| id.parse::<u32>().ok()) == Some(group)
            && fields.next().is_some_and(|state| !state.starts_with('Z'))
    }))
}
fn stop_group(pid: u32, cookie: Option<&str>, pinned: bool, port: u16) -> Result<(), String> {
    let members = group_members(pid);
    if !pinned && !cookie.is_some_and(|cookie| matches(pid, cookie)) {
        return Err("Server identity changed before cleanup".into());
    }
    // Only terminate the leader first. Its pipe closure lets GPUI and o8d drain.
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    let started = Instant::now();
    let mut leader_killed = false;
    loop {
        if !group_running(pid)? && port_free(port) {
            return Ok(());
        }
        if !leader_killed && started.elapsed() >= Duration::from_secs(1) {
            if pinned || cookie.is_some_and(|cookie| matches(pid, cookie)) {
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
            }
            leader_killed = true;
        }
        if started.elapsed() >= GROUP_DRAIN {
            let still_owned = pinned
                || members.iter().any(|(member, id)| {
                    identity(*member).as_ref() == Some(id)
                        && unsafe { libc::getpgid(*member as i32) } == pid as i32
                });
            if !still_owned {
                return Err("Remaining process group ownership cannot be verified".into());
            }
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            wait_for_port(port)?;
            let deadline = Instant::now() + Duration::from_secs(1);
            while group_running(pid)? {
                if Instant::now() >= deadline {
                    return Err("Owned process group did not stop".into());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
pub fn stop_child(child: &mut std::process::Child, port: u16) -> Result<(), String> {
    // An unreaped Child pins its PID/group against reuse throughout escalation.
    stop_group(child.id(), None, true, port)?;
    child.wait().map_err(|_| "Server reap failed")?;
    wait_for_port(port)
}

pub fn cleanup(directory: &Path, server_dir: &Path) -> Result<(), String> {
    for name in ["launcher-api.json", "launcher-ws.json"] {
        let path = directory.join(name);
        let mut file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&path)
        {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("Ownership receipt unavailable".into()),
        };
        let metadata = file
            .metadata()
            .map_err(|_| "Ownership receipt unavailable")?;
        if metadata.uid() != unsafe { libc::getuid() }
            || metadata.mode() & 0o077 != 0
            || !metadata.is_file()
            || metadata.nlink() != 1
        {
            return Err("Ownership receipt is not private".into());
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(8193)
            .read_to_end(&mut bytes)
            .map_err(|_| "Ownership receipt unavailable")?;
        if bytes.len() > 8192 {
            return Err("Invalid ownership receipt".into());
        }
        let receipt: Receipt =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid ownership receipt")?;
        let install = std::env::current_exe().map_err(|_| "Install unavailable")?;
        let current = identity(receipt.pid);
        let moved = receipt.install != install;
        let stale = !same_directory(&receipt.directory, directory)
            || current.as_deref() != Some(&receipt.identity);
        // Identity mismatch (including an unreadable foreign UID) never grants
        // signalling authority. Discard the receipt without waiting on its port.
        if stale || (moved && !old_install_server(receipt.pid, &receipt.install, server_dir)) {
            fs::remove_file(path).map_err(|_| "Ownership receipt unavailable")?;
            continue;
        }
        if current.is_some() {
            if !matches(receipt.pid, &receipt.identity) {
                return Err("Server process group changed".into());
            }
            if parent(receipt.pid) != Some(1) {
                return Err("Prior server still actively parented".into());
            }
            if !cwd(receipt.pid).is_some_and(|value| same_directory(&value, server_dir)) {
                return Err("Foreign server directory".into());
            }
            stop_group(receipt.pid, Some(&receipt.identity), false, receipt.port)?;
        }
        wait_for_port(receipt.port)?;
        fs::remove_file(path).map_err(|_| "Ownership receipt unavailable")?;
    }
    Ok(())
}

fn old_install_server(pid: u32, install: &Path, server_dir: &Path) -> bool {
    #[cfg(target_os = "linux")]
    let executable = fs::read_link(format!("/proc/{pid}/exe")).ok();
    #[cfg(target_os = "macos")]
    let executable = {
        let mut bytes = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let count = unsafe {
            libc::proc_pidpath(pid as i32, bytes.as_mut_ptr().cast(), bytes.len() as u32)
        };
        (count > 0).then(|| {
            PathBuf::from(std::ffi::OsStr::from_bytes(
                bytes.split(|b| *b == 0).next().unwrap_or_default(),
            ))
        })
    };
    #[cfg(target_os = "macos")]
    use std::os::unix::ffi::OsStrExt;
    executable.is_some_and(|path| {
        path.file_name().is_some_and(|name| name == "node")
            && install.parent().is_some_and(|root| path.starts_with(root))
    }) && cwd(pid).is_some_and(|path| same_directory(&path, server_dir))
}
