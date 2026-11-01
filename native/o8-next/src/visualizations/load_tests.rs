use super::*;
use std::{
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

struct Server {
    client: Client,
    request: mpsc::Receiver<String>,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}
impl Server {
    fn delayed(delay: Duration, reference: &Reference) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let client =
            Client::authenticated(&format!("http://{}", listener.local_addr().unwrap()), None)
                .unwrap();
        let body = json!({"ok":true,"result":{
            "visualization":reference,"sealedHtml":"<p>Saved chart</p>"
        }})
        .to_string();
        let (send, request) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let join = thread::spawn(move || {
            let until = Instant::now() + Duration::from_secs(10);
            let mut socket = loop {
                if stopping.load(Ordering::SeqCst) || Instant::now() >= until {
                    return;
                }
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("fixture accept: {error}"),
                }
            };
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = [0; 4096];
            let Ok(count) = socket.read(&mut bytes) else {
                return;
            };
            let _ = send.send(String::from_utf8_lossy(&bytes[..count]).into_owned());
            let until = Instant::now() + delay;
            while Instant::now() < until {
                if stopping.load(Ordering::SeqCst) {
                    return;
                }
                thread::sleep(Duration::from_millis(5));
            }
            // A timed-out client can close first in the red regression run.
            let _ = write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        });
        Self {
            client,
            request,
            stop,
            join: Some(join),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.join.take().unwrap().join().unwrap();
    }
}
fn reference() -> Reference {
    Reference::parse(&json!({
        "kind":"o8-visualization","id":"vis-00000000-0000-0000-0000-000000000001",
        "title":"Saved chart","height":320,"createdAt":"2026-10-01T00:00:00.000Z"
    }))
    .unwrap()
}

#[test]
fn saved_document_uses_the_read_request_deadline() {
    let reference = reference();
    let server = Server::delayed(Duration::from_secs(6), &reference);
    let result = document(&server.client, &reference, "read-fixture-0123456789");
    let request = server.request.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(request.starts_with(&format!(
        "GET /api/visualizations/{}?nativeNonce=read-fixture-0123456789 ",
        reference.id
    )));
    assert_eq!(
        result,
        Ok("<p>Saved chart</p>".into()),
        "a saved document read must survive the five-second mutation deadline"
    );
}

#[test]
fn document_loading_does_not_start_the_webview_readiness_deadline() {
    let reference = reference();
    let server = Server::delayed(Duration::ZERO, &reference);
    let mut card = Card::new(reference, server.client.clone());
    // Exercise the load lifecycle independently of platform WebKit support.
    card.error = None;
    card.start();
    server.request.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(
        card.started.is_none(),
        "the WebKit readiness clock must wait until its host is created"
    );
    let until = Instant::now() + Duration::from_secs(2);
    while card.loading.is_some() && Instant::now() < until {
        card.poll();
        thread::sleep(Duration::from_millis(5));
    }
    assert!(card.loading.is_none());
    assert_eq!(card.source.as_deref(), Some("<p>Saved chart</p>"));
    assert!(card.error.is_none());
    assert!(
        card.started.is_none(),
        "a fetched document waiting to paint has no running WebKit deadline"
    );
}

#[test]
fn started_webview_readiness_still_has_a_bounded_deadline() {
    let reference = reference();
    let server = Server::delayed(Duration::ZERO, &reference);
    // Complete the disposable server before testing the host-readiness phase.
    document(&server.client, &reference, "ready-fixture-0123456789").unwrap();
    let mut card = Card::new(reference, server.client.clone());
    card.error = None;
    card.source = Some("<p>Saved chart</p>".into());
    card.started = Some(Instant::now() - Duration::from_secs(13));
    assert!(card.poll());
    assert_eq!(
        card.error.as_deref(),
        Some("The visualization did not finish loading. Try again.")
    );
}
