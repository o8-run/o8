use super::*;
use gpui::{AnyElement, Div, Render, SharedString, Stateful, div, px};

impl Tasks {
    fn button(
        &mut self,
        id: &'static str,
        label: impl Into<SharedString>,
        enabled: bool,
        window: &Window,
        cx: &mut Context<Self>,
        action: impl Fn(&mut Self, &mut Context<Self>) + 'static,
    ) -> Stateful<Div> {
        let focus = self
            .controls
            .entry(id)
            .or_insert_with(|| cx.focus_handle())
            .clone()
            .tab_stop(enabled);
        if enabled {
            self.order.push(id);
        }
        let selected = focus.is_focused(window);
        let mouse = focus.clone();
        let mut button = div()
            .id(id)
            .debug_selector(move || id.into())
            .track_focus(&focus)
            .tab_stop(enabled)
            .h(px(26.))
            .px(px(10.))
            .rounded(px(7.))
            .text_size(px(12.))
            .flex()
            .items_center()
            .flex_shrink_0()
            .bg(if selected {
                theme().selection
            } else {
                theme().surface_raised
            })
            .text_color(theme().text_secondary)
            .opacity(if enabled { 1. } else { 0.45 })
            .when(enabled, |button| {
                button
                    .cursor_pointer()
                    .hover(|style| style.bg(theme().hover))
            })
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(move |_, _, window, _| {
                    if enabled {
                        mouse.focus(window);
                    }
                }),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                if enabled {
                    action(this, cx);
                }
            }))
            .child(label.into());
        button.style().align_self = Some(gpui::AlignItems::FlexStart);
        button
    }
}
fn muted(text: impl Into<SharedString>) -> Div {
    div()
        .text_size(px(11.))
        .text_color(theme().text_muted)
        .child(text.into())
}
impl Render for Tasks {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.loaded && !self.reading {
            self.load(cx);
        }
        self.order.clear();
        let enabled = self.busy.is_none() && !self.reading;
        let refresh = self.button(
            "plugin-task-refresh",
            "Refresh",
            enabled,
            window,
            cx,
            |this, cx| this.load(cx),
        );
        let mut rows: Vec<AnyElement> = vec![];
        if self.drafts.len() > 1 {
            let at = self
                .drafts
                .iter()
                .position(|draft| {
                    self.draft()
                        .is_some_and(|selected| selected.task_id == draft.task_id)
                })
                .unwrap_or(0);
            let previous = self.button(
                "plugin-task-previous",
                "Previous task",
                enabled && at > 0,
                window,
                cx,
                move |this, cx| this.select(at.saturating_sub(1), cx),
            );
            let next = self.button(
                "plugin-task-next",
                "Next task",
                enabled && at + 1 < self.drafts.len(),
                window,
                cx,
                move |this, cx| this.select(at + 1, cx),
            );
            rows.push(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(8.))
                    .child(previous)
                    .child(muted(format!("{} of {}", at + 1, self.drafts.len())))
                    .child(next)
                    .into_any_element(),
            );
        }
        if let Some(draft) = self.draft().cloned() {
            let contract = &draft.contract;
            let launch = self.button(
                "plugin-task-launch",
                "Launch reviewed task",
                self.available(Action::Launch),
                window,
                cx,
                |this, cx| this.control(Action::Launch, cx),
            );
            let inspect = self.button(
                "plugin-task-inspect",
                "Inspect attempt",
                self.available(Action::Inspect),
                window,
                cx,
                |this, cx| this.control(Action::Inspect, cx),
            );
            let mut actions = div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(8.))
                .child(launch)
                .child(inspect);
            if self.stop_target().is_some() {
                actions = if self.confirming {
                    actions
                        .child(muted("Stop this attempt?"))
                        .child(
                            self.button(
                                "plugin-task-stop-confirm",
                                "Stop attempt",
                                enabled,
                                window,
                                cx,
                                |this, cx| this.control(Action::Stop, cx),
                            )
                            .text_color(theme().danger),
                        )
                        .child(self.button(
                            "plugin-task-stop-cancel",
                            "Cancel",
                            enabled,
                            window,
                            cx,
                            |this, cx| this.confirm(false, cx),
                        ))
                } else {
                    actions.child(
                        self.button(
                            "plugin-task-stop",
                            "Stop worker",
                            enabled,
                            window,
                            cx,
                            |this, cx| this.confirm(true, cx),
                        )
                        .text_color(theme().text_muted),
                    )
                };
            }
            rows.push(div().debug_selector(|| "plugin-task-contract".into())
                .flex().flex_col().gap(px(10.))
                .child(div().flex().flex_wrap().items_start().gap(px(10.))
                    .child(div().flex_1().min_w(px(160.)).text_size(px(13.)).child(contract.objective.clone()))
                    .child(actions))
                .child(muted("Read only. One attempt. No automatic retry, fallback, setup, or mission replacement. Review is required."))
                .child(muted(format!("{} · {} · {}", contract.runtime, contract.model,
                    if contract.provider.is_some() { "OpenRouter API · provider default reasoning".to_owned() }
                    else { format!("{} effort · native provider login", contract.effort) })))
                .children(contract.provider.as_ref().map(|policy| muted(format!(
                    "Up to {} model requests, {} output tokens per request and 90 seconds. Stops after reported cost reaches ${:.2}; the last request can exceed that amount. Unknown cost holds further requests.",
                    policy.max_requests, policy.max_output_tokens, policy.cost_usd))))
                .child(muted(format!("Computer: {}\nProject: {}\nRepository: {}", contract.machine_id, contract.project_id, contract.repo_id)))
                .child(muted(format!("Allowed files: {}", contract.allowed_files.join(", "))))
                .child(muted(format!("Acceptance evidence: {}", contract.evidence.join("; "))))
                .when(!draft.session_current, |row| row.child(muted("This task belongs to an earlier sign-in. Launch is held.")))
                .child(muted(format!("Task: {}\nContract: {}\nRevision: {}\nRules: {}", draft.task_id, draft.contract_hash,
                    draft.revision, draft.rules_digest)).font_family(theme().font_mono))
                .child(self.button("plugin-task-requirements", if self.expanded { "Hide exact task requirements" } else { "Exact task requirements" }, enabled,
                    window, cx, |this, cx| { this.expanded = !this.expanded; cx.notify(); }))
                .when(self.expanded, |row| row.child(muted(serde_json::to_string_pretty(&contract.sealed_task_contract).unwrap_or_default())
                    .debug_selector(|| "plugin-task-exact-requirements".into()).font_family(theme().font_mono)))
                .into_any_element());
        } else if let Some(target) = self.stop_target() {
            let mut actions = div()
                .flex()
                .flex_wrap()
                .gap(px(8.))
                .items_center()
                .child(muted(format!("Task {}", target.task)));
            if self.confirming {
                actions = actions
                    .child(muted("Stop this attempt?"))
                    .child(
                        self.button(
                            "plugin-task-stop-confirm",
                            "Stop attempt",
                            enabled,
                            window,
                            cx,
                            |this, cx| this.control(Action::Stop, cx),
                        )
                        .text_color(theme().danger),
                    )
                    .child(self.button(
                        "plugin-task-stop-cancel",
                        "Cancel",
                        enabled,
                        window,
                        cx,
                        |this, cx| this.confirm(false, cx),
                    ));
            } else {
                actions = actions.child(self.button(
                    "plugin-task-stop",
                    "Stop worker",
                    enabled,
                    window,
                    cx,
                    |this, cx| this.confirm(true, cx),
                ));
            }
            rows.push(actions.into_any_element());
        }
        let status = if self.reading {
            Some("Reading held tasks".into())
        } else if let Some(action) = self.busy {
            Some(action.busy().into())
        } else {
            self.message.clone().or_else(|| {
                self.draft()
                    .and_then(|draft| draft.execution.as_ref())
                    .map(outcome)
                    .or_else(|| self.has_attempt().then(|| UNCERTAIN.to_owned()))
            })
        };
        div().id("plugin-task-review").debug_selector(|| "plugin-task-review".into())
            .track_focus(&self.focus).flex().flex_col().gap(px(10.)).mt(px(14.))
            .on_key_down(cx.listener(|this, event, window, cx| { if this.key(event, window, cx) { cx.stop_propagation(); } }))
            .child(div().flex().items_center().justify_between().gap(px(12.)).child("Review held tasks").child(refresh))
            .child(muted("The plugin can prepare a task. This desktop starts one worker only after you review and launch it. Worker usage belongs to the selected provider; savings have not been measured."))
            .when(self.loaded && !self.reading && self.drafts.is_empty() && self.message.is_none(), |row| row.child(muted("No held tasks are available for this account.")))
            .children(rows)
            .children(status.map(|text: String| muted(text).debug_selector(|| "plugin-task-status".into())))
    }
}
