use super::*;
use crate::composer::controls::{mode_label, model_label};
use gpui::{AnyElement, Div, KeyDownEvent, SharedString, Stateful};

#[path = "context_view.rs"]
mod context_view;

/// An icon-only footer control: a 28px target with the label as its tooltip.
fn icon_only(button: Stateful<Div>, path: &str, color: gpui::Rgba, label: String) -> Stateful<Div> {
    let label = SharedString::from(label);
    button
        .w(px(28.))
        .h(px(28.))
        .px(px(0.))
        .justify_center()
        .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(label.clone())).into())
        .child(crate::icon::stroke(path, color, 18., 1.6))
}

impl Surface {
    pub(crate) fn composer_footer(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let routing = self.composer_routing(cx).unwrap_or(Value::Null);
        let picked = routing["pickedMode"].as_str().unwrap_or("solo");
        let mode = mode_label(picked);
        let plan = routing["permissionMode"] == "plan";
        let access = if plan { "Plan only" } else { "Full access" };
        let enabled = self.queue_ready
            && !self.saving
            && !self.composer.read(cx).controls.busy
            && self.composer.read(cx).controls.pending_images == 0;
        let leading = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(6.))
            // The desktop footer's icon-only mode, permission and attach controls.
            .child(icon_only(
                self.composer_button("composer-mode", "", enabled, cx, |s, w, cx| {
                    s.open_composer_picker("mode", w, cx)
                }),
                match picked {
                    "multitask" => "M6 6v12m0-9h8a4 4 0 0 0 4-4 M6 2a2 2 0 1 0 0 4 2 2 0 1 0 0-4Z M6 18a2 2 0 1 0 0 4 2 2 0 1 0 0-4Z M18 1a2 2 0 1 0 0 4 2 2 0 1 0 0-4Z",
                    "fast" => "M6 5h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z M8 10v4m-2-2h4m5 0h3",
                    _ => "M6 5h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z M8 12h8",
                },
                theme().text_secondary,
                format!("Mode: {}", if picked == "solo" { "Delegation off" } else { mode }),
            ))
            .child(icon_only(
                self.composer_button("composer-access", "", enabled, cx, |s, w, cx| {
                    s.open_composer_picker("access", w, cx)
                }),
                if plan {
                    "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 13h8M8 17h5"
                } else {
                    "M7 11h10a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-4a3 3 0 0 1 3-3Z M8 11V7a4 4 0 0 1 7.5-2M12 15v2"
                },
                if plan { theme().accent } else { crate::theme::brand_orange() },
                format!("Permissions: {access}"),
            ))
            .child(icon_only(
                self.composer_button(
                    "composer-attach",
                    "",
                    enabled
                        && matches!(
                            routing["backend"].as_str(),
                            Some("codex" | "claude" | "fable" | "collide")
                        ),
                    cx,
                    |s, _, cx| s.attach_composer_image(cx),
                ),
                "M12 5v14M5 12h14",
                theme().text_secondary,
                "Attach image".into(),
            ))
            .when(self.queue["canSteer"] == true, |d| {
                d.child(self.composer_button(
                    "send-mode",
                    if self.send_next { "Queue" } else { "Steer" },
                    enabled,
                    cx,
                    |s, _, cx| {
                        s.send_next = !s.send_next;
                        cx.notify();
                    },
                ))
            });
        let trailing = div()
            .flex()
            .items_center()
            .gap(px(6.))
            .child(
                self.composer_button(
                    "composer-model",
                    &routing["model"]
                        .as_str()
                        .map_or("Model".into(), model_label),
                    enabled,
                    cx,
                    |s, w, cx| s.open_composer_picker("model", w, cx),
                )
                .max_w(px(140.))
                .truncate(),
            )
            .child(self.composer_button(
                "composer-effort",
                routing["effort"].as_str().unwrap_or("Effort"),
                enabled,
                cx,
                |s, w, cx| s.open_composer_picker("effort", w, cx),
            ))
            .child(
                self.composer_button("composer-microphone", "", false, cx, |_, _, _| {})
                    .w(px(26.))
                    .child(
                        canvas(
                            |_, _, _| (),
                            |bounds, _, window, _| {
                                // A stroked path activates viewport-sized GPU/MSAA
                                // targets. This small icon fits the existing quad pass.
                                let rect = |x, y, w, h| {
                                    Bounds::new(
                                        bounds.origin + point(px(x), px(y)),
                                        size(px(w), px(h)),
                                    )
                                };
                                let color = theme().text_secondary;
                                let stroke = px(1.3);
                                window.paint_quad(
                                    gpui::outline(rect(4., 1., 6., 11.), color, Default::default())
                                        .corner_radii(px(3.))
                                        .border_widths(stroke),
                                );
                                window.paint_quad(
                                    gpui::outline(rect(1., 7., 12., 8.), color, Default::default())
                                        .corner_radii(gpui::Corners {
                                            top_left: px(0.),
                                            top_right: px(0.),
                                            bottom_right: px(6.),
                                            bottom_left: px(6.),
                                        })
                                        .border_widths(gpui::Edges {
                                            top: px(0.),
                                            right: stroke,
                                            bottom: stroke,
                                            left: stroke,
                                        }),
                                );
                                window.paint_quad(gpui::fill(rect(6.35, 14., 1.3, 4.), color));
                                window.paint_quad(gpui::fill(rect(4., 17.35, 6., 1.3), color));
                            },
                        )
                        .w(px(14.))
                        .h(px(20.)),
                    ),
            )
            .child(self.voice_button(cx))
            .child(
                self.composer_button(
                    "send",
                    if self.saving { "…" } else { "↑" },
                    enabled,
                    cx,
                    |s, window, cx| {
                        s.send(None, cx);
                        s.composer.read(cx).focus.focus(window);
                    },
                )
                // Round send target, as in the desktop composer. White reads on the
                // accent in every appearance; the glass background token is transparent.
                .w(px(26.))
                .px(px(0.))
                .rounded_full()
                .justify_center()
                .text_size(px(14.))
                .font_weight(gpui::FontWeight::MEDIUM)
                .bg(theme().accent)
                .text_color(gpui::white()),
            );
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .justify_end()
            .gap(px(6.))
            .min_h(px(36.))
            .pt(px(4.))
            .px(px(8.))
            .pb(px(8.))
            .child(leading)
            .child(self.context_meter(window, cx))
            .child(trailing)
            .into_any_element()
    }

    /// GPT Live for this chat (ManagedLiveButton), beside the dictation mic
    /// as in the desktop footer: a waveform that turns accent while voice
    /// connects or is live. The shell owns the session; Caps Lock toggles it.
    fn voice_button(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let active = self.voice != super::VoiceState::Off;
        let tip = if active {
            "Live with your OpenAI key · voice usage is billed to your key. Caps Lock stops voice."
        } else {
            "GPT Live for this chat · Caps Lock starts or stops voice."
        };
        self.composer_button("composer-voice", "", true, cx, |_, window, cx| {
            window.dispatch_action(Box::new(super::ToggleVoice), cx);
        })
        .w(px(26.))
        .px(px(0.))
        .justify_center()
        .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(tip.into())).into())
        .child(crate::icon::stroke(
            WAVEFORM,
            if active {
                theme().accent
            } else {
                theme().text_muted
            },
            17.,
            1.7,
        ))
    }
    pub(super) fn composer_routing(&self, cx: &App) -> Option<Value> {
        let mut routing = self.routing.clone()?;
        for (key, value) in self.composer.read(cx).controls.overrides.as_object()? {
            routing[key] = value.clone();
        }
        Some(routing)
    }
    pub(super) fn composer_button(
        &self,
        id: &str,
        label: &str,
        enabled: bool,
        cx: &mut Context<Self>,
        action: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) -> Stateful<Div> {
        let focus = self.composer.update(cx, |i, cx| {
            i.controls
                .focus
                .entry(id.into())
                .or_insert_with(|| cx.focus_handle())
                .clone()
        });
        let mouse_focus = focus.clone();
        let action = Rc::new(action);
        let keyboard = action.clone();
        let selector = if id == "send-mode" {
            format!("send-mode-{}", label.to_lowercase())
        } else {
            id.to_owned()
        };
        div()
            .id(SharedString::from(id.to_owned()))
            .debug_selector(move || selector.clone())
            .track_focus(&focus)
            .tab_stop(enabled)
            .h(px(26.))
            .px(px(6.))
            .rounded(px(7.))
            .flex()
            .items_center()
            .flex_shrink_0()
            .text_size(px(11.))
            .text_color(theme().text_secondary)
            .opacity(if enabled { 1. } else { 0.4 })
            .focus(|s| s.bg(theme().selection))
            .when(enabled, |d| {
                d.cursor_pointer().hover(|s| s.bg(theme().hover))
            })
            .child(label.to_owned())
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(move |_, _, window, _| {
                    if enabled {
                        mouse_focus.focus(window);
                    }
                }),
            )
            .on_click(cx.listener(move |s, _, window, cx| {
                if enabled {
                    action(s, window, cx);
                }
            }))
            .on_key_down(cx.listener(move |s, event: &KeyDownEvent, window, cx| {
                if enabled && matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    keyboard(s, window, cx);
                    cx.stop_propagation();
                }
            }))
    }
    fn close_composer_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.update(cx, |i, cx| {
            i.controls.open = None;
            i.controls.model = None;
            i.focus.focus(window);
            cx.notify();
        });
        cx.notify();
    }
    fn dismiss_composer_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let trigger = self
            .composer
            .read(cx)
            .controls
            .open
            .map(|open| format!("composer-{open}"));
        self.close_composer_picker(window, cx);
        if let Some(focus) =
            trigger.and_then(|id| self.composer.read(cx).controls.focus.get(&id).cloned())
        {
            focus.focus(window);
        }
    }
    fn open_composer_picker(
        &mut self,
        picker: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.composer.read(cx).controls.busy {
            return;
        }
        let model = self.composer_routing(cx).unwrap_or(Value::Null)["model"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        self.composer.update(cx, |i, cx| {
            // A second press on the same chip closes its menu, as on the desktop.
            if i.controls.open == Some(picker) {
                i.controls.open = None;
                i.controls.model = None;
                cx.notify();
                return;
            }
            i.controls.open = Some(picker);
            i.controls.error.clear();
            if picker == "model" {
                i.controls.model = Some(cx.new(|cx| {
                    let mut input = Composer::new(cx);
                    input.set_text(&model, cx);
                    input.focus.focus(window);
                    input
                }));
            }
            cx.notify();
        });
        cx.notify();
    }
    pub(super) fn composer_choice(
        &mut self,
        field: &'static str,
        value: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.saving || !self.queue_ready || self.composer.read(cx).controls.busy {
            return;
        }
        if matches!(field, "pickedMode" | "permissionMode") {
            self.composer.update(cx, |i, _| {
                i.controls.overrides[field] = json!(value);
                if field == "pickedMode" {
                    i.controls.overrides["mode"] =
                        json!(if value == "solo" { "single" } else { "fleet" });
                }
            });
            self.close_composer_picker(window, cx);
            return;
        }
        let editor = self.composer.clone();
        let client = self.client.clone();
        let value = value.to_owned();
        let setting = if field == "model" {
            "orchestratorModel"
        } else {
            "thinkingEffort"
        };
        editor.update(cx, |i, cx| {
            i.controls.busy = true;
            i.controls.error.clear();
            cx.notify();
        });
        let requested = value.clone();
        let task = cx.background_executor().spawn(async move {
            let url = client.url("/api/panel/operator-defaults").unwrap();
            let mutation = client
                .request("POST", &url)
                .send_json(json!({setting: requested}));
            // A response can be lost after persistence. Read effective values and
            // precedence before exposing the new route to Send.
            let confirmed: Value =
                client.get("/api/panel/operator-defaults", &[("include", "values")])?;
            if confirmed["values"][setting] == requested {
                Ok(())
            } else if mutation.is_err() {
                Err("Settings update failed. Previous selection retained.".into())
            } else {
                Err("The effective setting differs. Previous selection retained.".into())
            }
        });
        cx.spawn_in(window, async move |this, cx| {
            let result: Result<(), String> = task.await;
            let _ = this.update_in(cx, |this, window, cx| {
                let owns_focus = editor
                    .read(cx)
                    .controls
                    .focus
                    .values()
                    .any(|focus| focus.is_focused(window))
                    || editor
                        .read(cx)
                        .controls
                        .model
                        .as_ref()
                        .is_some_and(|model| model.read(cx).focus.is_focused(window));
                editor.update(cx, |i, cx| {
                    i.controls.busy = false;
                    match result {
                        Ok(()) => {
                            i.controls.overrides[field] = json!(value);
                            i.controls.open = None;
                            i.controls.model = None;
                        }
                        Err(error) => i.controls.error = error,
                    }
                    cx.notify();
                });
                cx.notify();
                // Restore focus only when this is still the originating draft.
                if this.composer == editor && owns_focus {
                    editor.read(cx).focus.focus(window);
                }
            });
        })
        .detach();
    }
    fn attach_composer_image(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Attach images or files".into()),
        });
        let editor = self.composer.clone();
        cx.spawn(async move |_, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let _ = editor.update(cx, |i, cx| i.attach_paths(paths, cx));
        })
        .detach();
    }
    pub(super) fn composer_card(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let routing = self.composer_routing(cx).unwrap_or(Value::Null);
        let mode = mode_label(routing["pickedMode"].as_str().unwrap_or("solo"));
        self.sync_context_meter(&routing, cx);
        let (open, busy, error, model) = self.composer.update(cx, |i, cx| {
            i.controls.attachment_target = true;
            i.controls.images_enabled = self.queue_ready
                && matches!(
                    routing["backend"].as_str(),
                    Some("codex" | "claude" | "fable" | "collide")
                );
            let placeholder = format!("Message {mode}…");
            if i.placeholder != placeholder || i.framed {
                i.placeholder = placeholder;
                i.framed = false;
                cx.notify();
            }
            (
                i.controls.open,
                i.controls.busy,
                i.controls.error.clone(),
                i.controls.model.clone(),
            )
        });
        let footer = self.regions.measured_view(
            "footer",
            composer_regions::footer_style(),
            Self::composer_footer,
            window.viewport_size().width,
            cx,
        );
        let mut card = div()
            .id("composer-card")
            .debug_selector(|| "composer-card".into())
            .relative()
            .border_1()
            .border_color(theme().border)
            .rounded(px(crate::theme::GEOMETRY.composer_radius))
            .bg(theme().surface_raised)
            .capture_key_down(cx.listener(|s, event: &KeyDownEvent, window, cx| {
                match event.keystroke.key.as_str() {
                    "tab" => {
                        if s.composer.read(cx).focus.is_focused(window)
                            && !event.keystroke.modifiers.shift
                        {
                            let input = s.composer.read(cx);
                            if let Some(focus) = input
                                .controls
                                .focus
                                .get("composer-image-remove-0")
                                .filter(|_| !input.controls.images.is_empty())
                                .or_else(|| {
                                    input
                                        .controls
                                        .focus
                                        .get("composer-file-remove-0")
                                        .filter(|_| !input.controls.files.is_empty())
                                })
                            {
                                focus.focus(window);
                            } else {
                                s.focus.focus(window);
                            }
                        } else if event.keystroke.modifiers.shift {
                            window.focus_prev();
                        } else {
                            window.focus_next();
                        }
                        cx.stop_propagation();
                    }
                    "escape" if s.composer.read(cx).controls.open.is_some() => {
                        s.dismiss_composer_picker(window, cx);
                        cx.stop_propagation();
                    }
                    _ => {}
                }
            }))
            .on_drop(cx.listener(|s, paths: &gpui::ExternalPaths, _, cx| {
                s.composer
                    .update(cx, |i, cx| i.attach_paths(paths.paths().to_vec(), cx));
            }))
            .child(self.composer.clone())
            .child(self.composer.update(cx, |i, cx| i.image_chips(cx)))
            .child(footer);
        let owner = cx.entity().downgrade();
        card = card.child(
            canvas(
                |_, _, _| (),
                move |bounds, _, _, cx| {
                    let _ = owner.update(cx, |s, cx| {
                        s.composer
                            .update(cx, |i, _| i.controls.context.card_bounds = Some(bounds));
                    });
                },
            )
            .absolute()
            .inset_0(),
        );
        if let Some(open) = open {
            card = card
                .relative()
                .child(self.composer_popover(open, busy, model, &routing, cx));
        } else if let Some(help) = self.context_focus_help(window, cx) {
            card = card.relative().child(help);
        }
        card.when(!error.is_empty(), |d| {
            d.child(
                div()
                    .text_size(px(11.))
                    .text_color(theme().text_secondary)
                    .child(error),
            )
        })
        .into_any_element()
    }
}

/// Lucide audio-lines, as the desktop Live button draws it.
const WAVEFORM: &str = "M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4";
