//! ChangesList and workspace DiffViewer, reachable from the Files/Changes switch.
use super::file_diff::{self, Line};
use super::*;
#[derive(Clone)]
struct Changed {
    path: String,
    status: String,
    add: u64,
    del: u64,
}
enum Diff {
    None,
    Loading,
    Ready(Vec<Line>, bool),
    Failed(String),
}
pub(super) struct Changes {
    client: Client,
    workspace: String,
    files: Vec<Changed>,
    loading: bool,
    error: Option<String>,
    selected: Option<String>,
    diff: Diff,
    generation: u64,
    list_generation: u64,
    split: bool,
    width: gpui::Pixels,
    pub focus: FocusHandle,
}
impl Changes {
    pub(super) fn new(client: Client, workspace: String, cx: &mut Context<Self>) -> Self {
        let mut changes = Self {
            client,
            workspace,
            files: vec![],
            loading: false,
            error: None,
            selected: None,
            diff: Diff::None,
            generation: 0,
            list_generation: 0,
            split: false,
            width: px(0.),
            focus: cx.focus_handle(),
        };
        changes.refresh(cx);
        changes
    }
    pub(super) fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.loading {
            return;
        }
        if self.workspace.is_empty() {
            self.error = Some("Select a repo to inspect changes.".into());
            return;
        }
        self.loading = true;
        self.error = None;
        self.list_generation += 1;
        let generation = self.list_generation;
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let task = cx.background_executor().spawn(async move {
            client.get::<Value>(
                "/api/review/workspace",
                &[("workspace", workspace.as_str()), ("changesOnly", "1")],
            )
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.list_generation {
                    return;
                }
                this.loading = false;
                match result {
                    Ok(body) if body["error"].is_null() => {
                        this.files = body["changedFiles"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|f| {
                                Some(Changed {
                                    path: f["path"].as_str()?.into(),
                                    status: f["status"].as_str().unwrap_or("modified").into(),
                                    add: f["additions"].as_u64().unwrap_or(0),
                                    del: f["deletions"].as_u64().unwrap_or(0),
                                })
                            })
                            .collect();
                    }
                    Ok(body) => {
                        this.error = Some(
                            body["error"]
                                .as_str()
                                .unwrap_or("Unable to load workspace changes.")
                                .into(),
                        )
                    }
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
        if let Some(path) = self.selected.clone() {
            self.select(path, cx);
        }
        cx.notify();
    }
    fn select(&mut self, path: String, cx: &mut Context<Self>) {
        if self.selected.as_ref() == Some(&path) && matches!(self.diff, Diff::Loading) {
            return;
        }
        self.selected = Some(path.clone());
        self.diff = Diff::Loading;
        self.generation += 1;
        let generation = self.generation;
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let work = cx.background_executor().spawn(async move {
            let body: Value = client.get(
                "/api/panel/file-diff",
                &[("path", path.as_str()), ("workspace", workspace.as_str())],
            )?;
            if let Some(error) = body["error"].as_str() {
                return Err(error.to_owned());
            }
            let diff = body["diff"]
                .as_str()
                .filter(|d| !d.is_empty())
                .or_else(|| body["stagedDiff"].as_str())
                .unwrap_or("");
            Ok::<_, String>((
                if diff.is_empty() {
                    vec![]
                } else {
                    file_diff::parse(diff)
                },
                body["diffStatus"] == "truncated" || body["truncated"] == true,
            ))
        });
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                this.diff = match result {
                    Ok((lines, truncated)) => Diff::Ready(lines, truncated),
                    Err(error) => Diff::Failed(error),
                };
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn inventory(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        if self.loading {
            return note("Loading changes...", false).into_any_element();
        }
        if let Some(error) = &self.error {
            return div()
                .flex()
                .flex_col()
                .child(note(error, true))
                .child(
                    button("files-changes-retry", "Retry", false, cx)
                        .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
                )
                .into_any_element();
        }
        if self.files.is_empty() {
            return note("Working tree clean", false)
                .debug_selector(|| "files-changes-clean".into())
                .into_any_element();
        }
        let add: u64 = self.files.iter().map(|f| f.add).sum();
        let del: u64 = self.files.iter().map(|f| f.del).sum();
        #[cfg(test)]
        cx.set_global(super::tests::changes_tests::Inventory(
            self.files
                .iter()
                .map(|f| (f.path.clone(), f.status.clone(), f.add, f.del))
                .collect(),
        ));
        div()
            .debug_selector(|| "files-changes-list".into())
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .child(
                div()
                    .debug_selector(|| "files-changes-totals".into())
                    .h(px(32.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(10.))
                    .px(px(10.))
                    .border_b_1()
                    .border_color(theme().border)
                    .child(
                        div()
                            .text_size(px(10.))
                            .text_color(theme().text_faint)
                            .child(format!(
                                "{} {}",
                                self.files.len(),
                                if self.files.len() == 1 {
                                    "file"
                                } else {
                                    "files"
                                }
                            )),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(7.))
                            .font_family(theme().font_mono)
                            .text_size(px(9.5))
                            .child(div().text_color(theme().success).child(format!("+{add}")))
                            .child(div().text_color(theme().danger).child(format!("-{del}"))),
                    ),
            )
            .child(
                div()
                    .id("files-changes-rows")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .px(px(5.))
                    .pt(px(5.))
                    .pb(px(8.))
                    .children(self.files.iter().map(|file| {
                        let path = file.path.clone();
                        let key_path = path.clone();
                        let selected = self.selected.as_ref() == Some(&path);
                        let accent = match file.status.as_str() {
                            "added" | "untracked" => theme().success,
                            "deleted" => theme().danger,
                            "renamed" => crate::theme::brand_orange(),
                            _ => theme().accent,
                        };
                        let marker = match file.status.as_str() {
                            "added" => "+",
                            "deleted" => "-",
                            "renamed" => "r",
                            "untracked" => "?",
                            _ => "",
                        };
                        let (directory, name) = path.rsplit_once('/').unwrap_or(("", &path));
                        div()
                            .id(SharedString::from(path.clone()))
                            .debug_selector({
                                let path = path.clone();
                                move || format!("files-change-{path}")
                            })
                            .focusable()
                            .relative()
                            .min_h(px(40.))
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .pl(px(6.))
                            .pr(px(8.))
                            .py(px(4.))
                            .rounded(px(8.))
                            .border_1()
                            .border_color(if selected {
                                theme().border
                            } else {
                                crate::theme::CLEAR
                            })
                            .cursor_pointer()
                            .when(selected, |d| d.bg(theme().surface))
                            .hover(|d| d.bg(theme().hover))
                            .focus(|d| d.border_color(theme().accent))
                            .when(selected, |d| {
                                d.child(
                                    div()
                                        .absolute()
                                        .left_0()
                                        .top_0()
                                        .bottom_0()
                                        .w(px(2.))
                                        .bg(accent),
                                )
                            })
                            .tooltip({
                                let path = path.clone();
                                move |_, cx| {
                                    cx.new(|_| crate::icon::Tip(path.clone().into())).into()
                                }
                            })
                            .child(
                                div()
                                    .relative()
                                    .size(px(17.))
                                    .flex_shrink_0()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(crate::icon::stroke(
                                        file_icon(&path),
                                        if selected { accent } else { theme().text_faint },
                                        14.,
                                        1.6,
                                    ))
                                    .child(
                                        div()
                                            .absolute()
                                            .right(px(-2.))
                                            .bottom(px(-2.))
                                            .size(px(if marker.is_empty() { 5. } else { 8. }))
                                            .rounded_full()
                                            .bg(accent)
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .font_family(theme().font_mono)
                                            .font_weight(gpui::FontWeight(850.))
                                            .text_size(px(if marker == "r" { 5.5 } else { 6.5 }))
                                            .text_color(crate::theme::on_accent())
                                            .child(marker),
                                    ),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .flex_col()
                                    .gap(px(2.))
                                    .child(
                                        div()
                                            .text_size(px(13.5))
                                            .line_height(px(16.875))
                                            .font_weight(gpui::FontWeight::LIGHT)
                                            .text_color(theme().text)
                                            .overflow_hidden()
                                            .whitespace_nowrap()
                                            .text_ellipsis()
                                            .child(name.to_owned()),
                                    )
                                    .when(!directory.is_empty(), |d| {
                                        d.child(
                                            div()
                                                .font_family(theme().font_mono)
                                                .text_size(px(9.5))
                                                .font_weight(gpui::FontWeight(260.))
                                                .text_color(theme().text_faint)
                                                .overflow_hidden()
                                                .whitespace_nowrap()
                                                .text_ellipsis()
                                                .child(directory.to_owned()),
                                        )
                                    }),
                            )
                            .child(
                                div()
                                    .flex()
                                    .gap(px(5.))
                                    .flex_shrink_0()
                                    .font_family(theme().font_mono)
                                    .text_size(px(9.5))
                                    .when(file.add > 0, |d| {
                                        d.child(
                                            div()
                                                .text_color(theme().success)
                                                .child(format!("+{}", file.add)),
                                        )
                                    })
                                    .when(file.del > 0, |d| {
                                        d.child(
                                            div()
                                                .text_color(theme().danger)
                                                .child(format!("-{}", file.del)),
                                        )
                                    }),
                            )
                            .on_click(
                                cx.listener(move |this, _, _, cx| this.select(path.clone(), cx)),
                            )
                            .on_key_down(cx.listener(
                                move |this, event: &gpui::KeyDownEvent, _, cx| {
                                    if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                        this.select(key_path.clone(), cx);
                                        cx.stop_propagation();
                                    }
                                },
                            ))
                    })),
            )
            .into_any_element()
    }
}
impl Render for Changes {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let width = if self.width > px(0.) {
            f32::from(self.width)
        } else {
            crate::theme::right_panel_width(f32::from(window.viewport_size().width))
        };
        let measured = cx.entity().downgrade();
        let tree = (width * 0.34).max((width * 0.48).min(210.));
        #[cfg(test)]
        if let Diff::Ready(lines, _) = &self.diff {
            cx.set_global(super::tests::changes_tests::Rendered(
                lines
                    .iter()
                    .map(|l| (l.text.to_string(), l.old, l.new))
                    .collect(),
            ));
        }
        let body = match &self.diff {
            Diff::None => note("Select a file to inspect.", false).into_any_element(),
            Diff::Loading => note("Loading diff...", false).into_any_element(),
            Diff::Failed(error) => div()
                .flex()
                .flex_col()
                .child(note(error, true))
                .child(
                    button("files-diff-retry", "Retry", false, cx).on_click(cx.listener(
                        |this, _, _, cx| {
                            if let Some(path) = this.selected.clone() {
                                this.select(path, cx)
                            }
                        },
                    )),
                )
                .into_any_element(),
            Diff::Ready(lines, _) if lines.is_empty() => {
                note("No diff available for this file.", false)
                    .debug_selector(|| "files-diff-empty".into())
                    .into_any_element()
            }
            Diff::Ready(lines, _) => file_diff::view(lines, self.split),
        };
        div()
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .child(
                gpui::canvas(
                    |_, _, _| (),
                    move |bounds, _, _, cx| {
                        let _ = measured.update(cx, |this, cx| {
                            let width = bounds.size.width.floor();
                            if this.width != width {
                                this.width = width;
                                cx.notify();
                            }
                        });
                    },
                )
                .absolute()
                .size_full(),
            )
            .min_w_0()
            .min_h_0()
            .flex()
            .font_family(theme().font_ui)
            .font_weight(gpui::FontWeight::LIGHT)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .h(px(40.))
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .px(px(12.))
                            .border_b_1()
                            .border_color(theme().border)
                            .child(super::viewer::file_heading(
                                self.selected.as_deref().unwrap_or("Changes"),
                                cx,
                            ))
                            .child(
                                button("files-diff-unified-toggle", "Unified", !self.split, cx)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.split = false;
                                        cx.notify();
                                    })),
                            )
                            .child(
                                button("files-diff-side-toggle", "Side-by-side", self.split, cx)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.split = true;
                                        cx.notify();
                                    })),
                            ),
                    )
                    .when(matches!(self.diff, Diff::Ready(_, true)), |d| {
                        d.child(note("Diff truncated.", false))
                    })
                    .child(body),
            )
            .child(
                div()
                    .w(px(tree))
                    .max_w(gpui::relative(0.48))
                    .flex_shrink_0()
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .border_l_1()
                    .border_color(theme().border)
                    .child(
                        div()
                            .h(px(32.))
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .px(px(10.))
                            .gap(px(8.))
                            .text_size(px(11.))
                            .child(div().flex_1().child("Changes"))
                            .child(
                                button("files-changes-refresh", "Refresh", false, cx)
                                    .when(!self.loading, |d| {
                                        d.on_click(cx.listener(|this, _, _, cx| this.refresh(cx)))
                                    })
                                    .when(self.loading, |d| d.opacity(0.5)),
                            ),
                    )
                    .child(self.inventory(cx)),
            )
    }
}
fn button(
    id: &'static str,
    text: &str,
    active: bool,
    cx: &mut Context<Changes>,
) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .focusable()
        .min_h(px(24.))
        .px(px(7.))
        .flex()
        .items_center()
        .rounded(px(6.))
        .text_size(px(11.))
        .text_color(if active {
            theme().accent
        } else {
            theme().text_muted
        })
        .when(active, |d| d.bg(theme().selection))
        .cursor_pointer()
        .hover(|d| d.bg(theme().hover))
        .active(|d| d.bg(theme().selection))
        .focus(|d| d.border_1().border_color(theme().accent))
        .child(text.to_owned())
        .on_key_down(cx.listener(move |this, event: &gpui::KeyDownEvent, _, cx| {
            if !matches!(event.keystroke.key.as_str(), "enter" | "space") {
                return;
            }
            match id {
                "files-changes-retry" | "files-changes-refresh" => this.refresh(cx),
                "files-diff-retry" => {
                    if let Some(path) = this.selected.clone() {
                        this.select(path, cx);
                    }
                }
                "files-diff-unified-toggle" => this.split = false,
                "files-diff-side-toggle" => this.split = true,
                _ => {}
            }
            cx.notify();
            cx.stop_propagation();
        }))
}

fn note(text: &str, error: bool) -> gpui::Div {
    div()
        .px(px(14.))
        .py(px(16.))
        .text_size(px(12.))
        .text_color(if error {
            theme().danger
        } else {
            theme().text_muted
        })
        .child(text.to_owned())
}
