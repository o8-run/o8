//! Classic QuickDocs groups with pins owned and persisted by the native shell.
use super::{
    CHEVRON_DOWN, CHEVRON_RIGHT,
    search::{Pick, Search, file_color, file_icon},
    status,
};
use crate::{client::Client, theme::current as theme};
use gpui::{prelude::*, *};
use serde_json::Value;

#[derive(Clone)]
struct Doc {
    label: String,
    value: String,
    path: String,
}
#[derive(Clone)]
struct Group {
    label: String,
    entries: Vec<Doc>,
}
fn groups(body: &Value) -> Vec<Group> {
    body["groups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|group| {
            Some(Group {
                label: group["label"].as_str()?.into(),
                entries: group["entries"]
                    .as_array()?
                    .iter()
                    .filter_map(|entry| {
                        Some(Doc {
                            label: entry["label"].as_str()?.into(),
                            value: entry["value"].as_str()?.into(),
                            path: entry["path"].as_str()?.into(),
                        })
                    })
                    .collect(),
            })
        })
        .collect()
}
pub(super) struct PinsChanged(pub Vec<String>);
impl EventEmitter<PinsChanged> for QuickDocs {}
pub(super) struct QuickDocs {
    client: Client,
    workspace: String,
    groups: Vec<Group>,
    pins: Vec<String>,
    expanded: bool,
    pub(super) selected: Option<String>,
    pub(super) picker: Option<Entity<Search>>,
    picker_subscription: Option<Subscription>,
    return_focus: Option<FocusHandle>,
    pub(super) add_focus: FocusHandle,
    close_focus: FocusHandle,
}
impl EventEmitter<Pick> for QuickDocs {}
impl QuickDocs {
    pub(super) fn new(client: Client, workspace: String, cx: &mut Context<Self>) -> Self {
        let docs = Self {
            client,
            workspace,
            groups: vec![],
            pins: vec![],
            expanded: false,
            selected: None,
            picker: None,
            picker_subscription: None,
            return_focus: None,
            add_focus: cx.focus_handle(),
            close_focus: cx.focus_handle(),
        };
        let client = docs.client.clone();
        let workspace = docs.workspace.clone();
        let task = cx.background_executor().spawn(async move {
            client.get::<Value>(
                "/api/v2/files/quick-docs",
                &[("workspace", workspace.as_str())],
            )
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if let Ok(body) = result {
                    this.groups = groups(&body);
                }
                cx.notify();
            });
        })
        .detach();
        docs
    }
    fn sync_picker(&self, cx: &mut Context<Self>) {
        if let Some(picker) = &self.picker {
            picker.update(cx, |picker, cx| {
                picker.pinned = self.pins.clone();
                cx.notify();
            });
        }
    }
    fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.picker = None;
        self.picker_subscription = None;
        if let Some(focus) = self.return_focus.take() {
            focus.focus(window);
        }
        cx.notify();
    }
    fn picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.add_focus.focus(window);
        self.expanded = true;
        self.return_focus = window.focused(cx);
        let picker = cx.new(|cx| {
            let mut search = Search::new(self.client.clone(), self.workspace.clone(), true, cx);
            search.pinned = self.pins.clone();
            search.current = self.selected.clone();
            search.close_focus = Some(self.close_focus.clone());
            search
        });
        picker.read(cx).focus(window);
        self.picker_subscription =
            Some(
                cx.subscribe_in(&picker, window, |this, _, pick: &Pick, window, cx| {
                    this.mutate(pick.0.clone(), true, cx);
                    this.close(window, cx);
                }),
            );
        self.picker = Some(picker);
        cx.notify();
    }
    pub(super) fn set_pins(&mut self, paths: Vec<String>, cx: &mut Context<Self>) {
        self.pins = crate::shell_state::clean_pins(paths);
        self.sync_picker(cx);
        cx.notify();
    }
    fn mutate(&mut self, path: String, pin: bool, cx: &mut Context<Self>) {
        let mut paths = self.pins.clone();
        if pin {
            paths.push(path);
        } else {
            paths.retain(|current| current != &path);
        }
        self.set_pins(paths, cx);
        cx.emit(PinsChanged(self.pins.clone()));
    }
}
fn button(id: impl Into<ElementId>, label: &'static str) -> Stateful<Div> {
    div()
        .id(id)
        .size(px(24.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(5.))
        .cursor_pointer()
        .text_color(theme().text_muted)
        .hover(|d| d.bg(theme().hover))
        .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(label.into())).into())
}
impl Render for QuickDocs {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let total = self.groups.iter().map(|g| g.entries.len()).sum::<usize>() + self.pins.len();
        div()
            .relative()
            .flex_shrink_0()
            .flex()
            .flex_col()
            .border_b_1()
            .border_color(theme().border)
            .child(
                div()
                    .flex()
                    .items_center()
                    .child(
                        div()
                            .id("quick-docs-toggle")
                            .debug_selector(|| "quick-docs-toggle".into())
                            .flex_1()
                            .h(px(30.))
                            .px(px(12.))
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .cursor_pointer()
                            .hover(|d| d.bg(theme().hover))
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .child(crate::icon::stroke(
                                if self.expanded {
                                    CHEVRON_DOWN
                                } else {
                                    CHEVRON_RIGHT
                                },
                                theme().text_muted,
                                10.,
                                2.,
                            ))
                            .child("Quick docs")
                            .child(div().flex_1())
                            .child(total.to_string())
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.expanded = !this.expanded;
                                cx.notify();
                            })),
                    )
                    .child(
                        button("quick-docs-add", "Pin a file").track_focus(&self.add_focus).tab_stop(true).on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| { if matches!(event.keystroke.key.as_str(), "enter" | "space") { this.picker(window, cx); cx.stop_propagation(); } }))
                            .debug_selector(|| "quick-docs-add".into())
                            .child("+")
                            .on_click(cx.listener(|this, _, window, cx| this.picker(window, cx))),
                    ),
            )
            .when(self.expanded, |view| {
                view.child(
                    div()
                        .id("quick-docs-items")
                        .max_h(px(220.))
                        .overflow_y_scroll()
                        // Pins lead the list, so they show without scrolling
                        // past every Quick doc.
                        .when(!self.pins.is_empty(), |d| {
                            d.child(
                                div()
                                    .p(px(6.))
                                    .text_size(px(11.))
                                    .text_color(theme().text_faint)
                                    .child("Pinned files"),
                            )
                        })
                        .children(self.pins.clone().into_iter().enumerate().map(|(i, path)| {
                            let select = path.clone();
                            let unpin = path.clone();
                            div()
                                .mx(px(6.))
                                .flex()
                                .items_center()
                                .rounded(px(5.))
                                .when(self.selected.as_ref() == Some(&path), |d| {
                                    d.bg(theme().selection)
                                })
                                .child(
                                    div()
                                        .id(("pinned-file", i))
                                        .debug_selector(move || format!("pinned-file-{select}"))
                                        .flex_1()
                                        .min_w_0()
                                        .h(px(26.))
                                        .px(px(6.))
                                        .flex()
                                        .items_center()
                                        .gap(px(7.))
                                        .text_size(px(12.))
                                        .text_color(theme().text_secondary)
                                        .cursor_pointer()
                                        .hover(|d| d.bg(theme().hover))
                                        .child(crate::icon::stroke(
                                            file_icon(&path),
                                            file_color(&path),
                                            14.,
                                            1.6,
                                        ))
                                        .child(
                                            div()
                                                .overflow_hidden()
                                                .text_ellipsis()
                                                .whitespace_nowrap()
                                                .child(
                                                    path.rsplit('/')
                                                        .next()
                                                        .unwrap_or(&path)
                                                        .to_owned(),
                                                ),
                                        )
                                        .on_click(cx.listener(move |_, _, _, cx| {
                                            cx.emit(Pick(path.clone()))
                                        })),
                                )
                                .child(
                                    button(("unpin", i), "Unpin file")
                                        .debug_selector({
                                            let path = unpin.clone();
                                            move || format!("unpin-{path}")
                                        })
                                        .child("×")

                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.mutate(unpin.clone(), false, cx)
                                        })),
                                )
                        }))
                        .children(
                            self.groups
                                .clone()
                                .into_iter()
                                .enumerate()
                                .map(|(i, group)| {
                                    div()
                                        .pb(px(6.))
                                        .child(
                                            div()
                                                .h(px(24.))
                                                .px(px(10.))
                                                .text_size(px(11.))
                                                .text_color(theme().text_faint)
                                                .child(group.label),
                                        )
                                        .children(group.entries.into_iter().enumerate().map(
                                            |(j, doc)| {
                                                let path = doc.path.clone();
                                                let selected =
                                                    self.selected.as_ref() == Some(&path);
                                                div()
                                                    .id(("quick-doc", i * 100 + j))
                                                    .debug_selector(move || {
                                                        format!("quick-doc-{path}")
                                                    })
                                                    .min_h(px(36.))
                                                    .px(px(10.))
                                                    .py(px(4.))
                                                    .cursor_pointer()
                                                    .flex()
                                                    .items_center()
                                                    .gap(px(8.))
                                                    .when(selected, |d| d.bg(theme().selection))
                                                    .hover(|d| d.bg(theme().hover))
                                                    .child(
                                                        div()
                                                            .flex_1()
                                                            .min_w_0()
                                                            .flex()
                                                            .flex_col()
                                                            .gap(px(3.))
                                                            .child(
                                                                div()
                                                                    .text_size(px(12.))
                                                                    .text_color(theme().text_muted)
                                                                    .overflow_hidden()
                                                                    .whitespace_nowrap()
                                                                    .text_ellipsis()
                                                                    .child(doc.label),
                                                            )
                                                            .child(
                                                                div()
                                                                    .text_size(px(10.))
                                                                    .font_family(theme().font_mono)
                                                                    .text_color(theme().text_faint)
                                                                    .overflow_hidden()
                                                                    .whitespace_nowrap()
                                                                    .text_ellipsis()
                                                                    .child(doc.value),
                                                            ),
                                                    )
                                                    .child(crate::icon::stroke(
                                                        CHEVRON_RIGHT,
                                                        theme().text_muted,
                                                        13.,
                                                        2.,
                                                    ))
                                                    .on_click(cx.listener(move |_, _, _, cx| {
                                                        cx.emit(Pick(doc.path.clone()))
                                                    }))
                                            },
                                        ))
                                }),
                        )
                        .when(total == 0, |d| {
                            d.child(status("Pin files you reach for often.".into()))
                        }),
                )
            })
            .when_some(self.picker.clone(), |d, picker| {
                d.child(
                    div().absolute().top(px(32.)).right(px(6.)).child(
                        deferred(
                            anchored()
                                .anchor(Corner::TopRight)
                                .snap_to_window_with_margin(px(12.))
                                .child(
                                    div()
                                        .id("quick-doc-picker")
                                        .debug_selector(|| "quick-doc-picker".into())
                                        .w(px(300.))
                                        .h(px(326.))
                                        .occlude()
                                        .bg(crate::theme::popover_background())
                                        .border_1()
                                        .border_color(theme().border)
                                        .rounded(px(12.))
                                        .p(px(8.))
                                        .shadow_lg()
                                        .flex()
                                        .flex_col()
                                        .on_mouse_down_out(
                                            cx.listener(|this, _, window, cx| {
                                                this.close(window, cx)
                                            }),
                                        )
                                        .on_key_down(cx.listener(
                                            |this, event: &KeyDownEvent, window, cx| {
                                                if event.keystroke.key == "tab" && this.close_focus.is_focused(window) {
                                                    if let Some(picker) = &this.picker { picker.read(cx).focus_from_close(event.keystroke.modifiers.shift, window); }
                                                    cx.stop_propagation();
                                                }
                                                if event.keystroke.key == "escape"
                                                    && !this.picker.as_ref().is_some_and(|p| {
                                                        p.read(cx).input.read(cx).composing()
                                                    })
                                                {
                                                    this.close(window, cx);
                                                    cx.stop_propagation();
                                                }
                                            },
                                        ))
                                        .child(
                                            div()
                                                .flex()
                                                .items_center()
                                                .child(
                                                    div()
                                                        .flex_1()
                                                        .text_size(px(12.))
                                                        .text_color(theme().text)
                                                        .child("Pin a file"),
                                                )
                                                .child(
                                                    button("close-pin-picker", "Close file picker").track_focus(&self.close_focus).tab_stop(true).on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| { if matches!(event.keystroke.key.as_str(), "enter" | "space") { this.close(window, cx); cx.stop_propagation(); } }))
                                                        .child("×")
                                                        .on_click(cx.listener(
                                                            |this, _, window, cx| {
                                                                this.close(window, cx)
                                                            },
                                                        )),
                                                ),
                                        )
                                        .child(picker),
                                ),
                        )
                        .with_priority(1),
                    ),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::groups;
    use serde_json::json;
    #[test]
    fn classic_groups_keep_global_absolute_paths_and_repo_paths() {
        let groups = groups(&json!({"groups":[
            {"label":"Global","entries":[{"label":"Global instructions","value":"~/.codex/AGENTS.md","path":"/home/test/.codex/AGENTS.md"}]},
            {"label":"This repo","entries":[{"label":"AGENTS.md","value":"AGENTS.md","path":"AGENTS.md"}]}
        ]}));
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].label, "Global");
        assert_eq!(groups[0].entries[0].path, "/home/test/.codex/AGENTS.md");
        assert_eq!(groups[1].entries[0].path, "AGENTS.md");
    }
}
