//! The composer's floating pickers, after the desktop ComposerPicker: mode and
//! permission menus, the lead model list grouped by runtime, and effort stops.
use super::*;
use gpui::{AnyElement, Div, Entity, SharedString, Stateful};

/// COMPOSER_MODEL_GROUPS in ModelThinkingChip.tsx: house, then
/// (runtime, model id, label, detail).
pub(super) const HOUSES: &[(&str, &[(&str, &str, &str, &str)])] = &[
    (
        "Claude",
        &[
            ("fable", "claude-fable-5-1", "Fable 5.1", "flagship"),
            ("claude", "claude-opus-5-5", "Opus 5.5", "recommended lead"),
            ("claude", "claude-opus-5", "Opus 5", "deep reasoning"),
            ("claude", "claude-opus-4-8", "Opus 4.8", "previous Opus"),
            ("claude", "claude-sonnet-5", "Sonnet 5", "everyday"),
        ],
    ),
    (
        "Codex",
        &[
            (
                "codex",
                "gpt-6-astra",
                "GPT-6 Astra",
                "orchestrator flagship",
            ),
            (
                "codex",
                "gpt-6.1-sol",
                "GPT-6.1 Sol",
                "everyday orchestrator",
            ),
            ("codex", "gpt-6-sol", "GPT-6 Sol", "previous Sol"),
            (
                "codex",
                "gpt-6-luna",
                "GPT-6 Luna",
                "fast model for easier tasks",
            ),
            ("codex", "gpt-5.6-sol", "GPT-5.6 Sol", "flagship"),
            ("codex", "gpt-5.6-terra", "GPT-5.6 Terra", "worker class"),
        ],
    ),
];

const CHECK: &str = "M5 12l5 5L20 7";

