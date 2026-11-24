//! Parked Node (`O8_PARK_NODE=1`): when a request needs Node and none is
//! attached, ask the launcher to start it and hold the request until it
//! attaches. The app's own background traffic never wakes Node; it keeps
//! today's answer (503 or close 1013).
use super::{Producer, Selection};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
    time::timeout,
};

/// How long a request waits for Node before today's unavailable answer.
pub(super) const HOLD: Duration = Duration::from_secs(10);
const LAUNCHER_DEADLINE: Duration = Duration::from_secs(2);

fn launcher_socket() -> Option<PathBuf> {
    let parking = std::env::var("O8_PARK_NODE").as_deref() == Ok("1")
        && std::env::var("O8_API_FRONT_DOOR").as_deref() == Ok("1");
    parking
        .then(|| std::env::var_os("O8D_SESSION_DATA_DIR"))
        .flatten()
        .map(|dir| PathBuf::from(dir).join("launcher.sock"))
}

/// The server's own requests, reads the user did not cause (a window behind
/// another app, or a timer), and identity probes: the same classes Node's idle
/// gate ignores.
pub(super) fn background(header: &str) -> bool {
    let mut lines = header.lines();
    let mut request = lines.next().unwrap_or("").split_whitespace();
    let method = request.next().unwrap_or("");
    let path = request.next().unwrap_or("").split('?').next().unwrap_or("");
    let read = method == "GET" || method == "HEAD";
    if read && path == "/api/setup/identity" {
        return true;
    }
    lines
        .filter_map(|line| line.split_once(':'))
        .any(|(name, value)| {
            let (name, value) = (name.trim(), value.trim());
            name.eq_ignore_ascii_case("x-o8-background") && value == "1"
                || read && name.eq_ignore_ascii_case("x-o8-foreground") && value == "0"
        })
}

