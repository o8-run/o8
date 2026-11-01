//! Thread lineage for the orchestrator UI: the helpers a thread started, read
//! from its own trace (delegate tool calls) and from the server's
//! `parentInboxSubject`, plus `o8://thread/<id>` links between threads.
//! Display only; nothing here starts or stops work.
use crate::{activity::Step, client::Session};
use serde_json::Value;
use crate::theme::current as theme;
use gpui::{AnyElement, SharedString, div, prelude::*, px};
use std::{cell::RefCell, collections::HashSet};

pub const SCHEME: &str = "o8://thread/";

gpui::actions!(
    o8_next,
    [
        /// Opens the thread a lineage row, link chip or marker last asked for.
        OpenThreadLink
    ]
);

thread_local! {
    /// The thread an OpenThreadLink dispatch opens; set just before dispatch.
    static PENDING: RefCell<Option<String>> = const { RefCell::new(None) };
    /// The open thread's helpers as last drawn, for the trace's subagent card.
    static SHOWN: RefCell<Vec<Child>> = const { RefCell::new(Vec::new()) };
    /// Disclosures the reader opened: "card:<trace>" and "strip:<thread>".
    static OPEN: RefCell<HashSet<String>> = RefCell::default();
}

pub fn is_open(key: &str) -> bool {
    OPEN.with(|o| o.borrow().contains(key))
}

pub fn toggle(key: &str) {
    OPEN.with(|o| {
        let mut o = o.borrow_mut();
        if !o.remove(key) {
            o.insert(key.to_owned());
        }
    });
}

/// Live status for trace helpers the server also lists.
pub fn with_live_status(children: Vec<Child>) -> Vec<Child> {
    let shown = shown();
    children
        .into_iter()
        .map(|mut child| {
            if let Some(live) = shown
                .iter()
                .find(|s| s.thread.is_some() && s.thread == child.thread)
            {
                child.working = live.working;
                child.failed = live.failed;
            }
            child
        })
        .collect()
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0., |d| d.as_millis() as f64)
}

const OPEN_ARROW: &str = "M8 16 16 8M10 8h6v6";

/// One lineage row: status dot, title, runtime, elapsed; opens the child's
/// thread when it has one.
pub fn child_row(child: &Child, now: f64, key: String) -> AnyElement {
    let color = if child.working {
        theme().accent
    } else if child.failed {
        theme().danger
    } else {
        theme().success
    };
    let row = div()
        .id(SharedString::from(key.clone()))
        .debug_selector(move || key.clone())
        .h(px(26.))
        .px(px(8.))
        .flex()
        .items_center()
        .gap(px(8.))
        .rounded(px(7.))
        .text_size(px(12.5))
        .child(div().size(px(6.)).rounded_full().bg(color).flex_shrink_0())
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_color(theme().text_secondary)
                .child(crate::text::sanitize(&child.title)),
        )
        .when(!child.runtime.is_empty(), |row| {
            row.child(
                div()
                    .text_color(theme().text_muted)
                    .child(child.runtime.clone()),
            )
        })
        .when_some(elapsed(child, now), |row, time| {
            row.child(div().text_color(theme().text_muted).child(time))
        });
    match child.thread.clone() {
        Some(thread) => row
            .cursor_pointer()
            .hover(|s| s.bg(theme().hover))
            .child(crate::icon::stroke(OPEN_ARROW, theme().text_muted, 12., 1.8))
            .on_click(move |_, window, cx| {
                cx.stop_propagation();
                open(&thread, window, cx);
            })
            .into_any_element(),
        None => row.into_any_element(),
    }
}

/// Asks the shell to open `id`; the shell's OpenThreadLink handler takes it.
pub fn open(id: &str, window: &mut gpui::Window, cx: &mut gpui::App) {
    PENDING.with(|p| *p.borrow_mut() = Some(id.to_owned()));
    window.dispatch_action(Box::new(OpenThreadLink), cx);
}

pub fn take_pending() -> Option<String> {
    PENDING.with(|p| p.borrow_mut().take())
}

pub fn set_shown(children: Vec<Child>) {
    SHOWN.with(|s| *s.borrow_mut() = children);
}

pub fn shown() -> Vec<Child> {
    SHOWN.with(|s| s.borrow().clone())
}

/// One helper a thread started.
#[derive(Clone, Debug, PartialEq)]
pub struct Child {
    pub title: String,
    pub working: bool,
    pub failed: bool,
    /// The child's own thread, when o8 knows it; rows without one are trace-only.
    pub thread: Option<String>,
    pub runtime: String,
    /// Epoch ms.
    pub started: Option<f64>,
    pub finished: Option<f64>,
}

pub fn link(id: &str) -> String {
    format!("{SCHEME}{id}")
}

/// The worktree branch a thread works on, when it is not the default branch.
pub fn worktree_badge(branch: Option<&str>) -> Option<String> {
    let branch = branch?.trim();
    (!branch.is_empty() && !matches!(branch, "main" | "master" | "HEAD" | "trunk"))
        .then(|| crate::text::sanitize(branch))
}

