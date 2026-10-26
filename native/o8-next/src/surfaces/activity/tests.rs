use super::*;
use crate::shell::test_support::*;

#[gpui::test]
fn activity_palette_reaches_native_pane(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = fixture.root.join("activity.json");
    State::default().save(&file).unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        file.clone(),
        State::load(&file).unwrap(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    let labels = shell.read_with(cx, |shell, _| {
        shell
            .commands()
            .iter()
            .map(|command| command.label(&shell.sessions))
            .collect::<Vec<_>>()
    });
    assert!(
        labels.iter().any(|label| label == "Open Activity"),
        "Activity must be registered in the shell palette"
    );
    assert!(cx.debug_bounds("activity-pane").is_none());

    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("a c t i v i t y enter");
    cx.run_until_parked();
    draw(cx);
    assert!(
        cx.debug_bounds("activity-pane").is_some(),
        "Activity command must open a native pane through the real shell palette"
    );
    let saved = State::load(&file).unwrap();
    let workspace = &saved.workspaces[saved.selected.as_ref().unwrap()];
    assert_eq!(workspace.tabs[workspace.active], Tab::Activity);
}

pub(super) fn activity_open(
    fixture: &Fixture,
    cx: &mut TestAppContext,
) -> (Entity<Shell>, VisualTestContext, (f64, f64)) {
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("activity.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("a c t i v i t y");
    let started = Instant::now();
    visual.simulate_keystrokes("enter");
    draw(&mut visual);
    let first_frame = started.elapsed().as_secs_f64() * 1000.;
    visual.run_until_parked();
    draw(&mut visual);
    ready(&shell, &mut visual);
    assert!(
        visual.debug_bounds("activity-pane").is_some(),
        "Activity must be reachable from the real shell"
    );
    let content_frame = started.elapsed().as_secs_f64() * 1000.;
    (shell, visual, (first_frame, content_frame))
}
pub(super) fn activity_click(cx: &mut VisualTestContext, selector: &'static str) -> f64 {
    draw(cx);
    let bounds = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("Missing control: {selector}"));
    let start = Instant::now();
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    draw(cx);
    start.elapsed().as_secs_f64() * 1000.
}

#[gpui::test]
fn activity_feed_details_filters_and_links(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (shell, mut visual, opened) = activity_open(&fixture, cx);
    let cx = &mut visual;
    let mut interactions = vec![
        activity_click(cx, "activity-scope-all"),
        activity_click(cx, "activity-scope-0"),
    ];
    for selector in [
        "activity-filter-commit",
        "activity-filter-pr",
        "activity-filter-issue",
        "activity-filter-ci",
        "activity-filter-packet",
        "activity-filter-all",
    ] {
        interactions.push(activity_click(cx, selector));
    }
    activity_click(cx, "activity-filter-ci");
    let snapshot: Value = fixture.client.get("/api/activity-fixture", &[]).unwrap();
    assert!(
        !snapshot["calls"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "/repos/example/activity/actions/runs/91"),
        "CI details must stay lazy"
    );
    interactions.push(activity_click(cx, "activity-row-ci-example/activity-91"));
    assert!(cx.debug_bounds("activity-ci-job-0").is_some());
    activity_click(cx, "activity-ci-retry");
    activity_click(cx, "activity-open-run");
    assert_eq!(
        cx.opened_url().as_deref(),
        Some("https://github.com/example/activity/actions/runs/91")
    );
    activity_click(cx, "activity-open-ci-pr-7");
    assert_eq!(
        cx.opened_url().as_deref(),
        Some("https://github.com/example/activity/pull/7")
    );
    activity_click(cx, "activity-filter-pr");
    activity_click(cx, "activity-row-pr-example/activity-7");
    assert!(cx.debug_bounds("activity-pr-file-0").is_some());
    activity_click(cx, "activity-open-pr");
    assert_eq!(
        cx.opened_url().as_deref(),
        Some("https://github.com/example/activity/pull/7")
    );
    activity_click(cx, "activity-filter-issue");
    activity_click(cx, "activity-row-issue-example/activity-8");
    activity_click(cx, "activity-open-issue");
    assert_eq!(
        cx.opened_url().as_deref(),
        Some("https://github.com/example/activity/issues/8")
    );
    activity_click(cx, "activity-filter-commit");
    activity_click(cx, "activity-row-commit-example/activity-ddddddd");
    activity_click(cx, "activity-open-commit");
    activity_click(cx, "activity-filter-packet");
    activity_click(cx, "activity-row-packet-local-activity-packet");
    activity_click(cx, "activity-open-worker");
    ready(&shell, cx);
    assert!(matches!(
        shell.read_with(cx, |s, _| s.active()),
        Some(Tab::Session(_))
    ));
    let snapshot: Value = fixture.client.get("/api/activity-fixture", &[]).unwrap();
    let calls = snapshot["calls"].as_array().unwrap();
    assert!(
        calls
            .iter()
            .any(|p| p == "/repos/example/activity/actions/runs/91/jobs")
    );
    assert!(
        calls
            .iter()
            .any(|p| p == "/repos/example/activity/pulls/7/files")
    );
    println!(
        "O8_NEXT_ACTIVITY_EVIDENCE {}",
        json!({"platform":std::env::consts::OS,
        "endpoint":"headless GPUI CPU scene paint, fixture HTTP, no compositor", "openToFirstFrameMs":opened.0,"openToContentFrameMs":opened.1,
        "interactionToFrameMs":interactions})
    );
}

#[gpui::test]
fn activity_ci_refusal_retains_details_and_manual_retry(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    let cx = &mut visual;
    activity_click(cx, "activity-filter-ci");
    activity_click(cx, "activity-row-ci-example/activity-91");
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "refused")])
        .unwrap();
    activity_click(cx, "activity-ci-retry");
    assert!(cx.debug_bounds("activity-detail-delayed").is_some());
    assert!(
        cx.debug_bounds("activity-ci-job-0").is_some(),
        "A refused refresh retains last known CI details"
    );
    let before: Value = fixture.client.get("/api/activity-fixture", &[]).unwrap();
    activity_click(cx, "activity-row-ci-example/activity-91");
    activity_click(cx, "activity-row-ci-example/activity-91");
    let after: Value = fixture.client.get("/api/activity-fixture", &[]).unwrap();
    assert_eq!(
        before["calls"], after["calls"],
        "403/429 pause automatic refetch; expansion must not evade backoff"
    );
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "malformed")])
        .unwrap();
    activity_click(cx, "activity-ci-retry");
    assert!(
        cx.debug_bounds("activity-detail-delayed").is_some(),
        "Reject a detail response for a different run"
    );
    assert!(cx.debug_bounds("activity-ci-job-0").is_some());
    let view = activity_view(&shell, cx);
    assert!(view.read_with(cx, |v, _| {
        v.details
            .values()
            .any(|d| d.error.as_deref() == Some("Invalid Activity response"))
    }));
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "ready")])
        .unwrap();
    view.update(cx, |v, _| {
        for detail in v.details.values_mut() {
            detail.retry_at = Some(Instant::now() - Duration::from_secs(1));
        }
    });
    shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
    cx.run_until_parked();
    draw(cx);
    assert!(
        view.read_with(cx, |v, _| v.details.values().all(|d| d.error.is_none())),
        "An active expanded CI row must recover when the refusal cooldown expires"
    );
}

