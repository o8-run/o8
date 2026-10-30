//! O8SpecPane's note-color popover: hue, neutrals, Default/Custom and Reset.
use super::controls::control;
use super::*;
impl Spec {
    pub(super) fn settings_toggle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.settings = !self.settings;
        self.target.open = false;
        if !self.settings {
            self.settings_focus.focus(window);
        }
        cx.notify();
    }
    fn color(&mut self, color: Option<String>, cx: &mut Context<Self>) {
        self.preferences.color = color;
        let ink = self.preferences.ink();
        self.editor.update(cx, |e, cx| {
            e.note_color = ink;
            cx.notify();
        });
        cx.emit(PreferencesChanged(self.preferences.clone()));
        cx.notify();
    }
    fn hue(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        if self.hue_bounds.size.width <= px(0.) {
            return;
        }
        let hue = ((f32::from(at.x - self.hue_bounds.left())
            / f32::from(self.hue_bounds.size.width))
            * 360.)
            .clamp(0., 360.)
            .round();
        self.color(Some(format!("hsl({hue:.0}, 80%, 55%)")), cx);
    }
    pub(super) fn settings_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let ink = self.preferences.ink();
        let measure = cx.entity().downgrade();
        let hue = self.preferences.color.as_ref().map_or(Some(16.), |c| {
            c.strip_prefix("hsl(")
                .and_then(|s| s.split(',').next())
                .and_then(|h| h.trim().parse::<f32>().ok())
        });
        div()
            .id("spec-settings-menu")
            .debug_selector(|| "spec-settings-menu".into())
            .w(px(224.))
            .rounded(px(13.))
            .border_1()
            .border_color(theme().border)
            .bg(theme().surface_raised)
            .shadow_md()
            .occlude()
            .on_mouse_down_out(cx.listener(|this, _, window, cx| {
                this.close_menu(window, cx);
                cx.stop_propagation();
            }))
            .px(px(14.))
            .py(px(12.))
            .child(
                div()
                    .text_size(px(9.))
                    .text_color(theme().text_muted)
                    .mb(px(10.))
                    .child("NOTE COLOR"),
            )
            .child(
                div()
                    .id("spec-hue")
                    .debug_selector(|| "spec-hue".into())
                    .h(px(16.))
                    .rounded(px(8.))
                    .relative()
                    .cursor_pointer()
                    .child(
                        gpui::canvas(
                            |_, _, _| (),
                            move |bounds, _, _, cx| {
                                let _ = measure.update(cx, |this, _| this.hue_bounds = bounds);
                            },
                        )
                        .absolute()
                        .size_full(),
                    )
                    .child(
                        div()
                            .size_full()
                            .rounded(px(8.))
                            .overflow_hidden()
                            .flex()
                            .children((0..=60).map(|h| {
                                div().h_full().flex_1().bg(gpui::hsla(
                                    h as f32 / 60.,
                                    0.8,
                                    0.55,
                                    1.,
                                ))
                            })),
                    )
                    .when_some(hue, |d, h| {
                        d.child(
                            div()
                                .absolute()
                                .left(gpui::relative(h / 360.))
                                .top(px(-3.))
                                .ml(px(-6.))
                                .w(px(12.))
                                .h(px(22.))
                                .rounded(px(5.))
                                .bg(ink)
                                .border_2()
                                .border_color(gpui::white())
                                .shadow_sm(),
                        )
                    })
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, event: &MouseDownEvent, _, cx| {
                            this.hue(event.position, cx)
                        }),
                    )
                    .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| {
                        if event.pressed_button == Some(MouseButton::Left) {
                            this.hue(event.position, cx);
                        }
                    })),
            )
            .child(
                div().flex().gap(px(7.)).mt(px(10.)).children(
                    ["#000000", "#52525b", "#9ca3af", "#d1d5db", "#ffffff"]
                        .into_iter()
                        .enumerate()
                        .map(|(i, c)| {
                            let active = self.preferences.color.as_deref() == Some(c);
                            let color = preferences::Preferences {
                                color: Some(c.into()),
                                ..Default::default()
                            }
                            .ink();
                            control(format!("spec-color-{i}"), "", cx, move |this, _, cx| {
                                this.color(Some(c.into()), cx)
                            })
                            .size(px(22.))
                            .min_h(px(22.))
                            .p_0()
                            .rounded(px(6.))
                            .bg(color)
                            .border_color(if active {
                                theme().accent
                            } else {
                                theme().border
                            })
                            .when(active, |d| d.border_2())
                            .when(!active, |d| d.border_1())
                        }),
                ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .mt(px(12.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(7.))
                            .child(
                                div()
                                    .size(px(14.))
                                    .rounded(px(4.))
                                    .bg(ink)
                                    .border_1()
                                    .border_color(theme().border),
                            )
                            .child(
                                div()
                                    .debug_selector(|| "spec-color-label".into())
                                    .text_size(px(11.))
                                    .text_color(theme().text_secondary)
                                    .child(if self.preferences.color.is_some() {
                                        "Custom"
                                    } else {
                                        "Default"
                                    }),
                            ),
                    )
                    .child(
                        control("spec-color-reset", "Reset", cx, |this, _, cx| {
                            this.color(None, cx)
                        })
                        .text_color(theme().accent),
                    ),
            )
            .into_any_element()
    }
}
