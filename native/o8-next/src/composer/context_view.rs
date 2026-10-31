//! Composer-only wiring and presentation of the classic context/cache readout.
use super::*;
use crate::composer::controls::context::{self, Estimate, Projection, Reuse};
use gpui::FontWeight;

fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}

impl Surface {
    pub(crate) fn sync_context_meter(&mut self, routing: &Value, cx: &mut Context<Self>) {
        let Some(thread) = self
            .selected
            .clone()
            .filter(|id| id.starts_with("thoughts-"))
        else {
            return;
        };
        let backend = routing["backend"].as_str().unwrap_or("").to_owned();
        if backend.is_empty() {
            // Selection clears routing while history loads. Do not retain a
            // previous report or a canceled request when returning to a draft.
            self.composer.update(cx, |i, _| {
                if i.controls.context.binding.is_some() {
                    i.controls.context = Default::default();
                }
            });
            return;
        }
        let binding = (
            thread.clone(),
            format!("{}\0{}", backend, routing["model"].as_str().unwrap_or("")),
            self.transcript.as_ref().map_or(0, |t| t.context_epoch()),
        );
        let running = self
            .transcript
            .as_ref()
            .is_some_and(|t| t.context_snapshot().1);
        let (needs_poll, needs_clock) = self.composer.update(cx, |i, _| {
            if i.controls.context.binding.as_ref() != Some(&binding) {
                i.controls.context = context::MeterState {
                    binding: Some(binding.clone()),
                    ..Default::default()
                };
            }
            let meter = &mut i.controls.context;
            let refresh = !meter.requested || (meter.was_running && !running);
            meter.requested = true;
            (refresh, meter.clock.is_none())
        });
        // Record only completed transcript groups. No request is sent to keep a cache warm.
        self.context_values(cx);
        if needs_clock {
            self.start_context_clock(cx);
        }
        if !needs_poll {
            return;
        }
        let client = self.client.clone();
        let editor = self.composer.downgrade();
        let task = cx.spawn(async move |this, cx| {
            // Classic refreshes on binding/turn completion after a 900 ms settle.
            cx.background_executor()
                .timer(std::time::Duration::from_millis(900))
                .await;
            if !this
                .read_with(cx, |s, cx| {
                    editor.upgrade().is_some_and(|e| {
                        e == s.composer
                            && e.read(cx).controls.context.binding.as_ref() == Some(&binding)
                    })
                })
                .unwrap_or(false)
            {
                return;
            }
            let result = cx
                .background_executor()
                .spawn(async move { context::fetch(&client, &thread, &backend).unwrap_or(0.) })
                .await;
            let _ = this.update(cx, |s, cx| {
                let Some(editor) = editor.upgrade().filter(|e| *e == s.composer) else {
                    return;
                };
                if editor.read(cx).controls.context.binding.as_ref() != Some(&binding) {
                    return;
                }
                editor.update(cx, |i, _| {
                    let m = &mut i.controls.context;
                    m.growth = if result > 0. {
                        m.previous.map_or(0., |p| (result - p).max(0.))
                    } else {
                        0.
                    };
                    m.previous = (result > 0.).then_some(result);
                    m.reported = result;
                });
                cx.notify();
            });
        });
        self.composer
            .update(cx, |i, _| i.controls.context.poll = Some(task));
    }

