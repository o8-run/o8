//! Backhaul pongs acknowledge receipt of preceding input frames, never command
//! execution. Keep originals until that read barrier so a disconnect can report
//! each unconfirmed input instead of silently dropping it.
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{collections::VecDeque, time::Duration};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::{sleep_until, timeout, Instant};
use tokio_tungstenite::{
    tungstenite::{
        protocol::{frame::coding::CloseCode, CloseFrame},
        Message,
    },
    WebSocketStream,
};
use uuid::Uuid;

use super::send;

#[derive(Default)]
pub(super) struct Inputs {
    tag: String,
    sequence: u64,
    pending: VecDeque<(u64, Message)>,
    bytes: usize,
}

impl Inputs {
    pub fn new() -> Self {
        Self {
            tag: format!("o8-input:{}:", Uuid::new_v4()),
            ..Self::default()
        }
    }

    pub fn has_capacity(&self) -> bool {
        self.bytes < 1024 * 1024 && self.pending.len() < 256
    }

    pub fn confirm(&mut self, pong: &[u8]) {
        let Some(sequence) = std::str::from_utf8(pong)
            .ok()
            .and_then(|text| text.strip_prefix(&self.tag))
            .and_then(|text| text.parse::<u64>().ok())
        else {
            return;
        };
        if sequence > self.sequence {
            return;
        }
        while self
            .pending
            .front()
            .is_some_and(|(number, _)| *number <= sequence)
        {
            let (_, message) = self.pending.pop_front().unwrap();
            self.bytes -= message.len();
        }
    }

    pub async fn forward<S: AsyncRead + AsyncWrite + Unpin>(
        &mut self,
        backend: &mut WebSocketStream<S>,
        message: Message,
    ) -> Result<(), ()> {
        self.sequence += 1;
        self.bytes += message.len();
        self.pending.push_back((self.sequence, message.clone()));
        send(backend, message).await?;
        send(
            backend,
            Message::Ping(format!("{}{}", self.tag, self.sequence).into_bytes().into()),
        )
        .await
    }
}

fn failure(message: Message) -> Message {
    let input = message
        .to_text()
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or_else(|| json!({"type":"binary","bytes":message.len()}));
    let terminal = input["type"] == "terminal-input";
    Message::text(json!({"channel":if terminal {"terminal"} else {"server"},
        "event":if terminal {"error"} else {"input-failed"}, "data":{
            "code":"input_not_delivered", "requestId":input["requestId"], "sessionName":input["sessionName"],
            "error":"Input delivery was not confirmed. Check its state before retrying.", "input":input,
        }}).to_string())
}

/// Reporting owns its socket and originals independently of the input collector.
/// A cancelled collector hands these off synchronously; it never awaits a write
/// while removing an original from the receipt ledger.
pub(super) struct Report {
    socket: WebSocketStream<tokio::net::TcpStream>,
    inputs: Inputs,
    failed: Vec<Message>,
    failed_bytes: usize,
    plaintext: bool,
    fenced: bool,
    close: Message,
}

pub(super) type Reports = tokio::sync::mpsc::UnboundedSender<Report>;

struct ReportingOwner {
    report: Option<Report>,
    reports: Reports,
}

impl Drop for ReportingOwner {
    fn drop(&mut self) {
        if let Some(report) = self.report.take() {
            // One bounded handoff per connection, including task cancellation.
            // No serialization, socket readiness or network wait in this path.
            let _ = self.reports.send(report);
        }
    }
}

impl Report {
    fn has_capacity(&self) -> bool {
        self.failed_bytes < 1024 * 1024 && self.failed.len() < 8192
    }

    fn failed(&mut self, message: Message) {
        self.failed_bytes += message.len();
        self.failed.push(message);
    }

