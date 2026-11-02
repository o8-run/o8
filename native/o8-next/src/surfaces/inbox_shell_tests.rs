use super::*;
use crate::shell::test_support::*;
use gpui::TestAppContext;

#[gpui::test]
fn inbox_is_reachable_from_the_real_shell_palette(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("inbox.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    let main = shell.read_with(cx, |s, _| s.active());
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("i n b o x");
    assert_eq!(
        shell.read_with(cx, |s, _| s
            .commands()
            .iter()
            .map(|c| c.label(&s.sessions))
            .collect::<Vec<_>>()),
        vec!["Open Inbox"],
        "Inbox must be a native surface reachable through the production command palette"
    );
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    draw(cx);
    inbox_panel(&shell, cx);
    assert_eq!(
        shell.read_with(cx, |s, _| s.active()),
        main,
        "Inbox must keep the main surface open beside it"
    );
    assert!(cx.debug_bounds("inbox-view-replies").is_some());
}