    fn start_context_clock(&mut self, cx: &mut Context<Self>) {
        let editor = self.composer.downgrade();
        let task = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(15))
                    .await;
                if !this
                    .update(cx, |s, cx| {
                        if editor.upgrade().is_none_or(|e| e != s.composer) {
                            return false;
                        }
                        cx.notify();
                        true
                    })
                    .unwrap_or(false)
                {
                    break;
                }
            }
            let _ = editor.update(cx, |i, _| i.controls.context.clock = None);
        });
        self.composer
            .update(cx, |i, _| i.controls.context.clock = Some(task));
    }

    fn context_values(
        &mut self,
        cx: &mut Context<Self>,
    ) -> (Projection, Option<Reuse>, String, Option<Estimate>) {
        let routing = self.composer_routing(cx).unwrap_or(Value::Null);
        let runtime = routing["backend"].as_str().unwrap_or("").to_owned();
        let model = routing["model"].as_str().unwrap_or("");
        let session = self.selected.as_deref().unwrap_or("");
        let (entries, running) = self
            .transcript
            .as_ref()
            .map_or((&[][..], false), |t| t.context_snapshot());
        let time = now();
        let completed = self.composer.update(cx, |i, _| {
            let previous = i.controls.context.was_running;
            i.controls.context.was_running = running;
            (previous && !running).then_some(time)
        });
        let server = self
            .client
            .url("/")
            .map_or(String::new(), |url| url.to_string());
        let rows = context::observe(
            &server, session, &runtime, entries, running, completed, time,
        );
        let estimate = context::estimate(&rows, session, &runtime, model, time);
        let projection = context::project(
            self.composer.read(cx).controls.context.reported,
            context::conversation(entries),
        );
        (
            projection,
            context::latest_reuse(entries),
            runtime,
            estimate,
        )
    }

    pub(crate) fn context_meter(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (projection, reuse, runtime, estimate) = self.context_values(cx);
        let percent = projection.percent();
        let color = if percent >= 85. {
            crate::theme::brand_orange()
        } else if percent >= 60. {
            theme().text_muted
        } else {
            theme().text_faint
        };
        let help = format!(
            "{} active context {}{} / 1M · {}%.{}{} {}",
            if projection.reported {
                "Runtime-reported"
            } else {
                "Estimated"
            },
            if projection.reported { "" } else { "~" },
            context::format_tokens(projection.active),
            percent,
            reuse.as_ref().map_or(String::new(), |r| format!(
                " Last prompt reused {}% cached input.",
                r.percent
            )),
            if self.composer.read(cx).controls.context.growth > 0. {
                format!(
                    " Context grew by {} tokens since the previous runtime report.",
                    context::format_tokens(self.composer.read(cx).controls.context.growth)
                )
            } else {
                String::new()
            },
            context::explanation(&runtime, estimate.as_ref())
        );
        let open = self.composer.read(cx).controls.open == Some("context");
        let focused = self
            .composer
            .read(cx)
            .controls
            .focus
            .get("composer-context")
            .is_some_and(|focus| focus.is_focused(window));
        let button = self
            .composer_button("composer-context", "", true, cx, |s, w, cx| {
                if s.composer.read(cx).controls.open == Some("context") {
                    s.dismiss_composer_picker(w, cx);
                } else {
                    s.composer.update(cx, |i, _| {
                        i.controls.open = Some("context");
                        i.controls.model = None;
                    });
                    cx.notify();
                }
            })
            .h(px(24.))
            .px(px(0.))
            .rounded_full()
            .gap(px(4.))
            .line_height(gpui::relative(1.25))
            .when(open, |d| d.bg(theme().hover))
            .when(!open && !focused, |d| {
                d.tooltip(move |_, cx| cx.new(|_| ContextTip(help.clone())).into())
            });
        if self
            .composer
            .read(cx)
            .controls
            .context
            .focus_events
            .is_none()
        {
            let focus = self.composer.read(cx).controls.focus["composer-context"].clone();
            let events = [
                cx.on_focus(&focus, window, |_, _, cx| cx.notify()),
                cx.on_blur(&focus, window, |_, _, cx| cx.notify()),
            ];
            self.composer
                .update(cx, |i, _| i.controls.context.focus_events = Some(events));
        }
        // Only the ring (Q 2026-10-31): the cache estimate and the breakdown
        // live in the popover it opens.
        let ring = rings(percent, reuse.as_ref().map(|r| r.percent), color, 19.);
        let button = button.w(px(24.)).justify_center().child(ring);
        let owner = cx.entity().downgrade();
        let anchor_owner = owner.clone();
        let button = button.relative().child(
            canvas(
                |_, _, _| (),
                move |bounds, _, _, cx| {
                    let _ = anchor_owner.update(cx, |s, cx| {
                        s.composer
                            .update(cx, |i, _| i.controls.context.anchor = Some(bounds));
                    });
                },
            )
            .absolute()
            .inset_0(),
        );
        div()
            .relative()
            .flex_1()
            .min_w(px(24.))
            .h(px(24.))
            .flex()
            .justify_end()
            .items_center()
            .child(button)
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, _, cx| {
                        let _ = owner.update(cx, |s, cx| {
                            let width = f32::from(bounds.size.width).max(24.);
                            if (s.composer.read(cx).controls.context.width - width).abs() > 0.5 {
                                s.composer
                                    .update(cx, |i, _| i.controls.context.width = width);
                                cx.notify();
                            }
                        });
                    },
                )
                .absolute()
                .inset_0(),
            )
            .into_any_element()
    }

    pub(crate) fn context_popover(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let (projection, reuse, runtime, estimate) = self.context_values(cx);
        let percent = projection.percent();
        let mut rows = div().border_t_1().border_color(theme().border).pb(px(6.));
        for (label, tokens, approximate) in [
            ("System prompt estimate", context::SYSTEM, true),
            ("Tools & MCP estimate", context::TOOLS, true),
            ("Visible transcript estimate", projection.conversation, true),
            ("Runtime context not classified", projection.other, false),
        ] {
            if !approximate && tokens <= 0. {
                continue;
            }
            rows = rows.child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .px(px(14.))
                    .py(px(6.))
                    .text_size(px(13.5))
                    .text_color(if tokens == 0. {
                        theme().text_faint
                    } else {
                        theme().text
                    })
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .child(
                                div()
                                    .size(px(10.))
                                    .rounded(px(3.))
                                    .opacity(if tokens == 0. { 0.5 } else { 1. })
                                    .bg(if approximate {
                                        theme().text_faint
                                    } else {
                                        crate::theme::brand_orange()
                                    }),
                            )
                            .child(label),
                    )
                    .child(
                        div()
                            .font_family(theme().font_mono)
                            .text_size(px(9.5))
                            .text_color(theme().text_faint)
                            .child(format!(
                                "{}{}",
                                if approximate { "~" } else { "" },
                                context::format_tokens(tokens)
                            )),
                    ),
            );
        }
        let cache_label = reuse.as_ref().map_or("Awaiting usage".into(), |r| {
            format!("{}% reused", r.percent)
        });
        let cache_detail = reuse.as_ref().map_or(
            "Available after a provider reports cache usage.".into(),
            |r| {
                format!(
                    "{} of {} input · last reported turn",
                    context::format_tokens(r.read).replace('k', "K"),
                    context::format_tokens(r.prompt).replace('k', "K")
                )
            },
        );
        let has_reuse = reuse.is_some();
        let right = self.context_right(cx, 340.);
        let cache = div()
            .border_t_1()
            .border_color(theme().border)
            .px(px(14.))
            .py(px(12.))
            .child(
                div()
                    .flex()
                    .justify_between()
                    .gap(px(8.))
                    .text_size(px(12.))
                    .child("Prompt cache")
                    .child(
                        div()
                            .text_color(if reuse.is_some() {
                                theme().accent
                            } else {
                                theme().text_muted
                            })
                            .child(cache_label),
                    ),
            )
            .when_some(reuse, |d, r| {
                d.child(bar(r.percent, 5., theme().accent).mt(px(9.)).mb(px(9.)))
            })
            .child(
                div()
                    .text_size(px(10.5))
                    .text_color(theme().text_muted)
                    .mt(px(if has_reuse { 0. } else { 7. }))
                    .child(cache_detail),
            )
            .child(
                div()
                    .flex()
                    .justify_between()
                    .gap(px(8.))
                    .mt(px(9.))
                    .text_size(px(12.))
                    .debug_selector(|| "context-cache-estimate".into())
                    .child("Next prompt")
                    .child(div().text_color(theme().text_muted).child(context::label(
                        &runtime,
                        estimate.as_ref(),
                        false,
                    ))),
            )
            .child(
                div()
                    .text_size(px(10.5))
                    .line_height(gpui::relative(1.4))
                    .text_color(theme().text_faint)
                    .mt(px(6.))
                    .child(context::explanation(&runtime, estimate.as_ref())),
            );
        div().id("context-breakdown").debug_selector(|| "context-breakdown".into())
            .absolute().bottom_full().right(px(right)).mb(px(8.)).w(px(340.)).max_w(gpui::relative(1.))
            .rounded(px(18.)).border_1().border_color(theme().border).bg(crate::theme::menu_fill()).shadow_lg()
            .overflow_hidden()
            .text_color(theme().text).font_family(theme().font_ui).font_weight(FontWeight::LIGHT)
            .on_mouse_down_out(cx.listener(|s, event: &gpui::MouseDownEvent, w, cx| {
                // Let the trigger's click toggle itself; all other outside presses dismiss.
                if !s.composer.read(cx).controls.context.anchor.is_some_and(|bounds| bounds.contains(&event.position)) { s.dismiss_composer_picker(w, cx); }
            }))
            .child(div().flex().items_center().justify_between().pt(px(12.)).pr(px(12.)).pb(px(8.)).pl(px(14.)).text_size(px(13.5))
                .child("Active context")
                .child(self.composer_button("context-close", "×", true, cx, |s,w,cx| s.dismiss_composer_picker(w,cx))
                    .w(px(22.)).h(px(22.)).rounded_full().justify_center().bg(theme().hover).text_size(px(16.))))
            .child(div().flex().justify_between().px(px(14.)).pb(px(8.)).font_family(theme().font_mono).text_size(px(10.)).text_color(theme().text_faint)
                .child(if projection.reported { "Runtime reported" } else { "Estimated locally" })
                .child(format!("{}{} / 1M tokens · {}%", if projection.reported { "" } else { "~" }, context::format_tokens(projection.active), percent)))
            .child(div().px(px(14.)).pb(px(12.)).child(bar(percent, 8., crate::theme::brand_orange())))
            .child(rows)
            .child(div().border_t_1().border_color(theme().border).px(px(14.)).pt(px(8.)).pb(px(11.)).text_size(px(9.5)).line_height(gpui::relative(1.4)).text_color(theme().text_faint)
                .child(if projection.reported {
                    "The total is the runtime’s parent-session context report. Child-worker usage is excluded; category rows are estimates."
                } else {
                    "The runtime has not reported context yet. The total is estimated from the visible transcript plus the current prompt and tool baseline."
                }))
            .child(cache).into_any_element()
    }

    pub(crate) fn context_focus_help(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !self
            .composer
            .read(cx)
            .controls
            .focus
            .get("composer-context")
            .is_some_and(|f| f.is_focused(window))
        {
            return None;
        }
        let (_, _, runtime, estimate) = self.context_values(cx);
        let right = self.context_right(cx, 280.);
        Some(
            div()
                .id("context-cache-help")
                .debug_selector(|| "context-cache-help".into())
                .absolute()
                .bottom_full()
                .right(px(right))
                .mb(px(8.))
                .child(cx.new(|_| ContextTip(context::explanation(&runtime, estimate.as_ref()))))
                .into_any_element(),
        )
    }

    fn context_right(&self, cx: &App, width: f32) -> f32 {
        let meter = &self.composer.read(cx).controls.context;
        match (meter.card_bounds, meter.anchor) {
            (Some(card), Some(anchor)) => f32::from(card.right() - anchor.right())
                .max(8.)
                .min((f32::from(card.right()) - width - 16.).max(8.)),
            _ => 8.,
        }
    }
}

