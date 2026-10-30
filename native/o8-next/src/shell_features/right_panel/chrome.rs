use super::*;
#[path = "drawer.rs"]
mod drawer;
#[path = "launcher.rs"]
mod launch;
pub(super) use launch::launcher;

pub(super) fn button(
    s: &Shell,
    id: impl Into<String>,
    tip: impl Into<SharedString>,
    cx: &mut Context<Shell>,
    action: impl Fn(&mut Shell, &mut Window, &mut Context<Shell>) + 'static,
) -> gpui::Stateful<gpui::Div> {
    let id = id.into();
    let label: SharedString = tip.into();
    let selector = id.clone();
    let action = std::rc::Rc::new(action);
    let click = action.clone();
    let mut control = div();
    control
        .style()
        .text
        .get_or_insert_with(Default::default)
        .letter_spacing = Some(px(-0.1));
    control
        .id(SharedString::from(id.clone()))
        .debug_selector(move || selector.clone())
        .focusable()
        .when_some(
            s.features
                .read::<Panel>()
                .and_then(|p| p.focus.get(&id))
                .cloned(),
            |b, f| b.track_focus(&f),
        )
        .cursor_pointer()
        .rounded(px(7.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(12.))
        .font_weight(gpui::FontWeight::LIGHT)
        .text_color(theme().text_muted)
        .hover(|b| b.bg(theme().hover).text_color(theme().text))
        .active(|b| b.bg(theme().selection))
        .focus(|b| b.bg(theme().selection))
        .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(label.clone())).into())
        .on_click(cx.listener(move |s, _, window, cx| {
            cx.stop_propagation();
            click(s, window, cx)
        }))
        .on_key_down(cx.listener(move |s, e: &KeyDownEvent, window, cx| {
            match e.keystroke.key.as_str() {
                "enter" | "space" => action(s, window, cx),
                "tab" => {
                    if e.keystroke.modifiers.shift {
                        window.focus_prev()
                    } else {
                        window.focus_next()
                    }
                }
                _ => return,
            };
            cx.stop_propagation();
        }))
}
fn icon(
    s: &Shell,
    id: &'static str,
    path: &'static str,
    tip: &'static str,
    cx: &mut Context<Shell>,
    action: impl Fn(&mut Shell, &mut Window, &mut Context<Shell>) + 'static,
) -> gpui::Stateful<gpui::Div> {
    button(s, id, tip, cx, action)
        .size(px(28.))
        .child(crate::icon::stroke(path, theme().text_secondary, 16., 1.8))
}

pub(super) fn toggle(s: &Shell, open: bool, cx: &mut Context<Shell>) -> gpui::Stateful<gpui::Div> {
    let (disabled, progress, focus) = s
        .features
        .read::<Panel>()
        .map(|p| {
            (
                p.viewport < 1180.,
                p.morph.value().0,
                p.focus.get("header-right-panel").cloned(),
            )
        })
        .unwrap_or((false, f32::from(u8::from(open)), None));
    let action = |s: &mut Shell, w: &mut Window, cx: &mut Context<Shell>| {
        s.capture(w, cx);
        super::toggle(s, w, cx)
    };
    let label = if disabled {
        "Widen the window to open the right panel"
    } else if open {
        "Close panel  ⌘⌥B"
    } else {
        "Open O8 panel  ⌘⌥B"
    };
    let b = super::super::header::pill("header-right-panel", label, !disabled)
        .w(px(30.))
        .relative()
        .when_some(focus, |b, f| b.track_focus(&f))
        .focusable()
        .on_click(cx.listener(move |s, _, w, cx| {
            cx.stop_propagation();
            if !disabled {
                action(s, w, cx)
            }
        }))
        .on_key_down(cx.listener(move |s, e: &KeyDownEvent, w, cx| {
            if matches!(e.keystroke.key.as_str(), "enter" | "space") && !disabled {
                action(s, w, cx);
                cx.stop_propagation()
            }
        }))
        .child(
            div()
                .relative()
                .size(px(16.))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .opacity(1. - progress)
                        .child(
                            crate::icon::stroke(
                                PANEL,
                                theme().text_secondary,
                                16. * (1. - 0.28 * progress),
                                1.8,
                            )
                            .with_transformation(
                                gpui::Transformation::rotate(gpui::radians(
                                    -12f32.to_radians() * progress,
                                )),
                            ),
                        ),
                )
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .opacity(progress)
                        .child(
                            crate::icon::stroke(
                                COLUMNS,
                                theme().text_secondary,
                                16. * (0.72 + 0.28 * progress),
                                1.8,
                            )
                            .with_transformation(
                                gpui::Transformation::rotate(gpui::radians(
                                    12f32.to_radians() * (1. - progress),
                                )),
                            ),
                        ),
                ),
        )
        .child(
            div()
                .id("header-right-panel-hit")
                .debug_selector(|| "header-right-panel-hit".into())
                .absolute()
                .top(px(-14.))
                .bottom(px(-4.))
                .left_0()
                .right_0()
                .on_click(cx.listener(move |s, _, w, cx| {
                    cx.stop_propagation();
                    if !disabled {
                        action(s, w, cx)
                    }
                })),
        );
    b
}

