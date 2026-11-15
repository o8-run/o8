//! Starting the speech helper process. On macOS the helper is started with its
//! TCC responsibility disclaimed, as the desktop shell starts it
//! (`src-tauri/src/stt/mod.rs`, `spawn_disclaimed`). The helper then holds its
//! own microphone and speech-recognition permissions, and the system prompt
//! names the helper rather than whatever launched o8 next (a terminal, for
//! one). If that spawn fails, the helper starts as an ordinary child, as the
//! shell falls back to.
use super::helper::Launch;
use std::{
    io::{Read, Write},
    process::{Child, Stdio},
};

/// A started helper: its process, its stdin and its stdout. Its stderr is o8
/// next's own.
pub(super) struct Spawned {
    pub process: Process,
    pub stdin: Box<dyn Write + Send>,
    pub stdout: Box<dyn Read + Send>,
}

pub(super) enum Process {
    Child(Child),
    #[cfg(target_os = "macos")]
    Disclaimed {
        pid: libc::pid_t,
        reaped: bool,
    },
}

impl Process {
    /// The process has exited (and is reaped).
    pub(super) fn exited(&mut self) -> bool {
        match self {
            Self::Child(child) => !matches!(child.try_wait(), Ok(None)),
            #[cfg(target_os = "macos")]
            Self::Disclaimed { pid, reaped } => {
                if !*reaped {
                    let mut status = 0;
                    // A pid of ours that is gone (-1) counts as exited.
                    *reaped = unsafe { libc::waitpid(*pid, &mut status, libc::WNOHANG) } != 0;
                }
                *reaped
            }
        }
    }

    pub(super) fn kill(&mut self) {
        match self {
            Self::Child(child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
            #[cfg(target_os = "macos")]
            Self::Disclaimed { pid, reaped } => {
                if !*reaped {
                    let mut status = 0;
                    unsafe {
                        libc::kill(*pid, libc::SIGKILL);
                        libc::waitpid(*pid, &mut status, 0);
                    }
                    *reaped = true;
                }
            }
        }
    }

    #[cfg(test)]
    pub(super) fn disclaimed(&self) -> bool {
        match self {
            Self::Child(_) => false,
            #[cfg(target_os = "macos")]
            Self::Disclaimed { .. } => true,
        }
    }
}

pub(super) fn spawn(launch: &Launch) -> Result<Spawned, String> {
    #[cfg(target_os = "macos")]
    if let Ok(spawned) = disclaimed(launch) {
        return Ok(spawned);
    }
    let mut child = crate::child_command::command(&launch.program)
        .args(&launch.args)
        .envs(launch.envs.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("The speech helper could not start: {error}."))?;
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("The speech helper could not start.".into());
    };
    Ok(Spawned {
        process: Process::Child(child),
        stdin: Box::new(stdin),
        stdout: Box::new(stdout),
    })
}

