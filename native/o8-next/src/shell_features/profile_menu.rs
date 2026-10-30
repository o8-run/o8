use super::*;
// The rail's profile button and its quick settings menu (SettingsQuickDrawer.tsx):
// Account, Settings, Appearance and Get help, anchored beside the button.
struct ProfileMenu;
register_shell_feature!(ProfileMenu);
impl ShellFeature for ProfileMenu {
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            order: 10,
            dispatch: |s, event, window, cx| {
                if event.keystroke.key == "escape"
                    && s.features.read::<Menu>().is_some_and(|menu| menu.open)
                {
                    close(s, cx);
                    s.restore_focus(window, cx);
                    return KeyResult::Handled;
                }
                KeyResult::Unhandled
            },
        }]
    }
    fn rail(&self) -> &'static [RailItem] {
        &[RailItem {
            order: 20,
            render: |s, window, cx| Some(button(s, window, cx)),
        }]
    }
}

const DOCS_URL: &str = "https://o8.run";
const DISCORD_URL: &str = "https://o8.run/discord";

#[derive(Default)]
struct Menu {
    open: bool,
    appearance: bool,
    help: bool,
}

fn close(s: &mut Shell, cx: &mut Context<Shell>) {
    let menu = s.features.get::<Menu>();
    menu.open = false;
    menu.appearance = false;
    menu.help = false;
    cx.notify();
}

fn button(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) -> gpui::AnyElement {
    let open = s.features.get::<Menu>().open;
    let viewport = window.viewport_size();
    div()
        .relative()
        .flex_shrink_0()
        .child(
            div()
                .id("shell-profile")
                .debug_selector(|| "shell-profile".into())
                .size(px(44.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(10.))
                .cursor_pointer()
                .when(open, |button| button.bg(theme().hover))
                .hover(|button| button.bg(theme().hover))
                // The tooltip would sit over the open menu.
                .when(!open, |button| {
                    button.tooltip(|_, cx| {
                        cx.new(|_| crate::icon::Tip("Account and settings".into()))
                            .into()
                    })
                })
                .child(crate::icon::stroke(
                    ACCOUNT,
                    if open {
                        theme().text
                    } else {
                        theme().text_secondary
                    },
                    19.,
                    1.8,
                ))
                .on_click(cx.listener(|this, _, window, cx| {
                    let menu = this.features.get::<Menu>();
                    if menu.open {
                        close(this, cx);
                    } else {
                        menu.open = true;
                        this.capture(window, cx);
                        cx.notify();
                    }
                })),
        )
        .when(open, |anchor| {
            anchor.child(menu(s, f32::from(viewport.width), cx))
        })
        .into_any_element()
}

/// One menu row: a framed glyph, the label, and a trailing hint.
fn row(
    id: &'static str,
    glyph: &'static str,
    label: &'static str,
    trailing: impl IntoElement,
) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .w_full()
        .min_h(px(30.))
        .px(px(7.))
        .flex()
        .items_center()
        .gap(px(8.))
        .rounded(px(9.))
        .cursor_pointer()
        .hover(|row| row.bg(theme().hover))
        .child(
            div()
                .size(px(17.))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .bg(theme().surface_raised)
                .child(crate::icon::stroke(glyph, theme().text_muted, 13., 1.8)),
        )
        .child(
            div()
                .flex_1()
                .text_size(px(13.5))
                .font_weight(gpui::FontWeight::LIGHT)
                .text_color(theme().text)
                .child(label),
        )
        .child(trailing)
}

fn shortcut(keys: &'static str) -> gpui::Div {
    div()
        .font_family(theme().font_mono)
        .text_size(px(10.))
        .text_color(theme().text_faint)
        .child(keys)
}

fn chevron(open: bool) -> impl IntoElement {
    crate::icon::stroke(
        if open { CHEVRON_DOWN } else { CHEVRON_RIGHT },
        theme().text_muted,
        12.,
        1.8,
    )
}

fn separator() -> gpui::Div {
    div().h(px(1.)).w_full().bg(theme().border)
}

