use super::*;
use crate::shell::test_support::open;
use crate::shell::test_support::*;
fn click(v: &mut VisualTestContext, id: &'static str) {
    draw(v);
    let b = v.debug_bounds(id).unwrap_or_else(|| panic!("Missing {id}"));
    v.simulate_click(b.center(), gpui::Modifiers::default());
    v.run_until_parked();
    draw(v);
}
#[gpui::test]
fn resources_opens_from_launcher_and_shows_live_metrics(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--resources");
    let mut state = crate::shell_state::State::default();
    state.right_panel.visible = true;
    let (s, mut v) = open(f.client.clone(), f.root.join("resources.json"), state, cx);
    v.simulate_resize(gpui::size(px(1680.), px(1050.)));
    ready(&s, &mut v);
    click(&mut v, "panel-launcher-more");
    click(&mut v, "panel-tool-resources");
    s.update_in(&mut v, |s, w, cx| s.tick(true, w, cx));
    v.run_until_parked();
    draw(&mut v);
    assert!(
        v.debug_bounds("resources-total").is_some(),
        "Resources must render real metrics rather than a placeholder"
    );
    let initial = s.read_with(&v, |s, _| resources::probe(s));
    assert_eq!(initial["data"]["sessions"][0]["key"], "session-heavy");
    assert_eq!(initial["data"]["sessions"][0]["cpuPercent"], 41.);
    assert!(initial["data"]["sessions"][1]["memBytes"].is_null());
    assert!(v.debug_bounds("resource-row-process-small").is_some());
    assert!(v.debug_bounds("resource-stop-session-unknown").is_none());
    assert!(v.debug_bounds("resource-confirm-session-unknown").is_none());
    assert!(
        v.debug_bounds("resource-row-session-heavy").unwrap().top()
            < v.debug_bounds("resource-row-session-unknown")
                .unwrap()
                .top()
    );
    let machine = v
        .debug_bounds("resources-machine")
        .expect("the Machine section renders");
    assert!(
        machine.top() < v.debug_bounds("resource-row-session-heavy").unwrap().top(),
        "Machine sits above the per-session rows"
    );
    for meter in [
        "resources-meter-cpu",
        "resources-meter-memory",
        "resources-meter-swap",
        "resources-meter-disk-data",
        "resources-meter-disk-projects",
        "resources-meter-network",
    ] {
        assert!(v.debug_bounds(meter).is_some(), "{meter}");
    }
    assert!(v.debug_bounds("resources-sparkline").is_some());
    assert_eq!(initial["history"], json!([23.]));
    let reads = snapshot(&f)["reads"].clone();
    for _ in 0..3 {
        tick(&s, &mut v);
    }
    assert_eq!(
        snapshot(&f)["reads"],
        reads,
        "maintenance ticks must not poll every frame or second"
    );
    mode(&f, "changed");
    refresh(&s, &mut v);
    assert_eq!(
        s.read_with(&v, |s, _| resources::probe(s))["data"]["sessions"][0]["cpuPercent"],
        72.
    );
    assert_eq!(
        s.read_with(&v, |s, _| resources::probe(s))["history"],
        json!([23., 64.]),
        "each new machine sample extends the sparkline"
    );
    for failure in ["failed", "payload-error"] {
        mode(&f, failure);
        refresh(&s, &mut v);
        assert!(v.debug_bounds("resources-error").is_some());
        assert_eq!(
            s.read_with(&v, |s, _| resources::probe(s))["data"]["sessions"][0]["cpuPercent"],
            72.,
            "failed readings must retain known metrics"
        );
    }
    mode(&f, "ready");
    click(&mut v, "resources-retry");
    assert!(v.debug_bounds("resources-error").is_none());
    click(&mut v, "resource-stop-session-heavy");
    assert_eq!(
        snapshot(&f)["stops"].as_array().unwrap().len(),
        0,
        "Stop must require a second explicit confirmation"
    );
    click(&mut v, "resource-cancel-session-heavy");
    assert!(v.debug_bounds("resource-confirm-session-heavy").is_none());
    mode(&f, "stop-refused");
    click(&mut v, "resource-stop-session-heavy");
    click(&mut v, "resource-confirm-session-heavy");
    assert!(
        v.debug_bounds("resources-error").is_some(),
        "show a refused stop instead of claiming success"
    );
    assert_eq!(
        snapshot(&f)["stops"][0],
        json!({"key":"session-heavy","pid":424242})
    );
    mode(&f, "ready");
    click(&mut v, "resources-retry");
    let before_stop = snapshot(&f)["reads"].as_u64().unwrap();
    click(&mut v, "resource-stop-session-heavy");
    click(&mut v, "resource-confirm-session-heavy");
    assert_eq!(snapshot(&f)["stops"].as_array().unwrap().len(), 2);
    assert!(
        snapshot(&f)["reads"].as_u64().unwrap() > before_stop,
        "a successful stop must reread the process snapshot"
    );
    mode(&f, "empty");
    refresh(&s, &mut v);
    assert!(v.debug_bounds("resources-empty").is_some());
    std::thread::sleep(std::time::Duration::from_millis(300));
    click(&mut v, "header-right-panel");
    tick(&s, &mut v);
    let reads = snapshot(&f)["reads"].clone();
    refresh(&s, &mut v);
    assert_eq!(
        snapshot(&f)["reads"],
        reads,
        "covered Resources must pause polling"
    );
    mode(&f, "changed");
    std::thread::sleep(std::time::Duration::from_millis(300));
    click(&mut v, "header-right-panel");
    tick(&s, &mut v);
    assert!(
        v.debug_bounds("resource-row-session-heavy").is_some(),
        "reopening must read again"
    );
}

fn snapshot(f: &Fixture) -> Value {
    f.client.get("/api/resources-fixture", &[]).unwrap()
}
fn mode(f: &Fixture, mode: &str) {
    let _: Value = f
        .client
        .get("/api/resources-fixture", &[("mode", mode)])
        .unwrap();
}
fn tick(s: &Entity<Shell>, v: &mut VisualTestContext) {
    s.update_in(v, |s, w, cx| s.tick(true, w, cx));
    v.run_until_parked();
    draw(v);
}
fn refresh(s: &Entity<Shell>, v: &mut VisualTestContext) {
    s.update(v, |s, _| resources::due(s));
    tick(s, v);
}