/// One `start-node` request to the launcher; true when it accepted.
async fn start_node(socket: PathBuf) -> bool {
    timeout(LAUNCHER_DEADLINE, async {
        let mut peer = UnixStream::connect(socket).await.ok()?;
        peer.write_all(br#"{"op":"start-node"}"#).await.ok()?;
        peer.shutdown().await.ok()?;
        let mut reply = Vec::new();
        peer.take(4096).read_to_end(&mut reply).await.ok()?;
        let reply: Value = serde_json::from_slice(reply.split(|b| *b == b'\n').next()?).ok()?;
        Some(reply["ok"] == true)
    })
    .await
    .ok()
    .flatten()
    .unwrap_or(false)
}

/// With parking on, for a request that is not background traffic: start Node
/// and wait up to HOLD for it to attach. None leaves today's answer in place.
pub(super) async fn producer(header: &str, selection: &mut Selection) -> Option<Arc<Producer>> {
    producer_via(launcher_socket()?, header, selection).await
}

async fn producer_via(
    socket: PathBuf,
    header: &str,
    selection: &mut Selection,
) -> Option<Arc<Producer>> {
    if background(header) {
        return None;
    }
    if let Some(attached) = selection.borrow_and_update().clone() {
        return Some(attached);
    }
    if !start_node(socket).await {
        return None;
    }
    let attached = timeout(HOLD, selection.wait_for(Option::is_some))
        .await
        .ok()?
        .ok()?
        .clone();
    attached
}

/// Wake Node for work o8d accepted but only Node carries out (a queued send).
/// The request is already answered; nothing waits.
#[cfg(feature = "experimental-session-reads")]
pub(super) fn nudge(header: &str, selection: &Selection) {
    let Some(socket) = launcher_socket() else {
        return;
    };
    if background(header) || selection.borrow().is_some() {
        return;
    }
    tokio::spawn(start_node(socket));
}

#[cfg(test)]
mod tests {
    use super::{background, producer_via, Producer};
    use std::{sync::Arc, time::Instant};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::UnixListener,
        sync::watch,
    };

    fn fixture_producer() -> Arc<Producer> {
        Arc::new(Producer {
            bridge_key: "fixture-key".into(),
            upstream: "127.0.0.1:1".into(),
            bus: Arc::new(crate::EventBus::new("fixture".into(), 16)),
            startup_port_info: None,
            generation: 1,
            composer_queue_epoch: None,
            notices: None,
        })
    }

    /// A launcher stand-in: answers `start-node` and attaches a producer after `delay`.
    fn launcher(
        dir: &std::path::Path,
        delay: std::time::Duration,
        attach: watch::Sender<Option<Arc<Producer>>>,
    ) -> (std::path::PathBuf, tokio::task::JoinHandle<Vec<String>>) {
        let path = dir.join("launcher.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let task = tokio::spawn(async move {
            let mut received = Vec::new();
            while let Ok(Ok((mut peer, _))) =
                tokio::time::timeout(std::time::Duration::from_millis(300), listener.accept()).await
            {
                let mut request = String::new();
                peer.read_to_string(&mut request).await.unwrap();
                received.push(request);
                peer.write_all(b"{\"ok\":true,\"state\":\"starting\"}\n")
                    .await
                    .unwrap();
                let attach = attach.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(delay).await;
                    let _ = attach.send(Some(fixture_producer()));
                });
            }
            received
        });
        (path, task)
    }

    fn directory() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("o8d-wake-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn a_request_starts_a_parked_node_and_waits_for_it_to_attach() {
        let dir = directory();
        let (attach, mut selection) = watch::channel(None);
        let (socket, launcher) = launcher(&dir, std::time::Duration::from_millis(150), attach);
        let started = Instant::now();
        let woken = producer_via(socket, "POST /api/lanes HTTP/1.1\r\n\r\n", &mut selection).await;
        assert_eq!(woken.unwrap().bridge_key, "fixture-key");
        assert!(started.elapsed() >= std::time::Duration::from_millis(150));
        assert_eq!(
            launcher.await.unwrap(),
            vec![r#"{"op":"start-node"}"#.to_string()]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn background_traffic_never_asks_the_launcher() {
        let dir = directory();
        let (attach, mut selection) = watch::channel(None);
        let (socket, launcher) = launcher(&dir, std::time::Duration::ZERO, attach);
        let head = "GET /api/lanes HTTP/1.1\r\nx-o8-foreground: 0\r\n\r\n";
        assert!(producer_via(socket, head, &mut selection).await.is_none());
        assert!(launcher.await.unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn without_a_launcher_the_request_keeps_todays_answer() {
        let dir = directory();
        let (_attach, mut selection) = watch::channel(None);
        let woken = producer_via(
            dir.join("launcher.sock"),
            "GET /api/lanes HTTP/1.1\r\n\r\n",
            &mut selection,
        )
        .await;
        assert!(woken.is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_the_apps_own_background_traffic_is_background() {
        for head in [
            "GET /api/lanes HTTP/1.1\r\nx-o8-foreground: 0\r\n\r\n",
            "HEAD /api/lanes HTTP/1.1\r\nX-O8-Foreground:0\r\n\r\n",
            "POST /api/x HTTP/1.1\r\nx-o8-background: 1\r\n\r\n",
            "GET /api/setup/identity?probe=1 HTTP/1.1\r\n\r\n",
            "GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nx-o8-foreground: 0\r\n\r\n",
        ] {
            assert!(background(head), "{head:?}");
        }
        for head in [
            "GET /api/lanes HTTP/1.1\r\n\r\n",
            "GET /api/lanes HTTP/1.1\r\nx-o8-foreground: 1\r\n\r\n",
            // A write the user did not mark is never background.
            "POST /api/lanes HTTP/1.1\r\nx-o8-foreground: 0\r\n\r\n",
            "POST /api/setup/identity HTTP/1.1\r\n\r\n",
            "GET /ws HTTP/1.1\r\nUpgrade: websocket\r\n\r\n",
        ] {
            assert!(!background(head), "{head:?}");
        }
    }
}
