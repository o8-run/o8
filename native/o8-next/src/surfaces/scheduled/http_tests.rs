use super::*;
use crate::shell::test_support::{Fixture, TestAppContext, VisualTestContext, draw, open, ready};

fn settle(view: &Entity<Scheduled>, cx: &mut VisualTestContext) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        cx.run_until_parked();
        draw(cx);
        if !view.read_with(cx, |view, _| view.in_flight || view.computer_in_flight) {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!(
        "the Scheduled HTTP load did not settle (loading, in_flight, local error, connected error): {:?}",
        view.read_with(cx, |view, _| (
            view.loading,
            view.in_flight,
            view.error.clone(),
            view.connected
                .as_ref()
                .and_then(|result| result.as_ref().err())
                .cloned()
        ))
    );
}

fn fixture_state(fixture: &Fixture) -> Value {
    fixture
        .client
        .get("/api/scheduled-fixture", &[])
        .unwrap()
}

#[gpui::test]
fn scheduled_reads_this_macs_jobs_on_open_and_refresh_but_not_on_the_tick(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--scheduled");
    let (view, cx) =
        cx.add_window_view(|window, cx| Scheduled::new(fixture.client.clone(), window, cx));
    settle(&view, cx);
    let state = fixture_state(&fixture);
    assert_eq!(state["computer"], 1, "opening the page reads this Mac's jobs once");
    assert_eq!(
        state["computerForeground"], "0",
        "the read is the app's own, so it does not wake a resting server"
    );
    assert_eq!(view.read_with(cx, |view, _| view.computer_jobs().len()), 2);
    draw(cx);
    assert!(cx.debug_bounds("scheduled-computer-com.example.syncer").is_some());
    assert!(cx.debug_bounds("scheduled-computer-backup").is_some());

    view.update(cx, |view, cx| {
        view.fetched = Some(Instant::now() - REFRESH);
        view.tick(true, cx);
    });
    settle(&view, cx);
    let state = fixture_state(&fixture);
    assert_eq!(state["lists"], 2, "the 15-second tick still reads automations");
    assert_eq!(state["computer"], 1, "the tick never reads this Mac's jobs");

    view.update(cx, |view, cx| view.refresh(cx));
    settle(&view, cx);
    assert_eq!(fixture_state(&fixture)["computer"], 2, "Refresh reads them again");
}

#[test]
fn this_macs_rows_say_what_runs_and_never_more() {
    let job = json!({
        "label": "com.example.syncer", "scope": "system-daemon", "program": "/opt/tools/bin/syncer",
        "triggers": ["keep alive", "run at load"], "running": true, "pid": 812, "runs": 14,
        "lastExit": "0", "loaded": true, "disabled": false,
        "maker": { "kind": "app", "name": "Example" },
    });
    assert_eq!(
        computer::computer_about(&job),
        "/opt/tools/bin/syncer · keep alive, run at load · Example"
    );
    assert_eq!(computer::computer_status(&job).0, "Running · pid 812");
    assert_eq!(computer::computer_facts(&job), "System daemon · 14 runs");
    let failed = json!({ "running": false, "lastExit": "78", "loaded": true });
    assert_eq!(computer::computer_status(&failed).0, "Exit 78");
}

fn requests(fixture: &Fixture, mode: Option<&str>) -> u64 {
    let query = mode.map(|mode| vec![("mode", mode)]).unwrap_or_default();
    let state: Value = fixture
        .client
        .get("/api/scheduled-fixture", &query)
        .unwrap();
    state["lists"].as_u64().unwrap()
}

#[gpui::test]
fn scheduled_periodic_ticks_respect_refresh_interval(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--scheduled");
    let (view, cx) =
        cx.add_window_view(|window, cx| Scheduled::new(fixture.client.clone(), window, cx));
    settle(&view, cx);
    assert_eq!(requests(&fixture, None), 1);
    for refresh in [true, false, true, false, true] {
        view.update(cx, |view, cx| view.tick(refresh, cx));
        settle(&view, cx);
    }
    assert_eq!(
        requests(&fixture, None),
        1,
        "shell wake ticks must not bypass the 15-second cadence"
    );
    view.update(cx, |view, cx| {
        view.fetched = Some(Instant::now() - REFRESH);
        view.tick(true, cx);
        view.tick(true, cx);
        view.tick(false, cx);
    });
    settle(&view, cx);
    assert_eq!(
        requests(&fixture, None),
        2,
        "a due refresh must coalesce concurrent ticks"
    );
}

#[gpui::test]
fn scheduled_connected_failure_retains_recent_rows(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--scheduled");
    let (view, cx) =
        cx.add_window_view(|window, cx| Scheduled::new(fixture.client.clone(), window, cx));
    settle(&view, cx);
    assert_eq!(view.read_with(cx, |view, _| view.connected_jobs().len()), 1);
    requests(&fixture, Some("fail"));
    view.update(cx, |view, cx| view.load(cx));
    settle(&view, cx);
    assert_eq!(
        view.read_with(cx, |view, _| view.connected_jobs().len()),
        1,
        "a failed production GET must retain the last recent successful schedule"
    );
    assert!(
        cx.debug_bounds("scheduled-connected-fixture-nightly")
            .is_some()
    );
    requests(&fixture, Some("empty"));
    view.update(cx, |view, cx| view.load(cx));
    settle(&view, cx);
    assert_eq!(
        view.read_with(cx, |view, _| view.connected_jobs().len()),
        0,
        "a verified empty result must clear old rows"
    );
    requests(&fixture, Some("ok"));
    view.update(cx, |view, cx| view.load(cx));
    settle(&view, cx);
    assert_eq!(view.read_with(cx, |view, _| view.connected_jobs().len()), 1);
}

#[gpui::test]
fn scheduled_read_only_rows_have_no_pause_action(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--scheduled");
    let (view, cx) =
        cx.add_window_view(|window, cx| Scheduled::new(fixture.client.clone(), window, cx));
    settle(&view, cx);
    view.update(cx, |view, cx| {
        view.connected = Some(Ok(json!({ "available": true, "jobs": [
            { "id": "codex-a", "name": "Nightly check", "agentId": "codex",
              "enabled": true, "readOnly": true, "schedule": { "label": "Daily at 02:43" } },
        ] })));
        cx.notify();
    });
    draw(cx);
    assert!(cx.debug_bounds("scheduled-job-codex-a").is_some());
    assert!(cx.debug_bounds("scheduled-connected-codex-a").is_none());
}

#[gpui::test]
fn scheduled_explicit_refresh_remains_immediate(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--scheduled");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("refresh.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("s c h e d u l e d enter");
    let view = shell.read_with(&visual, |shell, _| {
        let Content::Scheduled(view) = shell.content.get(&shell.key(&Tab::Scheduled)).unwrap()
        else {
            panic!("Scheduled must be reached through the real shell")
        };
        view.clone()
    });
    settle(&view, &mut visual);
    let before = requests(&fixture, None);
    // The real shell's Refresh command calls this same surface hook.
    shell.update(&mut visual, |_, cx| {
        <Scheduled as ShellView>::refresh(&view, cx)
    });
    settle(&view, &mut visual);
    assert_eq!(requests(&fixture, None), before + 1);
}
