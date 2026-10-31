// BrowserPipCard + HoverPipCard: scoped preview, cycle, orientation, drag and reopen.
use super::*;
use gpui::{MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent};
use std::time::{Duration, Instant};
struct BrowserPreview;
register_shell_feature!(BrowserPreview);
impl ShellFeature for BrowserPreview {
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook {
            order: 55,
            run: tick,
        }]
    }
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            order: 85,
            dispatch: |s, event, window, cx| {
                if let Some(browser) = super::right_panel::active_browser(s) {
                    if browser.update(cx, |browser, cx| browser.browser_key(event, window, cx)) {
                        return KeyResult::Handled;
                    }
                }
                KeyResult::Unhandled
            },
        }]
    }
    fn rail(&self) -> &'static [RailItem] {
        &[RailItem {
            order: 15,
            render: trigger,
        }]
    }
    fn slots(&self) -> &'static [RenderSlot] {
        &[RenderSlot {
            group: RenderGroup::Content,
            order: 930,
            render: render,
        }]
    }
}
#[derive(Default)]
struct Pip {
    scope: Option<String>,
    panel_was_open: bool,
    browser_seen: bool,
    pending_open: bool,
    open: bool,
    manual: bool,
    page: Option<u64>,
    hover: Option<Instant>,
    hide: Option<Instant>,
    drag: Option<(gpui::Point<gpui::Pixels>, [f32; 2])>,
}
fn eligible(s: &Shell) -> bool {
    s.active()
        .is_none_or(|tab| matches!(tab, Tab::Session(_) | Tab::Brain))
}
fn tick(s: &mut Shell, _: bool, _: &mut Window, cx: &mut Context<Shell>) {
    let browser = super::right_panel::browser_for_scope(s);
    let available = browser
        .as_ref()
        .is_some_and(|b| !b.read(cx).preview_pages().is_empty());
    let shown = super::right_panel::browser_shown(s);
    let panel_open = super::right_panel::is_open(s);
    let ready = super::right_panel::browser_pip_ready(s);
    let allowed = eligible(s)
        && available
        && !s.palette
        && !s.workspace_picker
        && !s.shortcuts
        && !registrations().iter().any(|r| (r.overlay_open)(s));
    let scope = s.state.selected.clone();
    let p = s.features.get::<Pip>();
    let before = (p.open, p.page);
    if p.scope != scope {
        *p = Pip {
            scope,
            ..Pip::default()
        };
    }
    if shown {
        p.browser_seen = true;
    }
    if p.panel_was_open && !panel_open && p.browser_seen {
        p.pending_open = true;
        p.browser_seen = false;
    }
    if !panel_open && ready && allowed && p.pending_open {
        p.open = true;
        p.manual = true;
        p.pending_open = false;
    }
    if !allowed || panel_open {
        p.open = false;
    }
    if ready
        && allowed
        && p.hover
            .is_some_and(|t| t.elapsed() >= Duration::from_millis(240))
    {
        p.open = true;
    }
    if !p.manual
        && p.hide
            .is_some_and(|t| t.elapsed() >= Duration::from_millis(200))
    {
        p.open = false;
        p.hide = None;
    }
    p.panel_was_open = panel_open;
    let open = p.open && ready;
    let page = p.page;
    if before != (p.open, p.page) {
        cx.notify();
    }
    let viewport = if s.state.browser_pip_wide {
        1280.
    } else {
        390.
    };
    if let Some(browser) = browser {
        let pages = browser.read(cx).preview_pages();
        let chosen = page
            .or(browser.read(cx).preview_active())
            .filter(|id| pages.iter().any(|p| p.0 == *id))
            .or_else(|| pages.first().map(|p| p.0));
        browser.update(cx, |browser, cx| {
            browser.preview(open.then_some(chosen).flatten(), viewport, cx)
        });
    }
}
fn hover(s: &mut Shell, entered: bool, cx: &mut Context<Shell>) {
    let p = s.features.get::<Pip>();
    p.hover = entered.then(Instant::now);
    p.hide = (!entered).then(Instant::now);
    cx.notify();
}
fn trigger(s: &mut Shell, _: &mut Window, cx: &mut Context<Shell>) -> Option<AnyElement> {
    let browser = super::right_panel::browser_for_scope(s)?;
    if browser.read(cx).preview_pages().is_empty() {
        return None;
    }
    Some(
        div()
            .id("browser-pip-trigger")
            .debug_selector(|| "browser-pip-trigger".into())
            .size(px(44.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(10.))
            .cursor_pointer()
            .hover(|b| b.bg(theme().hover))
            .tooltip(|_, cx| {
                cx.new(|_| crate::icon::Tip("Browser preview".into()))
                    .into()
            })
            .on_hover(cx.listener(|s, entered: &bool, _, cx| hover(s, *entered, cx)))
            .child(crate::icon::stroke(
                crate::browser_panel::header::GLOBE,
                theme().text_muted,
                18.,
                1.6,
            ))
            .on_click(cx.listener(|s, _, window, cx| reopen(s, window, cx)))
            .into_any_element(),
    )
}
fn reopen(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    let Some(browser) = super::right_panel::browser_for_scope(s) else {
        return;
    };
    let page = s
        .features
        .get::<Pip>()
        .page
        .or(browser.read(cx).preview_active());
    let pages = browser.read(cx).preview_pages();
    let selected = page
        .and_then(|id| pages.iter().find(|p| p.0 == id))
        .or_else(|| pages.first());
    let Some((_, _, url)) = selected else {
        return;
    };
    let url = url.clone();
    s.features.get::<Pip>().open = false;
    browser.update(cx, |browser, cx| browser.preview(None, 0., cx));
    super::right_panel::open_browser(s, url, window, cx);
}
fn control(
    id: &'static str,
    label: &'static str,
    cx: &Context<Shell>,
) -> gpui::Stateful<gpui::Div> {
    crate::browser_panel::header::keyboard_button(
        div()
            .id(id)
            .debug_selector(move || id.into())
            .w(px(22.))
            .h(px(24.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(6.))
            .cursor_pointer()
            .hover(|b| b.bg(theme().hover))
            .text_size(px(12.))
            .text_color(theme().text_muted)
            .child(label)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation()),
        cx,
    )
}
fn cycle(s: &mut Shell, direction: isize, cx: &mut Context<Shell>) {
    let Some(browser) = super::right_panel::browser_for_scope(s) else {
        return;
    };
    let pages = browser.read(cx).preview_pages();
    if pages.is_empty() {
        return;
    }
    let selected = s
        .features
        .get::<Pip>()
        .page
        .or(browser.read(cx).preview_active());
    let index = pages
        .iter()
        .position(|p| Some(p.0) == selected)
        .unwrap_or(0);
    let index = (index as isize + direction).rem_euclid(pages.len() as isize) as usize;
    s.features.get::<Pip>().page = Some(pages[index].0);
    cx.notify();
}
fn render(
    s: &mut Shell,
    _: &Frame,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> Option<AnyElement> {
    tick(s, false, window, cx);
    if (s.features.get::<Pip>().pending_open && !super::right_panel::browser_pip_ready(s))
        || s.features
            .get::<Pip>()
            .hover
            .is_some_and(|t| t.elapsed() < Duration::from_millis(240))
        || s.features
            .get::<Pip>()
            .hide
            .is_some_and(|t| t.elapsed() < Duration::from_millis(200))
    {
        window.request_animation_frame();
    }
    if !s.features.get::<Pip>().open || !super::right_panel::browser_pip_ready(s) {
        return None;
    }
    let browser = super::right_panel::browser_for_scope(s)?;
    let pages = browser.read(cx).preview_pages();
    let selected = s
        .features
        .get::<Pip>()
        .page
        .or(browser.read(cx).preview_active());
    let index = pages
        .iter()
        .position(|p| Some(p.0) == selected)
        .unwrap_or(0);
    let (_, title, _) = pages.get(index)?;
    let (preferred_w, preferred_h) = if s.state.browser_pip_wide {
        (440., 264.)
    } else {
        (300., 470.)
    };
    let size = window.viewport_size();
    let left = super::super::rail::WIDTH
        + if s.surfaces.sidebar.hidden {
            0.
        } else {
            super::super::sidebar::width(s)
        };
    let composer = s
        .active()
        .and_then(|tab| s.content.get(&s.key(&tab)))
        .and_then(|content| match content {
            Content::Session(view) => view.read(cx).browser_composer_bounds(cx),
            _ => None,
        })
        .map(|b| {
            [
                f32::from(b.left()),
                f32::from(b.top()),
                f32::from(b.size.width),
                f32::from(b.size.height),
            ]
        });
    let (position, [width, height]) = crate::browser_panel::fit_preview(
        [
            left,
            crate::theme::GEOMETRY.header,
            f32::from(size.width) - left,
            f32::from(size.height) - crate::theme::GEOMETRY.header,
        ],
        [preferred_w, preferred_h],
        s.state
            .browser_pip_position
            .filter(|p| p.iter().all(|v| v.is_finite())),
        composer,
    );
    let count = pages.len();
    let drag_owner = cx.entity().downgrade();
    let dragging = s.features.get::<Pip>().drag.is_some();
    Some(
        gpui::deferred(
            div()
                .id("browser-pip-card")
                .debug_selector(|| "browser-pip-card".into())
                .absolute()
                .left(px(position[0]))
                .top(px(position[1]))
                .w(px(width))
                .h(px(height + 30.))
                .flex()
                .flex_col()
                .occlude()
                .rounded(px(12.))
                .border_1()
                .border_color(theme().border)
                .bg(crate::theme::popover_background())
                .shadow_lg()
                .overflow_hidden()
                .when(dragging, |d| {
                    d.child(
                        gpui::canvas(
                            |_, _, _| (),
                            move |_, _, window, _| {
                                let owner = drag_owner.clone();
                                window.on_mouse_event(
                                    move |event: &MouseMoveEvent, phase, _, cx| {
                                        if phase == gpui::DispatchPhase::Capture {
                                            let _ = owner.update(cx, |s, cx| {
                                                if let Some((start, position)) =
                                                    s.features.get::<Pip>().drag
                                                {
                                                    s.state.browser_pip_position = Some([
                                                        position[0]
                                                            + f32::from(event.position.x - start.x),
                                                        position[1]
                                                            + f32::from(event.position.y - start.y),
                                                    ]);
                                                    cx.notify();
                                                }
                                            });
                                        }
                                    },
                                );
                                let owner = drag_owner.clone();
                                window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
                                    if phase == gpui::DispatchPhase::Capture
                                        && event.button == MouseButton::Left
                                    {
                                        let _ = owner.update(cx, |s, cx| {
                                            if s.features.get::<Pip>().drag.take().is_some() {
                                                s.persist();
                                                cx.notify();
                                            }
                                        });
                                    }
                                });
                            },
                        )
                        .absolute()
                        .top_0()
                        .left_0()
                        .size(px(1.)),
                    )
                })
                .on_hover(cx.listener(|s, entered: &bool, _, cx| {
                    let p = s.features.get::<Pip>();
                    p.hide = (!*entered).then(Instant::now);
                    if *entered {
                        p.hover = None;
                    }
                    cx.notify();
                }))
                .child(
                    div()
                        .id("browser-pip-drag")
                        .h(px(30.))
                        .flex_shrink_0()
                        .pl(px(10.))
                        .pr(px(4.))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .text_ellipsis()
                                .text_size(px(10.5))
                                .text_color(theme().text_muted)
                                .child(title.clone()),
                        )
                        .when(count > 1, |d| {
                            d.child(
                                control("browser-pip-prev", "‹", cx)
                                    .on_click(cx.listener(|s, _, _, cx| cycle(s, -1, cx))),
                            )
                            .child(
                                div()
                                    .text_size(px(10.))
                                    .text_color(theme().text_muted)
                                    .child(format!("{}/{count}", index + 1)),
                            )
                            .child(
                                control("browser-pip-next", "›", cx)
                                    .on_click(cx.listener(|s, _, _, cx| cycle(s, 1, cx))),
                            )
                        })
                        .child(
                            control("browser-pip-orientation", "▯", cx).on_click(cx.listener(
                                |s, _, _, cx| {
                                    s.state.browser_pip_wide = !s.state.browser_pip_wide;
                                    s.persist();
                                    cx.notify();
                                },
                            )),
                        )
                        .child(
                            control("browser-pip-open", "↗", cx)
                                .on_click(cx.listener(|s, _, window, cx| reopen(s, window, cx))),
                        )
                        .child(control("browser-pip-close", "×", cx).on_click(cx.listener(
                            |s, _, _, cx| {
                                let p = s.features.get::<Pip>();
                                p.open = false;
                                p.manual = false;
                                p.hover = None;
                                cx.notify();
                            },
                        )))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |s, event: &MouseDownEvent, _, cx| {
                                s.features.get::<Pip>().drag = Some((event.position, position));
                                cx.notify();
                            }),
                        ),
                )
                .child(div().flex_1().min_h_0().child(browser)),
        )
        .with_priority(3)
        .into_any_element(),
    )
}
