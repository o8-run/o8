//! The desktop MessageActions row under each turn's answer: Play reads it aloud
//! with the app's `/api/tts` voice, Copy copies its text.
use crate::client::Client;
use crate::model::Row;
use crate::retained::RowState;
use crate::text::Node;
use crate::theme::current as theme;
use gpui::{AnyElement, App, ClipboardItem, Entity, SharedString, div, prelude::*, px};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const PLAY: &str = "M7 4.5 19.5 12 7 19.5Z";
const STOP: &str = "M8 7h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z";
const COPY: &str = "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2";
const CHECK: &str = "M5 12.5 10 17.5 19 7";

/// The answer each finished turn ends on: its last assistant row, with the
/// text of every assistant row in that turn, as classic shows one message.
/// Each value is (copy text, spoken text).
pub(crate) fn turn_ends(rows: &[Rc<RefCell<RowState>>]) -> HashMap<usize, (String, String)> {
    let mut ends = HashMap::new();
    let mut turn: Vec<(String, String)> = vec![];
    let mut last = None;
    let mut live = false;
    let mut finish = |turn: &mut Vec<(String, String)>, last: &mut Option<usize>| {
        if let Some(index) = last.take() {
            let (copy, spoken): (Vec<_>, Vec<_>) = turn.drain(..).unzip();
            ends.insert(index, (copy.join("\n\n"), spoken.join("\n\n")));
        }
        turn.clear();
    };
    for (index, row) in rows.iter().enumerate() {
        match &row.borrow().row {
            Row::Message { role, nodes, .. } if role == "assistant" => {
                let text = plain(nodes, false);
                if !text.is_empty() {
                    turn.push((text, plain(nodes, true)));
                    last = Some(index);
                }
            }
            Row::Message { .. } | Row::PacketHeader { .. } => {
                finish(&mut turn, &mut last);
                live = false;
            }
            Row::Activity { trace, .. } => live = trace.live,
        }
    }
    // The latest turn shows its actions once it has stopped working.
    if !live {
        finish(&mut turn, &mut last);
    }
    ends
}

/// A message's text: prose and lists line by line, code kept for Copy and left
/// out when it is read aloud.
pub(crate) fn plain(nodes: &[Node], speech: bool) -> String {
    let mut out: Vec<String> = vec![];
    for node in nodes {
        let text: String = node.runs.iter().map(|run| run.text.as_str()).collect();
        match node.kind.as_str() {
            "break" => {
                if out.last().is_some_and(|line| !line.is_empty()) {
                    out.push(String::new());
                }
            }
            "code-block" | "diff-card" if speech => {}
            "ul" => out.push(format!("{}{text}", if speech { "" } else { "- " })),
            kind if kind.starts_with("ol:") && !speech => {
                out.push(format!("{} {text}", &kind[3..]))
            }
            _ if node.data.is_none() => out.push(text),
            _ => {}
        }
    }
    while out.last().is_some_and(String::is_empty) {
        out.pop();
    }
    out.join("\n").trim().to_owned()
}

struct Playing {
    row: usize,
    cancel: Arc<AtomicBool>,
    player: Option<u32>,
}

/// One answer speaks at a time across the app, like classic's ttsEngine.
static SPEECH: Mutex<Option<Playing>> = Mutex::new(None);

pub(crate) fn speaking(row: usize) -> bool {
    SPEECH
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|p| p.row == row)
}

pub(crate) fn stop() {
    if let Some(playing) = SPEECH.lock().unwrap().take() {
        playing.cancel.store(true, Ordering::SeqCst);
        if let Some(pid) = playing.player {
            let _ = std::process::Command::new("kill")
                .arg(pid.to_string())
                .status();
        }
    }
}

/// Reading-length chunks: a short lead so the first words play in a second or
/// two, then sentence-bounded chunks fetched while the previous one plays.
fn chunks(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut current = String::new();
    for sentence in text.split_inclusive(['.', '!', '?', '\n']) {
        let limit = if out.is_empty() { 220 } else { 600 };
        if !current.is_empty() && current.len() + sentence.len() > limit {
            out.push(std::mem::take(&mut current));
        }
        current.push_str(sentence);
    }
    if !current.trim().is_empty() {
        out.push(current);
    }
    out.into_iter()
        .map(|c| c.trim().to_owned())
        .filter(|c| !c.is_empty())
        .collect()
}

