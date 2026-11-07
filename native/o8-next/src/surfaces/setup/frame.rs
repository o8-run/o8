//! The desktop's onboarding frame (OnboardingFrame.tsx): the o8 wordmark,
//! "Local workspace", the sounds switch, and the three-part progress rail
//! (Project, Agent, Workspace) above the current page.
use super::{Setup, progress, sound};
use crate::theme::current as theme;
use gpui::{AnyElement, Context, SharedString, div, prelude::*, px, relative};

/// One rail entry: its label, the line under it, and whether it is done.
pub(super) struct Part {
    pub label: &'static str,
    pub detail: String,
    pub done: bool,
}
/// The rail as the desktop words it, and which part is current.
pub(super) fn rail(setup: &Setup) -> (Vec<Part>, usize) {
    let step = progress::step_name(setup.step);
    let current = match step {
        "dispatch" => 1,
        "privacy" | "permissions" | "mobile" => 2,
        _ => 0,
    };
    let workspace = match step {
        "permissions" => "Optional voice setup",
        "mobile" => "Optional iPhone app",
        _ => "Privacy choices",
    };
    let agent_ready = setup
        .snapshot
        .as_ref()
        .is_some_and(|s| s.ready(&setup.backend, &setup.workers));
    let parts = vec![
        Part {
            label: "Project",
            detail: match &setup.project {
                Some(project) => project.name.clone(),
                None if current == 2 => "Optional".into(),
                None => "Choose a folder".into(),
            },
            done: setup.project.is_some(),
        },
        Part {
            label: "Agent",
            detail: if agent_ready {
                "Ready"
            } else if current == 1 {
                "Choose a tool"
            } else {
                "Check readiness"
            }
            .into(),
            done: agent_ready,
        },
        Part {
            label: "Workspace",
            detail: if current == 2 { workspace } else { "Next" }.into(),
            done: false,
        },
    ];
    (parts, current)
}

/// The sounds switch. It makes no cue of its own except the preview tick
/// when sounds turn on, as on the desktop.
fn sounds(cx: &mut Context<Setup>) -> AnyElement {
    let on = sound::on();
    div()
        .id("setup-sounds")
        .debug_selector(|| "setup-sounds".into())
        .px(px(8.))
        .py(px(4.))
        .rounded(px(6.))
        .text_size(px(11.))
        .text_color(theme().text_secondary)
        .cursor_pointer()
        .hover(|v| v.bg(theme().hover))
        .child(if on { "Sounds on" } else { "Sounds off" })
        .on_click(cx.listener(move |this, event: &gpui::ClickEvent, _, cx| {
            this.set_sounds(!on, !event.is_keyboard(), cx)
        }))
        .into_any_element()
}

pub(super) fn frame(
    setup: &Setup,
    body: impl IntoElement,
    cx: &mut Context<Setup>,
) -> impl IntoElement {
    let (parts, current) = rail(setup);
    let inset = |v: gpui::Div| v.px(px(32.)).py(px(28.));
    div()
        .debug_selector(|| "setup-frame".into())
        .w_full()
        .max_w(px(800.))
        .flex_none()
        .border_1()
        .border_color(theme().border)
        .rounded(px(16.))
        .bg(theme().surface)
        .child(
            inset(div())
                .pb(px(20.))
                .border_b_1()
                .border_color(theme().border)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(16.))
                        .mb(px(16.))
                        .child(
                            div()
                                .flex()
                                .text_size(px(28.))
                                .line_height(relative(1.))
                                .child("o8")
                                .child(div().text_color(crate::theme::brand_orange()).child(".")),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(sounds(cx))
                                .child(
                                    div()
                                        .text_size(px(11.))
                                        .text_color(theme().text_muted)
                                        .child("Local workspace"),
                                ),
                        ),
                )
                .child(
                    div()
                        .debug_selector(|| "setup-rail".into())
                        .grid()
                        .grid_cols(3)
                        .gap(px(12.))
                        .children(parts.into_iter().enumerate().map(|(index, part)| {
                            let here = index == current;
                            div()
                                .debug_selector(move || format!("setup-rail-{index}"))
                                .min_w_0()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .text_color(if here {
                                    theme().text
                                } else {
                                    theme().text_muted
                                })
                                .child(
                                    div()
                                        .size(px(26.))
                                        .flex_none()
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .rounded_full()
                                        .border_1()
                                        .border_color(theme().border)
                                        .text_size(px(11.))
                                        .when(here, |v| v.bg(theme().surface_raised))
                                        .child(SharedString::from(if part.done && !here {
                                            "✓".to_owned()
                                        } else {
                                            (index + 1).to_string()
                                        })),
                                )
                                .child(
                                    div()
                                        .min_w_0()
                                        .flex()
                                        .flex_col()
                                        .child(div().text_size(px(12.)).child(part.label))
                                        .child(
                                            div()
                                                .mt(px(4.))
                                                .text_size(px(10.))
                                                .truncate()
                                                .child(part.detail),
                                        ),
                                )
                        })),
                ),
        )
        .child(inset(div()).flex().flex_col().gap(px(20.)).child(body))
}
