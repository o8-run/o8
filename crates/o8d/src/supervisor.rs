//! Linux finite-input worker ownership. See SUPERVISOR.md for the wire contract.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File, OpenOptions},
    io,
    os::{
        fd::AsRawFd,
        unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    process::{Child, Command},
    sync::{mpsc, oneshot, Semaphore},
};
use uuid::Uuid;

mod ownership;
use ownership::{
    descendants_drained, group_empty, identity, persist, private_directory, read_record, regular,
    take_admission, verified,
};

const RING_BYTES: usize = 1024 * 1024;
const MAX_FRAME: usize = 2 * 1024 * 1024;
const MAX_PROCESSES: usize = 128;
type Reply = Result<Value, &'static str>;
type Signal = (i32, oneshot::Sender<Reply>);

struct Process {
    record: Value,
    phase: String,
    ring: VecDeque<(Value, usize)>,
    bytes: usize,
    seq: u64,
    evicted: u64,
    signals: mpsc::Sender<Signal>,
}
type SharedProcess = Arc<Mutex<Process>>;
struct Supervisor {
    token: String,
    epoch: String,
    directory: PathBuf,
    processes: tokio::sync::Mutex<HashMap<String, SharedProcess>>,
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    value[key]
        .as_str()
        .filter(|value| !value.is_empty() && !value.contains('\0'))
        .ok_or("invalid-request")
}
fn id(value: &Value) -> Result<&str, &'static str> {
    let id = text(value, "id")?;
    if id.len() > 160
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("invalid-request");
    }
    Ok(id)
}
fn absolute(value: &Value, key: &str) -> Result<PathBuf, &'static str> {
    let path = PathBuf::from(text(value, key)?);
    if !path.is_absolute() {
        return Err("invalid-request");
    }
    Ok(path)
}

impl Supervisor {
    async fn dispatch(&self, request: Value) -> Reply {
        if request["version"] != 1 {
            return Err("unsupported-version");
        }
        let credential = request["token"].as_str().unwrap_or("");
        if !bool::from(credential.as_bytes().ct_eq(self.token.as_bytes())) {
            return Err("unauthorized");
        }
        let run_id = id(&request)?;
        let owner = text(&request, "owner")?;
        if owner.len() > 200 {
            return Err("invalid-request");
        }
        if request["op"] == "spawn" {
            return self.spawn(&request).await;
        }
        let process = self
            .processes
            .lock()
            .await
            .get(run_id)
            .cloned()
            .ok_or("unknown-process")?;
        let signals = {
            let state = process.lock().map_err(|_| "ownership-unverifiable")?;
            if state.record["owner"] != owner {
                return Err("ownership-mismatch");
            }
            verified(
                &self.directory,
                &state,
                state.phase == "running" || state.phase == "draining",
            )?;
            if request["op"] == "attach" {
                let since = request["since"].as_u64().ok_or("invalid-request")?;
                if since > state.seq {
                    return Err("invalid-cursor");
                }
                let mut events: Vec<Value> = state
                    .ring
                    .iter()
                    .filter(|(event, _)| event["seq"].as_u64().unwrap_or(0) > since)
                    .map(|(event, _)| event.clone())
                    .collect();
                if let Some(exit) = state.record.get("exit") {
                    if exit["seq"].as_u64().unwrap_or(0) > since {
                        events.push(exit.clone());
                    }
                }
                return Ok(
                    json!({"ok":true,"id":run_id,"pid":state.record["pid"],"identity":state.record["identity"],
                    "epoch":state.record["epoch"],"events":events,"cursor":state.seq,
                    "gap":since < state.evicted,"state":state.phase,
                    "groupEmpty":state.phase == "exited" && group_empty(state.record["pid"].as_u64().unwrap_or(0) as u32)}),
                );
            }
            if request["op"] != "signal" {
                return Err("invalid-request");
            }
            if !matches!(state.phase.as_str(), "running" | "draining")
                || state.record["epoch"] != self.epoch
                || request["epoch"] != state.record["epoch"]
            {
                return Err("ownership-unverifiable");
            }
            state.signals.clone()
        };
        let signal = match text(&request, "signal")? {
            "SIGINT" => libc::SIGINT,
            "SIGTERM" => libc::SIGTERM,
            "SIGKILL" => libc::SIGKILL,
            _ => return Err("invalid-signal"),
        };
        let (sender, receiver) = oneshot::channel();
        signals
            .send((signal, sender))
            .await
            .map_err(|_| "ownership-unverifiable")?;
        receiver.await.map_err(|_| "ownership-unverifiable")?
    }

