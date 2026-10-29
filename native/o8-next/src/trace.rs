//! The thinking trace: a turn's reasoning and tool steps as one quiet timeline
//! on a hairline rail. The live step shimmers under a spinning arc, new steps
//! rise in, finished steps settle to past tense, and the header counts the
//! seconds until it reads "Thought for Ns". Shell text is never executed.
use crate::{
    activity::{Part, Step, summary},
    model::Trace,
    motion::{ease_out, mix},
    retained::RowState,
    theme::current as theme,
};
use gpui::{
    AnyElement, App, Bounds, HighlightStyle, PathBuilder, Pixels, Rgba, StyledText, Transformation,
    Window, canvas, div, point, prelude::*, px, radians,
};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    time::{Duration, Instant},
};

/// Measured from the reference at the transcript's 13px body size.
const ROW: f32 = 30.;
const RAIL_X: f32 = 9.;
const BRANCH_X: f32 = 24.;
const TEXT_X: f32 = 38.;
const CHIPS: f32 = 30.;
const APPEAR: Duration = Duration::from_millis(260);
const SWAP: Duration = Duration::from_millis(160);
const SLIDE: Duration = Duration::from_millis(300);
const STAGGER: Duration = Duration::from_millis(70);
const SHIMMER: f32 = 1.15;
const SPIN: f32 = 0.9;
const MAX_CHIPS: usize = 4;

const SEARCH: &str = "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z M16 16l4.5 4.5";
const CHEVRON_DOWN: &str = "m6 9 6 6 6-6";
const CHEVRON_RIGHT: &str = "m9 6 6 6-6 6";
const CROSS: &str = "M7 7l10 10M17 7 7 17";
const CHECK: &str = "m7.5 12.5 3 3 6-7";
// About 200 degrees of a ring, turned while the step runs.
const ARC: &str = "M12 3A9 9 0 1 1 8.92 20.46";
const GLOBE: &str = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M3 12h18 M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z";
const ATOM: &str = "M12 10.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z M12 7.5c4.7 0 8.5 2 8.5 4.5s-3.8 4.5-8.5 4.5-8.5-2-8.5-4.5 3.8-4.5 8.5-4.5Z M8.1 9.8c2.4-4.1 5.9-6.4 8.1-5.2 2.2 1.3 1.9 5.5-.4 9.6-2.4 4.1-5.9 6.4-8.1 5.2-2.2-1.3-1.9-5.5.4-9.6Z M15.9 9.8c2.4 4.1 2.6 8.3.4 9.6-2.2 1.2-5.7-1.1-8.1-5.2-2.3-4.1-2.6-8.3-.4-9.6 2.2-1.2 5.7 1.1 8.1 5.2Z";

thread_local! {
    /// When each trace and line was first drawn, so only new lines animate.
    static SEEN: RefCell<HashMap<String, Instant>> = RefCell::default();
    /// Start and end, epoch ms, of traces this window watched while live.
    static CLOCKS: RefCell<HashMap<String, (f64, Option<f64>)>> = RefCell::default();
    /// The trace column's inner width as last painted, for fitting chips.
    static COLUMN: Cell<Option<f32>> = const { Cell::new(None) };
}

/// Notes a trace's start and end as rows install, whether or not it is on screen.
pub fn note(row: &crate::model::Row) {
    if let crate::model::Row::Activity { id, trace, .. } = row {
        clock(id, trace, now_ms());
    }
}

/// Saved turns carry when they started but not when they settled, so a trace
/// watched live notes the moment it stopped and keeps that duration.
fn clock(id: &str, trace: &Trace, now: f64) -> Trace {
    CLOCKS.with(|clocks| {
        let mut clocks = clocks.borrow_mut();
        let mut timed = trace.clone();
        if trace.live {
            let (start, end) = clocks
                .entry(id.to_owned())
                .or_insert((trace.started.unwrap_or(now), None));
            *end = None;
            timed.started = Some(*start);
        } else if let Some((start, end)) = clocks.get_mut(id) {
            let end = *end.get_or_insert(now);
            timed.started = Some(*start);
            timed.ended = Some(trace.ended.filter(|e| *e > *start + 1000.).unwrap_or(end));
        }
        timed
    })
}

/// First sight of `key`; a key first drawn with an already-known trace animates,
/// the rest of a freshly loaded trace starts settled.
fn seen(key: &str, settled: bool) -> Instant {
    SEEN.with(|seen| {
        *seen.borrow_mut().entry(key.to_owned()).or_insert_with(|| {
            let now = Instant::now();
            if settled {
                now.checked_sub(Duration::from_secs(5)).unwrap_or(now)
            } else {
                now
            }
        })
    })
}

fn progress(since: Instant, length: Duration) -> f32 {
    ease_out((since.elapsed().as_secs_f32() / length.as_secs_f32()).min(1.))
}

/// An eased value's height, softened at the start so a row's first frame does
/// not shove the rows under it.
fn smooth(t: f32) -> f32 {
    t * t * (3. - 2. * t)
}

