use super::*;
// The dock's Tools button and its drawer: every destination the old rail held
// (new chat, terminal, scheduled, plugins) plus RailMoreMenu.tsx's Projects,
// Customize, Settings and Setup, opening upward from the end of the dock.
struct RailMore;
register_shell_feature!(RailMore);
impl ShellFeature for RailMore {
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            order: 10,
            dispatch: |s, event, window, cx| {
                if !s.features.read::<Menu>().is_some_and(|menu| menu.open) {
                    return KeyResult::Unhandled;
                }
                // RailMoreMenu's keys: arrows wrap, Home and End jump, Enter picks.
                let last = items(s).len() - 1;
                let menu = s.features.get::<Menu>();
                menu.keyed = true;
                match event.keystroke.key.as_str() {
                    "escape" => {
                        close(s, cx);
                        s.restore_focus(window, cx);
                    }
                    "down" => menu.active = if menu.active == last { 0 } else { menu.active + 1 },
                    "up" => menu.active = if menu.active == 0 { last } else { menu.active - 1 },
                    "home" => menu.active = 0,
                    "end" => menu.active = last,
                    "enter" | "space" => {
                        let index = menu.active;
                        pick(s, index, window, cx);
                    }
                    _ => return KeyResult::Unhandled,
                }
                cx.notify();
                KeyResult::Handled
            },
        }]
    }
}

/// Below this sidebar width the dock drops the update button; the Tools
/// drawer has it (Q 2026-11-09).
pub(crate) const COMPACT_BELOW: f32 = 240.;

/// The dock's width this frame, set by the dock before its items render.
#[derive(Default)]
pub(crate) struct Dock {
    pub(crate) width: f32,
}

pub(crate) fn compact(s: &Shell) -> bool {
    s.features.read::<Dock>().is_some_and(|dock| dock.width < COMPACT_BELOW)
}

#[derive(Default)]
struct Menu {
    open: bool,
    /// The row the keyboard is on, ringed once a key has moved it.
    active: usize,
    keyed: bool,
}

fn close(s: &mut Shell, cx: &mut Context<Shell>) {
    s.features.get::<Menu>().open = false;
    cx.notify();
}

/// Projects, Customize, Settings or Setup, whichever is open, marks the button.
fn selected(s: &Shell) -> bool {
    s.surfaces.projects.open
        || s.surfaces.customize.open
        || s.surfaces.settings.view.is_some()
        || s.surfaces.setup.view.is_some()
}

pub(crate) fn button(s: &mut Shell, cx: &mut Context<Shell>) -> gpui::AnyElement {
    // In a narrow dock the update button lives in the drawer; a dot says it is ready.
    let dot = compact(s) && super::update::ready(s);
    let open = s.features.get::<Menu>().open;
    let active = open || selected(s);
    div()
        .relative()
        .flex_shrink_0()
        .child(
            div()
                .id("rail-more")
                .debug_selector(|| "rail-more".into())
                .size(px(super::super::rail::TARGET))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(10.))
                .cursor_pointer()
                .when(active, |button| button.bg(theme().hover))
                .hover(|button| button.bg(theme().hover))
                // The tooltip would sit over the open menu.
                .when(!open, |button| {
                    button.tooltip(|_, cx| {
                        cx.new(|_| crate::icon::Tip("Tools".into()))
                            .into()
                    })
                })
                .child(crate::icon::stroke(
                    GRID,
                    if active {
                        theme().text
                    } else {
                        theme().text_secondary
                    },
                    17.,
                    1.8,
                ))
                .when(dot, |button| {
                    button.relative().child(
                        div()
                            .absolute()
                            .top(px(5.))
                            .right(px(5.))
                            .size(px(6.))
                            .rounded_full()
                            .bg(crate::theme::update_ready()),
                    )
                })
                .on_click(cx.listener(|this, _, window, cx| {
                    let menu = this.features.get::<Menu>();
                    if menu.open {
                        close(this, cx);
                    } else {
                        // The open destination takes focus, else the first.
                        let current = items(this).iter().position(|item| item.4).unwrap_or(0);
                        let menu = this.features.get::<Menu>();
                        menu.open = true;
                        menu.active = current;
                        menu.keyed = false;
                        this.capture(window, cx);
                        cx.notify();
                    }
                })),
        )
        .when(open, |anchor| anchor.child(menu(s, cx)))
        .into_any_element()
}

/// What a drawer row does when picked.
type Action = fn(&mut Shell, &mut Window, &mut Context<Shell>);

/// One destination: its glyph, label, a line under the label for some, whether
/// it is the open one, whether it is an overlay a second pick closes, and its action.
type Item = (&'static str, &'static str, &'static str, Option<&'static str>, bool, bool, Action);

fn run(command: Command, s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    s.capture(window, cx);
    s.execute(command, window, cx);
}

