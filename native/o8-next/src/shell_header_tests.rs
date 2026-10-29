use super::*;

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    draw(cx);
    let target = cx.debug_bounds(selector).expect(selector);
    cx.simulate_click(target.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    draw(cx);
}

fn tabs() -> Vec<Tab> {
    ["first", "second", "legacy"]
        .map(|name| Tab::Session(format!("thoughts-composer-{name}")))
        .into()
}

fn boot(
    cx: &mut TestAppContext,
    fixture: &Fixture,
    active: usize,
) -> (Entity<Shell>, VisualTestContext) {
    let workspace = fixture.client.sessions().unwrap()[0]
        .repo_path
        .clone()
        .unwrap();
    let mut state = State {
        selected: Some(workspace.clone()),
        ..State::default()
    };
    state.workspaces.insert(
        workspace,
        Workspace {
            tabs: tabs(),
            active,
            ..Workspace::default()
        },
    );
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("header.json"),
        state,
        cx,
    );
    visual.simulate_resize(size(px(1680.), px(1050.)));
    ready(&shell, &mut visual);
    shell.update_in(&mut visual, |s, window, cx| s.tick(false, window, cx));
    cx_run(&mut visual);
    (shell, visual)
}

fn active(shell: &Entity<Shell>, cx: &VisualTestContext) -> Option<Tab> {
    shell.read_with(cx, |s, _| s.active())
}

fn cx_run(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    draw(cx);
}

fn assert_inbox_panel(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    let panels = shell.read_with(cx, |s, cx| {
        let prefix = format!("panel|{}|", s.state.selected.as_deref().unwrap_or(""));
        s.content
            .iter()
            .filter_map(|(key, content)| {
                (key.starts_with(&prefix) && matches!(content, Content::Inbox(_)))
                    .then(|| content.ready(cx))
            })
            .collect::<Vec<_>>()
    });
    assert_eq!(
        panels,
        vec![true],
        "one loaded Inbox owned by the current workspace panel"
    );
    assert!(cx.debug_bounds("inbox-view-replies").is_some());
}

fn settle_panel(cx: &mut VisualTestContext) {
    // The production Transition uses wall time, with a 260ms column transition.
    std::thread::sleep(Duration::from_millis(280));
    cx.run_until_parked();
    draw(cx);
}

#[gpui::test]
fn header_back_forward_follow_visits_and_disable_at_the_ends(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = boot(cx, &fixture, 0);
    let cx = &mut visual;
    click(cx, "header-back");
    click(cx, "header-forward");
    assert_eq!(active(&shell, cx), Some(tabs()[0].clone()));
    click(cx, "surface-tab-1");
    click(cx, "surface-tab-2");
    for index in [1, 0, 0] {
        click(cx, "header-back");
        assert_eq!(active(&shell, cx), Some(tabs()[index].clone()));
    }
    assert_eq!(active(&shell, cx), Some(tabs()[0].clone()));
    for index in [1, 2, 2] {
        click(cx, "header-forward");
        assert_eq!(active(&shell, cx), Some(tabs()[index].clone()));
    }
    click(cx, "header-back");
    assert_eq!(active(&shell, cx), Some(tabs()[1].clone()));
    click(cx, "surface-tab-0");
    click(cx, "header-forward");
    assert_eq!(
        active(&shell, cx),
        Some(tabs()[0].clone()),
        "a new visit discards forward history"
    );
}

#[gpui::test]
fn header_sidebar_toggle_stays_at_desktop_x_open_and_hidden(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = boot(cx, &fixture, 0);
    let cx = &mut visual;
    for (width, height) in [(900., 700.), (1680., 1050.)] {
        cx.simulate_resize(size(px(width), px(height)));
        for hidden in [false, true] {
            draw(cx);
            assert_eq!(
                shell.read_with(cx, |s, _| s.surfaces.sidebar.hidden),
                hidden
            );
            let toggle = cx.debug_bounds("header-sidebar").expect("sidebar toggle");
            assert_eq!(
                toggle.left(),
                px(74.),
                "desktop rail 60 + inset 14 at {width}"
            );
            assert_eq!(toggle.size.height, px(26.));
            click(cx, "header-sidebar");
        }
    }
}

#[gpui::test]
fn header_cmd_w_and_close_mark_keep_the_neighbour_active(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = boot(cx, &fixture, 1);
    let cx = &mut visual;
    cx.simulate_keystrokes("cmd-w");
    draw(cx);
    assert_eq!(active(&shell, cx), Some(tabs()[2].clone()));
    assert_eq!(
        shell.read_with(cx, |s, _| s.current().unwrap().tabs.len()),
        2
    );
    click(cx, "surface-tab-close-1");
    assert_eq!(active(&shell, cx), Some(tabs()[0].clone()));
    assert_eq!(
        shell.read_with(cx, |s, _| s.current().unwrap().tabs.clone()),
        vec![tabs()[0].clone()]
    );
    let saved = State::load(&fixture.root.join("header.json")).unwrap();
    assert_eq!(
        saved.workspaces[saved.selected.as_ref().unwrap()].tabs,
        vec![tabs()[0].clone()]
    );
}

