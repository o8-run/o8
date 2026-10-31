use super::*;
// The rail's More button and its menu (RailMoreMenu.tsx): Projects, Customize,
// Settings and Setup, anchored beside the button. PRs follows it on the rail.
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
    let open = s.features.get::<Menu>().open;
    let active = open || selected(s);
    div()
        .relative()
        .flex_shrink_0()
        .child(
            div()
                .id("rail-more")
                .debug_selector(|| "rail-more".into())
                .size(px(44.))
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
                        cx.new(|_| crate::icon::Tip("Projects, Customize and Settings".into()))
                            .into()
                    })
                })
                .child(crate::icon::stroke(
                    MORE,
                    if active {
                        theme().text
                    } else {
                        theme().text_secondary
                    },
                    19.,
                    2.6,
                ))
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

/// One destination: its glyph, label and, for some, a line under the label.
type Item = (&'static str, &'static str, &'static str, Option<&'static str>, bool, fn() -> Command);

fn items(s: &Shell) -> [Item; 4] {
    [
        ("rail-more-projects", PROJECTS, "Projects", None, s.surfaces.projects.open, || Command::Projects),
        (
            "rail-more-customize",
            CUSTOMIZE,
            "Customize",
            Some("Agent and workspace capabilities"),
            s.surfaces.customize.open,
            || Command::Customize,
        ),
        (
            "rail-more-settings",
            SETTINGS,
            "Settings",
            Some("Appearance and app preferences"),
            s.surfaces.settings.view.is_some(),
            || Command::Settings,
        ),
        (
            "rail-more-setup",
            SETUP,
            "Setup",
            Some("Repositories and agent runtimes"),
            s.surfaces.setup.view.is_some(),
            || Command::Setup,
        ),
    ]
}

/// Opens destination `index`. One destination at a time, as classic's More
/// menu; the open one stays as it is.
fn pick(s: &mut Shell, index: usize, window: &mut Window, cx: &mut Context<Shell>) {
    let (.., current, command) = items(s)[index];
    close(s, cx);
    if !current {
        s.close_rail_overlays(window, cx);
        s.execute(command(), window, cx);
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
    let body = div()
        .p(px(8.))
        .flex()
        .flex_col()
        .children(items(s).into_iter().enumerate().map(
            |(index, (id, glyph, label, description, current, _))| {
                row(id, glyph, label, description, current, active == Some(index)).on_click(
                    cx.listener(move |this, _, window, cx| pick(this, index, window, cx)),
                )
            },
        ));
    div()
        .absolute()
        .left(px(54.))
        .top(px(0.))
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
                    .anchor(gpui::Corner::TopLeft)
                    .snap_to_window_with_margin(px(12.))
                    .child(
                        div()
                            .id("rail-more-menu")
                            .debug_selector(|| "rail-more-menu".into())
                            .occlude()
                            .w(px(206.))
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

// Lucide paths: more-horizontal drawn as three dots, then the menu's glyphs.
const MORE: &str = "M5 12h.01 M12 12h.01 M19 12h.01";
const PROJECTS: &str = "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z";
const CUSTOMIZE: &str = "M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6";
const SETTINGS: &str =
    "M20 7h-9 M14 17H5 M17 14a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M7 4a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z";
const SETUP: &str = "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z";