#[gpui::test]
fn activity_packet_hold_release_and_stop_mission(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (_, mut visual, _) = activity_open(&fixture, cx);
    let cx = &mut visual;
    activity_click(cx, "activity-filter-packet");
    activity_click(cx, "activity-row-packet-local-activity-queued");
    activity_click(cx, "activity-hold");
    let state: Value = fixture.client.get("/api/orchestrator/state", &[]).unwrap();
    assert_eq!(state["mission"]["packets"][0]["queueState"], "held");
    activity_click(cx, "activity-release");
    let state: Value = fixture.client.get("/api/orchestrator/state", &[]).unwrap();
    assert_eq!(state["mission"]["packets"][0]["queueState"], "queued");
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "stop-ready")])
        .unwrap();
    activity_click(cx, "activity-stop-mission");
    let state: Value = fixture.client.get("/api/orchestrator/state", &[]).unwrap();
    assert_eq!(state["mission"]["packets"][0]["queueState"], "held");
    let origin = fixture
        .client
        .get::<Value>("/api/activity-fixture", &[])
        .unwrap();
    assert!(origin["repo"].is_string());
}

pub(super) fn activity_view(
    shell: &Entity<Shell>,
    cx: &mut VisualTestContext,
) -> Entity<ActivityPane> {
    shell.read_with(cx, |s, _| {
        match s.content.get(&s.key(&Tab::Activity)).unwrap() {
            Content::Activity(a) => a.clone(),
            _ => panic!("Activity"),
        }
    })
}

