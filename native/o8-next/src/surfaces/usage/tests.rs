use super::format::{count, money};
use super::*;
use crate::shell::test_support::{Fixture, TestAppContext, draw};
use std::time::{Duration, Instant};

fn settle(view: &Entity<View>, cx: &mut gpui::VisualTestContext) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        draw(cx);
        if !view.read_with(cx, |view, _| view.loading) {
            return;
        }
        assert!(Instant::now() < deadline, "Usage never settled");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn money_and_counts_read_like_classic() {
    assert_eq!(money(1234.5), "$1,234.50");
    assert_eq!(count(1_500_000.), "1.5M");
    assert_eq!(count(12_345.), "12,345");
}

#[gpui::test]
fn usage_shows_limits_then_cost_from_production_shapes(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--usage");
    let (view, cx) = cx.add_window_view(|window, cx| View::new(fixture.client.clone(), window, cx));
    settle(&view, cx);
    assert!(cx.debug_bounds("usage-limit-cards").is_some());
    let bounds = cx.debug_bounds("usage-cost").unwrap();
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    settle(&view, cx);
    assert!(cx.debug_bounds("usage-total").is_some());
    assert!(cx.debug_bounds("usage-chart").is_some());
    let range = cx.debug_bounds("usage-range-7").unwrap();
    cx.simulate_click(range.center(), gpui::Modifiers::default());
    settle(&view, cx);
    assert!(view.read_with(cx, |view, _| view.history.contains_key(&7)));
}