/// The environment the helper gets: o8 next's own, without the window's
/// variables that `child_command` also drops, plus the launch's.
#[cfg(target_os = "macos")]
fn environment(launch: &Launch) -> Result<Vec<std::ffi::CString>, String> {
    use std::os::unix::ffi::OsStrExt;
    let mut vars: Vec<(std::ffi::OsString, std::ffi::OsString)> = std::env::vars_os()
        .filter(|(key, _)| key != "O8_NEXT_READY_STDOUT" && key != "O8_APPIMAGE_SOFTWARE_VULKAN")
        .collect();
    for (key, value) in &launch.envs {
        vars.retain(|(existing, _)| existing != key);
        vars.push((key.clone(), value.clone()));
    }
    vars.into_iter()
        .map(|(key, value)| {
            let mut entry = key.as_bytes().to_vec();
            entry.push(b'=');
            entry.extend_from_slice(value.as_bytes());
            std::ffi::CString::new(entry).map_err(|_| "environment contains NUL".to_string())
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn disclaimed(launch: &Launch) -> Result<Spawned, String> {
    use std::ffi::CString;
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;

    unsafe extern "C" {
        // Private but stable libSystem call (multi-process browsers use it for
        // the same purpose): the child becomes its own TCC responsible process.
        fn responsibility_spawnattrs_setdisclaim(
            attr: *mut libc::posix_spawnattr_t,
            disclaim: libc::c_int,
        ) -> libc::c_int;
    }

    let program = CString::new(launch.program.as_os_str().as_bytes())
        .map_err(|_| "helper path contains NUL".to_string())?;
    let args = launch
        .args
        .iter()
        .map(|arg| CString::new(arg.as_bytes()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "helper argument contains NUL".to_string())?;
    let env = environment(launch)?;
    let mut argv: Vec<*mut libc::c_char> = std::iter::once(program.as_ptr() as *mut _)
        .chain(args.iter().map(|arg| arg.as_ptr() as *mut _))
        .chain(std::iter::once(std::ptr::null_mut()))
        .collect();
    let mut envp: Vec<*mut libc::c_char> = env
        .iter()
        .map(|entry| entry.as_ptr() as *mut _)
        .chain(std::iter::once(std::ptr::null_mut()))
        .collect();

    // [read, write] for the child's stdin and stdout.
    let mut input = [0 as libc::c_int; 2];
    let mut output = [0 as libc::c_int; 2];
    unsafe {
        if libc::pipe(input.as_mut_ptr()) != 0 {
            return Err("pipe() failed".into());
        }
        if libc::pipe(output.as_mut_ptr()) != 0 {
            libc::close(input[0]);
            libc::close(input[1]);
            return Err("pipe() failed".into());
        }
        // Keep the parent's ends out of any other process this one starts.
        libc::fcntl(input[1], libc::F_SETFD, libc::FD_CLOEXEC);
        libc::fcntl(output[0], libc::F_SETFD, libc::FD_CLOEXEC);
    }
    let all = [input[0], input[1], output[0], output[1]];
    let close = |fds: &[libc::c_int]| {
        for fd in fds {
            unsafe { libc::close(*fd) };
        }
    };

    let mut pid: libc::pid_t = 0;
    let rc = unsafe {
        let mut attr: libc::posix_spawnattr_t = std::mem::zeroed();
        if libc::posix_spawnattr_init(&mut attr) != 0 {
            close(&all);
            return Err("posix_spawnattr_init failed".into());
        }
        if responsibility_spawnattrs_setdisclaim(&mut attr, 1) != 0 {
            libc::posix_spawnattr_destroy(&mut attr);
            close(&all);
            return Err("responsibility_spawnattrs_setdisclaim failed".into());
        }
        let mut actions: libc::posix_spawn_file_actions_t = std::mem::zeroed();
        if libc::posix_spawn_file_actions_init(&mut actions) != 0 {
            libc::posix_spawnattr_destroy(&mut attr);
            close(&all);
            return Err("posix_spawn_file_actions_init failed".into());
        }
        libc::posix_spawn_file_actions_adddup2(&mut actions, input[0], 0);
        libc::posix_spawn_file_actions_adddup2(&mut actions, output[1], 1);
        for fd in all {
            libc::posix_spawn_file_actions_addclose(&mut actions, fd);
        }
        // posix_spawnp: a bare program name is looked up on PATH.
        let rc = libc::posix_spawnp(
            &mut pid,
            program.as_ptr(),
            &actions,
            &attr,
            argv.as_mut_ptr(),
            envp.as_mut_ptr(),
        );
        libc::posix_spawn_file_actions_destroy(&mut actions);
        libc::posix_spawnattr_destroy(&mut attr);
        rc
    };
    // The child's ends belong to the child now, whatever happened.
    close(&[input[0], output[1]]);
    if rc != 0 {
        close(&[input[1], output[0]]);
        return Err(format!("posix_spawn failed (errno {rc})"));
    }
    Ok(Spawned {
        process: Process::Disclaimed { pid, reaped: false },
        stdin: Box::new(unsafe { std::fs::File::from_raw_fd(input[1]) }),
        stdout: Box::new(unsafe { std::fs::File::from_raw_fd(output[0]) }),
    })
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    #[test]
    fn speech_helper_starts_disclaimed_with_its_stdio_and_environment() {
        let launch = Launch {
            program: "sh".into(),
            args: vec![
                "-c".into(),
                r#"IFS= read -r line; printf '%s %s\n' "$line" "$SPEECH_SPAWN_PROBE""#.into(),
            ],
            envs: vec![("SPEECH_SPAWN_PROBE".into(), "env-ok".into())],
            data: None,
        };
        let Spawned {
            mut process,
            mut stdin,
            stdout,
        } = spawn(&launch).unwrap();
        assert!(process.disclaimed(), "macOS starts the helper disclaimed");
        writeln!(stdin, "hello").unwrap();
        let mut line = String::new();
        BufReader::new(stdout).read_line(&mut line).unwrap();
        assert_eq!(line, "hello env-ok\n");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !process.exited() {
            assert!(
                std::time::Instant::now() < deadline,
                "the helper was not reaped"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[test]
    fn speech_helper_that_cannot_start_reports_it() {
        let launch = Launch {
            program: "/nonexistent/o8-speech-helper".into(),
            args: Vec::new(),
            envs: Vec::new(),
            data: None,
        };
        let error = spawn(&launch).err().expect("no such helper");
        assert!(
            error.starts_with("The speech helper could not start"),
            "{error}"
        );
    }
}
