use super::*;

#[gpui::test]
fn brain_dock_returns_focus_and_keeps_each_session_draft(cx: &mut TestAppContext) {
    let (_server, client) = fixture();
    let saved = client.clone();
    let (surface, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    surface.update(cx, |s, cx| {
        s.sessions = saved.sessions().unwrap();
        s.select("thoughts-composer-first".into(), cx);
    });
    cx.run_until_parked();
    let open = cx.debug_bounds("open-brain").unwrap();
    cx.simulate_click(open.center(), gpui::Modifiers::default());
    cx.simulate_input("first Brain draft");
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    cx.simulate_input(" after resize");
    let first = surface.read_with(cx, |s, _| s.brains["thoughts-composer-first"].clone());
    first.read_with(cx, |b, cx| {
        assert_eq!(b.composer.read(cx).text, "first Brain draft after resize")
    });
    cx.simulate_keystrokes("escape");
    cx.run_until_parked();
    assert!(!first.read_with(cx, |b, _| b.expanded));
    surface.update_in(cx, |s, window, cx| {
        assert!(
            s.composer.read(cx).focus.is_focused(window),
            "minimizing Brain returns focus to its launching composer"
        )
    });
    let second_row = cx.debug_bounds("session-thoughts-composer-second").unwrap();
    cx.simulate_click(second_row.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    cx.simulate_keystrokes("ctrl-e");
    cx.simulate_input("second Brain draft");
    let second = surface.read_with(cx, |s, _| s.brains["thoughts-composer-second"].clone());
    assert_ne!(first.entity_id(), second.entity_id());
    second.read_with(cx, |b, cx| {
        assert_eq!(b.composer.read(cx).text, "second Brain draft")
    });
    let first_row = cx.debug_bounds("session-thoughts-composer-first").unwrap();
    cx.simulate_click(first_row.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    cx.simulate_keystrokes("ctrl-e");
    first.read_with(cx, |b, cx| {
        assert_eq!(b.composer.read(cx).text, "first Brain draft after resize")
    });
}
