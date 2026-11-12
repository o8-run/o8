use super::*;
use crate::shell::test_support::{Fixture, TestAppContext, VisualTestContext, draw};
use std::time::{Duration, Instant};

fn settle(view: &Entity<View>, cx: &mut VisualTestContext) {
    let until = Instant::now() + Duration::from_secs(15);
    loop {
        cx.run_until_parked();
        draw(cx);
        if !view.read_with(cx, |view, _| view.loading) {
            return;
        }
        assert!(Instant::now() < until, "scorecard did not settle");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn click(cx: &mut VisualTestContext, selector: &'static str) {
    draw(cx);
    let bounds = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("missing {selector}"));
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
}
#[gpui::test]
fn scorecard_range_and_each_figure_from_durable_fixture(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--scorecard");
    let (view, cx) = cx.add_window_view(|_, cx| Scorecard::new(f.client.clone(), cx));
    cx.simulate_resize(size(px(440.), px(700.)));
    settle(&view, cx);
    assert!(cx.debug_bounds("review-scorecard").is_some());
    view.read_with(cx, |view, _| {
        let data = view
            .snapshot
            .as_ref()
            .expect("production analytics response");
        assert_eq!(
            data.metrics
                .iter()
                .find(|m| m.id == "without-person")
                .unwrap()
                .display,
            "1 / 1 (100%)"
        );
        assert_eq!(
            data.metrics
                .iter()
                .find(|m| m.id == "findings")
                .unwrap()
                .display,
            "0"
        );
    });
    click(cx, "scorecard-range-30");
    settle(&view, cx);
    view.read_with(cx, |view, _| {
        let data = view.snapshot.as_ref().unwrap();
        for (id, expected) in [
            ("without-person", "1 / 2 (50%)"),
            ("needed-person", "0"),
            ("reason-approval", "0"),
            ("reason-rejected-twice", "0"),
            ("reason-gate", "0"),
            ("reason-start", "0"),
            ("reason-held", "0"),
            ("findings", "3"),
            ("severity-bug", "1"),
            ("severity-rule_violation", "1"),
            ("severity-note", "1"),
            ("finding-fixed", "1"),
            ("finding-author-fixed", "—"),
            ("finding-waived", "1"),
            ("finding-open", "1"),
            ("corrections", "0"),
            ("rounds", "1.5"),
            ("second-look", "1"),
            ("arrival-verdict", "1.5 min"),
            ("verdict-merge", "1.5 min"),
            ("learned", "—"),
        ] {
            assert_eq!(
                data.metrics.iter().find(|m| m.id == id).unwrap().display,
                expected,
                "{id}"
            );
        }
    });
    click(cx, "scorecard-metric-without-person");
    draw(cx);
    assert!(cx.debug_bounds("scorecard-drilldown").is_some());
    assert!(
        cx.debug_bounds("scorecard-change-scorecard-clean")
            .is_some()
    );
    click(cx, "scorecard-source-external");
    settle(&view, cx);
    click(cx, "scorecard-metric-without-person");
    draw(cx);
    assert!(cx.debug_bounds("scorecard-empty").is_some());
    click(cx, "scorecard-range-all");
    settle(&view, cx);
    assert_eq!(view.read_with(cx, |view, _| view.range), "all");
}
