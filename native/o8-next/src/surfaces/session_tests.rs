use super::*;
use crate::shell::test_support::*;
use gpui::TestAppContext;

#[gpui::test]
fn shell_retains_sidebar_selection_and_view_identity(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = fixture.root.join("selected.json");
    let (shell, cx) = cx.add_window_view(|window, cx| {
        Shell::new(
            fixture.client.clone(),
            file.clone(),
            State::default(),
            window,
            cx,
        )
    });
    ready(&shell, cx);
    let before = shell.read_with(cx, |s, _| {
        match s.content.get(&s.key(&s.active().unwrap())).unwrap() {
            Content::Session(session) => session.entity_id(),
            _ => panic!("session"),
        }
    });
    cx.simulate_keystrokes("down");
    cx.run_until_parked();
    shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
    ready(&shell, cx);
    let after = shell.read_with(cx, |s, _| {
        match s.content.get(&s.key(&s.active().unwrap())).unwrap() {
            Content::Session(session) => session.entity_id(),
            _ => panic!("session"),
        }
    });
    assert_eq!(
        before, after,
        "changing the session in the sidebar must retain the existing Surface and its drafts"
    );
}
