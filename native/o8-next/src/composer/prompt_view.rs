//! Native menu presentation, shared by the composer controls.
use super::*;
use gpui::{AnyElement, FontWeight, SharedString, StatefulInteractiveElement};
impl Surface {
    pub(super) fn slash_menu(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if self.composer.read(cx).controls.open.is_some() {
            return None;
        }
        let commands = self.composer.read(cx).slash_suggestions();
        if commands.is_empty() {
            return None;
        }
        let selected = self
            .composer
            .read(cx)
            .controls
            .slash
            .index
            .min(commands.len() - 1);
        let scroll = self.composer.read(cx).controls.slash.scroll.clone();
        let bounds = self.composer.read(cx).controls.context.card_bounds?;
        let mut menu = panel_content(
            "composer-slash-menu",
            (f32::from(bounds.size.width) - 16.).min(520.),
        )
        .child(small("Slash commands"));
        let mut list = div()
            .id("composer-slash-list")
            .max_h(px(292.))
            .overflow_y_scroll()
            .track_scroll(&scroll)
            .flex()
            .flex_col()
            .gap(px(2.));
        for (index, command) in commands.into_iter().enumerate() {
            list = list.child(
                div()
                    .id(SharedString::from(format!(
                        "slash-{}",
                        command.command.trim_start_matches('/')
                    )))
                    .debug_selector(move || {
                        format!("slash-{}", command.command.trim_start_matches('/'))
                    })
                    .px(px(8.))
                    .py(px(7.))
                    .rounded(px(8.))
                    .cursor_pointer()
                    .when(index == selected, |v| v.bg(theme().selection))
                    .hover(|v| v.bg(theme().hover))
                    .on_click(cx.listener(move |s, _, w, cx| {
                        s.composer
                            .update(cx, |i, cx| i.apply_slash(command, true, w, cx));
                        cx.notify();
                    }))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .text_size(px(12.5))
                                    .font_weight(FontWeight(300.))
                                    .child(command.command),
                            )
                            .child(small(command.group)),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(theme().text_secondary)
                            .child(format!("{} · {}", command.title, command.description)),
                    ),
            );
        }
        menu = menu
            .child(list)
            .on_mouse_down_out(cx.listener(|s, _, _, cx| {
                s.composer.update(cx, |i, cx| {
                    i.controls.slash.dismissed = Some(i.text.clone());
                    cx.notify();
                });
                cx.notify();
            }));
        let _ = window;
        Some(
            gpui::anchored()
                .position(point(bounds.left() + px(8.), bounds.top() - px(6.)))
                .anchor(gpui::Corner::BottomLeft)
                .child(menu)
                .into_any_element(),
        )
    }
    pub(super) fn prompt_popover(
        &mut self,
        open: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let title = match open {
            "quick" => "Quick actions",
            "prompts" => "Saved prompts",
            "repo" => "Repository",
            "branch" => "Base branch",
            "branch-create" => "Create branch",
            "rules" => "Session rules",
            "result" => "Command result",
            _ => "Save prompt",
        };
        let mut menu = panel("composer-prompt-picker", 460.).child(
            div()
                .flex()
                .justify_between()
                .child(small(title))
                .child(self.composer_button(
                    "composer-prompt-close",
                    "Close",
                    true,
                    cx,
                    |s, w, cx| s.close_composer_picker(w, cx),
                )),
        );
        if matches!(open, "save-prompt" | "branch-create") {
            menu = menu.child(self.prompt_form(open, cx));
        } else if open == "result" {
            menu = menu.child(
                div()
                    .id("composer-command-result-text")
                    .max_h(px(280.))
                    .overflow_y_scroll()
                    .text_size(px(12.))
                    .child(self.composer.read(cx).controls.prompt.feedback.clone()),
            );
        } else if open == "rules" {
            menu = menu.child(self.rules_view(cx));
        } else {
            if let Some(query) = self.composer.read(cx).controls.prompt.query.clone() {
                menu = menu.child(
                    div()
                        .id("composer-command-query")
                        .debug_selector(|| "composer-command-query".into())
                        .child(query),
                );
            }
            let state = &self.composer.read(cx).controls.prompt;
            let error = state.error.clone();
            let loading = state.loading;
            let selected = state.selected;
            if loading {
                menu = menu.child(small("Loading…"));
            } else if !error.is_empty() {
                menu = menu.child(small(error)).child(self.composer_button(
                    "composer-prompt-retry",
                    "Retry",
                    true,
                    cx,
                    move |s, _, cx| s.load_prompt_rows(open, cx),
                ));
            } else {
                let items = self.prompt_items(open, cx);
                if items.is_empty() {
                    menu = menu.child(small(match open {
                        "prompts" => "No matching prompts. Add one in Customize.",
                        "repo" => "No repositories in the registry.",
                        _ => "No matches.",
                    }));
                }
                let scroll = self.composer.read(cx).controls.prompt.scroll.clone();
                let mut list = div()
                    .id("composer-prompt-list")
                    .track_scroll(&scroll)
                    .max_h(px(280.))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap(px(2.));
                for (index, item) in items.into_iter().enumerate() {
                    let chosen = match open {
                        "repo" => self.intent_repo(cx).as_deref() == Some(item.0.as_str()),
                        "branch" => self.composer.read(cx).controls.prompt.branch == item.0,
                        _ => index == selected,
                    };
                    let pick = item.clone();
                    list = list.child(
                        div()
                            .id(SharedString::from(format!("composer-prompt-item-{index}")))
                            .debug_selector(move || format!("composer-prompt-item-{index}"))
                            .p(px(8.))
                            .rounded(px(8.))
                            .cursor_pointer()
                            .when(chosen, |v| v.bg(theme().selection))
                            .hover(|v| v.bg(theme().hover))
                            .on_click(cx.listener(move |s, _, w, cx| {
                                s.pick_prompt_item(open, pick.clone(), w, cx)
                            }))
                            .child(div().text_size(px(12.5)).child(item.1))
                            .child(
                                div()
                                    .text_size(px(10.5))
                                    .text_color(theme().text_secondary)
                                    .truncate()
                                    .child(item.2),
                            ),
                    );
                }
                menu = menu.child(list);
                if open == "branch" {
                    menu = menu.child(self.composer_button(
                        "composer-branch-new",
                        "New branch",
                        true,
                        cx,
                        |s, w, cx| s.open_prompt("branch-create", w, cx),
                    ));
                }
            }
        }
        let opened = self.composer.read(cx).controls.prompt.opened;
        if let Some(at) = opened {
            let progress = (cx
                .background_executor()
                .now()
                .saturating_duration_since(at)
                .as_secs_f32()
                * 1000.
                / crate::motion::COMPOSER_MENU_ENTER_MS as f32)
                .min(1.);
            if progress < 1. {
                window.request_animation_frame();
            }
            menu = menu.opacity(crate::motion::ease_out(progress));
        }
        menu.on_mouse_down_out(
            cx.listener(|s, event: &gpui::MouseDownEvent, _, cx| {
                s.dismiss_prompt_outside(event, cx)
            }),
        )
        .into_any_element()
    }
    fn prompt_form(&self, open: &str, cx: &mut Context<Self>) -> AnyElement {
        let state = &self.composer.read(cx).controls.prompt;
        let fields = state.fields.clone();
        let error = state.error.clone();
        let result = state.result.clone();
        let repo_scope = state.scope;
        let busy = state.loading;
        let mut form = div().flex().flex_col().gap(px(8.));
        for (index, field) in fields.iter().enumerate() {
            form = form
                .child(small(if open == "branch-create" {
                    "Branch name"
                } else {
                    ["Title", "Tags (comma separated)", "Prompt"][index]
                }))
                .child(
                    div()
                        .id(SharedString::from(format!("composer-prompt-field-{index}")))
                        .debug_selector(move || format!("composer-prompt-field-{index}"))
                        .max_h(px(160.))
                        .overflow_y_scroll()
                        .child(field.clone()),
                );
        }
        if open == "save-prompt" {
            form = form.child(
                div()
                    .flex()
                    .gap(px(6.))
                    .child(self.composer_button(
                        "composer-prompt-global",
                        if !repo_scope { "✓ Global" } else { "Global" },
                        !busy,
                        cx,
                        |s, _, cx| {
                            s.composer.update(cx, |i, cx| {
                                i.controls.prompt.scope = false;
                                cx.notify();
                            });
                            cx.notify();
                        },
                    ))
                    .child(self.composer_button(
                        "composer-prompt-repo",
                        if repo_scope {
                            "✓ Repository"
                        } else {
                            "Repository"
                        },
                        !busy && self.intent_repo(cx).is_some(),
                        cx,
                        |s, _, cx| {
                            s.composer.update(cx, |i, cx| {
                                i.controls.prompt.scope = true;
                                cx.notify();
                            });
                            cx.notify();
                        },
                    )),
            );
        }
        if !error.is_empty() {
            form = form.child(small(error));
        }
        if !result.is_empty() {
            form = form.child(small(result));
        }
        form.child(self.composer_button(
            "composer-prompt-submit",
            if busy {
                "Saving…"
            } else if open == "branch-create" {
                "Create branch"
            } else {
                "Save prompt"
            },
            !busy,
            cx,
            |s, _, cx| s.submit_prompt_form(cx),
        ))
        .into_any_element()
    }
}
pub(super) fn small(text: impl Into<SharedString>) -> impl IntoElement {
    div()
        .text_size(px(10.5))
        .text_color(theme().text_secondary)
        .child(text.into())
}
fn panel_content(id: &'static str, width: f32) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .w(px(width))
        .p(px(8.))
        .flex()
        .flex_col()
        .gap(px(6.))
        .rounded(px(14.))
        .border_1()
        .border_color(theme().border)
        .bg(crate::theme::popover_background())
        .shadow_lg()
        .occlude()
}
fn panel(id: &'static str, width: f32) -> gpui::Stateful<gpui::Div> {
    panel_content(id, width)
        .absolute()
        .bottom_full()
        .left(px(8.))
        .mb(px(8.))
        .max_w(gpui::relative(1.))
}
