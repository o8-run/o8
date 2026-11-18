//! App cutover: authenticated TS backhauls retain command and checkpoint ownership.
use crate::EventBus;
use futures_util::{Sink, SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::{timeout, timeout_at, Instant},
};
use tokio_tungstenite::{
    accept_async, accept_async_with_config, connect_async,
    tungstenite::{
        client::IntoClientRequest,
        protocol::{frame::coding::CloseCode, CloseFrame, WebSocketConfig},
        Error, Message,
    },
};

mod input;
#[cfg(unix)]
pub mod producer;

pub struct Producer {
    pub bridge_key: String,
    pub upstream: String,
    pub bus: Arc<EventBus>,
    pub startup_port_info: Option<Value>,
    pub generation: u64,
}
pub type Selection = tokio::sync::watch::Receiver<Option<Arc<Producer>>>;
#[cfg(feature = "experimental-session-reads")]
mod native;
#[cfg(feature = "experimental-session-reads")]
mod prompt_operator;
mod request_counts;

pub async fn serve(
    listener: TcpListener,
    upstream: String,
    key: String,
    bus: Arc<EventBus>,
    shutdown: tokio::sync::watch::Receiver<bool>,
) -> std::io::Result<()> {
    let (_owner, selection) = tokio::sync::watch::channel(Some(Arc::new(Producer {
        bridge_key: key.clone(),
        upstream,
        bus,
        startup_port_info: None,
        generation: 0,
    })));
    serve_producers(listener, key, selection, shutdown).await
}

pub async fn serve_producers(
    listener: TcpListener,
    key: String,
    selection: Selection,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> std::io::Result<()> {
    let mut connections = tokio::task::JoinSet::new();
    let mut writers = tokio::task::JoinSet::new();
    let (reports, mut reports_rx) = tokio::sync::mpsc::unbounded_channel::<input::Report>();
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            _ = connections.join_next(), if !connections.is_empty() => {},
            _ = writers.join_next(), if !writers.is_empty() => {},
            Some(report) = reports_rx.recv() => { writers.spawn(report.finish()); }
            accepted = listener.accept() => {
                let (socket, peer) = accepted?;
                let key = key.clone();
                let selection = selection.clone();
                let shutdown = shutdown.clone();
                let reports = reports.clone();
                connections.spawn(async move {
                    let _ = connection(socket, peer.ip().to_string(), key, selection, shutdown, reports).await;
                });
            }
        }
    }
    // Release the public port before announcing fallback. Existing TCP streams
    // remain alive until their HTTP responses complete; WS tasks observe shutdown.
    drop(listener);
    println!("{}", json!({"draining":true}));
    let deadline = Instant::now() + Duration::from_secs(5);
    let _ = timeout_at(deadline, async {
        while !connections.is_empty() {
            tokio::select! {
                _ = connections.join_next() => {},
                Some(report) = reports_rx.recv() => { writers.spawn(report.finish()); }
            }
        }
    })
    .await;
    // Expire HTTP at five seconds. Aborted WS collectors synchronously hand
    // off their ledger; their reporting owners are outside this JoinSet.
    connections.abort_all();
    while connections.join_next().await.is_some() {}
    while let Ok(report) = reports_rx.try_recv() {
        writers.spawn(report.finish());
    }
    let _ = timeout_at(deadline + Duration::from_millis(250), async {
        while writers.join_next().await.is_some() {}
    })
    .await;
    Ok(())
}

