//! A file pill's peek: rest the pointer on one and the lines it names show
//! beside it. The read goes through the Files panel's route, off the paint
//! thread, and each file is kept by path and modified time. A sent mention's
//! pill peeks the same way at the lines it was sent with.
use crate::{client::Client, theme::current as theme};
use gpui::{
    AnchoredPositionMode, AnyElement, App, Bounds, IntoElement, ParentElement, Pixels, Point, Size,
    Styled, Window, anchored, deferred, div, point, prelude::*, px, size,
};
use serde_json::Value;
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

pub(crate) const OPEN_DELAY: Duration = Duration::from_millis(300);
const CLOSE_DELAY: Duration = Duration::from_millis(150);
/// How many lines a peek shows around the one it names.
const LINES: usize = 8;
/// A file read this recently peeks again without asking the server.
const FRESH: Duration = Duration::from_secs(10);
// The card's fixed measures, so where it fits is known before it lays out.
const WIDTH: f32 = 440.;
const HEADER: f32 = 26.;
const LINE: f32 = 18.;
const NOTE: f32 = 32.;
/// Space between a pill and its card.
const GAP: f32 = 4.;
/// Space kept between the card and the transcript's sides.
const MARGIN: f32 = 8.;
pub(crate) const FILE_ICON: &str =
    "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z M14 3v6h6";
pub(crate) const LINK_ICON: &str = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M3 12h18 M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z";

/// What a peek shows for one file and line.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Snippet {
    /// The lines shown, and the 1-based number of the first.
    Lines {
        first: usize,
        lines: Vec<String>,
    },
    Missing,
    Unavailable(String),
    /// A mention's own lines, with no file to read.
    Preview(Vec<String>),
}

/// About eight lines with the named one near the middle, kept inside the file.
pub(crate) fn window(content: &str, line: Option<usize>) -> Snippet {
    let all: Vec<&str> = content.lines().collect();
    let target = line.unwrap_or(1).clamp(1, all.len().max(1));
    let end = (target.saturating_sub(LINES / 2 - 1).max(1) + LINES - 1).min(all.len());
    let first = end.saturating_sub(LINES - 1).max(1);
    Snippet::Lines {
        first,
        lines: all
            .get(first - 1..end)
            .unwrap_or_default()
            .iter()
            .map(|line| line.replace('\t', "    "))
            .collect(),
    }
}

/// The header's note for a file: its length and how long ago it changed.
pub(crate) fn meta(content: &str, mtime_ms: Option<f64>, now_ms: f64) -> String {
    let count = content.lines().count();
    let lines = if count == 1 { "1 line".to_owned() } else { format!("{count} lines") };
    let Some(mtime) = mtime_ms else {
        return lines;
    };
    let secs = ((now_ms - mtime) / 1000.).max(0.) as u64;
    let ago = match secs {
        0..60 => "modified just now".to_owned(),
        60..3_600 => format!("modified {} min ago", secs / 60),
        3_600..86_400 => format!("modified {} h ago", secs / 3_600),
        _ => format!("modified {} d ago", secs / 86_400),
    };
    format!("{lines} · {ago}")
}

/// A file as the server answered for it.
#[derive(Clone, Debug)]
enum Read {
    Text(Arc<str>),
    Missing,
    Unavailable(String),
    /// A GitHub link's card: its header and lines.
    Card(String, Vec<String>),
}
impl Read {
    fn from(result: Result<Value, String>) -> (Self, Option<f64>) {
        match result {
            Ok(body) => match body["content"].as_str() {
                Some(content) if content.contains('\0') => (
                    Self::Unavailable("This binary file has no text preview.".into()),
                    None,
                ),
                Some(content) => (Self::Text(content.into()), body["mtimeMs"].as_f64()),
                None => (
                    Self::Unavailable(body["error"].as_str().unwrap_or("File unavailable").into()),
                    None,
                ),
            },
            Err(error) if error == "File not found" => (Self::Missing, None),
            Err(error) => (Self::Unavailable(error), None),
        }
    }
    fn snippet(&self, line: Option<usize>) -> Snippet {
        match self {
            Self::Text(content) => window(content, line),
            Self::Missing => Snippet::Missing,
            Self::Unavailable(error) => Snippet::Unavailable(error.clone()),
            Self::Card(_, lines) => Snippet::Preview(lines.clone()),
        }
    }
}

