//! One owned, cancellable socket per selected session. No OS or app discovery.
use crate::client::Client;
use serde_json::{Value, json};
use std::{
    io::ErrorKind,
    net::{Shutdown, TcpStream},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig};

pub enum Incoming {
    Frame(Value),
    Status(&'static str),
}
pub struct Subscription {
    pub receiver: Receiver<Incoming>,
    cancel: Arc<Cancel>,
}
impl Drop for Subscription {
    fn drop(&mut self) {
        self.cancel.stop();
    }
}

#[derive(Default)]
struct Cancel {
    stopped: AtomicBool,
    gate: Mutex<()>,
    changed: Condvar,
    socket: Mutex<Option<TcpStream>>,
}
impl Cancel {
    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }
    fn stop(&self) {
        let gate = self.gate.lock().unwrap();
        self.stopped.store(true, Ordering::Release);
        self.changed.notify_all();
        drop(gate);
        if let Some(socket) = self.socket.lock().unwrap().take() {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
    fn bind(&self, socket: &TcpStream) -> Result<BoundSocket<'_>, ()> {
        let mut owned = self.socket.lock().unwrap();
        if self.is_stopped() {
            return Err(());
        }
        *owned = Some(socket.try_clone().map_err(|_| ())?);
        Ok(BoundSocket(&self.socket))
    }
}
struct BoundSocket<'a>(&'a Mutex<Option<TcpStream>>);
impl Drop for BoundSocket<'_> {
    fn drop(&mut self) {
        self.0.lock().unwrap().take();
    }
}
fn pause(cancel: &Cancel, duration: Duration) {
    let gate = cancel.gate.lock().unwrap();
    let _ = cancel
        .changed
        .wait_timeout_while(gate, duration, |_| !cancel.is_stopped())
        .unwrap();
}
fn emit(
    sender: &SyncSender<Incoming>,
    cancel: &Cancel,
    client: &Client,
    message: Incoming,
) -> bool {
    if cancel.is_stopped() || sender.send(message).is_err() {
        return false;
    }
    client.wake();
    true
}
fn run(
    client: &Client,
    key: &str,
    sender: &SyncSender<Incoming>,
    cancel: &Cancel,
    backoff: &mut u64,
) -> Result<(), ()> {
    let (url, address) = client.websocket().map_err(|_| ())?;
    if cancel.is_stopped() {
        return Ok(());
    }
    // A numeric address is derived from the validated explicit HTTP origin.
    // Direct TCP avoids proxies; the handshake follows no redirects.
    let tcp = TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|_| ())?;
    let _owned_socket = cancel.bind(&tcp)?;
    tcp.set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| ())?;
    tcp.set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| ())?;
    let request = url.as_str().into_client_request().map_err(|_| ())?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(16 * 1024 * 1024))
        .max_frame_size(Some(16 * 1024 * 1024));
    let (mut socket, _) =
        tungstenite::client::client_with_config(request, tcp, Some(config)).map_err(|_| ())?;
    socket
        .get_mut()
        .set_read_timeout(Some(Duration::from_secs(20)))
        .map_err(|_| ())?;
    // Omitting since, including after reconnect, requests a fresh checkpoint,
    // exactly as DesktopWebSocketContext does for a reopened transport.
    socket.send(Message::Text(json!({"type":"realtime-subscribe","subscriptions":[{"stream":format!("session:{key}")}]}).to_string().into())).map_err(|_| ())?;
    if !emit(sender, cancel, client, Incoming::Status("Live · read-only")) {
        return Ok(());
    }
    let mut ping = Instant::now();
    while !cancel.is_stopped() {
        match socket.read() {
            Ok(Message::Text(text)) => {
                if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                    if frame["channel"] == "system" && frame["event"] == "connected" {
                        *backoff = 1;
                    }
                    if frame["channel"] == "realtime" && frame["event"] == "incompatible" {
                        return Err(());
                    }
                    if !emit(sender, cancel, client, Incoming::Frame(frame)) {
                        break;
                    }
                }
            }
            Ok(Message::Close(_)) => return Err(()),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => return Err(()),
        }
        if ping.elapsed() >= Duration::from_secs(20) {
            socket
                .send(Message::Text(json!({"type":"ping"}).to_string().into()))
                .map_err(|_| ())?;
            ping = Instant::now();
        }
    }
    let _ = socket.close(None);
    Ok(())
}
pub fn subscribe(client: Client, key: String) -> Subscription {
    let (sender, receiver) = mpsc::sync_channel(64);
    let cancel = Arc::new(Cancel::default());
    let stopped = cancel.clone();
    thread::spawn(move || {
        let mut backoff = 1;
        while !stopped.is_stopped() {
            let _ = run(&client, &key, &sender, &stopped, &mut backoff);
            if stopped.is_stopped() {
                break;
            }
            if !emit(
                &sender,
                &stopped,
                &client,
                Incoming::Status("Reconnecting · saved history retained"),
            ) {
                break;
            }
            pause(&stopped, Duration::from_secs(backoff));
            backoff = (backoff * 2).min(30);
        }
    });
    Subscription { receiver, cancel }
}