fn synthesize(client: &Client, text: &str) -> Result<Vec<u8>, String> {
    let url = client.url("/api/tts").map_err(|e| e.to_string())?;
    let response = client
        .request("POST", &url)
        .timeout(Duration::from_secs(60))
        .send_json(serde_json::json!({ "text": text }))
        .map_err(|_| "Voice is unavailable right now.".to_owned())?;
    let mut audio = vec![];
    std::io::Read::read_to_end(&mut response.into_reader(), &mut audio)
        .map_err(|e| e.to_string())?;
    Ok(audio)
}

fn player(file: &std::path::Path) -> Option<std::process::Command> {
    let candidates: &[(&str, &[&str])] = if cfg!(target_os = "macos") {
        &[("afplay", &[])]
    } else {
        &[
            ("mpg123", &["-q"]),
            ("ffplay", &["-nodisp", "-autoexit", "-loglevel", "quiet"]),
        ]
    };
    candidates.iter().find_map(|(name, args)| {
        let found = std::process::Command::new("sh")
            .args(["-c", &format!("command -v {name}")])
            .output()
            .is_ok_and(|o| o.status.success());
        found.then(|| {
            let mut command = std::process::Command::new(name);
            command.args(*args).arg(file);
            command
        })
    })
}

/// Reads `text` aloud; returns when it finishes, fails or is stopped.
/// Marks `row` as the one speaking, stopping any other, before audio arrives.
fn begin(row: usize) -> Arc<AtomicBool> {
    let cancel = Arc::new(AtomicBool::new(false));
    stop();
    *SPEECH.lock().unwrap() = Some(Playing {
        row,
        cancel: cancel.clone(),
        player: None,
    });
    cancel
}

fn read_aloud(
    client: Client,
    row: usize,
    text: String,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let parts = chunks(&text);
    let fetch = |part: String| {
        let client = client.clone();
        std::thread::spawn(move || synthesize(&client, &part))
    };
    let mut next = parts.first().cloned().map(fetch);
    let mut result = Ok(());
    for index in 0..parts.len() {
        let Some(pending) = next.take() else { break };
        let audio = pending
            .join()
            .unwrap_or_else(|_| Err("Voice stopped.".into()));
        if index + 1 < parts.len() {
            next = Some(fetch(parts[index + 1].clone()));
        }
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let audio = match audio {
            Ok(audio) => audio,
            Err(error) => {
                result = Err(error);
                break;
            }
        };
        let file =
            std::env::temp_dir().join(format!("o8-read-aloud-{}-{index}.mp3", std::process::id()));
        if std::fs::write(&file, audio).is_err() {
            result = Err("Could not prepare the audio.".into());
            break;
        }
        let Some(mut command) = player(&file) else {
            result = Err("No audio player is available.".into());
            break;
        };
        match command.spawn() {
            Ok(mut child) => {
                if let Some(playing) = SPEECH.lock().unwrap().as_mut().filter(|p| p.row == row) {
                    playing.player = Some(child.id());
                }
                let _ = child.wait();
            }
            Err(_) => result = Err("No audio player is available.".into()),
        }
        let _ = std::fs::remove_file(&file);
        if result.is_err() || cancel.load(Ordering::SeqCst) {
            break;
        }
    }
    let mut speech = SPEECH.lock().unwrap();
    if speech
        .as_ref()
        .is_some_and(|p| Arc::ptr_eq(&p.cancel, &cancel))
    {
        *speech = None;
    }
    result
}

/// Per-view feedback: which answer was just copied, and a failed read.
#[derive(Default)]
pub(crate) struct Feedback {
    pub copied: Option<(usize, Instant)>,
    pub error: Option<(usize, String)>,
}

fn button(
    id: SharedString,
    path: &'static str,
    tip: &'static str,
    accent: bool,
) -> gpui::Stateful<gpui::Div> {
    let color = if accent {
        theme().accent
    } else {
        theme().text_muted
    };
    div()
        .id(id.clone())
        .debug_selector(move || id.to_string())
        .size(px(26.))
        .rounded(px(7.))
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .hover(|b| b.bg(theme().hover))
        .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(tip.into())).into())
        .child(crate::icon::stroke(path, color, 14., 1.8))
}

