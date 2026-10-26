use super::*;
pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) type View = crate::brain::Brain;
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((0, || Command::Brain)),
    create: |shell, _, workspace, window, cx| {
        let client = shell.client.in_workspace(&workspace);
        Some(Content::Brain(cx.new(|cx| {
            crate::brain::Brain::new(client, workspace, None, window, cx)
        })))
    },
    ..Registration::new("Brain", "Open Brain", |shell, _, window, cx| {
        if let Some(Content::Session(session)) = shell
            .active()
            .and_then(|tab| shell.content.get(&shell.key(&tab)))
        {
            let session = session.clone();
            shell.palette = false;
            session.update(cx, |session, cx| session.shell_open_brain(window, cx));
            shell.revision += 1;
            cx.notify();
            return None;
        }
        Some((Tab::Brain, false))
    })
};
impl ShellView for View {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).focus(window, cx);
    }

    #[cfg(test)]
    fn ready(view: &Entity<Self>, cx: &App) -> bool {
        view.read(cx).painted.get() == view.read(cx).revision
    }
}

use crate::brain::Event;
use async_channel::Sender;
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Read},
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
        let url = self.url("/api/cortex/ask").unwrap();
        let request = self.request("POST", &url).timeout(Duration::from_secs(270));
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

#[cfg(test)]
#[path = "../brain_tests.rs"]
mod tests;