fn items(s: &Shell) -> Vec<Item> {
    use super::super::rail::Icon;
    let active = s.active();
    let mut items: Vec<Item> = vec![
        ("rail-more-chat", Icon::Play.path(), "New chat", Some("Start a chat on the lead"), false, false, |s, w, cx| {
            s.capture(w, cx);
            super::start_chat(s, w, cx);
        }),
        ("rail-more-terminal", Icon::Terminal.path(), "Terminal", None, active == Some(Tab::Terminal), false, |s, w, cx| run(Command::Terminal, s, w, cx)),
        ("rail-more-scheduled", Icon::Clock.path(), "Scheduled", None, active == Some(Tab::Scheduled), false, |s, w, cx| run(Command::Scheduled, s, w, cx)),
        ("rail-more-plugins", Icon::Puzzle.path(), "Plugins", None, false, false, |s, w, cx| s.show_customize_tab("plugins", w, cx)),
        ("rail-more-projects", PROJECTS, "Projects", None, s.surfaces.projects.open, true, |s, w, cx| run(Command::Projects, s, w, cx)),
        (
            "rail-more-customize",
            CUSTOMIZE,
            "Customize",
            Some("Agent and workspace capabilities"),
            s.surfaces.customize.open,
            true,
            |s, w, cx| run(Command::Customize, s, w, cx),
        ),
        (
            "rail-more-settings",
            SETTINGS,
            "Settings",
            Some("Appearance and app preferences"),
            s.surfaces.settings.view.is_some(),
            true,
            |s, w, cx| run(Command::Settings, s, w, cx),
        ),
        (
            "rail-more-setup",
            SETUP,
            "Setup",
            Some("Repositories and agent runtimes"),
            s.surfaces.setup.view.is_some(),
            true,
            |s, w, cx| run(Command::Setup, s, w, cx),
        ),
    ];
    if compact(s) {
        let ready = super::update::ready(s);
        items.push((
            "rail-more-updates",
            UPDATES,
            "Updates",
            Some(if ready { "An update is ready to install" } else { "Check for updates" }),
            false,
            false,
            |s, _, cx| super::update::open(s, cx),
        ));
    }
    items
}

/// Opens destination `index`, one at a time. Picking the open overlay again
/// closes it, which is how the workspace comes back now that Home is gone.
fn pick(s: &mut Shell, index: usize, window: &mut Window, cx: &mut Context<Shell>) {
    let Some(&(.., current, overlay, action)) = items(s).get(index) else {
        return;
    };
    close(s, cx);
    s.close_rail_overlays(window, cx);
    if current && overlay {
        s.restore_focus(window, cx);
        cx.notify();
    } else if !current {
        action(s, window, cx);
    }
}

fn row(
    id: &'static str,
    glyph: &'static str,
    label: &'static str,
    description: Option<&'static str>,
    current: bool,
    focused: bool,
) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .w_full()
        .min_h(px(36.))
        .px(px(10.))
        .py(px(6.))
        .flex()
        .items_center()
        .gap(px(10.))
        .rounded(px(6.))
        .cursor_pointer()
        .when(current, |row| row.bg(theme().hover))
        // The keyboard's row wears a focus ring, as a focused button does.
        .border_1()
        .border_color(if focused { theme().accent } else { gpui::transparent_black().into() })
        .hover(|row| row.bg(theme().hover))
        .child(crate::icon::stroke(glyph, theme().text_secondary, 16., 1.7))
        .child(
            div()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(3.))
                .font_weight(gpui::FontWeight::LIGHT)
                .child(div().text_size(px(12.)).text_color(theme().text).child(label))
                .children(description.map(|text| {
                    div()
                        .text_size(px(10.5))
                        .text_color(theme().text_muted)
                        .child(text)
                })),
        )
}

fn menu(s: &mut Shell, cx: &mut Context<Shell>) -> gpui::AnyElement {
    let menu = s.features.get::<Menu>();
    let active = menu.keyed.then_some(menu.active);
    // New chat and Terminal still drag onto the workspace, as they did from the
    // rail; the drawer closes as the drag starts.
    let shell = cx.weak_entity();
    let draggable = move |row: gpui::Stateful<gpui::Div>, pane: super::RailPane| {
        let shell = shell.clone();
        row.on_drag(pane, move |drag: &super::RailPane, _, _, cx: &mut gpui::App| {
            let _ = shell.update(cx, |s, cx| close(s, cx));
            cx.new(|_| drag.clone())
        })
    };
    let body = div()
        .p(px(8.))
        .flex()
        .flex_col()
        .children(items(s).into_iter().enumerate().map(
            |(index, (id, glyph, label, description, current, ..))| {
                let row = row(id, glyph, label, description, current, active == Some(index)).on_click(
                    cx.listener(move |this, _, window, cx| pick(this, index, window, cx)),
                );
                match id {
                    "rail-more-chat" => draggable(row, super::RailPane::Chat),
                    "rail-more-terminal" => draggable(row, super::RailPane::Terminal),
                    _ => row,
                }
            },
        ));
    // The drawer opens 8 px above the dock, right-aligned to the Tools button.
    div()
        .absolute()
        .right(px(0.))
        .top(px(-8.))
        .child(
            gpui::deferred(
                gpui::anchored()
                    .position(gpui::point(px(0.), px(0.)))
                    .child(
                        div()
                            .id("rail-more-backdrop")
                            .w(px(100_000.))
                            .h(px(100_000.))
                            .on_mouse_down(
                                gpui::MouseButton::Left,
                                cx.listener(|this, _, _, cx| close(this, cx)),
                            ),
                    ),
            )
            .with_priority(1),
        )
        .child(
            gpui::deferred(
                gpui::anchored()
                    .anchor(gpui::Corner::BottomRight)
                    .snap_to_window_with_margin(px(12.))
                    .child(
                        div()
                            .id("rail-more-menu")
                            .debug_selector(|| "rail-more-menu".into())
                            .occlude()
                            .w(px(240.))
                            .rounded(px(12.))
                            .bg(crate::theme::popover_background())
                            .border_1()
                            .border_color(theme().border)
                            .shadow_lg()
                            .child(body),
                    ),
            )
            .with_priority(2),
        )
        .into_any_element()
}

// Lucide paths: layout-grid for the Tools button, then the drawer's glyphs.
const UPDATES: &str = "M12 15V3 M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5";
const GRID: &str = "M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z";
const PROJECTS: &str = "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z";
const CUSTOMIZE: &str = "M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6";
const SETTINGS: &str =
    "M20 7h-9 M14 17H5 M17 14a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M7 4a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z";
const SETUP: &str = "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z";
