//! Test-platform windows and an owned fixture server, never the operator's server.
use super::*;

#[gpui::test]
fn native_context_meter_opens_340px_card_and_restores_keyboard_focus(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    cx.simulate_resize(gpui::size(px(1200.), px(816.)));
    draw(cx);
    let bounds = cx.debug_bounds("composer-context").unwrap();
    assert_eq!(bounds.size.height, px(24.));
    assert!(bounds.size.width >= px(24.));
    surface.update_in(cx, |s, window, cx| {
        s.composer.read(cx).controls.focus["composer-context"].focus(window)
    });
    draw(cx);
    assert!(cx.debug_bounds("context-cache-help").is_some());
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.composer.read(cx).controls.open, Some("context"))
    });
    draw(cx);
    // GPUI's Frame::clear retains debug_bounds, so a selector that was painted
    // earlier cannot prove disappearance. Check current state/focus on close;
    // the first appearance below still proves the popover's painted geometry.
    assert_eq!(
        cx.debug_bounds("context-breakdown").unwrap().size.width,
        px(340.)
    );
    cx.simulate_keystrokes("escape");
    cx.run_until_parked();
    draw(cx);
    surface.update_in(cx, |s, window, cx| {
        assert_eq!(s.composer.read(cx).controls.open, None);
        assert!(s.composer.read(cx).controls.focus["composer-context"].is_focused(window))
    });
    click("composer-context", cx);
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.composer.read(cx).controls.open, Some("context"))
    });
    click("composer-context", cx);
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.composer.read(cx).controls.open, None)
    });
}

#[gpui::test]
fn native_context_meter_uses_only_spare_width_and_preserves_draft_render_isolation(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    for (width, height) in [(900., 700.), (1680., 1050.)] {
        cx.simulate_resize(gpui::size(px(width), px(height)));
        draw(cx);
        let meter = cx.debug_bounds("composer-context").unwrap();
        let model = cx.debug_bounds("composer-model").unwrap();
        let card = cx.debug_bounds("composer-card").unwrap();
        assert_eq!(meter.size.height, px(24.));
        assert!(meter.right() <= model.left());
        assert!(meter.left() >= card.left());
        // Empty composer: the round primary button is the mic.
        assert!(cx.debug_bounds("composer-microphone").unwrap().right() <= card.right());
        assert_eq!(cx.debug_path_count(), 0, "rings must use the icon atlas");
    }
    click("composer-input", cx);
    let renders = surface.read_with(cx, |s, cx| s.regions.renders(cx));
    cx.simulate_keystrokes("a");
    cx.update(|window, cx| window.draw(cx).clear());
    surface.read_with(cx, |s, cx| assert_eq!(s.regions.renders(cx), renders));
    // A cleared route during history loading must settle after measuring the
    // label once, rather than resetting that measurement on every frame.
    surface.update(cx, |s, cx| {
        s.routing = None;
        cx.notify();
    });
    draw(cx);
    let renders = surface.read_with(cx, |s, cx| s.regions.renders(cx));
    cx.update(|window, cx| window.draw(cx).clear());
    surface.read_with(cx, |s, cx| assert_eq!(s.regions.renders(cx), renders));
}
