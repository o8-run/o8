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
        let current = theme::choice_name();
        let imported = theme::imported_themes()
            .into_iter()
            .map(|(mode, label)| (mode, label, "Imported VS Code theme.".to_string()));
        for (mode, label, description) in [
            ("light", "Light Solid", "Opaque panels and workspace."),
            ("dark", "Dark Solid", "Opaque panels and workspace."),
            ("glass", "All Glass", "Glass across the entire window."),
            (
                "system",
                "System",
                "Light or Dark Solid, as the system is set.",
            ),
        ]
        .map(|(mode, label, description)| (mode.into(), label.into(), description.into()))
        .into_iter()
        .chain(imported)
        {
            let active = current == mode;
            let action = mode.clone();
            choices = choices.child(
                self.button(
                    format!("setting-appearance-{mode}"),
                    label,
                    true,
                    active,
                    window,
                    cx,
                    move |this, _, cx| {
                        cx.emit(Action::Appearance(action.clone()));
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
        let import = self.button(
            "setting-theme-import".into(),
            "Import VS Code theme…".into(),
            true,
            false,
            window,
            cx,
            |this, _, cx| this.choose_theme_file(cx),
        );
        let import_error = self.theme_import_error.clone().map(|error| {
            div()
                .debug_selector(|| "setting-theme-import-error".into())
                .text_size(px(11.))
                .text_color(theme().danger)
                .child(error)
        });
        let mut widths = div().flex().flex_wrap().gap(px(12.));
        for (name, label, _) in theme::CHAT_WIDTHS {
            let active = theme::chat_width_name() == name;
            widths = widths.child(
                self.button(
                    format!("setting-chat-width-{name}"),
                    label.into(),
                    true,
                    active,
                    window,
                    cx,
                    move |this, _, cx| {
                        if theme::set_chat_width(name) {
                            cx.refresh_windows();
                        }
                        this.changed(cx);
                    },
                )
                .border_1()
                .border_color(if active {
                    theme().accent
                } else {
                    theme().border
                }),
            );
        }
        div().flex().flex_col().gap(px(16.))
            .child(div().text_color(theme().text_muted).child("Theme"))
            .child(choices)
            .child(import)
            .children(import_error)
            .child(div().text_color(theme().text_muted).child("Chat width"))
            .child(widths)
            .child(div().text_size(px(11.)).text_color(theme().text_muted)
                .child("Changes apply immediately and are saved for the next launch. Glass uses the macOS desktop material where supported; other platforms may use solid surfaces."))
            .into_any_element()
    }
    fn choose_theme_file(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Import VS Code theme".into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            if let Some(path) = paths.first() {
                let _ = this.update(cx, |this, cx| this.import_theme(path, cx));
            }
        })
        .detach();
    }
    /// Adds a VS Code theme file to Appearance's themes. A file that cannot be
    /// read or mapped leaves an error row and changes nothing.
    pub(crate) fn import_theme(&mut self, path: &std::path::Path, cx: &mut Context<Self>) {
        let file = path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        let result = std::fs::read_to_string(path)
            .map_err(|error| format!("Could not read the file: {error}."))
            .and_then(|source| theme::import_theme(&source, &file));
        self.theme_import_error = result
            .err()
            .map(|error| format!("Could not import {file}. {error}"));
        self.changed(cx);
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
