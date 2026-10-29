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
    // The desktop workspace header, left to right: sidebar toggle, search,
    // back and forward through visited tabs, the tab pills, then Run.
    record_visit(s);
    let back = adjacent(s, -1);
    let forward = adjacent(s, 1);
    let hidden = s.surfaces.sidebar.hidden;
    Some(
        (div()
            .flex()
            .items_center()
            .flex_shrink_0()
            .gap(px(2.))
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
                icon_button(
                    "header-sidebar",
                    SIDEBAR,
                    16.,
                    1.8,
                    if hidden { "Show sidebar  ⌘B" } else { "Hide sidebar  ⌘B" },
                    true,
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    this.capture(window, cx);
                    toggle_sidebar(this, window, cx);
                })),
            )
            .child(
                icon_button("header-search", SEARCH, 15., 1.8, "Search conversations  ⌘F", true)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.capture(window, cx);
                        this.surfaces.sidebar.hidden = false;
                        if let Some(sidebar) = this.surfaces.sidebar.view.clone() {
                            sidebar.update(cx, |sidebar, cx| sidebar.search(window, cx));
                        }
                        cx.notify();
                    })),
            )
            .child(
                icon_button("header-back", BACK, 15., 1.7, "Back", back.is_some()).when_some(
                    back,
                    |button, visit| {
                        button.on_click(cx.listener(move |this, _, window, cx| {
                            this.capture(window, cx);
                            revisit(this, visit, window, cx);
                        }))
                    },
                ),
            )
            .child(
                icon_button("header-forward", FORWARD, 15., 1.7, "Forward", forward.is_some())
                    .when_some(forward, |button, visit| {
                        button.on_click(cx.listener(move |this, _, window, cx| {
                            this.capture(window, cx);
                            revisit(this, visit, window, cx);
                        }))
                    }),
            )
            .child(div().w(px(4.)).flex_shrink_0())
            .child(tabs(s, cx))
            .child(
                // Opens the workspace orchestrator with its composer focused, as
                // the rail's Run button does.
                icon_button("header-run", PLAY, 15., 1.8, "Run orchestrator", true).on_click(
                    cx.listener(|this, _, window, cx| {
                        this.capture(window, cx);
                        match this.workspace_sessions().first().map(|s| s.id.clone()) {
                            Some(id) => this.execute(Command::Message(id), window, cx),
                            None => this.execute(Command::Setup, window, cx),
                        }
                    }),
                ),
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

/// The desktop's 26px header icon pill (HeaderIconPill).
fn icon_button(
    id: &'static str,
    path: &'static str,
    size: f32,
    weight: f32,
    tip: &'static str,
    enabled: bool,
) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .h(px(26.))
        .min_w(px(26.))
        .px(px(5.))
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
        .child(crate::icon::stroke(path, theme().text_secondary, size, weight))
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

const SIDEBAR: &str = "M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z M9 4v16";
const BACK: &str = "M19 12H5m6-6-6 6 6 6";
const FORWARD: &str = "M5 12h14m-6-6 6 6-6 6";
const PLAY: &str = "M7 4.5v15a.5.5 0 0 0 .77.42l11.5-7.5a.5.5 0 0 0 0-.84L7.77 4.08A.5.5 0 0 0 7 4.5Z";
const SEARCH: &str = "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z M21 21l-4.3-4.3";
const CLOSE: &str = "M6 6l12 12M18 6L6 18";

/// The desktop's single-colour pill glyphs (PillRuntimeGlyph), chosen by label.
fn glyph(tab: &Tab) -> &'static str {
    match tab {
        Tab::Session(_) => {
            "M12 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z M6 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z M18 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z M12 8v4M12 12l-6 4M12 12l6 4"
        }
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
                            select_tab(this, i, window, cx);
                        }))
                }),
        )
}
