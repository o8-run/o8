use super::*;
use crate::shell::test_support::*;
use gpui::Modifiers;
struct PanelChromeTests;
register_shell_feature!(PanelChromeTests);
impl ShellFeature for PanelChromeTests {}
fn bounds(v: &mut VisualTestContext, id: &str) -> Bounds<gpui::Pixels> {
    draw(v);
    v.debug_bounds(Box::leak(id.to_owned().into_boxed_str()))
        .unwrap_or_else(|| panic!("missing {id}"))
}
fn click(v: &mut VisualTestContext, id: &str) {
    let b = bounds(v, id);
    v.simulate_click(b.center(), Modifiers::default());
    settle(v);
}
fn settle(v: &mut VisualTestContext) {
    let until = Instant::now() + Duration::from_millis(285);
    while Instant::now() < until {
        v.run_until_parked();
        draw(v);
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn setup(cx: &mut TestAppContext) -> (Fixture, Entity<Shell>, VisualTestContext) {
    let f = Fixture::new();
    let (s, mut v) = open(
        f.client.clone(),
        f.root.join("panel-chrome.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&s, &mut v);
    v.simulate_resize(size(px(1600.), px(1000.)));
    settle(&mut v);
    click(&mut v, "header-right-panel");
    (f, s, v)
}
fn saved(f: &Fixture) -> Value {
    serde_json::from_slice(&fs::read(f.root.join("panel-chrome.json")).unwrap()).unwrap()
}
#[gpui::test]
fn panel_chrome_launcher_disclosure_and_distinct_drawer(cx: &mut TestAppContext) {
    let (_f, _s, mut v) = setup(cx);
    assert!(
        v.debug_bounds("panel-tool-threads").is_none(),
        "only seven everyday tools initially"
    );
    click(&mut v, "panel-launcher-more");
    bounds(&mut v, "panel-tool-threads");
    click(&mut v, "panel-launcher-more");
    assert!(v.debug_bounds("panel-tool-threads").is_none());
    click(&mut v, "panel-tool-devices");
    click(&mut v, "panel-new-tab");
    bounds(&mut v, "panel-launcher-more");
    assert!(v.debug_bounds("panel-add-menu").is_none());
    click(&mut v, "panel-more-views");
    assert_eq!(bounds(&mut v, "panel-add-menu").size.width, px(340.));
    let a = bounds(&mut v, "panel-add-files");
    let b = bounds(&mut v, "panel-add-threads");
    assert!(b.left() > a.right());
    v.simulate_keystrokes("end enter");
    settle(&mut v);
    bounds(&mut v, "panel-tab-close-targeting");
}
#[gpui::test]
fn panel_chrome_tabs_geometry_keyboard_close_and_saved_restore(cx: &mut TestAppContext) {
    let (f, _s, mut v) = setup(cx);
    click(&mut v, "panel-launcher-more");
    click(&mut v, "panel-tool-threads");
    click(&mut v, "panel-more-views");
    click(&mut v, "panel-add-resources");
    assert_eq!(
        bounds(&mut v, "panel-tab-close-resources").size,
        size(px(20.), px(24.))
    );
    click(&mut v, "panel-tab-select-threads");
    v.simulate_keystrokes("end delete");
    settle(&mut v);
    assert!(v.debug_bounds("panel-tab-close-resources").is_none());
    let data = saved(&f);
    assert_eq!(data["right_panel"]["primary"], "threads");
    let state: crate::shell_state::State = serde_json::from_value(data).unwrap();
    let (_second, mut relaunched) = open(
        f.client.clone(),
        f.root.join("relaunch.json"),
        state,
        &mut v.cx,
    );
    settle(&mut relaunched);
    bounds(&mut relaunched, "panel-tab-close-threads");
    bounds(&mut relaunched, "panel-content");
    assert_eq!(
        relaunched.debug_opacity("panel-content"),
        Some(1.),
        "restored content must paint fully opaque, not only retain bounds"
    );
}
#[gpui::test]
fn panel_chrome_split_picker_ratio_keyboard_and_relaunch(cx: &mut TestAppContext) {
    let (f, _s, mut v) = setup(cx);
    click(&mut v, "panel-tool-devices");
    click(&mut v, "panel-split");
    bounds(&mut v, "panel-split-body");
    click(&mut v, "panel-lower-picker");
    v.simulate_keystrokes("end enter");
    settle(&mut v);
    click(&mut v, "panel-split-resize");
    v.simulate_keystrokes("home down");
    settle(&mut v);
    assert_eq!(saved(&f)["right_panel"]["ratio"], 30.);
    assert_eq!(saved(&f)["right_panel"]["secondary"], "targeting");
    let state: crate::shell_state::State = serde_json::from_value(saved(&f)).unwrap();
    let (_, mut relaunched) = open(
        f.client.clone(),
        f.root.join("split-relaunch.json"),
        state,
        &mut v.cx,
    );
    settle(&mut relaunched);
    bounds(&mut relaunched, "panel-split-ratio-30");
    let data: Value =
        serde_json::from_slice(&fs::read(f.root.join("split-relaunch.json")).unwrap()).unwrap();
    assert_eq!(data["right_panel"]["primary"], "devices");
    assert_eq!(data["right_panel"]["secondary"], "targeting");
}
#[gpui::test]
fn panel_chrome_maximize_escape_and_narrow_guard(cx: &mut TestAppContext) {
    let (_f, _s, mut v) = setup(cx);
    click(&mut v, "panel-tool-devices");
    let before = bounds(&mut v, "header-right-panel").left();
    click(&mut v, "panel-maximize");
    assert!(bounds(&mut v, "panel-new-tab").left() < before);
    v.simulate_keystrokes("escape");
    settle(&mut v);
    bounds(&mut v, "panel-tabs");
    v.simulate_resize(size(px(1100.), px(816.)));
    settle(&mut v);
    assert!(v.debug_bounds("panel-tabs").is_none());
    click(&mut v, "header-right-panel");
    assert!(v.debug_bounds("panel-tabs").is_none());
    v.simulate_resize(size(px(1600.), px(1000.)));
    settle(&mut v);
    bounds(&mut v, "panel-tabs");
}
#[gpui::test]
fn panel_chrome_browser_pages_are_separate_from_utility_tabs(cx: &mut TestAppContext) {
    let (f, _s, mut v) = setup(cx);
    click(&mut v, "panel-tool-devices");
    click(&mut v, "panel-more-views");
    click(&mut v, "panel-add-browser-page");
    bounds(&mut v, "panel-browser-pages");
    assert!(v.debug_bounds("panel-tab-close-browser").is_none());
    assert!(
        !saved(&f)["right_panel"]["utility_tabs"]
            .to_string()
            .contains("browser")
    );
}
#[gpui::test]
fn panel_chrome_drawer_escape_tab_and_outside_click(cx: &mut TestAppContext) {
    let (_f, _s, mut v) = setup(cx);
    click(&mut v, "panel-more-views");
    v.simulate_keystrokes("escape");
    settle(&mut v);
    assert!(v.debug_bounds("panel-add-menu").is_none());
    v.simulate_keystrokes("enter");
    settle(&mut v);
    bounds(&mut v, "panel-add-menu");
    v.simulate_keystrokes("tab");
    settle(&mut v);
    assert!(v.debug_bounds("panel-add-menu").is_none());
    click(&mut v, "panel-more-views");
    v.simulate_click(point(px(450.), px(500.)), Modifiers::default());
    settle(&mut v);
    assert!(v.debug_bounds("panel-add-menu").is_none());
}

#[gpui::test]
fn panel_chrome_widths_keep_ordinary_and_wide_tool_memory(cx: &mut TestAppContext) {
    let (f, _s, mut v) = setup(cx);
    click(&mut v, "panel-tool-devices");
    let wide = bounds(&mut v, "panel-resize").left();
    click(&mut v, "panel-resize");
    v.simulate_keystrokes("left");
    settle(&mut v);
    assert_eq!(saved(&f)["right_panel"]["tool_widths"]["device"], 616.);
    click(&mut v, "panel-more-views");
    click(&mut v, "panel-add-threads");
    assert!(bounds(&mut v, "panel-resize").left() > wide);
    click(&mut v, "panel-resize");
    v.simulate_keystrokes("right");
    settle(&mut v);
    assert_eq!(saved(&f)["right_panel_width"], 424.);
    click(&mut v, "panel-tab-select-devices");
    assert_eq!(bounds(&mut v, "panel-resize").left(), wide - px(16.));
}
fn surface(s: &Entity<Shell>, v: &mut VisualTestContext, data: Value) {
    let frame = json!({"kind":"symon-ui","payload":{"data":data}});
    s.update_in(v, |s, w, cx| s.ui_command(&frame, w, cx));
    settle(v);
}
#[gpui::test]
fn panel_chrome_missing_repository_opens_explanation_and_context_destinations(
    cx: &mut TestAppContext,
) {
    let (_f, s, mut v) = setup(cx);
    s.update_in(&mut v, |s, _, cx| {
        s.state.selected = None;
        cx.notify();
    });
    settle(&mut v);
    click(&mut v, "panel-tool-files");
    bounds(&mut v, "panel-no-repository");
    surface(&s, &mut v, json!({"surface":"compare"}));
    bounds(&mut v, "panel-comparison");
    surface(
        &s,
        &mut v,
        json!({"surface":"prs","repo":"example/project","number":12}),
    );
    bounds(&mut v, "panel-pr-example/project-12");
}