#[gpui::test]
fn activity_stop_replays_lost_response_with_one_identity(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    let cx = &mut visual;
    let view = activity_view(&shell, cx);
    activity_click(cx, "activity-filter-packet");
    activity_click(cx, "activity-row-packet-local-activity-queued");
    activity_click(cx, "activity-hold");
    activity_click(cx, "activity-release");
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "drop-stop")])
        .unwrap();
    activity_click(cx, "activity-stop-mission");
    assert_eq!(
        view.read_with(cx, |v, _| v.notice.clone()),
        "Decision applied."
    );
    let receipt: Value = fixture.client.get("/api/activity-fixture", &[]).unwrap();
    let bodies = receipt["mutations"].as_array().unwrap();
    assert!(
        bodies.len() >= 2,
        "Lost stop receipt must reconcile through the same production route"
    );
    assert!(
        bodies.iter().all(|body| body == &bodies[0]),
        "Receipt polling must reuse the exact mutation body"
    );
}

#[gpui::test]
fn activity_empty_local_auth_and_scoped_retention(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    let cx = &mut visual;
    let view = activity_view(&shell, cx);
    let original_count = view.read_with(cx, |v, _| v.rows.len());
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "refused")])
        .unwrap();
    activity_click(cx, "activity-refresh");
    assert_eq!(
        view.read_with(cx, |v, _| v.rows.len()),
        original_count,
        "Retain remote streams on a refused refresh"
    );
    assert!(view.read_with(cx, |v, _| {
        v.errors
            .iter()
            .any(|s| s.starts_with("GitHub sync delayed"))
    }));
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "empty")])
        .unwrap();
    activity_click(cx, "activity-refresh");
    activity_click(cx, "activity-filter-ci");
    assert!(
        view.read_with(cx, |v, _| v.rows.iter().all(|r| r.kind != "ci")),
        "Successful empty replaces a retained remote stream"
    );
    assert!(cx.debug_bounds("activity-empty").is_some());
    let unauthorized =
        Client::authenticated(&fixture.origin, Some("fixture-invalid-operator".into())).unwrap();
    view.update(cx, |v, _| v.client = unauthorized);
    activity_click(cx, "activity-filter-packet");
    activity_click(cx, "activity-row-packet-local-activity-queued");
    activity_click(cx, "activity-hold");
    assert!(view.read_with(cx, |v, _| v.notice.contains("HTTP 401")));
    let state: Value = fixture.client.get("/api/orchestrator/state", &[]).unwrap();
    assert_eq!(
        state["mission"]["packets"][0]["queueState"], "queued",
        "Refused UI mutation must not change persisted state"
    );
    // An unregistered local-only workspace never acquires the previous remote feed.
    view.update(cx, |v, _| v.client = fixture.client.clone());
    activity_click(cx, "workspace-switcher");
    activity_click(cx, "command-1");
    ready(&shell, cx);
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("a c t i v i t y enter");
    ready(&shell, cx);
    let second = activity_view(&shell, cx);
    activity_click(cx, "activity-filter-pr");
    assert!(second.read_with(cx, |v, _| {
        v.rows
            .iter()
            .all(|r| !matches!(r.kind, "pr" | "ci" | "issue"))
    }));
    assert!(cx.debug_bounds("activity-empty").is_some());
    let file = fixture.root.join("activity.json");
    assert!(
        State::load(&file)
            .unwrap()
            .workspaces
            .values()
            .any(|w| w.tabs.contains(&Tab::Activity))
    );
}

