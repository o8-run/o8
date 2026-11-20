//! Private CLI descendants, including tool sessions that create new groups.
//! Keep start identities so teardown never signals a recycled PID.
use std::{collections::HashMap, io, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;

async fn snapshot() -> io::Result<HashMap<i32, (i32, String)>> {
    let mut command = tokio::process::Command::new("/bin/ps");
    command
        .args(["-axo", "pid=,ppid=,lstart="])
        .env_clear()
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    tokio::time::timeout(Duration::from_secs(2), async {
        let mut child = command.spawn()?;
        let mut bytes = Vec::new();
        child
            .stdout
            .take()
            .unwrap()
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > 4 * 1024 * 1024 {
            child.kill().await?;
            return Err(io::Error::other("Process snapshot exceeds limit"));
        }
        if !child.wait().await?.success() {
            return Err(io::Error::other("Process snapshot failed"));
        }
        let text = String::from_utf8(bytes).map_err(io::Error::other)?;
        let mut result = HashMap::new();
        for line in text.lines() {
            let mut fields = line.split_whitespace();
            if let (Some(pid), Some(parent)) = (fields.next(), fields.next()) {
                if let (Ok(pid), Ok(parent)) = (pid.parse(), parent.parse()) {
                    result.insert(pid, (parent, fields.collect::<Vec<_>>().join(" ")));
                }
            }
        }
        Ok(result)
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Process snapshot timed out"))?
}
pub(super) struct Tree(Vec<(i32, String)>);
impl Tree {
    pub(super) async fn capture(root: i32) -> io::Result<Self> {
        let all = snapshot().await?;
        let mut found = vec![root];
        let mut records = Vec::new();
        let mut index = 0;
        while index < found.len() {
            let parent = found[index];
            index += 1;
            for (&pid, (ppid, start)) in &all {
                if *ppid == parent && pid > 1 && !found.contains(&pid) {
                    if found.len() >= 4096 {
                        return Err(io::Error::other("Codex process tree exceeds limit"));
                    }
                    found.push(pid);
                    records.push((pid, start.clone()));
                }
            }
        }
        Ok(Self(records))
    }
    pub(super) async fn kill(self) -> io::Result<()> {
        let current = snapshot().await?;
        for (pid, start) in self.0.into_iter().rev() {
            if current
                .get(&pid)
                .is_some_and(|(_, identity)| *identity == start)
            {
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
        Ok(())
    }
}
