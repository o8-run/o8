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
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> Option<AnyElement> {
    // The desktop header, measured from WorkspaceHeaderStrip, LeftHeaderStrip
    // and PanelHeaderStrip. The sidebar toggle stays at x=74 (rail 60 + 14)
    // whether the sidebar is open or not. With the sidebar open, search sits
    // at the sidebar's right edge and back/forward start the workspace header;
    // with it closed, toggle, search, back and forward share one row.
    record_visit(s);
    let back = adjacent(s, -1);
    let forward = adjacent(s, 1);
    let hidden = s.surfaces.sidebar.hidden;
    let panel = super::right_panel::width(s, window);
    let panel_open = super::right_panel::is_open(s);
    let history = |id: &'static str, path, tip, target: Option<usize>, cx: &mut Context<Shell>| {
        icon_button(id, path, 15., 1.7, tip, target.is_some()).when_some(target, |button, visit| {
            button.on_click(cx.listener(move |this, _, window, cx| {
                this.capture(window, cx);
                revisit(this, visit, window, cx);
            }))
        })
    };
    let workspace = div()
        .flex()
        .flex_1()
        .min_w_0()
        .h_full()
        .items_center()
        .gap(px(4.))
        // 4px workspace inset, plus the strip's 10px collapsed padding, or its
        // 8px padding after the 4px sidebar resize edge.
        .pl(px(if hidden { 14. } else { 16. }))
        .pr(px(8.))
        .when(hidden, |row| {
            row.child(sidebar_toggle(true, cx)).child(search_button(cx))
        })
        .child(history("header-back", BACK, "Back", back, cx))
        .child(history("header-forward", FORWARD, "Forward", forward, cx))
        .child(tabs(s, cx))
        .child(
            div()
                .flex()
                .flex_shrink_0()
                .items_center()
                .gap(px(4.))
                .mt(px(1.3))
                .child(super::header_tools::play(s, window, cx))
                .child(super::header_tools::tools(s, window, cx))
                .when(!panel_open, |row| {
                    row.child(super::right_panel::toggle_button(false, cx))
                }),
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
        });
    Some(
        div()
            .flex()
            .items_center()
            .flex_shrink_0()
            .h(px(crate::theme::GEOMETRY.header))
            .text_size(px(12.))
            .pr(px(4.))
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|_, _, window, _| window.prevent_default()),
            )
            .when(!hidden, |row| {
                row.child(
                    div()
                        .w(px(super::super::sidebar::WIDTH))
                        .h_full()
                        .flex_shrink_0()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .pl(px(14.))
                        .pr(px(8.))
                        .child(sidebar_toggle(false, cx))
                        .child(div().flex_1())
                        .child(search_button(cx)),
                )
            })
            .child(workspace)
            .when_some(panel, |row, (full, shown)| {
                row.child(super::right_panel::header(s, full, shown, cx))
            })
            .into_any_element(),
    )
}

/// SidebarTogglePill: 14px panel glyph, orange while the sidebar is pinned open.
fn sidebar_toggle(hidden: bool, cx: &mut Context<Shell>) -> gpui::Stateful<gpui::Div> {
    pill(
        "header-sidebar",
        if hidden { "Show sidebar  ⌘B" } else { "Hide sidebar  ⌘B" },
        true,
    )
    .child(crate::icon::stroke(
        SIDEBAR,
        if hidden {
            theme().text_secondary
        } else {
            crate::theme::brand_orange()
        },
        14.,
        1.8,
    ))
    .on_click(cx.listener(|this, _, window, cx| {
        this.capture(window, cx);
        toggle_sidebar(this, window, cx);
    }))
}

/// Search opens the command palette from the top, as the desktop's does.
fn search_button(cx: &mut Context<Shell>) -> gpui::Stateful<gpui::Div> {
    icon_button("header-search", SEARCH, 16., 1.7, "Search chats  ⌘K", true).on_click(
        cx.listener(|this, _, window, cx| {
            super::super::palette::toggle(this, window, cx);
            cx.notify();
        }),
    )
}

/// The desktop's 26px header icon pill (HeaderIconPill): 7px padding either
/// side of the glyph, transparent at rest, hover fill, 0.35 when disabled.
pub(super) fn pill(id: &'static str, tip: &'static str, enabled: bool) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .h(px(26.))
        .min_w(px(26.))
        .px(px(7.))
        .flex()
        .flex_shrink_0()
        .items_center()
        .justify_center()
        .rounded(px(7.))
        .when(enabled, |button| {
            button.cursor_pointer().hover(|button| button.bg(theme().hover))
        })
        .when(!enabled, |button| button.opacity(0.35))
        .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(tip.into())).into())
}