#[gpui::test]
fn activity_loading_error_and_keyboard_controls(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let unauthorized =
        Client::authenticated(&fixture.origin, Some("fixture-invalid-operator".into())).unwrap();
    let handle = cx.add_window(|window, cx| {
        let view = ActivityPane::new(unauthorized, String::new(), cx);
        view.focus(window);
        view
    });
    let view = handle.root(cx).unwrap();
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    let visual = &mut visual;
    assert!(view.read_with(visual, |v, _| v.loading));
    draw(visual);
    assert!(visual.debug_bounds("activity-loading").is_some());
    visual.run_until_parked();
    draw(visual);
    assert!(view.read_with(visual, |v, _| !v.loading
        && !v.errors.is_empty()
        && v.rows.is_empty()));
    visual.simulate_keystrokes("tab tab enter");
    draw(visual);
    assert!(view.read_with(visual, |v, _| v.filter == "all"));
    visual.simulate_keystrokes("tab enter");
    draw(visual);
    assert!(
        view.read_with(visual, |v, _| v.filter == "commit"),
        "Native filters must be reachable by keyboard"
    );
}

#[gpui::test]
fn activity_short_commit_prefix_keeps_ci_detail_reachable(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity");
    let (_, mut visual, _) = activity_open(&fixture, cx);
    let cx = &mut visual;
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "prefix")])
        .unwrap();
    activity_click(cx, "activity-refresh");
    activity_click(cx, "activity-filter-ci");
    // Desktop groups equal normalized SHAs. A seven-character commit prefix
    // must not absorb a forty-character CI identity and hide its detail action.
    activity_click(cx, "activity-row-ci-example/activity-91");
    assert!(cx.debug_bounds("activity-ci-job-0").is_some());
}

#[gpui::test]
fn activity_fork_commits_keep_their_own_ci_badges(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--activity --activity-forks");
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    let cx = &mut visual;
    let _: Value = fixture
        .client
        .get("/api/activity-fixture", &[("mode", "forks")])
        .unwrap();
    activity_click(cx, "activity-scope-all");
    activity_click(cx, "activity-filter-ci");
    let view = activity_view(&shell, cx);
    let badges = view.read_with(cx, |v, _| {
        v.rows
            .iter()
            .filter(|row| row.kind == "commit" && row.id == "ddddddd")
            .map(|row| {
                (
                    row.repo.clone().unwrap(),
                    row.ci
                        .as_ref()
                        .map(|ci| ci.data["conclusion"].as_str().unwrap().to_owned()),
                )
            })
            .collect::<std::collections::BTreeMap<_, _>>()
    });
    assert_eq!(
        badges,
        std::collections::BTreeMap::from([
            ("example/activity".to_owned(), Some("failure".to_owned())),
            (
                "example/activity-fork".to_owned(),
                Some("success".to_owned())
            ),
        ]),
        "Forks sharing a SHA must retain separate commit rows and repository-owned CI badges"
    );
}

