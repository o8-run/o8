use super::*;
use crate::composer::controls::mode_label;
use gpui::{AnyElement, Div, KeyDownEvent, SharedString, Stateful};

impl Surface {
    pub(crate) fn composer_footer(&mut self, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let routing = self.composer_routing(cx).unwrap_or(Value::Null);
        let mode = mode_label(routing["pickedMode"].as_str().unwrap_or("solo"));
        let access = if routing["permissionMode"] == "plan" {
            "Plan only"
        } else {
            "Full access"
        };
        let enabled = self.queue_ready && !self.saving && !self.composer.read(cx).controls.busy;
        let leading = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(6.))
            .child(
                self.composer_button("composer-mode", mode, enabled, cx, |s, w, cx| {
                    s.open_composer_picker("mode", w, cx)
                }),
            )
            .child(
                self.composer_button("composer-access", access, enabled, cx, |s, w, cx| {
                    s.open_composer_picker("access", w, cx)
                }),
            )
            .child(self.composer_button(
                "composer-attach",
                "+",
                enabled
                    && matches!(
                        routing["backend"].as_str(),
                        Some("codex" | "claude" | "fable" | "collide")
                    ),
                cx,
                |s, _, cx| s.attach_composer_image(cx),
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
                    routing["model"].as_str().unwrap_or("Model"),
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
            .child(div().flex_1().min_w(px(0.)))
            .child(trailing)
            .into_any_element()
    }

    pub(super) fn composer_routing(&self, cx: &App) -> Option<Value> {
        let mut routing = self.routing.clone()?;
        for (key, value) in self.composer.read(cx).controls.overrides.as_object()? {
            routing[key] = value.clone();
        }
        Some(routing)
    }
    fn composer_button(
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
    fn composer_choice(
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
            prompt: Some("Attach images".into()),
        });
        let editor = self.composer.clone();
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else { return; };
            let task = cx.background_executor().spawn(async move {
                use base64::Engine;
                paths.into_iter().map(|path| {
                    let mime = match path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
                        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp", "gif" => "image/gif",
                        _ => return Err("Choose a PNG, JPEG, WebP or GIF image."),
                    };
                    if fs::metadata(&path).map_err(|_| "Could not read image.")?.len() > 512 * 1024 { return Err("Image exceeds 512 KiB."); }
                    let bytes = fs::read(&path).map_err(|_| "Could not read image.")?;
                    Ok(json!({"name":path.file_name().and_then(|s| s.to_str()).unwrap_or("image"), "dataUri":format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))}))
                }).collect::<Result<Vec<_>, _>>()
            });
            let result = task.await;
            let _ = this.update(cx, |_, cx| {
                editor.update(cx, |i, cx| {
                    match result {
                        Ok(images) if i.controls.images.len() + images.len() <= 8 => i.controls.images.extend(images),
                        Ok(_) => i.controls.error = "Attach at most 8 images.".into(),
                        Err(error) => i.controls.error = error.into(),
                    }
                    cx.notify();
                });
                cx.notify();
            });
        }).detach();
    }
    pub(super) fn composer_card(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let routing = self.composer_routing(cx).unwrap_or(Value::Null);
        let mode = mode_label(routing["pickedMode"].as_str().unwrap_or("solo"));
        let (open, busy, error, model, images) = self.composer.update(cx, |i, cx| {
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
                i.controls.images.clone(),
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
                            s.focus.focus(window);
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
            .child(self.composer.clone())
            .children(images.iter().map(|image| {
                div()
                    .text_size(px(11.))
                    .px(px(14.))
                    .child(image["name"].as_str().unwrap_or("image").to_owned())
            }))
            .child(footer);
        if let Some(open) = open {
            let mut picker = div()
                .id("composer-picker")
                .p(px(8.))
                .flex()
                .flex_wrap()
                .gap(px(6.));
            let choices: &[(&str, &str)] = match open {
                "mode" => &[
                    ("solo", "Solo"),
                    ("fast", "Shared"),
                    ("multitask", "Worktrees"),
                ],
                "access" => &[("plan", "Plan only"), ("full", "Full access")],
                "effort" => &[
                    ("low", "Low"),
                    ("medium", "Medium"),
                    ("high", "High"),
                    ("xhigh", "Extra high"),
                    ("max", "Max"),
                ],
                _ => &[],
            };
            for &(value, label) in choices {
                let field = match open {
                    "mode" => "pickedMode",
                    "access" => "permissionMode",
                    _ => "effort",
                };
                picker = picker.child(self.composer_button(
                    &format!("{open}-{value}"),
                    label,
                    !busy,
                    cx,
                    move |s, w, cx| s.composer_choice(field, value, w, cx),
                ));
            }
            if let Some(model) = model {
                let input = model.clone();
                picker = picker
                    .child(
                        div()
                            .id("composer-model-input")
                            .debug_selector(|| "composer-model-input".into())
                            .w_full()
                            .child(model),
                    )
                    .child(self.composer_button(
                        "composer-model-save",
                        if busy { "Saving…" } else { "Save" },
                        !busy,
                        cx,
                        move |s, w, cx| {
                            let model = input.read(cx).text.trim().to_owned();
                            s.composer_choice("model", &model, w, cx);
                        },
                    ));
            }
            picker = picker.child(self.composer_button(
                "composer-picker-close",
                "Close",
                !busy,
                cx,
                |s, w, cx| s.dismiss_composer_picker(w, cx),
            ));
            card = card.child(picker);
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
