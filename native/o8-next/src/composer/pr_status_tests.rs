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
fn pr_status_resolve_prepares_thread_composer_without_losing_draft(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    surface.update(cx, |s, cx| {
        s.fixture_pr_status(
            json!({"number":128,"title":"Conflicts fixture","headSha":"abcdef012345",
            "state":"open","mergeable":false,"baseRefName":"main","conflictingFiles":["src/a.rs"]}),
        );
        s.composer
            .update(cx, |input, cx| input.set_text("Keep my draft", cx));
        cx.notify();
    });
    click("composer-pr-pill", cx);
    cx.simulate_keystrokes("escape");
    cx.simulate_keystrokes("enter");
    draw(cx);
    click("composer-pr-resolve", cx);
    surface.read_with(cx, |s, cx| {
        assert!(
            s.composer
                .read(cx)
                .text
                .starts_with("Keep my draft\n\nMerge main")
        );
        assert!(s.composer.read(cx).text.contains("PR #128"));
    });
    assert!(cx.debug_bounds("composer-pr-card").is_none());
}
