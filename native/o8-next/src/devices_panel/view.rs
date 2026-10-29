use super::*;
use crate::theme::current as theme;
use gpui::{prelude::*, *};
const DEVICE: &str =
    "M9 2h6a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3Z M10 5h4 M11 19h2";
const INSTRUCTIONS: &str = "Use the o8_device agent tool to test an iOS simulator already open in Devices.\n\nCall status, then acquire with the chosen deviceId. Your controller session is assigned automatically to this conversation and worker.\n\nUse press, swipe, scroll, type and snapshot with that deviceId. If occupied, ask its controller for an explicit handoff to your waiting session. Never reuse another worker’s session or bypass the device authority with a raw helper.\n\nCall release when finished or cancelled. The Devices panel shows the controller and waiting workers. Manual viewer input requires the operator to take control; request a handoff to resume agent input.";
fn prose(value: impl Into<SharedString>) -> Div {
    div()
        .text_size(px(11.5))
        .line_height(px(18.4))
        .text_color(theme().text_muted)
        .child(value.into())
}
fn button(
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    disabled: bool,
    cx: &mut Context<DevicesPanel>,
    action: impl Fn(&mut DevicesPanel, &mut Window, &mut Context<DevicesPanel>) + 'static,
) -> Stateful<Div> {
    let id = id.into();
    let action = std::rc::Rc::new(action);
    let key_action = action.clone();
    div()
        .id(id.clone())
        .debug_selector(move || id.to_string())
        .focusable()
        .tab_stop(!disabled)
        .when(!disabled, |b| b.cursor_pointer())
        .px(px(12.))
        .py(px(8.))
        .rounded(px(8.))
        .border_1()
        .border_color(theme().border)
        .bg(theme().hover)
        .text_size(px(11.5))
        .font_weight(FontWeight::LIGHT)
        .text_color(theme().text)
        .opacity(if disabled { 0.6 } else { 1. })
        .when(!disabled, |b| {
            b.hover(|s| s.bg(theme().selection))
                .active(|s| s.bg(theme().selection))
        })
        .focus(|s| s.border_color(theme().accent))
        .on_click(cx.listener(move |this, _, window, cx| {
            if !disabled {
                action(this, window, cx);
            }
        }))
        .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
            if !disabled && matches!(event.keystroke.key.as_str(), "enter" | "space") {
                key_action(this, window, cx);
                cx.stop_propagation();
            }
        }))
        .child(label.into())
}
fn small_button(
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    disabled: bool,
    cx: &mut Context<DevicesPanel>,
    action: impl Fn(&mut DevicesPanel, &mut Window, &mut Context<DevicesPanel>) + 'static,
) -> Stateful<Div> {
    button(id, label, disabled, cx, action)
        .px(px(10.))
        .py(px(6.))
}
impl DevicesPanel {
    fn agent_controls(&self, compact: bool, height: f32, cx: &mut Context<Self>) -> AnyElement {
        let state = self.state.as_ref().unwrap();
        let status = self
            .error
            .clone()
            .or_else(|| state["error"].as_str().map(str::to_owned));
        let delayed = status.as_ref().is_some_and(|s| !s.is_empty());
        let mut section = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .flex_shrink_0()
            .border_color(theme().border);
        if compact {
            section = section.border_b_1().px(px(16.)).py(px(7.)).child(
                small_button(
                    "devices-agent-disclosure",
                    format!(
                        "{} {} · Agent controls",
                        if self.expanded { "▾" } else { "▸" },
                        if delayed {
                            "Connection delayed"
                        } else {
                            "Shared device"
                        }
                    ),
                    false,
                    cx,
                    |this, _, cx| {
                        this.expanded = !this.expanded;
                        cx.notify();
                    },
                )
                .px(px(0.))
                .py(px(0.))
                .border_0()
                .bg(gpui::transparent_black())
                .rounded(px(0.))
                .tooltip(move |_, cx| {
                    cx.new(|_| {
                        crate::icon::Tip(
                            status
                                .clone()
                                .unwrap_or_else(|| "Agent controls".into())
                                .into(),
                        )
                    })
                    .into()
                }),
            );
            if !self.expanded {
                return section.into_any_element();
            }
        } else {
            section = section
                .border_t_1()
                .pt(px(16.))
                .child(div().text_size(px(12.)).child("Agent controls"));
        }
        let mut content = div().id("devices-agent-content").flex().flex_col().items_start().gap(px(8.)).pt(px(8.)).overflow_y_scroll()
            .child(prose("This is a shared phone. Each connected agent receives its own controller session automatically. Occupied devices require an explicit handoff."))
            .child(prose("Viewing is passive. Taking operator control pauses agent input until you hand control back."));
        if compact {
            content = content.max_h(px(height * 0.3));
        }
        if state["tools"]["agent"]["installed"] == true && state["agentCommand"].is_array() {
            content = content.child(small_button(
                "devices-copy",
                if self.copied {
                    "Instructions copied"
                } else {
                    "Copy agent instructions"
                },
                false,
                cx,
                |this, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(INSTRUCTIONS.into()));
                    this.copied = cx
                        .read_from_clipboard()
                        .and_then(|item| item.text())
                        .is_some_and(|value| value == INSTRUCTIONS);
                    this.copy_error = !this.copied;
                    cx.notify();
                },
            ));
        } else if compact {
            content = content.child(prose(
                "Stop the viewer to set up agent controls. The simulator will stay open.",
            ));
        } else {
            content = content.child(small_button(
                "devices-agent-install",
                "Set up agent controls",
                self.busy(),
                cx,
                |this, _, cx| this.read(Some(json!({"action":"install","tool":"agent"})), cx),
            ));
        }
        if self.copy_error {
            content = content.child(prose(
                "Could not copy. Check clipboard access and try again.",
            ));
        }
        section.child(content).into_any_element()
    }
    fn roster(&self, height: f32, cx: &mut Context<Self>) -> AnyElement {
        let state = self.state.as_ref().unwrap();
        let mut roster = div().id("devices-roster").max_h(px(height * 0.3)).overflow_y_scroll().flex_shrink_0().px(px(16.)).py(px(8.))
            .border_b_1().border_color(theme().border).text_size(px(11.5))
            .child(prose("Viewing is passive. Take operator control of each open simulator before using the viewer."));
        let devices: Vec<_> = rows(state, "devices")
            .filter(|d| d["platform"] == "ios" && d["state"] == "running")
            .collect();
        if devices.is_empty() {
            roster = roster.child(prose(
                "No running iOS simulators. Android control remains unavailable here.",
            ));
        }
        for device in devices {
            let row = rows(state, "controllers")
                .find(|r| r["deviceId"] == device["id"])
                .cloned()
                .unwrap_or(Value::Null);
            let device_id = text(&device["id"]);
            let expected = row["active"]["session"].clone();
            let operator = row["active"]["kind"] == "operator";
            let busy = self.busy() || row["busy"] == true;
            let action = json!({"action": if operator {"release-control"} else {"take-control"}, "deviceId":device_id, "expectedSession":expected});
            let label = row["active"]["label"].as_str().unwrap_or("No controller");
            let mut item = div().flex().flex_col().gap(px(8.)).py(px(8.)).child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(format!("{} · {label}", text(&device["name"]))),
                    )
                    .child(small_button(
                        format!("devices-control-{device_id}"),
                        if operator {
                            "Release operator control"
                        } else {
                            "Take operator control"
                        },
                        busy,
                        cx,
                        move |this, _, cx| this.read(Some(action.clone()), cx),
                    )),
            );
            for waiter in rows(&row, "waiting") {
                let action = json!({"action":"handoff","deviceId":device_id,"expectedSession":expected,"targetSession":waiter["session"]});
                item = item.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(8.))
                        .child(prose(format!("Waiting · {}", text(&waiter["label"]))).flex_1())
                        .child(small_button(
                            format!("devices-handoff-{}", text(&waiter["session"])),
                            "Hand off control",
                            busy,
                            cx,
                            move |this, window, cx| {
                                this.focus.focus(window);
                                this.read(Some(action.clone()), cx);
                            },
                        )),
                );
            }
            if row["lastInput"].is_object() {
                let last = &row["lastInput"];
                let at = if last["x"].is_number() {
                    format!(" at {}, {}", last["x"], last["y"])
                } else {
                    String::new()
                };
                item = item.child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(crate::icon::stroke(
                            "M19.5 12a7.5 7.5 0 1 0-15 0 7.5 7.5 0 0 0 15 0 M12.75 12a.75 .75 0 1 0-1.5 0 .75 .75 0 0 0 1.5 0",
                            theme().text_muted,
                            16.,
                            1.,
                        ))
                        .child(prose(format!(
                            "{} · {}{at}",
                            text(&last["label"]),
                            text(&last["action"])
                        ))),
                );
            }
            if let Some(error) = row["error"].as_str() {
                item = item.child(prose(error.to_owned()));
            }
            roster = roster.child(item);
        }
        roster.into_any_element()
    }
}
impl Render for DevicesPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let busy = self.busy();
        let running = self.running();
        let mut header = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(16.))
            .py(px(12.))
            .flex_shrink_0()
            .border_b_1()
            .border_color(theme().border)
            .child(crate::icon::stroke(DEVICE, theme().text, 16., 1.5))
            .child(div().flex_1().text_size(px(12.)).child("Devices"))
            .child(button(
                "devices-refresh",
                "Refresh",
                busy,
                cx,
                |this, _, cx| this.action("refresh", cx),
            ));
        if running {
            header = header.child(
                button(
                    "devices-stop",
                    "Stop viewer",
                    busy,
                    cx,
                    |this, window, cx| {
                        this.focus.focus(window);
                        this.action("stop", cx);
                    },
                )
                .tooltip(|_, cx| {
                    cx.new(|_| {
                        crate::icon::Tip(
                            "Stop the viewer helper. Your simulators stay open.".into(),
                        )
                    })
                    .into()
                }),
            );
        }
        let mut body = div()
            .id("devices-panel")
            .debug_selector(|| "devices-panel".into())
            .track_focus(&self.focus)
            .size_full()
            .min_w_0()
            .min_h_0()
            .flex()
            .flex_col()
            .font_family(theme().font_ui)
            .font_weight(FontWeight::LIGHT)
            .text_color(theme().text)
            .child(header);
        if running {
            body = body
                .child(self.agent_controls(true, f32::from(window.viewport_size().height), cx))
                .child(self.roster(f32::from(window.viewport_size().height), cx));
            let manual = self.manual();
            let revision = self.state.as_ref().map(super::revision).unwrap_or(0);
            let mut viewer = div()
                .id("devices-live-viewer")
                .debug_selector(move || {
                    format!(
                        "devices-viewer-{}-{revision}",
                        if manual { "operator" } else { "passive" }
                    )
                })
                .flex_1()
                .min_h_0()
                .relative();
            #[cfg(target_os = "macos")]
            {
                let web = self.web.clone();
                let url = text(&self.state.as_ref().unwrap()["embedUrl"]);
                let origin = self.client.url("/").unwrap().to_string();
                let active = self.active;
                viewer = viewer.child(
                    canvas(
                        |b, _, _| b,
                        move |bounds, _, window, _| {
                            let mut slot = web.borrow_mut();
                            if slot.is_none() && active && !cfg!(test) {
                                *slot = web::Viewer::new(window);
                            }
                            if let Some(viewer) = slot.as_mut() {
                                viewer.show(&url, &origin, bounds, window, active, manual);
                            }
                        },
                    )
                    .size_full(),
                );
            }
            #[cfg(not(target_os = "macos"))]
            {
                viewer = viewer.child(prose("The live device viewer needs macOS for now."));
            }
            body = body.child(viewer);
        } else {
            #[cfg(target_os = "macos")]
            if let Some(web) = self.web.borrow().as_ref() {
                web.hide();
            }
            let phase = self.phase().to_owned();
            let mut intro = div().id("devices-introduction").debug_selector(move || format!("devices-introduction-{phase}")).overflow_y_scroll().p(px(20.)).flex().flex_col().gap(px(20.))
                .child(div().pt(px(12.)).child(div().size(px(48.)).mb(px(18.)).rounded(px(14.)).bg(theme().hover).flex().items_center().justify_center().child(crate::icon::stroke(DEVICE,theme().accent,25.,1.5)))
                    .child(div().text_size(px(20.)).mb(px(8.)).child("Build for the screen in your hand."))
                    .child(prose("Run your installed iOS simulators and Android emulators here. See the app, interact with it, and capture what needs work.")));
            if let Some(error) = self
                .error
                .as_deref()
                .or_else(|| self.state.as_ref().and_then(|s| s["error"].as_str()))
            {
                intro = intro.child(
                    prose(error.to_owned())
                        .id("devices-error")
                        .debug_selector(|| "devices-error".into()),
                );
            }
            if let Some(state) = &self.state {
                let mut platforms = div()
                    .rounded(px(12.))
                    .border_1()
                    .border_color(theme().border);
                for (key, label, guide) in [
                    ("ios", "iOS Simulator", "https://developer.apple.com/xcode/"),
                    (
                        "android",
                        "Android Emulator",
                        "https://developer.android.com/studio/run/emulator",
                    ),
                ] {
                    let available = state["platforms"][key]["available"] == true;
                    platforms = platforms.child(
                        div()
                            .id(SharedString::from(format!("devices-{key}")))
                            .debug_selector(move || format!("devices-{key}"))
                            .flex()
                            .items_start()
                            .gap(px(12.))
                            .p(px(14.))
                            .when(key == "android", |d| {
                                d.border_t_1().border_color(theme().border)
                            })
                            .child(
                                div()
                                    .size(px(6.))
                                    .mt(px(6.))
                                    .rounded_full()
                                    .flex_shrink_0()
                                    .bg(if available {
                                        theme().accent
                                    } else {
                                        theme().text_faint
                                    }),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .child(div().text_size(px(13.5)).mb(px(3.)).child(label))
                                    .child(prose(text(&state["platforms"][key]["detail"]))),
                            )
                            .when(!available, |d| {
                                d.child(
                                    button(
                                        format!("devices-guide-{key}"),
                                        "Setup guide",
                                        false,
                                        cx,
                                        move |_, _, cx| cx.open_url(guide),
                                    )
                                    .px(px(8.))
                                    .py(px(6.)),
                                )
                            }),
                    );
                }
                let installed = state["tools"]["hub"]["installed"] == true;
                let label = match self.phase() {
                    "installing" => "Setting up…",
                    "starting" => "Opening devices…",
                    _ if installed => "Open device workspace",
                    _ => "Set up device viewer",
                };
                let phase = self.phase().to_owned();
                let stage = state["stage"].as_str().unwrap_or(if installed { "Use the panel maximize button for more room." } else { "Downloads the device viewer helper only. SDKs and simulator images are installed separately." });
                intro = intro
                    .child(platforms)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .items_start()
                            .gap(px(10.))
                            .child(
                                button("devices-open", label, busy, cx, move |this, window, cx| {
                                    if installed {
                                        this.focus.focus(window);
                                    }
                                    this.read(
                                        Some(if installed {
                                            json!({"action":"start"})
                                        } else {
                                            json!({"action":"install","tool":"hub"})
                                        }),
                                        cx,
                                    )
                                })
                                .bg(theme().accent)
                                .hover(|s| s.bg(theme().accent).opacity(0.9))
                                .active(|s| s.bg(theme().accent).opacity(0.75))
                                .text_color(theme().background),
                            )
                            .child(
                                prose(stage.to_owned())
                                    .id("devices-stage")
                                    .debug_selector(move || format!("devices-stage-{phase}")),
                            ),
                    )
                    .child(self.agent_controls(
                        false,
                        f32::from(window.viewport_size().height),
                        cx,
                    ));
            } else {
                intro = intro.child(
                    prose(if self.pending {
                        "Checking device tools…"
                    } else {
                        "Refresh to check your device tools."
                    })
                    .id("devices-checking")
                    .debug_selector(|| "devices-checking".into()),
                );
            }
            body = body.child(intro);
        }
        body
    }
}
