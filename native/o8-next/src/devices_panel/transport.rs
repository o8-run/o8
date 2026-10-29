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
pub(super) fn stream(
    client: Client,
    cancel: Arc<AtomicBool>,
    send: async_channel::Sender<Option<Value>>,
) {
    while !cancel.load(Ordering::Acquire) && !send.is_closed() {
        let result = (|| -> Result<(), ()> {
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
                use std::io::Read;
                if reader.read(&mut byte).map_err(|_| ())? == 0 {
                    return Err(());
                }
                if cancel.load(Ordering::Acquire) || send.is_closed() {
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
                        send.try_send(Some(value)).map_err(|_| ())?;
                        client.wake();
                    }
                    frame.clear();
                }
            }
        })();
        if cancel.load(Ordering::Acquire) || send.is_closed() {
            break;
        }
        let _ = result;
        if send.try_send(None).is_err() {
            break;
        }
        client.wake();
        for _ in 0..15 {
            if cancel.load(Ordering::Acquire) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}