    pub(super) async fn finish(mut self) -> Result<(), ()> {
        let unconfirmed =
            !self.inputs.pending.is_empty() || !self.failed.is_empty() || !self.fenced;
        // Prepare every correlated outcome before the first network yield. The
        // collector's deadline can no longer interrupt per-input accounting.
        let failures = if self.plaintext {
            self.inputs
                .pending
                .drain(..)
                .map(|(_, message)| message)
                .chain(self.failed.drain(..))
                .map(failure)
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let close = if (!self.plaintext && unconfirmed) || !self.fenced {
            match self.close {
                Message::Close(Some(frame))
                    if frame.code != CloseCode::Normal && frame.code != CloseCode::Away =>
                {
                    Message::Close(Some(frame))
                }
                _ => Message::Close(Some(CloseFrame {
                    code: CloseCode::Error,
                    reason: "input delivery unconfirmed".into(),
                })),
            }
        } else {
            self.close
        };
        // feed obeys sink readiness while batching writes; flush once, rather
        // than awaiting a separate network flush for every failure envelope.
        timeout(Duration::from_secs(5), async {
            for message in failures {
                self.socket.feed(message).await.map_err(|_| ())?;
            }
            self.socket.flush().await.map_err(|_| ())?;
            self.socket.send(close).await.map_err(|_| ())?;
            if !self.fenced {
                // Consume the unread suffix through the close handshake so
                // dropping TCP does not reset away the ambiguity close frame.
                while let Some(Ok(message)) = self.socket.next().await {
                    if matches!(message, Message::Close(_)) {
                        break;
                    }
                }
            }
            Ok(())
        })
        .await
        .map_err(|_| ())?
    }
}

/// Collect input through the public pong fence and await upstream receipts.
/// The reporting owner survives both this timeout and connection-task aborts.
pub(super) async fn drain<B>(
    socket: WebSocketStream<tokio::net::TcpStream>,
    backend: &mut WebSocketStream<B>,
    inputs: Inputs,
    mut backend_alive: bool,
    plaintext: bool,
    close: Message,
    reports: Reports,
) -> Result<(), ()>
where
    B: AsyncRead + AsyncWrite + Unpin,
{
    let mut owner = ReportingOwner {
        report: Some(Report {
            socket,
            inputs,
            failed: Vec::new(),
            failed_bytes: 0,
            plaintext,
            fenced: false,
            close,
        }),
        reports,
    };
    let report = owner.report.as_mut().unwrap();
    let delivery_deadline = Instant::now() + Duration::from_secs(4);
    let fence = format!("o8-drain:{}", Uuid::new_v4()).into_bytes();
    timeout(Duration::from_millis(4_500), async {
        send(&mut report.socket, Message::Ping(fence.clone().into())).await?;
        loop {
            if report.fenced && (!backend_alive || report.inputs.pending.is_empty()) {
                if backend_alive { let _ = send(backend, Message::Close(None)).await; }
                return Ok(());
            }
            tokio::select! {
                _ = sleep_until(delivery_deadline), if backend_alive => { backend_alive = false; }
                message = backend.next(), if backend_alive => {
                    match message {
                        Some(Ok(Message::Pong(data))) => report.inputs.confirm(&data),
                        Some(Ok(Message::Ping(data))) => {
                            if send(backend, Message::Pong(data)).await.is_err() { backend_alive = false; }
                        }
                        Some(Ok(Message::Text(ref raw))) if serde_json::from_str::<Value>(raw)
                            .is_ok_and(|frame| frame.get("__o8d").is_some()) => {},
                        Some(Ok(Message::Close(frame))) => {
                            report.close = Message::Close(frame);
                            backend_alive = false;
                        }
                        None | Some(Err(_)) => { backend_alive = false; }
                        Some(Ok(other)) => send(&mut report.socket, other).await?,
                    }
                }
                message = report.socket.next(), if if backend_alive { report.inputs.has_capacity() } else { report.has_capacity() } => {
                    match message {
                        Some(Ok(Message::Pong(data))) => { if data.as_ref() == fence { report.fenced = true; } }
                        Some(Ok(Message::Ping(data))) => send(&mut report.socket, Message::Pong(data)).await?,
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return Ok(()),
                        Some(Ok(other)) => {
                            if backend_alive {
                                if report.inputs.forward(backend, other).await.is_err() { backend_alive = false; }
                            } else { report.failed(other); }
                        }
                    }
                }
            }
        }
    }).await.map_err(|_| ())?
}
