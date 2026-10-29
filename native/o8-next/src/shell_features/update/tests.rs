use super::{Outcome, Phase, outcome, pending, phase, plist_version};
use serde_json::json;

// Bodies follow src/app/api/panel/update/apply/route.ts.

#[test]
fn a_finished_check_with_an_update_shows_its_version() {
    let body = json!({"ok": true, "state": {"updatePending": true, "version": "0.1.816"}});
    assert_eq!(pending(&body).as_deref(), Some("0.1.816"));
    let unversioned = json!({"ok": true, "state": {"updatePending": true}});
    assert_eq!(pending(&unversioned).as_deref(), Some(""));
}

#[test]
fn no_pending_update_or_an_unreadable_state_hides_the_pill() {
    for body in [
        json!({"ok": true, "state": {"updatePending": false, "version": "0.1.815"}}),
        json!({"ok": true}),
        json!({"error": "not found"}),
    ] {
        assert_eq!(pending(&body), None, "{body}");
    }
}

#[test]
fn apply_answers_map_to_what_the_shell_shows() {
    let current = json!({"ok": true, "requested": false, "result": {"code": "already_current"}});
    assert_eq!(outcome(&current), Outcome::Current);
    let sent = json!({"ok": true, "requested": true, "forced": false});
    assert_eq!(outcome(&sent), Outcome::Restarting);
    let busy = json!({"ok": false, "requested": false, "error": {
        "code": "update_apply_busy",
        "message": "Update apply refused because work is live. Retry when idle or pass force:true."
    }});
    assert_eq!(outcome(&busy), Outcome::Busy);
    let unavailable = json!({"ok": false, "requested": false, "error": {
        "code": "update_check_unavailable",
        "message": "A fresh native updater check did not finish within 25 seconds."
    }});
    assert_eq!(
        outcome(&unavailable),
        Outcome::Failed("A fresh native updater check did not finish within 25 seconds.".into())
    );
    assert_eq!(
        outcome(&json!({"ok": false})),
        Outcome::Failed("The update could not start.".into())
    );
}

#[test]
fn the_native_updater_phase_follows_an_accepted_apply() {
    let at = |value: serde_json::Value| json!({"ok": true, "state": {"autoApply": value}});
    assert_eq!(
        phase(&at(json!({"phase": "installing"}))),
        Some(Phase::Installing)
    );
    assert_eq!(
        phase(&at(json!({"phase": "restarting"}))),
        Some(Phase::Restarting)
    );
    assert_eq!(
        phase(&at(
            json!({"phase": "failed", "error": "signature mismatch"})
        )),
        Some(Phase::Failed("signature mismatch".into()))
    );
    assert_eq!(phase(&at(json!({"phase": "waiting"}))), None);
    assert_eq!(phase(&json!({"ok": true, "state": {}})), None);
}

#[test]
fn the_installed_version_comes_from_the_bundle_plist() {
    let plist = r#"<dict>
	<key>CFBundleName</key>
	<string>o8</string>
	<key>CFBundleShortVersionString</key>
	<string>0.1.815</string>
</dict>"#;
    assert_eq!(plist_version(plist).as_deref(), Some("0.1.815"));
    assert_eq!(plist_version("<dict></dict>"), None);
}

#[test]
fn update_all_reports_what_each_tool_did_in_one_line() {
    use super::update_summary;
    let ok = |label: &str| (label.to_string(), Ok(()));
    let failed = |label: &str, error: &str| (label.to_string(), Err(error.to_string()));
    assert_eq!(update_summary(&[ok("Gemini CLI")]), "Updated Gemini CLI.");
    assert_eq!(
        update_summary(&[ok("Gemini CLI"), ok("Qwen Code")]),
        "Updated Gemini CLI and Qwen Code."
    );
    assert_eq!(
        update_summary(&[ok("A"), ok("B"), ok("C")]),
        "Updated 3 tools."
    );
    assert_eq!(
        update_summary(&[ok("Gemini CLI"), failed("Qwen Code", "npm exited 1")]),
        "Updated Gemini CLI. Qwen Code failed: npm exited 1"
    );
    assert_eq!(
        update_summary(&[failed("A", "x"), failed("B", "y")]),
        "2 tools failed to update."
    );
    assert_eq!(update_summary(&[]), "Nothing to update.");
}

#[test]
fn the_download_ring_runs_clockwise_from_the_top() {
    use super::arc;
    assert_eq!(arc(0.25), "M12 1.5A10.5 10.5 0 0 1 22.50 12.00");
    assert_eq!(arc(0.5), "M12 1.5A10.5 10.5 0 0 1 12.00 22.50");
    assert!(arc(0.75).starts_with("M12 1.5A10.5 10.5 0 1 1 1.50 "));
    assert_eq!(arc(1.), arc(1.4));
    assert_eq!(arc(0.251), arc(0.25));
}
