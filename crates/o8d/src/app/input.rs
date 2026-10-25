//! Backhaul pongs acknowledge receipt of preceding input frames, never command
//! execution. Keep originals until that read barrier so a disconnect can report
//! each unconfirmed input instead of silently dropping it.
use futures_util::StreamExt;
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

    async fn fail<S: AsyncRead + AsyncWrite + Unpin>(
        &mut self,
        socket: &mut WebSocketStream<S>,
        plaintext: bool,
    ) -> Result<bool, ()> {
        let unconfirmed = !self.pending.is_empty();
        while let Some((_, message)) = self.pending.pop_front() {
            self.bytes -= message.len();
            if plaintext {
                send(socket, failure(message)).await?;
            }
        }
        Ok(unconfirmed)
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

/// The public peer's pong fences the input it queued before shutdown. Continue
/// reading through that fence and wait for backhaul receipt of each frame.
/// Reserve time inside the outer five-second connection drain to report failures.
pub(super) async fn drain<A, B>(
    socket: &mut WebSocketStream<A>,
    backend: &mut WebSocketStream<B>,
    mut inputs: Inputs,
    mut backend_alive: bool,
    plaintext: bool,
    mut close: Message,
) -> Result<(), ()>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let delivery_deadline = Instant::now() + Duration::from_secs(4);
    let fence = format!("o8-drain:{}", Uuid::new_v4()).into_bytes();
    timeout(Duration::from_millis(4_500), async {
        send(socket, Message::Ping(fence.clone().into())).await?;
        let mut fenced = false;
        let mut unconfirmed = false;
        if !backend_alive { unconfirmed |= inputs.fail(socket, plaintext).await?; }
        loop {
            if fenced && inputs.pending.is_empty() {
                if backend_alive { let _ = send(backend, Message::Close(None)).await; }
                let close = if !plaintext && unconfirmed {
                    // Rust never owns an opaque client's encryption key. Signal
                    // ambiguity with a protocol close, not a plaintext app frame.
                    match close {
                        Message::Close(Some(frame)) if frame.code != CloseCode::Normal
                            && frame.code != CloseCode::Away => Message::Close(Some(frame)),
                        _ => Message::Close(Some(CloseFrame { code: CloseCode::Error,
                            reason: "input delivery unconfirmed".into() })),
                    }
                } else { close };
                return send(socket, close).await;
            }
            tokio::select! {
                _ = sleep_until(delivery_deadline), if backend_alive => {
                    backend_alive = false;
                    unconfirmed |= inputs.fail(socket, plaintext).await?;
                }
                message = backend.next(), if backend_alive => {
                    match message {
                        Some(Ok(Message::Pong(data))) => inputs.confirm(&data),
                        Some(Ok(Message::Ping(data))) => {
                            if send(backend, Message::Pong(data)).await.is_err() {
                                backend_alive = false;
                                unconfirmed |= inputs.fail(socket, plaintext).await?;
                            }
                        }
                        Some(Ok(Message::Text(ref raw))) if serde_json::from_str::<Value>(raw)
                            .is_ok_and(|frame| frame.get("__o8d").is_some()) => {},
                        Some(Ok(Message::Close(frame))) => {
                            close = Message::Close(frame);
                            backend_alive = false;
                            unconfirmed |= inputs.fail(socket, plaintext).await?;
                        }
                        None | Some(Err(_)) => {
                            backend_alive = false;
                            unconfirmed |= inputs.fail(socket, plaintext).await?;
                        }
                        Some(Ok(other)) => send(socket, other).await?,
                    }
                }
                message = socket.next(), if !backend_alive || inputs.has_capacity() => {
                    match message {
                        Some(Ok(Message::Pong(data))) => { if data.as_ref() == fence { fenced = true; } }
                        Some(Ok(Message::Ping(data))) => send(socket, Message::Pong(data)).await?,
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return Ok(()),
                        Some(Ok(other)) => {
                            if backend_alive {
                                if inputs.forward(backend, other).await.is_err() {
                                    backend_alive = false;
                                    unconfirmed |= inputs.fail(socket, plaintext).await?;
                                }
                            } else {
                                unconfirmed = true;
                                if plaintext { send(socket, failure(other)).await?; }
                            }
                        }
                    }
                }
            }
        }
    }).await.map_err(|_| ())?
}