struct Entry {
    read: Read,
    mtime: Option<f64>,
    at: Instant,
}
/// Files peeked lately, by path, with the modified time they were read at.
#[derive(Default)]
struct Cache(HashMap<String, Entry>);
enum Lookup<'a> {
    /// Read lately enough to show without asking again.
    Fresh(&'a Read),
    /// Shown while a new read checks it.
    Stale(&'a Read),
    Miss,
}
impl Cache {
    fn lookup(&self, path: &str, now: Instant) -> Lookup<'_> {
        match self.0.get(path) {
            Some(entry) if now.duration_since(entry.at) < FRESH => Lookup::Fresh(&entry.read),
            Some(entry) => Lookup::Stale(&entry.read),
            None => Lookup::Miss,
        }
    }
    /// A file read again at the same modified time keeps the text it had.
    fn store(&mut self, path: String, read: Read, mtime: Option<f64>, now: Instant) {
        if let Some(entry) = self.0.get_mut(&path)
            && mtime.is_some()
            && entry.mtime == mtime
            && matches!((&entry.read, &read), (Read::Text(_), Read::Text(_)))
        {
            entry.at = now;
            return;
        }
        self.0.insert(
            path,
            Entry {
                read,
                mtime,
                at: now,
            },
        );
    }
}

/// The file pill a pointer rests on.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Target {
    /// The pill's element, unique in its transcript.
    pub key: String,
    pub root: String,
    pub path: String,
    pub line: Option<usize>,
    /// A sent mention's title and lines, shown instead of a file.
    pub preview: Option<(String, Vec<String>)>,
    /// A GitHub link, read for its card instead of a file.
    pub link: Option<String>,
}
impl Target {
    fn file(&self) -> String {
        match &self.link {
            Some(link) => link.clone(),
            None => format!("{}/{}", self.root.trim_end_matches('/'), self.path),
        }
    }
}

/// A github.com repository, issue or pull request link, the ones the server
/// can describe; any other link keeps its plain tooltip.
pub(crate) fn github_link(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://github.com/") else {
        return false;
    };
    let path = rest.split(['?', '#']).next().unwrap_or_default();
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    let name = |part: &str| {
        part.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
            && part.len() <= 100
            && part.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
    };
    let number = |part: &str| {
        part.len() <= 7 && !part.starts_with('0') && part.chars().all(|c| c.is_ascii_digit())
    };
    match parts.as_slice() {
        [owner, repo] => name(owner) && name(repo),
        [owner, repo, "issues", n] | [owner, repo, "pull", n] => {
            name(owner) && name(repo) && number(n)
        }
        [owner, repo, "pull", n, tab] => {
            name(owner) && name(repo) && number(n) && ["files", "commits", "checks"].contains(tab)
        }
        _ => false,
    }
}

