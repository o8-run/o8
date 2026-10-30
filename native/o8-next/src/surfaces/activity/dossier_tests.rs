//! All interactions open Activity through the real native shell and route host.
use super::tests::{activity_click, activity_open, activity_scope};
use crate::shell::test_support::*;
fn read(f: &Fixture, query: &[(&str, &str)]) -> Value {
    f.client
        .get("/api/activity-dossiers-fixture", query)
        .unwrap()
}
#[gpui::test]
fn activity_dossiers_scope_disclosure_and_evidence(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--activity --activity-dossiers");
    let (_, mut v, _) = activity_open(&f, cx);
    assert!(v.debug_bounds("activity-dossiers").is_some());
    assert!(v.debug_bounds("activity-dossier-candidate").is_some());
    assert!(v.debug_bounds("activity-dossier-foreign").is_none());
    activity_click(&mut v, "activity-dossier-history-toggle-candidate");
    assert!(
        v.debug_bounds("activity-dossier-history-candidate")
            .is_some()
    );
    assert!(
        v.debug_bounds("activity-dossier-field-candidate-approvalId")
            .is_some()
    );
    assert!(
        v.debug_bounds("activity-dossier-field-candidate-releaseRef")
            .is_some()
    );
    activity_click(&mut v, "activity-dossier-history-toggle-candidate");
    assert!(
        v.debug_bounds("activity-dossier-history-candidate")
            .is_none()
    );
    activity_click(&mut v, "activity-dossiers");
    assert!(v.debug_bounds("activity-dossier-candidate").is_none());
    activity_click(&mut v, "activity-dossiers");
    activity_scope(&mut v, "activity-scope-all");
    assert!(v.debug_bounds("activity-dossier-foreign").is_some());
}
#[gpui::test]
fn activity_dossier_decisions_write_real_state_and_replay_receipt(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--activity --activity-dossiers");
    let (_, mut v, _) = activity_open(&f, cx);
    read(&f, &[("mode", "slow")]);
    activity_click(&mut v, "activity-dossier-candidate-suppress");
    let result = read(&f, &[]);
    let calls = result["bodies"].as_array().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0], calls[1]);
    assert_eq!(calls[0]["cooldownDays"], 7);
    assert_eq!(
        result["dossiers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["id"] == "candidate")
            .unwrap()["status"],
        "suppressed"
    );
    read(&f, &[("mode", "ready")]);
    activity_click(&mut v, "activity-dossier-candidate-resume");
    assert_eq!(
        read(&f, &[])["dossiers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["id"] == "candidate")
            .unwrap()["status"],
        "candidate"
    );
    activity_click(&mut v, "activity-dossier-candidate-accept");
    let accepted = read(&f, &[]);
    let row = accepted["dossiers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["id"] == "candidate")
        .unwrap();
    assert!(
        row["linkedTaskId"].as_str().is_some(),
        "Accepted state: {row}"
    );
    assert!(
        row["remedies"].as_array().is_none(),
        "Public list helper omits the route projection"
    );
    activity_click(&mut v, "activity-dossier-candidate-stop");
    assert!(
        read(&f, &[])["dossiers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["id"] == "candidate")
            .unwrap()["operatorStoppedAt"]
            .as_str()
            .is_some()
    );
}
#[gpui::test]
fn activity_dossier_unsettled_and_read_failure_keep_context(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--activity --activity-dossiers");
    let (_, mut v, _) = activity_open(&f, cx);
    read(&f, &[("mode", "error")]);
    activity_click(&mut v, "activity-refresh");
    assert!(v.debug_bounds("activity-dossiers-error").is_some());
    assert!(v.debug_bounds("activity-dossier-candidate").is_some());
    read(&f, &[("mode", "ready")]);
    activity_click(&mut v, "activity-dossiers-retry");
    assert!(v.debug_bounds("activity-dossiers-error").is_none());
    read(&f, &[("mode", "unknown")]);
    activity_click(&mut v, "activity-dossier-candidate-accept");
    assert!(v.debug_bounds("activity-dossiers-error").is_some());
    activity_click(&mut v, "activity-dossier-candidate-accept");
    assert_eq!(
        read(&f, &[])["bodies"].as_array().unwrap().len(),
        1,
        "Unsettled receipt must keep both decisions disabled"
    );
}

#[gpui::test]
fn activity_dossier_status_controls_follow_real_projection(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--activity --activity-dossiers");
    let (_, mut v, _) = activity_open(&f, cx);
    for (status, allowed) in [
        ("candidate", vec!["accept", "suppress"]),
        ("accepted", vec!["stop"]),
        ("investigating", vec!["stop"]),
        ("remedy_active", vec!["stop"]),
        ("provisionally_resolved", vec!["stop"]),
        ("reopened", vec!["accept", "suppress"]),
        ("suppressed", vec!["resume"]),
        ("verified_closed", vec![]),
    ] {
        read(&f, &[("status", status)]);
        activity_click(&mut v, "activity-refresh");
        for action in ["accept", "suppress", "stop", "resume"] {
            let selector =
                Box::leak(format!("activity-dossier-candidate-{action}").into_boxed_str());
            assert_eq!(
                v.debug_bounds(selector).is_some(),
                allowed.contains(&action),
                "{status}: {action}"
            );
        }
    }
}
