//! Current-process counters only: no process enumeration or helper executable.
pub(super) struct Usage {
    pub memory_mib: f64,
    pub cpu_seconds: f64,
}
#[cfg(target_os = "linux")]
pub(super) fn usage() -> Option<Usage> {
    let stat = std::fs::read_to_string("/proc/self/statm").ok()?;
    let resident = stat.split_whitespace().nth(1)?.parse::<u64>().ok()?;
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    let mut clock = std::mem::MaybeUninit::<libc::timespec>::zeroed();
    if page_size <= 0
        || unsafe { libc::clock_gettime(libc::CLOCK_PROCESS_CPUTIME_ID, clock.as_mut_ptr()) } != 0
    {
        return None;
    }
    let clock = unsafe { clock.assume_init() };
    Some(Usage {
        memory_mib: resident as f64 * page_size as f64 / 1048576.,
        cpu_seconds: clock.tv_sec as f64 + clock.tv_nsec as f64 / 1e9,
    })
}
#[cfg(target_os = "macos")]
pub(super) fn usage() -> Option<Usage> {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
    // The API takes the address of caller-owned storage, typed as rusage_info_t*.
    if unsafe {
        libc::proc_pid_rusage(
            std::process::id() as libc::pid_t,
            libc::RUSAGE_INFO_V2,
            info.as_mut_ptr().cast(),
        )
    } != 0
    {
        return None;
    }
    let info = unsafe { info.assume_init() };
    Some(Usage {
        memory_mib: info.ri_resident_size as f64 / 1048576.,
        cpu_seconds: (info.ri_user_time as f64 + info.ri_system_time as f64) / 1e9,
    })
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(super) fn usage() -> Option<Usage> {
    None
}
