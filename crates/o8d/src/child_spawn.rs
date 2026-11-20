//! Unix provider spawn boundary. Every future Rust provider must construct its
//! command here (Tokio callers can convert it with `Command::from`). The
//! supervisor shares the reset but retains its stronger new-session boundary.
use std::{ffi::OsStr, io, os::unix::process::CommandExt, process::Command};

/// Only async-signal-safe operations: usable between fork and exec, without
/// touching allocator state, locks, environment, or the parent's signal mask.
pub(crate) fn reset_signal_mask() -> io::Result<()> {
    unsafe {
        let mut empty = std::mem::zeroed();
        if libc::sigemptyset(&mut empty) == -1 {
            return Err(io::Error::last_os_error());
        }
        // pthread_sigmask returns its error number directly, not through errno.
        let error = libc::pthread_sigmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut());
        if error != 0 {
            return Err(io::Error::from_raw_os_error(error));
        }
    }
    Ok(())
}

/// A provider owns a separate process group and starts with all signals
/// unblocked, even when spawned from an executor thread with a blocked mask.
pub fn provider_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    command.process_group(0);
    unsafe {
        command.pre_exec(reset_signal_mask);
    }
    command
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    #[test]
    fn provider_signal_mask_is_empty_and_process_group_is_private() {
        std::thread::spawn(|| {
            unsafe {
                let mut blocked = std::mem::zeroed();
                assert_eq!(libc::sigemptyset(&mut blocked), 0);
                assert_eq!(libc::sigaddset(&mut blocked, libc::SIGCHLD), 0);
                assert_eq!(libc::sigaddset(&mut blocked, libc::SIGTERM), 0);
                assert_eq!(
                    libc::pthread_sigmask(libc::SIG_BLOCK, &blocked, std::ptr::null_mut()),
                    0
                );
            }
            let output = provider_command("/bin/cat")
                .arg("/proc/self/status")
                .output()
                .unwrap();
            assert!(output.status.success());
            let status = String::from_utf8(output.stdout).unwrap();
            let field = |name: &str| {
                status
                    .lines()
                    .find_map(|l| l.strip_prefix(name))
                    .unwrap()
                    .trim()
            };
            assert_eq!(u64::from_str_radix(field("SigBlk:"), 16).unwrap(), 0);
            assert_eq!(field("NSpgid:"), field("Pid:"));
            assert_ne!(field("NSpgid:").parse::<i32>().unwrap(), unsafe {
                libc::getpgrp()
            });
            unsafe {
                let mut parent = std::mem::zeroed();
                assert_eq!(
                    libc::pthread_sigmask(libc::SIG_SETMASK, std::ptr::null(), &mut parent),
                    0
                );
                assert_eq!(libc::sigismember(&parent, libc::SIGCHLD), 1);
                assert_eq!(libc::sigismember(&parent, libc::SIGTERM), 1);
            }
        })
        .join()
        .unwrap();
    }
}