/// Progress that waits `delay` before it starts, for staggered arrivals.
fn progress_after(since: Instant, delay: Duration, length: Duration) -> f32 {
    let elapsed = since.elapsed().saturating_sub(delay);
    ease_out((elapsed.as_secs_f32() / length.as_secs_f32()).min(1.))
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Icon {
    Search,
    Dot,
    Ring,
    Cross,
    Check,
    Globe,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Tone {
    Primary,
    Secondary,
    Muted,
}

/// Where a line sits: on the main rail, on a dashed dead-end branch, on a
/// solid branch with work that ran at the same time, or where that branch
/// rejoins the rail.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Rail {
    Main,
    Dead,
    Fork { first: bool, last: bool },
    Join,
}

#[derive(Debug)]
struct Chip {
    label: String,
    badge: Badge,
}

#[derive(Clone, Copy, Debug)]
enum Badge {
    Text(&'static str, u32),
    Glyph(&'static str, u32),
    None,
}

struct Line {
    key: String,
    rail: Rail,
    icon: Icon,
    label: String,
    detail: Option<String>,
    tone: Tone,
    live: bool,
    chips: Vec<Chip>,
    more: usize,
}

fn noun(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

fn short(text: &str, limit: usize) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    if line.chars().count() > limit {
        format!("{}…", line.chars().take(limit).collect::<String>())
    } else {
        line.to_owned()
    }
}

fn quoted(text: &str, limit: usize) -> String {
    format!("\"{}\"", short(text, limit))
}

fn badge(name: &str) -> Badge {
    let extension = name.rsplit_once('.').map(|(_, e)| e.to_lowercase());
    let marks = &crate::theme::FILE_MARKS;
    match extension.as_deref() {
        Some("ts" | "mts" | "cts") => Badge::Text("TS", marks.typescript),
        Some("tsx" | "jsx") => Badge::Glyph(ATOM, marks.typescript),
        Some("js" | "mjs" | "cjs") => Badge::Text("JS", marks.javascript),
        Some("rs") => Badge::Text("RS", marks.rust),
        Some("py") => Badge::Text("PY", marks.python),
        Some("go") => Badge::Text("GO", marks.go),
        Some("md" | "mdx") => Badge::Text("MD", marks.neutral),
        Some("json" | "toml" | "yaml" | "yml") => Badge::Text("{}", marks.neutral),
        Some("css" | "scss") => Badge::Text("CSS", marks.css),
        Some("swift") => Badge::Text("SW", marks.swift),
        _ => Badge::None,
    }
}

fn name(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
}

fn segments(path: &str) -> Vec<&str> {
    path.split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect()
}

/// A path's last two folders, or nothing for the repository root and home
/// folders, which say nothing and can carry a user name.
fn place(path: &str) -> Option<String> {
    let parts = segments(path);
    if parts.is_empty() || path.starts_with('/') && parts.len() <= 3 {
        return None;
    }
    Some(parts[parts.len().saturating_sub(2)..].join("/"))
}

/// The folder a set of files shares, worded like `place`.
fn folder(paths: &[&str]) -> Option<String> {
    let dirs: Vec<Vec<&str>> = paths
        .iter()
        .map(|path| {
            let mut parts = segments(path);
            parts.pop();
            parts
        })
        .collect();
    let first = dirs.first()?;
    let common = (0..first.len())
        .take_while(|&i| dirs.iter().all(|dir| dir.get(i) == first.get(i)))
        .count();
    let absolute = paths.first().is_some_and(|p| p.starts_with('/'));
    if common == 0 || absolute && common <= 3 {
        return None;
    }
    Some(first[common.saturating_sub(2)..common].join("/"))
}

/// A page's title when it has a real one, otherwise its site and last path part.
fn page(url: &str, title: Option<&str>) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let mut parts = rest.split('/').filter(|s| !s.is_empty());
    let host = parts.next().unwrap_or(rest).trim_start_matches("www.");
    let title = title
        .map(|t| t.trim().trim_start_matches('#').trim())
        .filter(|t| !t.is_empty() && *t != host && (t.contains(' ') || !t.contains('.')));
    let label = match (title, parts.last()) {
        (Some(title), _) => title.to_owned(),
        (None, Some(last)) => {
            let last = [".html", ".htm", ".md"]
                .iter()
                .find_map(|ext| last.strip_suffix(ext))
                .unwrap_or(last);
            format!("{host} · {last}")
        }
        (None, None) => host.to_owned(),
    };
    short(&label, 26)
}

fn chip_list(labels: Vec<(String, Badge)>) -> (Vec<Chip>, usize) {
    let mut unique: Vec<(String, Badge)> = vec![];
    for (label, badge) in labels {
        if !label.is_empty() && !unique.iter().any(|(known, _)| *known == label) {
            unique.push((label, badge));
        }
    }
    let more = unique.len().saturating_sub(MAX_CHIPS);
    unique.truncate(MAX_CHIPS);
    (
        unique
            .into_iter()
            .map(|(label, badge)| Chip { label, badge })
            .collect(),
        more,
    )
}

fn file_chips<'a>(paths: impl Iterator<Item = &'a str>) -> Vec<(String, Badge)> {
    paths
        .map(|path| (name(path).to_owned(), badge(name(path))))
        .collect()
}

/// One command's worth of a step, with that step's outcome.
struct Atom<'a> {
    step: &'a Step,
    part: Part,
    failed: bool,
    running: bool,
}

impl Atom<'_> {
    fn subject(&self) -> Option<&str> {
        self.part.subject.as_deref()
    }
}

fn atoms(steps: &[Step], live: bool) -> Vec<Atom<'_>> {
    let mut out = vec![];
    for step in steps {
        let parts = if step.parts.is_empty() {
            vec![Part {
                key: step.group_key.clone(),
                subject: step.subject.clone(),
                scope: None,
                text: step.command.clone(),
            }]
        } else {
            step.parts.clone()
        };
        let count = parts.len();
        let failed = matches!(step.status.as_str(), "failed" | "stopped");
        for (index, part) in parts.into_iter().enumerate() {
            out.push(Atom {
                step,
                part,
                // A chained line stops at the command that failed, the last one we know.
                failed: failed && index + 1 == count,
                running: live && step.status == "running",
            });
        }
    }
    out
}

/// Kinds that read as one line with chips even when they ran at the same time.
fn filelike(key: &str) -> bool {
    matches!(key, "read" | "edit" | "web-read" | "list")
}

fn shell_like(key: &str) -> bool {
    key.starts_with("command:")
        || key.starts_with("git:")
        || matches!(key, "test" | "typecheck" | "lint")
}

/// What a command was, in a few words.
fn command(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    match words.as_slice() {
        ["node", "-e" | "--eval" | "-p", ..] => "a Node script".into(),
        ["python" | "python3", "-c", ..] => "a Python script".into(),
        _ => short(text, 48),
    }
}

/// Why a step failed: the first line of its output that is not a bare exit code.
fn reason(text: &str) -> Option<String> {
    let lines: Vec<String> = text
        .lines()
        .take(20)
        .map(|line| {
            line.replace("<tool_use_error>", "")
                .replace("</tool_use_error>", "")
                .trim()
                .to_owned()
        })
        .filter(|line| !line.is_empty())
        .collect();
    let exit = |line: &&String| {
        line.strip_prefix("Exit code ")
            .is_some_and(|n| n.chars().all(|c| c.is_ascii_digit()))
    };
    lines
        .iter()
        .find(|line| !exit(line))
        .or(lines.first())
        .map(|line| short(line, 48))
}

