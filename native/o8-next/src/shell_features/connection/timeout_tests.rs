use super::*;
use std::{
    io::{Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
};

/// Hold HTTP bytes in both directions while the production host stays alive.
/// WebSocket discovery still returns the host's own socket port, as it does
/// through an ordinary TCP proxy.
struct FrozenProxy {
    origin: String,
    frozen: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    acceptor: Option<JoinHandle<()>>,
}
impl FrozenProxy {
    fn new(origin: &str) -> Self {
        let upstream = url::Url::parse(origin)
            .unwrap()
            .socket_addrs(|| None)
            .unwrap()[0];
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let frozen = Arc::new(AtomicBool::new(false));
        let stopped = Arc::new(AtomicBool::new(false));
        let (freeze, stop) = (frozen.clone(), stopped.clone());
        let acceptor = thread::spawn(move || {
            let mut connections = Vec::new();
            while !stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((incoming, _)) => {
                        let (freeze, stop) = (freeze.clone(), stop.clone());
                        connections.push(thread::spawn(move || {
                            let Ok(outgoing) =
                                TcpStream::connect_timeout(&upstream, Duration::from_secs(2))
                            else {
                                return;
                            };
                            let (from, to) =
                                (outgoing.try_clone().unwrap(), incoming.try_clone().unwrap());
                            let (reply_freeze, reply_stop) = (freeze.clone(), stop.clone());
                            let reply = thread::spawn(move || {
                                relay(from, to, &reply_freeze, &reply_stop);
                            });
                            relay(incoming, outgoing, &freeze, &stop);
                            reply.join().unwrap();
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("proxy accept: {error}"),
                }
            }
            for connection in connections {
                connection.join().unwrap();
            }
        });
        Self {
            origin,
            frozen,
            stopped,
            acceptor: Some(acceptor),
        }
    }
    fn freeze(&self, frozen: bool) {
        self.frozen.store(frozen, Ordering::Release);
    }
}
fn relay(mut from: TcpStream, mut to: TcpStream, frozen: &AtomicBool, stopped: &AtomicBool) {
    from.set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    to.set_write_timeout(Some(Duration::from_secs(1))).unwrap();
    let mut buffer = [0; 8192];
    while !stopped.load(Ordering::Acquire) {
        if frozen.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(5));
            continue;
        }
        let count = match from.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(_) => break,
        };
        while frozen.load(Ordering::Acquire) && !stopped.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(5));
        }
        if stopped.load(Ordering::Acquire) || to.write_all(&buffer[..count]).is_err() {
            break;
        }
    }
    let _ = to.shutdown(Shutdown::Write);
}
impl Drop for FrozenProxy {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.acceptor.take().unwrap().join().unwrap();
    }
}

#[gpui::test]
fn frozen_proxy_keeps_loaded_draft_usable_and_recovers(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let proxy = FrozenProxy::new(&fixture.origin);
    let client = Client::authenticated(&proxy.origin, Some("fixture-shell-bearer".into())).unwrap();
    let (shell, mut visual) = open(
        client,
        fixture.root.join("frozen-proxy.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    settled(&shell, cx);
    cx.simulate_keystrokes("ctrl-k n e w enter");
    ready(&shell, cx);
    settled(&shell, cx);
    cx.simulate_input("cached draft");
    let view = shell.read_with(cx, |s, _| match &s.content[&s.key(&s.active().unwrap())] {
        Content::Session(view) => view.clone(),
        _ => panic!("session"),
    });

    proxy.freeze(true);
    shell.update_in(cx, |s, _, cx| s.load(cx));
    settled(&shell, cx);
    shell.read_with(cx, |s, cx| {
        assert!(!s.loading && !s.connected);
        assert_eq!(s.notice, "Server down");
        let sidebar = s.surfaces.sidebar.view.as_ref().unwrap().read(cx);
        assert_eq!(
            sidebar.diagnostic()["notice"],
            "Showing last loaded data · stale (Request timed out)"
        );
    });
    cx.simulate_input(" while stale");
    assert_eq!(
        view.read_with(cx, |v, cx| v.shell_issue_state(cx)["draft"].clone()),
        json!("cached draft while stale"),
        "the loaded window must remain usable while its HTTP proxy is frozen"
    );

    proxy.freeze(false);
    shell.update_in(cx, |s, window, cx| s.tick(true, window, cx));
    settled(&shell, cx);
    ready(&shell, cx);
    assert!(shell.read_with(cx, |s, _| s.connected && s.notice.is_empty()));
    assert_eq!(
        view.read_with(cx, |v, cx| v.shell_issue_state(cx)["draft"].clone()),
        json!("cached draft while stale")
    );
}
