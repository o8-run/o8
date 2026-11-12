//! GPUI's test platform only; no native window or OS input.
use super::*;

#[gpui::test]
fn pr_status_card_opens_and_dismisses_headlessly(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    surface.update(cx, |s, cx| {
        s.fixture_pr_status(json!({"number":128,"title":"Checks fixture","headSha":"abcdef012345",
            "statusCheckRollup":[{"name":"Unit","conclusion":"failure","url":"https://example.com/unit"}]}));
        cx.notify();
    });
    draw(cx);
    assert!(cx.debug_bounds("composer-pr-pill").is_some());
    click("composer-pr-pill", cx);
    assert!(cx.debug_bounds("composer-pr-card").is_some());
    cx.simulate_keystrokes("escape");
    draw(cx);
    assert!(cx.debug_bounds("composer-pr-card").is_none());
    cx.simulate_keystrokes("enter");
    draw(cx);
    assert!(cx.debug_bounds("composer-pr-card").is_some());
    let outside =
        cx.debug_bounds("conversation-column").unwrap().origin + gpui::point(px(12.), px(12.));
    cx.simulate_click(outside, Modifiers::default());
    draw(cx);
    assert!(cx.debug_bounds("composer-pr-card").is_none());
}
