//! PacketCard parity through the registered shell and HTTP fixture.
use super::tests::{activity_click, activity_open};
use crate::shell::test_support::Fixture;
use gpui::TestAppContext;

#[gpui::test]
fn activity_packet_card_metadata_tabs_and_review(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (_shell, mut visual, _) = activity_open(&fixture, cx);
    activity_click(&mut visual, "activity-filter-packet");
    activity_click(&mut visual, "activity-row-packet-local-activity-packet");
    for control in [
        "activity-packet-card",
        "activity-packet-summary",
        "activity-packet-runtime",
        "activity-packet-repo",
        "activity-packet-branch",
        "activity-packet-tab-agents",
        "activity-packet-tab-context",
        "activity-packet-tab-changes",
        "activity-packet-tab-files",
        "activity-packet-details",
    ] {
        assert!(
            visual.debug_bounds(control).is_some(),
            "PacketCard is missing {control}"
        );
    }
    let worker = visual.debug_bounds("activity-open-worker").unwrap();
    let details = visual.debug_bounds("activity-packet-details").unwrap();
    let archive = visual.debug_bounds("activity-packet-archive").unwrap();
    assert_eq!(
        worker.top(),
        details.top(),
        "primary and Details actions share a row"
    );
    assert_eq!(
        details.top(),
        archive.top(),
        "Archive follows the ordinary actions"
    );
    assert!(worker.left() < details.left() && details.left() < archive.left());
    assert!(visual.debug_bounds("activity-packet-last-event").is_some());
}

#[gpui::test]
fn activity_packet_card_hold_has_local_pending_feedback(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (_shell, mut visual, _) = activity_open(&fixture, cx);
    activity_click(&mut visual, "activity-filter-packet");
    activity_click(&mut visual, "activity-row-packet-local-activity-queued");
    assert!(visual.debug_bounds("activity-packet-card").is_some());
    activity_click(&mut visual, "activity-hold");
    assert!(
        visual.debug_bounds("activity-packet-feedback").is_some(),
        "hold feedback belongs in the expanded card"
    );
}

#[gpui::test]
fn activity_packet_card_review_files_and_diff_controls(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    fixture.client.activity_request("PATCH", "/api/orchestrator/state", &[], Some(&serde_json::json!({"packetId":"activity-packet","updates":{"queueState":"queued","blockedReason":null}}))).unwrap();
    let (_shell, mut visual, _) = activity_open(&fixture, cx);
    activity_click(&mut visual, "activity-filter-packet");
    activity_click(&mut visual, "activity-row-packet-local-activity-packet");
    for id in [
        "activity-packet-tab-files",
        "activity-packet-tab-changes",
        "activity-packet-review",
    ] {
        assert!(
            visual.debug_bounds(id).is_some(),
            "Missing packet review control {id}"
        );
    }
}