async fn connection(
    mut socket: TcpStream,
    peer: String,
    key: String,
    mut selection: Selection,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    reports: input::Reports,
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
    // Preserve main's realtime path unless the launcher explicitly enables takeover.
    let producer = selection.borrow_and_update().clone();
    let key = producer.as_ref().map(|p| p.bridge_key.clone()).unwrap_or(key);
    let upstream = producer.as_ref().map(|p| p.upstream.as_str());
    let front_door = std::env::var("O8_API_FRONT_DOOR").as_deref() == Ok("1");
    if !upgrade || (front_door && path.split('?').next() != Some("/ws")) {
        let count = request_counts::Count::new(header);
        #[cfg(feature = "experimental-session-reads")]
        let replay = match native::serve(
            &mut socket,
            header,
            upstream,
            &key,
            producer.as_ref().and_then(|p| p.startup_port_info.as_ref()),
            &count,
        )
        .await?
        {
            native::Outcome::Served => return Ok(()),
            native::Outcome::Replay(body) => Some(body),
            native::Outcome::Proxy => None,
        };
        #[cfg(not(feature = "experimental-session-reads"))]
        let replay: Option<Vec<u8>> = None;
        if producer.as_ref().is_some_and(|old| !selection.borrow().as_ref().is_some_and(|current| Arc::ptr_eq(old, current))) {
            return unavailable(&mut socket, &count).await;
        }
        let Some(upstream) = upstream else {
            return unavailable(&mut socket, &count).await;
        };
        let mut backend = match TcpStream::connect(upstream).await {
            Ok(stream) => request_counts::Backend::new(stream),
            Err(_) if producer.as_ref().is_some_and(|p| p.generation > 0) => {
                return unavailable(&mut socket, &count).await;
            }
            Err(_) => {
                count.finish(None).await;
                return Err(());
            }
        };
        // Attest the socket peer on the first request. TS closes each relayed
        // response, so every request arrives on a freshly stamped connection.
        if let Some(stamped) = stamp_http_header(header, &key, &peer) {
            if replay.is_none() {
                socket.read_exact(&mut vec![0; end]).await.map_err(|_| ())?;
            }
            backend
                .write_all(stamped.as_bytes())
                .await
                .map_err(|_| ())?;
        }
        if let Some(body) = replay {
            // If stamping did not apply, the original header was already consumed.
            if stamp_http_header(header, &key, &peer).is_none() {
                backend.write_all(header.as_bytes()).await.map_err(|_| ())?;
            }
            backend.write_all(&body).await.map_err(|_| ())?;
        }
        let result = tokio::io::copy_bidirectional(&mut socket, &mut backend).await;
        count.finish(backend.status).await;
        result.map_err(|_| ())?;
        return Ok(());
    }
    let Some(producer) = producer else {
        // No application session, capabilities or checkpoint is granted here.
        // Producer-backed upgrades still authenticate with the unchanged TS gate.
        return close_unavailable(socket).await;
    };
    let upstream = &producer.upstream;
    let bus = &producer.bus;
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
        Err(_) if producer.generation > 0 => {
            return close_unavailable(socket).await;
        }
        Err(_) => return Err(()),
    };
    // Classify the authenticated backhaul before accepting public input. Only
    // TS's explicit loopback/operator delegation permits plaintext app errors.
    let first = timeout(Duration::from_secs(10), backend.next())
        .await
        .map_err(|_| ())?
        .ok_or(())?
        .map_err(|_| ())?;
    let control = first
        .to_text()
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|frame| frame.get("__o8d").cloned())
        .filter(|control| {
            control["capabilities"].is_array() && control["subscriptions"].is_array()
        });
    let mut delegated = control.is_some();
    let mut subscriptions = control
        .as_ref()
        .and_then(|control| control["subscriptions"].as_array())
        .cloned()
        .unwrap_or_default();
    let mut selected = control
        .as_ref()
        .and_then(|control| control["capabilities"].as_array())
        .cloned()
        .unwrap_or_default();
    let mut socket = accept_async(socket).await.map_err(|_| ())?;
    if !delegated {
        send(&mut socket, first).await?;
    }
    let mut inputs = input::Inputs::new();
    let mut live = bus.listen();
    let mut alive = true;
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(25),
        Duration::from_secs(25),
    );
    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                return input::drain(socket, &mut backend, inputs, true, delegated,
                    Message::Close(Some(CloseFrame { code: CloseCode::Away, reason: "server shutting down".into() })), reports).await;
            }
            _ = selection.changed() => {
                return input::drain(socket, &mut backend, inputs, false, delegated, producer_close(), reports).await;
            }
            _ = heartbeat.tick() => {
                if !alive {
                    return input::drain(socket, &mut backend, inputs, false, delegated,
                        Message::Close(Some(CloseFrame { code: CloseCode::Away, reason: "heartbeat expired".into() })), reports).await;
                }
                alive = false;
                send(&mut socket, Message::Ping(vec![].into())).await?;
            }
            message = backend.next() => {
                let Some(Ok(message)) = message else {
                    return input::drain(socket, &mut backend, inputs, false, delegated, if producer.generation > 0 { producer_close() } else { Message::Close(None) }, reports).await;
                };
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
                                    return input::drain(socket, &mut backend, inputs, true, delegated,
                                        Message::Close(Some(CloseFrame { code: CloseCode::Again, reason: "reconnect for replay".into() })), reports).await;
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
                    Message::Ping(data) => {
                        if send(&mut backend, Message::Pong(data)).await.is_err() {
                            return input::drain(socket, &mut backend, inputs, false, delegated, if producer.generation > 0 { producer_close() } else { Message::Close(None) }, reports).await;
                        }
                    }
                    Message::Pong(data) => inputs.confirm(&data),
                    Message::Close(frame) => {
                        let close = if producer.generation > 0 && frame.as_ref().is_none_or(|f| f.code == CloseCode::Away) {
                            producer_close()
                        } else { Message::Close(frame) };
                        return input::drain(socket, &mut backend, inputs, false, delegated, close, reports).await;
                    }
                    other => send(&mut socket, other).await?,
                }
            }
            publication = live.recv(), if delegated => {
                let events = match publication {
                    Ok(events) => events,
                    Err(_) => {
                        return input::drain(socket, &mut backend, inputs, true, delegated,
                            Message::Close(Some(CloseFrame { code: CloseCode::Again, reason: "reconnect for replay".into() })), reports).await;
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
            message = socket.next(), if inputs.has_capacity() => {
                let Some(Ok(message)) = message else { return Ok(()); };
                match message {
                    Message::Pong(_) => { alive = true; }
                    Message::Ping(data) => { send(&mut socket, Message::Pong(data)).await?; }
                    Message::Close(frame) => { let _ = send(&mut backend, Message::Close(frame)).await; let _ = timeout(Duration::from_millis(50), socket.flush()).await; return Ok(()); }
                    Message::Text(ref raw) if delegated && serde_json::from_str::<Value>(raw).is_ok_and(|frame| frame["type"] == "ping") => {
                        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| ())?.as_millis() as u64;
                        send(&mut socket, Message::text(json!({"channel":"pong","ts":now}).to_string())).await?;
                    }
                    other => {
                        if inputs.forward(&mut backend, other).await.is_err() {
                            return input::drain(socket, &mut backend, inputs, false, delegated, if producer.generation > 0 { producer_close() } else { Message::Close(None) }, reports).await;
                        }
                    }
                }
            }
        }
    }
}

