//! Dedicated terminal transport. Reconnect always requests a fresh resync; input
//! is accepted only on the current ready connection and is never retried.
use crate::{
    client::Client,
    terminal_grid::{Grid, Size},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    io::ErrorKind,
    net::TcpStream,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, protocol::WebSocketConfig};

pub enum Event {
    Reconnecting,
    Changed,
    Ready,
    Exited,
    Failed,
}
pub struct Link {
    pub receiver: Receiver<Event>,
    sender: SyncSender<String>,
    size: Arc<Mutex<Size>>,
    ready: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
}
impl Link {
    pub fn input(&self, data: String) -> bool {
        self.ready.load(Ordering::Acquire) && self.sender.try_send(data).is_ok()
    }
    pub fn resize(&self, size: Size) {
        *self.size.lock().unwrap() = size;
    }
}
impl Drop for Link {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}
fn emit(
    sender: &SyncSender<Event>,
    cancel: &AtomicBool,
    client: &Client,
    mut event: Event,
) -> bool {
    loop {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        match sender.try_send(event) {
            Ok(()) => {
                client.wake();
                return true;
            }
            Err(TrySendError::Disconnected(_)) => return false,
            Err(TrySendError::Full(value)) => {
                event = value;
                thread::sleep(Duration::from_millis(1));
            }
        }
    }
}
pub fn connect(client: Client, session: String, initial: Size, grid: Arc<Mutex<Grid>>) -> Link {
    let (sender, receiver) = mpsc::sync_channel(8);
    let (input, commands) = mpsc::sync_channel(64);
    let cancel = Arc::new(AtomicBool::new(false));
    let ready = Arc::new(AtomicBool::new(false));
    let size = Arc::new(Mutex::new(initial));
    let (stopped, available, dimensions) = (cancel.clone(), ready.clone(), size.clone());
    thread::spawn(move || {
        let mut backoff = 100;
        while !stopped.load(Ordering::Relaxed) {
            available.store(false, Ordering::Release);
            // Never deliver queued keystrokes into a replacement connection.
            while commands.try_recv().is_ok() {}
            if !emit(&sender, &stopped, &client, Event::Reconnecting) {
                break;
            }
            let mut run = || -> Result<(), ()> {
                let (url, address) = client.websocket().map_err(|_| ())?;
                let tcp =
                    TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|_| ())?;
                tcp.set_read_timeout(Some(Duration::from_secs(2)))
                    .map_err(|_| ())?;
                tcp.set_write_timeout(Some(Duration::from_secs(2)))
                    .map_err(|_| ())?;
                tcp.set_nodelay(true).map_err(|_| ())?;
                let config = WebSocketConfig::default()
                    .max_message_size(Some(16 * 1024 * 1024))
                    .max_frame_size(Some(16 * 1024 * 1024));
                let (mut socket, _) =
                    tungstenite::client::client_with_config(url.as_str(), tcp, Some(config))
                        .map_err(|_| ())?;
                socket
                    .get_mut()
                    .set_read_timeout(Some(Duration::from_millis(2)))
                    .map_err(|_| ())?;
                let send = |socket: &mut tungstenite::WebSocket<TcpStream>, value: Value| {
                    socket
                        .send(Message::Text(value.to_string().into()))
                        .map_err(|_| ())
                };
                let mut current = *dimensions.lock().unwrap();
                send(
                    &mut socket,
                    json!({"type":"terminal-attach","sessionName":session,"cols":current.0,"rows":current.1}),
                )?;
                // Epoch is scoped to this socket's server-side client view.
                send(
                    &mut socket,
                    json!({"type":"terminal-visibility","sessionName":session,
                    "visible":true,"needsResync":true,"epoch":1,"cols":current.0,"rows":current.1}),
                )?;
                let mut waiting = true;
                let mut ping = Instant::now();
                while !stopped.load(Ordering::Relaxed) {
                    let next = *dimensions.lock().unwrap();
                    if next != current && !waiting {
                        send(
                            &mut socket,
                            json!({"type":"terminal-resize","sessionName":session,"cols":next.0,"rows":next.1}),
                        )?;
                        current = next;
                    }
                    for data in commands.try_iter().take(64) {
                        if !waiting {
                            send(
                                &mut socket,
                                json!({"type":"terminal-input","sessionName":session,"data":data}),
                            )?;
                        }
                    }
                    match socket.read() {
                        Ok(Message::Text(text)) => {
                            let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                                continue;
                            };
                            if frame["channel"] != "terminal"
                                || frame["data"]["sessionName"] != session
                            {
                                continue;
                            }
                            let data = &frame["data"];
                            let resync = frame["event"] == "resync" && data["epoch"] == 1;
                            if resync || (frame["event"] == "data" && !waiting) {
                                let bytes = STANDARD
                                    .decode(data["data"].as_str().ok_or(())?)
                                    .map_err(|_| ())?;
                                if resync {
                                    grid.lock().unwrap().reset();
                                }
                                let historical = resync || data["historical"] == true;
                                // Parse off the UI thread, releasing the grid between
                                // 32 KiB chunks so input/paint can take a brief snapshot.
                                for chunk in bytes.chunks(32 * 1024) {
                                    if stopped.load(Ordering::Relaxed) {
                                        return Ok(());
                                    }
                                    let replies = grid.lock().unwrap().feed(chunk, historical);
                                    for reply in replies {
                                        send(
                                            &mut socket,
                                            json!({"type":"terminal-input","sessionName":session,"data":reply}),
                                        )?;
                                    }
                                }
                                // Notifications coalesce; the bounded grid is the
                                // source of truth, never a backlog of output strings.
                                let _ = sender.try_send(Event::Changed);
                                client.wake();
                                if resync {
                                    waiting = false;
                                    backoff = 100;
                                    available.store(true, Ordering::Release);
                                    if !emit(&sender, &stopped, &client, Event::Ready) {
                                        return Ok(());
                                    }
                                }
                            } else if frame["event"] == "error" {
                                emit(&sender, &stopped, &client, Event::Failed);
                                return Ok(());
                            } else if frame["event"] == "exited" {
                                emit(&sender, &stopped, &client, Event::Exited);
                                return Ok(());
                            }
                        }
                        Ok(Message::Close(_)) => return Err(()),
                        Ok(_) => {}
                        Err(tungstenite::Error::Io(e))
                            if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                        Err(_) => return Err(()),
                    }
                    if ping.elapsed() >= Duration::from_secs(20) {
                        send(&mut socket, json!({"type":"ping"}))?;
                        ping = Instant::now();
                    }
                }
                let _ = send(
                    &mut socket,
                    json!({"type":"terminal-detach","sessionName":session}),
                );
                let _ = socket.close(None);
                Ok(())
            };
            if run().is_ok() {
                break;
            }
            available.store(false, Ordering::Release);
            let start = Instant::now();
            while !stopped.load(Ordering::Relaxed)
                && start.elapsed() < Duration::from_millis(backoff)
            {
                thread::sleep(Duration::from_millis(10));
            }
            backoff = (backoff * 2).min(5000);
        }
        available.store(false, Ordering::Release);
    });
    Link {
        receiver,
        sender: input,
        size,
        ready,
        cancel,
    }
}
