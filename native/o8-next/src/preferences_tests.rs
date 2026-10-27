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
        cx.debug_bounds("shell-sidebar").unwrap().size.width,
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
    assert_eq!(cx.debug_bounds("shell-sidebar").unwrap().size.width, px(0.));
    shell.update_in(cx, |s, window, cx| {
        let id = s.workspace_sessions()[0].id.clone();
        s.execute(Command::Message(id), window, cx);
    });
    cx.simulate_keystrokes("f8");
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
        visual.debug_bounds("shell-sidebar").unwrap().size.width,
        px(280.)
    );
}

fn sidebar_controls_fit(cx: &mut TestAppContext, width: f32) {
    let f = Fixture::start_mode(true, "--shell --composer --sidebar");
    let created = f
        .client
        .project_request(
            "POST",
            "/api/projects",
            &json!({"name":"Sidebar layout fixture", "slug":"sidebar-layout-fixture"}),
        )
        .unwrap();
    let project = created["project"]["id"].as_str().unwrap();
    for path in &f.folders {
        let repo = f
            .client
            .project_request(
                "POST",
                "/api/panel/repos",
                &json!({"action":"add", "localPath":path}),
            )
            .unwrap();
        f.client
            .project_request(
                "POST",
                &format!("/api/projects/{project}/repos"),
                &json!({"repoId":repo["repo"]["id"]}),
            )
            .unwrap();
    }
    f.client
        .project_request(
            "POST",
            "/api/panel/projects/active",
            &json!({"projectId":project}),
        )
        .unwrap();
    for (size, palette) in [([900., 700.], "light"), ([1680., 1050.], "dark")] {
        let prefs = Preferences::parse(
            &json!({"version":1,"palette":palette,"glass":false,
            "allGlass":false,"sidebarWidth":width,"sidebarVisible":true,"windowSize":size})
            .to_string(),
        )
        .unwrap();
        let handle = cx.update(|cx| {
            view::open_window_with_preferences(
                f.client.clone(),
                f.root.join(format!("width-{width}-{palette}.json")),
                State::default(),
                true,
                Some(prefs),
                cx,
            )
        });
        let shell = handle.root(cx).unwrap();
        let mut visual = VisualTestContext::from_window(handle.into(), cx);
        let started = Instant::now();
        loop {
            visual.run_until_parked();
            shell.update_in(&mut visual, |s, window, cx| s.tick(false, window, cx));
            draw(&mut visual);
            if shell.read_with(&visual, |s, cx| {
                s.connected
                    && s.surfaces
                        .sidebar
                        .view
                        .as_ref()
                        .unwrap()
                        .read(cx)
                        .diagnostic()["project"]
                        == project
            }) {
                break;
            }
            assert!(
                started.elapsed() < std::time::Duration::from_secs(10),
                "sidebar project must load"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        // Select a saved conversation through the native row so both footer
        // controls are present, even when the initial choice is a worker.
        let (sidebar, index) = shell.read_with(&visual, |s, cx| {
            let sidebar = s.surfaces.sidebar.view.as_ref().unwrap().clone();
            let index = sidebar
                .read(cx)
                .rows
                .iter()
                .position(|row| row.id.as_ref().is_some_and(|id| !id.contains(':')))
                .expect("saved fixture conversation");
            (sidebar, index)
        });
        sidebar.update(&mut visual, |s, cx| {
            s.scroll.scroll_to_item(index, gpui::ScrollStrategy::Top);
            cx.notify();
        });
        draw(&mut visual);
        let row = visual
            .debug_bounds(Box::leak(format!("thread-row-{index}").into_boxed_str()))
            .unwrap();
        visual.simulate_click(row.center(), gpui::Modifiers::default());
        visual.run_until_parked();
        draw(&mut visual);
        let rail = visual.debug_bounds("shell-sidebar").unwrap();
        assert_eq!(rail.size.width, px(width));
        let search = visual.debug_bounds("thread-search").unwrap();
        assert_eq!(search.left(), rail.left());
        assert_eq!(
            search.right(),
            rail.right(),
            "sidebar content must fill the preferred width"
        );
        assert!(
            visual.debug_bounds("sidebar-repo-0").is_some(),
            "registered repository chip"
        );
        for selector in [
            "sidebar-project-header",
            "sidebar-project-switcher",
            "sidebar-project-add",
            "sidebar-project-chevron",
            "thread-search",
            "thread-list",
            "thread-rename",
            "thread-archive",
            "sidebar-repo-0",
            "sidebar-repo-1",
            "sidebar-repo-2",
            "sidebar-repo-overflow",
        ] {
            if let Some(control) = visual.debug_bounds(selector) {
                assert!(
                    control.left() >= rail.left()
                        && control.right() <= rail.right()
                        && control.top() >= rail.top()
                        && control.bottom() <= rail.bottom()
                        && control.size.width > px(0.)
                        && control.size.height > px(0.),
                    "{selector} must fit width {width}: {control:?} inside {rail:?}"
                );
            } else {
                assert!(
                    selector.starts_with("sidebar-repo-"),
                    "missing control: {selector}"
                );
            }
        }
        let add = visual.debug_bounds("sidebar-project-add").unwrap();
        assert_eq!(rail.right() - add.right(), px(5.));
        visual.update(|window, _| window.remove_window());
    }
}

#[gpui::test]
fn launch_preferences_sidebar_minimum_width_fits_controls(cx: &mut TestAppContext) {
    sidebar_controls_fit(cx, 160.);
}

#[gpui::test]
fn launch_preferences_sidebar_maximum_width_fits_controls(cx: &mut TestAppContext) {
    sidebar_controls_fit(cx, 500.);
}

#[gpui::test]
fn launch_preferences_sidebar_intermediate_width_fills_column(cx: &mut TestAppContext) {
    sidebar_controls_fit(cx, 384.);
}

#[test]
fn launch_preferences_sidebar_width_is_clamped_at_the_layout_boundary() {
    for (requested, expected) in [(159., 160.), (160., 160.), (500., 500.), (501., 500.)] {
        crate::theme::configure("dark", false, false, requested, true);
        assert_eq!(crate::theme::sidebar_width(280.), expected);
    }
    crate::theme::reset_preferences();
}