/// The words, icon and chips for a run of like work. `count` is (done, total)
/// for files that are being read at the same time.
fn phrase(
    atoms: &[&Atom],
    running: bool,
    count: Option<(usize, usize)>,
    titles: &HashMap<String, String>,
) -> (Icon, String, Vec<Chip>, usize) {
    let first = atoms[0];
    let key = first.part.key.as_str();
    let verb = |live: &str, done: &str| if running { live } else { done }.to_owned();
    let subjects: Vec<&str> = {
        let mut seen: Vec<&str> = vec![];
        for subject in atoms.iter().filter_map(|a| a.subject()) {
            if !seen.contains(&subject) {
                seen.push(subject);
            }
        }
        seen
    };
    let total = if subjects.is_empty() {
        atoms.len()
    } else {
        subjects.len()
    };
    let many = total > 1;
    let counted = |one: &str, many_word: &str| match count {
        Some((done, total)) if running => {
            format!("{} of {total} {many_word}", (done + 1).min(total))
        }
        _ => noun(total, one, many_word),
    };
    let none = (vec![], 0);
    let (icon, label, (chips, more)) = match key {
        "search" => {
            let label = match (first.subject(), first.part.scope.as_deref().and_then(place)) {
                (Some(_), _) if atoms.len() > 1 => {
                    verb("Searching the codebase", "Searched the codebase")
                }
                (Some(pattern), Some(place)) => format!(
                    "{} {place} for {}",
                    verb("Searching", "Searched"),
                    quoted(pattern, 28)
                ),
                (Some(pattern), None) => format!(
                    "{} for {}",
                    verb("Searching the codebase", "Searched the codebase"),
                    quoted(pattern, 28)
                ),
                (None, _) => verb("Searching the codebase", "Searched the codebase"),
            };
            let found = atoms
                .iter()
                .flat_map(|a| a.step.found.iter().map(String::as_str));
            (Icon::Search, label, chip_list(file_chips(found)))
        }
        "web-search" => {
            let label = match first.subject() {
                Some(query) if atoms.len() == 1 => format!(
                    "{} for {}",
                    verb("Searching the web", "Searched the web"),
                    quoted(query, 36)
                ),
                _ => verb("Searching the web", "Searched the web"),
            };
            let links = atoms.iter().flat_map(|a| a.step.links.iter());
            let chips = links
                .map(|(title, url)| (page(url, Some(title)), Badge::Glyph(GLOBE, crate::theme::FILE_MARKS.neutral)))
                .collect();
            (Icon::Globe, label, chip_list(chips))
        }
        "web-read" => {
            let label = if many || count.is_some() {
                format!("{} {}", verb("Reading", "Read"), counted("page", "pages"))
            } else {
                verb("Reading a page", "Read a page")
            };
            let chips = subjects
                .iter()
                .map(|url| {
                    (
                        page(url, titles.get(*url).map(String::as_str)),
                        Badge::Glyph(GLOBE, crate::theme::FILE_MARKS.neutral),
                    )
                })
                .collect();
            (Icon::Globe, label, chip_list(chips))
        }
        "read" | "edit" => {
            let (live, done) = if key == "read" {
                ("Reading", "Read")
            } else {
                ("Editing", "Edited")
            };
            if many || count.is_some() {
                let place = folder(&subjects)
                    .map(|place| format!(" in {place}"))
                    .unwrap_or_default();
                (
                    Icon::Dot,
                    format!("{} {}{place}", verb(live, done), counted("file", "files")),
                    chip_list(file_chips(subjects.iter().copied())),
                )
            } else {
                let label = match subjects.first() {
                    Some(path) => format!("{} {}", verb(live, done), name(path)),
                    None => format!("{} a file", verb(live, done)),
                };
                (Icon::Dot, label, none)
            }
        }
        "list" => match first.subject() {
            Some(pattern) if pattern.contains('*') => (
                Icon::Search,
                format!(
                    "{} {}",
                    verb("Finding files matching", "Found files matching"),
                    quoted(pattern, 28)
                ),
                chip_list(file_chips(
                    atoms
                        .iter()
                        .flat_map(|a| a.step.found.iter().map(String::as_str)),
                )),
            ),
            _ if many => (
                Icon::Dot,
                format!(
                    "{} {}",
                    verb("Listing", "Listed"),
                    counted("folder", "folders")
                ),
                chip_list(
                    subjects
                        .iter()
                        .map(|dir| (name(dir).to_owned(), Badge::None))
                        .collect(),
                ),
            ),
            Some(dir) => (
                Icon::Dot,
                match place(dir) {
                    Some(place) => format!("{} {place}", verb("Listing", "Listed")),
                    None => verb("Listing the folder", "Listed the folder"),
                },
                none,
            ),
            None => (
                Icon::Dot,
                verb("Listing the folder", "Listed the folder"),
                none,
            ),
        },
        "test" | "typecheck" | "lint" => (
            Icon::Dot,
            format!("{} {}", verb("Running", "Ran"), command(&first.part.text)),
            none,
        ),
        "git:diff" => (Icon::Dot, verb("Reading the diff", "Read the diff"), none),
        "git:status" => (
            Icon::Dot,
            verb("Checking git status", "Checked git status"),
            none,
        ),
        "git:log" => (
            Icon::Dot,
            verb("Reading git history", "Read git history"),
            none,
        ),
        "plan" => (
            Icon::Dot,
            verb("Updating the plan", "Updated the plan"),
            none,
        ),
        "agent" => (
            Icon::Dot,
            match first.subject() {
                Some(task) => format!("{}: {}", verb("Delegating", "Delegated"), short(task, 48)),
                None => verb("Delegating to a subagent", "Delegated to a subagent"),
            },
            none,
        ),
        _ if atoms.len() == 1 => (
            Icon::Dot,
            format!("{} {}", verb("Running", "Ran"), command(&first.part.text)),
            none,
        ),
        _ => (
            Icon::Dot,
            format!(
                "{} {}",
                verb("Running", "Ran"),
                noun(atoms.len(), "command", "commands")
            ),
            none,
        ),
    };
    (icon, label, chips, more)
}

/// A step that failed, worded as what was tried and why it stopped.
fn dead_end(atom: &Atom, titles: &HashMap<String, String>) -> (String, Option<String>) {
    let tried = if shell_like(&atom.part.key) || atom.step.parts.len() > 1 {
        short(&atom.part.text, 56)
    } else {
        let (_, label, _, _) = phrase(&[atom], false, None, titles);
        let mut chars = label.chars();
        chars
            .next()
            .map(|c| c.to_lowercase().chain(chars).collect())
            .unwrap_or_default()
    };
    (
        format!("Dead end: {tried}"),
        atom.step.reason.as_deref().and_then(reason),
    )
}

/// What a trace did, counted by kind: "2 searches · 2 pages · 3 files read".
fn tally(steps: &[Step]) -> String {
    let atoms = atoms(steps, false);
    let count = |keys: &[&str]| {
        atoms
            .iter()
            .filter(|a| keys.contains(&a.part.key.as_str()))
            .count()
    };
    let files = |key: &str| {
        let mut seen: Vec<&str> = vec![];
        let mut unnamed = 0;
        for atom in atoms.iter().filter(|a| a.part.key == key) {
            match atom.subject() {
                Some(subject) if !seen.contains(&subject) => seen.push(subject),
                Some(_) => {}
                None => unnamed += 1,
            }
        }
        seen.len() + unnamed
    };
    let searches = count(&["search", "web-search"]);
    let pages = count(&["web-read"]);
    let (read, edited) = (files("read"), files("edit"));
    let quiet = count(&["list", "plan", "agent"]);
    let commands = atoms.len() - searches - pages - count(&["read"]) - count(&["edit"]) - quiet;
    let failed = steps
        .iter()
        .filter(|s| matches!(s.status.as_str(), "failed" | "stopped"))
        .count();
    let parts: Vec<String> = [
        (searches, noun(searches, "search", "searches")),
        (pages, noun(pages, "page", "pages")),
        (read, format!("{} read", noun(read, "file", "files"))),
        (edited, format!("{} edited", noun(edited, "file", "files"))),
        (commands, noun(commands, "command", "commands")),
        (failed, format!("{failed} failed")),
    ]
    .into_iter()
    .filter(|(n, _)| *n > 0)
    .map(|(_, text)| text)
    .collect();
    if parts.is_empty() {
        summary(steps)
    } else {
        parts.join(" · ")
    }
}

