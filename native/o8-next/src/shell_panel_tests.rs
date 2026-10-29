use super::*;

#[gpui::test]
fn inbox_saved_tab_migrates_to_panel_and_closing_it_survives_restart(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let session = fixture.client.sessions().unwrap()[0].clone();
    let workspace = session.repo_path.unwrap();
    let tab = Tab::Session(session.id);
    let mut initial = State {
        selected: Some(workspace.clone()),
        ..Default::default()
    };
    initial.workspaces.insert(
        workspace.clone(),
        Workspace {
            tabs: vec![tab.clone(), Tab::Inbox],
            active: 1,
            ..Default::default()
        },
    );
    let file = fixture.root.join("legacy-panel.json");
    initial.save(&file).unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        file.clone(),
        State::load(&file).unwrap(),
        cx,
    );
    inbox_panel_open(&shell, &mut visual);
    shell.read_with(&visual, |s, _| {
        assert_eq!(s.active(), Some(tab.clone()));
        assert_eq!(s.current().unwrap().tabs, vec![tab.clone()]);
    });
    assert_eq!(
        State::load(&file).unwrap().right_panel,
        Some(crate::shell_state::PanelTool::Inbox)
    );
    visual.simulate_keystrokes("ctrl-alt-b");
    assert!(shell.read_with(&visual, |s, _| s.state.right_panel.is_none()));
    assert!(visual.simulate_close());
    let (restored, mut second) = open(
        fixture.client.clone(),
        file.clone(),
        State::load(&file).unwrap(),
        &mut visual.cx,
    );
    ready(&restored, &mut second);
    restored.update_in(&mut second, |s, window, cx| s.tick(false, window, cx));
    draw(&mut second);
    assert_eq!(restored.read_with(&second, |s, _| s.active()), Some(tab));
    assert!(restored.read_with(&second, |s, _| s.state.right_panel.is_none()));
    assert!(
        second.debug_bounds("panel-tab").is_none(),
        "closed panel stays closed on restart"
    );
}

#[gpui::test]
fn inbox_panel_dismisses_settings_and_preserves_the_main_tab(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("panel-settings.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k n e w enter");
    ready(&shell, &mut visual);
    visual.simulate_input("Main draft");
    let main = shell.read_with(&visual, |s, _| s.active());
    visual.simulate_keystrokes("ctrl-shift-p s e t t i n g s enter");
    visual.run_until_parked();
    draw(&mut visual);
    assert!(shell.read_with(&visual, |s, _| s.surfaces.settings.view.is_some()));
    visual.simulate_keystrokes("ctrl-shift-p i n b o x enter");
    inbox_panel_open(&shell, &mut visual);
    assert!(shell.read_with(&visual, |s, _| s.surfaces.settings.view.is_none()));
    assert_eq!(shell.read_with(&visual, |s, _| s.active()), main);
    assert!(shell.read_with(&visual, |s, _| s.current().unwrap().composer));
    visual.simulate_keystrokes("ctrl-alt-b");
    draw(&mut visual);
    visual.simulate_input(" retained");
    visual.simulate_keystrokes("ctrl-alt-b");
    inbox_panel_open(&shell, &mut visual);
    let new_tab = visual.debug_bounds("panel-new-tab").unwrap();
    visual.simulate_click(new_tab.center(), gpui::Modifiers::default());
    visual.run_until_parked();
    draw(&mut visual);
    shell.update_in(&mut visual, |s, window, cx| s.tick(false, window, cx));
    assert_eq!(
        shell.read_with(&visual, |s, _| s.state.right_panel),
        Some(crate::shell_state::PanelTool::Launcher)
    );
    assert!(shell.read_with(&visual, |s, _| s.current().unwrap().composer));
    let close = visual.debug_bounds("header-right-panel").unwrap();
    visual.simulate_click(close.center(), gpui::Modifiers::default());
    draw(&mut visual);
    visual.simulate_input(" launcher");
    shell.read_with(&visual, |s, cx| {
        let Content::Session(session) = s.content.get(&s.key(&s.active().unwrap())).unwrap() else {
            panic!("main session")
        };
        assert_eq!(
            session.read(cx).shell_issue_state(cx)["draft"],
            "Main draft retained launcher"
        );
    });
}