fn tool_tab(s: &Shell, tool: Tool, cx: &mut Context<Shell>) -> AnyElement {
    let p = s.features.read::<Panel>().unwrap();
    let active = p.selected == tool;
    let scroll = p.scroll.clone();
    let index = p.tabs.iter().position(|t| *t == tool).unwrap();
    let slug = tool.slug();
    div()
        .id(SharedString::from(format!("panel-tool-tab-{slug}")))
        .debug_selector(move || {
            if active {
                "panel-tab".into()
            } else {
                format!("panel-tab-{slug}")
            }
        })
        .relative()
        .h(px(28.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .rounded(px(7.))
        .when(active, |v| v.bg(theme().selection).child(scroll.probe()))
        .child(
            button(
                s,
                format!("panel-tab-select-{}", tool.slug()),
                tool.label(),
                cx,
                move |s, w, cx| {
                    s.features.get::<Panel>().scroll.request_reveal();
                    show(s, tool, w, cx);
                    layout::focus(s, &format!("panel-tab-select-{}", tool.slug()), w)
                },
            )
            .tab_stop(active)
            .h(px(28.))
            .pl(px(8.))
            .pr(px(5.))
            .gap(px(6.))
            .when(active, |b| b.text_color(theme().text))
            .child(crate::icon::stroke(
                tool.icon(),
                if active {
                    theme().text
                } else {
                    theme().text_muted
                },
                13.,
                1.6,
            ))
            .child(tool.label()),
        )
        .child(
            button(
                s,
                format!("panel-tab-close-{}", tool.slug()),
                format!("Close {} tab", tool.label()),
                cx,
                move |s, w, cx| {
                    close_tab(s, index, w, cx);
                    let selected = s.features.get::<Panel>().current();
                    let id = if selected == Tool::Launcher {
                        "panel-new-tab".into()
                    } else {
                        format!("panel-tab-select-{}", selected.slug())
                    };
                    layout::focus(s, &id, w)
                },
            )
            .w(px(20.))
            .h(px(24.))
            .child(crate::icon::stroke(
                "M18 6 6 18M6 6l12 12",
                theme().text_muted,
                10.,
                2.5,
            )),
        )
        .into_any_element()
}

pub(super) fn header(s: &Shell, full: f32, shown: f32, cx: &mut Context<Shell>) -> AnyElement {
    let Some(p) = s.features.read::<Panel>() else {
        return div().into_any_element();
    };
    let selected = p.selected;
    let fade = if s.system_glass {
        crate::theme::veil_color(crate::theme::GLASS_VEIL[0].1)
    } else {
        theme().background
    };
    let mut rail = div()
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .items_center()
        .gap(px(4.));
    if selected == Tool::Browser {
        // The Browser's own pages replace the utility strip while it is in front.
        if let Some(view) = p.browsers.get(&key(s, Tool::Browser)).cloned() {
            let pages = view.update(cx, |browser, cx| browser.page_strip(cx));
            rail = rail.child(
                div()
                    .id("panel-browser-pages")
                    .debug_selector(|| "panel-browser-pages".into())
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .child(pages),
            );
        }
    } else if p.lower.is_none() && selected != Tool::Prs && selected != Tool::Compare {
        let strip = div()
            .id("panel-tabs")
            .debug_selector(|| "panel-tabs".into())
            .w_full()
            .min_w_0()
            .h_full()
            .flex()
            .items_center()
            .gap(px(4.))
            .children(p.tabs.iter().map(|t| tool_tab(s, *t, cx)))
            .when(selected == Tool::Launcher, |v| {
                v.child(
                    button(s, "panel-tab", "New tab", cx, |s, w, cx| {
                        show(s, Tool::Launcher, w, cx)
                    })
                    .relative()
                    .h(px(28.))
                    .px(px(10.))
                    .bg(theme().selection)
                    .child(p.scroll.probe())
                    .child("New tab"),
                )
            });
        rail = rail.child(super::super::tab_scroll::wrap(
            strip,
            p.scroll.clone(),
            Some(selected.slug()),
            "panel-tabs",
            fade,
            cx,
        ));
    } else {
        rail = rail.child(contextual::tabs(s, cx));
    }
    let mut row = div()
        .w(px(full))
        .h_full()
        .flex()
        .items_center()
        .gap(px(4.))
        .px(px(8.))
        .opacity(p.motion.value().0)
        .child(rail)
        .child(icon(s, "panel-new-tab", PLUS, "New tab", cx, |s, w, cx| {
            show(s, Tool::Launcher, w, cx)
        }))
        .child(
            div()
                .relative()
                .child(icon(
                    s,
                    "panel-more-views",
                    MORE,
                    "More panel views",
                    cx,
                    |s, w, cx| layout::menu(s, false, w, cx),
                ))
                .children(
                    p.menu
                        .filter(|_| !p.menu_lower)
                        .map(|_| drawer::menu(s, cx)),
                ),
        );
    if p.contexts.approvals > 0 {
        let count = p.contexts.approvals;
        row=row.child(button(s,"panel-approvals",format!("{count} pending approvals. Open Inbox."),cx,|s,w,cx|show(s,Tool::Inbox,w,cx)).h(px(26.)).min_w(px(42.)).px(px(8.)).gap(px(5.)).bg(crate::theme::brand_orange()).text_color(theme().background)
            .child(crate::icon::stroke("M12 3 20 6.5v5.3c0 4.3-3.1 7.7-8 9.2-4.9-1.5-8-4.9-8-9.2V6.5L12 3ZM9 12.2 11.2 14.4 15.5 9.6",theme().background,13.,2.)).child(if count>99{"99+".into()}else{count.to_string()}));
    }
    row = row
        .child(icon(
            s,
            "panel-maximize",
            if p.maximized { RESTORE } else { MAXIMIZE },
            if p.maximized {
                "Restore panel size · Esc"
            } else {
                "Maximize panel"
            },
            cx,
            |s, w, cx| {
                let p = s.features.get::<Panel>();
                p.maximized = !p.maximized;
                layout::focus(s, "panel-maximize", w);
                cx.notify()
            },
        ))
        .child(icon(
            s,
            "panel-split",
            SPLIT,
            if p.lower.is_some() {
                "Close right panel split"
            } else {
                "Split right panel"
            },
            cx,
            |s, w, cx| layout::split(s, w, cx),
        ))
        .child(toggle(s, true, cx));
    div()
        .w(px(shown))
        .h_full()
        .flex_shrink_0()
        .overflow_hidden()
        .child(row)
        .into_any_element()
}

pub(super) fn divider(s: &Shell, lower: Tool, cx: &mut Context<Shell>) -> AnyElement {
    let p = s.features.read::<Panel>().unwrap();
    div()
        .h(px(36.))
        .flex_shrink_0()
        .flex()
        .flex_col()
        .border_t_1()
        .border_color(theme().border)
        .bg(theme().background)
        .child(
            button(
                s,
                "panel-split-resize",
                "Drag to resize · double-click to reset",
                cx,
                |_, _, _| {},
            )
            .w_full()
            .h(px(7.))
            .rounded_none()
            .cursor(gpui::CursorStyle::ResizeUpDown)
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|s, e: &gpui::MouseDownEvent, w, cx| {
                    layout::focus(s, "panel-split-resize", w);
                    if e.click_count >= 2 {
                        s.state.right_panel.ratio = 50.;
                        s.persist();
                        cx.notify()
                    }
                }),
            )
            .on_drag(layout::SplitDrag, |_, _, _, cx| {
                cx.new(|_| layout::SplitDrag)
            })
            .child(div().size_full().debug_selector({
                let ratio = s.state.right_panel.ratio;
                move || format!("panel-split-ratio-{ratio:.0}")
            })),
        )
        .child(
            div()
                .h(px(28.))
                .flex()
                .items_center()
                .px(px(8.))
                .relative()
                .child(
                    button(
                        s,
                        "panel-lower-picker",
                        format!("Lower panel view: {}", lower.label()),
                        cx,
                        |s, w, cx| layout::menu(s, true, w, cx),
                    )
                    .h(px(28.))
                    .px(px(9.))
                    .gap(px(6.))
                    .child(crate::icon::stroke(lower.icon(), theme().text, 15., 1.6))
                    .child(lower.label())
                    .child(crate::icon::stroke(
                        "m6 9 6 6 6-6",
                        theme().text_muted,
                        9.,
                        2.4,
                    )),
                )
                .children(p.menu.filter(|_| p.menu_lower).map(|_| drawer::menu(s, cx))),
        )
        .into_any_element()
}
const MORE: &str = "M4 12h2M11 12h2M18 12h2";
const MAXIMIZE: &str = "M14 3h7v7M3 14v7h7M21 3l-7 7M3 21l7-7";
const RESTORE: &str = "M14 3v7h7M3 14h7v7M21 3l-7 7M3 21l7-7";
const SPLIT: &str =
    "M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4ZM3 12h18";
