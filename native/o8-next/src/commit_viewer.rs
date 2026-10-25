//! Original Apache-2.0 commit/workspace viewer. Mutations stay on desktop routes.
use crate::{
    client::Client,
    composer::{Composer, Submit},
    diff::Target,
    diff_ui::DiffSurface,
    theme::current as theme,
};
use gpui::{prelude::*, *};
use serde_json::{Value, json};
use std::{cell::Cell, rc::Rc};
pub(crate) struct Commit {
    client: Client,
    workspace: String,
    hash: String,
    hash_input: Entity<Composer>,
    editor: Entity<Composer>,
    message: Entity<Composer>,
    data: Value,
    compare: Value,
    selected: usize,
    baseline: String,
    loading: bool,
    busy: bool,
    focus_editor: bool,
    patch: Option<Entity<DiffSurface>>,
    show_patch: bool,
    notice: String,
    revision: u64,
    painted: Rc<Cell<u64>>,
    subscriptions: Vec<Subscription>,
}
impl Commit {
    pub(crate) fn new(
        client: Client,
        workspace: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let hash_input = cx.new(Composer::new);
        let editor = cx.new(Composer::source);
        let message = cx.new(Composer::new);
        hash_input.read(cx).focus.focus(window);
        let subscriptions = vec![
            cx.subscribe(&hash_input, |s, _, _: &Submit, cx| s.load(cx)),
            cx.subscribe(&message, |s, _, _: &Submit, cx| s.action("commit", cx)),
            cx.observe(&editor, |s, _, cx| {
                s.revision += 1;
                cx.notify();
            }),
            cx.observe(&message, |s, _, cx| {
                s.revision += 1;
                cx.notify();
            }),
        ];
        Self {
            client,
            workspace,
            hash: String::new(),
            hash_input,
            editor,
            message,
            data: Value::Null,
            compare: Value::Null,
            selected: 0,
            baseline: String::new(),
            loading: false,
            busy: false,
            focus_editor: false,
            patch: None,
            show_patch: false,
            notice: "Open a commit".into(),
            revision: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
            subscriptions,
        }
    }
    pub(crate) fn focus(&self, window: &mut Window, cx: &App) {
        self.hash_input.read(cx).focus.focus(window);
    }
    fn dirty(&self, cx: &App) -> bool {
        !self.compare.is_null() && self.editor.read(cx).text != self.baseline
    }
    fn path(&self) -> Option<&str> {
        self.data["files"]
            .get(self.selected)
            .and_then(|file| file["path"].as_str())
    }
    #[cfg(test)]
    pub(crate) fn test_ready(&self) -> bool {
        !self.loading
            && !self.busy
            && !self.compare.is_null()
            && self.painted.get() == self.revision
    }
    #[cfg(test)]
    pub(crate) fn test_notice(&self) -> &str {
        &self.notice
    }
    fn load(&mut self, cx: &mut Context<Self>) {
        if self.loading || self.busy {
            return;
        }
        if self.dirty(cx) {
            self.notice = "Save workspace changes first.".into();
            cx.notify();
            return;
        }
        let hash = self.hash_input.read(cx).text.trim().to_owned();
        if !(7..=40).contains(&hash.len()) || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            self.data = Value::Null;
            self.compare = Value::Null;
            self.patch = None;
            self.show_patch = false;
            self.notice = "Invalid commit hash".into();
            cx.notify();
            return;
        }
        self.hash = hash.clone();
        self.loading = true;
        self.data = Value::Null;
        self.compare = Value::Null;
        self.patch = None;
        self.show_patch = false;
        self.notice = "Reading commit…".into();
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let task = cx.background_executor().spawn(async move {
            client.get::<Value>(
                &format!("/api/panel/commits/{hash}"),
                &[("workspace", &workspace)],
            )
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |s, cx| {
                s.loading = false;
                match result {
                    Ok(data) if data["commit"].is_object() => {
                        s.data = data["commit"].clone();
                        s.select(0, cx);
                    }
                    Ok(_) => s.notice = "Commit unavailable".into(),
                    Err(error) => s.notice = format!("{error}. Retry Open."),
                }
                s.revision += 1;
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn select(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.loading || self.busy {
            return;
        }
        if self.dirty(cx) {
            self.notice = "Save workspace changes first.".into();
            cx.notify();
            return;
        }
        self.selected = index;
        self.compare = Value::Null;
        let Some(path) = self.path().map(str::to_owned) else {
            self.notice = "Empty commit".into();
            cx.notify();
            return;
        };
        self.loading = true;
        self.notice = "Reading workspace comparison…".into();
        let client = self.client.clone();
        let hash = self.hash.clone();
        let workspace = self.workspace.clone();
        let task = cx.background_executor().spawn(async move {
            client.get::<Value>(
                &format!("/api/panel/commits/{hash}/file"),
                &[("workspace", &workspace), ("path", &path)],
            )
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |s, cx| {
                s.loading = false;
                match result {
                    Ok(data) if data["file"].is_object() => {
                        s.compare = data["file"].clone();
                        s.baseline = s.compare["workspaceContent"]
                            .as_str()
                            .or(s.compare["commitContent"].as_str())
                            .unwrap_or("")
                            .into();
                        s.editor.update(cx, |editor, cx| {
                            editor.clear(cx);
                            editor.text = s.baseline.clone();
                            cx.notify();
                        });
                        s.notice = if s.compare["workspaceExists"] == false {
                            "Workspace file missing"
                        } else {
                            ""
                        }
                        .into();
                        s.focus_editor = true;
                    }
                    Ok(_) => s.notice = "Comparison unavailable".into(),
                    Err(error) => s.notice = format!("{error}. Retry the file."),
                }
                s.revision += 1;
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn action(&mut self, action: &'static str, cx: &mut Context<Self>) {
        if self.loading || self.busy || self.data.is_null() {
            return;
        }
        let dirty = self.dirty(cx);
        let message = self.message.read(cx).text.trim().to_owned();
        if action == "save" && (!dirty || self.path().is_none())
            || action == "commit" && message.is_empty()
            || action == "push" && dirty
        {
            return;
        }
        let content = self.editor.read(cx).text.clone();
        let path = self.path().unwrap_or("").to_owned();
        let workspace = self.workspace.clone();
        let client = self.client.clone();
        self.busy = true;
        self.notice = match action {
            "save" => "Saving…",
            "commit" => "Saving and committing…",
            _ => "Pushing…",
        }
        .into();
        let saved = content.clone();
        let task = cx.background_executor().spawn(async move {
            if action == "save" || action == "commit" && dirty {
                client.viewer_post(
                    "/api/v2/files",
                    &json!({"workspace":workspace,"path":path,"content":saved}),
                )?;
            }
            match action {
                "commit" => client.viewer_post(
                    "/api/review/commit",
                    &json!({"workspace":workspace,"message":message}),
                ),
                "push" => client.viewer_post("/api/review/push", &json!({"workspace":workspace})),
                _ => Ok(json!({"message":"Saved"})),
            }
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |s, cx| {
                s.busy = false;
                match result {
                    Ok(data) => {
                        if action != "push" {
                            s.baseline = content;
                        }
                        if action == "commit" {
                            s.message.update(cx, |input, cx| input.clear(cx));
                        }
                        s.notice = data["message"].as_str().unwrap_or("Done").into();
                    }
                    Err(error) => s.notice = error,
                }
                s.revision += 1;
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}
fn button(id: &'static str, label: &'static str, enabled: bool) -> Stateful<Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .p(px(6.))
        .rounded(px(5.))
        .bg(theme().surface_raised)
        .text_color(if enabled {
            theme().text
        } else {
            theme().text_muted
        })
        .when(enabled, |v| v.cursor_pointer())
        .child(label)
}
impl Render for Commit {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let _ = &self.subscriptions;
        if self.focus_editor {
            self.focus_editor = false;
            self.editor.read(cx).focus.focus(window);
        }
        let dirty = self.dirty(cx);
        let idle = !self.loading && !self.busy;
        let revision = self.revision;
        let painted = self.painted.clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(12.))
            .bg(theme().background)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .text_size(px(13.))
            .capture_key_down(cx.listener(|s, event: &KeyDownEvent, _, cx| {
                if (event.keystroke.modifiers.control || event.keystroke.modifiers.platform)
                    && event.keystroke.key == "s"
                {
                    s.action("save", cx);
                    cx.stop_propagation();
                }
            }))
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .items_center()
                    .child("Commit")
                    .child(
                        div()
                            .debug_selector(|| "commit-hash".into())
                            .flex_1()
                            .child(self.hash_input.clone()),
                    )
                    .child(
                        button("commit-open", "Open", idle)
                            .on_click(cx.listener(|s, _, _, cx| s.load(cx))),
                    )
                    .child(
                        button(
                            "commit-patch",
                            if self.show_patch {
                                "Workspace"
                            } else {
                                "Patch"
                            },
                            idle && !self.data.is_null(),
                        )
                        .on_click(cx.listener(|s, _, window, cx| {
                            if s.data.is_null() {
                                return;
                            }
                            s.show_patch = !s.show_patch;
                            s.focus_editor = !s.show_patch;
                            if s.show_patch && s.patch.is_none() {
                                s.patch = Some(cx.new(|cx| {
                                    DiffSurface::new(
                                        s.client.clone(),
                                        Target::Commit {
                                            workspace: s.workspace.clone(),
                                            hash: s.hash.clone(),
                                        },
                                        window,
                                        cx,
                                    )
                                }));
                            }
                            cx.notify();
                        })),
                    ),
            )
            .when(!self.data.is_null(), |v| {
                v.child(div().child(format!(
                    "{} · {} · +{} −{}",
                    self.data["subject"].as_str().unwrap_or(""),
                    self.data["shortHash"].as_str().unwrap_or(""),
                    self.data["totalAdditions"],
                    self.data["totalDeletions"]
                )))
                .child(div().child(format!(
                    "{} · {}",
                    self.data["author"].as_str().unwrap_or(""),
                    self.data["date"].as_str().unwrap_or("")
                )))
                .when(
                    self.data["body"]
                        .as_str()
                        .is_some_and(|body| !body.trim().is_empty()),
                    |v| v.child(div().child(self.data["body"].as_str().unwrap_or("").to_owned())),
                )
            })
            .child(
                div()
                    .debug_selector(|| "commit-status".into())
                    .child(self.notice.clone()),
            )
            .when(!self.show_patch, |v| {
                v.child(
                    div()
                        .flex()
                        .flex_1()
                        .min_h_0()
                        .gap(px(12.))
                        .child(
                            div()
                                .id("commit-files")
                                .w(px(200.))
                                .overflow_y_scroll()
                                .children(
                                    self.data["files"]
                                        .as_array()
                                        .into_iter()
                                        .flatten()
                                        .enumerate()
                                        .map(|(i, file)| {
                                            div()
                                                .id(i)
                                                .debug_selector(move || format!("commit-file-{i}"))
                                                .p(px(6.))
                                                .bg(if i == self.selected {
                                                    theme().selection
                                                } else {
                                                    theme().background
                                                })
                                                .child(
                                                    file["path"].as_str().unwrap_or("").to_owned(),
                                                )
                                                .on_click(
                                                    cx.listener(move |s, _, _, cx| s.select(i, cx)),
                                                )
                                        }),
                                ),
                        )
                        .when(!self.compare.is_null() && !self.loading, |v| {
                            v.child(
                                div()
                                    .id("commit-snapshot")
                                    .flex_1()
                                    .min_w_0()
                                    .overflow_y_scroll()
                                    .font_family(theme().font_mono)
                                    .child(
                                        self.compare["commitContent"]
                                            .as_str()
                                            .unwrap_or("No commit snapshot")
                                            .to_owned(),
                                    ),
                            )
                            .child(
                                div()
                                    .debug_selector(|| "commit-editor".into())
                                    .flex_1()
                                    .min_w_0()
                                    .font_family(theme().font_mono)
                                    .on_mouse_down(
                                        MouseButton::Left,
                                        cx.listener(|s, _, window, cx| {
                                            window.prevent_default();
                                            s.editor.read(cx).focus.focus(window);
                                        }),
                                    )
                                    .child(self.editor.clone()),
                            )
                        }),
                )
            })
            .when(self.show_patch, |v| {
                v.child(div().flex_1().min_h_0().children(self.patch.clone()))
            })
            .when(!self.data.is_null(), |v| {
                v.child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .items_center()
                        .child(
                            button("commit-save", "Save", idle && dirty)
                                .on_click(cx.listener(|s, _, _, cx| s.action("save", cx))),
                        )
                        .child(
                            div()
                                .debug_selector(|| "commit-message".into())
                                .flex_1()
                                .child(self.message.clone()),
                        )
                        .child(
                            button(
                                "commit-create",
                                "Commit",
                                idle && !self.message.read(cx).text.trim().is_empty(),
                            )
                            .on_click(cx.listener(|s, _, _, cx| s.action("commit", cx))),
                        )
                        .child(
                            button("commit-push", "Push", idle && !dirty)
                                .on_click(cx.listener(|s, _, _, cx| s.action("push", cx))),
                        ),
                )
            })
            .child(canvas(|_, _, _| (), move |_, _, _, _| painted.set(revision)).size(px(1.)))
    }
}