/// Words laid into at most `rows` lines of `width` characters, the last cut
/// with an ellipsis when more is left.
fn wrap(text: &str, width: usize, rows: usize) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        if !current.is_empty() && current.chars().count() + 1 + word.chars().count() > width {
            lines.push(std::mem::take(&mut current));
            if lines.len() == rows {
                let last = lines.last_mut().expect("a line");
                let kept: String = last.chars().take(width.saturating_sub(1)).collect();
                *last = format!("{}…", kept.trim_end());
                return lines;
            }
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

fn plural(count: u64, one: &str) -> String {
    if count == 1 { format!("1 {one}") } else { format!("{count} {one}s") }
}

/// The card for the server's answer about a GitHub link.
pub(crate) fn link_card(body: &Value) -> Option<(String, Vec<String>)> {
    let preview = &body["preview"];
    let repo = preview["repo"].as_str()?;
    let count = |key: &str| preview[key].as_u64().unwrap_or(0);
    match preview["kind"].as_str()? {
        "repo" => {
            let mut lines = wrap(preview["description"].as_str().unwrap_or("No description"), 64, 2);
            let mut facts = vec![plural(count("stars"), "star"), plural(count("forks"), "fork")];
            facts.extend(preview["language"].as_str().map(str::to_owned));
            lines.push(facts.join(" · "));
            Some((format!("github.com/{repo}"), lines))
        }
        kind @ ("issue" | "pull") => {
            let what = if kind == "pull" { "pull request" } else { "issue" };
            let state = match preview["state"].as_str().unwrap_or("open") {
                "merged" => "Merged",
                "closed" => "Closed",
                _ => "Open",
            };
            let mut lines = wrap(preview["title"].as_str().unwrap_or_default(), 64, 2);
            let mut facts = vec![format!("{state} {what}")];
            facts.extend(preview["author"].as_str().map(|author| format!("by {author}")));
            facts.push(plural(count("comments"), "comment"));
            lines.push(facts.join(" · "));
            Some((format!("{repo} #{}", count("number")), lines))
        }
        _ => None,
    }
}
struct Hover {
    target: Target,
    open: bool,
    over_card: bool,
}
#[derive(Default)]
struct State {
    client: Option<Client>,
    cache: Cache,
    reading: HashSet<String>,
    hover: Option<Hover>,
    wait: u64,
}
/// One transcript's peeks: the server to read from, the files read, and the
/// pill being hovered. Rows share it the way they share images.
#[derive(Clone, Default)]
pub(crate) struct Peeks(Rc<RefCell<State>>);
impl Peeks {
    pub(crate) fn connect(&self, client: Client) {
        self.0.borrow_mut().client = Some(client);
    }
    /// The pointer came onto or left a pill; the card follows after a pause.
    pub(crate) fn hover(&self, target: Target, hovering: bool, window: &mut Window, cx: &mut App) {
        let wait = {
            let mut state = self.0.borrow_mut();
            let same = state
                .hover
                .as_ref()
                .is_some_and(|hover| hover.target.key == target.key);
            if !hovering && !same {
                return;
            }
            if !same {
                state.hover = Some(Hover {
                    target,
                    open: false,
                    over_card: false,
                });
            }
            state.wait += 1;
            state.wait
        };
        self.settle_after(wait, hovering, window, cx);
    }
    fn card_hover(&self, hovering: bool, window: &mut Window, cx: &mut App) {
        let wait = {
            let mut state = self.0.borrow_mut();
            let Some(hover) = state.hover.as_mut() else {
                return;
            };
            hover.over_card = hovering;
            state.wait += 1;
            state.wait
        };
        if !hovering {
            self.settle_after(wait, false, window, cx);
        }
    }
    #[cfg(test)]
    pub(crate) fn remember(&self, file: &str, content: &str) {
        let read = Read::Text(content.into());
        let mut state = self.0.borrow_mut();
        state.cache.store(file.into(), read, None, Instant::now());
    }
    /// A click opens the file, so the card gets out of the way.
    pub(crate) fn dismiss(&self) {
        let mut state = self.0.borrow_mut();
        state.hover = None;
        state.wait += 1;
    }
    fn settle_after(&self, wait: u64, hovering: bool, window: &mut Window, cx: &mut App) {
        let peeks = self.clone();
        let delay = if hovering { OPEN_DELAY } else { CLOSE_DELAY };
        window
            .spawn(cx, async move |cx| {
                cx.background_executor().timer(delay).await;
                let _ = cx.update(|window, cx| {
                    let mut state = peeks.0.borrow_mut();
                    if state.wait != wait {
                        return;
                    }
                    if hovering {
                        let Some(hover) = state.hover.as_mut() else {
                            return;
                        };
                        hover.open = true;
                        let target = hover.target.clone();
                        drop(state);
                        peeks.read(target, window, cx);
                    } else if state.hover.as_ref().is_some_and(|hover| !hover.over_card) {
                        state.hover = None;
                    }
                    window.refresh();
                });
            })
            .detach();
    }
    /// Reads the file unless it was read lately or a read is on its way.
    fn read(&self, target: Target, window: &mut Window, cx: &mut App) {
        if target.preview.is_some() {
            return;
        }
        let file = target.file();
        let client = {
            let mut state = self.0.borrow_mut();
            if matches!(state.cache.lookup(&file, Instant::now()), Lookup::Fresh(_))
                || !state.reading.insert(file.clone())
            {
                return;
            }
            state.client.clone()
        };
        let Some(client) = client else {
            let mut state = self.0.borrow_mut();
            state.reading.remove(&file);
            let read = Read::Unavailable("Not connected to a server.".into());
            state.cache.store(file, read, None, Instant::now());
            return;
        };
        let (root, path, link) = (target.root, target.path, target.link);
        let task = cx.background_executor().spawn(async move {
            match link {
                Some(link) => {
                    let answer = client.get::<Value>("/api/panel/link-preview", &[("url", &link)]);
                    let read = match answer.ok().as_ref().and_then(link_card) {
                        Some((title, lines)) => Read::Card(title, lines),
                        None => Read::Unavailable("No preview for this link.".into()),
                    };
                    (read, None)
                }
                None => Read::from(crate::files_panel::read_file(&client, &root, &path)),
            }
        });
        let peeks = self.clone();
        window
            .spawn(cx, async move |cx| {
                let (read, mtime) = task.await;
                let mut state = peeks.0.borrow_mut();
                state.reading.remove(&file);
                state.cache.store(file, read, mtime, Instant::now());
                drop(state);
                let _ = cx.update(|window, _| window.refresh());
            })
            .detach();
    }
    /// The open card for this pill, beside it inside the transcript's
    /// viewport. `pill` and `viewport` are window bounds.
    pub(crate) fn card(
        &self,
        key: &str,
        pill: Bounds<Pixels>,
        viewport: Bounds<Pixels>,
    ) -> Option<AnyElement> {
        let state = self.0.borrow();
        let hover = state
            .hover
            .as_ref()
            .filter(|hover| hover.open && hover.target.key == key)?;
        let target = &hover.target;
        let lookup = state.cache.lookup(&target.file(), Instant::now());
        let snippet = match (&target.preview, lookup) {
            (Some((_, lines)), _) => Some(Snippet::Preview(lines.clone())),
            (None, Lookup::Fresh(read) | Lookup::Stale(read)) => Some(read.snippet(target.line)),
            (None, Lookup::Miss) => None,
        };
        let note = match (&target.preview, state.cache.0.get(&target.file())) {
            (None, Some(Entry { read: Read::Text(content), mtime, .. })) => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0., |elapsed| elapsed.as_millis() as f64);
                Some(meta(content, *mtime, now))
            }
            _ => None,
        };
        let title = match state.cache.0.get(&target.file()) {
            Some(Entry { read: Read::Card(title, _), .. }) => Some(title.clone()),
            _ => None,
        };
        let at = place(pill, size(px(WIDTH), height(&snippet)), viewport);
        let peeks = self.clone();
        let card = card(target, title, snippet, note)
            .on_hover(move |hovering, window, cx| peeks.card_hover(*hovering, window, cx));
        Some(
            deferred(
                anchored()
                    .position_mode(AnchoredPositionMode::Window)
                    .position(at)
                    .snap_to_window_with_margin(px(MARGIN))
                    .child(card),
            )
            .with_priority(1)
            .into_any_element(),
        )
    }
}

