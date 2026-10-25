//! App cutover: authenticated TS backhauls retain command and checkpoint ownership.
use crate::EventBus;
use futures_util::{Sink, SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    time::timeout,
};
use tokio_tungstenite::{
    accept_async, connect_async,
    tungstenite::{
        client::IntoClientRequest,
        protocol::{frame::coding::CloseCode, CloseFrame},
        Error, Message,
    },
};

pub async fn serve(
    listener: TcpListener,
    upstream: String,
    key: String,
    bus: Arc<EventBus>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> std::io::Result<()> {
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            _ = connections.join_next(), if !connections.is_empty() => {},
            accepted = listener.accept() => {
                let (socket, peer) = accepted?;
                let (upstream, key, bus) = (upstream.clone(), key.clone(), bus.clone());
                let shutdown = shutdown.clone();
                connections.spawn(async move {
                    let _ = connection(socket, peer.ip().to_string(), upstream, key, bus, shutdown).await;
                });
            }
        }
    }
    // Release the public port before announcing fallback. Existing TCP streams
    // remain alive until their HTTP responses complete; WS tasks observe shutdown.
    drop(listener);
    println!("{}", json!({"draining":true}));
    let _ = timeout(Duration::from_secs(5), async {
        while connections.join_next().await.is_some() {}
    })
    .await;
    // JoinSet aborts remaining connections at the bounded shutdown deadline.
    Ok(())
}

