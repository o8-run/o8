use super::*;
struct Header;
register_shell_feature!(Header);
impl ShellFeature for Header {
    fn slots(&self) -> &'static [RenderSlot] {
        &[RenderSlot {
            group: RenderGroup::Chrome,
            order: 100,
            render,
        }]
    }
}
fn render(
    s: &mut Shell,
    frame: &Frame,
    _: &mut Window,
    cx: &mut Context<Shell>,
) -> Option<AnyElement> {
    // Surface entries and the brand live in the navigation rail (shell_rail.rs);
    // the open tabs share this band, as in the desktop workspace header.
    Some(
        (div()
            .flex()
            .items_center()
            .flex_shrink_0()
            .gap(px(6.))
            .h(px(crate::theme::GEOMETRY.header))
            .text_size(px(12.))
            // Clears the traffic lights, which extend past the rail column.
            .pl(px(20.))
            .pr(px(8.))
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|_, _, window, _| window.prevent_default()),
            )
            .child(
                div()
                    .id("workspace-switcher")
                    .debug_selector(|| "workspace-switcher".into())
                    .h(px(26.))
                    .px(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .flex_shrink_0()
                    .rounded(px(7.))
                    .cursor_pointer()
                    .text_color(theme().text_secondary)
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .hover(|view| view.bg(theme().hover).text_color(theme().text))
                    .tooltip(|_, cx| cx.new(|_| crate::icon::Tip("Switch workspace".into())).into())
                    .child(
                        div()
                            .max_w(px(160.))
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .child(
                                s.state
                                    .selected
                                    .as_deref()
                                    .and_then(|path| std::path::Path::new(path).file_name())
                                    .map(|name| name.to_string_lossy().to_string())
                                    .unwrap_or_else(|| "Workspaces".into()),
                            ),
                    )
                    .child(crate::icon::stroke(CHEVRON, theme().text_muted, 10., 2.))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.capture(window, cx);
                        this.palette = true;
                        this.workspace_picker = true;
                        this.shortcuts = false;
                        this.query.clear();
                        this.choice = 0;
                        this.palette_scroll.scroll_to_item(1);
                        this.focus.focus(window);
                        cx.notify();
                    })),
            )
            .child(tabs(s, cx))
            .child(
                div()
                    .id("shell-palette")
                    .debug_selector(move || frame.commands.into())
                    .size(px(28.))
                    .flex()
                    .flex_shrink_0()
                    .items_center()
                    .justify_center()
                    .rounded(px(7.))
                    .cursor_pointer()
                    .hover(|view| view.bg(theme().hover))
                    .tooltip(|_, cx| cx.new(|_| crate::icon::Tip("Search and commands  ⌘K".into())).into())
                    .child(crate::icon::stroke(SEARCH, theme().text_secondary, 15., 1.8))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.capture(window, cx);
                        this.palette = true;
                        this.workspace_picker = false;
                        this.shortcuts = false;
                        this.query.clear();
                        this.choice = 0;
                        this.palette_scroll.scroll_to_item(1);
                        this.focus.focus(window);
                        this.revision += 1;
                        cx.notify();
                    })),
            )
            .when(frame.retry, |view| {
                view.child(
                    div()
                        .id("shell-retry")
                        .debug_selector(|| "shell-retry".into())
                        .cursor_pointer()
                        .p(px(6.))
                        .child("Retry")
                        .on_click(cx.listener(|this, _, _, cx| this.load(cx))),
                )
            }))
        .into_any_element(),
    )
}

const CHEVRON: &str = "m6 9 6 6 6-6";
const SEARCH: &str = "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z M21 21l-4.3-4.3";
const CLOSE: &str = "M6 6l12 12M18 6L6 18";

/// The desktop's single-colour pill glyphs (PillRuntimeGlyph), chosen by label.
fn glyph(tab: &Tab) -> &'static str {
    match tab {
        Tab::Session(_) => "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
        _ => match tab.label() {
            "Terminal" => "m4 17 6-6-6-6 M12 19h8",
            "Pull requests" => {
                "M18 15a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M6 3a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M13 6h3a2 2 0 0 1 2 2v7 M6 9v12"
            }
            "Inbox" => {
                "M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
            }
            _ => "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M3 9h18",
        },
    }
}