/// Play and Copy under a turn's answer.
pub(crate) fn row<V: 'static>(
    view: Entity<V>,
    client: Client,
    feedback: Rc<RefCell<Feedback>>,
    index: usize,
    (text, spoken): (String, String),
) -> AnyElement {
    let playing = speaking(index);
    let copied = feedback
        .borrow()
        .copied
        .is_some_and(|(row, at)| row == index && at.elapsed() < Duration::from_millis(1500));
    let error = feedback
        .borrow()
        .error
        .as_ref()
        .filter(|(row, _)| *row == index)
        .map(|(_, e)| e.clone());
    let play = {
        let view = view.clone();
        let feedback = feedback.clone();
        move |_: &gpui::ClickEvent, _: &mut gpui::Window, cx: &mut App| {
            if speaking(index) {
                stop();
                view.update(cx, |_, cx| cx.notify());
                return;
            }
            feedback.borrow_mut().error = None;
            let (client, spoken, waiting, feedback) = (
                client.clone(),
                spoken.clone(),
                view.clone(),
                feedback.clone(),
            );
            let cancel = begin(index);
            let task = cx
                .background_executor()
                .spawn(async move { read_aloud(client, index, spoken, cancel) });
            cx.spawn(async move |cx| {
                let result = task.await;
                if let Err(error) = result {
                    feedback.borrow_mut().error = Some((index, error));
                }
                let _ = waiting.update(cx, |_, cx| cx.notify());
            })
            .detach();
            // The button turns to Stop now; audio follows the first chunk.
            view.update(cx, |_, cx| cx.notify());
        }
    };
    let copy = {
        let view = view.clone();
        move |_: &gpui::ClickEvent, _: &mut gpui::Window, cx: &mut App| {
            cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
            feedback.borrow_mut().copied = Some((index, Instant::now()));
            view.update(cx, |_, cx| cx.notify());
            let view = view.clone();
            cx.spawn(async move |cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(1500))
                    .await;
                let _ = view.update(cx, |_, cx| cx.notify());
            })
            .detach();
        }
    };
    // Under the answer's reading column, the icons' glyphs on its text edge.
    let actions = div()
        .debug_selector(move || format!("message-actions-{index}"))
        .w_full()
        .max_w(px(crate::retained::COLUMN))
        .pl(px(18.))
        .pb(px(10.))
        .flex()
        .items_center()
        .gap(px(3.))
        .child(
            button(
                format!("message-play-{index}").into(),
                if playing { STOP } else { PLAY },
                if playing {
                    "Stop reading"
                } else {
                    "Read aloud"
                },
                playing,
            )
            .on_click(play),
        )
        .child(
            button(
                format!("message-copy-{index}").into(),
                if copied { CHECK } else { COPY },
                if copied { "Copied" } else { "Copy message" },
                false,
            )
            .on_click(copy),
        )
        .when_some(error, |row, error| {
            row.child(
                div()
                    .pl(px(6.))
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child(error),
            )
        });
    div()
        .w_full()
        .flex()
        .justify_center()
        .child(actions)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_lead_short_then_sentence_sized() {
        let text = "One sentence here. ".repeat(40);
        let parts = chunks(&text);
        assert!(parts[0].len() <= 220, "lead chunk plays quickly");
        assert!(parts.iter().skip(1).all(|p| p.len() <= 600));
        assert_eq!(
            parts.join(" ").split_whitespace().count(),
            text.split_whitespace().count()
        );
    }

    #[test]
    fn plain_keeps_paragraphs_and_skips_code_when_spoken() {
        let nodes = crate::text::markdown(
            "First **bold** line.\n\n- item\n\n```rust\nlet x = 1;\n```\nLast.",
        );
        let copy = plain(&nodes, false);
        assert!(copy.starts_with("First bold line.\n\n- item"), "{copy}");
        assert!(copy.contains("let x = 1;"));
        let spoken = plain(&nodes, true);
        assert!(!spoken.contains("let x"), "{spoken}");
        assert!(spoken.contains("Last."));
    }
}