use super::tests::activity_view;
use crate::shell::test_support::draw;
use serde_json::Value;
use std::time::Duration;
fn wait_packet(
    view: &gpui::Entity<super::ActivityPane>,
    cx: &mut gpui::VisualTestContext,
    id: &str,
) {
    for _ in 0..200 {
        cx.run_until_parked();
        draw(cx);
        if view.read_with(cx, |v, _| {
            !v.pending && !v.loading && v.packet_evidence(id)["loading"] == false
        }) {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("Packet read did not settle");
}
#[gpui::test]
fn activity_packet_card_lazy_review_files_retry_and_diff(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    let cx = &mut visual;
    let view = activity_view(&shell, cx);
    let state: Value = fixture.client.get("/api/activity-fixture", &[]).unwrap();
    assert!(
        state["packetReads"].as_array().unwrap().is_empty(),
        "Collapsed cards must not read reviews"
    );
    fixture
        .client
        .get::<Value>("/api/activity-fixture", &[("mode", "packet-refused")])
        .unwrap();
    activity_click(cx, "activity-filter-packet");
    activity_click(cx, "activity-row-packet-local-activity-packet");
    wait_packet(&view, cx, "activity-packet");
    activity_click(cx, "activity-release");
    wait_packet(&view, cx, "activity-packet");
    assert!(view.read_with(cx, |v, _| {
        v.packet_evidence("activity-packet")["error"]
            .as_str()
            .unwrap_or("no review error")
            .contains("HTTP 403")
    }));
    fixture
        .client
        .get::<Value>("/api/activity-fixture", &[("mode", "ready")])
        .unwrap();
    activity_click(cx, "activity-packet-retry-read");
    wait_packet(&view, cx, "activity-packet");
    assert_eq!(
        view.read_with(cx, |v, _| v.packet_evidence("activity-packet")["files"]
            .as_u64()),
        Some(6)
    );
    activity_click(cx, "activity-packet-tab-files");
    assert!(cx.debug_bounds("activity-packet-file-4").is_some());
    activity_click(cx, "activity-packet-show-files");
    assert!(cx.debug_bounds("activity-packet-file-5").is_some());
    activity_click(cx, "activity-packet-tab-changes");
    activity_click(cx, "activity-packet-open-diff");
    assert!(shell.read_with(cx, |s, _| matches!(
        s.active(),
        Some(crate::shell::Tab::Diff)
    )));
    let state = crate::shell::State::load(&fixture.root.join("activity.json")).unwrap();
    let workspace = &state.workspaces[state.selected.as_ref().unwrap()];
    assert_eq!(
        workspace.surfaces.diff.diff_packet.as_deref(),
        Some("activity-packet")
    );
}
#[gpui::test]
fn activity_packet_card_edits_summary_and_branch(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    fixture
        .client
        .activity_request(
            "PATCH",
            "/api/orchestrator/state",
            &[],
            Some(
                &serde_json::json!({"packetId":"activity-queued","updates":{"queueState":"draft"}}),
            ),
        )
        .unwrap();
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    let cx = &mut visual;
    let view = activity_view(&shell, cx);
    activity_click(cx, "activity-filter-packet");
    activity_click(cx, "activity-row-packet-local-activity-queued");
    wait_packet(&view, cx, "activity-queued");
    activity_click(cx, "activity-packet-branch-value");
    cx.simulate_keystrokes("cmd-a");
    cx.simulate_input("packet/parity");
    cx.simulate_keystrokes("enter");
    wait_packet(&view, cx, "activity-queued");
    let state: Value = fixture.client.get("/api/orchestrator/state", &[]).unwrap();
    assert_eq!(
        state["mission"]["packets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "activity-queued")
            .unwrap()["branchTarget"],
        "packet/parity"
    );
    activity_click(cx, "activity-packet-summary-value");
    cx.simulate_keystrokes("cmd-a");
    cx.simulate_input("Edited packet summary");
    activity_click(cx, "activity-packet-save");
    wait_packet(&view, cx, "activity-queued");
    let state: Value = fixture.client.get("/api/orchestrator/state", &[]).unwrap();
    assert_eq!(
        state["mission"]["packets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "activity-queued")
            .unwrap()["summary"],
        "Edited packet summary"
    );
    activity_click(cx, "activity-packet-tab-context");
}
#[gpui::test]
fn activity_packet_card_withheld_controls_are_absent(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    let view = activity_view(&shell, &mut visual);
    activity_click(&mut visual, "activity-filter-packet");
    for packet in ["activity-packet", "activity-queued"] {
        activity_click(
            &mut visual,
            Box::leak(format!("activity-row-packet-local-{packet}").into_boxed_str()),
        );
        wait_packet(&view, &mut visual, packet);
        for tab in ["agents", "context", "changes", "files"] {
            activity_click(
                &mut visual,
                Box::leak(format!("activity-packet-tab-{tab}").into_boxed_str()),
            );
            for id in [
                "activity-packet-launch",
                "activity-packet-delete",
                "activity-packet-approve-merge",
                "activity-packet-respec",
                "activity-packet-retry",
                "activity-packet-kill",
                "activity-packet-edit-spec",
                "activity-packet-feedback-submit",
                "activity-packet-runtime-value-choice",
                "activity-packet-repo-value-choice",
            ] {
                assert!(
                    visual.debug_bounds(id).is_none(),
                    "Unsupported control must not be drawn: {id}"
                );
            }
        }
        assert!(
            view.read_with(&visual, |v, _| v.packet_evidence(packet)["error"].is_null()),
            "available packet reads should settle without unsupported-route errors"
        );
    }
}
#[gpui::test]
fn activity_packet_card_bounds_realistic_long_metadata(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    fixture.client.activity_request("PATCH","/api/orchestrator/state",&[],Some(&serde_json::json!({"packetId":"activity-queued","updates":{"summary":format!("{}\n\n{}", "A long packet summary must wrap within its card and keep the controls reachable. ".repeat(50), "A second paragraph must stay inside the same three-line preview. ".repeat(50))}}))).unwrap();
    let (_shell, mut visual, _) = activity_open(&fixture, cx);
    let cx = &mut visual;
    activity_click(cx, "activity-filter-packet");
    activity_click(cx, "activity-row-packet-local-activity-queued");
    let pane = cx.debug_bounds("activity-pane").unwrap();
    let viewport = cx.update(|window, _| window.viewport_size());
    assert!(
        pane.right() <= viewport.width + gpui::px(1.),
        "packet content stretched its pane beyond the viewport: {pane:?}"
    );
    let card = cx.debug_bounds("activity-packet-card").unwrap();
    let summary = cx.debug_bounds("activity-packet-summary-value").unwrap();
    assert!(
        card.right() <= pane.right() + gpui::px(1.),
        "long metadata stretched the card beyond its pane: {card:?} vs {pane:?}"
    );
    assert!(
        summary.right() <= card.right(),
        "summary overflowed the card"
    );
    assert!(
        summary.size.height > gpui::px(25.) && summary.size.height <= gpui::px(60.),
        "summary should wrap and clamp to three lines: {summary:?}"
    );
}
