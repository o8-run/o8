//! O8SpecTargetPicker: active repo, arbitrary folder/o8.md, typed path and recents.
use super::controls::control;
use super::preferences::{Changed, normalize};
use super::*;
use crate::composer::Composer;
#[derive(Clone)]
pub(super) struct Choice {
    pub label: String,
    pub path: String,
}
pub(super) struct Target {
    pub open: bool,
    pub typed: bool,
    pub loading: bool,
    pub error: Option<String>,
    pub choices: Vec<Choice>,
    pub input: Entity<Composer>,
    pub _submit: Option<Subscription>,
    pub trigger: FocusHandle,
}
impl Target {
    pub fn new(cx: &mut Context<Spec>) -> Self {
        let input = cx.new(|cx| {
            let mut input = Composer::new(cx);
            input.inline = true;
            input.placeholder = "/path/to/repo or /path/to/repo/o8.md".into();
            input
        });
        Self {
            open: false,
            typed: false,
            loading: false,
            error: None,
            choices: vec![],
            input,
            _submit: None,
            trigger: cx.focus_handle(),
        }
    }
}
impl Spec {
    pub(in crate::files_panel) fn receive_preferences(
        &mut self,
        prefs: preferences::Preferences,
        cx: &mut Context<Self>,
    ) {
        let prefs = prefs.clean();
        if prefs == self.preferences {
            return;
        }
        let old = self.preferences.target_override.clone();
        self.preferences = prefs;
        let ink = self.preferences.ink();
        self.editor.update(cx, |e, cx| {
            e.note_color = ink;
            cx.notify();
        });
        if old != self.preferences.target_override
            && !self.pending
            && !self.saving
            && self.content == self.server
        {
            self.change_target(cx);
        }
        cx.notify();
    }
    pub(super) fn change_target(&mut self, cx: &mut Context<Self>) {
        self.workspace = self
            .preferences
            .target_override
            .clone()
            .unwrap_or_else(|| self.default_workspace.clone());
        self.client = self.client.in_workspace(&self.workspace);
        self.reviewing = false;
        self.mutating = false;
        self.editor.update(cx, |e, _| {
            e.assets = super::super::editor::assets::Assets {
                target: Some((self.client.clone(), self.workspace.clone())),
                generation: e.assets.generation + 1,
                ..Default::default()
            };
            e.rail = Default::default();
        });
        self.generation += 1;
        self.edits += 1;
        self.loaded_once = false;
        self.content.clear();
        self.server.clear();
        self.loaded.clear();
        self.hash = None;
        self.pending = false;
        self.saving = false;
        self.conflict = None;
        self.error = None;
        self.saved = None;
        self.editor.update(cx, |e, cx| e.initial_text("", cx));
        if self.started {
            self.load(false, cx);
            self.prewarm(cx);
        }
        cx.notify();
    }
    pub(super) fn select_target(
        &mut self,
        path: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.pending || self.saving || self.content != self.server {
            return;
        }
        let Some(path) = normalize(&path) else {
            self.target.error = Some("Enter an absolute file or repository path.".into());
            cx.notify();
            return;
        };
        self.preferences.remember(path.clone());
        self.preferences.target_override = if path == self.default_workspace {
            None
        } else {
            Some(path)
        };
        self.target.open = false;
        self.target.typed = false;
        self.target.error = None;
        self.change_target(cx);
        cx.emit(Changed(self.preferences.clone()));
        self.focus.focus(window);
    }
    fn follow_repo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending || self.saving || self.content != self.server {
            return;
        }
        self.preferences.target_override = None;
        self.target.open = false;
        self.change_target(cx);
        cx.emit(Changed(self.preferences.clone()));
        self.focus.focus(window);
    }
    pub(super) fn target_toggle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending || self.saving || self.content != self.server {
            return;
        }
        self.target.open = !self.target.open;
        self.target.error = None;
        if self.target.open {
            self.settings = false;
            self.target.loading = true;
            let client = self.client.clone();
            let generation = self.generation;
            let work = cx
                .background_executor()
                .spawn(async move { client.get::<Value>("/api/panel/repos", &[]) });
            cx.spawn(async move |this, cx| {
                let result = work.await;
                let _ = this.update(cx, |this, cx| {
                    if generation != this.generation {
                        return;
                    }
                    this.target.loading = false;
                    this.target.choices = vec![];
                    match result {
                        Ok(body) => {
                            for repo in body["repos"].as_array().into_iter().flatten() {
                                if repo["exists"] != false
                                    && let Some(path) = repo["localPath"].as_str()
                                {
                                    this.target.choices.push(Choice {
                                        label: repo["name"].as_str().unwrap_or(path).into(),
                                        path: path.into(),
                                    });
                                }
                            }
                        }
                        Err(e) => this.target.error = Some(e),
                    }
                    cx.notify();
                });
            })
            .detach();
        } else {
            self.target.trigger.focus(window);
        }
        cx.notify();
    }
    fn browse(&mut self, file: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending || self.saving || self.content != self.server {
            return;
        }
        self.target.loading = true;
        self.target.error = None;
        let client = self.client.clone();
        let generation = self.generation;
        let work = cx.background_executor().spawn(async move {
            io::json_request(
                &client,
                "POST",
                if file {
                    "/api/panel/file-io"
                } else {
                    "/api/panel/browse-folder"
                },
                &[],
                if file {
                    Some(json!({"action":"pick"}))
                } else {
                    Some(json!({}))
                },
            )
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = work.await;
            let _ = this.update_in(cx, |this, window, cx| {
                if generation != this.generation {
                    return;
                }
                this.target.loading = false;
                match result {
                    Ok((status, body)) if status < 300 && body["unavailable"] != true => {
                        if let Some(path) = body["path"].as_str() {
                            if file
                                && !path
                                    .trim_end_matches(['/', '\\'])
                                    .rsplit(['/', '\\'])
                                    .next()
                                    .is_some_and(|p| p.eq_ignore_ascii_case("o8.md"))
                            {
                                this.target.error = Some("Choose the o8.md file itself.".into());
                            } else {
                                this.select_target(path.into(), window, cx);
                            }
                        }
                    }
                    _ => {
                        this.target.typed = true;
                        this.target.input.read(cx).focus.focus(window);
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn target_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let mut choices = self.target.choices.clone();
        for path in self
            .preferences
            .recents
            .iter()
            .chain((!self.workspace.is_empty()).then_some(&self.workspace))
        {
            if !choices.iter().any(|c| &c.path == path) {
                choices.push(Choice {
                    label: path.rsplit('/').next().unwrap_or(path).into(),
                    path: path.clone(),
                });
            }
        }
        div()
            .id("spec-target-menu")
            .debug_selector(|| "spec-target-menu".into())
            .w(px(286.))
            .max_w(gpui::relative(0.95))
            .max_h(px(360.))
            .overflow_y_scroll()
            .p(px(5.))
            .rounded(px(13.))
            .border_1()
            .border_color(theme().border)
            .bg(theme().surface_raised)
            .shadow_md()
            .occlude()
            .on_mouse_down_out(cx.listener(|this, _, window, cx| {
                this.close_menu(window, cx);
                cx.stop_propagation();
            }))
            .flex()
            .flex_col()
            .child(
                div()
                    .px(px(8.))
                    .py(px(5.))
                    .text_size(px(9.5))
                    .text_color(theme().text_faint)
                    .child("O8.MD TARGET"),
            )
            .when(
                self.preferences.target_override.is_some() && !self.default_workspace.is_empty(),
                |d| {
                    d.child(
                        control(
                            "spec-follow-repo",
                            "Follow active repo",
                            cx,
                            |this, window, cx| this.follow_repo(window, cx),
                        )
                        .justify_start()
                        .min_h(px(38.)),
                    )
                },
            )
            .when(self.target.loading, |d| {
                d.child(
                    div()
                        .p(px(8.))
                        .text_size(px(11.))
                        .child("Loading repositories…"),
                )
            })
            .children(
                choices
                    .into_iter()
                    .filter(|_| !self.target.typed)
                    .enumerate()
                    .map(|(i, c)| {
                        let selected = c.path == self.workspace;
                        let path = c.path.clone();
                        control(
                            format!("spec-target-choice-{i}"),
                            "",
                            cx,
                            move |this, window, cx| this.select_target(path.clone(), window, cx),
                        )
                        .min_h(px(38.))
                        .justify_between()
                        .when(selected, |d| d.bg(theme().hover))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .child(
                                    div()
                                        .text_size(px(11.5))
                                        .whitespace_nowrap()
                                        .overflow_hidden()
                                        .text_ellipsis()
                                        .child(c.label),
                                )
                                .child(
                                    div()
                                        .text_size(px(9.5))
                                        .text_color(theme().text_faint)
                                        .whitespace_nowrap()
                                        .overflow_hidden()
                                        .text_ellipsis()
                                        .child(c.path),
                                ),
                        )
                        .when(selected, |d| d.child("✓"))
                    }),
            )
            .child(div().h(px(1.)).bg(theme().border).my(px(5.)))
            .child(
                control(
                    "spec-choose-folder",
                    "Choose repository folder…",
                    cx,
                    |this, window, cx| this.browse(false, window, cx),
                )
                .min_h(px(38.))
                .justify_start(),
            )
            .child(
                control(
                    "spec-choose-file",
                    "Choose o8.md file…",
                    cx,
                    |this, window, cx| this.browse(true, window, cx),
                )
                .min_h(px(38.))
                .justify_start(),
            )
            .child(
                control(
                    "spec-type-path",
                    "Enter a path…",
                    cx,
                    |this, window, cx| {
                        this.target.typed = true;
                        this.target.input.read(cx).focus.focus(window);
                        cx.notify();
                    },
                )
                .min_h(px(38.))
                .justify_start(),
            )
            .when(self.target.typed, |d| {
                d.child(
                    div()
                        .debug_selector(|| "spec-target-input".into())
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, window, cx| {
                                this.target.input.read(cx).focus.focus(window);
                                window.prevent_default();
                                cx.stop_propagation();
                            }),
                        )
                        .h(px(30.))
                        .w_full()
                        .px(px(7.))
                        .flex()
                        .flex_col()
                        .justify_center()
                        .border_1()
                        .border_color(theme().border)
                        .rounded(px(6.))
                        .child(self.target.input.clone()),
                )
                .child(control(
                    "spec-target-open",
                    "Open",
                    cx,
                    |this, window, cx| {
                        let path = this.target.input.read(cx).text.clone();
                        this.select_target(path, window, cx);
                    },
                ))
            })
            .when_some(self.target.error.as_ref(), |d, e| {
                d.child(
                    div()
                        .p(px(8.))
                        .text_size(px(10.5))
                        .text_color(theme().danger)
                        .child(e.clone()),
                )
            })
            .into_any_element()
    }
}
