use super::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Identity {
    pub(super) pid: u64,
    pub(super) legacy: Value,
    // Keep kernel precision even though the legacy Darwin format has seconds.
    pub(super) start: (u64, u64),
}

pub(super) fn observe(pid: u64, expected: &Value) -> ReadResult<Identity> {
    if pid == 0 || pid > i32::MAX as u64 || expected["version"] != 1 {
        return Err(());
    }
    let current = identity(pid)?;
    if current.legacy != *expected {
        return Err(());
    }
    Ok(current)
}

// Lease participants retain the existing metadata-lock identity contract.
// Publisher authority additionally pins and rechecks the full kernel witness.
pub(super) fn matches(pid: u64, expected: &Value) -> ReadResult<()> {
    observe(pid, expected).map(|_| ())
}

impl Identity {
    pub(super) fn recheck(&self) -> ReadResult<()> {
        if observe(self.pid, &self.legacy)? != *self {
            return Err(());
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
pub(super) fn identity(pid: u64) -> ReadResult<Identity> {
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").map_err(|_| ())?;
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).map_err(|_| ())?;
    let start = stat
        .rsplit_once(") ")
        .ok_or(())?
        .1
        .split_whitespace()
        .nth(19)
        .ok_or(())?;
    Ok(Identity {
        pid,
        start: (start.parse().map_err(|_| ())?, 0),
        legacy: json!({"version":1,"platform":"linux","bootId":boot.trim(),"startId":start}),
    })
}

#[cfg(target_os = "macos")]
pub(super) fn identity(pid: u64) -> ReadResult<Identity> {
    use std::{
        ffi::CStr,
        mem::{size_of, zeroed},
        ptr,
    };
    // proc_bsdinfo is a plain C output structure. Check the returned byte count,
    // PID and full timeval before using it; failures always retain TS ownership.
    let mut info: libc::proc_bsdinfo = unsafe { zeroed() };
    let size = size_of::<libc::proc_bsdinfo>();
    let count = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size as i32,
        )
    };
    validate_process_info(pid, count, &info)?;
    let mut boot = [0u8; 128];
    let mut length = boot.len();
    let result = unsafe {
        libc::sysctlbyname(
            c"kern.bootsessionuuid".as_ptr(),
            boot.as_mut_ptr().cast(),
            &mut length,
            ptr::null_mut(),
            0,
        )
    };
    if result != 0 || length == 0 || length > boot.len() {
        return Err(());
    }
    let boot = CStr::from_bytes_with_nul(&boot[..length])
        .map_err(|_| ())?
        .to_str()
        .map_err(|_| ())?;
    if boot.is_empty() || !boot.is_ascii() {
        return Err(());
    }
    let seconds: libc::time_t = info.pbi_start_tvsec.try_into().map_err(|_| ())?;
    let mut local: libc::tm = unsafe { zeroed() };
    if unsafe { libc::localtime_r(&seconds, &mut local) }.is_null() {
        return Err(());
    }
    let weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        .get(usize::try_from(local.tm_wday).map_err(|_| ())?)
        .ok_or(())?;
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .get(usize::try_from(local.tm_mon).map_err(|_| ())?)
    .ok_or(())?;
    // ps lstart uses local time and C-locale names; normalize its day padding.
    let start = format!(
        "{weekday} {month} {} {:02}:{:02}:{:02} {}",
        local.tm_mday,
        local.tm_hour,
        local.tm_min,
        local.tm_sec,
        local.tm_year + 1900
    );
    Ok(Identity {
        pid,
        start: (info.pbi_start_tvsec, info.pbi_start_tvusec),
        legacy: json!({"version":1,"platform":"darwin","bootId":boot,"startId":start}),
    })
}

#[cfg(target_os = "macos")]
fn validate_process_info(pid: u64, count: i32, info: &libc::proc_bsdinfo) -> ReadResult<()> {
    if count != std::mem::size_of::<libc::proc_bsdinfo>() as i32
        || info.pbi_pid as u64 != pid
        || info.pbi_start_tvsec == 0
        || info.pbi_start_tvusec >= 1_000_000
    {
        return Err(());
    }
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(super) fn identity(_pid: u64) -> ReadResult<Identity> {
    Err(())
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests {
    use super::*;

    #[test]
    fn direct_probe_matches_legacy_identity_and_refuses_dead_or_changed_process() {
        let pid = std::process::id() as u64;
        let own = identity(pid).unwrap();
        assert_eq!(observe(pid, &own.legacy).unwrap(), own);
        let mut changed = own.legacy.clone();
        changed["startId"] = json!("different-start");
        assert!(observe(pid, &changed).is_err());
        assert!(observe(0, &own.legacy).is_err());
        assert!(observe(i32::MAX as u64 + 1, &own.legacy).is_err());
        let mut child = std::process::Command::new("/usr/bin/true")
            .env_clear()
            .spawn()
            .unwrap();
        let dead = child.id() as u64;
        child.wait().unwrap();
        assert!(identity(dead).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn full_start_witness_is_rechecked_even_with_the_same_legacy_second() {
        let own = identity(std::process::id() as u64).unwrap();
        assert!(own.recheck().is_ok());
        let mut reused = own.clone();
        reused.start.1 = (reused.start.1 + 1) % 1_000_000;
        assert_eq!(reused.legacy, own.legacy);
        assert!(reused.recheck().is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn syscall_errors_short_reads_wrong_pid_and_invalid_time_fail_closed() {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        info.pbi_pid = 123;
        info.pbi_start_tvsec = 1;
        let size = std::mem::size_of_val(&info) as i32;
        assert!(validate_process_info(123, size, &info).is_ok());
        for count in [-1, 0, size - 1] {
            assert!(validate_process_info(123, count, &info).is_err());
        }
        assert!(validate_process_info(124, size, &info).is_err());
        info.pbi_start_tvusec = 1_000_000;
        assert!(validate_process_info(123, size, &info).is_err());
        info.pbi_start_tvusec = 0;
        info.pbi_start_tvsec = 0;
        assert!(validate_process_info(123, size, &info).is_err());
    }
}
