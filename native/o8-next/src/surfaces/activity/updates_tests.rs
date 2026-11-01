use super::tests::{activity_click, activity_open, activity_view};
use super::*;
use crate::shell::test_support::*;
use std::time::Duration;

fn tick(shell: &Entity<Shell>, visual: &mut VisualTestContext) {
    shell.update_in(visual, |s, w, cx| s.tick(false, w, cx));
    visual.run_until_parked();
    draw(visual);
}

fn inject(view: &Entity<ActivityPane>, visual: &mut VisualTestContext, frames: Vec<Value>) {
    let (sender, receiver) = std::sync::mpsc::channel();
    for frame in frames {
        sender
            .send(crate::transport::Incoming::Frame(frame))
            .unwrap();
    }
    view.update(visual, |v, _| {
        v.updates
            .subscription
            .as_mut()
            .expect("visible pane subscribes")
            .receiver = receiver;
    });
}

#[gpui::test]
fn activity_foreground_fallback_refreshes_after_two_minutes(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    activity_click(&mut visual, "activity-filter-ci");
    visual.deactivate_window();
    visual.update(|window, _| window.activate_window());
    visual.run_until_parked();
    assert!(visual.update(|window, _| window.is_window_active()));
    let view = activity_view(&shell, &mut visual);
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "empty")])
        .unwrap();
    view.update(&mut visual, |v, _| {
        v.loaded_at = Instant::now() - Duration::from_secs(121)
    });
    shell.update_in(&mut visual, |s, w, cx| s.tick(true, w, cx));
    visual.run_until_parked();
    draw(&mut visual);
    assert!(
        visual.debug_bounds("activity-empty").is_some(),
        "classic's foreground fallback must replace the old CI feed after 120 seconds"
    );
}

#[gpui::test]
fn activity_live_batches_ignore_transcripts_and_replace_retained_rows(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let mut state = State::default();
    state.bounds = [0., 0., 1680., 1050.];
    state.right_panel.visible = true;
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("live-activity.json"),
        state,
        cx,
    );
    ready(&shell, &mut visual);
    activity_click(&mut visual, "panel-launcher-more");
    activity_click(&mut visual, "panel-tool-activity");
    let view = shell.read_with(&visual, |s, _| {
        match s.content.get(&s.panel_front_key().unwrap()).unwrap() {
            Content::Activity(view) => view.clone(),
            _ => panic!("Activity must be the real right-panel surface"),
        }
    });
    activity_click(&mut visual, "activity-filter-ci");
    tick(&shell, &mut visual);
    let before = view.read_with(&visual, |v, _| v.loaded_at);
    inject(
        &view,
        &mut visual,
        vec![
            json!({"channel":"realtime","event":"batch","data":{"events":[{"channel":"history","event":"history.snapshot"}]}}),
        ],
    );
    tick(&shell, &mut visual);
    assert_eq!(
        view.read_with(&visual, |v, _| v.loaded_at),
        before,
        "transcript delivery cannot change repository activity"
    );
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "empty")])
        .unwrap();
    inject(
        &view,
        &mut visual,
        vec![
            json!({"channel":"realtime","event":"batch","data":{"events":[{"channel":"lane-lifecycle","event":"updated"}]}}),
        ],
    );
    tick(&shell, &mut visual);
    assert!(
        visual.debug_bounds("activity-empty").is_some(),
        "a live lifecycle update must replace the CI feed without a Refresh click"
    );
    assert!(view.read_with(&visual, |v, _| v.loaded_at > before));
    let main = shell.read_with(&visual, |s, _| s.active());
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "ready")])
        .unwrap();
    activity_click(&mut visual, "activity-refresh");
    activity_click(&mut visual, "activity-filter-pr");
    activity_click(&mut visual, "activity-row-pr-example/activity-7");
    activity_click(&mut visual, "activity-open-pr");
    assert_eq!(
        shell.read_with(&visual, |s, _| s.active()),
        main,
        "opening a panel PR preserves the main conversation"
    );
    assert!(shell.read_with(&visual, |s, _| {
        s.panel_front_key().is_some_and(|key| key.ends_with("|Prs"))
    }));
    assert!(visual.debug_bounds("pr-tab-summary").is_some());
    activity_click(&mut visual, "panel-pr-close-example/activity-7");
    activity_click(&mut visual, "header-right-panel");
    tick(&shell, &mut visual);
    assert!(
        view.read_with(&visual, |v, _| v.updates.subscription.is_none()),
        "covered Activity panes release their stream"
    );
}

