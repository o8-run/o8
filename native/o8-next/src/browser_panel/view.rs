use super::*;
use gpui::StyledImage;

pub(super) const GLOBE: &str =
    "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M2 12h20 M12 2a16 16 0 0 1 0 20 16 16 0 0 1 0-20";
const BACK: &str = "M19 12H5m7-7-7 7 7 7";
const FORWARD: &str = "M5 12h14m-7-7 7 7-7 7";
const RELOAD: &str = "M23 4v6h-6 M20.49 15a9 9 0 1 1-2.12-9.36L23 10";
const COPY: &str = "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71";
const EXTERNAL: &str =
    "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14 21 3";
const CLOSE: &str = "M18 6 6 18 M6 6l12 12";
const PLUS: &str = "M12 5v14 M5 12h14";
const CHECK: &str = "M20 6 9 17l-5-5";
const DESIGN: &str = "m14 6 4-4 4 4-9 9-4-4 5-5 M9 11l4 4 M9 15c-4-1-1 5-7 5 6 3 10-1 7-5";

fn button(id: &'static str, path: &'static str, tip: &'static str, enabled: bool) -> Stateful<Div> {
    let icon_size = match id {
        "browser-copy" | "browser-external" => 11.,
        "browser-design" | "browser-reload" | "browser-add-page" => 12.,
        _ => 13.,
    };
    div()
        .id(id)
        .focusable()
        .debug_selector(move || id.into())
        .size(px(22.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .tab_stop(enabled)
        .when(enabled, |b| {
            b.cursor_pointer()
                .hover(|b| b.bg(theme().hover))
                .active(|b| b.bg(theme().selection))
                .focus(|b| b.bg(theme().selection))
        })
        .opacity(if enabled { 1. } else { 0.3 })
        .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(tip.into())).into())
        .child(crate::icon::stroke(
            path,
            if path == CHECK {
                theme().success
            } else {
                theme().text_secondary
            },
            icon_size,
            2.,
        ))
}
#[derive(Clone, Copy)]
enum Control {
    Back,
    Forward,
    Reload,
    Copy,
    External,
}
impl Control {
    fn run(self, browser: &mut BrowserPanel, cx: &mut Context<BrowserPanel>) {
        match self {
            Self::Back => browser.act(web::Web::back, cx),
            Self::Forward => browser.act(web::Web::forward, cx),
            Self::Reload => browser.reload(cx),
            Self::Copy => browser.copy_url(cx),
            Self::External => browser.external(cx),
        }
    }
}
fn control(
    id: &'static str,
    path: &'static str,
    tip: &'static str,
    enabled: bool,
    action: Control,
    cx: &mut Context<BrowserPanel>,
) -> Stateful<Div> {
    button(id, path, tip, enabled)
        .on_mouse_down(
            gpui::MouseButton::Left,
            cx.listener(|this, _, _, _| this.focus_chrome()),
        )
        .on_click(cx.listener(move |this, _, _, cx| {
            if enabled {
                action.run(this, cx);
            }
        }))
        .on_key_down(cx.listener(move |this, event: &gpui::KeyDownEvent, _, cx| {
            if enabled && matches!(event.keystroke.key.as_str(), "enter" | "space") {
                action.run(this, cx);
                cx.stop_propagation();
            }
        }))
}
#[derive(Clone)]
struct DraggedPage {
    id: u64,
    title: String,
}
impl Render for DraggedPage {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .h(px(22.))
            .px(px(9.))
            .rounded(px(6.))
            .bg(theme().surface)
            .text_size(px(11.5))
            .font_weight(FontWeight::LIGHT)
            .text_color(theme().text)
            .child(self.title.clone())
    }
}
impl BrowserPanel {
    fn favicon(&self, url: &str) -> AnyElement {
        if let Some(image) = favicon::host(url)
            .and_then(|host| self.favicons.get(&host))
            .and_then(|image| image.as_ref())
        {
            gpui::img(image.clone())
                .size(px(12.))
                .rounded(px(3.))
                .with_fallback(|| {
                    crate::icon::stroke(GLOBE, theme().text_muted, 12., 2.).into_any_element()
                })
                .into_any_element()
        } else {
            crate::icon::stroke(GLOBE, theme().text_muted, 12., 2.).into_any_element()
        }
    }
    pub fn page_strip(&self, cx: &mut Context<Self>) -> AnyElement {
        let count = self.tabs.len();
        div()
            .id("browser-pages")
            .h(px(22.))
            .flex()
            .items_center()
            .min_w_0()
            .gap(px(1.))
            .children(self.tabs.iter().map(|tab| {
                let id = tab.id;
                let active = self.active == Some(id);
                let show_label = count <= 4 || active;
                let title = tab.title.clone();
                let label = if count <= 2 {
                    title.clone()
                } else {
                    model::title(&tab.url)
                };
                let after = Rc::new(std::cell::Cell::new(false));
                let drag_after = after.clone();
                let group: SharedString = format!("browser-page-{id}").into();
                div()
                    .id(group.clone())
                    .debug_selector(move || format!("browser-page-{id}"))
                    .group(group.clone())
                    .relative()
                    .focusable()
                    .h(px(22.))
                    .min_w_0()
                    .max_w(px(if count <= 2 {
                        180.
                    } else if count <= 4 {
                        120.
                    } else if active {
                        140.
                    } else {
                        30.
                    }))
                    .pl(px(if show_label { 9. } else { 6. }))
                    .pr(px(if show_label { 5. } else { 6. }))
                    .flex()
                    .items_center()
                    .gap(px(if show_label { 6. } else { 0. }))
                    .rounded(px(6.))
                    .cursor_pointer()
                    .tab_stop(true)
                    .bg(if active {
                        theme().selection
                    } else {
                        gpui::transparent_black().into()
                    })
                    .hover(|p| p.bg(theme().hover))
                    .active(|p| p.bg(theme().selection))
                    .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(title.clone().into())).into())
                    .child(
                        div()
                            .flex_shrink_0()
                            .when(!show_label, |d| {
                                d.group_hover(group.clone(), |s| s.invisible())
                            })
                            .child(self.favicon(&tab.url)),
                    )
                    .when(show_label, |p| {
                        p.child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .text_size(px(11.5))
                                .font_weight(FontWeight::LIGHT)
                                .text_color(if active {
                                    theme().text
                                } else {
                                    theme().text_muted
                                })
                                .child(label),
                        )
                    })
                    .child(
                        div()
                            .id(("browser-close", id))
                            .focusable()
                            .debug_selector(move || format!("browser-close-{id}"))
                            .size(px(if show_label { 17. } else { 12. }))
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(4.))
                            .when(!show_label, |d| d.absolute().left(px(6.)).top(px(5.)))
                            .when(!active || !show_label, |d| {
                                d.invisible().group_hover(group.clone(), |s| s.visible())
                            })
                            .hover(|b| b.bg(theme().hover))
                            .focus(|b| b.bg(theme().selection))
                            .on_key_down(cx.listener(
                                move |this, event: &gpui::KeyDownEvent, window, cx| {
                                    if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                        this.close(id, cx);
                                        this.focus.focus(window);
                                        cx.stop_propagation();
                                    }
                                },
                            ))
                            .child(crate::icon::stroke(CLOSE, theme().text_secondary, 9., 3.))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                cx.stop_propagation();
                                this.close(id, cx);
                            })),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| this.select(id, cx)))
                    .on_key_down(cx.listener(move |this, event: &gpui::KeyDownEvent, _, cx| {
                        if event.keystroke.key == "enter" {
                            this.select(id, cx);
                            cx.stop_propagation();
                        }
                    }))
                    .on_drag(
                        DraggedPage {
                            id,
                            title: tab.title.clone(),
                        },
                        |dragged, _, _, cx| cx.new(|_| dragged.clone()),
                    )
                    .drag_over::<DraggedPage>(|p, _, _, _| p.bg(theme().hover))
                    .on_drag_move::<DraggedPage>(move |event, _, _| {
                        if event.bounds.contains(&event.event.position) {
                            drag_after.set(event.event.position.x >= event.bounds.center().x);
                        }
                    })
                    .on_drop(cx.listener(move |this, dragged: &DraggedPage, _, cx| {
                        model::reorder(&mut this.tabs, dragged.id, id, after.get());
                        this.publish(cx);
                        cx.notify();
                    }))
            }))
            .child(
                button("browser-add-page", PLUS, "New tab", true)
                    .on_key_down(cx.listener(|this, e: &gpui::KeyDownEvent, window, cx| {
                        if matches!(e.keystroke.key.as_str(), "enter" | "space") {
                            this.add(String::new(), cx);
                            this.focus(window);
                            cx.stop_propagation();
                        }
                    }))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.add(String::new(), cx);
                        this.focus(window);
                    })),
            )
            .into_any_element()
    }
    fn empty(&self, cx: &mut Context<Self>) -> AnyElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(12.))
            .p(px(24.))
            .child(crate::icon::stroke(GLOBE, theme().text_muted, 32., 1.5))
            .child(
                div()
                    .text_size(px(13.5))
                    .font_weight(FontWeight::LIGHT)
                    .text_color(theme().text_faint)
                    .child("No active previews"),
            )
            .child(
                div()
                    .id("browser-new-tab")
                    .focusable()
                    .debug_selector(|| "browser-new-tab".into())
                    .px(px(12.))
                    .py(px(5.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(theme().border)
                    .bg(theme().hover)
                    .text_color(theme().text)
                    .text_size(px(12.))
                    .font_weight(FontWeight::LIGHT)
                    .cursor_pointer()
                    .hover(|b| b.bg(theme().selection))
                    .child("+ New Tab")
                    .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                        if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                            this.add(String::new(), cx);
                            this.focus(window);
                            cx.stop_propagation();
                        }
                    }))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.add(String::new(), cx);
                        this.focus(window);
                    })),
            )
            .into_any_element()
    }
}
impl Render for BrowserPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.request_favicons(cx);
        self.window = Some(window.window_handle());
        if !self.focus_observed {
            self.focus_observed = true;
            self._subscriptions.push(cx.on_focus(
                &self.address_focus.clone(),
                window,
                |this, _, cx| {
                    this.editing = true;
                    this.address.update(cx, |a, cx| a.select_all(cx));
                },
            ));
            self._subscriptions.push(cx.on_focus_out(
                &self.address_focus.clone(),
                window,
                |this, _, _, _| this.editing = false,
            ));
        }
        if self.blur_address {
            self.focus.focus(window);
            self.blur_address = false;
        }
        self.editing = self.address_focus.is_focused(window);
        let active = self.current().cloned();
        let has_url = active.as_ref().is_some_and(|tab| !tab.url.is_empty());
        let page = self.active.and_then(|id| self.pages.get(&id));
        let back = page.is_some_and(|p| p.back);
        let forward = page.is_some_and(|p| p.forward);
        let loading = page.is_some_and(|p| p.loading);
        let error = page.and_then(|p| p.error.clone());
        let web = page.map(|p| p.web.clone());
        let pending = page.map(|p| p.pending.clone());
        let creation_failed = page.map(|p| p.creation_failed.clone());
        let covered = self.covered;
        let agent_glow = self.agent_glow.is_some();
        let redacted = active.as_ref().is_some_and(|tab| tab.redacted);
        let empty = self.tabs.is_empty();
        let explain = redacted || error.is_some() || (!has_url && self.previews.is_empty());
        div().track_focus(&self.focus)
            .capture_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                let key = &event.keystroke;
                if key.key == "tab" && !key.modifiers.control && !key.modifiers.platform && !key.modifiers.alt {
                    this.focus_chrome();
                    if key.modifiers.shift { window.focus_prev(); } else { window.focus_next(); }
                    cx.stop_propagation();
                }
            }))
            .size_full().flex().flex_col().min_h_0()
            .text_color(theme().text).font_family(theme().font_ui).font_weight(FontWeight::LIGHT)
            .when(!self.in_header && !empty, |d| d.child(self.page_strip(cx)))
            .when(empty, |d| d.child(self.empty(cx)))
            .when(!empty, |d| d
                .child(div().h(px(30.)).px(px(5.)).flex_shrink_0().flex().items_center().gap(px(3.))
                    .border_b_1().border_color(theme().border)
                    .child(control("browser-back", BACK, "Back", back, Control::Back, cx))
                    .child(control("browser-forward", FORWARD, "Forward", forward, Control::Forward, cx))
                    .child(control("browser-reload", RELOAD, "Reload", has_url, Control::Reload, cx))
                    .child(div().id("browser-address").debug_selector(|| "browser-address".into()).h(px(22.)).px(px(9.)).min_w_0().flex_1()
                        .flex().items_center().gap(px(6.)).rounded(px(6.)).bg(theme().surface_raised)
                        .child(crate::icon::stroke(GLOBE, theme().text_muted, 10., 2.))
                        .child(div().flex_1().min_w_0().text_size(px(11.5)).child(self.address.clone()))
                        .on_click(cx.listener(|this, _, window, cx| {
                            if !this.editing { this.address.update(cx, |a, cx| a.select_all(cx)); }
                            this.focus(window);
                        })))
                    .child(button("browser-design", DESIGN, "Design Mode requires the classic browser bridge", false))
                    .child(control("browser-copy", if self.copied.is_some() { CHECK } else { COPY }, "Copy current URL", has_url, Control::Copy, cx))
                    .child(control("browser-external", EXTERNAL, "Open in browser", has_url, Control::External, cx)))
                .when(loading, |d| d.child(div().id("browser-loading").h(px(2.)).w_full().bg(theme().accent).debug_selector(|| "browser-loading".into())))
                .child(div().flex_1().min_h_0().relative().overflow_hidden()
                    .when(loading, |body| body.child(div().size_full().absolute().flex().items_center().justify_center().text_size(px(12.)).text_color(theme().text_muted).child("Loading page…")))
                    .when(agent_glow, |d| d.border_1().border_color(theme().warning))
                    .when(!has_url || error.is_some() || !cfg!(target_os = "macos"), |body| body.child(
                        div().size_full().flex().flex_col().items_center().justify_center().gap(px(8.)).p(px(32.))
                            .when(redacted || has_url, |d| d.child(crate::icon::stroke(GLOBE, theme().text_muted, 12., 2.)))
                            .child(div().text_size(px(13.5)).font_weight(if redacted { FontWeight::NORMAL } else { FontWeight::LIGHT })
                                .mb(px(if !has_url && !redacted { 10. } else { 0. }))
                                .text_color(if redacted { theme().text } else { theme().text_muted }).child(if redacted { "Navigate again to reopen this page" }
                                    else if error.is_some() { "Site not loading?" }
                                    else if has_url { "The Browser needs macOS for now." }
                                    else { "Open a running dev server" }))
                            .when(explain, |d| d.child(div().text_size(px(12.)).text_color(theme().text_faint).child(if redacted {
                                "Its address contained credentials or a signed value, so o8 did not save it across the restart.".to_string()
                            } else if let Some(error) = error.as_ref() { error.clone() } else if !has_url && self.previews.is_empty() { "No dev servers detected".into() } else { String::new() })))
                            .when(!has_url && !redacted, |d| d.children(self.previews.iter().map(|port| {
                                let port = *port;
                                div().id(("browser-port", port as usize)).focusable().debug_selector(move || format!("browser-port-{port}"))
                                    .w_full().max_w(px(320.)).px(px(16.)).py(px(12.)).rounded(px(12.))
                                    .border_1().border_color(theme().border).bg(theme().surface_raised)
                                    .cursor_pointer().hover(|d| d.bg(theme().hover)).flex().items_center().gap(px(12.))
                                    .child(div().size(px(34.)).rounded(px(9.)).bg(theme().selection).flex().items_center().justify_center()
                                        .child(crate::icon::stroke(GLOBE, theme().syntax_link, 16., 1.9)))
                                    .child(div().flex().flex_col().gap(px(1.))
                                        .child(div().text_size(px(14.)).font_weight(FontWeight::MEDIUM).text_color(theme().text).child(format!(":{port}")))
                                        .child(div().text_size(px(11.)).text_color(theme().text_faint).child("localhost")))
                                    .on_key_down(cx.listener(move |this, event: &gpui::KeyDownEvent, window, cx| {
                                        if matches!(event.keystroke.key.as_str(), "enter" | "space") { this.load_current(&format!("http://localhost:{port}"), cx); this.focus.focus(window); cx.stop_propagation(); }
                                    }))
                                    .on_click(cx.listener(move |this, _, _, cx| this.load_current(&format!("http://localhost:{port}"), cx)))
                            })))
                            .when(has_url, |d| d.child(div().id("browser-recover").debug_selector(|| "browser-recover".into()).rounded(px(6.)).px(px(8.)).py(px(4.))
                                .bg(theme().hover).text_size(px(11.)).text_color(theme().syntax_link).cursor_pointer().child("Open in browser")
                                .on_click(cx.listener(|this, _, _, cx| this.external(cx)))))
                    ))
                    .when(has_url && error.is_none() && cfg!(target_os = "macos"), |body| body.child(canvas(
                        |bounds, _, _| bounds,
                        move |bounds: Bounds<Pixels>, _, window, _| {
                            if let (Some(web), Some(pending)) = (&web, &pending) {
                                let mut slot = web.borrow_mut();
                                if slot.is_none() {
                                    *slot = web::Web::new(window);
                                    if let Some(failed) = &creation_failed { failed.set(slot.is_none() && !cfg!(test)); }
                                    if let Some(page) = slot.as_ref() && let Some(url) = pending.borrow_mut().take() { page.load(&url); }
                                }
                                if let Some(page) = slot.as_ref() {
                                    if covered || !page.has_document() { page.hide(); } else {
                                        let bounds = if agent_glow { Bounds::new(gpui::point(bounds.left() + px(2.), bounds.top() + px(2.)), gpui::size((bounds.size.width - px(4.)).max(px(0.)), (bounds.size.height - px(4.)).max(px(0.)))) } else { bounds };
                                        page.position(bounds, window);
                                    }
                                }
                            }
                        }).absolute().top_0().left_0().size_full()))
                ))
    }
}
