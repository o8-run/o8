//! Review outcomes beside Activity, from the same analytics route as classic.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, Div, ScrollHandle, SharedString, Stateful};
use serde::Deserialize;

pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) type View = Scorecard;
pub(super) const REGISTRATION: Registration = Registration {
    create: |shell, _, workspace, _, cx| {
        let client = shell.panel_client(&workspace);
        Some(Content::Scorecard(cx.new(|cx| Scorecard::new(client, cx))))
    },
    ..Registration::new("Review scorecard", "Open Review scorecard", |_, _, _, _| {
        Some((Tab::Scorecard, false))
    })
};
impl ShellView for Scorecard {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).focus.focus(window);
        view.update(cx, |view, cx| view.load(cx));
    }
    fn refresh(view: &Entity<Self>, cx: &mut Context<Shell>) {
        view.update(cx, |view, cx| view.load(cx));
    }
    #[cfg(test)]
    fn ready(view: &Entity<Self>, cx: &App) -> bool {
        !view.read(cx).loading
    }
}

#[derive(Clone, Deserialize)]
struct Entry {
    id: String,
    title: String,
    detail: String,
}
#[derive(Clone, Deserialize)]
struct Metric {
    id: String,
    section: String,
    label: String,
    value: Option<f64>,
    display: String,
    #[serde(default)]
    total: usize,
    note: String,
    changes: Vec<Entry>,
}
#[derive(Deserialize)]
struct Source {
    id: String,
    label: String,
}
#[derive(Deserialize)]
struct Snapshot {
    basis: String,
    sources: Vec<Source>,
    metrics: Vec<Metric>,
}
pub(crate) struct Scorecard {
    client: Client,
    focus: FocusHandle,
    scroll: ScrollHandle,
    range: &'static str,
    source: String,
    selected: Option<String>,
    snapshot: Option<Snapshot>,
    loading: bool,
    error: bool,
    generation: u64,
}
impl Scorecard {
    fn new(client: Client, cx: &mut Context<Self>) -> Self {
        let mut view = Self {
            client,
            focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
            range: "7",
            source: "all".into(),
            selected: None,
            snapshot: None,
            loading: false,
            error: false,
            generation: 0,
        };
        view.load(cx);
        view
    }
    fn load(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        self.loading = true;
        self.error = false;
        self.snapshot = None;
        let (client, range, source) = (self.client.clone(), self.range, self.source.clone());
        let task = cx.background_executor().spawn(async move {
            client.get::<Snapshot>(
                "/api/panel/analytics",
                &[("view", "review"), ("range", range), ("source", &source)],
            )
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.loading = false;
                match result {
                    Ok(snapshot) => this.snapshot = Some(snapshot),
                    Err(_) => this.error = true,
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn control(id: String, selected: bool, cx: &Context<Self>) -> Stateful<Div> {
        let selector = id.clone();
        crate::browser_panel::header::keyboard_button(
            div()
                .id(SharedString::from(id))
                .debug_selector(move || selector.clone())
                .min_w_0()
                .rounded(px(7.))
                .px(px(9.))
                .py(px(5.))
                .text_size(px(12.))
                .font_weight(gpui::FontWeight::LIGHT)
                .cursor_pointer()
                .text_color(if selected {
                    theme().text
                } else {
                    theme().text_muted
                })
                .when(selected, |v| v.bg(theme().selection))
                .hover(|v| v.bg(theme().hover))
                .focus(|v| v.bg(theme().selection)),
            cx,
        )
    }
    fn metric(&self, metric: &Metric, cx: &mut Context<Self>) -> AnyElement {
        let id = metric.id.clone();
        let selected = self.selected.as_ref() == Some(&id);
        let row = Self::control(format!("scorecard-metric-{id}"), selected, cx)
            .w_full()
            .flex()
            .items_center()
            .gap(px(8.))
            .py(px(9.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .child(metric.label.clone()),
            )
            .child(div().flex_shrink_0().child(if metric.value.is_none() {
                "Unavailable".to_owned()
            } else {
                metric.display.clone()
            }))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.selected = if selected { None } else { Some(id.clone()) };
                cx.notify();
            }));
        let mut view = div().flex().flex_col().child(row);
        if selected {
            let mut details = div()
                .debug_selector(|| "scorecard-drilldown".into())
                .px(px(9.))
                .pb(px(16.))
                .flex()
                .flex_col()
                .gap(px(8.))
                .text_size(px(12.))
                .text_color(theme().text_muted)
                .child(
                    div()
                        .when(metric.value.is_none(), |v| {
                            v.debug_selector(|| "scorecard-unavailable".into())
                        })
                        .child(metric.note.clone()),
                );
            if metric.value.is_some() {
                if metric.changes.is_empty() {
                    details = details.child(div().debug_selector(|| "scorecard-empty".into())
                        .child("No changes behind this figure. Complete a review or the recorded step to create an outcome."));
                }
                for entry in &metric.changes {
                    let selector = format!("scorecard-change-{}", entry.id);
                    details = details.child(
                        div()
                            .debug_selector(move || selector.clone())
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .child(
                                div()
                                    .truncate()
                                    .text_color(theme().text)
                                    .child(entry.title.clone()),
                            )
                            .child(div().truncate().child(entry.detail.clone())),
                    );
                }
                if metric.total > metric.changes.len() {
                    details = details.child(
                        div()
                            .debug_selector(|| "scorecard-more".into())
                            .child(format!("and {} more", metric.total - metric.changes.len())),
                    );
                }
            }
            view = view.child(details);
        }
        view.into_any_element()
    }
}
impl Render for Scorecard {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ranges = [("7", "7 days"), ("30", "30 days"), ("all", "All")];
        let mut body =
            div()
                .id("review-scorecard")
                .debug_selector(|| "review-scorecard".into())
                .track_focus(&self.focus)
                .size_full()
                .min_w_0()
                .bg(theme().surface)
                .text_color(theme().text)
                .font_weight(gpui::FontWeight::LIGHT)
                .flex()
                .flex_col()
                .gap(px(16.))
                .p(px(16.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(14.))
                                .child("Review scorecard"),
                        )
                        .child(
                            Self::control("scorecard-refresh".into(), false, cx)
                                .opacity(if self.loading { 0.5 } else { 1. })
                                .child(if self.loading {
                                    "Reading…"
                                } else {
                                    "Refresh"
                                })
                                .on_click(cx.listener(|this, _, _, cx| {
                                    if !this.loading {
                                        this.load(cx);
                                    }
                                })),
                        ),
                )
                .child(div().flex().flex_wrap().gap(px(8.)).children(ranges.map(
                    |(range, label)| {
                        Self::control(format!("scorecard-range-{range}"), self.range == range, cx)
                            .child(label)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if this.range != range {
                                    this.range = range;
                                    this.selected = None;
                                    this.scroll.set_offset(point(px(0.), px(0.)));
                                    this.load(cx);
                                }
                            }))
                    },
                )));
        if self.loading {
            body = body.child(
                div()
                    .text_size(px(12.))
                    .child("Reading saved reviews, approvals and merge receipts…"),
            );
        }
        if self.error {
            body = body.child(
                div()
                    .text_size(px(12.))
                    .child("Could not read review outcomes. Use Refresh to try again."),
            );
        }
        if let Some(snapshot) = &self.snapshot {
            let mut sources = vec![("all".to_owned(), "All sources".to_owned())];
            sources.extend(
                snapshot
                    .sources
                    .iter()
                    .map(|source| (source.id.clone(), source.label.clone())),
            );
            body = body.child(div().flex().flex_wrap().gap(px(8.)).children(
                sources.into_iter().map(|(id, label)| {
                    Self::control(format!("scorecard-source-{id}"), self.source == id, cx)
                        .child(div().truncate().child(label))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if this.source != id {
                                this.source = id.clone();
                                this.selected = None;
                                this.load(cx);
                            }
                        }))
                }),
            ));
            let mut section = String::new();
            let mut rows = Vec::new();
            for metric in &snapshot.metrics {
                if section != metric.section {
                    section = metric.section.clone();
                    rows.push(
                        div()
                            .pt(px(16.))
                            .pb(px(8.))
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .child(section.clone())
                            .into_any_element(),
                    );
                }
                rows.push(self.metric(metric, cx));
            }
            body = body.child(
                div()
                    .id("scorecard-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(theme().text_muted)
                            .pb(px(8.))
                            .child(snapshot.basis.clone()),
                    )
                    .children(rows),
            );
        }
        body
    }
}

#[cfg(test)]
#[path = "scorecard_tests.rs"]
mod tests;
