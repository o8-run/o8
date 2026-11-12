// Zoom through the real shell: its key handler, palette command, Settings
// buttons and launch apply all run inside a Shell update, while the window's
// bounds observers update the Shell too (window_state). Applying a zoom must
// not re-enter the Shell ("cannot update Shell while it is already being
// updated", the first Cmd+= in a real window).
use super::*;
use crate::shell::test_support::*;
use crate::shell_state::State as ShellState;
struct ZoomTests;
register_shell_feature!(ZoomTests);
impl ShellFeature for ZoomTests {}

fn zoom(cx: &mut VisualTestContext) -> (f32, f32, u16) {
    cx.update(|window, _| {
        (
            window.zoom(),
            window.scale_factor(),
            crate::theme::zoom_percent(),
        )
    })
}
fn settle(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    for _ in 0..5 {
        cx.run_until_parked();
        shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
        draw(cx);
    }
}
/// Clicks a Settings control where the platform reports it: unzoomed window
/// points. The page scrolls (by platform wheel deltas) until it is visible.
fn click(shell: &Entity<Shell>, cx: &mut VisualTestContext, id: &'static str) {
    let zoom = cx.update(|window, _| window.zoom());
    let mut visible = None;
    for _ in 0..10 {
        draw(cx);
        let bounds = cx
            .debug_bounds(id)
            .unwrap_or_else(|| panic!("missing {id}"));
        let page = cx.debug_bounds("settings-scroll");
        if id.starts_with("settings-nav") || page.is_none_or(|p| p.contains(&bounds.center())) {
            visible = Some(bounds);
            break;
        }
        cx.simulate_event(gpui::ScrollWheelEvent {
            position: page.unwrap().center().map(|v| v * zoom),
            delta: gpui::ScrollDelta::Pixels(gpui::point(gpui::px(0.), gpui::px(-200.))),
            ..Default::default()
        });
    }
    let bounds = visible.unwrap_or_else(|| panic!("{id} never scrolled into the visible page"));
    cx.simulate_click(bounds.center().map(|v| v * zoom), gpui::Modifiers::default());
    settle(shell, cx);
}

#[gpui::test]
fn zoom_key_palette_settings_and_launch_apply_through_the_shell(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = fixture.root.join("zoom.json");
    let (shell, mut visual) =
        open_past_setup(fixture.client.clone(), file.clone(), ShellState::default(), cx);
    let cx = &mut visual;
    ready(&shell, cx);
    let (_, base, _) = zoom(cx);
    assert_eq!(zoom(cx), (1., base, 100));

    // Settings › Appearance: minus, Reset and plus, each clicked at its
    // zoomed place.
    shell.update_in(cx, |s, window, cx| s.execute(Command::Settings, window, cx));
    settle(&shell, cx);
    click(&shell, cx, "settings-nav-appearance");
    click(&shell, cx, "setting-zoom-in");
    assert_eq!(zoom(cx), (1.1, base * 1.1, 110));
    click(&shell, cx, "setting-zoom-out");
    assert_eq!(zoom(cx).2, 100);
    click(&shell, cx, "setting-zoom-in");
    click(&shell, cx, "setting-zoom-reset");
    assert_eq!(zoom(cx), (1., base, 100));

    // The primary modifier with =, + and -, through the shell's key handler.
    cx.simulate_keystrokes("secondary-=");
    settle(&shell, cx);
    assert_eq!(zoom(cx), (1.1, base * 1.1, 110));
    cx.simulate_keystrokes("secondary-shift-=");
    settle(&shell, cx);
    assert_eq!(zoom(cx).2, 120);
    cx.simulate_keystrokes("secondary--");
    settle(&shell, cx);
    assert_eq!(zoom(cx).2, 110);

    // The palette's command.
    shell.update_in(cx, |s, window, cx| {
        s.execute(Command::Feature(&super::zoom::ZOOM_IN), window, cx)
    });
    settle(&shell, cx);
    assert_eq!(zoom(cx).2, 120);

    // A window opened at a saved zoom applies it at launch.
    let (shell_two, mut second) =
        open_past_setup(fixture.client.clone(), file, ShellState::default(), &mut cx.cx);
    ready(&shell_two, &mut second);
    assert_eq!(zoom(&mut second), (1.2, base * 1.2, 120));
    cx.simulate_keystrokes("secondary-0");
    settle(&shell, cx);
    assert_eq!(zoom(cx), (1., base, 100));
}
