use super::*;
// The header's Play button (HeaderPlayButton, add a pane). The workspace card
// that sat beside it is now the Activity Dock (activity_dock.rs).
struct HeaderTools;
register_shell_feature!(HeaderTools);
impl ShellFeature for HeaderTools {
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            order: 80,
            dispatch: |s, event, window, cx| {
                let menus = s.features.get::<Menus>();
                if event.keystroke.key == "escape" && menus.play {
                    close(s, window, cx);
                    return KeyResult::Handled;
                }
                KeyResult::Unhandled
            },
        }]
    }
}

#[derive(Default)]
struct Menus {
    play: bool,
    /// When the open menu started its 150ms appearance.
    opened: Option<std::time::Instant>,
}

/// Whether a header card or menu is open (native views hide under it).
pub(super) fn any_open(s: &Shell) -> bool {
    s.features.read::<Menus>().is_some_and(|menus| menus.play)
}

fn close(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    let menus = s.features.get::<Menus>();
    menus.play = false;
    s.restore_focus(window, cx);
    cx.notify();
}

/// Play: opens the add-pane menu (Chat, Terminal).
pub(super) fn play(s: &mut Shell, window: &Window, cx: &mut Context<Shell>) -> impl IntoElement {
    let open = s.features.get::<Menus>().play;
    let appear = appear(s, window);
    div()
        .relative()
        .flex_shrink_0()
        .child(
            super::header::pill("header-play", "Add a pane", true)
                .w(px(30.))
                .when(open, |button| button.bg(theme().hover))
                .child(crate::icon::stroke(PLAY, theme().text_secondary, 14., 1.8))
                .on_click(cx.listener(|this, _, _, cx| {
                    let menus = this.features.get::<Menus>();
                    menus.play = !menus.play;
                    menus.opened = Some(std::time::Instant::now());
                    cx.notify();
                })),
        )
        .when(open, |wrapper| {
            wrapper.child(popover(
                "header-play-menu",
                220.,
                appear,
                div()
                    .py(px(4.))
                    .child(
                        item(
                            "header-play-chat",
                            "Chat",
                            cx,
                            |this, window, cx| match this
                                .workspace_sessions()
                                .first()
                                .map(|s| s.id.clone())
                            {
                                Some(id) => this.execute(Command::Message(id), window, cx),
                                None => this.execute(Command::Setup, window, cx),
                            },
                        )
                        .on_drag(super::RailPane::Chat, drag_out(cx)),
                    )
                    .child(
                        item(
                            "header-play-terminal",
                            "Terminal",
                            cx,
                            |this, window, cx| this.execute(Command::Terminal, window, cx),
                        )
                        .on_drag(super::RailPane::Terminal, drag_out(cx)),
                    )
                    .child(
                        div()
                            .mt(px(4.))
                            .pt(px(7.))
                            .pb(px(5.))
                            .pl(px(12.))
                            .border_t_1()
                            .border_color(theme().border)
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .child("Drag to place on a pane edge"),
                    ),
                cx,
            ))
        })
}

/// HeaderPlayMenuItem's drag: Chat and Terminal leave the menu to land on a
/// pane edge, and the menu closes once they do.
fn drag_out(
    cx: &mut Context<Shell>,
) -> impl Fn(
    &super::RailPane,
    gpui::Point<gpui::Pixels>,
    &mut Window,
    &mut gpui::App,
) -> Entity<super::RailPane>
+ 'static {
    let shell = cx.entity().downgrade();
    move |pane, _, _, cx| {
        let shell = shell.clone();
        cx.defer(move |cx| {
            shell
                .update(cx, |s, cx| {
                    s.features.get::<Menus>().play = false;
                    cx.notify();
                })
                .ok();
        });
        cx.new(|_| pane.clone())
    }
}

/// The open card's 150ms appearance (the desktop overlay's scale-in from its
/// trigger), as opacity and a short drop.
fn appear(s: &Shell, window: &Window) -> f32 {
    let Some(opened) = s.features.read::<Menus>().and_then(|menus| menus.opened) else {
        return 1.;
    };
    let t = opened.elapsed().as_secs_f32() / 0.15;
    if t < 1. {
        window.request_animation_frame();
    }
    crate::motion::ease_out(t.min(1.))
}

/// A floating card under its trigger, right-aligned to it, over a backdrop
/// that closes it when the pointer lands anywhere else.
fn popover(
    id: &'static str,
    width: f32,
    appear: f32,
    child: impl IntoElement,
    cx: &mut Context<Shell>,
) -> impl IntoElement {
    div()
        .absolute()
        .top(px(30.))
        .right(px(0.))
        .child(
            gpui::deferred(
                gpui::anchored()
                    .position(gpui::point(px(0.), px(0.)))
                    .child(
                        div()
                            .id("header-popover-backdrop")
                            .size(gpui::relative(1.))
                            .w(px(100_000.))
                            .h(px(100_000.))
                            .on_mouse_down(
                                gpui::MouseButton::Left,
                                cx.listener(|this, _, window, cx| close(this, window, cx)),
                            ),
                    ),
            )
            .with_priority(1),
        )
        .child(
            gpui::deferred(
                gpui::anchored()
                    .anchor(gpui::Corner::TopRight)
                    .snap_to_window_with_margin(px(8.))
                    .child(
                        div()
                            .id(id)
                            .debug_selector(move || id.into())
                            .occlude()
                            .w(px(width))
                            .opacity(appear)
                            .relative()
                            .top(px(-6. * (1. - appear)))
                            .rounded(px(12.))
                            .bg(crate::theme::popover_background())
                            .border_1()
                            .border_color(theme().border)
                            .shadow_lg()
                            .text_size(px(13.))
                            .text_color(theme().text)
                            .child(child),
                    ),
            )
            .with_priority(2),
        )
}

/// One row of the Play menu.
fn item(
    id: &'static str,
    label: &'static str,
    cx: &mut Context<Shell>,
    run: fn(&mut Shell, &mut Window, &mut Context<Shell>),
) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .mx(px(4.))
        .h(px(30.))
        .px(px(10.))
        .flex()
        .items_center()
        .rounded(px(8.))
        .cursor_pointer()
        .hover(|row| row.bg(theme().hover))
        .child(label)
        .on_click(cx.listener(move |this, _, window, cx| {
            this.capture(window, cx);
            close(this, window, cx);
            run(this, window, cx);
        }))
}

const PLAY: &str = "M7 4.5 20 12 7 19.5Z";