fn menu(s: &mut Shell, viewport_width: f32, cx: &mut Context<Shell>) -> gpui::AnyElement {
    let menu = s.features.get::<Menu>();
    let (appearance, help) = (menu.appearance, menu.help);
    let current = crate::theme::appearance_name();
    let width = (viewport_width - 24.).clamp(246., 280.);
    let modes = [
        ("profile-appearance-light", "Light", "light"),
        ("profile-appearance-dark", "Dark", "dark"),
        ("profile-appearance-glass", "All Glass", "glass"),
    ];
    let body = div()
        .p(px(7.))
        .flex()
        .flex_col()
        .gap(px(4.))
        .child(
            row("profile-account", ACCOUNT, "Account", chevron(false)).on_click(cx.listener(
                |this, _, window, cx| {
                    close(this, cx);
                    this.execute(Command::Settings, window, cx);
                },
            )),
        )
        .child(separator())
        .child(
            row("profile-settings", SETTINGS, "Settings", shortcut("⌘,")).on_click(cx.listener(
                |this, _, window, cx| {
                    close(this, cx);
                    this.execute(Command::Settings, window, cx);
                },
            )),
        )
        .child(
            row(
                "profile-appearance",
                CONTRAST,
                "Appearance",
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .child(
                        div()
                            .text_size(px(10.))
                            .text_color(theme().text_muted)
                            .child(match current {
                                "glass" => "All Glass",
                                "light" => "Light Solid",
                                _ => "Dark Solid",
                            }),
                    )
                    .child(chevron(appearance)),
            )
            .on_click(cx.listener(|this, _, _, cx| {
                let menu = this.features.get::<Menu>();
                menu.appearance = !menu.appearance;
                cx.notify();
            })),
        )
        .when(appearance, |body| {
            body.child(
                div()
                    .pl(px(25.))
                    .pr(px(4.))
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .children(modes.into_iter().map(|(id, label, mode)| {
                        let selected = mode == current;
                        div()
                            .id(id)
                            .debug_selector(move || id.into())
                            .min_h(px(30.))
                            .pl(px(10.))
                            .pr(px(8.))
                            .flex()
                            .items_center()
                            .justify_between()
                            .rounded(px(8.))
                            .text_size(px(12.))
                            .text_color(theme().text)
                            .cursor_pointer()
                            .when(selected, |option| option.bg(theme().hover))
                            .hover(|option| option.bg(theme().hover))
                            .child(label)
                            .when(selected, |option| {
                                option.child(crate::icon::stroke(CHECK, theme().accent, 13., 2.))
                            })
                            .on_click(cx.listener(move |this, _, window, cx| {
                                close(this, cx);
                                this.set_appearance(mode, window, cx);
                            }))
                    })),
            )
        })
        .child(separator())
        .child(
            row("profile-help", BOOK, "Get help", chevron(help)).on_click(cx.listener(
                |this, _, _, cx| {
                    let menu = this.features.get::<Menu>();
                    menu.help = !menu.help;
                    cx.notify();
                },
            )),
        )
        .when(help, |body| {
            body.child(
                div()
                    .pl(px(28.))
                    .pr(px(4.))
                    .pb(px(3.))
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(
                        row(
                            "profile-shortcuts",
                            HELP,
                            "Keyboard shortcuts",
                            shortcut("⌘/"),
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            close(this, cx);
                            this.execute(Command::ShortcutReference, window, cx);
                        })),
                    )
                    .child(
                        row(
                            "profile-discord",
                            MESSAGE,
                            "Community Discord",
                            crate::icon::stroke(EXTERNAL, theme().text_faint, 11., 1.8),
                        )
                        .on_click(cx.listener(|_, _, _, cx| cx.open_url(DISCORD_URL))),
                    )
                    .child(
                        row(
                            "profile-docs",
                            GLOBE,
                            "Documentation",
                            crate::icon::stroke(EXTERNAL, theme().text_faint, 11., 1.8),
                        )
                        .on_click(cx.listener(|_, _, _, cx| cx.open_url(DOCS_URL))),
                    ),
            )
        });
    // SettingsQuickDrawer opens 8 px above the button, left-aligned to it.
    div()
        .absolute()
        .left(px(0.))
        .top(px(-8.))
        .child(
            gpui::deferred(
                gpui::anchored()
                    .position(gpui::point(px(0.), px(0.)))
                    .child(
                        div()
                            .id("profile-menu-backdrop")
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
                    .anchor(gpui::Corner::BottomLeft)
                    .snap_to_window_with_margin(px(12.))
                    .child(
                        div()
                            .id("profile-menu")
                            .debug_selector(|| "profile-menu".into())
                            .occlude()
                            .w(px(width))
                            .max_h(px(340.))
                            .overflow_y_scroll()
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

// Lucide paths, as the desktop menu draws them.
const ACCOUNT: &str = "M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20Z M12 7a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662";
const SETTINGS: &str =
    "M20 7h-9 M14 17H5 M17 14a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M7 4a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z";
const CONTRAST: &str = "M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20Z M12 18a6 6 0 0 0 0-12v12z";
const BOOK: &str = "M12 7v14 M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z";
const HELP: &str =
    "M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20Z M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3 M12 17h.01";
const MESSAGE: &str = "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z";
const GLOBE: &str = "M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20Z M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20 M2 12h20";
const EXTERNAL: &str =
    "M15 3h6v6 M10 14 21 3 M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6";
const CHEVRON_RIGHT: &str = "m9 18 6-6-6-6";
const CHEVRON_DOWN: &str = "m6 9 6 6 6-6";
const CHECK: &str = "m5 12 4 4L19 6";

impl Shell {
    /// Light, Dark or All Glass, switched in place: the window's material
    /// follows, every view repaints, and the choice is kept for next launch.
    pub(crate) fn set_appearance(
        &mut self,
        mode: &str,
        window: &mut Window,
        cx: &mut Context<Shell>,
    ) {
        if crate::theme::set_appearance(mode) {
            self.system_glass = crate::shell::material::switch(window, self.offscreen);
            window.refresh();
        }
        cx.notify();
    }
}