impl Surface {
    /// The floating menu above the composer card for the open chip.
    pub(super) fn composer_popover(
        &mut self,
        open: &'static str,
        busy: bool,
        model: Option<Entity<Composer>>,
        routing: &Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if matches!(
            open,
            "quick"
                | "prompts"
                | "repo"
                | "branch"
                | "branch-create"
                | "save-prompt"
                | "rules"
                | "result"
        ) {
            return self.prompt_popover(open, window, cx);
        }
        if open == "context" {
            return self.context_popover(cx);
        }
        let mut menu = div()
            .id("composer-picker")
            .debug_selector(|| "composer-picker".into())
            .absolute()
            .bottom_full()
            .mb(px(8.))
            .w(px(match open {
                "mode" => 224.,
                "attach" => 300.,
                "effort" => 300.,
                "model" => 366.,
                _ => 260.,
            }))
            .max_h(px(if open == "model" { 470. } else { 520. }))
            .overflow_y_scroll()
            .p(px(if open == "model" { 0. } else { 6. }))
            .flex()
            .when(open == "model", |m| m.flex_row().overflow_hidden())
            .when(open != "model", |m| m.flex_col())
            .gap(px(1.))
            .rounded(px(18.))
            .border_1()
            .border_color(theme().border)
            .bg(crate::theme::menu_fill())
            .shadow_lg();
        // Mode and permission sit on the left of the footer; model and effort on the right.
        menu = if matches!(open, "mode" | "access" | "attach") {
            menu.left(px(8.))
        } else {
            menu.right(px(8.))
        };
        match open {
            "mode" => {
                menu = menu.child(
                    div()
                        .flex()
                        .justify_between()
                        .px(px(8.))
                        .pt(px(2.))
                        .pb(px(4.))
                        .text_size(px(10.))
                        .font_weight(gpui::FontWeight::LIGHT)
                        .text_color(theme().text_faint)
                        .child("WORKER CHECKOUT")
                        .child("Shift+Tab cycles"),
                );
                let picked = routing["pickedMode"].as_str().unwrap_or("fast");
                let shares =
                    crate::composer::controls::shares_checkout(routing["backend"].as_str());
                for (value, label, detail) in [
                    (
                        "fast",
                        "Shared",
                        "Workers share this checkout with separate file scopes",
                    ),
                    (
                        "multitask",
                        "Worktrees",
                        "Give delegated workers separate checkouts",
                    ),
                ] {
                    menu = menu.child(self.menu_row(
                        &format!("mode-{value}"),
                        label,
                        detail,
                        picked == value,
                        !busy && (value != "fast" || shares),
                        cx,
                        move |s, w, cx| s.composer_choice("pickedMode", value, w, cx),
                    ));
                }
            }
            "access" => {
                let plan = routing["permissionMode"] == "plan";
                for (value, label, detail, selected) in [
                    (
                        "full",
                        "Full access",
                        "Can edit files and run actions",
                        !plan,
                    ),
                    (
                        "plan",
                        "Plan only",
                        "Inspect and propose without edits",
                        plan,
                    ),
                ] {
                    menu = menu.child(self.menu_row(
                        &format!("access-{value}"),
                        label,
                        detail,
                        selected,
                        !busy,
                        cx,
                        move |s, w, cx| s.composer_choice("permissionMode", value, w, cx),
                    ));
                }
            }
            // AttachFilesButton's menu: saved prompts, then files from disk.
            // The "+" drawer, after the mobile Add context sheet: recent
            // screenshots, files, prompts, scope and permission in one place
            // so the footer stays clean (Q 2026-10-31).
            "attach" => {
                let has_text = !self.composer.read(cx).text.trim().is_empty();
                let images = matches!(
                    routing["backend"].as_str(),
                    Some("codex" | "claude" | "fable" | "collide")
                );
                if images {
                    menu = menu.children(self.recent_screenshots(busy, cx));
                }
                menu = menu.child(self.menu_row(
                    "attach-upload",
                    "Add files",
                    if images {
                        "Images from disk"
                    } else {
                        "This runtime takes no images"
                    },
                    false,
                    !busy && images,
                    cx,
                    |s, w, cx| {
                        s.close_composer_picker(w, cx);
                        s.attach_composer_image(cx);
                    },
                ));
                menu = menu.child(self.menu_row(
                    "attach-browse-prompts",
                    "Saved prompts",
                    "Insert a prompt from your library",
                    false,
                    !busy,
                    cx,
                    |s, w, cx| s.open_prompt("prompts", w, cx),
                ));
                if has_text {
                    menu = menu.child(self.menu_row(
                        "attach-save-prompt",
                        "Save as prompt",
                        "Keep this draft in your library",
                        false,
                        !busy,
                        cx,
                        |s, w, cx| s.open_prompt("save-prompt", w, cx),
                    ));
                }
                let repo = self
                    .intent_repo(cx)
                    .as_deref()
                    .and_then(|p| std::path::Path::new(p).file_name())
                    .map_or("Choose a repository".to_owned(), |n| {
                        n.to_string_lossy().into_owned()
                    });
                let branch = match self.composer.read(cx).controls.prompt.branch.as_str() {
                    "" => "main".to_owned(),
                    branch => branch.to_owned(),
                };
                let access = if routing["permissionMode"] == "plan" {
                    "Plan only"
                } else {
                    "Full access"
                };
                menu = menu
                    .child(self.menu_row(
                        "attach-repo",
                        "Repository",
                        repo,
                        false,
                        !busy,
                        cx,
                        |s, w, cx| s.open_prompt("repo", w, cx),
                    ))
                    .child(self.menu_row(
                        "attach-branch",
                        "Base branch",
                        branch,
                        false,
                        !busy,
                        cx,
                        |s, w, cx| s.open_prompt("branch", w, cx),
                    ))
                    .child(self.menu_row(
                        "attach-permission",
                        "Permission",
                        access,
                        false,
                        !busy,
                        cx,
                        |s, w, cx| s.open_composer_picker("access", w, cx),
                    ));
            }
            "effort" => menu = menu.children(self.thinking_menu(routing, busy, cx)),
            "model" => menu = menu.children(self.lead_menu(routing, busy, model, cx)),
            _ => {}
        }
        menu.when(matches!(open, "mode" | "attach"), |v| {
            v.on_mouse_down_out(cx.listener(|s, event: &gpui::MouseDownEvent, _, cx| {
                s.dismiss_prompt_outside(event, cx)
            }))
        })
        .into_any_element()
    }

