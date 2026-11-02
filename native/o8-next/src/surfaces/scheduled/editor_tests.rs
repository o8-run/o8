//! The editor's request body, field by field, as AutomationEditor submits it.
use super::*;
use crate::shell::test_support::TestAppContext;

fn editor(row: Value, cx: &mut TestAppContext) -> (Entity<Editor>, &mut gpui::VisualTestContext) {
    cx.add_window_view(|window, cx| {
        Editor::new(WeakEntity::new_invalid(), Some(row), Vec::new(), window, cx)
    })
}

#[gpui::test]
fn editor_sends_a_watch_automation_as_the_desktop_does(cx: &mut TestAppContext) {
    let (view, cx) = editor(
        json!({
            "id": "a1", "name": " Watch ", "prompt": "Do it", "runtime": "opencode",
            "repoPath": "/repo", "branch": "trunk", "triggerKind": "watch",
            "catchUpPolicy": "skip", "repoConcurrencyLimit": 3,
            "precheckCommand": "true", "precheckTimeoutMs": 5000,
            "watchSourceKind": "managed_run", "watchSourceId": "run-1",
            "watchEventTypes": ["failed", "completed"], "watchLiteralFilter": "oom",
            "watchQuietMs": 90000, "watchMinIntervalMs": 10, "watchBatchWindowMs": 20,
            "watchMaxFiresPerTick": 2, "watchActionKind": "steer", "watchTargetLaneId": "lane"
        }),
        cx,
    );
    let body = view.read_with(cx, |view, cx| view.payload(cx));
    for (key, expected) in [
        ("name", json!("Watch")),
        ("runtime", json!("opencode")),
        ("branch", json!("trunk")),
        ("triggerKind", json!("watch")),
        ("cronExpr", Value::Null),
        ("catchUpPolicy", json!("skip")),
        ("repoConcurrencyLimit", json!(3)),
        ("precheckCommand", json!("true")),
        ("precheckTimeoutMs", json!(5000)),
        ("watchSourceKind", json!("managed_run")),
        ("watchSourceId", json!("run-1")),
        ("watchEventTypes", json!(["failed", "completed"])),
        ("watchLiteralFilter", json!("oom")),
        ("watchQuietMs", json!(90000)),
        ("watchMinIntervalMs", json!(10)),
        ("watchBatchWindowMs", json!(20)),
        ("watchMaxFiresPerTick", json!(2)),
        ("watchActionKind", json!("steer")),
        ("watchTargetLaneId", json!("lane")),
    ] {
        assert_eq!(body[key], expected, "{key}");
    }
}

#[gpui::test]
fn editor_leaves_watch_fields_off_a_cron_automation(cx: &mut TestAppContext) {
    let (view, cx) = editor(
        json!({"name": "Cron", "prompt": "Go", "repoPath": "/repo", "triggerKind": "cron",
            "repoConcurrencyLimit": 99, "precheckTimeoutMs": 5}),
        cx,
    );
    let body = view.read_with(cx, |view, cx| view.payload(cx));
    assert_eq!(body["cronExpr"], json!(DEFAULT_CRON));
    assert_eq!(body["catchUpPolicy"], json!("latest"));
    // Clamped as the desktop's number inputs clamp them.
    assert_eq!(body["repoConcurrencyLimit"], json!(16));
    assert_eq!(body["precheckTimeoutMs"], json!(1000));
    assert_eq!(body["precheckCommand"], Value::Null);
    assert_eq!(body["watchQuietMs"], Value::Null);
    for key in ["watchSourceKind", "watchEventTypes", "watchActionKind"] {
        assert!(body.get(key).is_none(), "{key}");
    }
}
