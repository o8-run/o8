use super::*;
use crate::shell::test_support::*;
// Real shell, production HTTP handlers, and an actual stopped/restarted host.
#[gpui::test]
fn shell_recovers_from_down_and_restart_without_reopening(cx: &mut TestAppContext) {
    let mut fixture = Fixture::new();
    let origin = fixture.origin.clone();
    fixture.server.kill().unwrap();
    fixture.server.wait().unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("reconnect.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    assert_eq!(shell.read_with(cx, |s, _| s.notice.clone()), "Server down");
    let _restarted = Fixture::on_port(url::Url::parse(&origin).unwrap().port().unwrap());
    shell.update_in(cx, |s, window, cx| s.tick(true, window, cx));
    ready(&shell, cx);
    assert!(shell.read_with(cx, |s, _| s.connected));
    let selected = shell.read_with(cx, |s, _| s.state.selected.clone());
    let tab = shell.read_with(cx, |s, _| s.active().unwrap());
    let entity = shell.read_with(cx, |s, _| match &s.content[&s.key(&tab)] {
        Content::Session(v) => v.entity_id(),
        _ => panic!("session"),
    });
    drop(_restarted);
    shell.update_in(cx, |s, window, cx| s.tick(true, window, cx));
    cx.run_until_parked();
    draw(cx);
    assert!(!shell.read_with(cx, |s, _| s.connected));
    cx.simulate_keystrokes("ctrl-w");
    assert_eq!(
        shell.read_with(cx, |s, _| s.active()),
        Some(tab.clone()),
        "offline keys must not close hidden content"
    );
    assert_eq!(
        shell.read_with(cx, |s, _| s.state.selected.clone()),
        selected
    );
    assert_eq!(
        shell.read_with(cx, |s, _| match &s.content[&s.key(&tab)] {
            Content::Session(v) => v.entity_id(),
            _ => panic!("session"),
        }),
        entity
    );
    let _again = Fixture::on_port(url::Url::parse(&origin).unwrap().port().unwrap());
    shell.update_in(cx, |s, window, cx| s.tick(true, window, cx));
    ready(&shell, cx);
    assert!(shell.read_with(cx, |s, _| s.connected));
}

#[gpui::test]
fn shell_names_missing_and_rejected_tokens_without_leaking_them(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    for (token, problem) in [
        (None, "Token missing"),
        (Some("fixture-rejected".into()), "Token rejected"),
    ] {
        let (shell, mut visual) = open(
            Client::authenticated(&fixture.origin, token).unwrap(),
            fixture.root.join("auth.json"),
            State::default(),
            cx,
        );
        visual.run_until_parked();
        draw(&mut visual);
        assert_eq!(shell.read_with(&visual, |s, _| s.notice.clone()), problem);
        assert!(!shell.read_with(&visual, |s, _| s.connected));
        assert!(visual.debug_bounds("shell-retry").is_some());
    }
}

#[gpui::test]
fn shell_connection_checks_are_single_flight_and_keep_current_view(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("checks.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
    let before = shell.read_with(cx, |s, _| serde_json::to_value(&s.state).unwrap());
    shell.update_in(cx, |s, window, cx| {
        for _ in 0..20 {
            s.tick(true, window, cx);
        }
        assert!(s.loading);
    });
    cx.run_until_parked();
    draw(cx);
    assert_eq!(
        shell.read_with(cx, |s, _| serde_json::to_value(&s.state).unwrap()),
        before
    );
    assert!(shell.read_with(cx, |s, _| s.notice.is_empty()));
}

#[test]
fn round1_token_file_created_after_launch_connects_on_retry() {
    let fixture = Fixture::new();
    let token_file = fixture.root.join("late-token");
    let output = Process::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "shell::connection::tests::round1_late_token_child",
            "--nocapture",
        ])
        .env("O8_NEXT_TOKEN_FILE", &token_file)
        .env("O8_NEXT_TOKEN_ORIGIN", &fixture.origin)
        .env("O8_NEXT_CORRECTION_ORIGIN", &fixture.origin)
        .env("O8_NEXT_CORRECTION_STATE", fixture.root.join("late.json"))
        .env_remove("O8_NEXT_API_TOKEN")
        .env_remove("O8_API_TOKEN")
        .env_remove("O8_WORKER_TOKEN")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "late token must reconnect through the actual shell window: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[gpui::test]
#[ignore = "owned subprocess supplies isolated launcher configuration"]
fn round1_late_token_child(cx: &mut TestAppContext) {
    let origin = std::env::var("O8_NEXT_CORRECTION_ORIGIN").unwrap();
    let file = PathBuf::from(std::env::var("O8_NEXT_CORRECTION_STATE").unwrap());
    let (shell, mut visual) = open(
        Client::authenticated(&origin, None).unwrap(),
        file,
        State::default(),
        cx,
    );
    visual.run_until_parked();
    draw(&mut visual);
    assert!(!shell.read_with(&visual, |s, _| s.connected));
    fs::write(
        std::env::var("O8_NEXT_TOKEN_FILE").unwrap(),
        "fixture-wrong-bearer",
    )
    .unwrap();
    visual.simulate_keystrokes("f5");
    visual.run_until_parked();
    draw(&mut visual);
    assert!(!shell.read_with(&visual, |s, _| s.connected));
    assert_eq!(
        shell.read_with(&visual, |s, _| s.notice.clone()),
        "Token rejected"
    );
    fs::write(
        std::env::var("O8_NEXT_TOKEN_FILE").unwrap(),
        "fixture-shell-bearer",
    )
    .unwrap();
    visual.simulate_keystrokes("f5");
    visual.run_until_parked();
    draw(&mut visual);
    assert!(
        shell.read_with(&visual, |s, _| s.connected),
        "Retry must reread the newly created token file"
    );
}

#[gpui::test]
fn round1_reconnect_keeps_composer_focus_draft_and_queue(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("focus-reconnect.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    cx.simulate_keystrokes("ctrl-k n e w enter");
    ready(&shell, cx);
    cx.simulate_input("retained draft");
    let (view, session) = shell.read_with(cx, |s, _| {
        let Some(Tab::Session(id)) = s.active() else {
            panic!("session")
        };
        let Content::Session(v) = &s.content[&s.key(&Tab::Session(id.clone()))] else {
            panic!("session")
        };
        (
            v.clone(),
            s.sessions
                .iter()
                .find(|session| session.id == id)
                .unwrap()
                .clone(),
        )
    });
    let queue = fixture.client.queue(&session).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let dead =
        Client::authenticated(&format!("http://{}", listener.local_addr().unwrap()), None).unwrap();
    drop(listener);
    shell.update_in(cx, |s, _, cx| {
        s.client = dead;
        s.load(cx);
    });
    cx.run_until_parked();
    draw(cx);
    assert!(!shell.read_with(cx, |s, _| s.connected));
    shell.update_in(cx, |s, _, cx| {
        s.client = fixture.client.clone();
        s.load(cx);
    });
    ready(&shell, cx);
    cx.simulate_input(" after reconnect");
    assert_eq!(
        view.read_with(cx, |v, cx| v.shell_issue_state(cx)["draft"].clone()),
        json!("retained draft after reconnect")
    );
    assert_eq!(fixture.client.queue(&session).unwrap(), queue);
    cx.update(|window, cx| assert!(view.read(cx).shell_selection(window, cx).1));
}

#[gpui::test]
fn round1_connection_is_a_registered_module(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        Client::authenticated(&fixture.origin, None).unwrap(),
        fixture.root.join("module.json"),
        State::default(),
        cx,
    );
    visual.run_until_parked();
    draw(&mut visual);
    assert!(!shell.read_with(&visual, |s, _| s.connected));
    assert!(
        visual.debug_bounds("connection-state").is_some(),
        "connection state must render through its registered module"
    );
    assert!(!include_str!("../shell.rs").contains("Token missing"));
    assert!(!include_str!("../shell_view.rs").contains("Server down"));
    assert_eq!(
        include_str!("../shell.rs")
            .lines()
            .filter(|line| line.contains("surfaces/connection.rs"))
            .count(),
        1
    );
}