fn activity_open_fork_commits(
    cx: &mut TestAppContext,
) -> (Fixture, Entity<Shell>, VisualTestContext, Vec<feed::Row>) {
    let fixture = Fixture::start_mode(false, "--activity --activity-forks");
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    activity_click(&mut visual, "activity-scope-all");
    activity_click(&mut visual, "activity-filter-commit");
    let view = activity_view(&shell, &mut visual);
    let rows = view.read_with(&visual, |view, _| {
        view.rows
            .iter()
            .filter(|row| row.kind == "commit" && row.id == "ddddddd")
            .cloned()
            .collect::<Vec<_>>()
    });
    assert_eq!(rows.len(), 2);
    assert_ne!(rows[0].repo, rows[1].repo);
    (fixture, shell, visual, rows)
}

#[gpui::test]
fn activity_fork_commit_clicks_expand_the_selected_repository(cx: &mut TestAppContext) {
    let (_fixture, shell, mut visual, rows) = activity_open_fork_commits(cx);
    let view = activity_view(&shell, &mut visual);
    let row_ids = view.read_with(&visual, |view, _| {
        view.controls.iter().filter_map(|(id, action)| {
            matches!(action, pane::Action::Expand(row) if row.kind == "commit" && row.id == "ddddddd")
                .then_some(id.clone())
        }).collect::<std::collections::BTreeSet<_>>()
    });
    assert_eq!(
        row_ids.len(),
        2,
        "Both forks must have independently addressable GPUI row controls"
    );
    for row in &rows {
        let selector = match row.repo.as_deref() {
            Some("example/activity") => "activity-row-commit-example/activity-ddddddd",
            Some("example/activity-fork") => "activity-row-commit-example/activity-fork-ddddddd",
            _ => panic!("unexpected fixture repository"),
        };
        draw(&mut visual);
        let bounds = visual.debug_bounds(selector).expect("fork commit control");
        visual.simulate_click(bounds.center(), gpui::Modifiers::default());
        visual.run_until_parked();
        draw(&mut visual);
        assert_eq!(
            view.read_with(&visual, |view, _| view.expanded.clone()),
            Some(row.key()),
            "Clicking a fork must expand that repository's commit"
        );
        let url = row.url().unwrap();
        assert!(view.read_with(&visual, |view, _| view.controls.iter().any(
            |(_, action)| { matches!(action, pane::Action::Link(target) if target == &url) }
        )));
    }
    visual.simulate_keystrokes("space");
    draw(&mut visual);
    assert_eq!(
        view.read_with(&visual, |view, _| view.expanded.clone()),
        None,
        "A clicked fork must also own the keyboard selection"
    );
}

#[gpui::test]
fn activity_fork_keyboard_focus_stays_on_the_selected_row(cx: &mut TestAppContext) {
    let (_fixture, shell, mut visual, rows) = activity_open_fork_commits(cx);
    let view = activity_view(&shell, &mut visual);
    let first = view.read_with(&visual, |view, _| {
        view.controls.iter().position(|(_, action)| {
            matches!(action, pane::Action::Expand(row) if row.key() == rows[0].key())
        }).unwrap()
    });
    visual.simulate_keystrokes("escape");
    for _ in 0..=first {
        visual.simulate_keystrokes("tab");
    }
    visual.simulate_keystrokes("enter");
    draw(&mut visual);
    assert_eq!(
        view.read_with(&visual, |view, _| view.expanded.clone()),
        Some(rows[0].key())
    );
    // Skip the first commit's link, then open the second row. Its position moves
    // when the first detail closes; the next Space must still act on that row.
    visual.simulate_keystrokes("tab tab enter");
    draw(&mut visual);
    assert_eq!(
        view.read_with(&visual, |view, _| view.expanded.clone()),
        Some(rows[1].key())
    );
    visual.simulate_keystrokes("space");
    draw(&mut visual);
    assert_eq!(
        view.read_with(&visual, |view, _| view.expanded.clone()),
        None,
        "Opening another fork must keep keyboard focus on its repository-qualified row"
    );
}
