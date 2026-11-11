use super::*;
use crate::shell::test_support::*;
use serde_json::json;
struct CanvasTests;
register_shell_feature!(CanvasTests);
impl ShellFeature for CanvasTests {}

#[gpui::test]
fn canvas_setting_exposes_native_surface(cx: &mut TestAppContext) {
    let f = Fixture::start(true);
    f.client
        .project_request(
            "POST",
            "/api/panel/operator-defaults",
            &json!({"experimentalCanvas":true}),
        )
        .unwrap();
    let (s, mut v) = open_past_setup(
        f.client.clone(),
        f.root.join("canvas.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&s, &mut v);
    // Both the shell's catalog and preferences are asynchronous reads.
    for _ in 0..30 {
        v.run_until_parked();
        draw(&mut v);
        std::thread::sleep(Duration::from_millis(10));
    }
    s.update_in(&mut v, |s, w, cx| {
        s.open_registered("Canvas", w, cx);
    });
    draw(&mut v);
    assert!(
        v.debug_bounds("canvas-surface").is_some(),
        "setting on exposes the native canvas"
    );
}
