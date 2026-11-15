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
    /// Birth clock reading taken just before spawn (see [`birth_clock`]).
    #[serde(default)]
    pub spawned: u64,
    /// The runtime executable the server was started from.
    #[serde(default)]
    pub runtime: Option<FileId>,
}
/// Device and inode. Unlike a path, this survives a move within one volume.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileId {
    pub dev: u64,
    pub ino: u64,
}
pub fn file_id(path: &Path) -> Option<FileId> {
    let metadata = fs::metadata(path).ok()?;
    Some(FileId {
        dev: metadata.dev(),
        ino: metadata.ino(),
    })
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
    pub spawned: u64,
    pub runtime: FileId,
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
/// Replaces a private record atomically: a crash leaves either the old record
/// or the new one, never a truncated file. An existing name that is a link, a
/// hard-linked or foreign file is refused rather than replaced.
pub fn private_write(path: &Path, data: &[u8]) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.nlink() != 1
                || metadata.uid() != unsafe { libc::getuid() } =>
        {
            return Err(std::io::Error::other("Foreign ownership file"));
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("Ownership file needs a name"))?;
    let temporary = path.with_file_name(format!(
        ".{}.{}.tmp",
        name.to_string_lossy(),
        uuid::Uuid::new_v4().simple()
    ));
    let written = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temporary)?;
        if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        file.write_all(data)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written?;
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
/// A clock in the same units and epoch as [`birth`]: microseconds since the
/// Unix epoch on macOS, clock ticks since boot on Linux.
#[cfg(target_os = "macos")]
pub fn birth_clock() -> u64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    now.as_micros() as u64
}
#[cfg(target_os = "linux")]
pub fn birth_clock() -> u64 {
    let mut now: libc::timespec = unsafe { std::mem::zeroed() };
    unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut now) };
    let ticks = ticks_per_second();
    // Floor like the kernel's start time, so a later fork never reads earlier.
    now.tv_sec as u64 * ticks + now.tv_nsec as u64 * ticks / 1_000_000_000
}
#[cfg(target_os = "linux")]
fn ticks_per_second() -> u64 {
    (unsafe { libc::sysconf(libc::_SC_CLK_TCK) }).max(1) as u64
}
/// Largest gap allowed between the recorded spawn time and the fork, so the
/// server is born well inside the window.
pub fn spawn_slack() -> u64 {
    spawn_window() / 4
}
/// Birth-clock units in two seconds.
fn spawn_window() -> u64 {
    #[cfg(target_os = "macos")]
    return 2_000_000;
    #[cfg(target_os = "linux")]
    return 2 * ticks_per_second();
}
#[cfg(target_os = "macos")]
fn birth(pid: u32) -> Option<u64> {
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
    (read == length as i32 && info.pbi_uid == unsafe { libc::getuid() })
        .then(|| info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
}
#[cfg(target_os = "linux")]
fn birth(pid: u32) -> Option<u64> {
    if fs::metadata(format!("/proc/{pid}")).ok()?.uid() != unsafe { libc::getuid() } {
        return None;
    }
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat.rsplit_once(") ")?
        .1
        .split_whitespace()
        .nth(19)?
        .parse()
        .ok()
}
/// Device and inode of the running executable, which follow the file across a move.
#[cfg(target_os = "linux")]
fn executable_id(pid: u32) -> Option<FileId> {
    file_id(Path::new(&format!("/proc/{pid}/exe")))
}
#[cfg(target_os = "macos")]
fn executable_id(pid: u32) -> Option<FileId> {
    use std::os::unix::ffi::OsStrExt;
    let mut bytes = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let count =
        unsafe { libc::proc_pidpath(pid as i32, bytes.as_mut_ptr().cast(), bytes.len() as u32) };
    if count <= 0 {
        return None;
    }
    // The kernel reports the current name of the text vnode; a file replaced at
    // that name since then has another inode and simply fails the comparison.
    file_id(Path::new(std::ffi::OsStr::from_bytes(
        &bytes[..count as usize],
    )))
}
/// Same-user processes other than this one.
fn same_user_processes() -> Vec<u32> {
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
        .filter(|pid| *pid != std::process::id() && identity(*pid).is_some())
        .collect()
}
/// The single process proven to be the server started with `hold`.
///
/// Any descendant of the server may have inherited the hold descriptor, so
/// holding it only makes a process a candidate. The proven server is the
/// earliest-born same-user holder that was born at or after the spawn (within
/// `window`, when given) and runs the recorded runtime executable. Every other
/// holder is logged and never signalled.
/// The proven server and the identity it had while every check passed. The
/// identity includes the kernel birth time, so a PID reused after the proof no
/// longer matches it.
struct Proven {
    pid: u32,
    cookie: String,
}
fn proven_holder(
    hold: &Hold,
    runtime: FileId,
    spawned: u64,
    window: Option<u64>,
) -> Option<Proven> {
    let holders: Vec<u32> = same_user_processes()
        .into_iter()
        .filter(|pid| holds(*pid, hold))
        .collect();
    let proven = holders
        .iter()
        .filter_map(|pid| {
            // Taken before the checks and required unchanged after them, so every
            // check describes the process this identity names.
            let cookie = observed(*pid)?;
            let born = birth(*pid)?;
            let qualifies = born >= spawned
                && window.is_none_or(|window| born <= spawned.saturating_add(window))
                && executable_id(*pid) == Some(runtime)
                && holds(*pid, hold);
            (qualifies && observed(*pid).as_deref() == Some(&cookie))
                .then_some((born, Proven { pid: *pid, cookie }))
        })
        .min_by_key(|(born, proven)| (*born, proven.pid))
        .map(|(_, proven)| proven);
    for pid in holders
        .iter()
        .filter(|pid| Some(**pid) != proven.as_ref().map(|proven| proven.pid))
    {
        crate::note!(
            "Process {pid} holds a server ownership file but is not the proven server; it was left running"
        );
    }
    proven
}
/// The identity used for every signalling decision. Debug builds can simulate
/// a PID reused after the proof (see `fault_after_proof`).
fn observed(pid: u32) -> Option<String> {
    let id = identity(pid)?;
    if cfg!(debug_assertions) && REUSED.load(std::sync::atomic::Ordering::SeqCst) {
        return Some(format!("{id}:reused"));
    }
    Some(id)
}
static REUSED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Debug-build seam for the real-entry test: from here on every PID reads as
/// another process born at another time.
fn fault_after_proof() {
    if cfg!(debug_assertions)
        && std::env::var("O8_LAUNCHER_FAULT").ok().as_deref() == Some("reuse-after-proof")
    {
        REUSED.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}
fn same_directory(a: &Path, b: &Path) -> bool {
    fs::canonicalize(a)
        .ok()
        .zip(fs::canonicalize(b).ok())
        .is_some_and(|(a, b)| a == b)
}
fn matches(pid: u32, cookie: &str) -> bool {
    observed(pid).as_deref() == Some(cookie) && unsafe { libc::getpgid(pid as i32) } == pid as i32
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
            // An unreadable record proves nothing: discard it, signal nothing.
            match serde_json::from_slice::<Receipt>(&bytes) {
                Ok(receipt) => recover_receipt(&receipt, &install, directory, server_dir, &hold)?,
                Err(_) => crate::note!(
                    "Ownership receipt {name} discarded: it is empty or damaged; nothing was signalled"
                ),
            }
            fs::remove_file(&path).map_err(|_| "Ownership receipt unavailable")?;
        }
        let pending = pending_path(&path);
        if let Some(bytes) = read_private(&pending)? {
            match serde_json::from_slice::<Pending>(&bytes) {
                Ok(record) => recover_pending(&record, directory, &hold)?,
                Err(_) => crate::note!(
                    "Pending server record for {name} discarded: it is empty or damaged; nothing was signalled"
                ),
            }
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
        crate::note!(
            "Ownership receipt for process {pid} discarded: the recorded process is gone or cannot be inspected; nothing was signalled"
        );
        return Ok(());
    }
    let moved = receipt.install != install;
    if moved {
        // The executable path follows a move, so only the inherited hold file proves it.
        let proven = match (&receipt.hold, receipt.runtime) {
            (Some(record), Some(runtime)) => {
                hold_intact(hold, record)
                    && proven_holder(record, runtime, receipt.spawned, None).is_some_and(|proven| {
                        proven.pid == pid && proven.cookie == receipt.identity
                    })
            }
            _ => false,
        };
        if !proven {
            crate::note!(
                "Ownership receipt for process {pid} discarded: it was started from {} and does not hold this profile's ownership file; it was left running",
                receipt.install.display()
            );
            return Ok(());
        }
        crate::note!(
            "Stopping process {pid} started from moved install {}: it is the proven holder of this profile's ownership file",
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
        crate::note!(
            "Pending server record discarded: its ownership file is missing; nothing was signalled"
        );
        return Ok(());
    }
    let Some(Proven { pid, cookie }) = proven_holder(
        &record.hold,
        record.runtime,
        record.spawned,
        Some(spawn_window()),
    ) else {
        crate::note!("Pending server record discarded: no live process is proven to be its server");
        return Ok(());
    };
    fault_after_proof();
    if unsafe { libc::getpgid(pid as i32) } != pid as i32 {
        crate::note!("Process {pid} matches a pending server record but leads no process group; it was left running");
        return Ok(());
    }
    if parent(pid) != Some(1) {
        return Err("Prior server still actively parented".into());
    }
    // Only the identity proven above authorizes a signal; stop_group re-checks
    // it before each one. A PID reused since the proof reads differently.
    if observed(pid).as_deref() != Some(&cookie) {
        crate::note!(
            "Pending server record discarded: process {pid} changed identity after its proof; nothing was signalled"
        );
        return Ok(());
    }
    crate::note!(
        "Stopping process {pid} from a pending server record: it is the proven holder of this spawn's ownership file"
    );
    stop_group(
        pid,
        Some(&cookie),
        false,
        record.port,
        Instant::now() + ORPHAN_BUDGET,
    )?;
    wait_for_port(record.port)
}
