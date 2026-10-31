use super::view::{explain, relative, schedule_label};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as f64
}

#[test]
fn relative_times_read_like_classic() {
    assert_eq!(relative(None, "never"), "never");
    assert_eq!(relative(Some(now() - 10_000.), ""), "just now");
    assert_eq!(relative(Some(now() - 5. * 60_000.), ""), "5m ago");
    assert_eq!(relative(Some(now() - 3. * 3_600_000.), ""), "3h ago");
    assert_eq!(relative(Some(now() - 2. * 86_400_000.), ""), "2d ago");
    assert_eq!(
        relative(Some(now() + 90. * 60_000. + 30_000.), ""),
        "in 1h 30m"
    );
}

#[test]
fn connected_schedules_label_daily_cron_and_intervals() {
    let daily = json!({"kind": "cron", "expr": "30 17 * * *", "tz": "America/New_York"});
    assert_eq!(
        schedule_label(&daily),
        "Daily at 5:30 PM · America/New_York"
    );
    assert_eq!(
        schedule_label(&json!({"kind": "cron", "expr": "0 9 * * 1-5"})),
        "0 9 * * 1-5"
    );
    assert_eq!(
        schedule_label(&json!({"kind": "every", "everyMs": 7_200_000})),
        "Every 2h"
    );
    assert_eq!(
        schedule_label(&json!({"kind": "every", "everyMs": 900_000})),
        "Every 15m"
    );
    assert_eq!(schedule_label(&json!({})), "Unknown schedule");
}

#[test]
fn fire_history_explains_skips_retries_and_watch_sources() {
    assert_eq!(
        explain(&json!({"status": "retrying", "attemptCount": 1, "maxAttempts": 3})),
        "Retry 2 of 3 queued"
    );
    assert_eq!(
        explain(&json!({"status": "skipped_precheck"})),
        "Precheck skipped the agent launch"
    );
    assert_eq!(
        explain(
            &json!({"status": "succeeded", "source": "watch", "sourceEventType": "push", "sourceId": "main"})
        ),
        "push from main · Dispatched successfully"
    );
}
