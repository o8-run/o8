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

#[gpui::test]
fn pr_status_many_checks_fits_zoomed_viewport_and_scrolls(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    surface.update(cx, |s, cx| {
        s.fixture_pr_status(json!({"number":128,"title":"A long pull request title that must leave room for its checks","headSha":"abcdef012345",
            "statusCheckRollup":(0..40).map(|index| json!({"name":format!("Check {index:02} with a long job name"),"conclusion":"failure"})).collect::<Vec<_>>()}));
        cx.notify();
    });
    click("composer-pr-pill", cx);
    cx.simulate_keystrokes("escape enter");
    for (zoom, width, height) in [
        (2., 700., 600.),
        (2., 500., 500.),
        (0.7, 900., 700.),
        (1., 900., 700.),
        (1.5, 750., 600.),
    ] {
        cx.simulate_resize(gpui::size(px(width), px(height)));
        cx.update(|window, cx| window.set_zoom(zoom, cx));
        draw(cx);
        let viewport = cx.update(|window, _| window.viewport_size());
        let card = cx
            .debug_bounds("composer-pr-card")
            .expect("open checks card");
        assert!(
            card.left() >= px(0.)
                && card.top() >= px(0.)
                && card.right() <= viewport.width
                && card.bottom() <= viewport.height,
            "checks card must fit the logical viewport at zoom={zoom}: card={card:?}, viewport={viewport:?}"
        );
        let list = cx
            .debug_bounds("composer-pr-checks")
            .expect("checks scroll area");
        assert!(
            list.size.height > px(0.)
                && (list.left() >= card.left()
                    && list.top() >= card.top()
                    && list.right() <= card.right()
                    && list.bottom() <= card.bottom())
        );
        let scroll = |delta, cx: &mut VisualTestContext| {
            cx.simulate_event(gpui::ScrollWheelEvent {
                position: list.center().map(|v| v * zoom),
                delta: gpui::ScrollDelta::Pixels(gpui::point(px(0.), px(delta))),
                modifiers: Default::default(),
                touch_phase: gpui::TouchPhase::Moved,
            });
            cx.run_until_parked();
            draw(cx);
        };
        scroll(100_000., cx);
        assert!(cx.debug_bounds("composer-pr-check-39").unwrap().bottom() > list.bottom());
        scroll(-100_000., cx);
        let last = cx.debug_bounds("composer-pr-check-39").unwrap();
        assert!(
            (last.left() >= list.left()
                && last.top() >= list.top()
                && last.right() <= list.right()
                && last.bottom() <= list.bottom()),
            "last check must scroll into the card: last={last:?}, list={list:?}"
        );
        assert!(cx.debug_bounds("composer-pr-check-0").unwrap().top() < list.top());
        assert_eq!(
            cx.debug_bounds("composer-pr-card").unwrap(),
            card,
            "scrolling stays inside the card"
        );
    }
}