async fn unavailable(socket: &mut TcpStream, count: &request_counts::Count) -> Result<(), ()> {
    socket.write_all(b"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nCache-Control: no-store\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.map_err(|_| ())?;
    count.finish(Some(503)).await;
    Ok(())
}

async fn close_unavailable(socket: TcpStream) -> Result<(), ()> {
    // No application input is accepted. Bound even the close handshake, since
    // this path intentionally grants no Node-authenticated WS session.
    let config = WebSocketConfig::default()
        .max_message_size(Some(16 * 1024))
        .max_frame_size(Some(16 * 1024));
    let mut socket = accept_async_with_config(socket, Some(config))
        .await
        .map_err(|_| ())?;
    send(&mut socket, producer_close()).await?;
    let _ = timeout(Duration::from_millis(250), async {
        while let Some(Ok(message)) = socket.next().await {
            if matches!(message, Message::Close(_)) {
                break;
            }
        }
    })
    .await;
    Ok(())
}

fn producer_close() -> Message {
    Message::Close(Some(CloseFrame {
        code: CloseCode::Again,
        reason: "producer unavailable; reconnect for checkpoint".into(),
    }))
}

/// Rewrites a strictly framed request head with the bridge key and the socket
/// peer, after any client-supplied bridge or address headers. A head that is not
/// strictly CRLF-framed gets no stamp; TS treats it as an unverified caller and
/// Node's parser rejects it.
fn stamp_http_header(header: &str, key: &str, peer: &str) -> Option<String> {
    let lines = header.strip_suffix("\r\n\r\n")?.split("\r\n");
    let mut stamped = String::with_capacity(header.len() + 128);
    for (index, line) in lines.enumerate() {
        if line.contains(['\r', '\n']) {
            return None;
        }
        if index == 0 {
            let parts: Vec<&str> = line.split(' ').collect();
            if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
                return None;
            }
        } else {
            if line.starts_with([' ', '\t']) {
                return None;
            }
            let name = line.split_once(':')?.0.trim().to_ascii_lowercase();
            if name.starts_with("x-o8d-") || name == "x-o8-client-addr" {
                continue;
            }
        }
        stamped.push_str(line);
        stamped.push_str("\r\n");
    }
    stamped.push_str(&format!(
        "x-o8d-bridge: {key}\r\nx-o8d-peer: {peer}\r\nx-o8d-relay: http\r\n\r\n"
    ));
    Some(stamped)
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

#[cfg(test)]
mod tests {
    use super::stamp_http_header;

    #[test]
    fn stamps_the_peer_after_dropping_client_bridge_and_address_headers() {
        let head = "POST /api/lanes HTTP/1.1\r\nHost: 127.0.0.1:3101\r\nX-O8D-Peer: 127.0.0.1\r\nx-o8d-bridge: guess\r\nx-o8d-session-read: authorize\r\nX-O8-Client-Addr : 127.0.0.1\r\nContent-Length: 2\r\n\r\n";
        assert_eq!(
            stamp_http_header(head, "key", "203.0.113.5").as_deref(),
            Some("POST /api/lanes HTTP/1.1\r\nHost: 127.0.0.1:3101\r\nContent-Length: 2\r\nx-o8d-bridge: key\r\nx-o8d-peer: 203.0.113.5\r\nx-o8d-relay: http\r\n\r\n")
        );
    }

    #[test]
    fn never_stamps_a_head_that_is_not_strictly_framed() {
        for head in [
            "GET / HTTP/1.1\r\nHost: a\nX-Smuggled: b\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: a\rX: b\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: a\r\n folded\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: a\r\n\tfolded\r\n\r\n",
            "GET  / HTTP/1.1\r\nHost: a\r\n\r\n",
            "GET /\r\nHost: a\r\n\r\n",
            "GET / HTTP/1.1\r\nno-colon\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: a\r\n",
        ] {
            assert_eq!(
                stamp_http_header(head, "key", "127.0.0.1"),
                None,
                "{head:?}"
            );
        }
    }

    #[test]
    fn stamps_http_1_0_without_host() {
        assert_eq!(
            stamp_http_header("GET /api/panel/file-asset HTTP/1.0\r\n\r\n", "k", "127.0.0.1").as_deref(),
            Some("GET /api/panel/file-asset HTTP/1.0\r\nx-o8d-bridge: k\r\nx-o8d-peer: 127.0.0.1\r\nx-o8d-relay: http\r\n\r\n")
        );
    }
}