pub(super) fn icon_button(
    id: &'static str,
    path: &'static str,
    size: f32,
    weight: f32,
    tip: &'static str,
    enabled: bool,
) -> gpui::Stateful<gpui::Div> {
    pill(id, tip, enabled).child(crate::icon::stroke(path, theme().text_secondary, size, weight))
}

pub(super) fn toggle_sidebar(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    s.surfaces.sidebar.hidden = !s.surfaces.sidebar.hidden;
    s.restore_focus(window, cx);
    cx.notify();
}

/// Visits to open tabs in this workspace, newest last (WorkspaceHistoryControls).
#[derive(Default)]
struct Visits {
    scope: Option<String>,
    tabs: Vec<Tab>,
    index: usize,
}

fn record_visit(s: &mut Shell) {
    let scope = s.state.selected.clone();
    let active = s.active();
    let visits = s.features.get::<Visits>();
    if visits.scope != scope {
        *visits = Visits {
            scope,
            ..Default::default()
        };
    }
    let Some(tab) = active else { return };
    if visits.tabs.get(visits.index) == Some(&tab) {
        return;
    }
    let keep = if visits.tabs.is_empty() { 0 } else { visits.index + 1 };
    visits.tabs.truncate(keep);
    visits.tabs.push(tab);
    if visits.tabs.len() > 100 {
        visits.tabs.remove(0);
    }
    visits.index = visits.tabs.len() - 1;
}

/// The nearest earlier (-1) or later (1) visit to a tab that is still open.
fn adjacent(s: &Shell, direction: isize) -> Option<usize> {
    let visits = s.features.read::<Visits>()?;
    let open = &s.current()?.tabs;
    let current = visits.tabs.get(visits.index)?;
    let mut index = visits.index as isize + direction;
    while index >= 0 && (index as usize) < visits.tabs.len() {
        let tab = &visits.tabs[index as usize];
        if tab != current && open.contains(tab) {
            return Some(index as usize);
        }
        index += direction;
    }
    None
}

fn revisit(s: &mut Shell, visit: usize, window: &mut Window, cx: &mut Context<Shell>) {
    let Some(tab) = s.features.read::<Visits>().and_then(|v| v.tabs.get(visit).cloned()) else {
        return;
    };
    let Some(index) = s.current().and_then(|w| w.tabs.iter().position(|t| t == &tab)) else {
        return;
    };
    s.features.get::<Visits>().index = visit;
    select_tab(s, index, window, cx);
}

fn select_tab(s: &mut Shell, index: usize, window: &mut Window, cx: &mut Context<Shell>) {
    for registration in registrations() {
        (registration.after_tab)(s);
    }
    s.state
        .workspaces
        .get_mut(s.state.selected.as_deref().unwrap_or(""))
        .unwrap()
        .active = index;
    s.ensure(window, cx);
    s.restore_focus(window, cx);
    s.persist();
    cx.notify();
}

const SIDEBAR: &str = "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M9 3v18";
const BACK: &str = "M19 12H5m6-6-6 6 6 6";
const FORWARD: &str = "M5 12h14m-6-6 6 6-6 6";
const SEARCH: &str = "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z M16 16l5 5";
const CLOSE: &str = "M6 6l12 12M18 6L6 18";

/// The desktop's single-colour pill glyphs (PillRuntimeGlyph), chosen by label.
fn glyph(tab: &Tab) -> &'static str {
    match tab {
        Tab::Session(_) => {
            "M12 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z M6 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z M18 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z M12 8v4M12 12l-6 4M12 12l6 4"
        }
        _ => match tab.label() {
            "Terminal" => "m4 17 6-6-6-6 M12 19h8",
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
    // The strip scrolls; an 18px fade at its right edge reveals more pills
    // behind it instead of cutting one off (HeaderPillStrip's edge mask).
    let fade = if s.system_glass {
        crate::theme::veil_color(crate::theme::GLASS_VEIL[0].1)
    } else {
        theme().background
    };
    div()
        .relative()
        .flex()
        .flex_1()
        .min_w_0()
        .h_full()
        .items_center()
        .child(strip(s, cx))
        .child(
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .right_0()
                .w(px(18.))
                .bg(gpui::linear_gradient(
                    90.,
                    gpui::linear_color_stop(gpui::Rgba { a: 0., ..fade }, 0.),
                    gpui::linear_color_stop(fade, 1.),
                )),
        )
}

fn strip(s: &Shell, cx: &mut Context<Shell>) -> impl IntoElement {
    let active = s.active();
    let geometry = crate::theme::GEOMETRY;
    div()
        .flex()
        .size_full()
        .min_w_0()
        .items_center()
        .gap(px(2.))
        .pl(px(6.))
        .pr(px(18.))
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
                            select_tab(this, i, window, cx);
                        }))
                }),
        )
}
