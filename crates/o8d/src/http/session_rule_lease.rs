//! Exact v39 lifecycle reservation protocol, shared with Node merge publication.
use super::*;
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
const BUSY: &str = "A merge publication or session-rule edit is already in progress. The requested operation was not admitted; inspect the result before retrying.";
fn identity(pid: u32) -> Result<Option<Value>, ()> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(());
    }
    #[cfg(unix)]
    if unsafe { libc::kill(pid as i32, 0) } != 0 {
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ESRCH) => return Ok(None),
            Some(libc::EPERM) => (),
            _ => return Err(()),
        }
    }
    #[cfg(target_os = "linux")]
    {
        let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let absent = unsafe { libc::kill(pid as i32, 0) } != 0
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
                return if absent { Ok(None) } else { Err(()) };
            }
            Err(_) => return Err(()),
        };
        let fields = stat
            .rsplit_once(") ")
            .ok_or(())?
            .1
            .split_whitespace()
            .collect::<Vec<_>>();
        let start = fields.get(19).ok_or(())?;
        let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").map_err(|_| ())?;
        if !start.bytes().all(|b| b.is_ascii_digit()) || boot.trim().is_empty() {
            return Err(());
        }
        Ok(Some(
            json!({"version":1,"platform":"linux","bootId":boot.trim(),"startId":start}),
        ))
    }
    #[cfg(target_os = "macos")]
    {
        let boot = command("/usr/sbin/sysctl", &["-n", "kern.bootsessionuuid"])?;
        let started = command("/bin/ps", &["-o", "lstart=", "-p", &pid.to_string()]);
        match started {
            Ok(started) => Ok(Some(darwin_form(&boot, &started)?)),
            Err(())
                if unsafe { libc::kill(pid as i32, 0) } != 0
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) =>
            {
                Ok(None)
            }
            Err(()) => Err(()),
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        Err(())
    }
}
fn clean_part(s: &str) -> Result<String, ()> {
    let s = s
        .split(super::prompt_library::whitespace)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if s.is_empty() || s.len() > 160 || !s.bytes().all(|b| (32..=126).contains(&b)) {
        return Err(());
    }
    Ok(s)
}
#[cfg(any(target_os = "macos", test))]
fn darwin_form(boot: &str, started: &str) -> Result<Value, ()> {
    Ok(
        json!({"version":1,"platform":"darwin","bootId":clean_part(boot)?,"startId":clean_part(started)?}),
    )
}
#[cfg(target_os = "macos")]
fn command(exe: &str, args: &[&str]) -> Result<String, ()> {
    use std::process::{Command, Stdio};
    let mut command = Command::new(exe);
    command
        .args(args)
        .env_clear()
        .env("LANG", "C")
        .env("LC_ALL", "C");
    if let Some(tz) = std::env::var_os("TZ") {
        command.env("TZ", tz);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ())?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child.wait_with_output().map_err(|_| ())?;
                if !status.success() || output.stdout.len() > 65536 {
                    return Err(());
                }
                return String::from_utf8(output.stdout).map_err(|_| ());
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(());
            }
        }
    }
}
fn same_identity(a: &Value, b: &Value) -> bool {
    ["platform", "bootId", "startId"]
        .iter()
        .all(|k| a[k] == b[k])
}
fn valid(value: &Value) -> bool {
    value.as_object().is_some_and(|o| o.len() == 4)
        && value["version"].as_f64() == Some(1.0)
        && matches!(
            value["platform"].as_str(),
            Some("linux" | "darwin" | "win32")
        )
        && ["bootId", "startId"].iter().all(|k| {
            value[k]
                .as_str()
                .is_some_and(|s| clean_part(s).is_ok_and(|clean| clean == s))
        })
}
pub(super) fn open(directory: &Path, path: &Path) -> Result<Connection, ()> {
    let real = path.canonicalize().map_err(|_| ())?;
    if !real.starts_with(directory)
        || !real.is_file()
        || std::fs::symlink_metadata(path)
            .map_err(|_| ())?
            .file_type()
            .is_symlink()
    {
        return Err(());
    }
    let db = Connection::open_with_flags(
        real,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| ())?;
    db.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|_| ())?;
    // Never bootstrap or migrate a missing v39 table in Rust.
    db.prepare("SELECT packet_id,reservation_id,owner_pid,owner_identity_json,acquired_at FROM workspace_lifecycle_leases LIMIT 0").map_err(|_|())?;
    Ok(db)
}
pub(super) struct Lease {
    db: Connection,
    key: String,
    reservation: String,
}
impl Lease {
    pub(super) fn acquire(
        directory: &Path,
        path: &Path,
        thread: &str,
    ) -> Result<Self, &'static str> {
        let mut db = open(directory, path).map_err(|_| BUSY)?;
        super::session_rules::restrict(&mut db, true).map_err(|_| BUSY)?;
        let own = identity(std::process::id())
            .map_err(|_| BUSY)?
            .ok_or(BUSY)?;
        let key = format!("session-rules-{:x}", Sha256::digest(thread.as_bytes()));
        let reservation = uuid::Uuid::new_v4().to_string();
        loop {
            db.execute_batch("BEGIN IMMEDIATE").map_err(|_| BUSY)?;
            let now = chrono::Utc::now().timestamp_millis();
            let inserted=db.execute("INSERT OR IGNORE INTO workspace_lifecycle_leases (packet_id,reservation_id,owner_pid,owner_identity_json,acquired_at) VALUES (?,?,?,?,?)",params![key,reservation,std::process::id(),own.to_string(),now]).map_err(|_|BUSY)?;
            let owner = if inserted == 0 {
                db.query_row("SELECT reservation_id,owner_pid,owner_identity_json FROM workspace_lifecycle_leases WHERE packet_id=?",[&key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,u32>(1)?,r.get::<_,String>(2)?))).optional().map_err(|_|BUSY)?
            } else {
                None
            };
            db.execute_batch("COMMIT").map_err(|_| BUSY)?;
            if inserted == 1 {
                return Ok(Self {
                    db,
                    key,
                    reservation,
                });
            }
            let Some((owner_id, pid, raw)) = owner else {
                return Err(BUSY);
            };
            let stored: Value = serde_json::from_str(&raw).map_err(|_| BUSY)?;
            if pid == 0 || !valid(&stored) {
                return Err(BUSY);
            }
            match identity(pid).map_err(|_| BUSY)? {
                None => (),
                Some(live) if !same_identity(&live, &stored) => (),
                _ => return Err(BUSY),
            }
            db.execute(
                "DELETE FROM workspace_lifecycle_leases WHERE packet_id=? AND reservation_id=?",
                params![key, owner_id],
            )
            .map_err(|_| BUSY)?;
        }
    }
    pub(super) fn release(&self) -> Result<(), ()> {
        if self
            .db
            .execute(
                "DELETE FROM workspace_lifecycle_leases WHERE packet_id=? AND reservation_id=?",
                params![self.key, self.reservation],
            )
            .map_err(|_| ())?
            != 1
        {
            return Err(());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn darwin_ps_lstart_and_boot_uuid_match_node_v39_form() {
        let parsed = darwin_form(" BOOT-UUID\n", "Mon Nov  9 08:01:02 2026\n").unwrap();
        assert_eq!(
            parsed,
            json!({"version":1,"platform":"darwin","bootId":"BOOT-UUID","startId":"Mon Nov 9 08:01:02 2026"})
        );
        assert!(valid(&parsed));
        assert!(darwin_form("", "Mon Nov 9 08:01:02 2026").is_err());
        assert!(darwin_form("boot", "雪").is_err());
        let mut bad = parsed.clone();
        bad["startId"] = json!("Mon Nov  9 08:01:02 2026");
        assert!(!valid(&bad));
        let mut extra = parsed.clone();
        extra["unused"] = json!(true);
        assert!(!valid(&extra));
        assert!(same_identity(&parsed, &extra));
    }
}
