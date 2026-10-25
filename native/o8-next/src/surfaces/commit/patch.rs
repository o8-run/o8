//! Read-only commit patch view adapted from the existing Apache-2.0 GPUI diff UI.
//! The shared parser, line model and theme remain authoritative; no shared target edits.
use crate::theme::current as theme;
use crate::{
    client::Client,
    diff::{Document, Kind, Line},
};
use gpui::{
    Context, FocusHandle, HighlightStyle, KeyDownEvent, ListHorizontalSizingBehavior, Render,
    ScrollStrategy, StyledText, UniformListScrollHandle, Window, canvas, div, prelude::*, px,
    uniform_list,
};
use std::{cell::RefCell, collections::BTreeSet, rc::Rc};

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Target {
    pub workspace: String,
    pub hash: String,
}
impl Target {
    fn read(&self, client: &Client) -> Result<(Document, serde_json::Value), String> {
        client.commit_diff(&self.workspace, &self.hash)
    }
}

pub(crate) struct DiffSurface {
    client: Client,
    pub(crate) target: Target,
    pub(crate) document: Rc<Document>,
    pub(crate) selected: usize,
    pub(crate) split: bool,
    pub(crate) ready: bool,
    generation: u64,
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
            client,
            target,
            document: Rc::new(Document::default()),
            selected: 0,
            split: false,
            ready: false,
            generation: 0,
            notice: String::new(),
            focus,
            scroll: UniformListScrollHandle::new(),
            painted: Rc::new(RefCell::new(BTreeSet::new())),
        };
        surface.load(cx);
        surface
    }
    pub(crate) fn load(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        self.ready = false;
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
                    Ok((document, _)) => {
                        this.document = Rc::new(document);
                        this.ready = true;
                        this.select_file(0, cx);
                        this.notice = if this.document.truncated {
                            "Diff truncated by server. Approval disabled; inspect a smaller worktree diff.".into()
                        } else if this.document.unsupported {
                            "Unsupported patch format. Review disabled; use a plain unified Git diff.".into()
                        } else { this.state_label() };
                    }
                    Err(error) => this.notice = error,
                }
                cx.notify();
            });
        }).detach();
        cx.notify();
    }
    fn state_label(&self) -> String {
        format!(
            "Read-only · {} files · HEAD {}",
            self.document.files.len(),
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
                    "s" => this.mode(true, cx),
                    "r" => this.load(cx),
                    _ => return,
                }
                cx.stop_propagation();
            }))
            .child(
                div()
                    .h(px(40.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .px(px(16.))
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
                    ),
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
                                            .debug_selector(move || format!("diff-file-{i}"))
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
                            uniform_list("diff-rows", self.row_count(), move |range, _, _| {
                                range
                                    .map(|i| {
                                        let f = &doc.files[selected];
                                        let (left, right) =
                                            if split { f.split[i] } else { (Some(i), None) };
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
                                                split
                                                    || left
                                                        .is_some_and(|i| f.lines[i].new.is_none()),
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
