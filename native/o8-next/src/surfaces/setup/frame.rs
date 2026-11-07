//! The desktop's onboarding frame (OnboardingFrame.tsx): the o8 wordmark,
//! "Local workspace" and the three-part progress rail (Project, Agent,
//! Workspace) above the current page, plus the footer's sounds switch and
//! Privacy link (Onboarding.tsx).
use super::{Setup, progress, sound};
use crate::theme::current as theme;
use gpui::{
    AnyElement, Context, FontWeight, Pixels, SharedString, Size, div, prelude::*, px, relative,
};

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
        .on_click(cx.listener(move |this, _, _, cx| this.set_sounds(!on, true, cx)))
        .into_any_element()
}

/// The footer's height, so the page above can centre in what is left.
pub(super) const FOOTER: f32 = 40.;
/// The footer under the frame: the sounds switch beside Privacy.
pub(super) fn footer(cx: &mut Context<Setup>) -> impl IntoElement {
    div()
        .flex_none()
        .h(px(FOOTER))
        .w_full()
        .flex()
        .items_center()
        .justify_end()
        .gap(px(8.))
        .px(px(24.))
        .pb(px(12.))
        .font_weight(FontWeight::LIGHT)
        .child(sounds(cx))
        .child(
            div()
                .id("setup-privacy-link")
                .debug_selector(|| "setup-privacy-link".into())
                .px(px(8.))
                .py(px(4.))
                .rounded(px(6.))
                .text_size(px(11.))
                .text_color(theme().text_secondary)
                .cursor_pointer()
                .hover(|v| v.bg(theme().hover))
                .child("Privacy")
                .on_click(|_, _, cx| cx.open_url("https://o8.run/privacy")),
        )
}

pub(super) fn frame(
    setup: &Setup,
    body: impl IntoElement,
    viewport: Size<Pixels>,
    fill: Option<f32>,
) -> impl IntoElement {
    let (parts, current) = rail(setup);
    // The desktop's clamp(20px, 4vw, 32px) across and clamp(20px, 3vh, 32px) down.
    let across = (f32::from(viewport.width) * 0.04).clamp(20., 32.);
    let down = (f32::from(viewport.height) * 0.03).clamp(20., 32.);
    let inset = move |v: gpui::Div| v.px(px(across)).py(px(down));
    let mut wordmark = div();
    wordmark
        .style()
        .text
        .get_or_insert_with(Default::default)
        .letter_spacing = Some(px(-2.));
    div()
        .debug_selector(|| "setup-frame".into())
        .w_full()
        .max_w(px(800.))
        .flex_none()
        .flex()
        .flex_col()
        // A page whose content scrolls inside the frame fills the window.
        .when_some(fill, |v, height| v.h(px(height)))
        .border_1()
        .border_color(theme().border)
        .rounded(px(16.))
        .bg(theme().surface)
        .child(
            inset(div())
                .flex_none()
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
                            wordmark
                                .flex()
                                .text_size(px(28.))
                                .font_weight(FontWeight::NORMAL)
                                .line_height(relative(1.))
                                .child("o8")
                                .child(div().text_color(crate::theme::brand_orange()).child(".")),
                        )
                        .child(
                            div()
                                .text_size(px(11.))
                                .font_weight(FontWeight::LIGHT)
                                .text_color(theme().text_muted)
                                .child("Local workspace"),
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
                                        .font_weight(FontWeight::LIGHT)
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
        .child(
            inset(div())
                .flex()
                .flex_col()
                .gap(px(20.))
                .when(fill.is_some(), |v| v.flex_1().min_h_0())
                .child(body),
        )
}
