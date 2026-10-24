use super::*;
use crate::{
    model::Row,
    retained::{RetainedRow, RowState},
    text,
    theme::current as theme,
};
use gpui::{IntoElement, KeyDownEvent, Render, canvas, div, px};
use std::{cell::RefCell, collections::BTreeSet};

fn markdown(body: &str) -> gpui::AnyElement {
    let state = Rc::new(RefCell::new(RowState::new(Row::Message {
        id: "issue-markdown".into(),
        role: "assistant".into(),
        nodes: text::markdown(body),
    })));
    RetainedRow {
        state,
        index: 0,
        painted: Rc::new(RefCell::new(BTreeSet::new())),
    }
    .into_any_element()
}
impl Issues {
    fn marker(&self, id: impl Into<String>) -> gpui::AnyElement {
        let id = id.into();
        let controls = self.painted_controls.clone();
        canvas(
            |_, _, _| (),
            move |_, _, _, _| {
                controls.borrow_mut().insert(id.clone());
            },
        )
        .size(px(1.))
        .into_any_element()
    }
    fn control(
        &self,
        id: impl Into<String>,
        label: impl Into<String>,
    ) -> gpui::Stateful<gpui::Div> {
        let id = id.into();
        div()
            .id(gpui::SharedString::from(id.clone()))
            .debug_selector({
                let id = id.clone();
                move || id.clone()
            })
            .cursor_pointer()
            .on_mouse_down(gpui::MouseButton::Left, |_, window, _| {
                window.prevent_default()
            })
            .px(px(10.))
            .py(px(6.))
            .rounded(px(6.))
            .bg(theme().surface_raised)
            .hover(|style| style.bg(theme().hover))
            .child(label.into())
            .child(self.marker(id))
    }

