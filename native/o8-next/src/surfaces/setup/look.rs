//! The desktop onboarding's control and type styles (onboarding-style.ts,
//! OnboardingFeedback.tsx and the setup's renderButton), shared by every
//! setup page.
use super::sound;
use crate::theme::current as theme;
use gpui::{AnyElement, Div, FontWeight, SharedString, Stateful, div, prelude::*, px, relative};

/// The desktop's three button looks.
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Look {
    /// `onboardingButtonStyle`: a bordered control.
    Bordered,
    /// `renderButton`: the step's main action, filled with the text colour.
    Primary,
    /// `onboardingQuietButtonStyle`: no border or fill, secondary text.
    Quiet,
}

/// Controls that chime advance; the rest tick. On the desktop only the
/// optional voice and iPhone offers and the permissions Continue chime, and
/// those pages come later, so every setup control ticks for now.
const ADVANCE: [&str; 0] = [];

/// A setup button with the desktop's look. A pointer click on an enabled
/// one cues before its own action.
pub(super) fn button(
    id: &str,
    label: impl Into<SharedString>,
    enabled: bool,
    look: Look,
) -> Stateful<Div> {
    let selector = id.to_owned();
    let label: SharedString = label.into();
    let cue = if ADVANCE
        .iter()
        .any(|advance| id == *advance || (advance.ends_with('-') && id.starts_with(advance)))
    {
        sound::Cue::Advance
    } else {
        sound::Cue::Tick
    };
    let base = div()
        .id(SharedString::from(id.to_owned()))
        .debug_selector(move || selector.clone())
        .min_h(px(44.))
        .py(px(10.))
        .flex()
        .items_center()
        .gap(px(12.))
        .rounded(px(10.))
        .text_size(px(13.))
        .font_weight(FontWeight::LIGHT)
        .line_height(relative(1.5));
    match look {
        Look::Bordered => base
            .px(px(16.))
            .border_1()
            .border_color(theme().border)
            .bg(theme().background)
            .text_color(theme().text),
        Look::Primary => base
            .px(px(16.))
            .border_1()
            .border_color(gpui::transparent_black())
            .bg(theme().text)
            .text_color(theme().background),
        Look::Quiet => base.px(px(12.)).text_color(theme().text_secondary),
    }
    .opacity(if enabled { 1. } else { 0.5 })
    .when(enabled, |v| v.cursor_pointer())
    .when(enabled, |v| {
        v.on_click(move |event, _, _| {
            if !event.is_keyboard() {
                sound::play(cue);
            }
        })
    })
    .when(!label.is_empty(), |v| v.child(label))
}

/// A small capitalised section label, such as "YOUR PROJECTS".
pub(super) fn label(text: &'static str) -> Div {
    div()
        .text_size(px(10.))
        .font_weight(FontWeight::LIGHT)
        .text_color(theme().text_muted)
        .child(text)
}

/// A page title at the desktop's 28 px, weight 300.
pub(super) fn title(text: impl Into<SharedString>) -> Div {
    div()
        .text_size(px(28.))
        .font_weight(FontWeight::LIGHT)
        .line_height(relative(1.2))
        .child(text.into())
}

/// `OnboardingFeedback` in its error tone: a quiet card with a title, a
/// line under it and an optional action.
pub(super) fn feedback(
    selector: &'static str,
    title: impl Into<SharedString>,
    detail: &'static str,
    action: Option<AnyElement>,
) -> Div {
    div()
        .debug_selector(move || selector.into())
        .flex()
        .flex_col()
        .py(px(14.))
        .px(px(16.))
        .rounded(px(12.))
        .border_1()
        .border_color(theme().border)
        .bg(theme().surface_raised)
        .font_weight(FontWeight::LIGHT)
        .child(
            div()
                .text_size(px(13.))
                .line_height(relative(1.5))
                .text_color(theme().danger)
                .child(title.into()),
        )
        .child(
            div()
                .mt(px(4.))
                .text_size(px(12.))
                .line_height(relative(1.5))
                .text_color(theme().text_secondary)
                .child(detail),
        )
        .when_some(action, |v, action| v.child(div().mt(px(8.)).child(action)))
}

/// The action row under a page: secondary actions left, the main one right.
pub(super) fn actions(left: Vec<AnyElement>, right: Vec<AnyElement>) -> Div {
    div()
        .flex()
        .flex_wrap()
        .items_center()
        .justify_between()
        .gap(px(12.))
        .pt(px(12.))
        .border_t_1()
        .border_color(theme().border)
        .child(div().flex().items_center().gap(px(4.)).children(left))
        .child(div().flex().items_center().gap(px(8.)).children(right))
}
