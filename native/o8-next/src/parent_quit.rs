//! #6532: Quit in a launcher-owned window. With Next off, the launcher owns the
//! window, WS and o8d, and only its bounded shutdown may quit o8. ⌘Q and the app
//! menu's Quit therefore ask that launcher over the window's stdout, a pipe only
//! the parent reads, so another installed instance never receives the request.
//! A server-owned window installs nothing and keeps its behavior.
use gpui::{App, KeyBinding, Menu, MenuItem};
use std::io::Write;

gpui::actions!(
    o8_next,
    [
        /// Quits o8 through the launcher that owns this window.
        QuitThroughLauncher
    ]
);

/// The line the launcher reads (`crates/o8-launcher/src/window.rs`).
const REQUEST: &str = "o8-next-quit";

/// Installs Quit when this launcher, not a server, owns the window.
pub(crate) fn install(cx: &mut App) {
    if std::env::var("O8_NEXT_PARENT_PIPE").as_deref() == Ok("1")
        && std::env::var("O8_NEXT_QUIT_VIA_PARENT").as_deref() == Ok("1")
    {
        install_with(cx, ask_launcher);
    }
}

fn ask_launcher() {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{REQUEST}");
    let _ = out.flush();
}

/// The window stays open and keeps its lifeline; the launcher's shutdown
/// closes it with WS and o8d.
fn install_with(cx: &mut App, ask: fn()) {
    cx.on_action(move |_: &QuitThroughLauncher, _| ask());
    cx.bind_keys([KeyBinding::new("cmd-q", QuitThroughLauncher, None)]);
    cx.set_menus(vec![Menu {
        name: "o8".into(),
        items: vec![MenuItem::action("Quit o8", QuitThroughLauncher)],
    }]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{Context, IntoElement, Render, TestAppContext, Window, div};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static ASKED: AtomicUsize = AtomicUsize::new(0);
    fn record() {
        ASKED.fetch_add(1, Ordering::SeqCst);
    }

    struct Blank;
    impl Render for Blank {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
        }
    }

    #[gpui::test]
    fn cmd_q_and_the_menu_quit_ask_the_launcher_once_each(cx: &mut TestAppContext) {
        cx.update(|cx| install_with(cx, record));
        let (_view, cx) = cx.add_window_view(|_, _| Blank);
        cx.simulate_keystrokes("cmd-q");
        cx.run_until_parked();
        assert_eq!(ASKED.load(Ordering::SeqCst), 1, "⌘Q");
        // The app menu's Quit dispatches the same action.
        cx.dispatch_action(QuitThroughLauncher);
        cx.run_until_parked();
        assert_eq!(ASKED.load(Ordering::SeqCst), 2, "menu Quit");
    }
}
