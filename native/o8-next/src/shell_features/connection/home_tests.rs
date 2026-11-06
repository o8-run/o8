use super::*;

// Classic's "work without a project": the home folder is a workspace of no
// project. It is listed, its landing asks what to do, a chat started there
// belongs to it, and maintenance keeps it selected.
#[gpui::test]
fn home_works_without_a_project_and_stays_selected(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--shell --composer --parity");
    let file = fixture.root.join("home.json");
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    let cx = &mut visual;
    settled(&shell, cx);
    let home = crate::shell::session::home_workspace().expect("HOME is set");
    assert!(!shell.read_with(cx, |s, _| s.workspaces.contains(&home)));
    let labels = shell.read_with(cx, |s, _| {
        crate::shell::palette::entries(s)
            .iter()
            .map(|entry| entry.label(&s.sessions))
            .collect::<Vec<_>>()
    });
    assert!(
        labels.iter().any(|l| l == "Work without a project: Home"),
        "{labels:?}"
    );

    shell.update_in(cx, |s, window, cx| s.switch(home.clone(), window, cx));
    assert_eq!(
        shell.read_with(cx, |s, _| s.state.selected.clone()),
        Some(home.clone())
    );
    // Before any chat lives there, Home is in no session or project list.
    // The sidebar's catalog refresh and connection maintenance both re-pick
    // a missing workspace, and both keep Home.
    let list = shell
        .read_with(cx, |s, _| s.surfaces.sidebar.view.clone())
        .expect("sidebar list");
    for _ in 0..3 {
        list.update(cx, |list, cx| list.load(cx));
        for _ in 0..20 {
            settled(&shell, cx);
            std::thread::sleep(Duration::from_millis(50));
        }
        shell.update_in(cx, |s, window, cx| s.tick(true, window, cx));
        settled(&shell, cx);
    }
    assert_eq!(
        shell.read_with(cx, |s, _| s.state.selected.clone()),
        Some(home.clone()),
        "refreshes keep Home selected before it has a chat"
    );
    draw(cx);
    let start = cx
        .debug_bounds("landing-new-chat")
        .expect("Home lands on its own prompt");
    cx.simulate_click(start.center(), gpui::Modifiers::default());
    let deadline = Instant::now() + Duration::from_secs(20);
    while !shell.read_with(cx, |s, _| {
        s.sessions
            .iter()
            .any(|x| x.repo_path.as_deref() == Some(home.as_str()))
    }) {
        assert!(
            Instant::now() < deadline,
            "no chat started in the home folder"
        );
        shell.update_in(cx, |s, window, cx| s.tick(true, window, cx));
        settled(&shell, cx);
        std::thread::sleep(Duration::from_millis(50));
    }

    shell.update_in(cx, |s, window, cx| s.tick(true, window, cx));
    settled(&shell, cx);
    assert_eq!(
        shell.read_with(cx, |s, _| s.state.selected.clone()),
        Some(home.clone()),
        "maintenance keeps Home selected"
    );
    assert_eq!(State::load(&file).unwrap().selected, Some(home));
}
