//! Opt-in native diff surface, independent of the transcript/composer/terminal.
use crate::theme::current as theme;
use crate::{
    client::Client,
    diff::{self, Document, Kind, Line, Target},
};
use gpui::{
    App, Application, Bounds, Context, FocusHandle, HighlightStyle, KeyDownEvent,
    ListHorizontalSizingBehavior, Render, ScrollStrategy, StyledText, UniformListScrollHandle,
    Window, WindowBounds, WindowOptions, canvas, div, point, prelude::*, px, size, uniform_list,
};
use serde_json::Value;
use std::{cell::RefCell, collections::BTreeSet, rc::Rc};

#[path = "diff_inline.rs"]
mod inline;

pub(crate) struct DiffSurface {
    inline: Option<inline::State>,
    client: Client,
    pub(crate) target: Target,
    pub(crate) document: Rc<Document>,
    pub(crate) selected: usize,
    pub(crate) split: bool,
    pub(crate) ready: bool,
    busy: bool,
    generation: u64,
    pending: Option<Value>,
    state: Value,
    pub(crate) notice: String,
    focus: FocusHandle,
    scroll: UniformListScrollHandle,
    pub(crate) painted: Rc<RefCell<BTreeSet<usize>>>,
}
impl DiffSurface {
    pub(crate) fn new(
        client: Client,
        target: Target,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let focus = cx.focus_handle();
        focus.focus(window);
        let mut surface = Self {
            inline: None,
            client,
            target,
            document: Rc::new(Document::default()),
            selected: 0,
            split: false,
            ready: false,
            busy: false,
            generation: 0,
            pending: None,
            state: Value::Null,
            notice: String::new(),
            focus,
            scroll: UniformListScrollHandle::new(),
            painted: Rc::new(RefCell::new(BTreeSet::new())),
        };
        surface.load(cx);
        surface
    }
    pub(crate) fn load(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.generation += 1;
        let generation = self.generation;
        self.ready = false;
        if self.inline.is_some() {
            self.document = Rc::new(Document::default());
            self.painted.borrow_mut().clear();
        }
        self.pending = None;
        self.notice = "Reading diff…".into();
        let client = self.client.clone();
        let target = self.target.clone();
        let task = cx
            .background_executor()
            .spawn(async move { target.read(&client) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation { return; }
                match result {
                    Ok((document, state)) => {
                        this.document = Rc::new(document);
                        this.state = state;
                        this.ready = true;
                        this.select_file(0, cx);
                        this.notice = if this.document.truncated {
                            "Diff truncated by server. Approval disabled; inspect a smaller worktree diff.".into()
                        } else if this.document.unsupported {
                            "Unsupported patch format. Review disabled; use a plain unified Git diff.".into()
                        } else if this.inline.is_some() && this.document.files.is_empty() { "No changes".into() } else { this.state_label() };
                    }
                    Err(error) => this.notice = error,
                }
                cx.notify();
            });
        }).detach();
        cx.notify();
    }
    fn state_label(&self) -> String {
        if let Some(inline) = &self.inline {
            return inline.label(&self.document);
        }
        let verdict = self.state["orchestratorReview"]["verdict"]
            .as_str()
            .unwrap_or("unreviewed");
        format!(
            "Read-only · {} files · {} · HEAD {}",
            self.document.files.len(),
            verdict,
            &self.document.head[..self.document.head.len().min(12)]
        )
    }
    pub(crate) fn select_file(&mut self, index: usize, cx: &mut Context<Self>) {
        self.selected = index.min(self.document.files.len().saturating_sub(1));
        self.scroll = UniformListScrollHandle::new();
        self.painted.borrow_mut().clear();
        cx.notify();
    }
    pub(crate) fn row_count(&self) -> usize {
        self.document.files.get(self.selected).map_or(0, |f| {
            if let Some(inline) = &self.inline {
                inline.rows(f).len()
            } else if self.split {
                f.split.len()
            } else {
                f.lines.len()
            }
        })
    }
    pub(crate) fn scroll_to(&self, row: usize, cx: &mut Context<Self>) {
        self.scroll.scroll_to_item(row, ScrollStrategy::Top);
        cx.notify();
    }
    fn decide(&mut self, approved: bool, cx: &mut Context<Self>) {
        if !self.ready
            || self.busy
            || self.document.truncated
            || self.document.unsupported
            || self.document.files.is_empty()
        {
            return;
        }
        let Target::Packet(packet) = &self.target else {
            return;
        };
        // A retry never changes its intended verdict, HEAD or mutation identity.
        let body = self
            .pending
            .get_or_insert_with(|| diff::decision(packet, &self.document.head, approved))
            .clone();
        self.busy = true;
        self.notice = "Recording review…".into();
        let client = self.client.clone();
        let target = self.target.clone();
        let generation = self.generation;
        let expected = self.document.clone();
        // Rc remains on the UI thread. Send just the immutable revision identity.
        let head = expected.head.clone();
        let source = expected.source.clone();
        let task = cx.background_executor().spawn(async move {
            let (current, _) = target.read(&client)?;
            if current.head != head
                || current.source != source
                || current.truncated
                || current.unsupported
            {
                return Err("Diff changed. Refresh and review it before deciding.".to_owned());
            }
            let result = client.review(&body)?;
            if result["result"]["recorded"] != true {
                return Err(
                    "Server did not record this decision. Refresh to inspect review state.".into(),
                );
            }
            let Target::Packet(packet) = &target else {
                unreachable!()
            };
            // Refresh actual persisted state, never synthesize an optimistic verdict.
            client.review_state(packet)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.busy = false;
                match result {
                    Ok(state) => {
                        this.state = state;
                        this.pending = None;
                        this.notice = this.state_label();
                    }
                    Err(error) => this.notice = error,
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn mode(&mut self, split: bool, cx: &mut Context<Self>) {
        self.split = split;
        self.scroll = UniformListScrollHandle::new();
        self.painted.borrow_mut().clear();
        cx.notify();
    }
}
fn button(id: &'static str, label: &'static str, selected: bool) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .px(px(8.))
        .py(px(4.))
        .rounded(px(5.))
        .text_size(px(12.))
        .bg(if selected {
            theme().selection
        } else {
            theme().surface_raised
        })
        .cursor_pointer()
        .child(label)
}
fn cell(line: Option<&Line>, before: bool) -> gpui::Div {
    let Some(line) = line else {
        return div().flex_1().min_w_0();
    };
    let mark = match line.kind {
        Kind::Added => "+",
        Kind::Removed => "−",
        _ => " ",
    };
    let number = if before { line.old } else { line.new };
    div()
        .flex()
        .flex_1()
        .min_w_0()
        .h(px(20.))
        .overflow_hidden()
        .bg(match line.kind {
            Kind::Added => theme().success_surface,
            Kind::Removed => theme().danger_surface,
            _ => theme().background,
        })
        .child(
            div()
                .w(px(56.))
                .flex_shrink_0()
                .text_color(theme().text_muted)
                .child(format!(
                    "{} {mark}",
                    number.map(|n| n.to_string()).unwrap_or_default()
                )),
        )
        .child(
            StyledText::new(line.text.clone()).with_highlights(line.highlights.iter().map(
                |(range, color)| {
                    (
                        range.clone(),
                        HighlightStyle {
                            color: Some((*color).into()),
                            ..Default::default()
                        },
                    )
                },
            )),
        )
}
impl Render for DiffSurface {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let doc = self.document.clone();
        let inline = self.inline.is_some();
        let rows = self
            .document
            .files
            .get(self.selected)
            .and_then(|file| self.inline.as_ref().map(|state| state.rows(file)));
        let painted = self.painted.clone();
        let selected = self.selected;
        let split = self.split;
        let content_width = doc.files.get(selected).map_or(0., |f| {
            (f.width_chars as f32 * 8. + 64. + if inline { 160. } else { 0. })
                * if split { 2. } else { 1. }
        });
        let can_review = !inline
            && self.ready
            && !self.busy
            && self.pending.is_none()
            && !doc.truncated
            && !doc.unsupported
            && !doc.files.is_empty()
            && matches!(self.target, Target::Packet(_));
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(theme().background)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .font_weight(gpui::FontWeight::LIGHT)
            .text_size(px(13.5))
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if !this.focus.is_focused(window) {
                    return;
                }
                match event.keystroke.key.as_str() {
                    "home" => this.scroll_to(0, cx),
                    "end" => this.scroll_to(this.row_count().saturating_sub(1), cx),
                    "up" | "down" if event.keystroke.modifiers.alt => {
                        let index = if event.keystroke.key == "up" {
                            this.selected.saturating_sub(1)
                        } else {
                            this.selected + 1
                        };
                        this.select_file(index, cx);
                    }
                    "u" => this.mode(false, cx),
                    "s" if this.inline.is_none() => this.mode(true, cx),
                    "r" => this.load(cx),
                    _ => return,
                }
                cx.stop_propagation();
            }))
            .when(inline, |view| view.child(self.inline_header(cx)))
            .child(
                div()
                    .h(px(40.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .px(px(16.))
                    .gap(px(8.))
                    .child("o8 next · Diff")
                    .when(!inline, |bar| {
                        bar.child(
                            button("diff-unified", "Unified", !split)
                                .on_click(cx.listener(|s, _, _, cx| s.mode(false, cx))),
                        )
                    })
                    .when(!inline, |bar| {
                        bar.child(button("diff-split", "Split", split).on_click(cx.listener(
                            |s, _, _, cx| {
                                if s.inline.is_none() {
                                    s.mode(true, cx);
                                }
                            },
                        )))
                    })
                    .child(
                        button("diff-refresh", "Refresh", false)
                            .on_click(cx.listener(|s, _, _, cx| s.load(cx))),
                    )
                    .when(can_review, |bar| {
                        bar.child(
                            button("diff-approve", "Approve", false)
                                .on_click(cx.listener(|s, _, _, cx| s.decide(true, cx))),
                        )
                        .child(
                            button("diff-reject", "Reject", false)
                                .on_click(cx.listener(|s, _, _, cx| s.decide(false, cx))),
                        )
                    })
                    .when(self.pending.is_some() && !self.busy, |bar| {
                        bar.child(
                            button("diff-retry", "Retry decision", false)
                                .on_click(cx.listener(|s, _, _, cx| s.decide(false, cx))),
                        )
                    }),
            )
            .child(
                div()
                    .px(px(16.))
                    .py(px(8.))
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child(self.notice.clone()),
            )
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(
                        uniform_list(
                            "diff-files",
                            doc.files.len(),
                            cx.processor(|s, range: std::ops::Range<usize>, _, cx| {
                                range
                                    .map(|i| {
                                        let f = &s.document.files[i];
                                        div()
                                            .id(i)
                                            .debug_selector(move || format!("diff-file-{i}").into())
                                            .px(px(12.))
                                            .py(px(5.))
                                            .h(px(58.))
                                            .overflow_hidden()
                                            .cursor_pointer()
                                            .bg(if i == s.selected {
                                                theme().selection
                                            } else {
                                                theme().background
                                            })
                                            .child(div().text_size(px(13.5)).child(f.path.clone()))
                                            .child(
                                                div()
                                                    .mt(px(4.))
                                                    .text_size(px(9.5))
                                                    .text_color(theme().text_muted)
                                                    .child(format!(
                                                        "{} · +{} −{}{}",
                                                        if f.status == "deleted" {
                                                            "removed"
                                                        } else {
                                                            &f.status
                                                        },
                                                        f.additions,
                                                        f.deletions,
                                                        if f.status == "renamed" {
                                                            format!(" · from {}", f.old_path)
                                                        } else {
                                                            String::new()
                                                        }
                                                    )),
                                            )
                                            .on_click(
                                                cx.listener(move |s, _, _, cx| {
                                                    s.select_file(i, cx)
                                                }),
                                            )
                                    })
                                    .collect::<Vec<_>>()
                            }),
                        )
                        .w(px(240.))
                        .flex_shrink_0()
                        .h_full(),
                    )
                    .child(
                        div().flex_1().min_w_0().h_full().child(
                            uniform_list(
                                "diff-rows",
                                self.row_count(),
                                cx.processor(
                                    move |surface, range: std::ops::Range<usize>, _, cx| {
                                        range
                                            .map(|i| {
                                                let f = &doc.files[selected];
                                                let (left, right) = if split {
                                                    f.split[i]
                                                } else {
                                                    (
                                                        Some(
                                                            rows.as_ref().map_or(i, |rows| rows[i]),
                                                        ),
                                                        None,
                                                    )
                                                };
                                                let painted = painted.clone();
                                                div()
                                                    .h(px(20.))
                                                    .min_w(px(content_width))
                                                    .flex()
                                                    .font_family(theme().font_mono)
                                                    .text_size(px(12.))
                                                    .line_height(px(20.))
                                                    .whitespace_nowrap()
                                                    .when(
                                                        inline
                                                            && left.is_some_and(|index| {
                                                                f.lines[index].kind == Kind::Hunk
                                                            }),
                                                        |row| {
                                                            row.child(
                                                                surface
                                                                    .inline_hunk(left.unwrap(), cx),
                                                            )
                                                        },
                                                    )
                                                    .child(cell(
                                                        left.map(|i| &f.lines[i]),
                                                        split
                                                            || left.is_some_and(|i| {
                                                                f.lines[i].new.is_none()
                                                            }),
                                                    ))
                                                    .when(split, |row| {
                                                        row.child(cell(
                                                            right.map(|i| &f.lines[i]),
                                                            false,
                                                        ))
                                                    })
                                                    .child(
                                                        canvas(
                                                            |_, _, _| (),
                                                            move |_, _, _, _| {
                                                                painted.borrow_mut().insert(i);
                                                            },
                                                        )
                                                        .size(px(1.)),
                                                    )
                                            })
                                            .collect::<Vec<_>>()
                                    },
                                ),
                            )
                            .debug_selector(|| "diff-viewport".into())
                            .with_horizontal_sizing_behavior(
                                ListHorizontalSizingBehavior::Unconstrained,
                            )
                            .track_scroll(self.scroll.clone())
                            .size_full(),
                        ),
                    ),
            )
    }
}
pub fn launch(client: Client, target: Target, offscreen: bool) {
    (if offscreen {
        Application::headless()
    } else {
        Application::new()
    })
    .run(move |cx: &mut App| {
        cx.open_window(
            WindowOptions {
                focus: false,
                show: !offscreen,
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    point(px(100.), px(100.)),
                    size(px(1200.), px(816.)),
                ))),
                titlebar: Some(gpui::TitlebarOptions {
                    title: Some("o8 next".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            |window, cx| cx.new(|cx| DiffSurface::new(client, target, window, cx)),
        )
        .expect("GPUI diff window");
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
    });
}

pub const HELP: &str =
    "Diff mode: --review-packet ID or --diff-worktree PATH [--diff-base REF] [--diff-file FILE]";

/// Keep the ordinary transcript/composer launch parser independent so other
/// opt-in native surfaces can be added alongside this mode.
pub fn try_launch(args: &[String]) -> Result<bool, String> {
    if !args.iter().any(|s| {
        matches!(
            s.as_str(),
            "--review-packet" | "--diff-worktree" | "--diff-base" | "--diff-file"
        )
    }) {
        return Ok(false);
    }
    let (mut enabled, mut offscreen) = (false, false);
    let (mut server, mut packet, mut worktree, mut base, mut file) = (None, None, None, None, None);
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--enable-next" => enabled = true,
            "--offscreen" => offscreen = true,
            flag @ ("--server" | "--review-packet" | "--diff-worktree" | "--diff-base"
            | "--diff-file") => {
                i += 1;
                let value = args
                    .get(i)
                    .filter(|s| !s.is_empty() && !s.starts_with("--"))
                    .ok_or("Missing diff flag value")?
                    .clone();
                match flag {
                    "--server" => server = Some(value),
                    "--review-packet" => packet = Some(value),
                    "--diff-worktree" => worktree = Some(value),
                    "--diff-base" => base = Some(value),
                    _ => file = Some(value),
                }
            }
            _ => {
                return Err(
                    "Diff mode accepts only explicit target, server, opt-in and offscreen flags"
                        .into(),
                );
            }
        }
        i += 1;
    }
    if !enabled {
        return Err("This surface is opt-in; pass --enable-next".into());
    }
    let target = match (packet, worktree) {
        (Some(id), None) if base.is_none() && file.is_none() => Target::Packet(id),
        (None, Some(path)) => Target::Worktree { path, base, file },
        _ => return Err(HELP.into()),
    };
    let client =
        Client::new(&server.ok_or("Pass --server with an explicit disposable server origin")?)?;
    launch(client, target, offscreen);
    Ok(true)
}
