//! Packet recovery through the registered Activity surface and owned HTTP fixture.
use super::pane::Action;
use super::tests::{activity_click, activity_open, activity_view};
use crate::shell::test_support::{Fixture, draw};
use gpui::{Entity, TestAppContext, VisualTestContext, point, px};
use serde_json::Value;
use std::time::Duration;

fn settle(view: &Entity<super::ActivityPane>, cx: &mut VisualTestContext) {
    for _ in 0..200 {
        cx.run_until_parked();
        draw(cx);
        if view.read_with(cx, |view, _| !view.pending && !view.loading) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("Packet recovery did not settle");
}
fn mode(fixture: &Fixture, mode: &str) {
    fixture
        .client
        .get::<Value>("/api/activity-fixture", &[("mode", mode)])
        .unwrap();
}
fn requests(fixture: &Fixture) -> Vec<Value> {
    fixture
        .client
        .get::<Value>("/api/activity-fixture", &[])
        .unwrap()["recoveries"]
        .as_array()
        .unwrap()
        .clone()
}
fn click(view: &Entity<super::ActivityPane>, cx: &mut VisualTestContext, selector: &'static str) {
    for offset in [0., -150., -450., -1200.] {
        view.update(cx, |view, cx| {
            view.scroll.set_offset(point(px(0.), px(offset)));
            cx.notify();
        });
        cx.run_until_parked();
        draw(cx);
        let height = cx.update(|window, _| window.viewport_size().height);
        if cx
            .debug_bounds(selector)
            .is_some_and(|bounds| bounds.top() >= px(0.) && bounds.bottom() <= height)
        {
            activity_click(cx, selector);
            return;
        }
    }
    panic!("Recovery control is not reachable: {selector}");
}
#[gpui::test]
fn activity_packet_recovery_retry_control(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    let view = activity_view(&shell, &mut visual);
    activity_click(&mut visual, "activity-filter-packet");
    activity_click(&mut visual, "activity-row-packet-local-activity-packet");
    assert!(visual.debug_bounds("activity-recovery-retry").is_some());
    mode(&fixture, "recovery-unknown");
    click(&view, &mut visual, "activity-recovery-retry");
    settle(&view, &mut visual);
    assert!(view.read_with(&visual, |view, _| {
        view.notice.contains("Fixture request is unsettled")
    }));
    assert_eq!(requests(&fixture).len(), 1);
    click(&view, &mut visual, "activity-recovery-retry");
    assert_eq!(
        requests(&fixture).len(),
        1,
        "unknown outcomes cannot submit a second retry"
    );
    mode(&fixture, "ready");
    activity_click(&mut visual, "activity-refresh");
    settle(&view, &mut visual);
    let sent = requests(&fixture);
    assert_eq!(sent.len(), 2);
    assert_eq!(
        sent[0], sent[1],
        "Refresh must inspect the original body and identity"
    );
    assert_eq!(sent[0]["body"]["clearWorktree"], false);
    assert_eq!(sent[0]["path"], "/api/orchestrator/reset-packet");
    assert!(view.read_with(&visual, |view, _| {
        view.notice.contains("Fixture committed work retained")
    }));
}
#[gpui::test]
fn activity_packet_recovery_reset_control(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    let view = activity_view(&shell, &mut visual);
    activity_click(&mut visual, "activity-filter-packet");
    activity_click(&mut visual, "activity-row-packet-local-activity-packet");
    click(&view, &mut visual, "activity-recovery-reset");
    assert!(visual.debug_bounds("activity-recovery-confirm").is_some());
    assert!(
        requests(&fixture).is_empty(),
        "opening a confirmation must not reset work"
    );
    click(&view, &mut visual, "activity-recovery-cancel");
    assert!(requests(&fixture).is_empty());
    click(&view, &mut visual, "activity-recovery-reset");
    mode(&fixture, "recovery-refused");
    click(&view, &mut visual, "activity-recovery-confirm-submit");
    settle(&view, &mut visual);
    assert!(
        visual.debug_bounds("activity-recovery-confirm").is_some(),
        "a refusal keeps the confirmation usable"
    );
    assert!(view.read_with(&visual, |view, _| {
        view.notice.contains("Fixture recovery refused")
    }));
    mode(&fixture, "ready");
    click(&view, &mut visual, "activity-recovery-confirm-submit");
    settle(&view, &mut visual);
    let sent = requests(&fixture);
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0]["body"]["clearWorktree"], true);
    assert_eq!(sent[1]["body"]["clearWorktree"], true);
    assert!(view.read_with(&visual, |view, _| {
        view.notice.contains("Fixture packet reset and held")
    }));
}
#[gpui::test]
fn activity_packet_recovery_stop_reset_control(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    let view = activity_view(&shell, &mut visual);
    mode(&fixture, "lane-running");
    activity_click(&mut visual, "activity-filter-packet");
    activity_click(&mut visual, "activity-row-packet-local-activity-packet");
    activity_click(&mut visual, "activity-release");
    settle(&view, &mut visual);
    assert!(visual.debug_bounds("activity-lane-stop").is_some());
    click(&view, &mut visual, "activity-recovery-stop-reset");
    assert!(requests(&fixture).is_empty());
    mode(&fixture, "recovery-poll");
    let row = view.read_with(&visual, |view, _| {
        view.rows
            .iter()
            .find(|row| row.id == "activity-packet")
            .unwrap()
            .clone()
    });
    view.update(&mut visual, |view, cx| {
        view.act(Action::RecoveryConfirm(row.clone()), cx);
        assert!(view.pending);
        view.act(Action::RecoveryConfirm(row), cx);
    });
    settle(&view, &mut visual);
    let sent = requests(&fixture);
    assert_eq!(
        sent.len(),
        2,
        "one request and its receipt poll, without duplicate submissions"
    );
    assert_eq!(sent[0], sent[1]);
    assert_eq!(sent[0]["body"]["clearWorktree"], true);
}
#[gpui::test]
fn activity_packet_recovery_start_over_control(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    let view = activity_view(&shell, &mut visual);
    activity_click(&mut visual, "activity-filter-packet");
    activity_click(&mut visual, "activity-row-packet-local-activity-packet");
    click(&view, &mut visual, "activity-recovery-start-over");
    let row = view.read_with(&visual, |view, _| {
        view.rows
            .iter()
            .find(|row| row.id == "activity-packet")
            .unwrap()
            .clone()
    });
    view.update(&mut visual, |view, cx| {
        view.act(Action::RecoveryConfirm(row.clone()), cx)
    });
    assert!(
        requests(&fixture).is_empty(),
        "empty feedback must stay disabled"
    );
    visual.simulate_input(&"🙂".repeat(2001));
    view.update(&mut visual, |view, cx| {
        view.act(Action::RecoveryConfirm(row.clone()), cx)
    });
    assert!(
        requests(&fixture).is_empty(),
        "the route's 4000 UTF-16-unit limit must be enforced"
    );
    visual.simulate_keystrokes("cmd-a");
    visual.simulate_input("Keep the public interface stable.");
    mode(&fixture, "recovery-refused");
    click(&view, &mut visual, "activity-recovery-confirm-submit");
    settle(&view, &mut visual);
    assert!(visual.debug_bounds("activity-recovery-confirm").is_some());
    mode(&fixture, "ready");
    click(&view, &mut visual, "activity-recovery-confirm-submit");
    settle(&view, &mut visual);
    let sent = requests(&fixture);
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0]["path"], "/api/orchestrator/rerun-with-feedback");
    assert_eq!(
        sent[0]["body"]["feedback"],
        "Keep the public interface stable."
    );
    assert_eq!(
        sent[0]["body"]["feedback"], sent[1]["body"]["feedback"],
        "failed feedback must be retained"
    );
    assert!(visual.debug_bounds("activity-recovery-confirm").is_none());
    assert!(view.read_with(&visual, |view, _| {
        view.notice.contains("Fixture new attempt queued")
    }));
}
