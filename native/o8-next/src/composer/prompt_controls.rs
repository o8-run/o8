//! Slash suggestions, intent chips and prompt insertion beside the native editor.
use super::prompt_view::small;
use super::*;
use crate::composer::commands;
use gpui::{AnyElement, KeyDownEvent};
struct ControlsView {
    owner: gpui::WeakEntity<Surface>,
    _subscription: gpui::Subscription,
}
impl gpui::Render for ControlsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.owner
            .update(cx, |s, cx| s.composer_control_scene(window, cx))
            .unwrap()
    }
}
impl Surface {
    pub(super) fn composer_control_view(&mut self, cx: &mut Context<Self>) -> gpui::AnyView {
        let view = if let Some(view) = &self.composer.read(cx).controls.prompt.view {
            view.clone()
        } else {
            let owner = cx.entity();
            let view: gpui::AnyView = cx
                .new(|cx| ControlsView {
                    owner: owner.downgrade(),
                    _subscription: cx.observe(&owner, |_, _, cx| cx.notify()),
                })
                .into();
            self.composer
                .update(cx, |i, _| i.controls.prompt.view = Some(view.clone()));
            view
        };
        // Reserve one toolbar row so changing the draft never resizes the
        // transcript. Only slash/filter/presence changes invalidate this scene.
        let mut style = gpui::StyleRefinement::default();
        style.size.width = Some(gpui::relative(1.).into());
        style.size.height = Some(px(34.).into());
        style.flex_shrink = Some(0.);
        view.cached(style)
    }

