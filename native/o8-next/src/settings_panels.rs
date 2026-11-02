//! Settings-only panels use the same shell actions as the native workspace.
use super::*;
use crate::theme::{self, current as theme};
use gpui::{AnyElement, div, prelude::*, px};

impl Settings {
    pub(super) fn appearance_view(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut choices = div().flex().flex_wrap().gap(px(12.));
        for (mode, label, description) in [
            ("light", "Light Solid", "Opaque panels and workspace."),
            ("dark", "Dark Solid", "Opaque panels and workspace."),
            ("glass", "All Glass", "Glass across the entire window."),
        ] {
            let active = theme::appearance_name() == mode;
            choices = choices.child(
                self.button(
                    format!("setting-appearance-{mode}"),
                    label.into(),
                    true,
                    active,
                    window,
                    cx,
                    move |this, _, cx| {
                        cx.emit(Action::Appearance(mode));
                        this.changed(cx);
                    },
                )
                .h_auto()
                .min_h(px(90.))
                .w(px(180.))
                .p(px(16.))
                .flex_col()
                .items_start()
                .gap(px(8.))
                .border_1()
                .border_color(if active {
                    theme().accent
                } else {
                    theme().border
                })
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child(description),
                ),
            );
        }
        let mut widths = div().flex().flex_wrap().gap(px(12.));
        for (name, label, _) in theme::CHAT_WIDTHS {
            widths = widths.child(self.button(
                format!("setting-chat-width-{name}"),
                label.into(),
                true,
                theme::chat_width_name() == name,
                window,
                cx,
                move |this, _, cx| {
                    if theme::set_chat_width(name) {
                        cx.refresh_windows();
                    }
                    this.changed(cx);
                },
            ));
        }
        div().flex().flex_col().gap(px(16.))
            .child(div().text_color(theme().text_muted).child("Theme"))
            .child(choices)
            .child(div().text_color(theme().text_muted).child("Chat width"))
            .child(widths)
            .child(div().text_size(px(11.)).text_color(theme().text_muted)
                .child("Changes apply immediately and are saved for the next launch. Glass uses the macOS desktop material where supported; other platforms may use solid surfaces."))
            .into_any_element()
    }
    pub(super) fn panel_result(
        &mut self,
        section: &'static str,
        label: &'static str,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.button(
            format!("settings-result-{section}"),
            format!("Open {label}"),
            !self.busy,
            false,
            window,
            cx,
            move |this, _, cx| this.select(section, cx),
        )
        .into_any_element()
    }
    pub(super) fn keyboard_view(&mut self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child("Keyboard shortcuts")
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child("Browse the shortcuts available in this native workspace."),
            )
            .child(self.button(
                "setting-keyboard-open".into(),
                "Open keyboard shortcuts".into(),
                !self.busy,
                false,
                window,
                cx,
                |_, _, cx| cx.emit(Action::Shortcuts),
            ))
            .into_any_element()
    }
}

pub(super) fn matches(section: &str, active: &str, query: &str, keywords: &str) -> bool {
    if query.len() < 2 {
        section == active
    } else {
        query.split_whitespace().all(|word| keywords.contains(word))
    }
}

pub(super) fn fact(id: &str, label: &str, value: &str) -> gpui::Div {
    let selector = id.to_owned();
    let value_selector = format!("{id}-value-{value}");
    div()
        .debug_selector(move || selector.clone())
        .flex()
        .flex_wrap()
        .justify_between()
        .gap(px(16.))
        .py(px(12.))
        .border_b_1()
        .border_color(theme().border)
        .child(label.to_owned())
        .child(
            div()
                .debug_selector(move || value_selector.clone())
                .text_color(theme().text_secondary)
                .child(value.to_owned()),
        )
}
