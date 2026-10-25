use super::*;
use crate::{settings_fields::SECTIONS, theme::current as theme};
use gpui::{AnyElement, Div, KeyDownEvent, Render, Stateful, canvas, div, prelude::*, px};

impl Settings {
    fn button(
        &mut self,
        id: String,
        label: String,
        enabled: bool,
        selected: bool,
        window: &Window,
        cx: &mut Context<Self>,
        action: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) -> Stateful<Div> {
        let focus = self
            .controls
            .entry(id.clone())
            .or_insert_with(|| cx.focus_handle())
            .clone();
        let focused = focus.is_focused(window);
        let mouse_focus = focus.clone();
        let action = Rc::new(action);
        let key_action = action.clone();
        div()
            .id(gpui::SharedString::from(id.clone()))
            .debug_selector(move || id.clone())
            .track_focus(&focus)
            .tab_stop(enabled)
            .h(px(26.))
            .px(px(10.))
            .rounded(px(7.))
            .text_size(px(12.))
            .flex()
            .items_center()
            .flex_shrink_0()
            .bg(if focused || selected {
                theme().selection
            } else {
                theme().surface_raised
            })
            .text_color(if focused {
                theme().accent
            } else {
                theme().text_secondary
            })
            .opacity(if enabled { 1. } else { 0.45 })
            .when(enabled, |v| {
                v.cursor_pointer().hover(|v| v.bg(theme().hover))
            })
            .child(label)
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(move |_, _, window, _| {
                    if enabled {
                        mouse_focus.focus(window);
                    }
                }),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                if enabled {
                    action(this, window, cx);
                }
            }))
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                if enabled && matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    key_action(this, window, cx);
                    cx.stop_propagation();
                }
            }))
    }
    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event.keystroke.key.as_str() {
            "escape" if !self.busy => {
                if self.editor.is_some() || self.confirm.is_some() {
                    self.cancel(window, cx);
                } else {
                    cx.emit(Close);
                }
            }
            "tab" => {
                if event.keystroke.modifiers.shift {
                    window.focus_prev();
                } else {
                    window.focus_next();
                }
            }
            "f" if event.keystroke.modifiers.control || event.keystroke.modifiers.platform => {
                self.search.read(cx).focus.focus(window)
            }
            "pageup" | "pagedown" => {
                let mut offset = self.scroll.offset();
                offset.y = (offset.y
                    + px(if event.keystroke.key == "pageup" {
                        300.
                    } else {
                        -300.
                    }))
                .clamp(-self.scroll.max_offset().height, px(0.));
                self.scroll.set_offset(offset);
            }
            _ => return,
        }
        self.changed(cx);
        cx.stop_propagation();
    }
    fn row(
        &mut self,
        field: &'static Field,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let value = self
            .snapshot
            .as_ref()
            .and_then(|s| s.values.get(field.id))
            .cloned()
            .unwrap_or(Value::Null);
        let locked = self.locked(field);
        let env = self
            .snapshot
            .as_ref()
            .and_then(|s| s.sources.get(field.id))
            .is_some_and(|s| s == "env");
        let detail = if env {
            "Controlled by the server environment. Change the environment and restart o8 to edit it here."
        } else {
            field.detail
        };
        let mut controls = div().flex().flex_wrap().gap(px(8.));
        match field.kind {
            Kind::Toggle => {
                let next = !value.as_bool().unwrap_or(false);
                controls = controls.child(self.button(
                    format!("setting-{}", field.id),
                    field.display(&value),
                    !locked,
                    value == true,
                    window,
                    cx,
                    move |this, _, cx| this.set(field, Value::Bool(next), cx),
                ));
            }
            Kind::Choice(options) => {
                for (index, (key, label)) in options.iter().enumerate() {
                    controls = controls.child(self.button(
                        format!("setting-{}-{index}", field.id),
                        (*label).into(),
                        !locked,
                        value == *key,
                        window,
                        cx,
                        move |this, _, cx| this.set(field, Value::from(*key), cx),
                    ));
                }
            }
            _ => {
                controls = controls
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(theme().text_secondary)
                            .child(field.display(&value)),
                    )
                    .child(self.button(
                        format!("edit-{}", field.id),
                        "Edit".into(),
                        !locked,
                        false,
                        window,
                        cx,
                        move |this, window, cx| this.edit(field, window, cx),
                    ));
            }
        }
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .py(px(16.))
            .border_b_1()
            .border_color(theme().border)
            .child(div().text_size(px(13.5)).child(field.label))
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child(detail),
            )
            .child(controls)
            .into_any_element()
    }
    fn key_row(
        &mut self,
        provider: Provider,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let enabled = !self.busy && !self.uncertain;
        let id = provider.id.clone();
        let edit_id = id.clone();
        let toggle_id = id.clone();
        let remove_id = id.clone();
        let mut controls = div()
            .flex()
            .flex_wrap()
            .gap(px(8.))
            .child(
                self.button(
                    format!("key-edit-{id}"),
                    if provider.configured {
                        "Replace key"
                    } else {
                        "Add key"
                    }
                    .into(),
                    enabled,
                    false,
                    window,
                    cx,
                    move |this, window, cx| {
                        this.begin(Target::Key(edit_id.clone()), "", window, cx)
                    },
                ),
            )
            .child(
                self.button(
                    format!("key-enabled-{id}"),
                    if provider.enabled {
                        "Turn off"
                    } else {
                        "Turn on"
                    }
                    .into(),
                    enabled,
                    provider.enabled,
                    window,
                    cx,
                    move |this, _, cx| {
                        this.write(
                            "PATCH",
                            true,
                            json!({"provider":toggle_id,"enabled":!provider.enabled}),
                            cx,
                        )
                    },
                ),
            )
            .child(self.button(
                format!("key-remove-{id}"),
                "Remove key".into(),
                enabled && provider.configured,
                false,
                window,
                cx,
                move |this, _, cx| {
                    this.confirm = Some(remove_id.clone());
                    this.changed(cx);
                },
            ));
        if id == "openrouter" {
            controls = controls.child(self.button(
                "key-check-openrouter".into(),
                "Recheck connection".into(),
                enabled,
                false,
                window,
                cx,
                |this, _, cx| {
                    this.write(
                        "PATCH",
                        true,
                        json!({"provider":"openrouter","check":true}),
                        cx,
                    )
                },
            ));
        }
        let mut row = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .py(px(16.))
            .border_b_1()
            .border_color(theme().border)
            .child(provider.label())
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child(provider.status()),
            )
            .child(controls);
        if self.confirm.as_ref() == Some(&id) {
            row = row.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(8.))
                    .text_color(theme().danger)
                    .child("Remove the saved key? External environment keys are unchanged.")
                    .child(
                        self.button(
                            "settings-confirm-remove".into(),
                            "Remove key".into(),
                            enabled,
                            false,
                            window,
                            cx,
                            move |this, _, cx| {
                                this.write("DELETE", true, json!({"provider":id}), cx)
                            },
                        )
                        .text_color(theme().danger),
                    )
                    .child(self.button(
                        "settings-cancel-remove".into(),
                        "Cancel".into(),
                        enabled,
                        false,
                        window,
                        cx,
                        |this, window, cx| this.cancel(window, cx),
                    )),
            );
        }
        row.into_any_element()
    }
    fn editor_view(
        &mut self,
        editor: Editor,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let title = match &editor.target {
            Target::Field(field, _) => field.label,
            Target::Key(_) => "Enter a new provider key",
            Target::File(_) => "Edit settings.toml",
        };
        let file = matches!(editor.target, Target::File(_));
        let field = matches!(editor.target, Target::Field(_, _));
        let mut actions = div()
            .flex()
            .flex_wrap()
            .gap(px(8.))
            .child(self.button(
                "settings-save".into(),
                if self.busy { "Saving…" } else { "Save" }.into(),
                !self.busy && !self.uncertain && !self.conflict,
                true,
                window,
                cx,
                |this, _, cx| this.save(cx),
            ))
            .child(self.button(
                "settings-cancel".into(),
                "Cancel".into(),
                !self.busy,
                false,
                window,
                cx,
                |this, window, cx| this.cancel(window, cx),
            ));
        if file || field {
            actions = actions.child(
                self.button(
                    "settings-file-reload".into(),
                    if file {
                        "Reload file"
                    } else {
                        "Reload setting"
                    }
                    .into(),
                    !self.busy,
                    false,
                    window,
                    cx,
                    |this, window, cx| {
                        if let Some(Editor {
                            target: Target::Field(field, _),
                            ..
                        }) = this.editor.clone()
                        {
                            this.edit(field, window, cx);
                        } else {
                            this.load(true, cx);
                        }
                    },
                ),
            );
        }
        let input = match editor.input {
            Input::Text(input) => input.into_any_element(),
            Input::Secret(input) => input.into_any_element(),
        };
        div().flex().flex_col().gap(px(16.)).child(title).child(actions)
            .when(file, |v| v.child(div().text_size(px(11.)).text_color(theme().text_muted).child("Only declared settings are shown. Additional entries stay on the server and are preserved on save. Shift+Enter inserts a line. Reload replaces this draft.")))
            .when(matches!(editor.target, Target::Key(_)), |v| v.child(div().text_size(px(11.)).text_color(theme().text_muted).child("Saved keys are never displayed. The new key leaves this input on Save.")))
            .child(div().id("settings-editor").debug_selector(|| "settings-editor".into())
                .on_mouse_down(gpui::MouseButton::Left, cx.listener(|this, _, window, cx| {
                    if let Some(editor) = &this.editor { match &editor.input { Input::Text(s) => s.read(cx).focus.focus(window), Input::Secret(s) => s.read(cx).focus.focus(window) } }
                })).child(input)).into_any_element()
    }
}
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
            |this, _, cx| this.load(false, cx),
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
            let fields: Vec<_> = FIELDS
                .iter()
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
            if fields.is_empty() {
                content = content.child(empty("No settings match this search."));
            }
            for field in fields {
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
                    .child(div().flex_1().child("Settings"))
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
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(|this, _, window, cx| this.search.read(cx).focus.focus(window)),
                    )
                    .child(self.search.clone()),
            )
            .when(self.busy, |v| {
                v.child(
                    div()
                        .debug_selector(|| "settings-loading".into())
                        .text_size(px(11.))
                        .child(self.note.clone()),
                )
            })
            .when(!self.busy && !self.note.is_empty(), |v| {
                v.child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child(self.note.clone()),
                )
            })
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
