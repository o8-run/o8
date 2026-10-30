use super::tests::{activity_click, activity_open, activity_view};
use super::*;
use crate::shell::test_support::*;

fn snapshot(f: &Fixture, query: &[(&str, &str)]) -> Value {
    f.client
        .get("/api/activity-proposals-fixture", query)
        .unwrap()
}
fn selector(source: &str, id: &str, action: &str) -> &'static str {
    Box::leak(format!("activity-proposal-{source}:{id}{action}").into_boxed_str())
}
// Keyboard activation uses the focused control from the earlier real click,
// without the convenience helper's automatic async drain.
fn press(v: &mut VisualTestContext) {
    v.update(|window, cx| {
        window.dispatch_keystroke(gpui::Keystroke::parse("enter").unwrap(), cx);
    });
}

fn start(f: &Fixture, cx: &mut TestAppContext) -> (Entity<Shell>, VisualTestContext) {
    let (s, mut v, _) = activity_open(f, cx);
    activity_click(&mut v, "activity-dossiers");
    (s, v)
}
#[gpui::test]
fn activity_proposals_sources_details_and_frozen_new_badges(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--activity --activity-dossiers");
    let (_, mut v) = start(&f, cx);
    let data = snapshot(&f, &[]);
    for (source, id) in [
        ("auto", "auto-fixture"),
        ("cross-repo", "cross-fixture"),
        ("observation", data["observation"]["id"].as_str().unwrap()),
    ] {
        assert!(v.debug_bounds(selector(source, id, "")).is_some());
        activity_click(&mut v, selector(source, id, ""));
        let detail = Box::leak(format!("activity-proposal-details-{source}:{id}").into_boxed_str());
        assert!(v.debug_bounds(detail).is_some());
        activity_click(&mut v, selector(source, id, ""));
        assert!(v.debug_bounds(detail).is_none());
    }
    activity_click(&mut v, "activity-proposals");
    assert!(
        v.debug_bounds(selector("auto", "auto-fixture", ""))
            .is_none()
    );
    activity_click(&mut v, "activity-proposals");
    assert!(
        v.debug_bounds("activity-proposal-new-auto:auto-fixture")
            .is_some(),
        "Opening keeps this mount's new emphasis frozen"
    );
}
#[gpui::test]
fn activity_proposal_accept_writes_and_hands_off_an_unsent_draft(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--activity --activity-dossiers");
    let (s, mut v) = start(&f, cx);
    let before = snapshot(&f, &[]);
    activity_click(&mut v, selector("auto", "auto-fixture", "-accept"));
    ready(&s, &mut v);
    let draft = s.read_with(&v, |s, cx| {
        match s.content.get(&s.key(&s.active().unwrap())) {
            Some(Content::Session(view)) => view.read(cx).shell_issue_state(cx)["draft"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
            _ => panic!("Acceptance must open a local chat draft"),
        }
    });
    assert!(draft.contains("Please save the following directive after I review it:"));
    assert!(draft.contains("Use the last acknowledged hash"));
    let after = snapshot(&f, &[]);
    assert_eq!(after["files"].as_array().unwrap().len(), 1);
    assert!(
        after["files"][0]["content"]
            .as_str()
            .unwrap()
            .contains("title: \"Guard file writes\"")
    );
    assert_eq!(
        after["messages"], before["messages"],
        "The handoff must never send a message"
    );
}
#[gpui::test]
fn activity_proposal_dismiss_uses_source_routes_and_persisted_ledgers(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--activity --activity-dossiers");
    let (_, mut v) = start(&f, cx);
    let data = snapshot(&f, &[]);
    for (source, id) in [
        ("auto", "auto-fixture"),
        ("cross-repo", "cross-fixture"),
        ("observation", data["observation"]["id"].as_str().unwrap()),
    ] {
        activity_click(&mut v, selector(source, id, "-dismiss"));
        assert!(v.debug_bounds(selector(source, id, "")).is_none());
    }
    let after = snapshot(&f, &[]);
    let bodies = after["bodies"].as_array().unwrap();
    assert_eq!(bodies.len(), 3);
    assert_eq!(bodies[0]["body"]["action"], "dismiss");
    assert_eq!(bodies[0]["body"]["filePattern"], "src/**/*.rs");
    assert_eq!(
        bodies[1]["body"]["targetRepoId"],
        data["cross"]["targetRepoId"]
    );
    assert_eq!(bodies[2]["body"]["action"], "dismiss_observation");
    assert!(after["snooze"].is_object());
    assert!(after["crossSnooze"].is_object());
    assert!(after["observations"].as_array().unwrap().is_empty());
    assert!(after["files"].as_array().unwrap().is_empty());
}
#[gpui::test]
fn activity_proposal_failed_write_keeps_row_and_busy_accept_is_single(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--activity --activity-dossiers");
    let (s, mut v) = start(&f, cx);
    snapshot(&f, &[("mode", "fail")]);
    activity_click(&mut v, selector("cross-repo", "cross-fixture", "-accept"));
    assert!(v.debug_bounds("activity-proposals-error").is_some());
    assert!(
        v.debug_bounds(selector("cross-repo", "cross-fixture", ""))
            .is_some()
    );
    assert!(snapshot(&f, &[])["files"].as_array().unwrap().is_empty());
    snapshot(&f, &[("mode", "slow")]);
    press(&mut v);
    draw(&mut v);
    assert!(v.debug_bounds("activity-proposal-pending").is_some());
    press(&mut v);
    v.run_until_parked();
    draw(&mut v);
    ready(&s, &mut v);
    let after = snapshot(&f, &[]);
    assert_eq!(after["files"].as_array().unwrap().len(), 1);
    let writes = after["bodies"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|b| b["path"] == "/api/cortex/directives")
        .collect::<Vec<_>>();
    assert_eq!(
        writes.len(),
        2,
        "One failed write and one confirmed retry, no double submit"
    );
    assert_eq!(
        writes[0]["body"]["id"], writes[1]["body"]["id"],
        "Retry reuses the directive's file identity"
    );
    assert_eq!(
        after["bodies"].as_array().unwrap().last().unwrap()["body"]["action"],
        "accept"
    );
    assert!(after["origins"].is_object());
}
#[gpui::test]
fn activity_preferences_seen_and_visibility_survive_shell_reload(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--activity --activity-dossiers");
    let (s1, mut v) = start(&f, cx);
    activity_click(&mut v, "activity-proposals");
    activity_click(&mut v, "activity-filter-issue");
    activity_click(&mut v, "activity-row-issue-example/activity-8");
    let expected = activity_view(&s1, &mut v).read_with(&v, |v, _| v.expanded.clone());
    assert!(expected.is_some());
    let file = f.root.join("activity.json");
    let state = State::load(&file).unwrap();
    let raw: Value = serde_json::to_value(&state).unwrap();
    let selected = state.selected.as_ref().unwrap();
    assert_eq!(
        raw["workspaces"][selected]["activity_preferences"]["proposals_open"],
        false
    );
    assert!(
        raw["workspaces"][selected]["activity_preferences"]["seen"]
            .as_array()
            .unwrap()
            .len()
            >= 3
    );
    let (s2, mut v2) = open(f.client.clone(), file, state, cx);
    ready(&s2, &mut v2);
    assert!(v2.debug_bounds("activity-proposals").is_some());
    assert!(
        v2.debug_bounds(selector("auto", "auto-fixture", ""))
            .is_none()
    );
    activity_click(&mut v2, "activity-dossiers");
    activity_click(&mut v2, "activity-proposals");
    assert!(
        v2.debug_bounds("activity-proposal-new-auto:auto-fixture")
            .is_none(),
        "Persisted seen IDs clear emphasis on the next mount"
    );
    let view = activity_view(&s2, &mut v2);
    assert_eq!(view.read_with(&v2, |v, _| v.filter), "issue");
    assert_eq!(view.read_with(&v2, |v, _| v.expanded.clone()), expected);
}

#[gpui::test]
fn activity_feed_scroll_and_expansion_survive_native_reopen(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--activity --activity-dossiers");
    snapshot(&f, &[("many", "1")]);
    let _: Value = f
        .client
        .get("/api/activity-fixture", &[("mode", "empty")])
        .unwrap();
    let (s, mut v, _) = activity_open(&f, cx);
    let view = activity_view(&s, &mut v);
    let (id, key) = view.read_with(&v, |v, _| {
        let row = v
            .rows
            .iter()
            .find(|r| r.kind == "commit")
            .expect("Real local Git history");
        (row.selector(), row.key())
    });
    let id: &'static str = Box::leak(id.into_boxed_str());
    for _ in 0..15 {
        draw(&mut v);
        let viewport = v.debug_bounds("activity-list").unwrap();
        if v.debug_bounds(id)
            .is_some_and(|b| viewport.contains(&b.center()))
        {
            break;
        }
        v.simulate_event(gpui::ScrollWheelEvent {
            position: viewport.center(),
            delta: gpui::ScrollDelta::Pixels(gpui::point(gpui::px(0.), gpui::px(-180.))),
            ..Default::default()
        });
        v.run_until_parked();
    }
    activity_click(&mut v, id);
    let viewport = v.debug_bounds("activity-list").unwrap();
    v.simulate_event(gpui::ScrollWheelEvent {
        position: viewport.center(),
        delta: gpui::ScrollDelta::Pixels(gpui::point(gpui::px(0.), gpui::px(-280.))),
        ..Default::default()
    });
    v.run_until_parked();
    draw(&mut v);
    let file = f.root.join("activity.json");
    let state = State::load(&file).unwrap();
    let saved: Value = serde_json::to_value(&state).unwrap();
    let repo = state.selected.as_ref().unwrap();
    let scroll = saved["workspaces"][repo]["activity_preferences"]["views"][repo]["scroll"]
        .as_f64()
        .unwrap();
    assert!(
        scroll < -100.,
        "The actual wheel must scroll and persist: {scroll}"
    );
    let (s2, mut v2) = open(f.client.clone(), file, state, cx);
    ready(&s2, &mut v2);
    let view2 = activity_view(&s2, &mut v2);
    assert_eq!(view2.read_with(&v2, |v, _| v.expanded.clone()), Some(key));
    // A restored scroll puts the recurring-problems header above the viewport.
    let viewport = v2.debug_bounds("activity-list").unwrap();
    assert!(
        v2.debug_bounds("activity-dossiers")
            .is_none_or(|b| b.top() < viewport.top()),
        "The reopened feed must retain the actual scroll position"
    );
}