    async fn spawn(&self, request: &Value) -> Reply {
        let run_id = id(request)?;
        let command = absolute(request, "command")?;
        let cwd = absolute(request, "cwd")?;
        let args: Vec<&str> = request["args"]
            .as_array()
            .ok_or("invalid-request")?
            .iter()
            .map(|arg| {
                arg.as_str()
                    .filter(|s| !s.contains('\0'))
                    .ok_or("invalid-request")
            })
            .collect::<Result<_, _>>()?;
        let env = request["env"].as_object().ok_or("invalid-request")?;
        for (key, value) in env {
            if key.is_empty()
                || key.contains(['=', '\0'])
                || value.as_str().is_none_or(|s| s.contains('\0'))
            {
                return Err("invalid-request");
            }
        }
        let stdout =
            regular(&absolute(request, "stdoutPath")?, true).map_err(|_| "invalid-output")?;
        let stderr =
            regular(&absolute(request, "stderrPath")?, true).map_err(|_| "invalid-output")?;
        let stdin = if request.get("stdinPath").is_some() {
            Stdio::from(
                regular(&absolute(request, "stdinPath")?, false).map_err(|_| "invalid-input")?,
            )
        } else {
            Stdio::null()
        };
        let mut processes = self.processes.lock().await;
        if processes.contains_key(run_id)
            || self
                .directory
                .join(format!("{run_id}.owner.json"))
                .try_exists()
                .map_err(|_| "ownership-unverifiable")?
        {
            return Err("duplicate-process");
        }
        if processes.len() >= MAX_PROCESSES {
            return Err("process-limit");
        }
        let mut record = json!({"version":1,"id":run_id,"owner":text(request, "owner")?,"epoch":self.epoch,
            "pid":0,"identity":null,"state":"prepared"});
        persist(&self.directory, &record)?;
        let admission = take_admission(request)?;
        let mut launch = Command::new(command);
        launch
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(env.iter().map(|(k, v)| (k, v.as_str().unwrap())))
            .stdin(stdin)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        // Between fork and exec, use only async-signal-safe signal/session operations.
        unsafe {
            launch.pre_exec(|| {
                crate::child_spawn::reset_signal_mask()?;
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = match launch.spawn() {
            Ok(child) => child,
            Err(_) => {
                if let Some((path, lease)) = admission {
                    if read_record(&path).is_ok_and(|current| current == lease) {
                        let _ = fs::remove_file(path);
                    }
                }
                record["state"] = json!("spawn-failed");
                persist(&self.directory, &record)?;
                return Err("spawn-failed");
            }
        };
        let pid = child.id().ok_or("ownership-unverifiable")?;
        record["pid"] = json!(pid);
        record["identity"] = identity(pid).unwrap_or(Value::Null);
        record["state"] = json!("running");
        let persisted = persist(&self.directory, &record);
        let (signals, receiver) = mpsc::channel(8);
        let process = Arc::new(Mutex::new(Process {
            record: record.clone(),
            phase: "running".into(),
            ring: VecDeque::new(),
            bytes: 0,
            seq: 0,
            evicted: 0,
            signals,
        }));
        processes.insert(run_id.into(), process.clone());
        let out = tokio::spawn(capture(
            child.stdout.take().unwrap(),
            stdout,
            process.clone(),
            "stdout",
        ));
        let err = tokio::spawn(capture(
            child.stderr.take().unwrap(),
            stderr,
            process.clone(),
            "stderr",
        ));
        tokio::spawn(own_child(
            child,
            receiver,
            process,
            self.directory.clone(),
            out,
            err,
            admission,
        ));
        persisted?;
        if record["identity"].is_null() {
            return Err("ownership-unverifiable");
        }
        Ok(
            json!({"ok":true,"id":run_id,"pid":pid,"identity":record["identity"],"epoch":self.epoch}),
        )
    }
}

async fn capture<R: AsyncRead + Unpin>(
    mut pipe: R,
    file: File,
    process: SharedProcess,
    stream: &'static str,
) -> io::Result<()> {
    let mut file = tokio::fs::File::from_std(file);
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let count = pipe.read(&mut buffer).await?;
        if count == 0 {
            return file.flush().await;
        }
        file.write_all(&buffer[..count]).await?;
        let mut state = process
            .lock()
            .map_err(|_| io::Error::other("state unavailable"))?;
        state.seq += 1;
        let event =
            json!({"seq":state.seq,"stream":stream,"data":STANDARD.encode(&buffer[..count])});
        // Charge serialized bytes too: short reads must not make an attachment
        // exceed the transport limit through JSON event overhead.
        let size = event.to_string().len();
        state.ring.push_back((event, size));
        state.bytes += size;
        while state.bytes > RING_BYTES {
            if let Some((event, size)) = state.ring.pop_front() {
                state.evicted = event["seq"].as_u64().unwrap_or(state.evicted);
                state.bytes -= size;
            }
        }
    }
}

async fn own_child(
    mut child: Child,
    mut signals: mpsc::Receiver<Signal>,
    process: SharedProcess,
    directory: PathBuf,
    out: tokio::task::JoinHandle<io::Result<()>>,
    err: tokio::task::JoinHandle<io::Result<()>>,
    admission: Option<(PathBuf, Value)>,
) {
    let mut clock = tokio::time::interval(Duration::from_millis(10));
    let pid = child.id().unwrap_or(0);
    let status = loop {
        let drained = out.is_finished() && err.is_finished() && descendants_drained(pid);
        tokio::select! {
            _ = clock.tick() => {
                if drained {
                    // Reaping and changing the visible phase share the same
                    // lock as attach/ownership checks. A second Tokio thread
                    // must never probe a reaped leader as a live owner.
                    let Ok(mut state) = process.lock() else { return; };
                    match child.try_wait() {
                        Ok(Some(status)) => { state.phase = "settling".into(); break Ok(status); }
                        Err(error) => { state.phase = "lost".into(); break Err(error); }
                        Ok(None) => {}
                    }
                }
                let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                if let Some(pid) = child.id() {
                    if unsafe { libc::waitid(libc::P_PID, pid, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) } == 0
                        && unsafe { info.si_pid() } == pid as i32 {
                        if let Ok(mut state) = process.lock() { state.phase = "draining".into(); }
                    }
                }
            }
            Some((signal, reply)) = signals.recv() => {
                let result = (|| {
                    let state = process.lock().map_err(|_| "ownership-unverifiable")?;
                    verified(&directory, &state, true)?;
                    let pid = child.id().ok_or("ownership-unverifiable")?;
                    if state.record["pid"] != pid { return Err("ownership-mismatch"); }
                    // No wait/reap can run concurrently in this actor. Even an
                    // exited (zombie) leader still pins this process-group id.
                    if unsafe { libc::kill(-(pid as i32), signal) } != 0 { return Err("signal-refused"); }
                    Ok(json!({"ok":true}))
                })();
                let _ = reply.send(result);
            }
        }
    };
    // /proc enumeration can race a forking descendant. Reaping the leader is
    // followed by a kernel group-absence check before terminal settlement. If
    // anything remains, preserve admission and refuse further numeric signals.
    while !group_empty(pid) {
        if let Ok(mut state) = process.lock() {
            state.phase = "lost".into();
        }
        let _ = descendants_drained(pid);
        tokio::select! {
            _ = clock.tick() => {},
            Some((_, reply)) = signals.recv() => { let _ = reply.send(Err("ownership-unverifiable")); }
        }
    }
    if let Ok(mut state) = process.lock() {
        state.phase = "settling".into();
    }
    let (out, err) = tokio::join!(out, err);
    let Ok(mut state) = process.lock() else {
        return;
    };
    let Ok(status) = status else {
        state.phase = "lost".into();
        return;
    };
    use std::os::unix::process::ExitStatusExt;
    state.seq += 1;
    let mut record = state.record.clone();
    record["state"] = json!("exited");
    record["exit"] =
        json!({"seq":state.seq,"stream":"exit","code":status.code(),"signal":status.signal()});
    record["outputComplete"] = json!(matches!(out, Ok(Ok(()))) && matches!(err, Ok(Ok(()))));
    if persist(&directory, &record).is_ok() {
        state.record = record;
        state.phase = "exited".into();
    } else {
        state.phase = "lost".into();
    }
    if let Some((path, lease)) = admission {
        if read_record(&path).is_ok_and(|current| current == lease) {
            let _ = fs::remove_file(path);
        }
    }
}

async fn connection(stream: UnixStream, supervisor: Arc<Supervisor>) -> io::Result<()> {
    if stream.peer_cred()?.uid() != unsafe { libc::geteuid() } {
        return Ok(());
    }
    let (reader, mut writer) = stream.into_split();
    let mut frame = Vec::new();
    BufReader::new(reader)
        .take((MAX_FRAME + 1) as u64)
        .read_until(b'\n', &mut frame)
        .await?;
    let result = if frame.len() > MAX_FRAME || frame.last() != Some(&b'\n') {
        Err("invalid-frame")
    } else {
        match serde_json::from_slice::<Value>(&frame) {
            Ok(request) => supervisor.dispatch(request).await,
            Err(_) => Err("invalid-request"),
        }
    };
    let reply = result.unwrap_or_else(|code| json!({"ok":false,"error":code}));
    writer.write_all(format!("{reply}\n").as_bytes()).await
}

pub async fn run(arguments: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    // Reap orphaned members of our own groups without relying on the app or
    // the host init process. Each group actor waits only its verified members.
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
        return Err("subreaper unavailable".into());
    }
    let option = |name: &str| {
        arguments
            .windows(2)
            .find(|pair| pair[0] == name)
            .map(|pair| PathBuf::from(&pair[1]))
    };
    let socket = option("--socket").ok_or("socket required")?;
    let directory = option("--state-dir").ok_or("state directory required")?;
    if !socket.is_absolute() || !directory.is_absolute() {
        return Err("absolute paths required".into());
    }
    private_directory(&directory)?;
    private_directory(socket.parent().ok_or("socket directory required")?)?;
    let token = std::env::var("O8D_SUPERVISOR_TOKEN")?;
    if token.len() < 32 {
        return Err("credential required".into());
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory.join("supervisor.lock"))?;
    if !lock.metadata()?.is_file()
        || unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0
    {
        return Err("supervisor already running".into());
    }
    if let Ok(metadata) = fs::symlink_metadata(&socket) {
        if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::geteuid() } {
            return Err("socket ownership unavailable".into());
        }
        // The state lock excludes this daemon's owner; never unlink a live peer.
        if UnixStream::connect(&socket).await.is_ok() {
            return Err("socket in use".into());
        }
        fs::remove_file(&socket)?;
    }
    let mut processes = HashMap::new();
    for entry in fs::read_dir(&directory)? {
        let entry = entry?;
        if !entry.file_name().to_string_lossy().ends_with(".owner.json") {
            continue;
        }
        let record = read_record(&entry.path())?;
        let run_id = id(&record)?.to_owned();
        if entry.file_name() != format!("{run_id}.owner.json").as_str() {
            return Err("ownership mismatch".into());
        }
        let seq = record["exit"]["seq"].as_u64().unwrap_or(0);
        let phase = if record["state"] == "exited" {
            "exited"
        } else {
            "lost"
        };
        let (signals, _) = mpsc::channel(1);
        processes.insert(
            run_id,
            Arc::new(Mutex::new(Process {
                record,
                phase: phase.into(),
                ring: VecDeque::new(),
                bytes: 0,
                seq,
                evicted: seq.saturating_sub(1),
                signals,
            })),
        );
    }
    let listener = UnixListener::bind(&socket)?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
    let supervisor = Arc::new(Supervisor {
        token,
        epoch: Uuid::new_v4().to_string(),
        directory,
        processes: tokio::sync::Mutex::new(processes),
    });
    println!("{}", json!({"ready":true,"protocol":1}));
    let limit = Arc::new(Semaphore::new(64));
    loop {
        let permit = limit.clone().acquire_owned().await?;
        let (stream, _) = listener.accept().await?;
        let supervisor = supervisor.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let _ =
                tokio::time::timeout(Duration::from_secs(10), connection(stream, supervisor)).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn spawned_child_clears_executor_signal_mask() {
        std::thread::spawn(|| {
            unsafe {
                let mut blocked=std::mem::zeroed();
                assert_eq!(libc::sigemptyset(&mut blocked),0);
                assert_eq!(libc::sigaddset(&mut blocked,libc::SIGCHLD),0);
                assert_eq!(libc::sigaddset(&mut blocked,libc::SIGTERM),0);
                assert_eq!(libc::pthread_sigmask(libc::SIG_BLOCK,&blocked,std::ptr::null_mut()),0);
            }
            let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            runtime.block_on(async {
                let root=std::env::temp_dir().join(format!("o8d-signal-mask-{}",Uuid::new_v4()));
                private_directory(&root).unwrap();
                let supervisor=Supervisor {token:"fixture-signal-token".into(),epoch:"fixture-epoch".into(),directory:root.clone(),processes:tokio::sync::Mutex::new(HashMap::new())};
                let result=supervisor.dispatch(json!({"version":1,"token":"fixture-signal-token","op":"spawn","id":"mask-fixture","owner":"fixture","command":"/bin/cat","args":["/proc/self/status"],"env":{},"cwd":root,"stdoutPath":root.join("stdout"),"stderrPath":root.join("stderr")})).await.unwrap();
                assert_eq!(result["ok"],true);
                tokio::time::timeout(Duration::from_secs(5),async {
                    loop {
                        let process=supervisor.processes.lock().await.get("mask-fixture").cloned().unwrap();
                        if process.lock().unwrap().phase=="exited" {break;}
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }).await.unwrap();
                let output=fs::read_to_string(root.join("stdout")).unwrap();
                let mask=output.lines().find_map(|l|l.strip_prefix("SigBlk:")).unwrap();
                let mask=u64::from_str_radix(mask.trim(),16).unwrap();
                fs::remove_dir_all(root).unwrap();
                assert_eq!(mask,0,"child inherited the executor's blocked signals");
            });
        }).join().unwrap();
    }

    #[tokio::test]
    async fn short_reads_bound_serialized_replay_as_well_as_payload() {
        let path = std::env::temp_dir().join(format!("o8d-short-reads-{}", Uuid::new_v4()));
        let file = regular(&path, true).unwrap();
        let (signals, _) = mpsc::channel(1);
        let process = Arc::new(Mutex::new(Process {
            record: json!({}),
            phase: "running".into(),
            ring: VecDeque::new(),
            bytes: 0,
            seq: 0,
            evicted: 0,
            signals,
        }));
        // Capacity one guarantees tiny reads through the production capture loop.
        let (reader, mut writer) = tokio::io::duplex(1);
        let write = tokio::spawn(async move {
            for _ in 0..30_000 {
                writer.write_all(b"x").await.unwrap();
            }
        });
        capture(reader, file, process.clone(), "stdout")
            .await
            .unwrap();
        write.await.unwrap();
        let state = process.lock().unwrap();
        let events: Vec<_> = state.ring.iter().map(|(event, _)| event).collect();
        assert!(state.evicted > 0);
        assert!(state.bytes <= RING_BYTES);
        assert!(serde_json::to_vec(&events).unwrap().len() < MAX_FRAME);
        assert_eq!(fs::metadata(&path).unwrap().len(), 30_000);
        fs::remove_file(path).unwrap();
    }
}
