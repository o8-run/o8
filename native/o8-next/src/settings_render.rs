//! Page layout; row controls stay in settings_view.rs.
use super::*;
use crate::{settings_fields::SECTIONS, theme::current as theme};
use gpui::{Div, Render, canvas, div, prelude::*, px};

impl Render for Settings {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.open_file && !self.busy {
            self.open_file = false;
            if let Some(toml) = self.snapshot.as_ref().and_then(|s| s.toml.as_ref()) {
                if toml.error.is_none() {
                    let text = toml.text.clone();
                    let revision = toml.revision.clone();
                    self.begin(Target::File(revision), &text, window, cx);
                }
            }
        }
        if !self.busy {
            if let Some(field) = self.open_field.take() {
                if !self.locked(field) {
                    if let Some(snapshot) = &self.snapshot {
                        if let Some(toml) = &snapshot.toml {
                            let revision = toml.revision.clone();
                            let value = &snapshot.values[field.id];
                            let text = match field.kind {
                                Kind::Number(scale, _) => {
                                    (value.as_f64().unwrap_or(0.) * scale).to_string()
                                }
                                _ => value.as_str().unwrap_or("").into(),
                            };
                            self.begin(Target::Field(field, revision), &text, window, cx);
                        }
                    }
                }
            }
        }
        let revision = self.revision;
        let painted = self.painted.clone();
        let close = self.button(
            "settings-close".into(),
            "Close settings (Esc)".into(),
            !self.busy,
            false,
            window,
            cx,
            |_, _, cx| cx.emit(Close),
        );
        let refresh = self.button(
            "settings-refresh".into(),
            "Refresh".into(),
            !self.busy,
            false,
            window,
            cx,
            |this, _, cx| {
                this.load(false, cx);
                this.load_panel(true, cx);
            },
        );
        let file = self.button(
            "settings-file-open".into(),
            "Edit settings.toml".into(),
            !self.busy && self.snapshot.is_some() && self.editor.is_none(),
            false,
            window,
            cx,
            |this, _, cx| this.load(true, cx),
        );
        let additional = match self.snapshot.as_ref().and_then(|s| s.toml.as_ref()) {
            Some(t) if t.error.is_none() && t.additional_settings_set => {
                "Additional TOML entries: set"
            }
            Some(t) if t.error.is_none() => "Additional TOML entries: not set",
            _ => "Additional TOML entries: unavailable",
        };
        let mut navigation = div()
            .id("settings-navigation")
            .debug_selector(|| "settings-navigation".into())
            .min_h_0()
            .overflow_y_scroll()
            .w(px(200.))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .gap(px(8.))
            .pr(px(16.));
        for (id, label) in SECTIONS {
            navigation = navigation.child(self.button(
                format!("settings-nav-{id}"),
                (*label).into(),
                !self.busy && self.editor.is_none(),
                self.section == *id,
                window,
                cx,
                move |this, _, cx| this.select(id, cx),
            ));
        }
        let query = self.search.read(cx).text.trim().to_lowercase();
        let mut content = div()
            .id("settings-content")
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(16.));
        if let Some(editor) = self.editor.clone() {
            content = content.child(self.editor_view(editor, window, cx));
        } else if self.section == "keys" {
            content = content.child("Provider keys").child(div().text_size(px(11.)).text_color(theme().text_muted).child("Only presence and connection state are shown. Changes apply to new sessions."));
            if let Some(keys) = &self.keys {
                let providers = keys.providers.clone();
                if providers.is_empty() {
                    content = content.child(empty("No provider keys are available."));
                }
                for provider in providers {
                    content = content.child(self.key_row(provider, window, cx));
                }
            }
        } else {
            let fields: Vec<_> = fields()
                .filter(|f| {
                    if query.len() >= 2 {
                        f.matches(&query)
                    } else {
                        f.section == self.section
                    }
                })
                .collect();
            content = content.child(if query.len() >= 2 {
                "Search results"
            } else {
                SECTIONS
                    .iter()
                    .find(|(id, _)| *id == self.section)
                    .unwrap()
                    .1
            });
            let appearance = panels::matches(
                "appearance",
                self.section,
                &query,
                "appearance theme light dark solid all glass workspace",
            );
            let keyboard = panels::matches(
                "keyboard",
                self.section,
                &query,
                "keyboard shortcuts help keybindings hotkeys",
            );
            let about = panels::matches(
                "about",
                self.section,
                &query,
                "about version platform mode updates github documentation releases credits",
            );
            let connections = panels::matches(
                "connections",
                self.section,
                &query,
                "connections adapter capabilities workers actions session transforms usage limits",
            );
            if connections {
                content = content.child(if query.len() >= 2 && self.section != "connections" {
                    self.panel_result("connections", "Connections", window, cx)
                } else {
                    self.connections_view(window, cx)
                });
            }
            if about {
                content = content.child(if query.len() >= 2 && self.section != "about" {
                    self.panel_result("about", "About", window, cx)
                } else {
                    self.about_view(window, cx)
                });
            }
            if keyboard {
                content = content.child(self.keyboard_view(window, cx));
            }
            if appearance {
                content = content.child(self.appearance_view(window, cx));
            }
            if fields.is_empty() && !appearance && !keyboard && !about && !connections {
                content = content.child(empty("No settings match this search."));
            }
            let mut previous = None;
            for field in fields {
                let group = (field.section, field.group());
                if previous != Some(group) {
                    content = content.child(
                        div()
                            .debug_selector(move || format!("settings-group-{}", field.group()))
                            .mt(px(16.))
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .child(if query.len() >= 2 {
                                format!("{} · {}", field.section_label(), field.group())
                            } else {
                                field.group().into()
                            }),
                    );
                    previous = Some(group);
                }
                content = content.child(self.row(field, window, cx));
            }
        }
        div()
            .id("settings-page")
            .debug_selector(|| "settings-page".into())
            .size_full()
            .flex()
            .flex_col()
            .p(px(24.))
            .gap(px(16.))
            .bg(theme().background)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .font_weight(gpui::FontWeight::LIGHT)
            .text_size(px(13.5))
            .track_focus(&self.focus)
            .tab_stop(false)
            .capture_key_down(cx.listener(Self::key))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(8.))
                    .items_center()
                    // Status sits beside the title: a line above the list
                    // pushed every row down mid-click, so a second click on a
                    // switch landed in the gap.
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .items_baseline()
                            .gap(px(10.))
                            .child("Settings")
                            .when(!self.note.is_empty(), |v| {
                                v.child(
                                    div()
                                        .when(self.busy, |v| {
                                            v.debug_selector(|| "settings-loading".into())
                                        })
                                        .truncate()
                                        .text_size(px(11.))
                                        .text_color(theme().text_muted)
                                        .child(self.note.clone()),
                                )
                            }),
                    )
                    .child(file)
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .child(additional),
                    )
                    .child(refresh)
                    .child(close),
            )
            .child(
                div()
                    .id("settings-search")
                    .debug_selector(|| "settings-search".into())
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .w_full()
                    .min_w_0()
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(|this, _, window, cx| this.search.read(cx).focus.focus(window)),
                    )
                    .child(div().flex_1().min_w_0().child(self.search.clone()))
                    .when(!query.is_empty(), |v| {
                        v.child(self.button(
                            "settings-search-clear".into(),
                            "Clear search".into(),
                            true,
                            false,
                            window,
                            cx,
                            |this, _, cx| this.clear_search(cx),
                        ))
                    }),
            )
            .when_some(self.error.clone(), |v, error| {
                v.child(
                    div()
                        .debug_selector(|| "settings-error".into())
                        .text_color(theme().danger)
                        .child(error),
                )
            })
            .when(self.conflict, |v| {
                v.child(
                    div()
                        .debug_selector(|| "settings-conflict".into())
                        .child("The file changed in another app. Reload before saving."),
                )
            })
            .child(
                div().flex().flex_1().min_h_0().child(navigation).child(
                    div()
                        .id("settings-scroll")
                        .debug_selector(|| "settings-scroll".into())
                        .flex_1()
                        .min_w_0()
                        .overflow_y_scroll()
                        .track_scroll(&self.scroll)
                        .child(content),
                ),
            )
            .when(
                !self.busy
                    && if self.section == "keys" {
                        self.keys.is_some()
                    } else {
                        self.snapshot.is_some()
                    },
                |v| v.child(div().debug_selector(|| "settings-loaded".into()).h(px(1.))),
            )
            .child(
                canvas(|_, _, _| (), move |_, _, _, _| painted.set(revision))
                    .h(px(1.))
                    .w_full(),
            )
    }
}
fn empty(label: &'static str) -> Div {
    div()
        .debug_selector(|| "settings-empty".into())
        .text_color(theme().text_muted)
        .child(label)
}
