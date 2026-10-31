use super::*;
use crate::composer::controls::mode_label;
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
        let picked = routing["pickedMode"].as_str().unwrap_or("fast");
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
            .child(self.mode_chip(picked, enabled, cx))
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
                self.track_prompt_anchor(
                    self.composer_button("composer-attach", "", enabled, cx, |s, w, cx| {
                        s.open_composer_picker("attach", w, cx)
                    }),
                    "attach",
                ),
                "M12 5v14M5 12h14",
                theme().text_secondary,
                "Attach files".into(),
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
        // MicButton's colors: recording and errors red, transcribing accent.
        let color = match self.dictation {
            super::DictationState::Listening => theme().danger,
            super::DictationState::Finishing => theme().accent,
            _ => theme().text_secondary,
        };
        let trailing = div()
            .flex()
            .items_center()
            .gap(px(6.))
            .child(self.lead_chip(&routing, enabled, cx))
            .children(self.thinking_chip(&routing, enabled, cx))
            .child(
                self.mic_button(enabled, cx).child(
                    canvas(
                        |_, _, _| (),
                        move |bounds, _, window, _| {
                            // A stroked path activates viewport-sized GPU/MSAA
                            // targets. This small icon fits the existing quad pass.
                            let rect = |x, y, w, h| {
                                Bounds::new(bounds.origin + point(px(x), px(y)), size(px(w), px(h)))
                            };
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

    /// Dictation for this chat (MicButton, toggle mode): a tap starts it, the
    /// next tap stops it and sends what was said. Ctrl+Z held dictates too.
    fn mic_button(&self, enabled: bool, cx: &mut Context<Self>) -> Stateful<Div> {
        let state = self.dictation;
        let tip = match state {
            super::DictationState::Off => {
                "Click to dictate, click again to finish (Ctrl+Z hold also works)"
            }
            super::DictationState::Starting => "Waiting for the microphone… click to cancel",
            super::DictationState::Listening => "Click to finish dictation",
            super::DictationState::Finishing => "Transcribing…",
        };
        // A recording can always be stopped; transcribing finishes uninterrupted.
        let enabled = match state {
            super::DictationState::Off => enabled,
            super::DictationState::Finishing => false,
            _ => true,
        };
        self.composer_button("composer-microphone", "", enabled, cx, |_, window, cx| {
            window.dispatch_action(Box::new(super::ToggleDictation), cx);
        })
        .w(px(26.))
        .when(state == super::DictationState::Listening, |button| {
            button.bg(theme().danger_surface)
        })
        .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(tip.into())).into())
    }
    /// GPT Live for this chat (ManagedLiveButton), beside the dictation mic
    /// as in the desktop footer: a waveform that turns accent while voice
    /// connects or is live. The shell owns the session; Caps Lock toggles it.
    fn voice_button(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let active = matches!(
            self.voice,
            super::VoiceState::Connecting | super::VoiceState::Live
        );
        let tip = match self.voice {
            super::VoiceState::Off => "GPT Live for this chat · Caps Lock starts or stops voice.",
            super::VoiceState::Closing => "Closing voice…",
            _ => {
                "Live with your OpenAI key · voice usage is billed to your key. Caps Lock stops voice."
            }
        };
        // Closing admits no new start until the host confirms closure.
        let enabled = self.voice != super::VoiceState::Closing;
        self.composer_button("composer-voice", "", enabled, cx, |_, window, cx| {
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
        let picked = crate::composer::controls::visible_mode(
            routing["pickedMode"].as_str(),
            routing["backend"].as_str(),
        );
        routing["pickedMode"] = json!(picked);
        routing["mode"] = json!("fleet");
        if let Some(tier) = super::composer_selector::service_tier(
            routing["backend"].as_str().unwrap_or(""),
            routing["model"].as_str().unwrap_or(""),
            cx,
        ) {
            routing["serviceTier"] = json!(tier);
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
    pub(super) fn close_composer_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
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
    pub(super) fn open_composer_picker(
        &mut self,
        picker: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.composer.read(cx).controls.busy {
            return;
        }
        self.composer.update(cx, |i, cx| {
            // A second press on the same chip closes its menu, as on the desktop.
            if i.controls.open == Some(picker) {
                i.controls.open = None;
                i.controls.model = None;
                cx.notify();
                return;
            }
            i.controls.open = Some(picker);
            i.controls.prompt.opened = Some(cx.background_executor().now());
            i.controls.error.clear();
            if picker == "model" {
                i.controls.model = Some(cx.new(|cx| {
                    let input = Composer::new(cx);
                    input.focus.focus(window);
                    input
                }));
            }
            cx.notify();
        });
        if self.composer.read(cx).controls.open == Some(picker) {
            self.prepare_selector(picker, cx);
        }
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
            if field == "pickedMode" {
                let error = crate::composer::mode_store::save(
                    self.composer.read(cx).controls.prompt.store.as_deref(),
                    value,
                )
                .err();
                if let Some(error) = error {
                    self.composer.update(cx, |i, _| i.controls.error = error);
                }
            }
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
        // Classic saves a model choice on the thread too, so it survives a reload.
        let thread = (field == "model").then(|| self.selected.clone()).flatten();
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
                if let Some(thread) = thread {
                    let history = client.url("/api/v2/chat-history").unwrap();
                    client
                        .request("POST", &history)
                        .send_json(json!({"tabId": thread, "messages": [], "model": requested}))
                        .map_err(|_| {
                            "Model saved as the default, but not on this chat.".to_owned()
                        })?;
                }
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
    pub(super) fn attach_composer_image(&mut self, cx: &mut Context<Self>) {
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
        let mode = mode_label(routing["pickedMode"].as_str().unwrap_or("fast"));
        self.sync_context_meter(&routing, cx);
        let (open, busy, error, model) = self.composer.update(cx, |i, cx| {
            i.controls.attachment_target = true;
            i.controls.images_enabled = self.queue_ready
                && matches!(
                    routing["backend"].as_str(),
                    Some("codex" | "claude" | "fable" | "collide")
                );
            // ComposerArea: the placeholder teaches the mode, or the send
            // action while a turn runs.
            let placeholder = if self.queue["canSteer"] == true {
                if self.send_next {
                    "Queue for the next turn…"
                } else {
                    "Steer the agent…"
                }
            } else if mode == "Worktrees" {
                "Ask anything · workers use isolated worktrees"
            } else {
                "Ask anything · workers share this checkout"
            }
            .to_owned();
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
            .flex()
            .flex_col()
            .border_1()
            .border_color(theme().border)
            .rounded(px(crate::theme::GEOMETRY.composer_radius))
            .bg(theme().surface_raised)
            .capture_key_down(cx.listener(|s, event: &KeyDownEvent, window, cx| {
                if s.prompt_picker_key(event, window, cx) {
                    return;
                }
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
                                .or_else(|| {
                                    input.controls.focus.get(if input.text.trim().is_empty() {
                                        "composer-attach"
                                    } else {
                                        "composer-intent-repo"
                                    })
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
            .child(self.composer_control_view(cx))
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
                .child(self.composer_popover(open, busy, model, &routing, window, cx));
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