    /// One menu item: label, muted detail underneath, and a check when selected.
    fn menu_row(
        &self,
        id: &str,
        label: &'static str,
        detail: impl Into<SharedString>,
        selected: bool,
        enabled: bool,
        cx: &mut Context<Self>,
        action: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) -> Stateful<Div> {
        self.composer_button(id, "", enabled, cx, action)
            .w_full()
            .h_auto()
            .min_h(px(34.))
            .py(px(5.))
            .px(px(10.))
            .rounded(px(8.))
            .when(selected, |row| row.bg(theme().hover))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(1.))
                    .child(
                        div()
                            .text_size(px(12.5))
                            .text_color(theme().text)
                            .child(label),
                    )
                    .child(
                        div()
                            .text_size(px(10.5))
                            .text_color(theme().text_muted)
                            .child(detail.into()),
                    ),
            )
            .when(selected, |row| {
                row.child(crate::icon::stroke(CHECK, theme().accent, 14., 2.))
            })
    }

    /// A strip of the newest screenshots; a click attaches one. Thumbnails
    /// are made in the background the first time they are shown.
    fn recent_screenshots(&self, busy: bool, cx: &mut Context<Self>) -> Option<Div> {
        let shots = super::composer_screenshots::recent(5);
        if shots.is_empty() {
            return None;
        }
        let missing: Vec<_> = shots
            .iter()
            .filter(|p| super::composer_screenshots::thumbnail(p).is_none_or(|t| !t.exists()))
            .cloned()
            .collect();
        if !missing.is_empty() && !self.composer.read(cx).controls.thumbs_pending {
            self.composer
                .update(cx, |i, _| i.controls.thumbs_pending = true);
            let task = cx
                .background_executor()
                .spawn(async move { super::composer_screenshots::make_thumbnails(missing) });
            let editor = self.composer.downgrade();
            cx.spawn(async move |this, cx| {
                task.await;
                let _ = editor.update(cx, |i, _| i.controls.thumbs_pending = false);
                let _ = this.update(cx, |_, cx| cx.notify());
            })
            .detach();
        }
        let mut strip = div().flex().gap(px(6.)).px(px(4.)).pb(px(6.));
        for (index, path) in shots.into_iter().enumerate() {
            let thumb = super::composer_screenshots::thumbnail(&path).filter(|t| t.exists());
            let attach = path.clone();
            strip = strip.child(
                self.composer_button(
                    &format!("attach-shot-{index}"),
                    "",
                    !busy,
                    cx,
                    move |s, w, cx| {
                        s.close_composer_picker(w, cx);
                        s.composer
                            .update(cx, |i, cx| i.attach_paths(vec![attach.clone()], cx));
                    },
                )
                .w(px(50.))
                .h(px(50.))
                .px(px(0.))
                .rounded(px(9.))
                .overflow_hidden()
                .border_1()
                .border_color(theme().border)
                .bg(theme().hover)
                .children(
                    thumb.map(|t| gpui::img(t).size_full().object_fit(gpui::ObjectFit::Cover)),
                ),
            );
        }
        Some(
            div()
                .flex()
                .flex_col()
                .child(
                    div()
                        .px(px(8.))
                        .pt(px(2.))
                        .pb(px(6.))
                        .text_size(px(10.))
                        .font_weight(gpui::FontWeight::LIGHT)
                        .text_color(theme().text_faint)
                        .child("RECENT SCREENSHOTS"),
                )
                .child(strip),
        )
    }

    /// A model on the thread's runtime switches in place. Another runtime cannot
    /// take over a thread with history (the desktop hands off or starts fresh), so
    /// it starts a fresh conversation there; an empty thread changes runtime.
    pub(super) fn choose_lead(
        &mut self,
        backend: &str,
        model: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let routing = self.composer_routing(cx).unwrap_or(Value::Null);
        if routing["backend"] == backend {
            self.composer_choice("model", model, window, cx);
            return;
        }
        let Some(session) = self
            .selected
            .as_ref()
            .and_then(|id| self.sessions.iter().find(|s| &s.id == id))
            .cloned()
        else {
            return;
        };
        let Some(repo) = session.repo_path.clone() else {
            return;
        };
        // Saved messages remain authoritative before their rows are retained.
        // Keep live rows as well: a new reply can precede the next session list.
        let fresh = session.message_count > 0 || !self.rows.is_empty();
        let id = if fresh {
            format!(
                "thoughts-next-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            )
        } else {
            session.id.clone()
        };
        let client = self.client.clone();
        let (backend, model) = (backend.to_owned(), model.to_owned());
        let name = std::path::Path::new(&repo)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let editor = self.composer.clone();
        editor.update(cx, |i, cx| {
            i.controls.busy = true;
            i.controls.error.clear();
            cx.notify();
        });
        let thread = id.clone();
        let task = cx.background_executor().spawn(async move {
            let defaults = client.url("/api/panel/operator-defaults").unwrap();
            client
                .request("POST", &defaults)
                .send_json(json!({"orchestratorBackend": backend, "orchestratorModel": model}))
                .map_err(|e| e.to_string())?;
            let history = client.url("/api/v2/chat-history").unwrap();
            client
                .request("POST", &history)
                .send_json(json!({
                    "tabId": thread, "messages": [], "backend": backend, "model": model,
                    "repoPath": repo, "repoName": name, "title": "New conversation",
                }))
                .map_err(|e| e.to_string())?;
            Ok::<_, String>(())
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            let _ = this.update_in(cx, |this, window, cx| {
                editor.update(cx, |i, cx| {
                    i.controls.busy = false;
                    i.controls.open = None;
                    i.controls.model = None;
                    if let Err(error) = &result {
                        i.controls.error = format!("Could not switch the lead: {error}");
                    }
                    cx.notify();
                });
                if result.is_ok() {
                    this.selected = Some(id);
                    this.load_sessions(cx);
                }
                editor.read(cx).focus.focus(window);
            });
        })
        .detach();
    }
}