/// How tall a card is for what it shows.
fn height(snippet: &Option<Snippet>) -> Pixels {
    let body = match snippet {
        Some(Snippet::Lines { lines, .. }) => 12. + LINE * lines.len() as f32,
        Some(Snippet::Preview(lines)) if !lines.is_empty() => 12. + LINE * lines.len() as f32,
        _ => NOTE,
    };
    px(2. + HEADER + body)
}

/// Where a card goes: below its pill when it fits in the viewport, above when
/// only that fits, otherwise on the roomier side. It stays inside the
/// viewport across, and down as far as its height allows.
pub(crate) fn place(
    pill: Bounds<Pixels>,
    card: Size<Pixels>,
    viewport: Bounds<Pixels>,
) -> Point<Pixels> {
    let (gap, margin) = (px(GAP), px(MARGIN));
    let below = viewport.bottom() - pill.bottom() - gap;
    let above = pill.top() - viewport.top() - gap;
    let y = if card.height <= below || below >= above {
        pill.bottom() + gap
    } else {
        pill.top() - gap - card.height
    };
    let x = pill
        .left()
        .min(viewport.right() - margin - card.width)
        .max(viewport.left() + margin);
    point(
        x,
        y.min(viewport.bottom() - card.height).max(viewport.top()),
    )
}

