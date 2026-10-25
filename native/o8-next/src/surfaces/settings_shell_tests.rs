use super::*;
use crate::shell::test_support::*;
use gpui::TestAppContext;

#[gpui::test]
fn settings_opens_from_shell_command_palette(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("settings-shell.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("s e t t i n g s enter");
    draw(&mut visual);
    assert!(
        visual.debug_bounds("settings-page").is_some(),
        "Settings must be reachable through the real shell command palette"
    );
}