fn bar(percent: f64, height: f32, color: gpui::Rgba) -> Div {
    div()
        .h(px(height))
        .rounded_full()
        .bg(theme().border)
        .overflow_hidden()
        .child(
            div()
                .h_full()
                .w(gpui::relative(percent as f32 / 100.))
                .rounded_full()
                .bg(color),
        )
}

/// SVG masks use the icon atlas, avoiding a viewport-sized stroked path target.
fn rings(percent: f64, reuse: Option<f64>, color: gpui::Rgba, size: f32) -> Div {
    let circle = |radius: f64| {
        format!(
            "M12 {} A{radius} {radius} 0 1 1 12 {} A{radius} {radius} 0 1 1 12 {}",
            12. - radius,
            12. + radius,
            12. - radius
        )
    };
    let mut ring = div()
        .relative()
        .size(px(size))
        .flex_shrink_0()
        .child(
            crate::icon::stroke(&circle(28. / 3.), theme().border, size, 8. / 3.)
                .absolute()
                .inset_0(),
        )
        .child(
            crate::icon::stroke(&circle(14. / 3.), theme().border, size, 2.)
                .absolute()
                .inset_0(),
        );
    for (value, radius, weight, color) in [
        (percent, 28. / 3., 8. / 3., color),
        (reuse.unwrap_or(0.), 14. / 3., 2., theme().accent),
    ] {
        if value <= 0. {
            continue;
        }
        let radians = value / 100. * std::f64::consts::TAU - std::f64::consts::FRAC_PI_2;
        let path = if value >= 100. {
            circle(radius)
        } else {
            format!(
                "M12 {} A{radius} {radius} 0 {} 1 {} {}",
                12. - radius,
                u8::from(value > 50.),
                12. + radius * radians.cos(),
                12. + radius * radians.sin()
            )
        };
        ring = ring.child(
            crate::icon::stroke(&path, color, size, weight as f32)
                .absolute()
                .inset_0(),
        );
    }
    ring
}

struct ContextTip(String);
impl gpui::Render for ContextTip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .max_w(px(280.))
            .p(px(10.))
            .rounded(px(8.))
            .bg(crate::theme::menu_fill())
            .shadow_lg()
            .font_family(theme().font_ui)
            .text_size(px(11.))
            .font_weight(FontWeight::LIGHT)
            .line_height(gpui::relative(1.4))
            .text_color(theme().text_muted)
            .child(self.0.clone())
    }
}