fn card(
    target: &Target,
    title: Option<String>,
    snippet: Option<Snippet>,
    note_text: Option<String>,
) -> gpui::Stateful<gpui::Div> {
    let at = target
        .line
        .map_or_else(String::new, |line| format!(":{line}"));
    let note = |text: String| {
        div()
            .h(px(NOTE))
            .flex()
            .items_center()
            .px(px(10.))
            .text_size(px(12.))
            .text_color(theme().text_muted)
            .child(text)
    };
    let tall = height(&snippet);
    let body = match snippet {
        None => note("Loading…".into()).into_any_element(),
        Some(Snippet::Missing) => note("File not found".into()).into_any_element(),
        Some(Snippet::Unavailable(error)) => note(error).into_any_element(),
        Some(Snippet::Preview(lines)) if lines.is_empty() => {
            note("Nothing more to show.".into()).into_any_element()
        }
        Some(Snippet::Preview(lines)) => div()
            .py(px(6.))
            .text_size(px(12.))
            .children(lines.into_iter().enumerate().map(|(index, text)| {
                div()
                    .debug_selector(move || format!("transcript-peek-preview-{index}"))
                    .h(px(LINE))
                    .px(px(10.))
                    .whitespace_nowrap()
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_color(theme().text)
                    .child(text)
            }))
            .into_any_element(),
        Some(Snippet::Lines { first, lines }) => div()
            .py(px(6.))
            .font_family(theme().font_mono)
            .text_size(px(12.))
            .children(lines.into_iter().enumerate().map(|(index, text)| {
                let number = first + index;
                div()
                    .debug_selector(move || format!("transcript-peek-line-{number}"))
                    .h(px(LINE))
                    .flex()
                    .items_center()
                    .px(px(10.))
                    .when(Some(number) == target.line, |row| row.bg(theme().selection))
                    .child(
                        div()
                            .w(px(40.))
                            .flex_shrink_0()
                            .text_color(theme().text_faint)
                            .child(number.to_string()),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .whitespace_nowrap()
                            .overflow_hidden()
                            .text_color(theme().text)
                            .child(text),
                    )
            }))
            .into_any_element(),
    };
    div()
        .id("transcript-peek")
        .debug_selector(|| "transcript-peek".into())
        .occlude()
        .w(px(WIDTH))
        .h(tall)
        .rounded(px(10.))
        .overflow_hidden()
        .flex()
        .flex_col()
        .bg(crate::theme::popover_background())
        .border_1()
        .border_color(theme().border)
        .shadow_lg()
        .child(
            div()
                .h(px(HEADER))
                .flex_shrink_0()
                .px(px(10.))
                .py(px(6.))
                .border_b_1()
                .border_color(theme().border)
                .flex()
                .items_center()
                .gap(px(8.))
                .text_size(px(11.5))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .whitespace_nowrap()
                        .overflow_hidden()
                        .text_ellipsis()
                        .text_color(theme().text_secondary)
                        .child(match (&target.preview, title, &target.link) {
                            (Some((title, _)), _, _) => title.clone(),
                            (None, Some(title), _) => title,
                            (None, None, Some(link)) => link.clone(),
                            (None, None, None) => format!("{}{at}", target.file()),
                        }),
                )
                .when_some(note_text, |header, note| {
                    header.child(
                        div()
                            .debug_selector(|| "transcript-peek-meta".into())
                            .flex_shrink_0()
                            .whitespace_nowrap()
                            .text_color(theme().text_faint)
                            .child(note),
                    )
                }),
        )
        .child(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numbered(count: usize) -> String {
        (1..=count).map(|n| format!("line {n}\n")).collect()
    }
    fn shown(snippet: Snippet) -> (usize, usize) {
        match snippet {
            Snippet::Lines { first, lines } => (first, first + lines.len() - 1),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_header_counts_lines_and_says_how_long_ago_the_file_changed() {
        let now = 1_000_000_000.;
        assert_eq!(meta("one", None, now), "1 line");
        assert_eq!(meta("a\nb\nc\n", Some(now - 20_000.), now), "3 lines · modified just now");
        assert_eq!(meta("a\nb", Some(now - 5. * 60_000.), now), "2 lines · modified 5 min ago");
        assert_eq!(meta("a\nb", Some(now - 3. * 3_600_000.), now), "2 lines · modified 3 h ago");
        assert_eq!(meta("a\nb", Some(now - 2. * 86_400_000.), now), "2 lines · modified 2 d ago");
        // A clock behind the file's time reads as just now, never negative.
        assert_eq!(meta("a", Some(now + 5_000.), now), "1 line · modified just now");
    }

    #[test]
    fn a_peek_shows_about_eight_lines_around_the_named_one() {
        let file = numbered(100);
        assert_eq!(shown(window(&file, Some(50))), (47, 54));
        assert_eq!(shown(window(&file, None)), (1, 8));
        assert_eq!(shown(window(&file, Some(2))), (1, 8), "kept inside the top");
        assert_eq!(shown(window(&file, Some(100))), (93, 100), "and the end");
        assert_eq!(shown(window(&file, Some(900))), (93, 100), "past the end");
        assert_eq!(shown(window(&numbered(3), Some(2))), (1, 3), "a short file");
        let Snippet::Lines { lines, .. } = window(&file, Some(50)) else {
            unreachable!()
        };
        assert_eq!(lines[3], "line 50");
        assert_eq!(
            window("", Some(4)),
            Snippet::Lines {
                first: 1,
                lines: vec![]
            }
        );
    }

    #[test]
    fn a_card_goes_where_the_viewport_has_room() {
        let bounds =
            |x: f32, y: f32, w: f32, h: f32| Bounds::new(point(px(x), px(y)), size(px(w), px(h)));
        let viewport = bounds(100., 50., 600., 500.);
        let card = size(px(440.), px(184.));
        let pill = |x, y| bounds(x, y, 80., 20.);
        // Room below: just under the pill.
        assert_eq!(
            place(pill(150., 100.), card, viewport),
            point(px(150.), px(124.))
        );
        // Near the bottom: above it, clear of the pill.
        assert_eq!(
            place(pill(150., 480.), card, viewport),
            point(px(150.), px(292.))
        );
        // Kept inside across, on both sides.
        assert_eq!(place(pill(600., 100.), card, viewport).x, px(252.));
        assert_eq!(place(pill(40., 100.), card, viewport).x, px(108.));
        // Room on neither side: the roomier one, inside the viewport.
        let short = bounds(100., 50., 600., 300.);
        let at = place(pill(150., 160.), card, short);
        assert_eq!(
            at.y,
            px(166.),
            "below, lifted to end at the viewport's bottom"
        );
        assert_eq!(
            place(pill(150., 210.), card, short).y,
            px(50.),
            "above, from its top"
        );
    }

    #[test]
    fn only_github_repository_issue_and_pull_request_links_get_a_card() {
        for url in [
            "https://github.com/o8-run/o8",
            "https://github.com/o8-run/o8/",
            "https://github.com/o8-run/o8/issues/12",
            "https://github.com/o8-run/o8/pull/6261",
            "https://github.com/o8-run/o8/pull/6261/files",
            "https://github.com/o8-run/o8/issues/12#issuecomment-1",
        ] {
            assert!(github_link(url), "{url}");
        }
        for url in [
            "http://github.com/o8-run/o8",
            "https://github.com.evil.test/o8-run/o8",
            "https://gist.github.com/a/b",
            "https://github.com/o8-run",
            "https://github.com/o8-run/o8/blob/main/README.md",
            "https://github.com/o8-run/o8/issues/0",
            "https://github.com/o8-run/o8/issues/12/x",
            "https://github.com/../o8",
            "https://example.com/o8-run/o8",
        ] {
            assert!(!github_link(url), "{url}");
        }
    }

    #[test]
    fn a_github_card_names_the_repository_and_its_facts() {
        let repo = serde_json::json!({"ok": true, "preview": {
            "kind": "repo", "repo": "o8-run/o8", "description": "Review and merge layer",
            "stars": 60, "forks": 1, "language": "TypeScript"}});
        assert_eq!(
            link_card(&repo),
            Some((
                "github.com/o8-run/o8".into(),
                vec!["Review and merge layer".into(), "60 stars · 1 fork · TypeScript".into()]
            ))
        );
        let pull = serde_json::json!({"ok": true, "preview": {
            "kind": "pull", "repo": "o8-run/o8", "number": 6261, "title": "Install with Homebrew",
            "state": "merged", "author": "q", "comments": 1}});
        assert_eq!(
            link_card(&pull),
            Some((
                "o8-run/o8 #6261".into(),
                vec!["Install with Homebrew".into(), "Merged pull request · by q · 1 comment".into()]
            ))
        );
        let issue = serde_json::json!({"preview": {"kind": "issue", "repo": "a/b", "number": 2,
            "title": "x", "state": "closed", "author": null, "comments": 0}});
        assert_eq!(link_card(&issue).unwrap().1[1], "Closed issue · 0 comments");
        assert_eq!(link_card(&serde_json::json!({"ok": false})), None);
    }

    #[test]
    fn long_descriptions_wrap_to_two_lines_and_end_cut() {
        let text = "word ".repeat(40);
        let lines = wrap(&text, 20, 2);
        assert_eq!(lines.len(), 2);
        assert!(lines.iter().all(|line| line.chars().count() <= 20), "{lines:?}");
        assert!(lines[1].ends_with('…'));
        assert_eq!(wrap("short one", 20, 2), vec!["short one"]);
        assert!(wrap("", 20, 2).is_empty());
    }

    #[test]
    fn a_missing_file_peeks_as_not_found() {
        let (read, _) = Read::from(Err("File not found".into()));
        assert_eq!(read.snippet(Some(3)), Snippet::Missing);
        let (read, _) = Read::from(Err("Could not reach the selected server.".into()));
        assert_eq!(
            read.snippet(None),
            Snippet::Unavailable("Could not reach the selected server.".into())
        );
        let (read, _) = Read::from(Ok(serde_json::json!({"content": "a\0b"})));
        assert!(matches!(read.snippet(None), Snippet::Unavailable(_)));
    }

    #[test]
    fn a_file_read_lately_peeks_again_without_a_read() {
        let mut cache = Cache::default();
        let now = Instant::now();
        assert!(matches!(cache.lookup("/r/a.rs", now), Lookup::Miss));
        let (read, mtime) = Read::from(Ok(serde_json::json!({"content": "x", "mtimeMs": 5.0})));
        cache.store("/r/a.rs".into(), read, mtime, now);
        assert!(matches!(
            cache.lookup("/r/a.rs", now + Duration::from_secs(1)),
            Lookup::Fresh(Read::Text(text)) if &**text == "x"
        ));
        assert!(matches!(cache.lookup("/r/b.rs", now), Lookup::Miss));
        let later = now + FRESH;
        assert!(matches!(cache.lookup("/r/a.rs", later), Lookup::Stale(_)));
        // The same modified time keeps the text it had; a new one replaces it.
        let kept = |cache: &Cache| match cache.lookup("/r/a.rs", later) {
            Lookup::Fresh(Read::Text(text)) => text.to_string(),
            _ => panic!("fresh after a read"),
        };
        cache.store("/r/a.rs".into(), Read::Text("y".into()), Some(5.0), later);
        assert_eq!(kept(&cache), "x");
        cache.store("/r/a.rs".into(), Read::Text("z".into()), Some(6.0), later);
        assert_eq!(kept(&cache), "z");
    }
}
