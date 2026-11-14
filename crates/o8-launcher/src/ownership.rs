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
    /// Absent in receipts written before the hold proof existed.
    #[serde(default)]
    pub hold: Option<Hold>,
}
/// A private file the server inherits open at spawn. Its token names this
/// spawn; device and inode let a later start find the process holding it,
/// wherever the install has moved since.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hold {
    pub token: String,
    pub dev: u64,
    pub ino: u64,
}
/// Written durably before spawn and replaced by a full receipt once the
/// process identity is known.
#[derive(Debug, Serialize, Deserialize)]
pub struct Pending {
    pub hold: Hold,
    pub directory: PathBuf,
    pub install: PathBuf,
    pub port: u16,
}
pub fn pending_path(receipt: &Path) -> PathBuf {
    receipt.with_extension("pending.json")
}
pub fn hold_path(receipt: &Path) -> PathBuf {
    receipt.with_extension("hold")
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
    file.sync_all()?;
    sync_parent(path)
}
/// Makes a just-created or removed name durable before the next step relies on it.
pub fn sync_parent(path: &Path) -> std::io::Result<()> {
    match path.parent() {
        Some(parent) => fs::File::open(parent)?.sync_all(),
        None => Ok(()),
    }
}
/// Creates a fresh hold file. The caller keeps the returned handle open only
/// until the child has inherited it.
pub fn create_hold(path: &Path, token: &str) -> std::io::Result<(fs::File, Hold)> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    file.write_all(token.as_bytes())?;
    file.sync_all()?;
    sync_parent(path)?;
    let metadata = file.metadata()?;
    Ok((
        file,
        Hold {
            token: token.into(),
            dev: metadata.dev(),
            ino: metadata.ino(),
        },
    ))
}
/// The hold file still exists with the recorded inode and token. Without this,
/// a recycled inode number could match an unrelated open file.
fn hold_intact(path: &Path, hold: &Hold) -> bool {
    let Ok(mut file) = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    else {
        return false;
    };
    let Ok(metadata) = file.metadata() else {
        return false;
    };
    let mut token = String::new();
    metadata.is_file()
        && metadata.uid() == unsafe { libc::getuid() }
        && metadata.dev() == hold.dev
        && metadata.ino() == hold.ino
        && Read::by_ref(&mut file)
            .take(256)
            .read_to_string(&mut token)
            .is_ok()
        && token == hold.token
}
/// The process has the hold file open. Only same-user processes are inspectable.
#[cfg(target_os = "linux")]
pub fn holds(pid: u32, hold: &Hold) -> bool {
    let Ok(entries) = fs::read_dir(format!("/proc/{pid}/fd")) else {
        return false;
    };
    entries.flatten().any(|entry| {
        fs::metadata(entry.path())
            .is_ok_and(|metadata| metadata.dev() == hold.dev && metadata.ino() == hold.ino)
    })
}
#[cfg(target_os = "macos")]
pub fn holds(pid: u32, hold: &Hold) -> bool {
    // <sys/proc_info.h>; libc does not export the vnode descriptor record.
    #[repr(C)]
    struct FileInfo {
        openflags: u32,
        status: u32,
        offset: i64,
        kind: i32,
        guardflags: u32,
    }
    #[repr(C)]
    struct VnodeDescriptor {
        file: FileInfo,
        vnode: libc::vnode_info,
    }
    const PROC_PIDFDVNODEINFO: libc::c_int = 1;
    let entry = std::mem::size_of::<libc::proc_fdinfo>();
    let needed = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDLISTFDS,
            0,
            std::ptr::null_mut(),
            0,
        )
    };
    if needed <= 0 {
        return false;
    }
    // Room for descriptors opened between the two calls.
    let mut descriptors: Vec<libc::proc_fdinfo> =
        vec![unsafe { std::mem::zeroed() }; needed as usize / entry + 32];
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDLISTFDS,
            0,
            descriptors.as_mut_ptr().cast(),
            (descriptors.len() * entry) as i32,
        )
    };
    if read <= 0 {
        return false;
    }
    descriptors.truncate(read as usize / entry);
    descriptors.iter().any(|descriptor| {
        if descriptor.proc_fdtype != libc::PROX_FDTYPE_VNODE as u32 {
            return false;
        }
        let mut info: VnodeDescriptor = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<VnodeDescriptor>() as i32;
        let count = unsafe {
            libc::proc_pidfdinfo(
                pid as i32,
                descriptor.proc_fd,
                PROC_PIDFDVNODEINFO,
                (&mut info as *mut VnodeDescriptor).cast(),
                size,
            )
        };
        // st_dev is a 32-bit dev_t on macOS.
        count == size
            && info.vnode.vi_stat.vst_dev == hold.dev as u32
            && info.vnode.vi_stat.vst_ino == hold.ino
    })
}
/// Same-user process group leaders other than this process.
fn group_leaders() -> Vec<u32> {
    #[cfg(target_os = "linux")]
    let pids: Vec<u32> = fs::read_dir("/proc")
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.file_name().to_str()?.parse().ok())
                .collect()
        })
        .unwrap_or_default();
    #[cfg(target_os = "macos")]
    let pids: Vec<u32> = {
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        let mut pids = vec![0 as libc::pid_t; count.max(0) as usize + 64];
        let size = (pids.len() * std::mem::size_of::<libc::pid_t>()) as i32;
        let read = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), size) };
        pids.truncate(read.max(0) as usize);
        pids.into_iter()
            .filter(|pid| *pid > 0)
            .map(|pid| pid as u32)
            .collect()
    };
    pids.into_iter()
        .filter(|pid| {
            *pid != std::process::id()
                && unsafe { libc::getpgid(*pid as i32) } == *pid as i32
                && identity(*pid).is_some()
        })
        .collect()
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
    wait_for_port_until(port, Instant::now() + Duration::from_secs(3))
}
fn wait_for_port_until(port: u16, deadline: Instant) -> Result<(), String> {
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
// Time kept after group escalation for the kernel to release the port.
const KILL_RESERVE: Duration = Duration::from_secs(1);
// Startup cleanup of a prior run keeps the historical per-group budget.
const ORPHAN_BUDGET: Duration = Duration::from_secs(11);
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
fn stop_group(
    pid: u32,
    cookie: Option<&str>,
    pinned: bool,
    port: u16,
    deadline: Instant,
) -> Result<(), String> {
    let members = group_members(pid);
    if !pinned && !cookie.is_some_and(|cookie| matches(pid, cookie)) {
        return Err("Server identity changed before cleanup".into());
    }
    // Only terminate the leader first. Its pipe closure lets GPUI and o8d drain.
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    let started = Instant::now();
    // The shared deadline shortens draining, never the escalation that follows it.
    let drain_end = (started + GROUP_DRAIN).min(
        deadline
            .checked_sub(KILL_RESERVE)
            .unwrap_or(started)
            .max(started),
    );
    let leader_end = (started + Duration::from_secs(1)).min(drain_end);
    let mut leader_killed = false;
    loop {
        if !group_running(pid)? && port_free(port) {
            return Ok(());
        }
        let now = Instant::now();
        if !leader_killed && now >= leader_end {
            if pinned || cookie.is_some_and(|cookie| matches(pid, cookie)) {
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
            }
            leader_killed = true;
        }
        if now >= drain_end {
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
            let deadline = deadline.max(now + Duration::from_millis(250));
            wait_for_port_until(port, deadline)?;
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
/// Stops a server this process spawned, all within `deadline`.
pub fn stop_child(
    child: &mut std::process::Child,
    port: u16,
    deadline: Instant,
) -> Result<(), String> {
    // An unreaped Child pins its PID/group against reuse throughout escalation.
    stop_group(child.id(), None, true, port, deadline)?;
    loop {
        if child
            .try_wait()
            .map_err(|_| "Server reap failed")?
            .is_some()
        {
            break;
        }
        if Instant::now() >= deadline {
            return Err("Server reap deadline".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    wait_for_port_until(port, deadline)
}
fn read_private(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
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
    Ok(Some(bytes))
}
fn remove(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err("Ownership receipt unavailable".into())
        }
        _ => Ok(()),
    }
}

/// Stops servers a prior run of this install left behind, then removes their
/// records. Nothing is signalled without a live identity re-check.
pub fn cleanup(directory: &Path, server_dir: &Path) -> Result<(), String> {
    let install = std::env::current_exe().map_err(|_| "Install unavailable")?;
    for name in ["launcher-api.json", "launcher-ws.json"] {
        let path = directory.join(name);
        let hold = hold_path(&path);
        if let Some(bytes) = read_private(&path)? {
            let receipt: Receipt =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid ownership receipt")?;
            recover_receipt(&receipt, &install, directory, server_dir, &hold)?;
            fs::remove_file(&path).map_err(|_| "Ownership receipt unavailable")?;
        }
        let pending = pending_path(&path);
        if let Some(bytes) = read_private(&pending)? {
            let record: Pending =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid ownership receipt")?;
            recover_pending(&record, directory, &hold)?;
            fs::remove_file(&pending).map_err(|_| "Ownership receipt unavailable")?;
        }
        remove(&hold)?;
    }
    Ok(())
}

fn recover_receipt(
    receipt: &Receipt,
    install: &Path,
    directory: &Path,
    server_dir: &Path,
    hold: &Path,
) -> Result<(), String> {
    let pid = receipt.pid;
    let current = identity(pid);
    // Identity mismatch, including another user's process that cannot be read,
    // never grants signalling authority. Discard without waiting on its port.
    if !same_directory(&receipt.directory, directory)
        || current.as_deref() != Some(&receipt.identity)
    {
        eprintln!(
            "Ownership receipt for process {pid} discarded: the recorded process is gone or cannot be inspected; nothing was signalled"
        );
        return Ok(());
    }
    let moved = receipt.install != install;
    if moved {
        // The executable path follows a move, so only the inherited hold file proves it.
        let proven = receipt
            .hold
            .as_ref()
            .is_some_and(|record| hold_intact(hold, record) && holds(pid, record));
        if !proven {
            eprintln!(
                "Ownership receipt for process {pid} discarded: it was started from {} and does not hold this profile's ownership file; it was left running",
                receipt.install.display()
            );
            return Ok(());
        }
        eprintln!(
            "Stopping process {pid} started from moved install {}: it holds this profile's ownership file",
            receipt.install.display()
        );
    }
    if !matches(pid, &receipt.identity) {
        return Err("Server process group changed".into());
    }
    if parent(pid) != Some(1) {
        return Err("Prior server still actively parented".into());
    }
    // After a move the old working directory is no longer this install's.
    if !moved && !cwd(pid).is_some_and(|value| same_directory(&value, server_dir)) {
        return Err("Foreign server directory".into());
    }
    stop_group(
        pid,
        Some(&receipt.identity),
        false,
        receipt.port,
        Instant::now() + ORPHAN_BUDGET,
    )?;
    wait_for_port(receipt.port)
}

/// A prior run spawned a server but stopped before recording its identity.
fn recover_pending(record: &Pending, directory: &Path, hold: &Path) -> Result<(), String> {
    if !same_directory(&record.directory, directory) || !hold_intact(hold, &record.hold) {
        eprintln!(
            "Pending server record discarded: its ownership file is missing; nothing was signalled"
        );
        return Ok(());
    }
    let holders: Vec<u32> = group_leaders()
        .into_iter()
        .filter(|pid| holds(*pid, &record.hold))
        .collect();
    if holders.is_empty() {
        eprintln!("Pending server record discarded: no live process holds its ownership file");
        return Ok(());
    }
    for pid in holders {
        // Captured after the hold proof; stop_group re-checks it before each signal.
        let Some(cookie) = identity(pid) else {
            continue;
        };
        if !holds(pid, &record.hold) {
            continue;
        }
        if parent(pid) != Some(1) {
            return Err("Prior server still actively parented".into());
        }
        eprintln!("Stopping process {pid} from a pending server record: it holds this spawn's ownership file");
        stop_group(
            pid,
            Some(&cookie),
            false,
            record.port,
            Instant::now() + ORPHAN_BUDGET,
        )?;
    }
    wait_for_port(record.port)
}