/// Which chips fit the reading column, in order, skipping any too wide for
/// what is left, and how many the "+N more" covers.
fn fit(chips: &[Chip], more: usize, width: f32) -> (Vec<usize>, usize) {
    let estimate = |chip: &Chip| {
        let badge = match chip.badge {
            Badge::Text(text, _) => 5. + 7. * text.len() as f32,
            Badge::Glyph(..) => 18.,
            Badge::None => 0.,
        };
        18. + badge + 6.6 * chip.label.chars().count() as f32 + 6.
    };
    let tail = 64.;
    let mut used = 0.;
    let mut shown = vec![];
    for (index, chip) in chips.iter().enumerate() {
        if shown.is_empty() || used + estimate(chip) + tail <= width {
            used += estimate(chip);
            shown.push(index);
        }
    }
    let hidden = chips.len() - shown.len() + more;
    (shown, hidden)
}

/// One line per run of like work, worded as the work it did. Work that ran at
/// the same time branches off the rail and rejoins it when it is done.
fn lines(steps: &[Step], trace: &Trace) -> Vec<Line> {
    let atoms = atoms(steps, trace.live);
    let titles: HashMap<String, String> = steps
        .iter()
        .flat_map(|step| step.links.iter())
        .map(|(title, url)| (url.clone(), title.clone()))
        .collect();
    let batch = |atom: &Atom| {
        atom.step
            .batch
            .as_deref()
            .filter(|b| {
                steps
                    .iter()
                    .filter(|s| s.batch.as_deref() == Some(*b))
                    .count()
                    > 1
            })
            .map(str::to_owned)
    };
    let mut out = vec![];
    let mut index = 0;
    let mut item = 0;
    while index < atoms.len() {
        let key = format!("g{item}");
        item += 1;
        let first = &atoms[index];
        if let Some(shared) = batch(first) {
            let mut end = index;
            while end < atoms.len() && batch(&atoms[end]).as_deref() == Some(shared.as_str()) {
                end += 1;
            }
            let group: Vec<&Atom> = atoms[index..end].iter().collect();
            index = end;
            let running = group.iter().any(|a| a.running);
            let same = group
                .iter()
                .all(|a| a.part.key == group[0].part.key && !a.failed);
            if same && filelike(&group[0].part.key) {
                let total = group.len();
                let done = group.iter().filter(|a| !a.running).count();
                let (icon, label, chips, more) =
                    phrase(&group, running, running.then_some((done, total)), &titles);
                out.push(Line {
                    key,
                    rail: Rail::Main,
                    icon,
                    label,
                    detail: None,
                    tone: if running {
                        Tone::Primary
                    } else {
                        Tone::Secondary
                    },
                    live: running,
                    chips,
                    more,
                });
                continue;
            }
            let count = group.len();
            for (position, atom) in group.iter().enumerate() {
                let rail = Rail::Fork {
                    first: position == 0,
                    last: position + 1 == count,
                };
                let line_key = format!("{key}:{position}");
                if atom.failed {
                    let (label, detail) = dead_end(atom, &titles);
                    out.push(Line {
                        key: line_key,
                        rail,
                        icon: Icon::Cross,
                        label,
                        detail,
                        tone: Tone::Muted,
                        live: false,
                        chips: vec![],
                        more: 0,
                    });
                } else {
                    let (_, label, chips, more) = phrase(&[atom], atom.running, None, &titles);
                    out.push(Line {
                        key: line_key,
                        rail,
                        icon: Icon::Dot,
                        label,
                        detail: None,
                        tone: if atom.running {
                            Tone::Primary
                        } else {
                            Tone::Muted
                        },
                        live: atom.running,
                        chips,
                        more,
                    });
                }
            }
            if !running {
                out.push(Line {
                    key: format!("{key}:join"),
                    rail: Rail::Join,
                    icon: Icon::Ring,
                    label: "Merged the results".into(),
                    detail: Some(format!("{count} at once")),
                    tone: Tone::Secondary,
                    live: false,
                    chips: vec![],
                    more: 0,
                });
            }
            continue;
        }
        if first.failed {
            index += 1;
            let (label, detail) = dead_end(first, &titles);
            out.push(Line {
                key,
                rail: Rail::Dead,
                icon: Icon::Cross,
                label,
                detail,
                tone: Tone::Muted,
                live: false,
                chips: vec![],
                more: 0,
            });
            continue;
        }
        let mut end = index + 1;
        while end < atoms.len()
            && !atoms[end].failed
            && atoms[end].part.key == first.part.key
            && batch(&atoms[end]).is_none()
        {
            end += 1;
        }
        let group: Vec<&Atom> = atoms[index..end].iter().collect();
        index = end;
        let running = group.iter().any(|a| a.running);
        let (icon, label, chips, more) = phrase(&group, running, None, &titles);
        out.push(Line {
            key,
            rail: Rail::Main,
            icon,
            label,
            detail: None,
            tone: if running {
                Tone::Primary
            } else {
                Tone::Secondary
            },
            live: running,
            chips,
            more,
        });
    }
    if !trace.live && !steps.is_empty() {
        let timed = trace
            .started
            .zip(trace.ended)
            .is_some_and(|(s, e)| e - s >= 1000.);
        out.push(Line {
            key: "done".into(),
            rail: Rail::Main,
            icon: Icon::Check,
            label: if trace.thinking {
                "Finished thinking".into()
            } else {
                "Finished".into()
            },
            detail: timed.then(|| tally(steps)),
            tone: Tone::Primary,
            live: false,
            chips: vec![],
            more: 0,
        });
    }
    out
}

fn seconds(ms: f64) -> String {
    let total = (ms / 1000.).round().max(0.) as u64;
    if total < 60 {
        format!("{total}s")
    } else {
        format!("{}m {}s", total / 60, total % 60)
    }
}

/// The header: "Thinking" with its running seconds, then how long it took.
fn title(steps: &[Step], trace: &Trace, now: f64) -> (String, Option<String>) {
    if trace.live {
        let elapsed = trace.started.map(|start| seconds(now - start));
        return ("Thinking".into(), elapsed);
    }
    let elapsed = match (trace.started, trace.ended) {
        (Some(start), Some(end)) => end - start,
        _ => 0.,
    };
    let title = if elapsed >= 1000. {
        let verb = if trace.thinking { "Thought" } else { "Worked" };
        format!("{verb} for {}", seconds(elapsed))
    } else if steps.is_empty() {
        "Thought briefly".into()
    } else {
        tally(steps)
    };
    (title, None)
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0., |d| d.as_millis() as f64)
}

/// A lighter band sweeps left to right across live text about once a second.
fn shimmer(text: &str, base: Rgba, light: Rgba, clock: f32) -> StyledText {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let length = chars.len() as f32;
    let band = 7.;
    let cycle = (clock % SHIMMER) / SHIMMER;
    let centre = -band + cycle * (length + band * 2.);
    let highlights = chars.iter().enumerate().map(|(i, (start, c))| {
        let distance = ((i as f32) - centre).abs();
        let amount = (1. - distance / band).max(0.);
        let eased = amount * amount * (3. - 2. * amount);
        (
            *start..start + c.len_utf8(),
            HighlightStyle {
                color: Some(mix(base, light, eased * 0.85).into()),
                ..Default::default()
            },
        )
    });
    StyledText::new(text.to_owned()).with_highlights(highlights.collect::<Vec<_>>())
}

