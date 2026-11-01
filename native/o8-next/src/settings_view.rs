use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, Div, KeyDownEvent, Stateful, div, prelude::*, px};

impl Settings {
    pub(super) fn button(
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
    pub(super) fn key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event.keystroke.key.as_str() {
            "escape" if !self.busy => {
                if self.editor.is_some() || self.confirm.is_some() {
                    self.cancel(window, cx);
                } else if !self.search.read(cx).text.is_empty() {
                    self.clear_search(cx);
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
    pub(super) fn row(
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
            self.snapshot
                .as_ref()
                .and_then(|s| field.dependency_reason(&s.values))
                .unwrap_or(field.detail)
        };
        let mut controls = div().flex().flex_wrap().gap(px(8.));
        match field.kind {
            // A switch, not a button labelled with its state: a lone "Off"
            // read as text. An Off/On choice is the same control.
            Kind::Toggle | Kind::WordToggle(_) | Kind::Choice(&[("off", "Off"), ("on", "On")]) => {
                let toggle = matches!(field.kind, Kind::Toggle);
                let word = if let Kind::WordToggle(word) = field.kind {
                    word
                } else {
                    "on"
                };
                let on = if toggle { value == true } else { value == word };
                let next = match (toggle, on) {
                    (true, on) => Value::Bool(!on),
                    (false, true) => Value::from("off"),
                    (false, false) => Value::from(word),
                };
                let track = if on { theme().accent } else { theme().border };
                controls = controls.child(
                    self.button(
                        format!("setting-{}", field.id),
                        String::new(),
                        !locked,
                        false,
                        window,
                        cx,
                        move |this, _, cx| this.set(field, next.clone(), cx),
                    )
                    .w(px(34.))
                    .h(px(20.))
                    .p(px(0.))
                    .rounded_full()
                    // The track covers the button's own fill, so its hover
                    // tint never shows; the button keeps focus and keys.
                    .child(
                        div()
                            .size_full()
                            .p(px(2.))
                            .flex()
                            .items_center()
                            .rounded_full()
                            .bg(track)
                            .when(on, |v| v.justify_end())
                            .child(
                                div()
                                    .size(px(16.))
                                    .rounded_full()
                                    .bg(gpui::white())
                                    .shadow_sm(),
                            ),
                    ),
                );
            }
            Kind::TierEffort => {
                controls = controls.child(field.display(&value));
                for (index, (effort, label)) in crate::settings_fields::EFFORT.iter().enumerate() {
                    let mut next = value.clone();
                    next["effort"] = Value::from(*effort);
                    controls = controls.child(self.button(
                        format!("setting-{}-effort-{index}", field.id),
                        (*label).into(),
                        !locked,
                        value["effort"] == *effort,
                        window,
                        cx,
                        move |this, _, cx| this.set(field, next.clone(), cx),
                    ));
                }
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
            .debug_selector(move || format!("settings-row-{}", field.id))
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(16.))
            .py(px(16.))
            .border_b_1()
            .border_color(theme().border)
            .child(
                div()
                    .flex_1()
                    .min_w(px(200.))
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(div().text_size(px(13.5)).child(field.label))
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .child(detail),
                    ),
            )
            .child(controls.max_w(px(350.)).items_center().justify_end())
            .into_any_element()
    }
    pub(super) fn clear_search(&mut self, cx: &mut Context<Self>) {
        self.search.update(cx, |s, cx| s.clear(cx));
        self.scroll.set_offset(gpui::point(px(0.), px(0.)));
        self.changed(cx);
    }
    pub(super) fn key_row(
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
    pub(super) fn editor_view(
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
                .flex().flex_col().w_full().min_w_0()
                .on_mouse_down(gpui::MouseButton::Left, cx.listener(|this, _, window, cx| {
                    if let Some(editor) = &this.editor { match &editor.input { Input::Text(s) => s.read(cx).focus.focus(window), Input::Secret(s) => s.read(cx).focus.focus(window) } }
                })).child(input)).into_any_element()
    }
}
