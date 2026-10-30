//! Shell entry point, no-repo target selection, persistence and visibility.
use super::*;
pub(super) fn shell<'a>(
    f: &Fixture,
    state: Value,
    cx: &'a mut TestAppContext,
) -> VisualTestContext {
    let state = serde_json::from_value(state).unwrap();
    let client = f.client.clone();
    let file = f.root.join("shell.json");
    let handle = cx.update(|cx| crate::shell::notes_test_window(client, file, state, cx));
    let mut visual = VisualTestContext::from_window(handle, cx);
    visual.update(|window, _| window.activate_window());
    draw(&mut visual);
    click(&mut visual, "header-right-panel");
    std::thread::sleep(Duration::from_millis(280));
    draw(&mut visual);
    click(&mut visual, "panel-tool-o8.md");
    std::thread::sleep(Duration::from_millis(220));
    draw(&mut visual);
    wait(&mut visual, "spec-target");
    visual
}
pub(super) fn empty_state() -> Value {
    serde_json::json!({"version":1,"bounds":[100,100,1400,900],"selected":null,"workspaces":{},"right_panel_width":650})
}
fn menu_click(cx: &mut VisualTestContext, selector: &'static str) {
    wait(cx, selector);
    for _ in 0..5 {
        let menu = cx.debug_bounds("spec-target-menu").unwrap();
        let control = cx.debug_bounds(selector).unwrap();
        let y = control.center().y;
        if y >= menu.top() + px(4.) && y <= menu.bottom() - px(4.) {
            break;
        }
        cx.simulate_event(gpui::ScrollWheelEvent {
            position: menu.center(),
            delta: gpui::ScrollDelta::Pixels(gpui::point(
                px(0.),
                if y > menu.bottom() {
                    px(-220.)
                } else {
                    px(220.)
                },
            )),
            modifiers: gpui::Modifiers::default(),
            touch_phase: gpui::TouchPhase::Moved,
        });
        draw(cx);
    }
    click(cx, selector);
}
fn choose(cx: &mut VisualTestContext, path: &str) {
    click(cx, "spec-target");
    menu_click(cx, "spec-type-path");
    search(cx, "spec-target-input", path);
    menu_click(cx, "spec-target-open");
    wait(cx, "spec-editor");
}
#[gpui::test]
fn spec_target_no_repo_typed_file_and_preferences_persist(cx: &mut TestAppContext) {
    let f = Fixture::new();
    fs::write(path(&f), "# Isolated notes\n").unwrap();
    let mut cx = shell(&f, empty_state(), cx);
    assert_eq!(content(&mut cx), "");
    choose(&mut cx, &format!("{}/o8.md", f.repo));
    until(&mut cx, |cx| content(cx) == "# Isolated notes\n");
    let saved: Value =
        serde_json::from_str(&fs::read_to_string(f.root.join("shell.json")).unwrap()).unwrap();
    assert_eq!(saved["notes"]["target_override"], f.repo);
    assert!(
        f.requests()
            .iter()
            .filter(|r| r.contains("/api/repo-spec?"))
            .all(|r| r.contains("repoPath=%2F") && !r.contains("repoPath=&"))
    );
    click(&mut cx, "spec-settings");
    click(&mut cx, "spec-color-2");
    cx.simulate_keystrokes("escape");
    draw(&mut cx);
    let saved: Value =
        serde_json::from_str(&fs::read_to_string(f.root.join("shell.json")).unwrap()).unwrap();
    assert_eq!(saved["notes"]["color"], "#9ca3af");
    assert!(cx.simulate_close());
}
#[gpui::test]
fn spec_target_six_recents_file_folder_and_follow_active_repo(cx: &mut TestAppContext) {
    let f = Fixture::new();
    fs::write(path(&f), "Fixture original\n").unwrap();
    fs::write(f.root.join("active-workspace"), "1").unwrap();
    let mut state = empty_state();
    state["selected"] = serde_json::json!(f.repo);
    state["workspaces"] =
        serde_json::json!({&f.repo:{"tabs":[],"active":0,"composer":false,"selections":{}}});
    let mut cx = shell(&f, state, cx);
    wait(&mut cx, "spec-editor");
    for i in 0..7 {
        let dir = f.root.join(format!("recent-{i}"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("o8.md"), format!("Recent {i}\n")).unwrap();
        choose(&mut cx, dir.to_str().unwrap());
        until(&mut cx, |cx| content(cx) == format!("Recent {i}\n"));
    }
    let saved: Value =
        serde_json::from_str(&fs::read_to_string(f.root.join("shell.json")).unwrap()).unwrap();
    assert_eq!(saved["notes"]["recents"].as_array().unwrap().len(), 6);
    click(&mut cx, "spec-target");
    menu_click(&mut cx, "spec-follow-repo");
    until(&mut cx, |cx| content(cx) == "Fixture original\n");
    click(&mut cx, "spec-target");
    menu_click(&mut cx, "spec-choose-file");
    until(&mut cx, |cx| content(cx) == "Fixture original\n");
    click(&mut cx, "spec-target");
    menu_click(&mut cx, "spec-choose-folder");
    draw(&mut cx);
    assert!(f.requests().iter().any(|r| r == "POST /api/panel/file-io"));
    assert!(
        f.requests()
            .iter()
            .any(|r| r == "POST /api/panel/browse-folder")
    );
}
#[gpui::test]
fn spec_saved_override_loads_before_active_repo_and_poll_stops_when_hidden(
    cx: &mut TestAppContext,
) {
    let f = Fixture::new();
    let alternate = f.root.join("alternate");
    fs::create_dir_all(&alternate).unwrap();
    fs::write(alternate.join("o8.md"), "Override notes\n").unwrap();
    let mut state = empty_state();
    state["notes"] = serde_json::json!({"target_override":alternate,"recents":[alternate],"color":"hsl(180, 80%, 55%)"});
    let mut cx = shell(&f, state, cx);
    wait(&mut cx, "spec-editor");
    until(&mut cx, |cx| content(cx) == "Override notes\n");
    assert!(
        f.requests()
            .iter()
            .filter(|r| r.contains("/api/repo-spec?"))
            .all(|r| r.contains("alternate"))
    );
    click(&mut cx, "header-right-panel");
    std::thread::sleep(Duration::from_millis(250));
    draw(&mut cx);
    let count = f
        .requests()
        .iter()
        .filter(|r| r.starts_with("GET /api/repo-spec?"))
        .count();
    advance(&mut cx, 5200);
    draw(&mut cx);
    assert_eq!(
        f.requests()
            .iter()
            .filter(|r| r.starts_with("GET /api/repo-spec?"))
            .count(),
        count,
        "hidden panes must stop polling"
    );
    fs::write(alternate.join("o8.md"), "External while hidden\n").unwrap();
    click(&mut cx, "header-right-panel");
    std::thread::sleep(Duration::from_millis(250));
    draw(&mut cx);
    until(&mut cx, |cx| content(cx) == "External while hidden\n");
}
#[gpui::test]
fn spec_settings_hue_neutrals_reset_and_keyboard_close(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let mut cx = shell(&f, empty_state(), cx);
    click(&mut cx, "spec-settings");
    wait(&mut cx, "spec-hue");
    let bounds = cx.debug_bounds("spec-hue").unwrap();
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    draw(&mut cx);
    let saved: Value =
        serde_json::from_str(&fs::read_to_string(f.root.join("shell.json")).unwrap()).unwrap();
    let hue = saved["notes"]["color"].as_str().unwrap();
    assert!(hue.starts_with("hsl(180,"));
    click(&mut cx, "spec-color-0");
    click(&mut cx, "spec-color-reset");
    cx.simulate_keystrokes("escape");
    draw(&mut cx);
    let saved: Value =
        serde_json::from_str(&fs::read_to_string(f.root.join("shell.json")).unwrap()).unwrap();
    assert!(saved["notes"]["color"].is_null());
    cx.simulate_keystrokes("enter");
    draw(&mut cx);
    wait(&mut cx, "spec-settings-menu");
}
#[gpui::test]
fn spec_load_error_retry_keeps_notes_frame(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let hidden = f.root.join("hidden");
    fs::rename(&f.repo, &hidden).unwrap();
    let (_, cx) = panel(&f, cx);
    wait(cx, "spec-retry");
    assert!(cx.debug_bounds("spec-frame").is_some());
    assert!(cx.update(|_, cx| cx.global::<Status>().text.contains("invalid")));
    fs::rename(hidden, &f.repo).unwrap();
    click(cx, "spec-retry");
    wait(cx, "spec-editor");
    until(cx, |cx| {
        cx.update(|_, cx| cx.global::<Status>().text == "Loaded")
    });
}
