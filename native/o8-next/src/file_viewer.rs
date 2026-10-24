//! Original Apache-2.0 file editor using the existing operator routes and GPUI input.
use crate::{
    client::Client,
    composer::{Composer, Submit},
    theme::current as theme,
};
use gpui::{prelude::*, *};
use serde_json::{Value, json};
use std::{cell::Cell, rc::Rc};

pub(crate) struct Files {
    client: Client,
    workspace: String,
    path_input: Entity<Composer>,
    editor: Entity<Composer>,
    path: String,
    baseline: String,
    hash: Option<String>,
    conflict: Option<Value>,
    loading: bool,
    saving: bool,
    ready: bool,
    truncated: bool,
    focus_editor: bool,
    notice: String,
    revision: u64,
    painted: Rc<Cell<u64>>,
    subscriptions: Vec<Subscription>,
}
impl Files {
    #[cfg(test)]
    pub(crate) fn test_ready(&self, path: &str, truncated: bool) -> bool {
        self.path == path
            && self.ready
            && !self.loading
            && !self.saving
            && self.truncated == truncated
    }
    pub(crate) fn new(
        client: Client,
        workspace: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let path_input = cx.new(Composer::new);
        let editor = cx.new(Composer::source);
        path_input.read(cx).focus.focus(window);
        let subscriptions = vec![
            cx.subscribe(&path_input, |this, _, _: &Submit, cx| this.load(cx)),
            cx.observe(&editor, |this, _, cx| {
                this.revision += 1;
                cx.notify();
            }),
        ];
        Self {
            client,
            workspace,
            path_input,
            editor,
            path: String::new(),
            baseline: String::new(),
            hash: None,
            conflict: None,
            loading: false,
            saving: false,
            ready: false,
            truncated: false,
            focus_editor: false,
            notice: "Open a workspace file".into(),
            revision: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
            subscriptions,
        }
    }
    pub(crate) fn focus(&self, window: &mut Window, cx: &App) {
        if self.ready && !self.truncated {
            self.editor.read(cx).focus.focus(window);
        } else {
            self.path_input.read(cx).focus.focus(window);
        }
    }
    fn dirty(&self, cx: &App) -> bool {
        self.ready && self.editor.read(cx).text != self.baseline
    }
    fn load(&mut self, cx: &mut Context<Self>) {
        if self.loading || self.saving {
            return;
        }
        if self.dirty(cx) {
            self.notice = "Save changes before opening or reloading a file.".into();
            cx.notify();
            return;
        }
        let path = self.path_input.read(cx).text.trim().to_owned();
        if path.is_empty() {
            return;
        }
        self.path = path.clone();
        self.loading = true;
        self.ready = false;
        self.conflict = None;
        self.notice = "Reading file…".into();
        self.revision += 1;
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let task = cx.background_executor().spawn(async move {
            client.get::<Value>(
                "/api/panel/file-content",
                &[("path", &path), ("workspace", &workspace)],
            )
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                match result {
                    Ok(data) => {
                        if let Some(content) = data["content"].as_str() {
                            this.baseline = content.into();
                            this.hash = data["contentHash"].as_str().map(str::to_owned);
                            this.truncated = data["truncated"] == true;
                            this.ready = true;
                            this.focus_editor = true;
                            this.editor.update(cx, |editor, cx| {
                                editor.clear(cx);
                                editor.text = content.into();
                                cx.notify();
                            });
                            this.notice = if this.truncated {
                                "File truncated by server. Saving disabled."
                            } else if content.is_empty() {
                                "Empty file"
                            } else {
                                ""
                            }
                            .into();
                        } else {
                            this.notice = "Could not read file. Retry.".into();
                        }
                    }
                    Err(error) => this.notice = format!("{error}. Retry."),
                }
                this.revision += 1;
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn save(&mut self, force: bool, cx: &mut Context<Self>) {
        if !self.ready
            || self.truncated
            || self.loading
            || self.saving
            || (!force && (!self.dirty(cx) || self.conflict.is_some()))
        {
            return;
        }
        let content = self.editor.read(cx).text.clone();
        let mut body = json!({"path":self.path,"workspace":self.workspace,"content":content});
        if let Some(hash) = &self.hash {
            body["expectedHash"] = json!(hash);
        }
        if force {
            body["force"] = json!(true);
        }
        self.saving = true;
        self.notice = "Saving…".into();
        self.revision += 1;
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { client.save_file(&body) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.saving = false;
                match result {
                    Ok((status, data)) if status == 409 && data["error"] == "changed-on-disk" => {
                        this.conflict = Some(data);
                        this.notice = "Changed on disk".into();
                    }
                    Ok((status, data)) if (200..300).contains(&status) => {
                        this.baseline = content;
                        this.hash = data["contentHash"].as_str().map(str::to_owned);
                        this.conflict = None;
                        this.notice = "Saved".into();
                    }
                    Ok((status, _)) => {
                        this.notice = format!("Save refused (HTTP {status}). Draft retained.")
                    }
                    Err(error) => this.notice = format!("{error}. Draft retained."),
                }
                this.revision += 1;
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn reload_conflict(&mut self, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        let Some(conflict) = self.conflict.take() else {
            return;
        };
        self.ready = conflict["content"].is_string();
        self.baseline = conflict["content"].as_str().unwrap_or("").into();
        self.hash = conflict["contentHash"].as_str().map(str::to_owned);
        self.editor.update(cx, |editor, cx| {
            editor.clear(cx);
            editor.text = self.baseline.clone();
            cx.notify();
        });
        self.notice = if self.ready {
            "Reloaded"
        } else {
            "File was removed. Retry."
        }
        .into();
        self.revision += 1;
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
impl Render for Files {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.focus_editor {
            self.focus_editor = false;
            self.focus(window, cx);
        }
        let _ = &self.subscriptions;
        let dirty = self.dirty(cx);
        let saving = self.saving;
        let can_save = dirty && !saving && !self.truncated && self.conflict.is_none();
        let revision = self.revision;
        let painted = self.painted.clone();
        // Honor the same Cmd/Ctrl+S shortcut as the desktop editor.
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
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                if (event.keystroke.modifiers.control || event.keystroke.modifiers.platform)
                    && event.keystroke.key == "s"
                {
                    this.save(false, cx);
                    cx.stop_propagation();
                }
            }))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child("File")
                    .child(
                        div()
                            .debug_selector(|| "file-path".into())
                            .flex_1()
                            .child(self.path_input.clone()),
                    )
                    .child(
                        button("file-open", "Open", !self.loading && !saving)
                            .on_click(cx.listener(|s, _, _, cx| s.load(cx))),
                    )
                    .child(
                        button(
                            "file-save",
                            if saving { "Saving…" } else { "Save" },
                            can_save,
                        )
                        .on_click(cx.listener(|s, _, _, cx| s.save(false, cx))),
                    ),
            )
            .child(div().debug_selector(|| "file-status".into()).child(format!(
                "{}{}",
                self.notice,
                if dirty { " · Unsaved" } else { "" }
            )))
            .when(self.conflict.is_some(), |v| {
                v.child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(
                            button("file-reload", "Reload", !saving)
                                .on_click(cx.listener(|s, _, _, cx| s.reload_conflict(cx))),
                        )
                        .child(
                            button("file-overwrite", "Overwrite", !saving)
                                .on_click(cx.listener(|s, _, _, cx| s.save(true, cx))),
                        ),
                )
            })
            .when(self.ready && !self.truncated, |v| {
                v.child(
                    div()
                        .debug_selector(|| "file-editor".into())
                        .flex_1()
                        .min_h_0()
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
            })
            .when(self.ready && self.truncated, |v| {
                v.child(
                    div()
                        .id("file-preview")
                        .debug_selector(|| "file-preview".into())
                        .flex_1()
                        .overflow_y_scroll()
                        .child(self.baseline.clone()),
                )
            })
            .when(!self.ready && !self.loading && !self.path.is_empty(), |v| {
                v.child(
                    button("file-retry", "Retry", true)
                        .on_click(cx.listener(|s, _, _, cx| s.load(cx))),
                )
            })
            .child(canvas(|_, _, _| (), move |_, _, _, _| painted.set(revision)).size(px(1.)))
    }
}
