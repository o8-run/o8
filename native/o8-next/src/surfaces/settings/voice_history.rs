//! Settings › Voice › History, from the desktop voice window's History tab:
//! everything dictated or asked on this Mac, newest first, with copy and
//! delete. The desktop host's recorder owns `dictation-history.json` and
//! writes it beside o8 next, so this reads the file directly; the server may
//! run on another machine. The file holds no credentials.
use crate::theme::current as theme;
use gpui::{
    AnyElement, ClipboardItem, Context, IntoElement, Render, SharedString, Window, div, prelude::*,
    px,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const FILE: &str = "dictation-history.json";
/// The host keeps at most this many (`MAX_ENTRIES` in its recorder).
pub(crate) const MAX_ENTRIES: usize = 200;
const COPIED: Duration = Duration::from_millis(1400);
const COPY: &str = "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2";
const CHECK: &str = "M5 12.5 10 17.5 19 7";
const CLOSE: &str = "M6 6l12 12M18 6L6 18";

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct Entry {
    pub id: String,
    pub ts: i64,
    pub mode: String,
    pub text: String,
    #[serde(default)]
    pub app: String,
}

/// The file the host's recorder writes, resolved as the host resolves it.
/// Tests never resolve it: this Mac's dictations are private text.
pub(crate) fn history_path() -> Option<PathBuf> {
    if cfg!(test) {
        return None;
    }
    path_from(|key| std::env::var_os(key))
}

fn path_from(var: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let set = |key| var(key).filter(|value| !value.is_empty());
    set("O8_DATA_DIR")
        .or_else(|| set("CORTEX_IDE_DATA_DIR"))
        .map(PathBuf::from)
        .or_else(|| set("HOME").map(|home| PathBuf::from(home).join(".o8")))
        .map(|dir| dir.join(FILE))
}

/// The recorder's whole file, or nothing when any entry is malformed.
fn parse(body: &str) -> Option<Vec<Entry>> {
    serde_json::from_str(body).ok()
}

/// Newest first, at most the host's cap. A missing or unreadable file reads
/// as empty, as on the desktop.
pub(crate) fn read(path: &Path) -> Vec<Entry> {
    let mut entries = std::fs::read_to_string(path)
        .ok()
        .and_then(|body| parse(&body))
        .unwrap_or_default();
    entries.reverse();
    entries.truncate(MAX_ENTRIES);
    entries
}

/// Rewrites the file with only the entries `keep` accepts. It re-reads just
/// before writing so a dictation recorded since the list loaded survives, and
/// leaves a file it can't parse alone rather than replacing it. Unknown fields
/// are kept. The temp name differs from the host's, so neither replaces the
/// other's half-written file.
fn rewrite(path: &Path, keep: impl Fn(&Value) -> bool) -> bool {
    let Ok(body) = std::fs::read_to_string(path) else {
        return false;
    };
    if parse(&body).is_none() {
        return false;
    }
    let items: Vec<Value> = match serde_json::from_str(&body) {
        Ok(items) => items,
        Err(_) => return false,
    };
    let kept: Vec<Value> = items.into_iter().filter(|item| keep(item)).collect();
    let Ok(text) = serde_json::to_string_pretty(&kept) else {
        return false;
    };
    let temp = path.with_extension("json.next.tmp");
    if std::fs::write(&temp, text).is_ok() && std::fs::rename(&temp, path).is_ok() {
        return true;
    }
    let _ = std::fs::remove_file(&temp);
    false
}

/// One change to the file. Each runs off the UI thread, one at a time.
enum Op {
    Read,
    Delete(String),
    Clear,
}

/// Applies `op`, then reads the list as it now stands.
fn run(path: &Path, op: &Op) -> Vec<Entry> {
    match op {
        Op::Read => {}
        Op::Delete(id) => {
            rewrite(path, |item| item["id"].as_str() != Some(id.as_str()));
        }
        Op::Clear => {
            rewrite(path, |_| false);
        }
    }
    read(path)
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// "just now", "5m ago", "3h ago", then the local "Nov 5 3:04 PM".
pub(crate) fn when(ts: i64, now: i64) -> String {
    let diff = (now - ts).max(0);
    if diff < 45 {
        return "just now".into();
    }
    if diff < 3600 {
        return format!("{}m ago", (diff as f64 / 60.).round() as i64);
    }
    if diff < 86_400 {
        return format!("{}h ago", (diff as f64 / 3600.).round() as i64);
    }
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let Some((month, day, _, hour, minute)) = u64::try_from(ts)
        .ok()
        .and_then(crate::shell::sidebar::calendar_moment)
    else {
        return String::new();
    };
    let twelve = match hour % 12 {
        0 => 12,
        h => h,
    };
    let half = if hour < 12 { "AM" } else { "PM" };
    format!(
        "{} {day} {twelve}:{minute:02} {half}",
        MONTHS[(month as usize).saturating_sub(1).min(11)]
    )
}

/// "com.apple.Notes" reads as "Notes", as on the desktop.
pub(crate) fn app_name(bundle: &str) -> String {
    let last = bundle.rsplit('.').next().unwrap_or(bundle);
    let mut chars = last.chars();
    chars.next().map_or(String::new(), |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

pub(crate) struct VoiceHistory {
    path: Option<PathBuf>,
    pub entries: Vec<Entry>,
    /// The History panel is on screen; only then does activation reread.
    shown: bool,
    /// File operations wait here and run in order, one at a time.
    queue: VecDeque<Op>,
    running: bool,
    copied: Option<String>,
    copied_turn: u64,
    _activation: Option<gpui::Subscription>,
}

impl VoiceHistory {
    pub(crate) fn new(path: Option<PathBuf>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        // The desktop reloads when its window comes forward; so does this,
        // while the panel is on screen.
        let activation = cx.observe_window_activation(window, |this, window, cx| {
            if this.shown && window.is_window_active() {
                this.load(cx);
            }
        });
        Self {
            path,
            entries: vec![],
            shown: false,
            queue: VecDeque::new(),
            running: false,
            copied: None,
            copied_turn: 0,
            _activation: Some(activation),
        }
    }

    /// Settings reports whether the panel is on screen; coming on screen rereads.
    pub(crate) fn set_shown(&mut self, shown: bool, cx: &mut Context<Self>) {
        let appearing = shown && !self.shown;
        self.shown = shown;
        if appearing {
            self.load(cx);
        }
    }

    pub(crate) fn load(&mut self, cx: &mut Context<Self>) {
        self.apply(Op::Read, cx);
    }

    fn apply(&mut self, op: Op, cx: &mut Context<Self>) {
        self.queue.push_back(op);
        self.next(cx);
    }

    fn next(&mut self, cx: &mut Context<Self>) {
        if self.running {
            return;
        }
        let Some(path) = self.path.clone() else {
            self.queue.clear();
            return;
        };
        let Some(op) = self.queue.pop_front() else {
            return;
        };
        self.running = true;
        let work = cx
            .background_executor()
            .spawn(async move { run(&path, &op) });
        cx.spawn(async move |this, cx| {
            let entries = work.await;
            let _ = this.update(cx, |this, cx| {
                this.running = false;
                // A queued change will read again; show only the latest list.
                if this.queue.is_empty() {
                    this.entries = entries;
                    cx.notify();
                }
                this.next(cx);
            });
        })
        .detach();
    }

    fn copy(&mut self, id: String, text: String, cx: &mut Context<Self>) {
        if text.trim().is_empty() {
            return;
        }
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        self.copied = Some(id);
        self.copied_turn += 1;
        let turn = self.copied_turn;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(COPIED).await;
            let _ = this.update(cx, |this, cx| {
                if this.copied_turn == turn {
                    this.copied = None;
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    fn delete(&mut self, id: String, cx: &mut Context<Self>) {
        self.apply(Op::Delete(id), cx);
    }

    fn clear(&mut self, cx: &mut Context<Self>) {
        self.apply(Op::Clear, cx);
    }

    fn button(
        &self,
        id: &'static str,
        label: &'static str,
        cx: &mut Context<Self>,
        run: impl Fn(&mut Self, &mut Context<Self>) + 'static,
    ) -> impl IntoElement {
        div()
            .id(id)
            .debug_selector(move || id.into())
            .flex_none()
            .px(px(8.))
            .py(px(2.))
            .rounded(px(6.))
            .text_size(px(11.))
            .border_1()
            .border_color(theme().border)
            .cursor_pointer()
            .hover(|v| v.bg(theme().hover))
            .on_click(cx.listener(move |this, _, _, cx| run(this, cx)))
            .child(label)
    }

    fn icon_button(
        &self,
        id: String,
        icon: &'static str,
        color: gpui::Rgba,
        cx: &mut Context<Self>,
        run: impl Fn(&mut Self, &mut Context<Self>) + 'static,
    ) -> impl IntoElement {
        let selector = id.clone();
        div()
            .id(SharedString::from(id))
            .debug_selector(move || selector.clone())
            .size(px(24.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(7.))
            .border_1()
            .border_color(theme().border)
            .cursor_pointer()
            .hover(|v| v.bg(theme().hover))
            .on_click(cx.listener(move |this, _, _, cx| run(this, cx)))
            .child(crate::icon::stroke(icon, color, 12.5, 2.))
    }

    fn row(&self, index: usize, entry: &Entry, now: i64, cx: &mut Context<Self>) -> AnyElement {
        let copied = self.copied.as_deref() == Some(entry.id.as_str());
        let group = SharedString::from(format!("voice-history-row-{index}"));
        let app = app_name(&entry.app);
        let (copy_id, copy_text, delete_id) =
            (entry.id.clone(), entry.text.clone(), entry.id.clone());
        div()
            .id(group.clone())
            .debug_selector(move || format!("settings-voice-history-row-{index}"))
            .group(group.clone())
            .py(px(11.))
            .when(index > 0, |v| v.border_t_1().border_color(theme().border))
            .flex()
            .flex_col()
            .gap(px(5.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .child(
                        div()
                            .debug_selector(move || format!("settings-voice-history-mode-{index}"))
                            .text_size(px(9.))
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .text_color(if entry.mode == "ask" {
                                theme().accent
                            } else {
                                theme().text_muted
                            })
                            .child(entry.mode.to_uppercase()),
                    )
                    .child(
                        div()
                            .debug_selector(move || format!("settings-voice-history-time-{index}"))
                            .ml(px(8.))
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .child(when(entry.ts, now)),
                    )
                    .when(!app.is_empty(), |v| {
                        v.child(
                            div()
                                .ml(px(8.))
                                .text_size(px(11.))
                                .text_color(theme().text_muted)
                                .child(format!("· {app}")),
                        )
                    })
                    .child(
                        div()
                            .ml_auto()
                            .flex()
                            .gap(px(5.))
                            .when(!copied, |v| {
                                v.opacity(0.).group_hover(group.clone(), |v| v.opacity(1.))
                            })
                            .child(self.icon_button(
                                format!("settings-voice-history-copy-{index}"),
                                if copied { CHECK } else { COPY },
                                if copied {
                                    theme().success
                                } else {
                                    theme().text_muted
                                },
                                cx,
                                move |this, cx| this.copy(copy_id.clone(), copy_text.clone(), cx),
                            ))
                            .child(self.icon_button(
                                format!("settings-voice-history-delete-{index}"),
                                CLOSE,
                                theme().text_muted,
                                cx,
                                move |this, cx| this.delete(delete_id.clone(), cx),
                            )),
                    ),
            )
            .child(
                div()
                    .text_size(px(13.))
                    .line_height(px(19.5))
                    .text_color(theme().text)
                    .child(entry.text.clone()),
            )
            .into_any_element()
    }
}

impl Render for VoiceHistory {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = now();
        let entries = self.entries.clone();
        let rows: Vec<AnyElement> = entries
            .iter()
            .enumerate()
            .map(|(index, entry)| self.row(index, entry, now, cx))
            .collect();
        let empty = rows.is_empty();
        div()
            .id("settings-voice-history")
            .debug_selector(|| "settings-voice-history".into())
            .flex()
            .flex_col()
            .gap(px(12.))
            .max_w(px(720.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(div().flex_1().child("History"))
                    .child(self.button("settings-voice-history-refresh", "Refresh", cx, |this, cx| {
                        this.load(cx)
                    }))
                    .when(!empty, |v| {
                        v.child(self.button(
                            "settings-voice-history-clear",
                            "Clear all",
                            cx,
                            |this, cx| this.clear(cx),
                        ))
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .p(px(14.))
                    .rounded(px(12.))
                    .border_1()
                    .border_color(theme().border)
                    .child(div().text_size(px(13.)).child("Recent"))
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .child("Everything you dictated or asked, newest first. Stored locally on this Mac."),
                    )
                    .when(empty, |v| {
                        v.child(
                            div()
                                .debug_selector(|| "settings-voice-history-empty".into())
                                .py(px(4.))
                                .text_size(px(12.5))
                                .text_color(theme().text_muted)
                                .child("No dictations yet — hold Fn and speak, and they’ll show up here."),
                        )
                    })
                    .children(rows),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_resolves_as_the_host_resolves_it() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |key: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| OsString::from(*v))
            }
        };
        assert_eq!(
            path_from(env(&[
                ("O8_DATA_DIR", "/d"),
                ("CORTEX_IDE_DATA_DIR", "/c"),
                ("HOME", "/h")
            ])),
            Some(PathBuf::from("/d/dictation-history.json"))
        );
        assert_eq!(
            path_from(env(&[("CORTEX_IDE_DATA_DIR", "/c"), ("HOME", "/h")])),
            Some(PathBuf::from("/c/dictation-history.json"))
        );
        assert_eq!(
            path_from(env(&[("HOME", "/h")])),
            Some(PathBuf::from("/h/.o8/dictation-history.json"))
        );
        assert_eq!(path_from(env(&[])), None);
    }

    #[test]
    fn labels_read_as_the_desktop_writes_them() {
        assert_eq!(when(1_000, 1_030), "just now");
        assert_eq!(when(1_000, 1_000 + 5 * 60), "5m ago");
        assert_eq!(when(1_000, 1_000 + 3 * 3600), "3h ago");
        assert_eq!(app_name("com.apple.Notes"), "Notes");
        assert_eq!(app_name("com.tinyspeck.slackmacgap"), "Slackmacgap");
        assert_eq!(app_name(""), "");
    }

    fn scratch(name: &str, body: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "o8-voice-history-unit-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE);
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn at_most_the_hosts_cap_shows_newest_first() {
        let items: Vec<Value> = (0..MAX_ENTRIES + 5)
            .map(|i| serde_json::json!({"id":i.to_string(),"ts":i,"mode":"dictation","text":"t","app":""}))
            .collect();
        let path = scratch("cap", &serde_json::to_string(&items).unwrap());
        let entries = read(&path);
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert_eq!(entries[0].id, (MAX_ENTRIES + 4).to_string());
        assert_eq!(entries[MAX_ENTRIES - 1].id, "5");
    }

    #[test]
    fn a_file_that_does_not_parse_is_never_rewritten() {
        let path = scratch("bad", "{not json");
        assert!(!rewrite(&path, |_| false));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not json");
        let wrong = r#"[{"id":"1"}]"#;
        let path = scratch("shape", wrong);
        assert!(!rewrite(&path, |_| false));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), wrong);
    }
}