fn tone(tone: Tone) -> Rgba {
    match tone {
        Tone::Primary => theme().text,
        Tone::Secondary => theme().text_secondary,
        Tone::Muted => theme().text_muted,
    }
}

fn rail_color() -> Rgba {
    Rgba {
        a: theme().text_muted.a * 0.45,
        ..theme().text_muted
    }
}

/// The icon in the rail; a live step's icon sits inside a turning arc.
fn icon(line: &Line, clock: f32) -> AnyElement {
    let muted = theme().text_muted;
    let branch = matches!(line.rail, Rail::Dead | Rail::Fork { .. });
    let glyph = |path: &'static str, color: Rgba, size: f32, weight: f32| {
        crate::icon::stroke(path, color, size, weight).into_any_element()
    };
    let core = match line.icon {
        Icon::Search => glyph(
            SEARCH,
            if line.live { theme().text } else { muted },
            14.,
            2.,
        ),
        Icon::Globe => glyph(
            GLOBE,
            if line.live { theme().text } else { muted },
            13.,
            1.8,
        ),
        Icon::Cross => glyph(CROSS, muted, 10., 2.2),
        Icon::Check => div()
            .size(px(13.))
            .rounded_full()
            .bg(theme().accent)
            .flex()
            .items_center()
            .justify_center()
            .child(crate::icon::stroke(CHECK, crate::theme::on_accent(), 11., 2.6))
            .into_any_element(),
        Icon::Ring => div()
            .size(px(8.))
            .rounded_full()
            .border_1()
            .border_color(muted)
            .into_any_element(),
        Icon::Dot => {
            let size = if branch { 4.5 } else { 6. };
            div()
                .size(px(size))
                .rounded_full()
                .bg(if line.live { theme().text } else { muted })
                .into_any_element()
        }
    };
    let mut slot = div()
        .relative()
        .size(px(16.))
        .flex()
        .items_center()
        .justify_center()
        .child(core);
    if line.live {
        let angle = (clock % SPIN) / SPIN * std::f32::consts::TAU;
        slot = slot.child(
            div().absolute().inset_0().child(
                crate::icon::stroke(ARC, theme().text, 16., 1.6)
                    .with_transformation(Transformation::rotate(radians(angle))),
            ),
        );
    }
    slot.into_any_element()
}

fn chip(chip: &Chip, arrive: f32) -> AnyElement {
    let mark = match chip.badge {
        Badge::Text(text, color) => Some(
            div()
                .text_size(px(10.5))
                .font_weight(gpui::FontWeight::BOLD)
                .text_color(gpui::rgb(color))
                .child(text)
                .into_any_element(),
        ),
        Badge::Glyph(path, color) => {
            Some(crate::icon::stroke(path, gpui::rgb(color), 13., 1.6).into_any_element())
        }
        Badge::None => None,
    };
    div()
        .relative()
        .top(px(4. * (1. - arrive)))
        .opacity(arrive)
        .h(px(22.))
        .px(px(9.))
        .flex()
        .flex_shrink_0()
        .items_center()
        .gap(px(5.))
        .rounded_full()
        .bg(theme().surface_raised)
        .border_1()
        .border_color(theme().border)
        .text_size(px(12.))
        .text_color(theme().text_secondary)
        .children(mark)
        .child(chip.label.clone())
        .into_any_element()
}

fn stroke(window: &mut Window, color: Rgba, dashed: bool, build: impl FnOnce(&mut PathBuilder)) {
    let mut path = PathBuilder::stroke(px(1.));
    if dashed {
        path = path.dash_array(&[px(2.), px(2.5)]);
    }
    build(&mut path);
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
}

