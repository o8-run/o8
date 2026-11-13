use super::*;
use std::io::{Read, Write};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

// A bounded peer tolerates idle/closed sockets and independent concurrent Inbox reads.
pub(super) struct Peer {
    pub(super) client: Client,
    pub(super) requests: Arc<Mutex<Vec<String>>>,
    pub(super) fail: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Peer {
    pub(super) fn new() -> Self {
        Self::with_history(records())
    }
    pub(super) fn with_history(history: Vec<Value>) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let client = Client::authenticated(
            &format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port()),
            Some("fixture".into()),
        )
        .unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let fail = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let (seen, refused, done) = (requests.clone(), fail.clone(), stop.clone());
        let history = Arc::new(history);
        let worker = std::thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        let seen = seen.clone();
                        let refused = refused.clone();
                        let history = history.clone();
                        std::thread::spawn(move || {
                            let _ = socket.set_nonblocking(false);
                            let _ = socket.set_read_timeout(Some(Duration::from_millis(300)));
                            let mut bytes = Vec::new();
                            while !bytes.ends_with(b"\r\n\r\n") && bytes.len() < 8192 {
                                let mut chunk = [0; 1024];
                                let Ok(count) = socket.read(&mut chunk) else {
                                    return;
                                };
                                if count == 0 {
                                    return;
                                }
                                bytes.extend_from_slice(&chunk[..count]);
                            }
                            let request = String::from_utf8_lossy(&bytes).to_string();
                            let audit = request.starts_with("GET /api/panel/approvals?status=all");
                            let limit = request.split("auditLimit=").nth(1)
                                .and_then(|value| value.split(['&', ' ']).next()?.parse::<usize>().ok())
                                .unwrap_or(usize::MAX);
                            seen.lock().unwrap().push(request);
                            let status = if audit && refused.load(Ordering::Relaxed) {
                                "403 Forbidden"
                            } else {
                                "200 OK"
                            };
                            let body = if audit {
                                json!({
                                    "approvals":bounded(&history, limit),
                                    "total":history.iter().filter_map(|row| row["audit"].as_array())
                                        .map(Vec::len).sum::<usize>()
                                })
                            } else {
                                json!({"items":[],"approvals":[],"maintainer":{
                                    "contributions":[],"replies":[],"sources":[],
                                    "truncated":false,"repliesTruncated":false
                                }})
                            }.to_string();
                            let _ = write!(
                                socket,
                                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            );
                        });
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(2)),
                }
            }
        });
        Self {
            client,
            requests,
            fail,
            stop,
            worker: Some(worker),
        }
    }
    pub(super) fn audit_reads(&self) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.starts_with("GET /api/panel/approvals?status=all"))
            .count()
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

fn bounded(history: &[Value], mut remaining: usize) -> Vec<Value> {
    let mut rows = history.to_vec();
    rows.retain_mut(|row| {
        let Some(events) = row["audit"].as_array_mut() else {
            return false;
        };
        events.truncate(remaining);
        remaining = remaining.saturating_sub(events.len());
        !events.is_empty()
    });
    rows
}