async fn connection(
    mut socket: TcpStream,
    peer: String,
    upstream: String,
    key: String,
    bus: Arc<EventBus>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<(), ()> {
    // Peek leaves the handshake available to tungstenite. HTTP remains a bounded
    // streaming proxy to the original handlers, including authenticated ingress.
    let mut header = vec![0; 16 * 1024];
    let count = timeout(Duration::from_secs(5), async {
        loop {
            let count = socket.peek(&mut header).await.map_err(|_| ())?;
            if count == 0 {
                return Err(());
            }
            if header[..count].windows(4).any(|part| part == b"\r\n\r\n") {
                return Ok(count);
            }
            if count == header.len() {
                return Err(());
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .map_err(|_| ())??;
    let end = header[..count]
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .ok_or(())?
        + 4;
    let header = std::str::from_utf8(&header[..end]).map_err(|_| ())?;
    let path = header
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or(())?;
    let upgrade = header.lines().any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.eq_ignore_ascii_case("upgrade") && value.trim().eq_ignore_ascii_case("websocket")
        })
    });
    if !upgrade {
        let mut backend = TcpStream::connect(&upstream).await.map_err(|_| ())?;
        tokio::io::copy_bidirectional(&mut socket, &mut backend)
            .await
            .map_err(|_| ())?;
        return Ok(());
    }
    let mut request = format!("ws://{upstream}{path}")
        .into_client_request()
        .map_err(|_| ())?;
    // Preserve Origin, but derive the authenticated proxy marker and socket peer
    // ourselves. Public headers cannot downgrade a remote device to plaintext.
    if let Some(origin) = header.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("origin").then_some(value.trim())
    }) {
        request
            .headers_mut()
            .insert("origin", origin.parse().map_err(|_| ())?);
    }
    request
        .headers_mut()
        .insert("x-o8d-bridge", key.parse().map_err(|_| ())?);
    request
        .headers_mut()
        .insert("x-o8d-peer", peer.parse().map_err(|_| ())?);
    // Authenticate with the real TS gate before accepting the public upgrade.
    let mut backend = match timeout(Duration::from_secs(10), connect_async(request))
        .await
        .map_err(|_| ())?
    {
        Ok((backend, _)) => backend,
        Err(Error::Http(response)) => {
            let code = response.status().as_u16();
            socket.write_all(format!("HTTP/1.1 {code} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.map_err(|_| ())?;
            return Ok(());
        }
        Err(_) => return Err(()),
    };
    let mut socket = accept_async(socket).await.map_err(|_| ())?;
    let mut live = bus.listen();
    let mut subscriptions = vec![];
    let mut selected = vec![];
    let mut delegated = false;
    let mut alive = true;
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(25),
        Duration::from_secs(25),
    );
    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                let _ = send(&mut socket, Message::Close(Some(CloseFrame { code: CloseCode::Away, reason: "server shutting down".into() }))).await;
                return Ok(());
            }
            _ = heartbeat.tick() => {
                if !alive { return Ok(()); }
                alive = false;
                send(&mut socket, Message::Ping(vec![].into())).await?;
            }
            message = backend.next() => {
                let Some(Ok(message)) = message else { return Ok(()); };
                if let Message::Text(raw) = &message {
                    if let Ok(frame) = serde_json::from_str::<Value>(raw) {
                        if let Some(control) = frame.get("__o8d") {
                            delegated = true;
                            selected = control["capabilities"].as_array().cloned().unwrap_or_default();
                            if control.get("subscriptions").is_none() { continue; }
                            subscriptions = control["subscriptions"].as_array().cloned().unwrap_or_default();
                            // Reconcile events that crossed the producer pipe before
                            // this private subscription barrier reached the backhaul.
                            for subscription in &mut subscriptions {
                                let stream = subscription["stream"].as_str().ok_or(())?.to_owned();
                                let since = subscription["since"].as_u64().unwrap_or(0);
                                let Some((events, latest)) = bus.crossover(&stream, since).await else {
                                    // TS remains the replay authority. Never advance
                                    // over an evicted crossover and claim delivery.
                                    let _ = send(&mut socket, Message::Close(Some(CloseFrame { code: CloseCode::Again, reason: "reconnect for replay".into() }))).await;
                                    return Ok(());
                                };
                                let events = events.into_iter().filter(|event| visible(event, &selected)).collect::<Vec<_>>();
                                if !events.is_empty() {
                                    send(&mut socket, batch(&stream, events, bus.epoch())).await?;
                                }
                                subscription["since"] = json!(latest.max(since));
                            }
                            continue;
                        }
                    }
                }
                match message {
                    Message::Ping(data) => send(&mut backend, Message::Pong(data)).await?,
                    Message::Pong(_) => {},
                    Message::Close(frame) => { let _ = send(&mut socket, Message::Close(frame)).await; return Ok(()); }
                    other => send(&mut socket, other).await?,
                }
            }
            publication = live.recv(), if delegated => {
                let events = match publication {
                    Ok(events) => events,
                    Err(_) => {
                        let _ = send(&mut socket, Message::Close(Some(CloseFrame { code: CloseCode::Again, reason: "reconnect for replay".into() }))).await;
                        return Ok(());
                    }
                };
                for subscription in &mut subscriptions {
                    let stream = subscription["stream"].as_str().ok_or(())?.to_owned();
                    let since = subscription["since"].as_u64().unwrap_or(0);
                    let matching = events.iter().filter(|event| event["stream"] == stream
                        && event["seq"].as_u64().unwrap_or(0) > since && visible(event, &selected)).cloned().collect::<Vec<_>>();
                    if let Some(last) = matching.last() {
                        subscription["since"] = last["seq"].clone();
                        send(&mut socket, batch(&stream, matching, bus.epoch())).await?;
                    }
                }
            }
            message = socket.next() => {
                let Some(Ok(message)) = message else { return Ok(()); };
                match message {
                    Message::Pong(_) => { alive = true; }
                    Message::Ping(data) => { send(&mut socket, Message::Pong(data)).await?; }
                    Message::Close(frame) => { let _ = send(&mut backend, Message::Close(frame)).await; let _ = timeout(Duration::from_millis(50), socket.flush()).await; return Ok(()); }
                    Message::Text(ref raw) if delegated && serde_json::from_str::<Value>(raw).is_ok_and(|frame| frame["type"] == "ping") => {
                        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| ())?.as_millis() as u64;
                        send(&mut socket, Message::text(json!({"channel":"pong","ts":now}).to_string())).await?;
                    }
                    other => send(&mut backend, other).await?,
                }
            }
        }
    }
}

async fn send<S: Sink<Message> + Unpin>(socket: &mut S, message: Message) -> Result<(), ()> {
    timeout(Duration::from_millis(50), socket.send(message))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

fn visible(event: &Value, selected: &[Value]) -> bool {
    let capable = selected
        .iter()
        .any(|value| value == "mobile-inbox-delta-v1");
    match event["audience"].as_str() {
        Some("mobile-inbox-legacy") => !capable,
        Some("mobile-inbox-delta-v1") => capable,
        _ => true,
    }
}

fn batch(stream: &str, events: Vec<Value>, epoch: &str) -> Message {
    Message::text(
        json!({"channel":"realtime","event":"batch","data":{
        "delivery":"live","stream":stream,"latestSeq":events.last().map(|event| &event["seq"]),
        "epoch":epoch,"events":events}})
        .to_string(),
    )
}
