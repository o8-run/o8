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
use std::{
    cell::RefCell,
    collections::{BTreeSet, HashMap},
    rc::Rc,
};

#[path = "diff_ui_scope.rs"]
mod scope;
#[path = "diff_ui_stack.rs"]
mod stack;
pub(crate) use scope::Scope;

pub(crate) struct DiffSurface {
    client: Client,
    pub(crate) target: Target,
    pub(crate) document: Rc<Document>,
    pub(crate) selected: usize,
    pub(crate) split: bool,
    pub(crate) ready: bool,
    /// The last read failed and its error is the notice.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) failed: bool,
    busy: bool,
    generation: u64,
    pending: Option<Value>,
    state: Value,
    pub(crate) notice: String,
    focus: FocusHandle,
    scroll: UniformListScrollHandle,
    pub(crate) painted: Rc<RefCell<BTreeSet<usize>>>,
    /// Working changes: each file's shared diff rows, stacked.
    stack: Rc<Vec<Vec<crate::files_panel::file_diff::Line>>>,
    /// Stacked files the reader opened (`true`) or closed, by path. Every
    /// other file opens while it fits the row budget.
    pub(crate) chosen: HashMap<String, bool>,
    /// Said beside the notice when Expand all left files closed.
    limit_note: Option<String>,
    /// Which working changes the stack shows.
    pub(crate) scope: Scope,
    /// The paths the scope keeps; `None` until its first read lands.
    scope_paths: Option<Rc<BTreeSet<String>>>,
    scope_error: Option<String>,
    scope_generation: u64,
    /// The files list beside the stack: the reader's choice, or else shown
    /// unless the surface is narrow.
    pub(crate) drawer: Option<bool>,
    /// The stack's measured width, for the narrow layout.
    pub(crate) width: gpui::Pixels,
    stack_scroll: gpui::ScrollHandle,
    /// The working changes to go back to from one file's full view.
    pub(crate) stack_target: Option<Target>,
}
/// The line under Review's header once a diff is read. Working changes
/// are never approved, so a part that didn't read cleanly (a hunk read while
/// a file was being rewritten falls short) still shows, with a Refresh hint;
/// a packet keeps its approval gate.
pub(crate) fn notice(target: &Target, document: &Document, label: String) -> String {
    if document.truncated {
        "Diff truncated by server. Approval disabled; inspect a smaller worktree diff.".into()
    } else if !document.unsupported {
        label
    } else if let Target::Worktree { .. } = target {
        format!(
            "{label} · Part of this diff didn't read cleanly, so it shows as read. Refresh to read it again."
        )
    } else {
        "Unsupported patch format. Review disabled; use a plain unified Git diff.".into()
    }
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
            client,
            target,
            document: Rc::new(Document::default()),
            selected: 0,
            split: false,
            ready: false,
            failed: false,
            busy: false,
            generation: 0,
            pending: None,
            state: Value::Null,
            notice: String::new(),
            focus,
            scroll: UniformListScrollHandle::new(),
            painted: Rc::new(RefCell::new(BTreeSet::new())),
            stack: Rc::new(vec![]),
            chosen: HashMap::new(),
            limit_note: None,
            scope: Scope::All,
            scope_paths: None,
            scope_error: None,
            scope_generation: 0,
            drawer: None,
            width: px(0.),
            stack_scroll: gpui::ScrollHandle::new(),
            stack_target: None,
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
        self.failed = false;
        self.pending = None;
        self.notice = "Reading diff…".into();
        if self.stacked() {
            self.read_scope(cx);
        }
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
                        if this.stacked() {
                            // What the reader opened or closed follows each
                            // file's path across a refresh.
                            this.stack = Rc::new(stack::parse(&this.document));
                            let files = &this.document.files;
                            this.chosen
                                .retain(|path, _| files.iter().any(|f| &f.path == path));
                            this.selected = this.selected.min(files.len().saturating_sub(1));
                            this.limit_note = None;
                        }
                        this.state = state;
                        this.ready = true;
                        if this.stacked() {
                            // A refresh keeps the reader's place in the stack.
                            this.painted.borrow_mut().clear();
                        } else {
                            this.select_file(0, cx);
                        }
                        this.notice = notice(&this.target, &this.document, this.state_label());
                    }
                    Err(error) => {
                        this.notice = error;
                        this.failed = true;
                    }
                }
                cx.notify();
            });
        }).detach();
        cx.notify();
    }
    fn state_label(&self) -> String {
        if let Target::Worktree { .. } = self.target {
            let head = &self.document.head[..self.document.head.len().min(12)];
            return match self.document.files.len() {
                0 => format!("No uncommitted changes · HEAD {head}"),
                1 => format!("Working changes · 1 file · HEAD {head}"),
                n => format!("Working changes · {n} files · HEAD {head}"),
            };
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
        if self.stacked() {
            // Walking the list moves to a file without opening it.
            let selected = self.selected;
            self.reveal(selected, false, cx);
            return;
        }
        self.scroll = UniformListScrollHandle::new();
        self.painted.borrow_mut().clear();
        cx.notify();
    }
    pub(crate) fn row_count(&self) -> usize {
        self.document.files.get(self.selected).map_or(0, |f| {
            if self.split {
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
        let painted = self.painted.clone();
        let selected = self.selected;
        let split = self.split;
        let content_width = doc.files.get(selected).map_or(0., |f| {
            (f.width_chars as f32 * 8. + 64.) * if split { 2. } else { 1. }
        });
        let can_review = self.ready
            && !self.busy
            && self.pending.is_none()
            && !doc.truncated
            && !doc.unsupported
            && !doc.files.is_empty()
            && matches!(self.target, Target::Packet(_));
        let stacked = self.stacked();
        let all_open = stacked && self.all_open();
        let shown = Rc::new(self.shown());
        let listed = shown.clone();
        let files = uniform_list(
            "diff-files",
            shown.len(),
            cx.processor(move |s, range: std::ops::Range<usize>, _, cx| {
                range
                    .map(|position| {
                        let i = listed[position];
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
                            .on_click(cx.listener(move |s, _, _, cx| s.pick(i, cx)))
                    })
                    .collect::<Vec<_>>()
            }),
        )
        .w(if stacked { stack::DRAWER } else { px(240.) })
        .flex_shrink_0()
        .h_full();
        let rows = div().flex_1().min_w_0().h_full().child(
            uniform_list("diff-rows", self.row_count(), move |range, _, _| {
                range
                    .map(|i| {
                        let f = &doc.files[selected];
                        let (left, right) = if split { f.split[i] } else { (Some(i), None) };
                        let painted = painted.clone();
                        div()
                            .h(px(20.))
                            .min_w(px(content_width))
                            .flex()
                            .font_family(theme().font_mono)
                            .text_size(px(12.))
                            .line_height(px(20.))
                            .whitespace_nowrap()
                            .child(cell(
                                left.map(|i| &f.lines[i]),
                                split || left.is_some_and(|i| f.lines[i].new.is_none()),
                            ))
                            .when(split, |row| {
                                row.child(cell(right.map(|i| &f.lines[i]), false))
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
            })
            .debug_selector(|| "diff-viewport".into())
            .with_horizontal_sizing_behavior(ListHorizontalSizingBehavior::Unconstrained)
            .track_scroll(self.scroll.clone())
            .size_full(),
        );
        let body = if stacked {
            self.stack_view(files.into_any_element(), cx)
        } else {
            div()
                .flex()
                .flex_1()
                .min_h_0()
                .child(files)
                .child(rows)
                .into_any_element()
        };
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
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                match event.keystroke.key.as_str() {
                    key @ ("home" | "end") if this.stacked() => {
                        let shown = this.shown();
                        let first = if key == "home" {
                            shown.first()
                        } else {
                            shown.last()
                        };
                        if let Some(&index) = first {
                            this.select_file(index, cx);
                        }
                    }
                    "home" => this.scroll_to(0, cx),
                    "end" => this.scroll_to(this.row_count().saturating_sub(1), cx),
                    key @ ("up" | "down") if event.keystroke.modifiers.alt && this.stacked() => {
                        // Steps through the files the scope shows.
                        let shown = this.shown();
                        let at = shown.iter().position(|i| *i >= this.selected);
                        let next = match (key, at) {
                            ("up", Some(at)) => at.checked_sub(1).map(|at| shown[at]),
                            ("down", Some(at)) if shown[at] > this.selected => Some(shown[at]),
                            ("down", Some(at)) => shown.get(at + 1).copied(),
                            // Nothing shown follows a hidden selection: stay.
                            ("down", None) => None,
                            _ => shown.last().copied(),
                        };
                        if let Some(index) = next {
                            this.select_file(index, cx);
                        }
                    }
                    "up" | "down" if event.keystroke.modifiers.alt => {
                        let index = if event.keystroke.key == "up" {
                            this.selected.saturating_sub(1)
                        } else {
                            this.selected + 1
                        };
                        this.select_file(index, cx);
                    }
                    "u" => this.mode(false, cx),
                    "s" => this.mode(true, cx),
                    "r" => this.load(cx),
                    _ => return,
                }
                cx.stop_propagation();
            }))
            .child(
                div()
                    .min_h(px(40.))
                    .flex_shrink_0()
                    .flex()
                    // A narrow pane wraps the buttons instead of clipping them.
                    .flex_wrap()
                    .items_center()
                    .px(px(16.))
                    .py(px(4.))
                    .gap(px(8.))
                    .child("o8 next · Diff")
                    .child(
                        button("diff-unified", "Unified", !split)
                            .on_click(cx.listener(|s, _, _, cx| s.mode(false, cx))),
                    )
                    .child(
                        button("diff-split", "Split", split)
                            .on_click(cx.listener(|s, _, _, cx| s.mode(true, cx))),
                    )
                    .child(
                        button("diff-refresh", "Refresh", false)
                            .on_click(cx.listener(|s, _, _, cx| s.load(cx))),
                    )
                    .when(stacked, |bar| {
                        bar.child(
                            button("diff-drawer", "Files", self.drawer_shown()).on_click(
                                cx.listener(|s, _, _, cx| {
                                    s.drawer = Some(!s.drawer_shown());
                                    cx.notify();
                                }),
                            ),
                        )
                        // An empty scope has nothing to open or close.
                        .when(!shown.is_empty(), |bar| {
                            bar.child(
                                button(
                                    "diff-collapse",
                                    if all_open {
                                        "Collapse all"
                                    } else {
                                        "Expand all"
                                    },
                                    false,
                                )
                                .on_click(cx.listener(
                                    move |s, _, _, cx| {
                                        if all_open {
                                            s.collapse_all();
                                        } else {
                                            s.expand_all();
                                        }
                                        cx.notify();
                                    },
                                )),
                            )
                        })
                        .children(Scope::ORDER.map(|scope| {
                            button(scope.id(), scope.label(), self.scope == scope)
                                .on_click(cx.listener(move |s, _, _, cx| s.set_scope(scope, cx)))
                        }))
                    })
                    .when(self.stack_target.is_some(), |bar| {
                        bar.child(
                            button("diff-back", "All changes", false)
                                .on_click(cx.listener(|s, _, _, cx| s.back_to_stack(cx))),
                        )
                    })
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
                    .child(match &self.limit_note {
                        Some(note) => format!("{} · {note}", self.notice),
                        None => self.notice.clone(),
                    })
                    .when_some(
                        stacked.then(|| self.scope_stale()).flatten(),
                        |row, stale| {
                            row.child(
                                div()
                                    .debug_selector(|| "diff-scope-stale".into())
                                    .text_color(theme().danger)
                                    .child(stale),
                            )
                        },
                    ),
            )
            .child(body)
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
