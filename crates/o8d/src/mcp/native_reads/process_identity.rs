use super::*;

/// Match the app's metadata-lock identity contract. An uncertain probe always
/// returns the read to TypeScript; PID existence alone is never authority.
pub(super) fn matches(pid: u64, expected: &Value) -> ReadResult<()> {
    if pid == 0 || pid > i32::MAX as u64 || expected["version"] != 1 {
        return Err(());
    }
    if identity(pid)? != *expected {
        return Err(());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn identity(pid: u64) -> ReadResult<Value> {
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").map_err(|_| ())?;
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).map_err(|_| ())?;
    let start = stat
        .rsplit_once(") ")
        .ok_or(())?
        .1
        .split_whitespace()
        .nth(19)
        .ok_or(())?;
    Ok(json!({"version":1,"platform":"linux","bootId":boot.trim(),"startId":start}))
}

#[cfg(target_os = "macos")]
fn identity(pid: u64) -> ReadResult<Value> {
    fn command(program: &str, args: &[&str]) -> ReadResult<String> {
        use std::io::Read;
        let mut child = std::process::Command::new(program)
            .args(args)
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|_| ())?;
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => break,
                Ok(Some(_)) => return Err(()),
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(2));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(());
                }
            }
        }
        let mut text = String::new();
        child
            .stdout
            .take()
            .ok_or(())?
            .take(1024)
            .read_to_string(&mut text)
            .map_err(|_| ())?;
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() || text.len() > 160 || !text.is_ascii() {
            return Err(());
        }
        Ok(text)
    }
    let boot = command("/usr/sbin/sysctl", &["-n", "kern.bootsessionuuid"])?;
    let start = command("/bin/ps", &["-o", "lstart=", "-p", &pid.to_string()])?;
    Ok(json!({"version":1,"platform":"darwin","bootId":boot,"startId":start}))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn identity(_pid: u64) -> ReadResult<Value> {
    Err(())
}