/// The thread row menu's Copy items: (selector, label, clipboard text, toast).
pub fn copy_items(id: &str) -> [(&'static str, &'static str, String, &'static str); 2] {
    [
        ("sidebar-row-copy-id", "Copy thread ID", id.to_owned(), "Thread ID copied"),
        ("sidebar-row-copy-link", "Copy link", link(id), "Thread link copied"),
    ]
}

/// The thread id in an `o8://thread/<id>` link.
pub fn parse_link(url: &str) -> Option<&str> {
    let id = url.strip_prefix(SCHEME)?.trim_end_matches('/');
    valid_id(id).then_some(id)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
}

/// The thread a launch/delegate tool result names: an `o8://thread/` link, or
/// a thread/session id field anywhere in a JSON result.
pub fn created_thread(result: &str) -> Option<String> {
    if let Some(at) = result.find(SCHEME) {
        let rest = &result[at..];
        let end = rest
            .find(|c: char| c.is_whitespace() || matches!(c, ')' | ']' | '"' | '\'' | '>' | ','))
            .unwrap_or(rest.len());
        if let Some(id) = parse_link(&rest[..end]) {
            return Some(id.to_owned());
        }
    }
    let value: Value = serde_json::from_str(result.trim()).ok()?;
    find_id(&value, 0)
}

fn find_id(value: &Value, depth: usize) -> Option<String> {
    const KEYS: [&str; 6] = [
        "threadId",
        "childThreadId",
        "sessionId",
        "sessionKey",
        "conversationId",
        "thread_id",
    ];
    let map = value.as_object()?;
    KEYS.iter()
        .find_map(|k| map.get(*k)?.as_str().filter(|id| valid_id(id)))
        .map(str::to_owned)
        .or_else(|| {
            (depth < 4)
                .then(|| map.values().find_map(|v| find_id(v, depth + 1)))
                .flatten()
        })
}

/// The thread that started `session`, from the server's lineage.
pub fn parent(session: &Session) -> Option<&str> {
    let subject = session.parent_inbox_subject.as_ref()?;
    (subject["kind"] == "conversation")
        .then(|| subject["id"].as_str())
        .flatten()
        .filter(|id| valid_id(id))
}

fn working_status(status: &str) -> bool {
    matches!(
        status,
        "running" | "working" | "busy" | "starting" | "thinking" | "calling" | "active"
    )
}

/// Helpers the server lists as children of `thread`.
pub fn server_children(sessions: &[Session], thread: &str) -> Vec<Child> {
    sessions
        .iter()
        .filter(|s| s.id != thread && parent(s) == Some(thread))
        .map(|s| Child {
            title: s.title.clone(),
            working: working_status(&s.status),
            failed: matches!(s.status.as_str(), "error" | "failed"),
            thread: Some(s.id.clone()),
            runtime: s.runtime.clone(),
            started: s
                .run_started_at
                .as_deref()
                .and_then(|t| t.parse::<f64>().ok().or_else(|| iso_ms(t))),
            finished: None,
        })
        .collect()
}

/// Helpers this thread's trace delegated to.
pub fn trace_children(steps: &[Step]) -> Vec<Child> {
    steps
        .iter()
        .filter(|s| s.delegate)
        .map(|s| Child {
            title: s
                .subject
                .clone()
                .unwrap_or_else(|| "Subagent".into())
                .lines()
                .next()
                .unwrap_or_default()
                .chars()
                .take(80)
                .collect(),
            working: s.status == "running",
            failed: s.status == "failed",
            thread: s.thread.clone(),
            runtime: String::new(),
            started: s.started,
            finished: s.finished,
        })
        .collect()
}

/// Trace helpers, then server children the trace did not already name.
pub fn merge(mut trace: Vec<Child>, server: Vec<Child>) -> Vec<Child> {
    for child in server {
        match trace
            .iter_mut()
            .find(|t| t.thread.is_some() && t.thread == child.thread)
        {
            // The server knows a linked child's live status better.
            Some(known) => {
                known.working = child.working;
                known.failed = child.failed;
                known.runtime = child.runtime;
                if known.title == "Subagent" {
                    known.title = child.title;
                }
            }
            None => trace.push(child),
        }
    }
    trace
}

/// "4 subagents" and "4 working", the card's two lines.
pub fn card_label(children: &[Child]) -> Option<(String, Option<String>)> {
    if children.is_empty() {
        return None;
    }
    let n = children.len();
    let working = children.iter().filter(|c| c.working).count();
    Some((
        format!("{n} {}", if n == 1 { "subagent" } else { "subagents" }),
        (working > 0).then(|| format!("{working} working")),
    ))
}

/// "Waiting on 2 subagents" and the working titles, while any still work.
pub fn waiting(children: &[Child]) -> Option<(String, String)> {
    let working: Vec<&str> = children
        .iter()
        .filter(|c| c.working)
        .map(|c| c.title.as_str())
        .collect();
    let n = working.len();
    (n > 0).then(|| {
        (
            format!("Waiting on {n} {}", if n == 1 { "subagent" } else { "subagents" }),
            working.join(", "),
        )
    })
}

/// Compact elapsed time: "39s", "4m", "2h".
pub fn elapsed(child: &Child, now: f64) -> Option<String> {
    let start = child.started?;
    let end = if child.working {
        now
    } else {
        child.finished.unwrap_or(now)
    };
    let secs = ((end - start) / 1000.).max(0.) as u64;
    Some(match secs {
        0..60 => format!("{secs}s"),
        60..3600 => format!("{}m", secs / 60),
        _ => format!("{}h", secs / 3600),
    })
}

/// RFC 3339 "2026-11-01T14:48:00Z" or "...+00:00" to epoch ms, UTC only.
fn iso_ms(text: &str) -> Option<f64> {
    let text = text.trim();
    let (date, time) = text.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let time = time.trim_end_matches('Z').split('+').next()?;
    let mut t = time.split(':');
    let (h, min) = (t.next()?.parse::<i64>().ok()?, t.next()?.parse::<i64>().ok()?);
    let s = t.next().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.);
    // Days from civil (Howard Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + h * 3600 + min * 60) as f64 + s) * 1000.)
}

#[cfg(test)]
#[path = "lineage_tests.rs"]
mod tests;
