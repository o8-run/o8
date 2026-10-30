//! Browser commands from the classic toolbar and platform Browser menu.
use super::*;

impl BrowserPanel {
    pub(crate) fn browser_key(
        &mut self,
        event: &gpui::KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.covered || self.remote.is_some() {
            return false;
        }
        let key = &event.keystroke;
        if key.key == "escape" && self.menu {
            self.menu = false;
        } else if key.key == "f10" && key.modifiers.shift {
            self.focus_chrome();
            self.focus.focus(window);
            self.menu = !self.menu;
            self.hide_pages();
        } else if (key.modifiers.platform || key.modifiers.control)
            && !key.modifiers.alt
            && !key.modifiers.shift
        {
            match key.key.as_str() {
                "l" => {
                    self.focus(window);
                    self.editing = true;
                    self.address.update(cx, |field, cx| field.select_all(cx));
                }
                "r" => self.reload(cx),
                "[" => self.act(web::Web::back, cx),
                "]" => self.act(web::Web::forward, cx),
                _ => return false,
            }
        } else if key.modifiers.alt
            && !key.modifiers.platform
            && !key.modifiers.control
            && !key.modifiers.shift
        {
            match key.key.as_str() {
                "left" => self.act(web::Web::back, cx),
                "right" => self.act(web::Web::forward, cx),
                _ => return false,
            }
        } else {
            return false;
        }
        cx.notify();
        true
    }

    pub(super) fn browser_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let page = self.active.and_then(|id| self.pages.get(&id));
        let has_url = self.current().is_some_and(|tab| !tab.url.is_empty());
        let rows = [
            (
                "browser-menu-back",
                "Back",
                "⌘[",
                page.is_some_and(|page| page.back),
            ),
            (
                "browser-menu-forward",
                "Forward",
                "⌘]",
                page.is_some_and(|page| page.forward),
            ),
            ("browser-menu-reload", "Reload", "⌘R", has_url),
            ("browser-menu-focus", "Focus address", "⌘L", true),
            (
                "browser-menu-remote",
                "Remote previews",
                "",
                self.client.is_some(),
            ),
        ];
        div()
            .id("browser-menu")
            .debug_selector(|| "browser-menu".into())
            .absolute()
            .top(px(30.))
            .right(px(5.))
            .w(px(230.))
            .p(px(4.))
            .occlude()
            .rounded(px(8.))
            .border_1()
            .border_color(theme().border)
            .bg(crate::theme::popover_background())
            .shadow_lg()
            .children(rows.into_iter().map(|(id, label, key, enabled)| {
                let row = div()
                    .id(id)
                    .debug_selector(move || id.into())
                    .h(px(30.))
                    .px(px(8.))
                    .rounded(px(6.))
                    .flex()
                    .items_center()
                    .justify_between()
                    .text_size(px(12.))
                    .text_color(if enabled {
                        theme().text
                    } else {
                        theme().text_faint
                    })
                    .when(enabled, |d| {
                        d.cursor_pointer().hover(|d| d.bg(theme().hover))
                    })
                    .child(label)
                    .child(div().text_color(theme().text_muted).child(key));
                header::keyboard_button(row, cx)
                    .tab_stop(enabled)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if !enabled {
                            return;
                        }
                        this.menu = false;
                        match id {
                            "browser-menu-back" => this.act(web::Web::back, cx),
                            "browser-menu-forward" => this.act(web::Web::forward, cx),
                            "browser-menu-reload" => this.reload(cx),
                            "browser-menu-focus" => this.focus(window),
                            "browser-menu-remote" => this.open_remote(cx),
                            _ => {}
                        }
                        cx.notify();
                    }))
            }))
            .into_any_element()
    }
}
