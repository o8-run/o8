//! The composer's floating pickers, after the desktop ComposerPicker: mode and
//! permission menus, the lead model list grouped by runtime, and effort stops.
use super::*;
use gpui::{AnyElement, Div, Entity, Stateful};

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
            .w(px(if open == "effort" { 300. } else { 260. }))
            .max_h(px(520.))
            .overflow_y_scroll()
            .p(px(6.))
            .flex()
            .flex_col()
            .gap(px(1.))
            .rounded(px(16.))
            .border_1()
            .border_color(theme().border)
            .bg(crate::theme::menu_fill())
            .shadow_lg();
        // Mode and permission sit on the left of the footer; model and effort on the right.
        menu = if matches!(open, "mode" | "access") {
            menu.left(px(8.))
        } else {
            menu.right(px(8.))
        };
        match open {
            "mode" => {
                let picked = routing["pickedMode"].as_str().unwrap_or("solo");
                for (value, label, detail) in [
                    ("solo", "Solo", "Delegation off · works in this session"),
                    ("fast", "Shared", "Workers share this checkout"),
                    (
                        "multitask",
                        "Worktrees",
                        "Parallel packets in isolated worktrees",
                    ),
                ] {
                    menu = menu.child(self.menu_row(
                        &format!("mode-{value}"),
                        label,
                        detail,
                        picked == value,
                        !busy,
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
            "effort" => {
                let effort = routing["effort"].as_str().unwrap_or("medium");
                let mut stops = div().flex().gap(px(4.)).p(px(4.));
                for (value, label) in [
                    ("low", "Low"),
                    ("medium", "Medium"),
                    ("high", "High"),
                    ("xhigh", "Extra"),
                    ("max", "Max"),
                ] {
                    let selected = effort == value;
                    stops = stops.child(
                        self.composer_button(
                            &format!("effort-{value}"),
                            label,
                            !busy,
                            cx,
                            move |s, w, cx| s.composer_choice("effort", value, w, cx),
                        )
                        .flex_1()
                        .justify_center()
                        .h(px(30.))
                        .rounded(px(8.))
                        .when(selected, |stop| {
                            stop.bg(theme().selection).text_color(theme().text)
                        }),
                    );
                }
                menu = menu.child(header("Reasoning")).child(stops);
            }
            "model" => {
                let current = routing["model"].as_str().unwrap_or("");
                for (house, models) in HOUSES {
                    menu = menu.child(header(house));
                    for &(backend, value, label, detail) in *models {
                        menu = menu.child(self.menu_row(
                            &format!("model-{value}"),
                            label,
                            detail,
                            current == value,
                            !busy,
                            cx,
                            move |s, w, cx| s.choose_lead(backend, value, w, cx),
                        ));
                    }
                }
                if let Some(model) = model {
                    let input = model.clone();
                    menu = menu.child(header("Other model")).child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .px(px(4.))
                            .child(
                                div()
                                    .id("composer-model-input")
                                    .debug_selector(|| "composer-model-input".into())
                                    .flex_1()
                                    .min_w_0()
                                    .child(model),
                            )
                            .child(self.composer_button(
                                "composer-model-save",
                                if busy { "Saving…" } else { "Save" },
                                !busy,
                                cx,
                                move |s, w, cx| {
                                    let model = input.read(cx).text.trim().to_owned();
                                    s.composer_choice("model", &model, w, cx);
                                },
                            )),
                    );
                }
            }
            _ => {}
        }
        menu.when(open == "mode", |v| {
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
        detail: &'static str,
        selected: bool,
        enabled: bool,
        cx: &mut Context<Self>,
        action: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) -> Stateful<Div> {
        self.composer_button(id, "", enabled, cx, action)
            .w_full()
            .h(px(34.))
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
                            .child(detail),
                    ),
            )
            .when(selected, |row| {
                row.child(crate::icon::stroke(CHECK, theme().accent, 14., 2.))
            })
    }

    /// A model on the thread's runtime switches in place. Another runtime cannot
    /// take over a thread with history (the desktop hands off or starts fresh), so
    /// it starts a fresh conversation there; an empty thread changes runtime.
    fn choose_lead(
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

fn header(label: &'static str) -> impl IntoElement {
    div()
        .px(px(10.))
        .pt(px(8.))
        .pb(px(4.))
        .text_size(px(10.5))
        .text_color(theme().text_muted)
        .child(label)
}
