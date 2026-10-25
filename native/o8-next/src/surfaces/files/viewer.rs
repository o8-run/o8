//! Original Apache-2.0 file editor using the existing operator routes and GPUI input.
use crate::{
    client::Client,
    composer::{Composer, Submit},
    theme::current as theme,
};
use gpui::{prelude::*, *};
use serde_json::{Value, json};
use std::{
    cell::Cell,
    rc::Rc,
    time::{Duration, Instant},
};

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
    binary: bool,
    sensitive: bool,
    close_confirmation: Option<Instant>,
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
                this.cancel_close(cx);
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
            binary: false,
            sensitive: false,
            close_confirmation: None,
            focus_editor: false,
            notice: "Open a workspace file".into(),
            revision: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
            subscriptions,
        }
    }
    pub(crate) fn focus(&self, window: &mut Window, cx: &App) {
        if self.editable() {
            self.editor.read(cx).focus.focus(window);
        } else {
            self.path_input.read(cx).focus.focus(window);
        }
    }
    fn editable(&self) -> bool {
        self.ready
            && !self.truncated
            && !self.binary
            && !self.sensitive
            && self.hash.as_ref().is_some_and(|hash| {
                hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
    }
    pub(crate) fn dirty(&self, cx: &App) -> bool {
        self.editable() && self.editor.read(cx).text != self.baseline
    }
    pub(crate) fn has_draft(&self, cx: &App) -> bool {
        self.dirty(cx) || self.saving
    }
    fn cancel_close(&mut self, cx: &mut Context<Self>) {
        if self.close_confirmation.take().is_some() {
            self.notice.clear();
            cx.notify();
        }
    }
    pub(crate) fn request_close(&mut self, cx: &mut Context<Self>) -> bool {
        if self.saving {
            return false;
        }
        if !self.dirty(cx) {
            return true;
        }
        let now = Instant::now();
        if self.close_confirmation.is_some_and(|until| now < until) {
            return true;
        }
        let until = now + Duration::from_millis(2600);
        self.close_confirmation = Some(until);
        self.notice = "Unsaved — close again to discard · Esc to cancel".into();
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(2600))
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.close_confirmation == Some(until) {
                    this.cancel_close(cx);
                }
            });
        })
        .detach();
        cx.notify();
        false
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
        self.read_path(path, cx);
    }
    fn read_path(&mut self, path: String, cx: &mut Context<Self>) {
        self.cancel_close(cx);
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
                            this.sensitive = crate::shell::files::guard::contains(&data);
                            this.binary = data["binary"] == true;
                            this.baseline = if this.binary || this.sensitive {
                                String::new()
                            } else {
                                content.chars().take(100_000).collect()
                            };
                            this.hash = data["contentHash"].as_str().map(str::to_owned);
                            this.truncated =
                                data["truncated"] == true || content.chars().count() > 100_000;
                            this.ready = true;
                            this.focus_editor = true;
                            this.editor.update(cx, |editor, cx| {
                                editor.clear(cx);
                                if this.editable() {
                                    editor.text = this.baseline.clone();
                                }
                                cx.notify();
                            });
                            this.notice = if this.sensitive {
                                "Sensitive file hidden · Read-only"
                            } else if this.binary {
                                ""
                            } else if this.truncated {
                                "File truncated by server. Saving disabled."
                            } else if !this.editable() {
                                "File revision unavailable · Read-only"
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
    fn save(&mut self, overwrite: bool, cx: &mut Context<Self>) {
        if !self.editable()
            || self.loading
            || self.saving
            || (!overwrite && (!self.dirty(cx) || self.conflict.is_some()))
        {
            return;
        }
        let content = self.editor.read(cx).text.clone();
        let mut body = json!({"path":self.path,"workspace":self.workspace,"content":content});
        // Overwrite confirms the conflict revision, not any later desktop edit.
        let expected = if overwrite {
            self.conflict
                .as_ref()
                .and_then(|data| data.get("contentHash"))
                .cloned()
        } else {
            self.hash.as_ref().map(|hash| json!(hash))
        };
        let Some(expected) = expected else {
            return;
        };
        if !expected.is_null()
            && !expected
                .as_str()
                .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return;
        }
        body["expectedHash"] = expected;
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
                    Ok((status, mut data))
                        if status == 409 && data["error"] == "changed-on-disk" =>
                    {
                        crate::shell::files::guard::scrub(&mut data);
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
        if self.conflict.take().is_some() {
            // Reload through the bounded, binary-aware read route, never the full
            // conflict payload. The loaded path may differ from the path input.
            self.read_path(self.path.clone(), cx);
        }
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
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" && this.close_confirmation.is_some() {
                    this.cancel_close(cx);
                    cx.stop_propagation();
                    return;
                }
                if (event.keystroke.modifiers.control || event.keystroke.modifiers.platform)
                    && event.keystroke.key == "s"
                    && this.editor.read(cx).focus.is_focused(window)
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
            .when(self.editable(), |v| {
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
            .when(self.ready && self.binary, |v| {
                v.child(
                    div()
                        .debug_selector(|| "file-binary".into())
                        .child("Binary file · Read-only"),
                )
            })
            .when(
                self.ready && self.truncated && !self.binary && !self.sensitive,
                |v| {
                    v.child(
                        div()
                            .id("file-preview")
                            .debug_selector(|| "file-preview".into())
                            .flex_1()
                            .overflow_y_scroll()
                            .child(self.baseline.clone()),
                    )
                },
            )
            .when(!self.ready && !self.loading && !self.path.is_empty(), |v| {
                v.child(
                    button("file-retry", "Retry", true)
                        .on_click(cx.listener(|s, _, _, cx| s.load(cx))),
                )
            })
            .child(canvas(|_, _, _| (), move |_, _, _, _| painted.set(revision)).size(px(1.)))
    }
}