    fn editor(
        &self,
        id: &'static str,
        name: &str,
        editor: &Entity<Composer>,
        height: f32,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let editor = editor.clone();
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(name.to_owned())
            .child(
                div()
                    .id(id)
                    .debug_selector(move || id.into())
                    .h(px(height))
                    .min_h(px(height))
                    .border_1()
                    .border_color(theme().border)
                    .p(px(6.))
                    .child(editor.clone())
                    .child(self.marker(id))
                    .on_click(
                        cx.listener(move |_, _, window, cx| editor.read(cx).focus.focus(window)),
                    ),
            )
            .into_any_element()
    }
    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key == "escape" {
            self.mode = Mode::List;
            self.focus.focus(window);
            self.changed(cx);
            cx.stop_propagation();
        } else if event.keystroke.key == "backspace"
            && self.mode == Mode::Create
            && self.label.read(cx).focus.is_focused(window)
            && self.label.read(cx).text.is_empty()
        {
            self.labels.pop();
            self.changed(cx);
            cx.stop_propagation();
        }
    }
    fn list_view(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let query = self.search.read(cx).text.trim().to_lowercase();
        let issues: Vec<_> = self
            .issues
            .iter()
            .filter(|i| {
                query.is_empty()
                    || i.title.to_lowercase().contains(&query)
                    || i.number.to_string().contains(&query)
            })
            .cloned()
            .collect();
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(self.editor(
                "issue-search",
                "Search by number or title",
                &self.search,
                46.,
                cx,
            ))
            .when(query.parse::<u64>().is_ok_and(|n| n > 0), |v| {
                v.child(
                    self.control("issue-open-number", format!("Open issue #{query}"))
                        .on_click(cx.listener(move |s, _, _, cx| {
                            if let Ok(number) = s.search.read(cx).text.trim().parse::<u64>() {
                                if number > 0 {
                                    s.detail = None;
                                    s.request(Action::Detail(number), cx);
                                }
                            }
                        })),
                )
            })
            .when(issues.is_empty() && !self.busy, |v| {
                v.child(
                    div()
                        .debug_selector(|| "issue-empty".into())
                        .p(px(20.))
                        .child("No open issues matched this search.")
                        .child(self.marker("issue-empty")),
                )
            })
            .children(issues.into_iter().map(|issue| {
                let number = issue.number;
                let linked = self.linked.as_ref().is_some_and(|i| {
                    i.issue.number == number && Some(i.repo.clone()) == self.slug()
                });
                div()
                    .flex()
                    .gap(px(8.))
                    .items_start()
                    .child(
                        self.control(
                            format!("issue-view-{number}"),
                            format!("#{number} {}", issue.title),
                        )
                        .flex_1()
                        .child(
                            div()
                                .text_size(px(11.))
                                .text_color(theme().text_muted)
                                .child(
                                    issue
                                        .body
                                        .as_deref()
                                        .unwrap_or("")
                                        .chars()
                                        .take(180)
                                        .collect::<String>(),
                                ),
                        )
                        .on_click(cx.listener(move |s, _, _, cx| {
                            s.detail = None;
                            s.request(Action::Detail(number), cx);
                        })),
                    )
                    .child(
                        self.control(
                            format!("issue-link-{number}"),
                            if linked { "Selected" } else { "Link" },
                        )
                        .on_click(
                            cx.listener(move |s, _, window, cx| s.link(issue.clone(), window, cx)),
                        ),
                    )
            }))
            .into_any_element()
    }
    fn detail_view(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let Some(issue) = &self.detail else {
            return div()
                .p(px(20.))
                .child(format!(
                    "{} issue #{}",
                    if self.busy {
                        "Loading"
                    } else {
                        "Failed to load"
                    },
                    self.detail_number.unwrap_or(0)
                ))
                .into_any_element();
        };
        let number = issue.number;
        let repository = &self.repos[self.selected];
        div()
            .debug_selector(move || format!("issue-detail-{number}"))
            .child(self.marker(format!("issue-detail-{number}")))
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(
                div()
                    .text_size(px(20.))
                    .child(format!("#{} {}", issue.number, issue.title)),
            )
            .child(
                div()
                    .text_color(if issue.state == "open" {
                        theme().success
                    } else {
                        theme().accent
                    })
                    .child(format!(
                        "{} · {} · {} · {} comments",
                        issue.state,
                        issue
                            .author
                            .as_str()
                            .or_else(|| issue.author["login"].as_str())
                            .unwrap_or("unknown"),
                        issue.created_at,
                        issue.comments
                    )),
            )
            .child(
                div().flex().gap(px(6.)).flex_wrap().children(
                    issue
                        .labels
                        .iter()
                        .filter_map(|l| l["name"].as_str())
                        .map(|name| {
                            div()
                                .px(px(8.))
                                .py(px(3.))
                                .bg(theme().selection)
                                .child(name.to_owned())
                        }),
                ),
            )
            .child(self.control("issue-github", "GitHub").on_click(cx.listener(
                move |s, _, _, cx| {
                    if let Some(issue) = &s.detail {
                        s.open_url(&issue.url, cx);
                    }
                },
            )))
            .child(div().text_color(theme().text_secondary).child(format!(
                    "{} · {}\n{}\n{}",
                    repository.name,
                    repository.readiness["label"]
                        .as_str()
                        .unwrap_or("Readiness unknown"),
                    repository.readiness["summary"].as_str().unwrap_or(""),
                    repository.readiness["nextAction"].as_str().unwrap_or("")
                )))
            .when(repository.missing(), |v| {
                v.child(
                    div()
                        .debug_selector(|| "issue-checkout-missing".into())
                        .child(self.marker("issue-checkout-missing"))
                        .text_color(theme().warning)
                        .child(
                            "Local checkout is missing. Restore it before launching work there.",
                        ),
                )
            })
            .when(!repository.missing(), |v| {
                v.child(
                    self.control("issue-work", "Work on issue")
                        .on_click(cx.listener(|s, _, window, cx| s.work(window, cx))),
                )
            })
            .child(markdown(
                issue
                    .body
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("No description provided."),
            ))
            .into_any_element()
    }
    fn create_view(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        if let Some(number) = self.created {
            return div()
                .debug_selector(move || format!("issue-created-{number}"))
                .child(self.marker(format!("issue-created-{number}")))
                .p(px(24.))
                .text_color(theme().success)
                .child(format!("Issue #{number} created"))
                .into_any_element();
        }
        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(
                        self.control(
                            "issue-preview",
                            if self.preview { "Edit" } else { "Preview" },
                        )
                        .on_click(cx.listener(|s, _, _, cx| {
                            s.preview = !s.preview;
                            s.changed(cx);
                        })),
                    )
                    .child(
                        self.control(
                            "issue-enhance",
                            if self.busy && self.activity == "Enhancing issue…" {
                                "Enhancing…"
                            } else if self.enhanced {
                                "Enhanced"
                            } else {
                                "Enhance"
                            },
                        )
                        .when(self.busy, |v| v.opacity(0.5))
                        .on_click(cx.listener(|s, _, _, cx| s.request(Action::Enhance, cx))),
                    )
                    .child(
                        self.control(
                            "issue-create",
                            if self.busy && self.activity == "Creating issue…" {
                                "Creating…"
                            } else {
                                "Create issue"
                            },
                        )
                        .when(self.busy, |v| v.opacity(0.5))
                        .on_click(cx.listener(|s, _, _, cx| s.request(Action::Create, cx))),
                    ),
            )
            .when(self.enhanced, |v| {
                v.child(
                    div()
                        .debug_selector(|| "issue-enhanced".into())
                        .child(self.marker("issue-enhanced"))
                        .text_color(theme().success)
                        .child("Enhanced · review before creating"),
                )
            })
            .when(self.preview, |v| {
                v.child(
                    div()
                        .debug_selector(|| "issue-preview-body".into())
                        .child(self.marker("issue-preview-body"))
                        .child(markdown(&format!(
                            "# {}\n\n{}",
                            self.title.read(cx).text,
                            self.body.read(cx).text
                        ))),
                )
            })
            .when(!self.preview, |v| {
                v.child(self.editor("issue-title", "Title", &self.title, 46., cx))
                    .child(self.editor(
                        "issue-body",
                        "Description (Markdown, Shift+Enter for newline)",
                        &self.body,
                        130.,
                        cx,
                    ))
                    .child(
                        div()
                            .flex()
                            .gap(px(6.))
                            .children(self.labels.iter().enumerate().map(|(index, label)| {
                                self.control(format!("issue-label-{index}"), format!("{label} ×"))
                                    .on_click(cx.listener(move |s, _, _, cx| {
                                        if !s.busy && index < s.labels.len() {
                                            s.labels.remove(index);
                                            s.changed(cx);
                                        }
                                    }))
                            })),
                    )
                    .child(self.editor(
                        "issue-label",
                        "Labels (Enter to add)",
                        &self.label,
                        46.,
                        cx,
                    ))
            })
            .into_any_element()
    }
    fn open_url(&self, url: &str, cx: &mut Context<Self>) {
        if let Ok(url) = url::Url::parse(url) {
            if url.scheme() == "https"
                && url.host_str() == Some("github.com")
                && url.username().is_empty()
                && url.password().is_none()
            {
                cx.open_url(url.as_str());
            }
        }
    }
}
impl Render for Issues {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.ensure_worker(window, cx);
        self.painted_controls.borrow_mut().clear();
        let revision = self.revision;
        let painted = self.painted.clone();
        let content = match self.mode {
            Mode::List => self.list_view(cx),
            Mode::Detail => self.detail_view(cx),
            Mode::Create => self.create_view(cx),
            Mode::Worker => div()
                .debug_selector(|| "issue-worker".into())
                .child(self.marker("issue-worker"))
                .size_full()
                .children(self.worker.clone())
                .into_any_element(),
        };
        div()
            .size_full()
            .flex()
            .flex_col()
            .gap(px(8.))
            .bg(theme().background)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .font_weight(gpui::FontWeight::LIGHT)
            .text_size(px(13.))
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(Self::key))
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .flex_wrap()
                    .p(px(8.))
                    .child("Issues")
                    .children(self.repos.iter().enumerate().map(|(index, repo)| {
                        self.control(
                            format!("issue-repo-{index}"),
                            repo.slug().unwrap_or_default(),
                        )
                        .bg(if index == self.selected {
                            theme().selection
                        } else {
                            theme().surface_raised
                        })
                        .on_mouse_down(
                            gpui::MouseButton::Left,
                            cx.listener(move |s, _, window, cx| {
                                window.prevent_default();
                                s.select_repo(index, cx);
                            }),
                        )
                    }))
                    .child(self.control("issue-new", "New issue").on_click(cx.listener(
                        |s, _, _, cx| {
                            if !s.busy {
                                s.mode = Mode::Create;
                                s.created = None;
                                s.error.clear();
                                s.changed(cx);
                            }
                        },
                    )))
                    .child(
                        self.control("issue-back", "Issue list")
                            .on_click(cx.listener(|s, _, _, cx| {
                                s.mode = Mode::List;
                                s.changed(cx);
                            })),
                    )
                    .child(self.control("issue-retry", "Retry").on_click(cx.listener(
                        |s, _, _, cx| {
                            if s.repos.is_empty() {
                                s.load_repos(cx);
                            } else {
                                let action = if s.mode == Mode::Detail {
                                    s.detail_number.map(Action::Detail).unwrap_or(Action::List)
                                } else {
                                    Action::List
                                };
                                s.request(action, cx);
                            }
                        },
                    ))),
            )
            .when(self.busy, |v| {
                v.child(
                    div()
                        .debug_selector(|| "issue-loading".into())
                        .child(self.marker("issue-loading"))
                        .p(px(8.))
                        .child(self.activity),
                )
            })
            .when(!self.busy, |v| {
                v.child(
                    div()
                        .debug_selector(|| "issue-ready".into())
                        .child(self.marker("issue-ready"))
                        .h(px(1.)),
                )
            })
            .when(!self.error.is_empty(), |v| {
                v.child(
                    div()
                        .debug_selector(|| "issue-error".into())
                        .child(self.marker("issue-error"))
                        .p(px(8.))
                        .text_color(theme().danger)
                        .child(format!(
                            "{}{}",
                            self.error,
                            if self.detail.is_some() {
                                " · Showing last successful issue. Refresh failed."
                            } else {
                                ""
                            }
                        )),
                )
            })
            .when(self.repos.is_empty() && !self.busy, |v| {
                v.child("No repos available")
            })
            .child(
                div()
                    .id("issues-scroll")
                    .overflow_y_scroll()
                    .flex_1()
                    .min_h_0()
                    .p(px(12.))
                    .child(content),
            )
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .p(px(8.))
                    .child(
                        div()
                            .debug_selector({
                                let id = self
                                    .linked
                                    .as_ref()
                                    .map(|i| format!("issue-linked-{}", i.issue.number))
                                    .unwrap_or("issue-unlinked".into());
                                move || id.clone()
                            })
                            .child(
                                self.marker(
                                    self.linked
                                        .as_ref()
                                        .map(|i| format!("issue-linked-{}", i.issue.number))
                                        .unwrap_or("issue-unlinked".into()),
                                ),
                            )
                            .child(
                                self.linked
                                    .as_ref()
                                    .map(|i| format!("Linked to #{} in {}", i.issue.number, i.repo))
                                    .unwrap_or("No issue linked yet.".into()),
                            ),
                    )
                    .when(self.linked.is_some(), |v| {
                        v.child(self.control("issue-open-linked", "Open issue").on_click(
                            cx.listener(|s, _, _, cx| {
                                if let Some(i) = &s.linked {
                                    s.open_url(&i.issue.url, cx);
                                }
                            }),
                        ))
                        .child(
                            self.control("issue-clear", "Clear link")
                                .on_click(cx.listener(|s, _, _, cx| {
                                    s.linked = None;
                                    if let Some(worker) = &s.worker {
                                        worker.update(cx, |s, cx| s.shell_link_issue(None, cx));
                                    }
                                    s.changed(cx);
                                })),
                        )
                        .child(
                            self.control("issue-task-composer", "Task composer")
                                .on_click(cx.listener(|s, _, window, cx| {
                                    s.ensure_worker(window, cx);
                                    if s.worker.is_some() {
                                        s.mode = Mode::Worker;
                                    } else {
                                        s.error =
                                            "No workspace worker session is available.".into();
                                    }
                                    s.changed(cx);
                                })),
                        )
                    }),
            )
            .child(canvas(|_, _, _| (), move |_, _, _, _| painted.set(revision)).size(px(1.)))
    }
}
