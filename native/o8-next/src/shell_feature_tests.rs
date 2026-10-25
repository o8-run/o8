//! Exercise feature contributions through the production shell and route host.
use super::test_support::*;
use super::*;

#[gpui::test]
fn registered_shell_feature_reaches_render_keys_commands_tick_and_observer(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("feature-registry.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    assert!(
        visual.debug_bounds("feature-probe").is_some(),
        "registered render slot must paint through the real shell"
    );
    visual.simulate_keystrokes("alt-u");
    assert_eq!(
        shell.read_with(&visual, |s, _| s.notice.clone()),
        "feature key"
    );
    visual.simulate_keystrokes("ctrl-shift-p");
    visual.simulate_keystrokes("f e a t u r e enter");
    assert_eq!(
        shell.read_with(&visual, |s, _| s.notice.clone()),
        "feature command"
    );
    visual.update(|window, cx| shell.update(cx, |s, cx| s.tick(true, window, cx)));
    assert_eq!(
        shell.read_with(&visual, |s, _| s.notice.clone()),
        "feature tick"
    );
    visual.simulate_resize(size(px(910.), px(710.)));
    draw(&mut visual);
    assert_eq!(
        shell.read_with(&visual, |s, _| s.notice.clone()),
        "feature observer"
    );
    assert!(visual.simulate_close());
    let saved = State::load(&fixture.root.join("feature-registry.json")).unwrap();
    assert_eq!(saved.bounds[2..], [910., 710.]);
}
