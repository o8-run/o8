//! Finishing through the server's dictation routes with the shell's client:
//! `POST /api/dictation/transcribe` (multipart `audio`, Whisper) and
//! `POST /api/dictation/polish` (`{transcript, surface, context}`). Both answer
//! `{text}`; polish adds `cancelled` for a spoken cancel.
use super::{Finish, Polished};
use crate::client::{Client, server_reason};
use serde_json::{Value, json};
use std::time::Duration;

/// The route bounds its upstream call at 60 seconds.
const TRANSCRIBE_WITHIN: Duration = Duration::from_secs(75);
/// The route tries two models for up to 30 seconds each.
const POLISH_WITHIN: Duration = Duration::from_secs(70);
/// The transcribe route's own limit.
const MAX_AUDIO: usize = 10 * 1024 * 1024;

pub(crate) struct ServerFinish {
    client: Client,
}

impl ServerFinish {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }
}

impl Finish for ServerFinish {
    fn transcribe(&self, wav: &std::path::Path) -> Result<String, String> {
        let audio =
            std::fs::read(wav).map_err(|_| "The recording could not be read.".to_string())?;
        if audio.len() > MAX_AUDIO {
            return Err("The recording is too long to transcribe.".into());
        }
        let boundary = format!("o8-speech-{}", stamp());
        let url = self
            .client
            .url("/api/dictation/transcribe")
            .map_err(|_| "Invalid route".to_string())?;
        let reply = self
            .client
            .request("POST", &url)
            .timeout(TRANSCRIBE_WITHIN)
            .set(
                "Content-Type",
                &format!("multipart/form-data; boundary={boundary}"),
            )
            .send_bytes(&multipart(&boundary, &audio));
        let reply = answer(reply, "Transcription")?;
        Ok(reply["text"].as_str().unwrap_or_default().trim().to_owned())
    }

    fn polish(&self, transcript: &str, repo: Option<&str>) -> Result<Polished, String> {
        let mut body = json!({"transcript": transcript, "surface": "chat"});
        if let Some(repo) = repo {
            body["context"] = json!({"activeRepoPath": repo});
        }
        let url = self
            .client
            .url("/api/dictation/polish")
            .map_err(|_| "Invalid route".to_string())?;
        let reply = self
            .client
            .request("POST", &url)
            .timeout(POLISH_WITHIN)
            .send_json(body);
        let reply = answer(reply, "Polish")?;
        Ok(Polished {
            text: reply["text"].as_str().unwrap_or_default().to_owned(),
            cancelled: reply["cancelled"] == true,
        })
    }
}

/// One `audio` file field, as the browser's FormData sends a WAV.
pub(super) fn multipart(boundary: &str, audio: &[u8]) -> Vec<u8> {
    let mut body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"dictation.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(audio);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// The JSON reply, or the route's own `error` text when it refuses.
fn answer(reply: Result<ureq::Response, ureq::Error>, what: &str) -> Result<Value, String> {
    let unreadable = || format!("{what} returned an unreadable reply.");
    match reply {
        Ok(response) => Client::read::<Value>(response).map_err(|_| unreadable()),
        Err(ureq::Error::Status(code, response)) => Err(Client::read::<Value>(response)
            .ok()
            .and_then(|reply| server_reason(&reply))
            .map_or_else(
                || format!("{what} returned HTTP {code}."),
                |reason| format!("{reason}."),
            )),
        Err(_) => Err(format!("{what} could not reach the o8 server.")),
    }
}

fn stamp() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("{nanos:x}")
}