/// Closes one tab, as Cmd+W does for the active one.
pub(super) fn close_tab(s: &mut Shell, index: usize, window: &mut Window, cx: &mut Context<Shell>) {
    let Some(tab) = s.current().and_then(|w| w.tabs.get(index).cloned()) else {
        return;
    };
    s.content.remove(&s.key(&tab));
    let saved = s
        .state
        .workspaces
        .get_mut(s.state.selected.as_deref().unwrap_or(""))
        .unwrap();
    (tab.registration().remove)(saved, &tab);
    saved.tabs.remove(index);
    if index < saved.active {
        saved.active -= 1;
    }
    saved.active = saved.active.min(saved.tabs.len().saturating_sub(1));
    s.ensure(window, cx);
    s.restore_focus(window, cx);
    s.persist();
    cx.notify();
}

/// The desktop header's pill strip: the active tab is a filled pill, the rest
/// are quiet labels that fill on hover. Each pill leads with its kind's glyph,
/// which turns into a close mark while the pill is hovered.
fn tabs(s: &Shell, cx: &mut Context<Shell>) -> impl IntoElement {
    let active = s.active();
    let geometry = crate::theme::GEOMETRY;
    div()
        .flex()
        .flex_1()
        .min_w_0()
        .items_center()
        .gap(px(2.))
        .id("surface-tabs")
        .overflow_x_scroll()
        .children(
            s.current()
                .map(|w| w.tabs.clone())
                .unwrap_or_default()
                .into_iter()
                .enumerate()
                .map(|(i, t)| {
                    let selected = active.as_ref() == Some(&t);
                    let group = gpui::SharedString::from(format!("surface-tab-{i}"));
                    let label = match &t {
                        Tab::Session(id) => {
                            let selected =
                                s.current().and_then(|w| w.selections.get(id)).unwrap_or(id);
                            s.sessions
                                .iter()
                                .find(|s| &s.id == selected)
                                .map(|s| s.title.clone())
                                .unwrap_or_else(|| "Chat".into())
                        }
                        _ => t.label().into(),
                    };
                    div()
                        .id(("surface-tab", i))
                        .group(group.clone())
                        .debug_selector(move || format!("surface-tab-{i}"))
                        .cursor_pointer()
                        .h(px(geometry.tab_height))
                        .px(px(10.))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .flex_shrink_0()
                        .rounded(px(geometry.tab_radius))
                        .font_weight(gpui::FontWeight::LIGHT)
                        .text_color(if selected {
                            theme().text
                        } else {
                            theme().text_muted
                        })
                        .when(selected, |pill| pill.bg(theme().selection))
                        .when(!selected, |pill| pill.hover(|pill| pill.bg(theme().hover)))
                        .child(
                            div()
                                .relative()
                                .size(px(14.))
                                .flex_shrink_0()
                                .child(
                                    div()
                                        .absolute()
                                        .inset_0()
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .group_hover(group.clone(), |view| view.opacity(0.))
                                        .child(crate::icon::stroke(
                                            glyph(&t),
                                            if selected {
                                                theme().text
                                            } else {
                                                theme().text_muted
                                            },
                                            11.,
                                            2.,
                                        )),
                                )
                                .child(
                                    div()
                                        .id(("surface-tab-close", i))
                                        .debug_selector(move || format!("surface-tab-close-{i}"))
                                        .absolute()
                                        .inset_0()
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .rounded(px(4.))
                                        .opacity(0.)
                                        .group_hover(group, |view| view.opacity(1.))
                                        .tooltip(|_, cx| {
                                            cx.new(|_| crate::icon::Tip("Close tab  ⌘W".into())).into()
                                        })
                                        .child(crate::icon::stroke(CLOSE, theme().text, 11., 2.4))
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            cx.stop_propagation();
                                            this.capture(window, cx);
                                            close_tab(this, i, window, cx);
                                        })),
                                ),
                        )
                        .child(
                            div()
                                .max_w(px(180.))
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .child(label),
                        )
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.capture(window, cx);
                            for registration in registrations() {
                                (registration.after_tab)(this);
                            }
                            this.state
                                .workspaces
                                .get_mut(this.state.selected.as_deref().unwrap_or(""))
                                .unwrap()
                                .active = i;
                            this.ensure(window, cx);
                            this.restore_focus(window, cx);
                            this.persist();
                            cx.notify();
                        }))
                }),
        )
}
