use super::*;
use std::io::BufReader;
pub(super) const TIMEOUT: &str = "Device tools took too long to respond. Refresh to try again.";
const ROUTE: &str = "/api/panel/devices";
pub(super) fn read(client: &Client, action: Option<Value>) -> Result<Value, String> {
    let url = client
        .url(ROUTE)
        .map_err(|_| "Device tools could not be reached.")?;
    let request = client
        .request(if action.is_some() { "POST" } else { "GET" }, &url)
        .timeout(Duration::from_secs(15));
    let response = match action {
        Some(body) => request.send_json(body),
        None => request.call(),
    };
    let (ok, response) = match response {
        Ok(response) => (true, response),
        Err(ureq::Error::Status(_, response)) => (false, response),
        Err(error) => {
            return Err(if error.to_string().to_lowercase().contains("timed out") {
                TIMEOUT
            } else {
                "Device tools could not be reached."
            }
            .into());
        }
    };
    let value: Value = Client::read(response).map_err(|error| -> String {
        if error.contains("timed out") {
            TIMEOUT.into()
        } else {
            "Device tools returned an invalid response.".into()
        }
    })?;
    if !ok {
        return Err(value["error"]["message"]
            .as_str()
            .unwrap_or("Device tools could not be reached.")
            .into());
    }
    if !value["phase"].is_string() || !value["tools"].is_object() || !value["platforms"].is_object()
    {
        return Err("Device tools returned an invalid response.".into());
    }
    Ok(value)
}
// Refresh the subscription before its bounded HTTP lifetime expires. The old
// reader remains authoritative until the replacement's first valid snapshot.
#[cfg(not(test))]
const RENEW_AFTER: Duration = Duration::from_secs(30);
#[cfg(test)]
const RENEW_AFTER: Duration = Duration::from_millis(150);

pub(super) fn stream(
    client: Client,
    cancel: Arc<AtomicBool>,
    send: async_channel::Sender<Option<Value>>,
) {
    use std::{sync::mpsc, time::Instant};
    let (events, receive) = mpsc::sync_channel::<(u64, Option<Value>)>(32);
    let mut readers: Vec<(u64, Arc<AtomicBool>, Instant)> = Vec::new();
    let mut newest = 0;
    let mut active = None;
    let mut accepted = 0;
    let mut renew_at = Instant::now();
    while !cancel.load(Ordering::Acquire) && !send.is_closed() {
        if Instant::now() >= renew_at {
            newest += 1;
            let id = newest;
            let local = Arc::new(AtomicBool::new(false));
            let started = Instant::now();
            readers.push((id, local.clone(), started));
            let (client, cancel, events) = (client.clone(), cancel.clone(), events.clone());
            std::thread::spawn(move || {
                let _ = read_stream(&client, &cancel, &local, id, &events);
                let _ = events.try_send((id, None));
            });
            renew_at = started + RENEW_AFTER;
        }
        match receive.recv_timeout(Duration::from_millis(50)) {
            Ok((id, Some(snapshot))) if active == Some(id) || id > accepted => {
                if active != Some(id) {
                    active = Some(id);
                    accepted = id;
                    for (older, stop, _) in &readers {
                        if *older < id {
                            stop.store(true, Ordering::Release);
                        }
                    }
                    if id == newest
                        && let Some((_, _, started)) = readers.iter().find(|(key, _, _)| *key == id)
                    {
                        renew_at = *started + RENEW_AFTER;
                    }
                }
                if send.try_send(Some(snapshot)).is_err() {
                    break;
                }
                client.wake();
            }
            Ok((id, None)) => {
                readers.retain(|(key, _, _)| *key != id);
                if active == Some(id) {
                    active = None;
                    if send.try_send(None).is_err() {
                        break;
                    }
                    client.wake();
                    renew_at = Instant::now() + Duration::from_millis(1500);
                } else if id == newest {
                    renew_at = Instant::now() + Duration::from_millis(1500);
                }
            }
            Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    for (_, stop, _) in readers {
        stop.store(true, Ordering::Release);
    }
}

fn read_stream(
    client: &Client,
    cancel: &AtomicBool,
    local: &AtomicBool,
    id: u64,
    events: &std::sync::mpsc::SyncSender<(u64, Option<Value>)>,
) -> Result<(), ()> {
    use std::io::Read;
    if cancel.load(Ordering::Acquire) || local.load(Ordering::Acquire) {
        return Ok(());
    }
    let url = client
        .url("/api/panel/devices?stream=controllers")
        .map_err(|_| ())?;
    let response = client
        .request("GET", &url)
        .timeout(Duration::from_secs(35))
        .call()
        .map_err(|_| ())?;
    if response.header("content-type") != Some("text/event-stream") {
        return Err(());
    }
    let mut reader = BufReader::new(response.into_reader());
    let mut frame = Vec::new();
    loop {
        let mut byte = [0];
        if reader.read(&mut byte).map_err(|_| ())? == 0 {
            return Err(());
        }
        if cancel.load(Ordering::Acquire) || local.load(Ordering::Acquire) {
            return Ok(());
        }
        frame.push(byte[0]);
        if frame.len() > 1_000_000 {
            return Err(());
        }
        if frame.ends_with(b"\n\n") {
            if frame.starts_with(b"data: ") {
                let value: Value =
                    serde_json::from_slice(&frame[6..frame.len() - 2]).map_err(|_| ())?;
                if value["revision"]
                    .as_u64()
                    .is_none_or(|n| n > 9_007_199_254_740_991)
                    || !value["controllers"].is_array()
                {
                    return Err(());
                }
                events.try_send((id, Some(value))).map_err(|_| ())?;
            }
            frame.clear();
        }
    }
}