/// Draws this line's stretch of the rail: the main hairline above and below
/// its icon, a dashed curve out to a dead end, and the solid branch that work
/// running at the same time leaves and rejoins the rail on. `slide` moves a
/// dead end out from the rail.
fn rail_canvas(rail: Rail, first: bool, last: bool, slide: f32) -> impl IntoElement {
    canvas(
        |_, _, _| {},
        move |bounds: Bounds<Pixels>, _, window: &mut Window, _: &mut App| {
            let color = rail_color();
            let top = bounds.top();
            let bottom = bounds.bottom();
            let centre = top + px(ROW / 2.);
            let x = bounds.left() + px(RAIL_X);
            let branch = bounds.left() + px(BRANCH_X);
            let line = |window: &mut Window, at: Pixels, from: Pixels, to: Pixels| {
                if to > from {
                    stroke(window, color, false, |path| {
                        path.move_to(point(at, from));
                        path.line_to(point(at, to));
                    });
                }
            };
            match rail {
                Rail::Main | Rail::Join => {
                    if !first {
                        line(window, x, top - px(4.), centre - px(8.));
                    }
                    if !last {
                        line(window, x, centre + px(8.), bottom + px(4.));
                    }
                    if rail == Rail::Join {
                        stroke(window, color, false, |path| {
                            path.move_to(point(branch, top - px(2.)));
                            path.cubic_bezier_to(
                                point(x + px(2.), centre - px(7.)),
                                point(branch, centre - px(4.)),
                                point(x + px(2.), top + px(4.)),
                            );
                        });
                    }
                }
                Rail::Dead => {
                    if !last {
                        line(window, x, top - px(4.), bottom + px(4.));
                    }
                    let end = x + (branch - x) * slide - px(6.);
                    let faded = Rgba {
                        a: color.a * slide,
                        ..color
                    };
                    stroke(window, faded, true, |path| {
                        path.move_to(point(x, top - px(6.)));
                        path.cubic_bezier_to(
                            point(end, centre),
                            point(x, centre - px(2.)),
                            point(end - px(4.), centre),
                        );
                    });
                }
                Rail::Fork {
                    first: opens,
                    last: closes,
                } => {
                    if !last {
                        line(window, x, top - px(4.), bottom + px(4.));
                    }
                    if opens {
                        stroke(window, color, false, |path| {
                            path.move_to(point(x, top - px(6.)));
                            path.cubic_bezier_to(
                                point(branch, centre - px(7.)),
                                point(x, top + px(6.)),
                                point(branch, top + px(2.)),
                            );
                        });
                    } else {
                        line(window, branch, top - px(4.), centre - px(6.));
                    }
                    if !(closes && last) {
                        line(window, branch, centre + px(6.), bottom + px(4.));
                    }
                }
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// The trace for one block of steps. `expanded` is the row's disclosure; a live
/// trace stays open.
pub fn element(state: Rc<RefCell<RowState>>, index: usize, list: &gpui::ListState) -> AnyElement {
    let (id, steps, trace, expanded) = {
        let state = state.borrow();
        let crate::model::Row::Activity { id, steps, trace } = &state.row else {
            return div().into_any_element();
        };
        (id.clone(), steps.clone(), trace.clone(), state.disclosure())
    };
    let open = trace.live || expanded;
    // One clock for every trace keeps shimmers and arcs in step.
    let beat = seen("trace:clock", true).elapsed().as_secs_f32();
    // A saved trace drawn for the first time starts settled; a live trace and
    // lines added later animate in.
    let known = SEEN.with(|seen| seen.borrow().contains_key(&format!("trace:{id}")));
    let settled = !known && !trace.live;
    seen(&format!("trace:{id}"), true);
    let now = now_ms();
    let timed = clock(&id, &trace, now);
    let lines = lines(&steps, &timed);
    let expandable = !lines.is_empty();
    let mut animating = trace.live;

    let header_open = progress(seen(&format!("trace:{id}:header"), settled), APPEAR);
    let (title, live_time) = title(&steps, &timed, now);
    let title_key = if trace.live { "live" } else { "done" };
    let title_since = seen(&format!("trace:{id}:title:{title_key}"), settled);
    let title_fade = progress(title_since, SWAP);
    animating |= title_fade < 1. || header_open < 1.;
    let title_text: AnyElement = if trace.live {
        shimmer(&title, theme().text, theme().text_muted, beat).into_any_element()
    } else {
        div().child(title).into_any_element()
    };
    let toggle_state = state.clone();
    let toggle_list = list.clone();
    let header = div()
        .id(("trace-header", index))
        .debug_selector(move || format!("trace-header-{index}"))
        .relative()
        .top(px(6. * (1. - header_open)))
        .opacity(header_open)
        .h(px(ROW * header_open))
        .flex()
        .items_center()
        .when(expandable && !trace.live, |row| {
            row.cursor_pointer().on_click(move |_, window, cx| {
                toggle_state.borrow_mut().toggle_disclosure();
                toggle_list.splice(index..index + 1, 1);
                window.refresh();
                cx.stop_propagation();
            })
        })
        .child(
            div()
                .absolute()
                .left(px(RAIL_X - 6.))
                .top(px(ROW / 2. - 6.))
                .when(expandable, |slot| {
                    slot.child(crate::icon::stroke(
                        if open { CHEVRON_DOWN } else { CHEVRON_RIGHT },
                        theme().text_muted,
                        12.,
                        2.,
                    ))
                }),
        )
        .child(
            div()
                .pl(px(TEXT_X))
                .flex()
                .items_center()
                .gap(px(7.))
                .opacity(0.35 + 0.65 * title_fade)
                .text_color(if trace.live {
                    theme().text
                } else {
                    theme().text_secondary
                })
                .child(title_text)
                .when_some(live_time, |row, time| {
                    row.child(div().text_color(theme().text_muted).child(time))
                }),
        );

    let mut body = div().flex().flex_col();
    if open {
        let count = lines.len();
        for (position, line) in lines.iter().enumerate() {
            let base = format!("trace:{id}:{}", line.key);
            // Each new line opens its own height, so the rows under it and the
            // followed scroll glide instead of jumping.
            let appear = progress(seen(&base, settled), APPEAR);
            let swap = progress(seen(&format!("{base}:{}", line.label), settled), SWAP);
            let slide = if line.rail == Rail::Dead {
                progress(seen(&format!("{base}:dead"), settled), SLIDE)
            } else {
                1.
            };
            let chips_since =
                (!line.chips.is_empty()).then(|| seen(&format!("{base}:chips"), settled));
            let chips_open = chips_since.map_or(0., |since| progress(since, APPEAR));
            animating |=
                appear < 1. || swap < 1. || slide < 1. || chips_since.is_some() && chips_open < 1.;
            let x = match line.rail {
                Rail::Main | Rail::Join => RAIL_X,
                Rail::Fork { .. } => BRANCH_X,
                Rail::Dead => RAIL_X + (BRANCH_X - RAIL_X) * slide,
            };
            let label: AnyElement = if line.live {
                shimmer(&line.label, theme().text, theme().text_muted, beat).into_any_element()
            } else {
                div().child(line.label.clone()).into_any_element()
            };
            // The column narrows with the window; the last painted width says how far.
            let width = COLUMN
                .with(Cell::get)
                .unwrap_or(crate::theme::GEOMETRY.composer_width)
                - TEXT_X;
            let (shown, more) = fit(&line.chips, line.more, width);
            let chips_row = chips_since.map(|since| {
                // Chips that arrive together come in one after another.
                let chips =
                    shown
                        .iter()
                        .map(|&i| &line.chips[i])
                        .enumerate()
                        .map(|(order, item)| {
                            let arrived = seen(&format!("{base}:chip:{}", item.label), settled);
                            let delay = if arrived.saturating_duration_since(since) < STAGGER {
                                STAGGER * order as u32
                            } else {
                                Duration::ZERO
                            };
                            let arrive = progress_after(arrived, delay, APPEAR);
                            animating |= arrive < 1.;
                            chip(item, arrive)
                        });
                div()
                    .pl(px(TEXT_X))
                    .h(px(CHIPS * chips_open))
                    .flex()
                    .items_start()
                    .gap(px(6.))
                    .overflow_hidden()
                    .children(chips.collect::<Vec<_>>())
                    .when(more > 0, |row| {
                        row.child(
                            div()
                                .h(px(22.))
                                .flex()
                                .items_center()
                                .pl(px(2.))
                                .text_size(px(12.))
                                .text_color(theme().text_muted)
                                .opacity(chips_open)
                                .child(format!("+{more} more")),
                        )
                    })
            });
            body = body.child(
                div()
                    .id(("trace-line", position))
                    .debug_selector(move || format!("trace-line-{index}-{position}"))
                    .relative()
                    .top(px(6. * (1. - appear)))
                    .opacity(appear)
                    .h(px((ROW + CHIPS * chips_open) * smooth(appear)))
                    .overflow_hidden()
                    .flex()
                    .flex_col()
                    .child(rail_canvas(
                        line.rail,
                        position == 0,
                        position + 1 == count,
                        slide,
                    ))
                    .child(
                        div()
                            .relative()
                            .h(px(ROW))
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .child(
                                div()
                                    .absolute()
                                    .left(px(x - 8.))
                                    .top(px(ROW / 2. - 8.))
                                    .child(icon(line, beat)),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .pl(px(TEXT_X))
                                    .flex()
                                    .items_center()
                                    .gap(px(7.))
                                    .min_w_0()
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_color(tone(line.tone))
                                    .opacity(0.3 + 0.7 * swap)
                                    .child(div().flex_shrink_0().child(label))
                                    .when_some(line.detail.clone(), |row, detail| {
                                        row.child(
                                            div()
                                                .flex_1()
                                                .min_w_0()
                                                .overflow_hidden()
                                                .whitespace_normal()
                                                .text_ellipsis()
                                                .line_clamp(1)
                                                .text_color(theme().text_muted)
                                                .child(detail),
                                        )
                                    }),
                            ),
                    )
                    .children(chips_row),
            );
        }
    }

    // Reading column and insets match the transcript's message rows.
    let column = crate::theme::GEOMETRY.composer_width + 48.;
    div()
        .w_full()
        .flex()
        .justify_center()
        .child(
            div()
                .w(px(column))
                .max_w_full()
                .px(px(24.))
                .pt(px(4.))
                .pb(px(10.))
                .text_size(px(13.))
                .line_height(px(20.))
                .child(
                    canvas(
                        |bounds, _, _| COLUMN.with(|c| c.set(Some(f32::from(bounds.size.width)))),
                        |_, _, _, _| {},
                    )
                    .w_full()
                    .h(px(0.)),
                )
                .child(header)
                .child(body)
                .when(animating, |column| {
                    // Redraw while anything moves: the shimmer, arc, clock and fades.
                    column.child(
                        canvas(
                            |_, window, _| window.request_animation_frame(),
                            |_, _, _, _| {},
                        )
                        .size_0(),
                    )
                }),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(group: usize, key: &str, status: &str, subject: Option<&str>) -> Step {
        let mut step = tool(
            "base",
            serde_json::json!({"name":"Bash","args":{"command":"cargo test"}}),
        );
        step.id = format!("s{group}{key}{status}{}", subject.unwrap_or(""));
        step.status = status.into();
        step.reason =
            (status == "failed").then(|| "Exit code 1\nmiddleware can't read the body".into());
        step.group = group;
        step.group_key = key.into();
        step.subject = subject.map(str::to_owned);
        step.parts = vec![];
        step
    }

    fn tool(id: &str, value: serde_json::Value) -> Step {
        crate::activity::activity(id, &value, "")
    }

    fn labels(lines: &[Line]) -> Vec<String> {
        lines.iter().map(|line| line.label.clone()).collect()
    }

    #[test]
    fn lines_word_live_and_finished_work_like_the_reference() {
        let steps = vec![
            step(0, "search", "ok", Some("fn route")),
            step(1, "read", "ok", Some("src/router.ts")),
            step(1, "read", "ok", Some("src/auth.ts")),
            step(2, "command:cargo", "failed", None),
            step(3, "read", "running", Some("src/Button.tsx")),
        ];
        let live = Trace {
            live: true,
            thinking: true,
            ..Default::default()
        };
        let lines_live = lines(&steps, &live);
        assert_eq!(
            labels(&lines_live),
            [
                "Searched the codebase for \"fn route\"",
                "Read 2 files in src",
                "Dead end: cargo test",
                "Reading Button.tsx",
            ]
        );
        assert_eq!(
            lines_live[2].rail,
            Rail::Dead,
            "a failed step branches off the rail"
        );
        assert_eq!(
            lines_live[2].detail.as_deref(),
            Some("middleware can't read the body"),
            "the reason skips the bare exit code"
        );
        assert!(lines_live[3].live && !lines_live[1].live);
        assert_eq!(
            lines_live[1]
                .chips
                .iter()
                .map(|c| c.label.as_str())
                .collect::<Vec<_>>(),
            ["router.ts", "auth.ts"]
        );

        let done = Trace {
            thinking: true,
            ..Default::default()
        };
        let finished = lines(&steps, &done);
        assert_eq!(finished[3].label, "Read Button.tsx");
        let last = finished.last().unwrap();
        assert_eq!(last.label, "Finished thinking");
        assert_eq!(
            last.detail, None,
            "without a clock the header already counts the work"
        );
        let timed = Trace {
            started: Some(0.),
            ended: Some(14_000.),
            ..done.clone()
        };
        assert_eq!(
            lines(&steps, &timed).last().unwrap().detail.as_deref(),
            Some(tally(&steps).as_str())
        );
        assert_eq!(
            tally(&steps),
            "1 search · 3 files read · 1 command · 1 failed"
        );
    }

    #[test]
    fn chips_that_do_not_fit_the_column_count_as_more() {
        let chip = |label: &str| Chip {
            label: label.into(),
            badge: Badge::Glyph(GLOBE, 0),
        };
        let chips = [
            chip("Animation – GPUI docs"),
            chip("A very long page title here"),
            chip("uniform list"),
        ];
        assert_eq!(fit(&chips, 0, 1000.), (vec![0, 1, 2], 0));
        assert_eq!(
            fit(&chips, 2, 380.),
            (vec![0, 2], 3),
            "a chip too wide for what is left is skipped, and counted"
        );
        assert_eq!(
            fit(&chips[..1], 0, 10.),
            (vec![0], 0),
            "one chip always shows"
        );
    }

    #[test]
    fn file_chips_show_names_badges_and_a_count_of_the_rest() {
        let steps: Vec<Step> = ["a.ts", "b.ts", "c.tsx", "d.rs", "e.md", "a.ts"]
            .iter()
            .map(|name| step(0, "read", "ok", Some(&format!("src/{name}"))))
            .collect();
        let line = &lines(&steps, &Trace::default())[0];
        assert_eq!(line.label, "Read 5 files in src", "duplicates count once");
        assert_eq!(
            line.chips
                .iter()
                .map(|c| c.label.as_str())
                .collect::<Vec<_>>(),
            ["a.ts", "b.ts", "c.tsx", "d.rs"]
        );
        assert_eq!(line.more, 1);
        assert!(matches!(line.chips[0].badge, Badge::Text("TS", _)));
        assert!(matches!(line.chips[2].badge, Badge::Glyph(..)));
    }

    #[test]
    fn web_research_shows_the_query_and_the_pages_as_chips() {
        let search = tool(
            "w1",
            serde_json::json!({"name":"WebSearch","status":"done","args":{"query":"gpui list row animation"},
                "result":"Links: [{\"title\":\"Animation – GPUI\",\"url\":\"https://gpui.rs/animation\"},{\"title\":\"docs.rs\",\"url\":\"https://docs.rs/gpui/0.2.1/src/gpui/elements/animation.rs.html\"}]"}),
        );
        let mut fetches = vec![
            tool(
                "w2",
                serde_json::json!({"name":"WebFetch","status":"done","args":{"url":"https://gpui.rs/animation"}}),
            ),
            tool(
                "w3",
                serde_json::json!({"name":"WebFetch","status":"running","args":{"url":"https://docs.rs/crate/gpui/0.2.2/source/examples/animation.rs"}}),
            ),
        ];
        for fetch in &mut fetches {
            fetch.batch = Some("w2".into());
        }
        let steps = [vec![search], fetches].concat();
        let live = Trace {
            live: true,
            ..Default::default()
        };
        let shown = lines(&steps, &live);
        assert_eq!(
            labels(&shown),
            [
                "Searched the web for \"gpui list row animation\"",
                "Reading 2 of 2 pages",
            ]
        );
        assert_eq!(shown[0].icon, Icon::Globe);
        let chip_labels = |line: &Line| {
            line.chips
                .iter()
                .map(|c| c.label.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            chip_labels(&shown[0]),
            ["Animation – GPUI", "docs.rs · animation.rs"],
            "a real title, or the site and page when the title is only the site"
        );
        assert_eq!(
            chip_labels(&shown[1]),
            ["Animation – GPUI", "docs.rs · animation.rs"],
            "a page read takes the title its search found"
        );
        assert!(shown[1].live);
        assert_eq!(lines(&steps, &Trace::default())[1].label, "Read 2 pages");
    }

    #[test]
    fn work_that_ran_at_the_same_time_branches_and_rejoins() {
        let mut steps = vec![
            tool(
                "a",
                serde_json::json!({"name":"Read","status":"done","args":{"file_path":"src/a.rs"}}),
            ),
            tool(
                "b",
                serde_json::json!({"name":"Bash","status":"done","args":{"command":"cargo test -p trace"}}),
            ),
            tool(
                "c",
                serde_json::json!({"name":"Grep","status":"running","args":{"pattern":"session","path":"src/lib"}}),
            ),
        ];
        for step in &mut steps[1..] {
            step.batch = Some("b".into());
        }
        let live = Trace {
            live: true,
            ..Default::default()
        };
        let shown = lines(&steps, &live);
        assert_eq!(
            labels(&shown),
            [
                "Read a.rs",
                "Ran cargo test -p trace",
                "Searching src/lib for \"session\""
            ]
        );
        assert_eq!(
            shown.iter().map(|l| l.rail).collect::<Vec<_>>(),
            [
                Rail::Main,
                Rail::Fork {
                    first: true,
                    last: false
                },
                Rail::Fork {
                    first: false,
                    last: true
                },
            ],
            "no join while a branch still runs"
        );
        steps[2].status = "ok".into();
        let shown = lines(&steps, &Trace::default());
        assert_eq!(shown[3].rail, Rail::Join);
        assert_eq!(shown[3].icon, Icon::Ring);
        assert_eq!(
            (shown[3].label.as_str(), shown[3].detail.as_deref()),
            ("Merged the results", Some("2 at once"))
        );
    }

    #[test]
    fn a_chained_command_reads_as_each_thing_it_did() {
        let steps = vec![tool(
            "x",
            serde_json::json!({"name":"Bash","status":"done","args":{"command":
                "rg -il orchestrator src/lib | wc -l; cat package.json tsconfig.json && ls scripts/ci; git status --short; node -e 'console.log(1)'"}}),
        )];
        assert_eq!(
            labels(&lines(&steps, &Trace::default())),
            [
                "Searched src/lib for \"orchestrator\"",
                "Read 2 files",
                "Listed scripts/ci",
                "Checked git status",
                "Ran a Node script",
                "Finished",
            ]
        );
    }

    #[test]
    fn a_saved_turn_keeps_its_branches_and_how_long_it_worked() {
        // The server saves each call's start and finish and the turn's outcome time.
        let entries: Vec<crate::model::Entry> = serde_json::from_value(serde_json::json!([
            {"id":"ask","role":"user","text":"Research it","timestamp":"1000"},
            {"id":"reply","role":"assistant","text":"Done.","timestamp":"1001",
             "receipt":{"terminal":{"userMessageId":"ask","outcome":"completed","completedAt":32_000}},
             "toolCalls":[
                {"id":"s","name":"WebSearch","args":{"query":"gpui"},"status":"done","startedAt":2_000,"finishedAt":5_000},
                {"id":"g","name":"Grep","args":{"pattern":"shape_line"},"status":"done","startedAt":2_010,"finishedAt":3_000},
                {"id":"r","name":"Read","args":{"file_path":"src/a.rs"},"status":"done","startedAt":6_000,"finishedAt":6_500}
             ]}
        ]))
        .unwrap();
        let rows = crate::model::render_tree(&entries);
        let (steps, trace) = rows
            .iter()
            .find_map(|row| match row {
                crate::model::Row::Activity { steps, trace, .. } => {
                    Some((steps.clone(), trace.clone()))
                }
                _ => None,
            })
            .unwrap();
        assert!(!trace.live);
        assert_eq!(title(&steps, &trace, 0.).0, "Worked for 31s");
        let shown = lines(&steps, &trace);
        assert_eq!(
            shown.iter().map(|l| l.rail).collect::<Vec<_>>(),
            [
                Rail::Fork {
                    first: true,
                    last: false
                },
                Rail::Fork {
                    first: false,
                    last: true
                },
                Rail::Join,
                Rail::Main,
                Rail::Main,
            ],
            "the search and grep overlapped, the read came after"
        );
    }

    #[test]
    fn page_labels_prefer_real_titles() {
        assert_eq!(page("https://www.example.com/", None), "example.com");
        assert_eq!(
            page("https://nextjs.org/docs/routing.html?x=1", Some("docs")),
            "docs"
        );
        assert_eq!(
            page("https://nextjs.org/docs/routing.html", Some("nextjs.org")),
            "nextjs.org · routing"
        );
        assert_eq!(place("/Users/someone/repo"), None, "home folders stay out");
        assert_eq!(place("/Users/someone/repo/src/lib"), Some("src/lib".into()));
    }

    #[test]
    fn the_header_counts_while_live_then_says_how_long_it_took() {
        let steps = vec![step(0, "read", "ok", Some("a.rs"))];
        let mut trace = Trace {
            started: Some(1_000.),
            ended: Some(15_000.),
            thinking: true,
            live: true,
        };
        assert_eq!(
            title(&steps, &trace, 5_200.),
            ("Thinking".into(), Some("4s".into()))
        );
        trace.live = false;
        assert_eq!(title(&steps, &trace, 0.).0, "Thought for 14s");
        trace.thinking = false;
        assert_eq!(title(&steps, &trace, 0.).0, "Worked for 14s");
        trace.started = None;
        assert_eq!(
            title(&steps, &trace, 0.).0,
            "1 file read",
            "no clock: the counted line"
        );
        assert_eq!(title(&[], &trace, 0.).0, "Thought briefly");
    }

    #[test]
    fn a_trace_watched_live_keeps_how_long_it_ran() {
        let live = Trace {
            started: Some(10_000.),
            ended: Some(10_001.),
            thinking: false,
            live: true,
        };
        assert_eq!(clock("watched", &live, 12_000.).started, Some(10_000.));
        let done = Trace {
            live: false,
            ..live.clone()
        };
        let timed = clock("watched", &done, 24_000.);
        assert_eq!((timed.started, timed.ended), (Some(10_000.), Some(24_000.)));
        assert_eq!(title(&[], &timed, 0.).0, "Worked for 14s");
        assert_eq!(
            clock("watched", &done, 99_000.).ended,
            Some(24_000.),
            "the end holds"
        );
        assert_eq!(
            clock("history", &done, 24_000.),
            done,
            "unwatched history is unchanged"
        );
    }

    #[test]
    fn durations_read_as_seconds_then_minutes() {
        assert_eq!(seconds(14_200.), "14s");
        assert_eq!(seconds(65_000.), "1m 5s");
    }
}
