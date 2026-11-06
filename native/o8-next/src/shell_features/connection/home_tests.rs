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

// Home is the one place for work without a project. A chat saved with no
// project before Home existed (#5503) is listed under Home and still sends,
// from its own scratch folder rather than the home folder.
#[gpui::test]
fn an_older_no_project_chat_is_listed_under_home_and_sends_from_its_scratch_folder(
    cx: &mut TestAppContext,
) {
    // The fixture saves this chat the way #5503 did: a runtime and model, no
    // repository.
    let fixture = Fixture::start_mode(true, "--shell --composer --parity --composer-scratch");
    let id = "thoughts-composer-scratch";
    let file = fixture.root.join("home-scratch.json");
    let (shell, mut visual) = open(fixture.client.clone(), file, State::default(), cx);
    let cx = &mut visual;
    settled(&shell, cx);
    let home = crate::shell::session::home_workspace().expect("HOME is set");
    let session = shell
        .read_with(cx, |s, _| s.sessions.iter().find(|s| s.id == id).cloned())
        .expect("the older chat is listed");
    assert_eq!(session.repo_path, None, "its saved record keeps no project");
    assert_eq!(session.workspace(), home, "it opens in Home");

    shell.update_in(cx, |s, window, cx| s.switch(home.clone(), window, cx));
    let list = shell
        .read_with(cx, |s, _| s.surfaces.sidebar.view.clone())
        .expect("sidebar list");
    let deadline = Instant::now() + Duration::from_secs(20);
    while !list.read_with(cx, |l, _| l.sessions.iter().any(|s| s.id == id)) {
        assert!(
            Instant::now() < deadline,
            "Home's list leaves out the older chat"
        );
        list.update(cx, |list, cx| list.load(cx));
        settled(&shell, cx);
        std::thread::sleep(Duration::from_millis(50));
    }

    shell.update_in(cx, |s, window, cx| {
        s.open_thread_by_id(id.into(), window, cx)
    });
    settled(&shell, cx);
    assert_eq!(
        shell.read_with(cx, |s, _| s.state.selected.clone()),
        Some(home.clone()),
        "opening it keeps Home selected"
    );
    let deadline = Instant::now() + Duration::from_secs(20);
    let input = loop {
        draw(cx);
        if let Some(input) = cx.debug_bounds("composer-input") {
            break input;
        }
        assert!(Instant::now() < deadline, "the older chat has no composer");
        settled(&shell, cx);
        std::thread::sleep(Duration::from_millis(50));
    };
    cx.simulate_click(input.center(), gpui::Modifiers::default());
    cx.simulate_input("Older scratch chat still sends");
    cx.simulate_keystrokes("enter");
    let deadline = Instant::now() + Duration::from_secs(20);
    let item = loop {
        settled(&shell, cx);
        let queued = fixture.client.queue(&session).unwrap();
        if let Some(item) = queued["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["payload"]["text"] == "Older scratch chat still sends")
        {
            break item.clone();
        }
        if Instant::now() >= deadline {
            let state = shell.read_with(cx, |s, cx| {
                match s.content.get(&s.key(&Tab::Session(id.into()))) {
                    Some(Content::Session(view)) => view.read(cx).shell_issue_state(cx).to_string(),
                    _ => "no session view".into(),
                }
            });
            panic!("the older chat's send was not queued: {state}");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(
        item["repoPath"]
            .as_str()
            .is_some_and(|p| p.ends_with(&format!("/thread-scratch/{id}"))),
        "it runs in its own scratch folder, not the home folder: {item}"
    );
    let history: serde_json::Value = fixture
        .client
        .get("/api/v2/chat-history", &[("tabId", id)])
        .unwrap();
    assert!(
        history["repoPath"].is_null(),
        "nothing is migrated: {}",
        history["repoPath"]
    );
}