#[gpui::test]
fn header_right_panel_toggle_shortcut_launcher_and_inbox(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = boot(cx, &fixture, 0);
    let cx = &mut visual;
    let closed_centre = cx.debug_bounds("composer-card").unwrap().center().x;
    click(cx, "header-right-panel");
    settle_panel(cx);
    assert!(cx.debug_bounds("composer-card").unwrap().center().x < closed_centre);
    for tool in [
        "panel-tool-terminal",
        "panel-tool-review",
        "panel-tool-inbox",
    ] {
        let bounds = cx.debug_bounds(tool).expect("launcher choice");
        assert!(bounds.size.width > px(0.) && bounds.size.height > px(0.));
    }
    click(cx, "header-right-panel");
    settle_panel(cx);
    assert_eq!(
        cx.debug_bounds("composer-card").unwrap().center().x,
        closed_centre
    );
    cx.simulate_keystrokes("cmd-alt-b");
    settle_panel(cx);
    assert!(cx.debug_bounds("panel-tool-inbox").is_some());
    cx.simulate_keystrokes("cmd-alt-b");
    settle_panel(cx);
    assert_eq!(
        cx.debug_bounds("composer-card").unwrap().center().x,
        closed_centre
    );
    cx.simulate_keystrokes("cmd-shift-p i n b o x enter");
    cx.run_until_parked();
    settle_panel(cx);
    assert_eq!(active(&shell, cx), Some(tabs()[0].clone()));
    assert!(!shell.read_with(cx, |s, _| s.current().unwrap().tabs.contains(&Tab::Inbox)));
    assert!(cx.debug_bounds("panel-tab").is_some());
    assert!(cx.debug_bounds("inbox-view-replies").is_some());
}

#[gpui::test]
fn header_inbox_panel_restores_without_becoming_a_main_tab(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = boot(cx, &fixture, 1);
    visual.simulate_keystrokes("cmd-shift-p i n b o x enter");
    visual.run_until_parked();
    settle_panel(&mut visual);
    assert!(visual.debug_bounds("inbox-view-replies").is_some());
    assert_eq!(active(&shell, &visual), Some(tabs()[1].clone()));
    assert!(visual.simulate_close());
    let file = fixture.root.join("header.json");
    let saved = State::load(&file).unwrap();
    let (restored, mut restored_cx) = open(fixture.client.clone(), file, saved, &mut visual.cx);
    ready(&restored, &mut restored_cx);
    restored.update_in(&mut restored_cx, |s, window, cx| s.tick(false, window, cx));
    restored_cx.run_until_parked();
    settle_panel(&mut restored_cx);
    assert_eq!(active(&restored, &restored_cx), Some(tabs()[1].clone()));
    assert!(!restored.read_with(&restored_cx, |s, _| {
        s.current().unwrap().tabs.contains(&Tab::Inbox)
    }));
    assert_inbox_panel(&restored, &mut restored_cx);
}

#[gpui::test]
fn header_saved_inbox_tab_migrates_to_the_panel(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let workspace = fixture.client.sessions().unwrap()[0]
        .repo_path
        .clone()
        .unwrap();
    let mut state = State {
        selected: Some(workspace.clone()),
        ..State::default()
    };
    state.workspaces.insert(
        workspace,
        Workspace {
            tabs: vec![tabs()[0].clone(), Tab::Inbox],
            active: 1,
            ..Workspace::default()
        },
    );
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("migrate.json"),
        state,
        cx,
    );
    ready(&shell, &mut visual);
    shell.update_in(&mut visual, |s, window, cx| s.tick(false, window, cx));
    cx_run(&mut visual);
    visual.run_until_parked();
    settle_panel(&mut visual);
    assert_eq!(active(&shell, &visual), Some(tabs()[0].clone()));
    assert_eq!(
        shell.read_with(&visual, |s, _| s.current().unwrap().tabs.clone()),
        vec![tabs()[0].clone()]
    );
    assert_inbox_panel(&shell, &mut visual);
}

#[gpui::test]
fn header_workspace_tools_show_fixture_branch_path_changes_and_pull_request(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::start_mode(false, "--header-tools");
    let (shell, mut visual) = boot(cx, &fixture, 0);
    let cx = &mut visual;
    click(cx, "header-workspace-tools");
    cx.run_until_parked();
    draw(cx);
    for text in [
        "branch:feature/header-fixture",
        "meta:2 changed files",
        "additions:+17",
        "deletions:−4",
        "pr:#73 Header fixture pull request",
    ] {
        let selector = Box::leak(format!("workspace-{text}").into_boxed_str());
        let bounds = cx.debug_bounds(selector).expect(selector);
        assert!(bounds.size.width > px(0.) && bounds.size.height > px(0.));
    }
    let path = shell.read_with(cx, |s, _| s.state.selected.clone().unwrap());
    let selector = Box::leak(format!("workspace-meta:{path}").into_boxed_str());
    assert!(cx.debug_bounds(selector).is_some());
    click(cx, "workspace-copy-path");
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().unwrap().text()),
        Some(path)
    );
    cx.simulate_keystrokes("escape");
    draw(cx);
    assert_eq!(active(&shell, cx), Some(tabs()[0].clone()));
}