    pub(super) fn composer_control_scene(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut view = div().child(self.composer_intent(cx));
        if let Some(menu) = self.slash_menu(window, cx) {
            view = view.child(menu);
        }
        view.into_any_element()
    }
    pub(super) fn mode_chip(
        &self,
        picked: &str,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        self.track_prompt_anchor(
            self.composer_button(
                "composer-mode",
                crate::composer::controls::mode_label(picked),
                enabled,
                cx,
                |s, w, cx| s.open_composer_picker("mode", w, cx),
            ),
            "mode",
        )
        .when(picked != "solo", |v| {
            v.bg(theme().selection).text_color(theme().accent)
        })
        .child(crate::icon::stroke(
            "m6 9 6 6 6-6",
            theme().text_secondary,
            9.,
            1.5,
        ))
    }
    pub(super) fn composer_intent(&self, cx: &mut Context<Self>) -> AnyElement {
        let editor = self.composer.read(cx);
        let has_text = !editor.text.trim().is_empty();
        let repo = self.intent_repo(cx);
        let label = repo
            .as_deref()
            .and_then(|p| std::path::Path::new(p).file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "choose repo".into());
        let branch = if editor.controls.prompt.branch.is_empty() {
            "main".to_owned()
        } else {
            editor.controls.prompt.branch.clone()
        };
        let enabled = !self.saving && !editor.controls.busy;
        let feedback = editor.controls.prompt.feedback.clone();
        div()
            .id("composer-intent-row")
            .overflow_x_scroll()
            .flex()
            .items_center()
            .gap(px(6.))
            .px(px(12.))
            .py(px(4.))
            .when(has_text, |v| {
                v.child(small("Work on"))
                    .child(
                        self.prompt_trigger("composer-intent-repo", &label, "repo", enabled, cx)
                            .max_w(px(160.))
                            .truncate(),
                    )
                    .child(small("off"))
                    .child(
                        self.prompt_trigger(
                            "composer-intent-branch",
                            &branch,
                            "branch",
                            enabled,
                            cx,
                        )
                        .max_w(px(160.))
                        .truncate(),
                    )
            })
            // Classic has no Commands or Prompts buttons: quick actions open
            // with Cmd+Shift+K or "/", saved prompts from the "+" menu.
            .when(!feedback.is_empty(), |v| {
                v.child(
                    self.prompt_trigger(
                        "composer-command-result",
                        &feedback
                            .lines()
                            .next()
                            .unwrap_or("")
                            .chars()
                            .take(70)
                            .collect::<String>(),
                        "result",
                        enabled,
                        cx,
                    ),
                )
            })
            .into_any_element()
    }
    pub(super) fn track_prompt_anchor(
        &self,
        button: gpui::Stateful<gpui::Div>,
        kind: &'static str,
    ) -> gpui::Stateful<gpui::Div> {
        let editor = self.composer.downgrade();
        button.relative().child(
            gpui::canvas(
                |_, _, _| (),
                move |bounds, _, _, cx| {
                    let _ = editor.update(cx, |i, _| {
                        i.controls.prompt.anchors.insert(kind, bounds);
                    });
                },
            )
            .absolute()
            .inset_0(),
        )
    }
    fn prompt_trigger(
        &self,
        id: &str,
        label: &str,
        kind: &'static str,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        self.track_prompt_anchor(
            self.composer_button(id, label, enabled, cx, move |s, w, cx| {
                s.open_prompt(kind, w, cx)
            }),
            kind,
        )
    }
    pub(super) fn dismiss_prompt_outside(
        &mut self,
        event: &gpui::MouseDownEvent,
        cx: &mut Context<Self>,
    ) {
        let input = self.composer.read(cx);
        if input
            .controls
            .open
            .and_then(|k| input.controls.prompt.anchors.get(k))
            .is_some_and(|b| b.contains(&event.position))
        {
            return;
        }
        self.composer.update(cx, |i, cx| {
            i.controls.open = None;
            i.controls.model = None;
            i.controls.prompt.generation += 1;
            cx.notify();
        });
        cx.notify();
    }
    pub(super) fn intent_repo(&self, cx: &App) -> Option<String> {
        self.composer
            .read(cx)
            .controls
            .prompt
            .repo
            .clone()
            .or_else(|| {
                self.sessions
                    .iter()
                    .find(|s| Some(&s.id) == self.selected.as_ref())
                    .and_then(|s| s.repo_path.clone())
            })
    }
    pub(crate) fn quick_action_shortcut(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        // The composer has no Commands button, so the shortcut works while typing.
        if self.composer.read(cx).controls.open == Some("quick") {
            if let Some(query) = &self.composer.read(cx).controls.prompt.query {
                query.read(cx).focus.focus(window);
            }
        } else {
            self.open_prompt("quick", window, cx);
        }
        true
    }
    pub(crate) fn open_prompt(
        &mut self,
        open: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.composer.read(cx).controls.busy {
            return;
        }
        if self.composer.read(cx).controls.open == Some(open) {
            self.close_composer_picker(window, cx);
            return;
        }
        let editor = self.composer.clone();
        let query = cx.new(|cx| {
            let mut i = Composer::new(cx);
            i.placeholder = match open {
                "quick" => "Search actions…",
                "prompts" => "Search saved prompts…",
                "branch" => "Search branches…",
                "rules" => "Add a session rule…",
                _ => "Search repositories…",
            }
            .into();
            i
        });
        let owner = editor.downgrade();
        let subscription = cx.observe(&query, move |s, input, cx| {
            let Some(owner) = owner.upgrade() else {
                return;
            };
            let text = input.read(cx).text.clone();
            if owner.read(cx).controls.prompt.last_query == text {
                return;
            }
            owner.update(cx, |i, _| {
                i.controls.prompt.last_query = text;
                i.controls.prompt.selected = 0;
            });
            if s.composer == owner && owner.read(cx).controls.open == Some("prompts") {
                s.load_prompt_rows("prompts", cx);
            }
            cx.notify();
        });
        let has_repo = self.intent_repo(cx).is_some();
        let branch_base = editor
            .read(cx)
            .controls
            .prompt
            .rows
            .iter()
            .find(|r| r["current"] == true)
            .and_then(|r| r["name"].as_str())
            .unwrap_or("main")
            .to_owned();
        let draft = editor.read(cx).text.clone();
        let mut fields = vec![];
        if open == "save-prompt" {
            for text in [
                draft
                    .lines()
                    .find(|s| !s.trim().is_empty())
                    .unwrap_or("Saved prompt")
                    .chars()
                    .take(80)
                    .collect::<String>(),
                String::new(),
                draft,
            ] {
                fields.push(cx.new(|cx| {
                    let mut i = Composer::new(cx);
                    i.set_text(&text, cx);
                    i
                }));
            }
        } else if open == "branch-create" {
            fields.push(cx.new(Composer::new));
        }
        editor.update(cx, |i, cx| {
            i.controls.open = Some(open);
            i.controls.error.clear();
            i.controls.prompt.rows.clear();
            i.controls.prompt.error.clear();
            i.controls.prompt.result.clear();
            i.controls.prompt.loading = false;
            if open == "branch-create" {
                i.controls.prompt.branch_base = branch_base;
            }
            i.controls.prompt.selected = 0;
            i.controls.prompt.last_query.clear();
            i.controls.prompt.fields = fields;
            i.controls.prompt.query = Some(query.clone());
            i.controls.prompt.scope = has_repo;
            i.controls.prompt.query_subscription = Some(subscription);
            i.controls.prompt.opened = Some(cx.background_executor().now());
            cx.notify();
        });
        if matches!(open, "repo" | "branch" | "prompts" | "rules") {
            self.load_prompt_rows(open, cx);
        }
        if let Some(field) = editor.read(cx).controls.prompt.fields.first() {
            field.read(cx).focus.focus(window);
        } else {
            query.read(cx).focus.focus(window);
        }
        cx.notify();
    }
    pub(super) fn load_prompt_rows(&mut self, open: &'static str, cx: &mut Context<Self>) {
        let editor = self.composer.clone();
        let repo = self.intent_repo(cx).unwrap_or_default();
        let query = editor.read(cx).controls.prompt.last_query.clone();
        let thread = self.selected.clone().unwrap_or_default();
        let generation = editor.update(cx, |i, cx| {
            i.controls.prompt.generation += 1;
            i.controls.prompt.loading = true;
            i.controls.prompt.error.clear();
            cx.notify();
            i.controls.prompt.generation
        });
        let client = self.client.clone();
        let debounce = open == "prompts" && !query.is_empty();
        let fetch = async move {
            let result: Value = match open {
                "repo" => client.get("/api/panel/repos", &[])?,
                "branch" => {
                    if repo.is_empty() {
                        return Err("Choose a repository before selecting a branch.".to_owned());
                    }
                    client.get("/api/panel/branches", &[("path", repo.as_str())])?
                }
                "prompts" => client.get(
                    "/api/prompt-library",
                    &[
                        ("query", query.as_str()),
                        ("repoPath", repo.as_str()),
                        ("scope", "available"),
                        ("limit", "100"),
                    ],
                )?,
                _ => client.get(
                    "/api/orchestrator/session-rules",
                    &[("threadId", thread.as_str())],
                )?,
            };
            let key = match open {
                "repo" => "repos",
                "branch" => "branches",
                "prompts" => "prompts",
                _ => "rules",
            };
            let mut rows = (if open == "rules" {
                &result["result"][key]
            } else {
                &result[key]
            })
            .as_array()
            .cloned()
            .ok_or_else(|| format!("The {open} response did not contain {key}."))?;
            if open == "rules" {
                for row in &mut rows {
                    row["tier"] = json!("Session");
                }
                let directives: Value =
                    client.get("/api/cortex/directives", &[("repoPath", repo.as_str())])?;
                for mut row in directives["directives"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                {
                    row["tier"] = json!(if row["scope"] == "global" || row["scope"] == "" {
                        "Global"
                    } else {
                        "Repo"
                    });
                    rows.push(row);
                }
            }
            if open == "branch" {
                rows.sort_by(|a, b| {
                    b["lastCommitUnix"]
                        .as_i64()
                        .unwrap_or(0)
                        .cmp(&a["lastCommitUnix"].as_i64().unwrap_or(0))
                        .then_with(|| b["current"].as_bool().cmp(&a["current"].as_bool()))
                        .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
                });
            }
            Ok::<_, String>(rows)
        };
        cx.spawn(async move |this, cx| {
            if debounce {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(100))
                    .await;
            }
            if !editor
                .update(cx, |i, _| {
                    i.controls.open == Some(open) && i.controls.prompt.generation == generation
                })
                .unwrap_or(false)
            {
                return;
            }
            let result = cx.background_executor().spawn(fetch).await;
            let _ = editor.update(cx, |i, cx| {
                if i.controls.open != Some(open) || i.controls.prompt.generation != generation {
                    return;
                }
                i.controls.prompt.loading = false;
                match result {
                    Ok(rows) => i.controls.prompt.rows = rows,
                    Err(error) => i.controls.prompt.error = error,
                }
                cx.notify();
            });
            let _ = this.update(cx, |_, cx| cx.notify());
        })
        .detach();
    }
    pub(super) fn prompt_items(
        &self,
        open: &str,
        cx: &App,
    ) -> Vec<(String, String, String, Value)> {
        let state = &self.composer.read(cx).controls.prompt;
        let query = state
            .query
            .as_ref()
            .map(|q| q.read(cx).text.trim().to_lowercase())
            .unwrap_or_default();
        if open == "quick" {
            return commands::QUICK
                .iter()
                .filter(|(_, verb, label, _)| {
                    format!("{verb} {label}").to_lowercase().contains(&query)
                })
                .map(|(id, verb, label, body)| {
                    (
                        id.to_string(),
                        verb.to_string(),
                        label.to_string(),
                        json!({"body":body}),
                    )
                })
                .collect();
        }
        state
            .rows
            .iter()
            .filter_map(|row| {
                let (id, label, detail) = match open {
                    "repo" => {
                        let path = row["localPath"].as_str().or(row["path"].as_str())?;
                        (
                            path.to_owned(),
                            row["label"]
                                .as_str()
                                .or(row["name"].as_str())
                                .or(row["repoName"].as_str())
                                .unwrap_or(path)
                                .to_owned(),
                            path.to_owned(),
                        )
                    }
                    "branch" => {
                        let name = row["name"].as_str()?;
                        (
                            name.to_owned(),
                            format!(
                                "{}{}{}",
                                name,
                                if row["current"] == true {
                                    " · current"
                                } else {
                                    ""
                                },
                                if row["isWorktree"] == true {
                                    " · worktree"
                                } else {
                                    ""
                                }
                            ),
                            format!(
                                "{} {}",
                                row["lastCommitAge"].as_str().unwrap_or(""),
                                row["lastCommitMessage"].as_str().unwrap_or("")
                            ),
                        )
                    }
                    "prompts" => (
                        row["id"].as_str()?.to_owned(),
                        row["title"].as_str().unwrap_or("Saved prompt").to_owned(),
                        row["body"]
                            .as_str()
                            .unwrap_or("")
                            .lines()
                            .next()
                            .unwrap_or("")
                            .to_owned(),
                    ),
                    _ => (
                        row["id"].as_str()?.to_owned(),
                        row["text"].as_str().unwrap_or("").to_owned(),
                        "Session rule".into(),
                    ),
                };
                (open == "prompts" || format!("{label} {detail}").to_lowercase().contains(&query))
                    .then_some((id, label, detail, row.clone()))
            })
            .collect()
    }
    pub(super) fn prompt_picker_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(open) = self.composer.read(cx).controls.open else {
            return false;
        };
        let key = event.keystroke.key.as_str();
        if open == "mode" && matches!(key, "up" | "down") {
            let routing = self.composer_routing(cx).unwrap_or(Value::Null);
            // Arrows skip Shared where it is unavailable, as classic's cycle does.
            let ids: &[&str] =
                if crate::composer::controls::shares_checkout(routing["backend"].as_str()) {
                    &["mode-fast", "mode-multitask"]
                } else {
                    &["mode-multitask"]
                };
            let current = ids
                .iter()
                .position(|id| {
                    self.composer
                        .read(cx)
                        .controls
                        .focus
                        .get(*id)
                        .is_some_and(|f| f.is_focused(window))
                })
                .unwrap_or_else(|| {
                    ["fast", "multitask"]
                        .iter()
                        .position(|v| routing["pickedMode"] == *v)
                        .unwrap_or(0)
                });
            let next = (current + 1) % ids.len();
            if let Some(focus) = self.composer.read(cx).controls.focus.get(ids[next]) {
                focus.focus(window);
            }
            cx.stop_propagation();
            return true;
        }
        if open == "rules"
            && key == "enter"
            && self
                .composer
                .read(cx)
                .controls
                .prompt
                .query
                .as_ref()
                .is_some_and(|query| query.read(cx).focus.is_focused(window))
        {
            self.mutate_prompt_rule(None, cx);
            cx.stop_propagation();
            return true;
        }
        if !matches!(open, "quick" | "repo" | "branch" | "prompts") {
            return false;
        }
        // Search results hidden by the loading state cannot be applied by Enter.
        let items = if self.composer.read(cx).controls.prompt.loading {
            vec![]
        } else {
            self.prompt_items(open, cx)
        };
        match key {
            "up" | "down" => {
                if !items.is_empty() {
                    self.composer.update(cx, |i, cx| {
                        i.controls.prompt.selected = (i.controls.prompt.selected
                            + if key == "up" { items.len() - 1 } else { 1 })
                            % items.len();
                        i.controls
                            .prompt
                            .scroll
                            .scroll_to_item(i.controls.prompt.selected);
                        cx.notify();
                    });
                    cx.notify();
                }
            }
            "enter" => {
                let selected = self
                    .composer
                    .read(cx)
                    .controls
                    .prompt
                    .selected
                    .min(items.len().saturating_sub(1));
                if let Some(item) = items.get(selected) {
                    self.pick_prompt_item(open, item.clone(), window, cx);
                }
            }
            _ => return false,
        }
        cx.stop_propagation();
        true
    }
    pub(super) fn pick_prompt_item(
        &mut self,
        open: &str,
        item: (String, String, String, Value),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (id, _, _, row) = item;
        match open {
            "quick" if id == "prompts" => {
                self.open_prompt("prompts", window, cx);
                return;
            }
            "quick" => {
                if let Some(body) = row["body"].as_str() {
                    self.composer.update(cx, |i, cx| {
                        let next = if i.text.trim().is_empty() {
                            format!("{body}\n\n")
                        } else {
                            format!("{}\n\n{body}\n\n", i.text.trim_end())
                        };
                        i.set_text(&next, cx);
                    });
                }
            }
            "prompts" => {
                if let Some(body) = row["body"].as_str() {
                    self.composer.update(cx, |i, cx| i.insert_prompt(body, cx));
                    let client = self.client.clone();
                    cx.background_executor()
                        .spawn(async move {
                            if let Ok(mut url) = client.url("/api/prompt-library/") {
                                url.path_segments_mut()
                                    .unwrap()
                                    .pop_if_empty()
                                    .push(&id)
                                    .push("use");
                                let _ = client.request("POST", &url).send_json(json!({}));
                            }
                        })
                        .detach();
                }
            }
            "repo" => {
                self.composer.update(cx, |i, _| {
                    i.controls.prompt.repo = Some(id);
                    i.controls.prompt.branch.clear();
                });
            }
            "branch" => {
                self.composer
                    .update(cx, |i, _| i.controls.prompt.branch = id);
            }
            _ => return,
        }
        self.close_composer_picker(window, cx);
    }
}
