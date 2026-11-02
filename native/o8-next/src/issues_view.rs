use super::*;
use crate::{
    model::Row,
    retained::{RetainedRow, RowState},
    text,
    theme::current as theme,
};
use gpui::{IntoElement, KeyDownEvent, Render, canvas, div, px};
use std::{cell::RefCell, collections::BTreeSet};

/// Opened, closed or merged, in the colour the rest of the app uses for it.
fn state_tone(state: &str) -> gpui::Rgba {
    match state {
        "open" => theme().success,
        "merged" => theme().accent,
        _ => theme().text_muted,
    }
}
fn title_case(state: &str) -> String {
    let mut letters = state.chars();
    letters
        .next()
        .map(|first| first.to_uppercase().chain(letters).collect())
        .unwrap_or_default()
}
fn age(at: &str) -> String {
    match crate::clock::age(crate::clock::timestamp(at), crate::clock::now()).as_str() {
        "" => String::new(),
        "now" => "just now".into(),
        age => format!("{age} ago"),
    }
}
fn dot(tone: gpui::Rgba, size: f32) -> gpui::Div {
    div().flex_shrink_0().size(px(size)).rounded_full().bg(tone)
}
/// The author's first letter, tinted the same way every time they appear.
fn monogram(author: &str) -> gpui::Div {
    div()
        .flex_shrink_0()
        .size(px(22.))
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .bg(theme().surface_raised)
        .text_size(px(11.))
        .text_color(theme().text_secondary)
        .child(
            author
                .chars()
                .next()
                .map(|letter| letter.to_uppercase().to_string())
                .unwrap_or_default(),
        )
}
fn label_tone(label: &Value) -> gpui::Rgba {
    label["color"]
        .as_str()
        .and_then(|hex| u32::from_str_radix(hex, 16).ok())
        .map(gpui::rgb)
        .unwrap_or(theme().text_muted)
}
impl Issues {
    /// Links need a row index of their own, and a long thread must not parse
    /// again on every paint.
    fn markdown(&self, index: usize, body: &str) -> gpui::AnyElement {
        let mut rendered = self.rendered.borrow_mut();
        // The create preview adds an entry on every keystroke.
        if rendered.len() > 256 {
            rendered.clear();
        }
        let state = rendered
            .entry(body.to_owned())
            .or_insert_with(|| {
                Rc::new(RefCell::new(RowState::new(Row::Message {
                    id: "issue-markdown".into(),
                    role: "assistant".into(),
                    author: None,
                    nodes: text::markdown(body),
                })))
            })
            .clone();
        RetainedRow {
            state,
            index,
            painted: Rc::new(RefCell::new(BTreeSet::new())),
        }
        .into_any_element()
    }
    /// One voice in the thread: who, when, what they said.
    fn entry(
        &self,
        id: String,
        index: usize,
        author: &str,
        when: String,
        body: &str,
    ) -> gpui::AnyElement {
        div()
            .debug_selector({
                let id = id.clone();
                move || id.clone()
            })
            .child(self.marker(id))
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .text_size(px(12.))
                    .child(monogram(author))
                    .child(div().text_color(theme().text).child(author.to_owned()))
                    .child(div().text_color(theme().text_muted).child(when)),
            )
            .child(self.markdown(index, body))
            .into_any_element()
    }
    fn linked_work(&self, items: &[crate::issues::LinkedItem]) -> gpui::AnyElement {
        div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .pb(px(4.))
                    .child("Linked work"),
            )
            .children(items.iter().map(|item| {
                let id = format!("issue-linked-item-{}", item.number);
                let url = item.url.clone();
                let tone = state_tone(&item.state);
                div()
                    .id(gpui::SharedString::from(id.clone()))
                    .debug_selector({
                        let id = id.clone();
                        move || id.clone()
                    })
                    .child(self.marker(id))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .px(px(8.))
                    .py(px(5.))
                    .mx(px(-8.))
                    .rounded(px(6.))
                    .cursor_pointer()
                    .text_size(px(12.))
                    .hover(|style| style.bg(theme().hover))
                    .on_click(move |_, window, cx| crate::ui::open_link(&url, window, cx))
                    .child(dot(tone, 7.))
                    .child(
                        div()
                            .flex_shrink_0()
                            .text_color(theme().text_muted)
                            .child(format!("#{}", item.number)),
                    )
                    .child(div().flex_1().min_w_0().truncate().child(item.title.clone()))
                    .child(
                        div()
                            .flex_shrink_0()
                            .text_size(px(11.))
                            .text_color(tone)
                            .child(format!(
                                "{} · {}",
                                if item.kind == "pull" { "PR" } else { "Issue" },
                                title_case(&item.state)
                            )),
                    )
            }))
            .into_any_element()
    }
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
        self.bare_control(id, label)
            .bg(theme().surface_raised)
            .hover(|style| style.bg(theme().hover))
    }
    /// A control that brings its own surface and hover.
    fn bare_control(
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
            // The status line above already says it is loading.
            if self.single && self.busy {
                return div().into_any_element();
            }
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
        let author = issue
            .author
            .as_str()
            .or_else(|| issue.author["login"].as_str())
            .unwrap_or("unknown");
        let tone = state_tone(&issue.state);
        let mut meta = vec![format!("{author} opened {}", age(&issue.created_at))];
        if issue.comments > 0 {
            meta.push(format!(
                "{} comment{}",
                issue.comments,
                if issue.comments == 1 { "" } else { "s" }
            ));
        }
        if !issue.assignees.is_empty() {
            meta.push(format!("Assigned to {}", issue.assignees.join(", ")));
        }
        let divider = || div().h(px(1.)).bg(theme().border);
        div()
            .debug_selector(move || format!("issue-detail-{number}"))
            .child(self.marker(format!("issue-detail-{number}")))
            .flex()
            .flex_col()
            .gap(px(14.))
            .px(px(6.))
            .pb(px(20.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .text_size(px(12.))
                    .child(
                        self.bare_control(
                            "issue-github",
                            format!("{} #{number} ↗", self.slug().unwrap_or_default()),
                        )
                            .px(px(0.))
                            .py(px(0.))
                            .text_color(theme().text_muted)
                            .on_click(cx.listener(move |s, _, _, cx| {
                                if let Some(issue) = &s.detail {
                                    s.open_url(&issue.url, cx);
                                }
                            })),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .text_color(tone)
                            .child(dot(tone, 7.))
                            .child(title_case(&issue.state)),
                    )
                    .child(div().flex_1())
                    .when(!repository.missing(), |v| {
                        v.child(
                            self.bare_control("issue-work", "Work on issue")
                                .bg(theme().accent)
                                .text_color(crate::theme::on_accent())
                                .hover(|style| style.opacity(0.9))
                                .on_click(cx.listener(|s, _, window, cx| s.work(window, cx))),
                        )
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .text_size(px(17.))
                            .line_height(gpui::relative(1.3))
                            .child(issue.title.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(theme().text_muted)
                            .child(meta.join(" · ")),
                    ),
            )
            .when(!issue.labels.is_empty(), |v| {
                v.child(div().flex().gap(px(6.)).flex_wrap().children(
                    issue.labels.iter().filter(|l| l["name"].is_string()).map(|label| {
                        div()
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .px(px(8.))
                            .py(px(2.))
                            .rounded(px(10.))
                            .bg(theme().surface_raised)
                            .text_size(px(11.))
                            .text_color(theme().text_secondary)
                            .child(dot(label_tone(label), 7.))
                            .child(label["name"].as_str().unwrap_or("").to_owned())
                    }),
                ))
            })
            .when(repository.missing(), |v| {
                v.child(
                    div()
                        .debug_selector(|| "issue-checkout-missing".into())
                        .child(self.marker("issue-checkout-missing"))
                        .text_size(px(12.))
                        .text_color(theme().warning)
                        .child(
                            "Local checkout is missing. Restore it before launching work there.",
                        ),
                )
            })
            .when(!issue.linked.is_empty(), |v| {
                v.child(divider()).child(self.linked_work(&issue.linked))
            })
            .child(divider())
            .child(
                self.entry(
                    "issue-body".into(),
                    0,
                    author,
                    age(&issue.created_at),
                    issue
                        .body
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .unwrap_or("No description provided."),
                ),
            )
            .children(issue.discussion.iter().enumerate().flat_map(|(index, comment)| {
                [
                    divider().into_any_element(),
                    self.entry(
                        format!("issue-comment-{index}"),
                        index + 1,
                        &comment.author,
                        age(&comment.created_at),
                        &comment.body,
                    ),
                ]
            }))
            .when(issue.discussion_incomplete, |v| {
                v.child(
                    div()
                        .debug_selector(|| "issue-discussion-incomplete".into())
                        .child(self.marker("issue-discussion-incomplete"))
                        .text_size(px(12.))
                        .text_color(theme().text_muted)
                        .child("Some of this discussion is available only on GitHub."),
                )
            })
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
                        .child(self.markdown(0, &format!(
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
            _ if self.single => self.detail_view(cx),
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
            .when(!self.single, |v| {
                v.child(
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
            })
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
            .when(self.single && !self.busy && !self.error.is_empty(), |v| {
                v.child(
                    div()
                        .px(px(8.))
                        .child(
                            self.control("issue-retry", "Try again")
                                .on_click(cx.listener(|s, _, _, cx| {
                                    if s.repos.is_empty() {
                                        s.load_repos(cx);
                                    } else if let Some(number) = s.detail_number {
                                        s.request(Action::Detail(number), cx);
                                    }
                                })),
                        ),
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
            .when(!self.single, |v| {
                v.child(
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
                                        .map(|i| {
                                            format!("Linked to #{} in {}", i.issue.number, i.repo)
                                        })
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
            })
            .child(canvas(|_, _, _| (), move |_, _, _, _| painted.set(revision)).size(px(1.)))
    }
}
