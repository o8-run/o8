//! Launcher-owned listener, with one authenticated, replaceable Node producer.
//! This socket carries the existing stamped event batches, never public commands.
use super::Producer;
use crate::EventBus;
use serde_json::{json, Value};
use std::{
    io,
    os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::{watch, Mutex},
    time::timeout,
};

const FRAME_LIMIT: usize = 1024 * 1024;
pub struct Listener {
    listener: UnixListener,
    path: PathBuf,
    identity: (u64, u64),
}
impl Listener {
    pub async fn bind(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(io::Error::other("absolute producer socket required"));
        }
        if let Ok(meta) = std::fs::symlink_metadata(path) {
            if !meta.file_type().is_socket()
                || meta.uid() != unsafe { libc::geteuid() }
                || meta.mode() & 0o077 != 0
            {
                return Err(io::Error::other("private producer socket required"));
            }
            // Reclaim only an unchanged, dead socket owned by this uid. A live
            // owner or any ambiguous error is never unlinked.
            match timeout(Duration::from_millis(500), UnixStream::connect(path)).await {
                Ok(Err(error)) if error.kind() == io::ErrorKind::ConnectionRefused => {}
                _ => return Err(io::Error::other("producer socket already owned")),
            }
            let current = std::fs::symlink_metadata(path)?;
            if (current.dev(), current.ino()) != (meta.dev(), meta.ino()) {
                return Err(io::Error::other("producer socket changed"));
            }
            std::fs::remove_file(path)?;
        }
        let listener = UnixListener::bind(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        let meta = std::fs::symlink_metadata(path)?;
        Ok(Self {
            listener,
            path: path.to_owned(),
            identity: (meta.dev(), meta.ino()),
        })
    }
    pub async fn run(
        &self,
        key: String,
        public_port: u16,
        mut shutdown: watch::Receiver<bool>,
        selected: watch::Sender<Option<Arc<Producer>>>,
    ) -> io::Result<()> {
        let authority = Arc::new(Mutex::new(selected));
        let mut tasks = tokio::task::JoinSet::new();
        let mut generation = 0;
        loop {
            tokio::select! {
                _ = shutdown.changed() => break,
                _ = tasks.join_next(), if !tasks.is_empty() => {},
                accepted = self.listener.accept() => {
                    let (stream, _) = accepted?;
                    if stream.peer_cred()?.uid() != unsafe { libc::geteuid() } { continue; }
                    // Bound unauthenticated local handshakes as well as frames.
                    if tasks.len() >= 16 { continue; }
                    generation += 1;
                    let authority = authority.clone(); let key = key.clone();
                    tasks.spawn(async move { let _ = attach(stream, &key, public_port, generation, authority).await; });
                }
            }
        }
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        authority.lock().await.send_replace(None);
        Ok(())
    }
}
impl Drop for Listener {
    fn drop(&mut self) {
        if std::fs::symlink_metadata(&self.path)
            .ok()
            .is_some_and(|m| (m.dev(), m.ino()) == self.identity)
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
async fn line(reader: &mut (impl AsyncBufRead + Unpin), limit: usize) -> Result<Vec<u8>, ()> {
    let mut bytes = Vec::new();
    (&mut *reader)
        .take((limit + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .await
        .map_err(|_| ())?;
    if bytes.len() > limit || bytes.last() != Some(&b'\n') {
        return Err(());
    }
    Ok(bytes)
}
fn target(value: &Value, key: &str, port: u16, generation: u64) -> Result<Arc<Producer>, ()> {
    let supplied = value["key"].as_str().ok_or(())?;
    if value["version"] != 1
        || supplied.len() != key.len()
        || !bool::from(supplied.as_bytes().ct_eq(key.as_bytes()))
    {
        return Err(());
    }
    let upstream = value["upstream"].as_str().ok_or(())?;
    let address: std::net::SocketAddr = upstream.parse().map_err(|_| ())?;
    if !address.ip().is_loopback() || address.port() == 0 || address.port() == port {
        return Err(());
    }
    let epoch = value["epoch"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control))
        .ok_or(())?;
    let startup_port_info = match value.get("startupPortInfo") {
        None | Some(Value::Null) => None,
        Some(value) if value.is_object() => Some(value.clone()),
        _ => return Err(()),
    };
    Ok(Arc::new(Producer {
        bridge_key: format!("{key}:{epoch}"),
        upstream: upstream.into(),
        bus: Arc::new(EventBus::new(epoch.into(), 400)),
        startup_port_info,
        generation,
    }))
}
async fn attach(
    stream: UnixStream,
    key: &str,
    port: u16,
    generation: u64,
    authority: Arc<Mutex<watch::Sender<Option<Arc<Producer>>>>>,
) -> Result<(), ()> {
    let (input, mut output) = stream.into_split();
    let mut input = BufReader::new(input);
    let bytes = timeout(Duration::from_secs(5), line(&mut input, 16 * 1024))
        .await
        .map_err(|_| ())??;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
    let producer = target(&value, key, port, generation)?;
    {
        let selected = authority.lock().await;
        if selected.borrow().is_some() {
            return Err(());
        }
        // ACK completes before publication. A peer that cannot read it never
        // becomes authority, and the key is never echoed.
        timeout(Duration::from_secs(5), output.write_all(format!("{}\n", json!({"version":1,"pid":std::process::id(),"generation":generation,"epoch":producer.bus.epoch()})).as_bytes())).await.map_err(|_| ())?.map_err(|_| ())?;
        selected.send_replace(Some(producer.clone()));
    }
    let result = async {
        loop {
            let bytes = line(&mut input, FRAME_LIMIT).await?;
            let events: Vec<Value> = serde_json::from_slice(&bytes).map_err(|_| ())?;
            producer.bus.publish(events).await.map_err(|_| ())?;
        }
        #[allow(unreachable_code)]
        Ok::<(), ()>(())
    }
    .await;
    let selected = authority.lock().await;
    if selected
        .borrow()
        .as_ref()
        .is_some_and(|active| Arc::ptr_eq(active, &producer))
    {
        selected.send_replace(None);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn producer_authority_is_exact_bounded_loopback_and_fresh() {
        let grant = json!({"version":1,"key":"fixture-bridge","upstream":"127.0.0.1:18002","epoch":"producer-a"});
        let a = target(&grant, "fixture-bridge", 18001, 1).unwrap();
        let b = target(&grant, "fixture-bridge", 18001, 2).unwrap();
        assert!(!Arc::ptr_eq(&a.bus, &b.bus));
        assert_eq!(a.bridge_key, "fixture-bridge:producer-a");
        for (name, value) in [
            ("key", json!("wrong")),
            ("version", json!(2)),
            ("upstream", json!("192.0.2.1:18002")),
            ("upstream", json!("127.0.0.1:18001")),
            ("epoch", json!("x".repeat(129))),
            ("startupPortInfo", json!([])),
        ] {
            let mut bad = grant.clone();
            bad[name] = value;
            assert!(target(&bad, "fixture-bridge", 18001, 1).is_err());
        }
    }
    #[tokio::test]
    async fn attachment_authentication_detachment_and_new_epoch_are_atomic() {
        let (selected, mut view) = watch::channel(None);
        let authority = Arc::new(Mutex::new(selected));
        let open = |epoch: &str| {
            let (peer, daemon) = UnixStream::pair().unwrap();
            let authority = authority.clone();
            let task =
                tokio::spawn(
                    async move { attach(daemon, "fixture-key", 18001, 1, authority).await },
                );
            (
                peer,
                task,
                json!({"version":1,"key":"fixture-key","upstream":"127.0.0.1:18002","epoch":epoch}),
            )
        };
        let (mut peer, task, mut grant) = open("first");
        grant["key"] = json!("wrong-key");
        peer.write_all(format!("{grant}\n").as_bytes())
            .await
            .unwrap();
        assert!(task.await.unwrap().is_err());
        assert!(view.borrow().is_none());
        let (peer, task, grant) = open("first");
        let mut peer = BufReader::new(peer);
        peer.get_mut()
            .write_all(format!("{grant}\n").as_bytes())
            .await
            .unwrap();
        let ack = line(&mut peer, 4096).await.unwrap();
        assert!(!String::from_utf8(ack).unwrap().contains("fixture-key"));
        view.changed().await.unwrap();
        let first = view.borrow_and_update().clone().unwrap();
        drop(peer);
        assert!(task.await.unwrap().is_err());
        view.changed().await.unwrap();
        assert!(view.borrow_and_update().is_none());
        let (peer, task, grant) = open("second");
        let mut peer = BufReader::new(peer);
        peer.get_mut()
            .write_all(format!("{grant}\n").as_bytes())
            .await
            .unwrap();
        line(&mut peer, 4096).await.unwrap();
        view.changed().await.unwrap();
        let second = view.borrow_and_update().clone().unwrap();
        assert_eq!(second.bus.epoch(), "second");
        assert!(!Arc::ptr_eq(&first.bus, &second.bus));
        peer.get_mut()
            .write_all(b"malformed producer batch\n")
            .await
            .unwrap();
        assert!(task.await.unwrap().is_err());
        view.changed().await.unwrap();
        assert!(view.borrow().is_none());
    }
    #[tokio::test]
    async fn producer_socket_is_private_and_cleanup_never_unlinks_a_replacement() {
        let root = std::env::temp_dir().join(format!("o8-owner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("producer.sock");
        let listener = Listener::bind(&path).await.unwrap();
        assert_eq!(
            std::fs::symlink_metadata(&path).unwrap().mode() & 0o777,
            0o600
        );
        assert!(Listener::bind(&path).await.is_err());
        std::fs::remove_file(&path).unwrap();
        let foreign = root.join("foreign");
        std::fs::write(&foreign, b"preserve").unwrap();
        std::os::unix::fs::symlink(&foreign, &path).unwrap();
        drop(listener);
        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(Listener::bind(&path).await.is_err());
        assert_eq!(std::fs::read(&foreign).unwrap(), b"preserve");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn frame_reader_caps_allocation_and_requires_complete_line() {
        assert_eq!(line(&mut &b"ok\nrest"[..], 3).await.unwrap(), b"ok\n");
        assert!(line(&mut &b"long\n"[..], 3).await.is_err());
        assert!(line(&mut &b"no newline"[..], 30).await.is_err());
    }
}

/// The launcher's pipe is the owner lifeline; producer EOF only detaches Node.
pub async fn run_owner(address: std::net::SocketAddr, path: &Path, key: String) -> io::Result<()> {
    // Keep the launcher's ownership proof in this process, not git children.
    if let Some(raw) = std::env::var_os("O8_LAUNCH_HOLD_FD") {
        let fd = raw.to_str().and_then(|v| v.parse::<i32>().ok()).filter(|fd| *fd > 2)
            .ok_or_else(|| io::Error::other("ownership hold unavailable"))?;
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
            return Err(io::Error::other("ownership hold unavailable"));
        }
    }
    let socket = Listener::bind(path).await?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    let public_port = listener.local_addr()?.port();
    let (selected, selection) = watch::channel(None);
    let (shutdown, receiver) = watch::channel(false);
    let mut producer = tokio::spawn({
        let receiver = receiver.clone();
        let key = key.clone();
        async move { socket.run(key, public_port, receiver, selected).await }
    });
    let (gone, mut lifeline) = tokio::sync::oneshot::channel();
    // A plain thread avoids leaving Tokio's uninterruptible stdin blocking task
    // behind when SIGTERM drains the server while the parent pipe is still open.
    std::thread::spawn(move || {
        use std::io::Read;
        let mut bytes = [0; 64];
        while matches!(std::io::stdin().read(&mut bytes), Ok(count) if count > 0) {}
        let _ = gone.send(());
    });
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    println!(
        "{}",
        json!({"listening":listener.local_addr()?.to_string()})
    );
    let app = super::serve_producers(listener, key, selection, receiver);
    tokio::pin!(app);
    let result = tokio::select! {
        result = &mut app => result,
        _ = &mut producer => { let _ = shutdown.send(true); app.await },
        _ = &mut lifeline => { let _ = shutdown.send(true); app.await },
        _ = terminate.recv() => { let _ = shutdown.send(true); app.await },
        _ = tokio::signal::ctrl_c() => { let _ = shutdown.send(true); app.await },
    };
    let _ = shutdown.send(true);
    if !producer.is_finished() {
        let _ = producer.await;
    }
    result
}
