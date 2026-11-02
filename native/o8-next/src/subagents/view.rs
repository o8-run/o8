use super::*;
use gpui::{AnyElement, SharedString};
use model::Group;
use std::rc::Rc;

impl Inspector {
    fn button(
        &mut self,
        id: impl Into<String>,
        label: impl Into<SharedString>,
        cx: &mut Context<Self>,
        action: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) -> gpui::Stateful<gpui::Div> {
        let id = id.into();
        let selector = id.clone();
        let label = label.into();
        let focus = self
            .controls
            .entry(id.clone())
            .or_insert_with(|| cx.focus_handle())
            .clone();
        let key_focus = focus.clone();
        let action = Rc::new(action);
        let click = action.clone();
        div()
            .id(SharedString::from(id))
            .debug_selector(move || selector.clone())
            .track_focus(&focus)
            .focusable()
            .cursor_pointer()
            .rounded(px(7.))
            .px(px(8.))
            .py(px(5.))
            .text_size(px(12.))
            .font_weight(gpui::FontWeight::LIGHT)
            .text_color(theme().text_secondary)
            .hover(|v| v.bg(theme().hover))
            .focus(|v| v.bg(theme().selection))
            .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(label.clone())).into())
            .on_click(cx.listener(move |s, _, w, cx| {
                key_focus.focus(w);
                click(s, w, cx);
                cx.stop_propagation();
            }))
            .on_key_down(cx.listener(move |s, e: &KeyDownEvent, w, cx| {
                match e.keystroke.key.as_str() {
                    "enter" | "space" => action(s, w, cx),
                    "tab" => {
                        if e.keystroke.modifiers.shift {
                            w.focus_prev()
                        } else {
                            w.focus_next()
                        }
                    }
                    _ => return,
                }
                cx.stop_propagation();
            }))
    }
    fn index(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let query = self.query.read(cx).text.to_lowercase();
        let mut list = div()
            .id("subagents-list")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .px(px(14.))
            .pb(px(16.));
        let mut count = 0;
        for (group, slug, label) in [
            (Group::Working, "working", "Active"),
            (Group::Attention, "attention", "Needs attention"),
            (Group::Done, "done", "Done"),
        ] {
            let agents = self
                .agents
                .iter()
                .filter(|a| {
                    a.group == group
                        && (query.is_empty()
                            || format!("{} {} {}", a.title, a.runtime, a.status)
                                .to_lowercase()
                                .contains(&query))
                })
                .cloned()
                .collect::<Vec<_>>();
            // Newest first, so the latest work is at the top of each group.
            let mut agents = agents;
            agents.sort_by(|a, b| {
                let at = |agent: &Agent| agent.finished.or(agent.started).unwrap_or(0.);
                at(b).total_cmp(&at(a))
            });
            if agents.is_empty() {
                continue;
            }
            count += agents.len();
            let selector = format!("subagents-group-{slug}-{}", agents.len());
            list = list.child(
                div()
                    .debug_selector(move || selector.clone())
                    .pt(px(16.))
                    .pb(px(6.))
                    .text_size(px(11.))
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .text_color(theme().text_muted)
                    .child(format!("{label} ({})", agents.len())),
            );
            for agent in agents {
                let id = agent.id.clone();
                let label = row_label(&agent);
                let meta = [
                    agent.runtime.clone(),
                    agent.model.clone().unwrap_or_default(),
                ]
                .into_iter()
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
                .join(" · ");
                list = list.child(
                    self.button(
                        format!("subagent-row-{id}"),
                        format!("Open {}", agent.title),
                        cx,
                        move |s, w, cx| s.inspect(Some(id.clone()), w, cx),
                    )
                    .w_full()
                    .px(px(12.))
                    .py(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .child(
                        div()
                            .size(px(6.))
                            .rounded_full()
                            .flex_shrink_0()
                            .bg(color(agent.group)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .child(agent.title),
                            )
                            .when(!meta.is_empty(), |v| {
                                v.child(
                                    div()
                                        .mt(px(3.))
                                        .text_size(px(10.))
                                        .font_weight(gpui::FontWeight(260.))
                                        .text_color(theme().text_muted)
                                        .child(meta),
                                )
                            }),
                    )
                    .child(
                        div()
                            .flex_shrink_0()
                            .whitespace_nowrap()
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .child(label),
                    ),
                );
            }
        }
        if count == 0 && self.loaded {
            list = list.child(
                div()
                    .debug_selector(|| "subagents-empty".into())
                    .py(px(24.))
                    .text_size(px(12.))
                    .text_color(theme().text_muted)
                    .child(if query.is_empty() {
                        "No subagents in this conversation yet."
                    } else {
                        "No matching subagents."
                    }),
            );
        }
        list.into_any_element()
    }
    fn detail_view(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let id = self.selected.clone().unwrap();
        let agent = self.agents.iter().find(|a| a.id == id).cloned();
        let selector = format!("subagents-detail-{id}");
        let mut content = div()
            .debug_selector(move || selector.clone())
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col();
        let Some(agent) = agent else {
            return content.child(div().p(px(16.)).text_size(px(12.)).text_color(theme().text_muted)
                .child(if self.loaded {"This subagent is no longer available in this conversation. Return to the list or refresh."} else {"Reading this subagent…"})).into_any_element();
        };
        let output = self.output();
        content = content.child(
            div()
                .px(px(16.))
                .py(px(12.))
                .flex_shrink_0()
                .border_b_1()
                .border_color(theme().border)
                .child(div().text_size(px(13.5)).child(agent.title.clone()))
                .child(
                    div()
                        .mt(px(4.))
                        .text_size(px(9.5))
                        .text_color(theme().text_muted)
                        .child(
                            [
                                Some(agent.runtime.clone()),
                                agent.model.clone(),
                                agent.effort.clone(),
                            ]
                            .into_iter()
                            .flatten()
                            .collect::<Vec<_>>()
                            .join(" · "),
                        ),
                )
                .child(
                    div()
                        .mt(px(10.))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .child(div().size(px(6.)).rounded_full().bg(color(agent.group)))
                        .child(div().text_size(px(11.)).child(format!(
                            "{} {}",
                            agent.status,
                            timing(&agent)
                        ))),
                )
                .when_some(agent.progress.clone(), |v, progress| {
                    v.child(
                        div()
                            .mt(px(6.))
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .child(progress),
                    )
                })
                .when(!output.is_empty(), |v| {
                    v.child(
                        self.button("subagents-copy", "Copy agent output", cx, |s, _, cx| {
                            let text = s.output();
                            if !text.is_empty() {
                                cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
                                s.copied = true;
                                cx.notify();
                            }
                        })
                        .mt(px(8.))
                        .child(if self.copied {
                            "Copied"
                        } else {
                            "Copy output"
                        }),
                    )
                }),
        );
        if let Some(error) = self.detail_error.clone() {
            content = content.child(
                div()
                    .p(px(16.))
                    .text_size(px(11.))
                    .text_color(theme().danger)
                    .child(error)
                    .child(
                        self.button(
                            "subagents-retry-history",
                            "Retry agent transcript",
                            cx,
                            |s, _, cx| {
                                if s.detail.is_some() {
                                    s.load_older(cx)
                                } else {
                                    s.ensure_detail(cx)
                                }
                            },
                        )
                        .child(if self.detail.is_some() {
                            "Retry earlier messages"
                        } else {
                            "Retry transcript"
                        }),
                    ),
            );
        }
        if let Some(detail) = &self.detail {
            let more = detail
                .transcript
                .as_ref()
                .and_then(|t| t.page.as_ref())
                .is_some_and(|p| p.has_more);
            if more {
                content = content.child(
                    self.button(
                        "subagents-load-older",
                        "Read earlier agent history",
                        cx,
                        |s, _, cx| s.load_older(cx),
                    )
                    .child(if self.detail_pending {
                        "Reading earlier messages…"
                    } else {
                        "Load older"
                    }),
                );
            }
        }
        if let Some(detail) = &self.detail {
            content = content.child(div().flex_1().min_h_0().child(detail.content()));
        } else {
            content = content.child(
                div()
                    .id("subagents-output")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p(px(16.))
                    .text_size(px(13.))
                    .child(output)
                    .child(
                        div()
                            .mt(px(12.))
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .child(if self.detail_pending {
                                "Reading agent transcript…"
                            } else if agent.session.is_none() {
                                "No transcript has been recorded for this agent yet."
                            } else {
                                "Transcript unavailable. Retry to read it."
                            }),
                    ),
            );
        }
        content.into_any_element()
    }
}
impl Render for Inspector {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let title = if self.selected.is_some() {
            self.button("subagents-back", "All subagents", cx, |s, w, cx| {
                s.back(w, cx)
            })
            .child(icon("m15 18-6-6 6-6"))
        } else {
            self.button("subagents-title", "Subagents", cx, |_, _, _| {})
                .child("Subagents")
        };
        let mut body = div()
            .debug_selector(|| "subagents-inspector".into())
            .size_full()
            .min_w_0()
            .flex()
            .flex_col()
            .bg(theme().background)
            .track_focus(&self.focus)
            .key_context("Subagents")
            .on_key_down(cx.listener(|s, e: &KeyDownEvent, w, cx| {
                match e.keystroke.key.as_str() {
                    "escape" if s.selected.is_some() => s.back(w, cx),
                    "escape" => s.close(w, cx),
                    "tab" => {
                        if e.keystroke.modifiers.shift {
                            w.focus_prev()
                        } else {
                            w.focus_next()
                        }
                    }
                    "home" => {
                        if let Some(detail) = &mut s.detail {
                            detail.navigate(false);
                            cx.notify()
                        }
                    }
                    "end" => {
                        if let Some(detail) = &mut s.detail {
                            detail.navigate(true);
                            cx.notify()
                        }
                    }
                    _ => return,
                }
                cx.stop_propagation();
            }))
            .child(
                div()
                    .flex_shrink_0()
                    .px(px(8.))
                    .py(px(7.))
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .child(title)
                    .child(div().flex_1())
                    .when(self.selected.is_none(), |row| {
                        row.child(
                            self.button("subagents-search", "Search subagents", cx, |s, w, cx| {
                                s.search = !s.search;
                                if s.search {
                                    s.back(w, cx);
                                    s.query.read(cx).focus.focus(w);
                                } else {
                                    s.query.update(cx, |q, cx| q.set_text("", cx));
                                    s.focus.focus(w);
                                }
                                cx.notify();
                            })
                            .child(icon("M21 21l-4.3-4.3M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z")),
                        )
                    })
                    .when(self.selected.is_none(), |row| {
                        row.child(
                            self.button(
                                "subagents-refresh",
                                "Refresh subagents",
                                cx,
                                |s, _, cx| s.refresh(cx),
                            )
                            .child(icon("M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5")),
                        )
                    })
                    .child(
                        self.button("subagents-close", "Close subagents", cx, |s, w, cx| {
                            s.close(w, cx)
                        })
                        .child(icon("M18 6 6 18M6 6l12 12")),
                    ),
            )
            .when(self.selected.is_none(), |body| {
                body.child(
                    div()
                        .debug_selector(|| "subagents-summary".into())
                        .px(px(16.))
                        .pb(px(10.))
                        .text_size(px(10.))
                        .text_color(theme().text_muted)
                        .child(if self.loaded {
                            format!(
                                "{} · {}",
                                if self.scope.parent.is_some() {
                                    "This conversation"
                                } else {
                                    "This workspace"
                                },
                                self.summary()
                            )
                        } else {
                            "Reading subagents…".into()
                        }),
                )
            });
        if self.search {
            body = body.child(
                div()
                    .px(px(14.))
                    .pb(px(8.))
                    .h(px(40.))
                    .child(self.query.clone()),
            );
        }
        if let Some(error) = self.error.clone() {
            body = body.child(
                div()
                    .debug_selector(|| "subagents-error".into())
                    .px(px(16.))
                    .py(px(8.))
                    .text_size(px(11.))
                    .text_color(theme().danger)
                    .child(format!(
                        "Could not refresh subagents. Showing the last known state. {error}"
                    )),
            );
        } else if self.loaded {
            body = body.child(
                div()
                    .debug_selector(|| "subagents-current".into())
                    .h(px(0.)),
            );
        }
        let content = if self.selected.is_some() {
            self.detail_view(cx)
        } else {
            self.index(cx)
        };
        body.child(content)
    }
}
fn icon(path: &'static str) -> AnyElement {
    crate::icon::stroke(path, theme().text_muted, 14., 1.8).into_any_element()
}
fn color(group: Group) -> gpui::Rgba {
    match group {
        Group::Working => theme().accent,
        Group::Attention => theme().warning,
        Group::Done => theme().text_muted,
    }
}
/// The row's right side: "Working · 12s", "just now", or what needs attention.
fn row_label(agent: &Agent) -> String {
    match (agent.group, agent.started, agent.finished) {
        (Group::Working, Some(start), _) => format!(
            "{} · {}s",
            agent.status,
            ((crate::clock::now() as f64 * 1000. - start).max(0.) / 1000.) as u64
        ),
        (Group::Done, _, Some(end)) => {
            crate::clock::age(Some((end / 1000.) as u64), crate::clock::now())
        }
        _ => agent.status.clone(),
    }
}
fn timing(agent: &Agent) -> String {
    match (agent.started, agent.finished) {
        (Some(start), Some(end)) => {
            format!("· worked for {}s", ((end - start).max(0.) / 1000.) as u64)
        }
        (Some(start), None) if agent.group == Group::Working => format!(
            "· {}s",
            ((crate::clock::now() as f64 * 1000. - start).max(0.) / 1000.) as u64
        ),
        (_, Some(end)) => crate::clock::age(Some((end / 1000.) as u64), crate::clock::now()),
        _ => String::new(),
    }
}