#[gpui::test]
fn activity_refresh_queues_one_trailing_fresh_read(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    activity_click(&mut visual, "activity-filter-ci");
    let view = activity_view(&shell, &mut visual);
    let calls = || {
        fixture
            .client
            .get::<Value>("/api/activity-fixture", &[])
            .unwrap()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|path| *path == "/repos/example/activity/actions/runs")
            .count()
    };
    let before = calls();
    draw(&mut visual);
    let refresh = visual.debug_bounds("activity-refresh").unwrap().center();
    // Both presses land before the first background completion is published.
    for _ in 0..2 {
        visual.simulate_event_without_wait(gpui::MouseDownEvent {
            position: refresh,
            modifiers: gpui::Modifiers::default(),
            button: gpui::MouseButton::Left,
            click_count: 1,
            first_mouse: false,
        });
        visual.simulate_event_without_wait(gpui::MouseUpEvent {
            position: refresh,
            modifiers: gpui::Modifiers::default(),
            button: gpui::MouseButton::Left,
            click_count: 1,
        });
    }
    assert!(
        view.read_with(&visual, |v, _| v.updates.queued
            && v.updates.fresh
            && v.updates.manual),
        "a refresh during a read must retain its fresh/manual intent"
    );
    visual.run_until_parked();
    draw(&mut visual);
    assert!(view.read_with(&visual, |v, _| !v.loading
        && !v.updates.queued
        && !v.updates.fresh));
    assert_eq!(
        calls() - before,
        2,
        "one read followed by exactly one fresh trailing read"
    );
}

#[gpui::test]
fn activity_timeline_orders_instants_across_timezones(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (_shell, mut visual, _) = activity_open(&fixture, cx);
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "offset")])
        .unwrap();
    activity_click(&mut visual, "activity-refresh");
    activity_click(&mut visual, "activity-filter-all");
    let commit = visual
        .debug_bounds("activity-row-commit-example/activity-ddddddd")
        .unwrap();
    let ci = visual
        .debug_bounds("activity-row-ci-example/activity-91")
        .unwrap();
    assert!(
        commit.top() < ci.top(),
        "12:00Z must precede 15:00+04:00 (11:00Z) in a newest-first feed"
    );
}

#[gpui::test]
fn activity_first_open_uses_brokers_retained_snapshot(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let _: Value = fixture
        .client
        .get("/api/panel/prs", &[("repo", "example/activity")])
        .unwrap();
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "refused")])
        .unwrap();
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    activity_click(&mut visual, "activity-filter-pr");
    assert!(
        visual
            .debug_bounds("activity-row-pr-example/activity-7")
            .is_some(),
        "a newly opened native pane must use the server's stale snapshot when no client snapshot exists"
    );
    assert!(visual.debug_bounds("activity-github-status").is_some());
    let view = activity_view(&shell, &mut visual);
    assert!(view.read_with(&visual, |v, _| v.remote_updated.is_some()));
}

#[gpui::test]
fn activity_packets_without_event_times_keep_the_mount_timestamp(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    activity_click(&mut visual, "activity-filter-packet");
    activity_click(&mut visual, "activity-row-packet-local-activity-queued");
    let view = activity_view(&shell, &mut visual);
    let date = |visual: &VisualTestContext| {
        view.read_with(visual, |v, _| {
            v.rows
                .iter()
                .find(|r| r.id == "activity-queued")
                .unwrap()
                .date
                .clone()
        })
    };
    let first = date(&visual);
    assert!(
        crate::clock::timestamp(&first)
            .is_some_and(|time| crate::clock::now().saturating_sub(time) < 30),
        "an undated packet belongs in Today, like classic's per-mount fallback"
    );
    activity_click(&mut visual, "activity-refresh");
    assert_eq!(
        date(&visual),
        first,
        "refresh must not make an undated packet look newly created"
    );
}

#[gpui::test]
fn activity_live_refresh_respects_list_cooldown_but_manual_retry_can_recover(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    activity_click(&mut visual, "activity-filter-ci");
    let view = activity_view(&shell, &mut visual);
    tick(&shell, &mut visual);
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "refused")])
        .unwrap();
    activity_click(&mut visual, "activity-refresh");
    let before: Value = fixture.client.get("/api/activity-fixture", &[]).unwrap();
    inject(
        &view,
        &mut visual,
        vec![
            json!({"channel":"realtime","event":"batch","data":{"events":[{"channel":"lane-lifecycle","event":"updated"}]}}),
        ],
    );
    tick(&shell, &mut visual);
    let after: Value = fixture.client.get("/api/activity-fixture", &[]).unwrap();
    assert_eq!(
        before["calls"], after["calls"],
        "lifecycle updates must not evade a repository's list cooldown"
    );
    assert!(
        visual
            .debug_bounds("activity-row-ci-example/activity-91")
            .is_some(),
        "cooldown retains the known CI row"
    );
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "empty")])
        .unwrap();
    activity_click(&mut visual, "activity-retry");
    assert!(
        visual.debug_bounds("activity-empty").is_some(),
        "the explicit Retry can recover before the old cooldown expires"
    );
}

