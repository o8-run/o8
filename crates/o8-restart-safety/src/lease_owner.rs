//! Same boot/start identity wire format as metadata-lock-process-identity.ts.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(test)]
thread_local! {
    pub(crate) static IDENTITY_UNAVAILABLE: std::cell::Cell<bool> = std::cell::Cell::new(false);
    pub(crate) static IDENTITY_PROBE: std::cell::Cell<Option<fn(u32) -> Option<Value>>> = std::cell::Cell::new(None);
}

#[cfg(all(test, windows))]
thread_local! {
    static CIM_TEST_BUDGET: std::cell::Cell<Option<Duration>> = std::cell::Cell::new(None);
}

const UNBOUND_MS: f64 = 30_000.0;
type Observation = (Option<SystemTime>, u64, Instant);
static OBSERVED: OnceLock<Mutex<HashMap<PathBuf, Observation>>> = OnceLock::new();
#[cfg(windows)]
static OWN_IDENTITY: Mutex<Option<Value>> = Mutex::new(None);
pub fn read(path: &Path) -> Value {
    if !fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
    {
        return Value::Null;
    }
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn command(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .args(args)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("TZ", "UTC")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    // Cold Windows PowerShell/CIM startup may exceed two seconds. Keep a bound
    // but do not mistake the query's startup deadline for an absent process.
    let budget = Duration::from_secs(if cfg!(windows) { 10 } else { 2 });
    #[cfg(all(test, windows))]
    let budget = CIM_TEST_BUDGET.with(|test_budget| test_budget.get().unwrap_or(budget));
    let deadline = Instant::now() + budget;
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            let output = child
                .wait_with_output()
                .map_err(|error| error.to_string())?;
            if !status.success() {
                return Err(format!(
                    "exit {status}: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            return Ok(String::from_utf8(output.stdout)
                .map_err(|error| error.to_string())?
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "process query timed out after {} ms",
                budget.as_millis()
            ));
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

pub fn identity(pid: u32) -> Option<Value> {
    #[cfg(test)]
    if IDENTITY_UNAVAILABLE.with(|unavailable| unavailable.get()) {
        return None;
    }
    #[cfg(test)]
    if let Some(probe) = IDENTITY_PROBE.with(|probe| probe.get()) {
        return probe(pid);
    }
    #[cfg(windows)]
    if pid == std::process::id() {
        // Serialize the first CIM query; concurrent callers must not launch a
        // cold PowerShell process each. Cache only a successful immutable cookie.
        let mut own = OWN_IDENTITY.lock().ok()?;
        if own.is_none() {
            *own = probe_identity(pid);
        }
        return own.clone();
    }
    probe_identity(pid)
}

#[cfg(windows)]
fn windows_script(pid: u32) -> String {
    format!("$process = Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\" -ErrorAction Stop; if ($null -eq $process) {{ exit 3 }}; $boot = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().Ticks; $started = $process.CreationDate.ToUniversalTime().Ticks; [Console]::Out.Write(\"$boot $started\")")
}

fn probe_identity(pid: u32) -> Option<Value> {
    #[cfg(target_os = "linux")]
    {
        let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let fields: Vec<_> = stat.rsplit_once(") ")?.1.split_whitespace().collect();
        return Some(
            json!({"version":1,"platform":"linux","bootId":boot.trim(),"startId":fields.get(19)?}),
        );
    }
    #[cfg(target_os = "macos")]
    {
        let boot = command("/usr/sbin/sysctl", &["-n", "kern.bootsessionuuid"]).ok()?;
        let start = command("/bin/ps", &["-o", "lstart=", "-p", &pid.to_string()]).ok()?;
        if boot.is_empty() || start.is_empty() {
            return None;
        }
        let seconds = command(
            "/bin/date",
            &["-j", "-u", "-f", "%a %b %e %T %Y", &start, "+%s"],
        )
        .ok()?;
        if seconds.parse::<u64>().ok()? == 0 {
            return None;
        }
        return Some(
            json!({"version":1,"platform":"darwin","bootId":boot,"startId":format!("epoch:{seconds}")}),
        );
    }
    #[cfg(windows)]
    {
        let script = windows_script(pid);
        let result = command(
            "powershell.exe",
            &["-NoProfile", "-NonInteractive", "-Command", &script],
        )
        .ok()?;
        let (boot, start) = result.split_once(' ')?;
        if boot.parse::<u64>().ok()? == 0 || start.parse::<u64>().ok()? == 0 {
            return None;
        }
        return Some(json!({"version":1,"platform":"win32","bootId":boot,"startId":start}));
    }
    #[allow(unreachable_code)]
    None
}

fn absent(pid: u32) -> bool {
    #[cfg(unix)]
    {
        extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        return pid <= i32::MAX as u32
            && unsafe {
                kill(pid as i32, 0) != 0
                    && std::io::Error::last_os_error().raw_os_error() == Some(3)
            };
    }
    #[cfg(windows)]
    {
        if pid == std::process::id() {
            return false;
        }
        // A successful empty query proves absence; command failures do not.
        return command("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command",
            &format!("$p = Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\" -ErrorAction Stop; if ($null -eq $p) {{ [Console]::Out.Write('absent') }}")]).ok().as_deref() == Some("absent");
    }
    #[allow(unreachable_code)]
    false
}

pub fn stale(value: &Value, path: &Path) -> bool {
    let pid = value["ownerPid"]
        .as_u64()
        .or_else(|| value["pid"].as_u64())
        .filter(|p| *p > 0 && *p <= i32::MAX as u64);
    let owner = &value["ownerIdentity"];
    let identified = owner["version"] == 1
        && owner["bootId"].is_string()
        && owner["startId"].is_string()
        && owner["platform"].is_string();
    if let Some(pid) = pid {
        if absent(pid as u32)
            || (identified
                && identity(pid as u32).is_some_and(|current| {
                    // Local display-time cookies from older versions are not comparable
                    // to epoch cookies. A boot mismatch still proves owner death.
                    let comparable = owner["platform"] != "darwin"
                        || owner["startId"]
                            .as_str()
                            .is_some_and(|s| s.starts_with("epoch:"))
                        || owner["bootId"] != current["bootId"];
                    comparable && &current != owner
                }))
        {
            return true;
        }
    }
    if !value["pid"].is_null() && identified {
        return false;
    }
    if let (Some(created), Some(now)) = (
        value["createdMonotonicMs"].as_f64(),
        crate::monotonic::now_ms(),
    ) {
        if created.is_finite() && created >= 0.0 && created <= now {
            return now - created >= UNBOUND_MS;
        }
    }
    // Legacy/partial records get a local Instant grace window. Modification time
    // distinguishes replacement records; it never determines their age.
    let Ok(metadata) = fs::metadata(path) else {
        return !path.exists();
    };
    let stamp = metadata.modified().ok();
    let size = metadata.len();
    let Ok(mut observed) = OBSERVED.get_or_init(|| Mutex::new(HashMap::new())).lock() else {
        return false;
    };
    let first = observed
        .entry(path.to_path_buf())
        .or_insert_with(|| (stamp, size, Instant::now()));
    if first.0 != stamp || first.1 != size {
        *first = (stamp, size, Instant::now());
    }
    let expired = first.2.elapsed() >= Duration::from_millis(UNBOUND_MS as u64);
    if expired {
        observed.remove(path);
    }
    expired
}

#[cfg(test)]
pub fn expire_observation(path: &Path) {
    if let Some(observed) = OBSERVED.get() {
        for (entry, (_, _, since)) in observed.lock().unwrap().iter_mut() {
            if entry == path {
                *since = Instant::now() - Duration::from_secs(31);
            }
        }
    }
}

#[cfg(windows)]
#[test]
fn windows_cim_probe_reports_live_owner_and_elapsed_time() {
    // A fresh runner can start with a cold WMI service. Only this test gets a
    // longer deadline, including the identity() call below; production keeps 10 s.
    CIM_TEST_BUDGET.with(|budget| budget.set(Some(Duration::from_secs(60))));
    let script = windows_script(std::process::id());
    let _ = command(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-Command", &script],
    );
    let started = Instant::now();
    let result = command(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-Command", &script],
    );
    println!(
        "Windows CIM self probe: elapsedMs={}, outcome={}",
        started.elapsed().as_millis(),
        match &result {
            Ok(_) => "live owner".into(),
            Err(error) => error.clone(),
        }
    );
    let output = result.expect("the running caller must be queryable with its normal permissions");
    let (boot, start) = output.split_once(' ').unwrap();
    assert!(boot.parse::<u64>().unwrap() > 0);
    assert!(start.parse::<u64>().unwrap() > 0);
    let cookie = identity(std::process::id()).unwrap();
    assert_eq!(cookie["bootId"], boot);
    assert_eq!(cookie["startId"], start);
}
