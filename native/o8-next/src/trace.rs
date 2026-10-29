//! The thinking trace: a turn's reasoning and tool steps as one quiet timeline
//! on a hairline rail. The live step shimmers under a spinning arc, new steps
//! rise in, finished steps settle to past tense, and the header counts the
//! seconds until it reads "Thought for Ns". Shell text is never executed.
use crate::{
    activity::{Step, summary},
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
    cell::RefCell,
    collections::HashMap,
    rc::Rc,
    time::{Duration, Instant},
};

/// Measured from the reference at the transcript's 13px body size.
const ROW: f32 = 26.;
const RAIL_X: f32 = 9.;
const BRANCH_X: f32 = 24.;
const TEXT_X: f32 = 38.;
const CHIPS: f32 = 26.;
const APPEAR: Duration = Duration::from_millis(220);
const SWAP: Duration = Duration::from_millis(160);
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

#[derive(Clone, Copy, PartialEq)]
enum Icon {
    Search,
    Dot,
    Cross,
    Check,
    Globe,
}

#[derive(Clone, Copy, PartialEq)]
enum Tone {
    Primary,
    Secondary,
    Muted,
}

struct Chip {
    label: String,
    badge: Badge,
}

#[derive(Clone, Copy)]
enum Badge {
    Text(&'static str, u32),
    Glyph(&'static str, u32),
    None,
}

struct Line {
    key: String,
    branch: bool,
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

fn badge(name: &str) -> Badge {
    let extension = name.rsplit_once('.').map(|(_, e)| e.to_lowercase());
    match extension.as_deref() {
        Some("ts" | "mts" | "cts") => Badge::Text("TS", 0x4f9fbf),
        Some("tsx" | "jsx") => Badge::Glyph(ATOM, 0x4f9fbf),
        Some("js" | "mjs" | "cjs") => Badge::Text("JS", 0xc9a43a),
        Some("rs") => Badge::Text("RS", 0xd0875a),
        Some("py") => Badge::Text("PY", 0x4b8bbe),
        Some("go") => Badge::Text("GO", 0x4fa8c8),
        Some("md" | "mdx") => Badge::Text("MD", 0x8a8f98),
        Some("json" | "toml" | "yaml" | "yml") => Badge::Text("{}", 0x8a8f98),
        Some("css" | "scss") => Badge::Text("CSS", 0x6c8fd6),
        Some("swift") => Badge::Text("SW", 0xe0794c),
        _ => Badge::None,
    }
}

fn chips(steps: &[&Step], files: bool) -> (Vec<Chip>, usize) {
    let mut labels = Vec::<(String, Badge)>::new();
    for step in steps {
        let Some(subject) = step.subject.as_deref() else {
            continue;
        };
        let web = subject.starts_with("http://") || subject.starts_with("https://");
        let label = if files && !web {
            subject
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(subject)
                .to_owned()
        } else {
            short(subject, 32)
        };
        let mark = if web {
            Badge::Glyph(GLOBE, 0x8a8f98)
        } else if files {
            badge(&label)
        } else {
            Badge::None
        };
        if !labels.iter().any(|(existing, _)| existing == &label) {
            labels.push((label, mark));
        }
    }
    let more = labels.len().saturating_sub(MAX_CHIPS);
    (
        labels
            .into_iter()
            .take(MAX_CHIPS)
            .map(|(label, badge)| Chip { label, badge })
            .collect(),
        more,
    )
}

/// One line per group of like steps, worded as the work it did.
fn lines(steps: &[Step], trace: &Trace) -> Vec<Line> {
    let mut groups: Vec<Vec<&Step>> = vec![];
    for step in steps {
        match groups.last_mut() {
            Some(group) if group[0].group == step.group => group.push(step),
            _ => groups.push(vec![step]),
        }
    }
    let mut out = vec![];
    for (index, group) in groups.iter().enumerate() {
        let first = group[0];
        let running = trace.live && group.iter().any(|s| s.status == "running");
        let count = group.len();
        let key = format!("g{index}");
        if first.status == "failed" || first.status == "stopped" {
            // Name what was tried; a bare "Exit code 1" says nothing on its own.
            let reason = first.reason.as_deref().map(|reason| short(reason, 48));
            out.push(Line {
                key,
                branch: true,
                icon: Icon::Cross,
                label: format!("Dead end: {}", short(&first.command, 56)),
                detail: reason,
                tone: Tone::Muted,
                live: false,
                chips: vec![],
                more: 0,
            });
            continue;
        }
        let kind = first.group_key.as_str();
        let pick = |live: &str, done: &str| {
            if running {
                live.to_owned()
            } else {
                done.to_owned()
            }
        };
        let (icon, label, files) = match kind {
            "search" => (
                Icon::Search,
                pick("Searching the codebase", "Searched the codebase"),
                false,
            ),
            "web-search" => (
                Icon::Globe,
                pick("Searching the web", "Searched the web"),
                false,
            ),
            "read" => (
                Icon::Dot,
                if running {
                    format!("Reading {}", noun(count, "file", "files"))
                } else {
                    format!("Read {}", noun(count, "file", "files"))
                },
                true,
            ),
            "edit" => (
                Icon::Dot,
                if running {
                    format!("Editing {}", noun(count, "file", "files"))
                } else {
                    format!("Edited {}", noun(count, "file", "files"))
                },
                true,
            ),
            "list" => (Icon::Dot, pick("Listing folders", "Listed folders"), true),
            "test" => (Icon::Dot, pick("Running the tests", "Ran the tests"), false),
            "typecheck" => (Icon::Dot, pick("Checking types", "Checked types"), false),
            "lint" => (Icon::Dot, pick("Linting", "Linted"), false),
            "git:diff" => (Icon::Dot, pick("Reading the diff", "Read the diff"), false),
            "git:status" => (
                Icon::Dot,
                pick("Checking git status", "Checked git status"),
                false,
            ),
            "git:log" => (
                Icon::Dot,
                pick("Reading git history", "Read git history"),
                false,
            ),
            _ if count == 1 => {
                let command = short(&first.command, 56);
                (
                    Icon::Dot,
                    if running {
                        format!("Running {command}")
                    } else {
                        format!("Ran {command}")
                    },
                    false,
                )
            }
            _ => (
                Icon::Dot,
                if running {
                    format!("Running {count} commands")
                } else {
                    format!("Ran {count} commands")
                },
                false,
            ),
        };
        let (chips, more) = if kind.starts_with("command:") || kind == "test" {
            (vec![], 0)
        } else {
            chips(group, files)
        };
        out.push(Line {
            key,
            branch: false,
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
            branch: false,
            icon: Icon::Check,
            label: if trace.thinking {
                "Finished thinking".into()
            } else {
                "Finished".into()
            },
            detail: timed.then(|| summary(steps)),
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
        summary(steps)
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

fn rail() -> Rgba {
    Rgba {
        a: theme().text_muted.a * 0.45,
        ..theme().text_muted
    }
}

/// The icon in the rail; a live step's icon sits inside a turning arc.
fn icon(line: &Line, clock: f32) -> AnyElement {
    let muted = theme().text_muted;
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
            .child(crate::icon::stroke(CHECK, gpui::rgb(0xffffff), 11., 2.6))
            .into_any_element(),
        Icon::Dot => {
            let size = if line.branch { 4.5 } else { 6. };
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

fn chip(chip: &Chip) -> AnyElement {
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
        .h(px(20.))
        .px(px(8.))
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

/// Draws this line's stretch of the rail: the main hairline above and below
/// its icon, and for a branch the curve that leaves the main line.
fn rail_canvas(branch: bool, first: bool, last: bool, dashed: bool) -> impl IntoElement {
    canvas(
        |_, _, _| {},
        move |bounds: Bounds<Pixels>, _, window: &mut Window, _: &mut App| {
            let color = rail();
            let top = bounds.top();
            let centre = top + px(ROW / 2.);
            let x = bounds.left() + px(RAIL_X);
            let segment = |window: &mut Window, from: Pixels, to: Pixels| {
                if to > from {
                    let mut path = PathBuilder::stroke(px(1.));
                    path.move_to(point(x, from));
                    path.line_to(point(x, to));
                    if let Ok(path) = path.build() {
                        window.paint_path(path, color);
                    }
                }
            };
            if branch {
                if !last {
                    segment(window, top - px(4.), bounds.bottom());
                }
                let branch_x = bounds.left() + px(BRANCH_X);
                let mut curve = PathBuilder::stroke(px(1.));
                if dashed {
                    curve = curve.dash_array(&[px(2.), px(2.5)]);
                }
                curve.move_to(point(x, top - px(6.)));
                curve.cubic_bezier_to(
                    point(branch_x - px(6.), centre),
                    point(x, centre - px(2.)),
                    point(branch_x - px(10.), centre),
                );
                if let Ok(path) = curve.build() {
                    window.paint_path(path, color);
                }
            } else {
                if !first {
                    segment(window, top - px(4.), centre - px(8.));
                }
                if !last {
                    segment(window, centre + px(8.), bounds.bottom() + px(4.));
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
    // A trace drawn for the first time starts settled; lines added later animate.
    let known = SEEN.with(|seen| seen.borrow().contains_key(&format!("trace:{id}")));
    seen(&format!("trace:{id}"), true);
    let now = now_ms();
    let timed = clock(&id, &trace, now);
    let lines = lines(&steps, &timed);
    let expandable = !lines.is_empty();
    let mut animating = trace.live;

    let (title, live_time) = title(&steps, &timed, now);
    let title_key = if trace.live { "live" } else { "done" };
    let title_since = seen(&format!("trace:{id}:title:{title_key}"), !known);
    let title_fade = progress(title_since, SWAP);
    animating |= title_fade < 1.;
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
        .h(px(ROW))
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
            let appear = progress(seen(&format!("trace:{id}:{}", line.key), !known), APPEAR);
            let swap = progress(
                seen(&format!("trace:{id}:{}:{}", line.key, line.label), !known),
                SWAP,
            );
            animating |= appear < 1. || swap < 1.;
            let x = if line.branch { BRANCH_X } else { RAIL_X };
            let label: AnyElement = if line.live {
                shimmer(&line.label, theme().text, theme().text_muted, beat).into_any_element()
            } else {
                div().child(line.label.clone()).into_any_element()
            };
            let chips_row = (!line.chips.is_empty()).then(|| {
                div()
                    .pl(px(TEXT_X))
                    .h(px(CHIPS))
                    .flex()
                    .items_start()
                    .gap(px(6.))
                    .overflow_hidden()
                    .children(line.chips.iter().map(chip))
                    .when(line.more > 0, |row| {
                        row.child(
                            div()
                                .h(px(20.))
                                .flex()
                                .items_center()
                                .pl(px(2.))
                                .text_size(px(12.))
                                .text_color(theme().text_muted)
                                .child(format!("+{} more", line.more)),
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
                    .flex()
                    .flex_col()
                    .child(rail_canvas(
                        line.branch,
                        position == 0,
                        position + 1 == count,
                        line.branch,
                    ))
                    .child(
                        div()
                            .relative()
                            .h(px(ROW))
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
                                    .pl(px(TEXT_X))
                                    .flex()
                                    .items_center()
                                    .gap(px(7.))
                                    .min_w_0()
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_color(tone(line.tone))
                                    .opacity(0.3 + 0.7 * swap)
                                    .child(label)
                                    .when_some(line.detail.clone(), |row, detail| {
                                        row.child(
                                            div().text_color(theme().text_muted).child(detail),
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
        Step {
            id: format!("s{group}{key}{status}"),
            command: "cargo test".into(),
            status: status.into(),
            reason: (status == "failed").then(|| "middleware can't read the body".into()),
            group,
            group_key: key.into(),
            subject: subject.map(str::to_owned),
        }
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
        let labels: Vec<_> = lines(&steps, &live)
            .into_iter()
            .map(|l| (l.label, l.live, l.branch))
            .collect();
        assert_eq!(labels[0], ("Searched the codebase".into(), false, false));
        assert_eq!(labels[1], ("Read 2 files".into(), false, false));
        assert_eq!(labels[2].0, "Dead end: cargo test");
        assert!(labels[2].2, "a failed step branches off the rail");
        assert_eq!(labels[3], ("Reading 1 file".into(), true, false));
        assert_eq!(labels.len(), 4, "a live trace has no finished line");

        let done = Trace {
            thinking: true,
            ..Default::default()
        };
        let finished = lines(&steps, &done);
        assert_eq!(finished[3].label, "Read 1 file");
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
            Some(summary(&steps).as_str())
        );
    }

    #[test]
    fn file_chips_show_names_badges_and_a_count_of_the_rest() {
        let steps: Vec<Step> = ["a.ts", "b.ts", "c.tsx", "d.rs", "e.md", "a.ts"]
            .iter()
            .map(|name| step(0, "read", "ok", Some(&format!("src/{name}"))))
            .collect();
        let refs: Vec<&Step> = steps.iter().collect();
        let (chips, more) = chips(&refs, true);
        assert_eq!(
            chips.iter().map(|c| c.label.as_str()).collect::<Vec<_>>(),
            ["a.ts", "b.ts", "c.tsx", "d.rs"]
        );
        assert_eq!(more, 1, "duplicates collapse before counting the rest");
        assert!(matches!(chips[0].badge, Badge::Text("TS", _)));
        assert!(matches!(chips[2].badge, Badge::Glyph(..)));
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
            summary(&steps),
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