#[gpui::test]
fn activity_registry_failure_keeps_the_known_repository_feed(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    activity_click(&mut visual, "activity-filter-pr");
    let view = activity_view(&shell, &mut visual);
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "repos-refused")])
        .unwrap();
    activity_click(&mut visual, "activity-refresh");
    assert!(
        visual
            .debug_bounds("activity-row-pr-example/activity-7")
            .is_some(),
        "registry failure must not turn a known remote repository into a local-only folder"
    );
    assert!(view.read_with(&visual, |v, _| {
        v.errors
            .iter()
            .any(|e| e.starts_with("Repository list unavailable"))
    }));
}

#[gpui::test]
fn activity_panel_opens_before_the_workspace_has_saved_view_state(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let mut state = State::default();
    state.bounds = [0., 0., 1680., 1050.];
    state.right_panel.visible = true;
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("activity-unsaved.json"),
        state,
        cx,
    );
    ready(&shell, &mut visual);
    shell.update(&mut visual, |s, _| {
        s.state
            .workspaces
            .remove(s.state.selected.as_ref().unwrap());
    });
    activity_click(&mut visual, "panel-launcher-more");
    activity_click(&mut visual, "panel-tool-activity");
    assert!(
        visual.debug_bounds("activity-pane").is_some(),
        "Activity only needs the selected folder, not a previously saved chat tab"
    );
    activity_click(&mut visual, "activity-filter-ci");
    activity_click(&mut visual, "activity-row-ci-example/activity-91");
    assert!(visual.debug_bounds("activity-ci-job-0").is_some());
}

#[gpui::test]
fn activity_pr_preview_keeps_classics_six_file_limit(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (_shell, mut visual, _) = activity_open(&fixture, cx);
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "many-files")])
        .unwrap();
    activity_click(&mut visual, "activity-refresh");
    activity_click(&mut visual, "activity-filter-pr");
    activity_click(&mut visual, "activity-row-pr-example/activity-7");
    assert!(visual.debug_bounds("activity-pr-file-5").is_some());
    assert!(
        visual.debug_bounds("activity-pr-file-6").is_none(),
        "the full file list belongs in PR details"
    );
}

#[gpui::test]
fn activity_idle_maintenance_does_not_reload_auxiliary_drawers(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    activity_click(&mut visual, "activity-filter-ci");
    let view = activity_view(&shell, &mut visual);
    tick(&shell, &mut visual);
    inject(
        &view,
        &mut visual,
        vec![
            json!({"channel":"realtime","event":"batch","data":{"events":[{"channel":"history","event":"history.snapshot"}]}}),
        ],
    );
    tick(&shell, &mut visual);
    let before = view.read_with(&visual, |v, _| v.revision);
    for _ in 0..3 {
        shell.update_in(&mut visual, |s, w, cx| s.tick(true, w, cx));
        visual.run_until_parked();
        draw(&mut visual);
    }
    assert_eq!(
        view.read_with(&visual, |v, _| v.revision),
        before,
        "idle maintenance must not fetch and repaint unchanged Activity drawers each second"
    );
}

#[gpui::test]
fn activity_background_window_uses_five_minute_fallback(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    activity_click(&mut visual, "activity-filter-ci");
    let view = activity_view(&shell, &mut visual);
    tick(&shell, &mut visual);
    inject(&view, &mut visual, vec![]);
    visual.deactivate_window();
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "empty")])
        .unwrap();
    view.update(&mut visual, |v, _| {
        v.loaded_at = Instant::now() - Duration::from_secs(121)
    });
    tick(&shell, &mut visual);
    assert!(
        visual
            .debug_bounds("activity-row-ci-example/activity-91")
            .is_some(),
        "inactive windows must not use the two-minute foreground fallback"
    );
    view.update(&mut visual, |v, _| {
        v.loaded_at = Instant::now() - Duration::from_secs(301)
    });
    tick(&shell, &mut visual);
    assert!(visual.debug_bounds("activity-empty").is_some());
}

#[gpui::test]
fn activity_pr_destination_honors_the_saved_browser_preference(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "browser-pr")])
        .unwrap();
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    activity_click(&mut visual, "activity-filter-pr");
    activity_click(&mut visual, "activity-row-pr-example/activity-7");
    activity_click(&mut visual, "activity-open-pr");
    assert_eq!(
        visual.opened_url().as_deref(),
        Some("https://github.com/example/activity/pull/7")
    );
    assert_eq!(
        shell.read_with(&visual, |s, _| s.active()),
        Some(Tab::Activity)
    );
}
