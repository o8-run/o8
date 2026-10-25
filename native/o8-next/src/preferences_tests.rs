use super::*;
use crate::shell::{test_support::*, *};

#[gpui::test]
fn launch_preferences_match_palette_sidebar_and_window_before_input(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let prefs = Preferences::parse(r#"{"version":1,"palette":"light","glass":false,"allGlass":false,"sidebarWidth":384,"sidebarVisible":true,"windowSize":[900,700]}"#).unwrap();
    let file = f.root.join("appearance.json");
    let handle = cx.update(|cx| {
        view::open_window_with_preferences(
            f.client.clone(),
            file.clone(),
            State::default(),
            true,
            Some(prefs),
            cx,
        )
    });
    let shell = handle.root(cx).unwrap();
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    let cx = &mut visual;
    ready(&shell, cx);
    let viewport = cx.update(|window, _| window.viewport_size());
    assert_eq!(viewport.width, px(900.));
    assert_eq!(viewport.height, px(700.));
    assert_eq!(
        crate::theme::current().background,
        crate::theme::Theme::for_appearance(crate::theme::Appearance::Light).background
    );
    assert_eq!(
        cx.debug_bounds("session-sidebar").unwrap().size.width,
        px(384.)
    );
    shell.update_in(cx, |s, window, cx| {
        let id = s.workspace_sessions()[0].id.clone();
        s.execute(Command::Message(id), window, cx);
    });
    cx.simulate_input("matching draft");
    draw(cx);
    shell.read_with(cx, |s, cx| {
        let Content::Session(v) = s.content.get(&s.key(&s.active().unwrap())).unwrap() else {
            panic!("session")
        };
        assert_eq!(v.read(cx).shell_issue_state(cx)["draft"], "matching draft");
    });
    assert!(!fs::read_to_string(file).unwrap().contains("palette"));
}

#[gpui::test]
fn launch_preferences_apply_glass_and_collapsed_sidebar_without_stealing_input(
    cx: &mut TestAppContext,
) {
    let f = Fixture::new();
    let prefs = Preferences::parse(r#"{"version":1,"palette":"dark","glass":true,"allGlass":true,"sidebarWidth":500,"sidebarVisible":false}"#).unwrap();
    let handle = cx.update(|cx| {
        view::open_window_with_preferences(
            f.client.clone(),
            f.root.join("glass.json"),
            State::default(),
            true,
            Some(prefs),
            cx,
        )
    });
    let shell = handle.root(cx).unwrap();
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    let cx = &mut visual;
    ready(&shell, cx);
    assert_eq!(crate::theme::glass_enabled(), cfg!(target_os = "macos"));
    assert_eq!(
        crate::theme::current().shell_background.a,
        if cfg!(target_os = "macos") { 0. } else { 1. }
    );
    assert_eq!(
        cx.debug_bounds("session-sidebar").unwrap().size.width,
        px(0.)
    );
    shell.update_in(cx, |s, window, cx| {
        let id = s.workspace_sessions()[0].id.clone();
        s.execute(Command::Message(id), window, cx);
    });
    cx.simulate_input("glass draft");
    draw(cx);
    shell.read_with(cx, |s, cx| {
        let Content::Session(v) = s.content.get(&s.key(&s.active().unwrap())).unwrap() else {
            panic!("session")
        };
        assert_eq!(v.read(cx).shell_issue_state(cx)["draft"], "glass draft");
    });
}

#[gpui::test]
fn launch_preferences_reject_invalid_snapshot_and_retain_saved_bounds(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let prefs = Preferences::parse(
        r#"{"version":1,"palette":"light","glass":false,"allGlass":false,"sidebarWidth":90000,"sidebarVisible":true,"windowSize":[0,0]}"#,
    );
    assert!(prefs.is_none());
    let state = State {
        bounds: [100., 100., 1000., 720.],
        ..State::default()
    };
    let handle = cx.update(|cx| {
        view::open_window_with_preferences(
            f.client.clone(),
            f.root.join("fallback.json"),
            state,
            true,
            prefs,
            cx,
        )
    });
    let shell = handle.root(cx).unwrap();
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    ready(&shell, &mut visual);
    let size = visual.update(|window, _| window.viewport_size());
    assert_eq!(size.width, px(1000.));
    assert_eq!(size.height, px(720.));
    assert_eq!(
        visual.debug_bounds("session-sidebar").unwrap().size.width,
        px(250.)
    );
}
