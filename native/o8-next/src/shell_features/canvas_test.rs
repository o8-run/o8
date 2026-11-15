use super::*;
use crate::shell::test_support::*;
use serde_json::json;
struct CanvasTests;
register_shell_feature!(CanvasTests);
impl ShellFeature for CanvasTests {}

/// Opens the shell with the canvas preference set, waits for its one start-up
/// read to answer, then asks for Canvas.
fn open_with_setting(on: bool, cx: &mut TestAppContext) -> (Entity<Shell>, VisualTestContext) {
    let f = Fixture::start(true);
    f.client
        .project_request(
            "POST",
            "/api/panel/operator-defaults",
            &json!({"experimentalCanvas":on}),
        )
        .unwrap();
    let (s, mut v) = open_past_setup(
        f.client.clone(),
        f.root.join("canvas.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&s, &mut v);
    // The read goes to a real server, so wait on its answer with a deadline.
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while !s.read_with(&v, |s, _| crate::shell::canvas::setting_read(s)) {
        assert!(std::time::Instant::now() < deadline, "preference never read");
        v.run_until_parked();
        std::thread::sleep(Duration::from_millis(10));
    }
    s.update_in(&mut v, |s, w, cx| {
        s.open_registered("Canvas", w, cx);
    });
    draw(&mut v);
    (s, v)
}

#[gpui::test]
fn canvas_setting_exposes_native_surface(cx: &mut TestAppContext) {
    let (s, mut v) = open_with_setting(true, cx);
    assert!(s.read_with(&v, |s, _| crate::shell::canvas::enabled(s)));
    assert!(
        v.debug_bounds("canvas-surface").is_some(),
        "setting on exposes the native canvas"
    );
}

#[gpui::test]
fn canvas_setting_off_hides_native_surface(cx: &mut TestAppContext) {
    let (s, mut v) = open_with_setting(false, cx);
    assert!(!s.read_with(&v, |s, _| crate::shell::canvas::enabled(s)));
    assert!(
        v.debug_bounds("canvas-surface").is_none(),
        "setting off keeps the canvas closed"
    );
}
