//! Bounded SSE reader for the same operator-authenticated Brain route as desktop.
use super::*;
use crate::brain::Event;
use async_channel::Sender;
use std::{
    io::{BufRead, BufReader},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
impl Client {
    pub(crate) fn ask_brain(
        &self,
        body: &Value,
        cancel: &Arc<AtomicBool>,
        sender: &Sender<Event>,
    ) -> Result<(), String> {
        let url = self.origin.join("/api/cortex/ask").unwrap();
        let mut request = self
            .agent
            .post(url.as_str())
            .timeout(Duration::from_secs(270));
        if let Some(token) = &self.token {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
        let response = request
            .send_json(body.clone())
            .map_err(|error| match error {
                ureq::Error::Status(_, _) => "Brain could not answer. Try again.".to_owned(),
                _ => "Answer interrupted. Send again to continue.".to_owned(),
            })?;
        if !response
            .header("Content-Type")
            .is_some_and(|t| t.starts_with("text/event-stream"))
        {
            return Err("Brain could not answer. Try again.".into());
        }
        let mut reader = BufReader::new(response.into_reader().take(16 * 1024 * 1024 + 1));
        let mut frame = String::new();
        let mut total = 0;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            let mut bytes = Vec::new();
            let count = reader
                .by_ref()
                .take(1024 * 1024 + 1)
                .read_until(b'\n', &mut bytes)
                .map_err(|_| "Answer interrupted. Send again to continue.")?;
            total += count;
            if bytes.len() > 1024 * 1024 || total > 16 * 1024 * 1024 {
                return Err(
                    "Brain response exceeds the native response limit. Try a shorter question."
                        .into(),
                );
            }
            let line = String::from_utf8(bytes).map_err(|_| "Brain returned invalid text.")?;
            if count == 0 || line.trim_end_matches(['\r', '\n']).is_empty() {
                emit(&frame, sender);
                frame.clear();
                if count == 0 {
                    return Ok(());
                }
            } else {
                frame.push_str(line.trim_end_matches(['\r', '\n']));
                frame.push('\n');
                if frame.len() > 1024 * 1024 {
                    return Err("Brain event exceeds the native response limit.".into());
                }
            }
        }
    }
}
fn emit(frame: &str, sender: &Sender<Event>) {
    let event = frame
        .lines()
        .find_map(|line| line.strip_prefix("event:"))
        .unwrap_or("")
        .trim();
    let data = frame
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n");
    if let Ok(value) = serde_json::from_str::<Value>(&data) {
        let _ = sender.send_blocking(Event::Frame(event.into(), value));
    }
}
