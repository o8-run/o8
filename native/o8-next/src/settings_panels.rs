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
        let bespoke = theme::bespoke_themes()
            .into_iter()
            .map(|(mode, label, description)| (mode, label, description.to_string()));
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
        .chain(bespoke)
        .chain(imported)
        {
            let active = current == mode;
            let swatches = theme::swatches(&mode).map(|colors| {
                div().flex().gap(px(4.)).children(colors.map(|color| {
                    div()
                        .size(px(14.))
                        .rounded_full()
                        .border_1()
                        .border_color(theme().border)
                        .bg(color)
                }))
            });
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
                )
                .children(swatches),
            );
        }
        let tuned = theme::glass_settings();
        let mut backdrops = div().flex().flex_wrap().gap(px(12.));
        for (kind, label, vivid) in [("frosted", "Frosted", false), ("vivid", "Vivid", true)] {
            let active = tuned.vivid == vivid;
            backdrops = backdrops.child(
                self.button(
                    format!("setting-glass-backdrop-{kind}"),
                    label.into(),
                    true,
                    active,
                    window,
                    cx,
                    move |this, _, cx| {
                        cx.emit(Action::Appearance(format!("glass-backdrop:{kind}")));
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
        for (label, veil) in theme::GLASS_PRESETS {
            backdrops = backdrops.child(self.button(
                format!("setting-glass-preset-{}", label.to_lowercase()),
                label.into(),
                true,
                false,
                window,
                cx,
                move |this, _, cx| {
                    cx.emit(Action::Appearance(format!("glass-veil:{veil}")));
                    this.changed(cx);
                },
            ));
        }
        // The veil slider: a press or a drag along the track sets the share.
        let track = std::rc::Rc::new(std::cell::Cell::new(gpui::Bounds::<gpui::Pixels>::default()));
        let share_at = {
            let track = track.clone();
            move |x: gpui::Pixels| {
                let bounds = track.get();
                let width = f32::from(bounds.size.width).max(1.);
                ((f32::from(x) - f32::from(bounds.origin.x)) / width).clamp(0., 1.)
            }
        };
        let pressed = share_at.clone();
        let veil_slider = div()
            .flex()
            .items_center()
            .gap(px(12.))
            .child(
                div()
                    .w(px(56.))
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child("Veil"),
            )
            .child(
                div()
                    .id("setting-glass-veil")
                    .debug_selector(|| "setting-glass-veil".into())
                    .relative()
                    .w(px(260.))
                    .h(px(22.))
                    .flex()
                    .items_center()
                    .cursor_pointer()
                    .child(
                        gpui::canvas(
                            {
                                let track = track.clone();
                                move |bounds, _, _| track.set(bounds)
                            },
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .size_full(),
                    )
                    .child(
                        div()
                            .w_full()
                            .h(px(4.))
                            .rounded(px(2.))
                            .bg(theme().border)
                            .child(
                                div()
                                    .h_full()
                                    .rounded(px(2.))
                                    .w(gpui::relative(tuned.veil))
                                    .bg(theme().accent),
                            ),
                    )
                    .child(
                        div()
                            .absolute()
                            .top(px(5.))
                            .left(gpui::relative(tuned.veil))
                            .ml(px(-6.))
                            .size(px(12.))
                            .rounded_full()
                            .bg(theme().text),
                    )
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(move |this, event: &gpui::MouseDownEvent, _, cx| {
                            let veil = pressed(event.position.x);
                            cx.emit(Action::Appearance(format!("glass-veil:{veil}")));
                            this.changed(cx);
                        }),
                    )
                    .on_mouse_move(cx.listener(
                        move |this, event: &gpui::MouseMoveEvent, _, cx| {
                            if event.pressed_button == Some(gpui::MouseButton::Left) {
                                let veil = share_at(event.position.x);
                                cx.emit(Action::Appearance(format!("glass-veil:{veil}")));
                                this.changed(cx);
                            }
                        },
                    )),
            )
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child(format!("{}%", (tuned.veil * 100.).round())),
            );
        let glass = div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(backdrops)
            .child(veil_slider);
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
        // The whole window's zoom, as the primary modifier with = - 0 sets it.
        let percent = theme::zoom_percent();
        let mut zoom = div().flex().items_center().gap(px(12.));
        for (id, label, enabled, steps) in [
            ("out", "−", percent > theme::ZOOM_MIN, -1),
            ("reset", "Reset", percent != theme::ZOOM_DEFAULT, 0),
            ("in", "+", percent < theme::ZOOM_MAX, 1),
        ] {
            let button = self.button(
                format!("setting-zoom-{id}"),
                label.into(),
                enabled,
                false,
                window,
                cx,
                move |this, window, cx| {
                    match steps {
                        0 => crate::zoom::reset(window, cx),
                        steps => crate::zoom::step(steps, window, cx),
                    }
                    this.changed(cx);
                },
            );
            zoom = zoom.child(button.border_1().border_color(theme().border));
            if id == "out" {
                zoom = zoom.child(
                    div()
                        .debug_selector(|| "setting-zoom-level".into())
                        .min_w(px(44.))
                        .flex()
                        .justify_center()
                        .child(crate::zoom::label(percent)),
                );
            }
        }
        let installed = self
            .font_families
            .get_or_insert_with(|| window.text_system().all_font_names())
            .clone();
        let mut fonts = div().flex().flex_wrap().gap(px(12.));
        for (mono, kind, title) in [(false, "ui", "UI font"), (true, "mono", "Code font")] {
            let list_id = format!("setting-font-{kind}-list");
            let mut list = div()
                .id(gpui::SharedString::from(list_id.clone()))
                .debug_selector(move || list_id.clone())
                .flex()
                .flex_col()
                .gap(px(2.))
                .w(px(260.))
                .max_h(px(220.))
                .overflow_y_scroll();
            for option in theme::font_options(mono, &installed) {
                let label = if option.default {
                    format!("{} (default)", option.family)
                } else {
                    option.family.clone()
                };
                let family = option.family.clone();
                let picked = installed.clone();
                list = list.child(self.button(
                    format!("setting-font-{kind}-{}", option.family),
                    label,
                    true,
                    option.current,
                    window,
                    cx,
                    move |this, _, cx| {
                        if theme::set_font(mono, &family, &picked) {
                            cx.refresh_windows();
                        }
                        this.changed(cx);
                    },
                ));
            }
            fonts = fonts.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(div().text_color(theme().text_muted).child(title))
                    .child(list),
            );
        }
        div().flex().flex_col().gap(px(16.))
            .child(div().text_color(theme().text_muted).child("Theme"))
            .child(choices)
            .child(import)
            .children(import_error)
            .child(
                div()
                    .text_color(theme().text_muted)
                    .child("Glass (All Glass only): backdrop, presets and veil"),
            )
            .child(glass)
            .child(div().text_color(theme().text_muted).child("Chat width"))
            .child(widths)
            .child(div().text_color(theme().text_muted).child("Zoom"))
            .child(zoom)
            .child(fonts)
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
        // A re-imported running theme repaints with its new colors.
        if result.is_ok() {
            cx.refresh_windows();
        }
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
            .child(self.snapshot_hotkey_view(window, cx))
            .into_any_element()
    }
    fn snapshot_hotkey_view(&mut self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        use crate::snapshot_hotkey::{self as hotkey, Mode};
        let mut choices = div().flex().flex_wrap().gap(px(12.));
        for (mode, id, label) in [
            (Mode::Off, "off", "Off"),
            (Mode::Screen, "screen", "Screen"),
            (Mode::Window, "window", "Frontmost window"),
        ] {
            let active = hotkey::mode() == mode;
            choices = choices.child(
                self.button(
                    format!("setting-snapshot-hotkey-{id}"),
                    label.into(),
                    !self.busy,
                    active,
                    window,
                    cx,
                    move |this, _, cx| {
                        hotkey::set_mode(mode);
                        cx.emit(Action::SnapshotHotkey);
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
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(div().mt(px(8.)).child("Snapshot hotkey"))
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child("Press both Shift keys together to capture into a new chat in the open project, ready to type. Off by default and saved on this Mac."),
            )
            .child(choices)
            .child(
                div()
                    .debug_selector(|| "setting-snapshot-hotkey-permission".into())
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child(format!(
                        "macOS only. Needs Input Monitoring or Accessibility permission to see Shift in other apps, and Screen Recording to capture them. If it is missing, macOS shows its prompt and the hotkey stays off until you allow o8 under {}.",
                        hotkey::PERMISSION_PATH
                    )),
            )
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
