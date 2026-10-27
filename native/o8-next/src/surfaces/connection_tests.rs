use super::*;
use crate::shell::test_support::*;
// Drive main's retained sidebar lifecycle too: a streamed update can fence an
// in-flight HTTP load, which is retried by the normal shell tick.
fn settled(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    // Allow the production GET budget, then time for the shell to apply its result.
    let deadline = Instant::now() + crate::client::LOAD_REQUEST_TIMEOUT + Duration::from_secs(5);
    loop {
        shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
        cx.run_until_parked();
        draw(cx);
        if !shell.read_with(cx, |s, _| s.loading) {
            return;
        }
        assert!(Instant::now() < deadline, "connection load must settle");
        std::thread::sleep(Duration::from_millis(10));
    }
}
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
    settled(&shell, cx);
    assert_eq!(shell.read_with(cx, |s, _| s.notice.clone()), "Server down");
    let _restarted = Fixture::on_port(url::Url::parse(&origin).unwrap().port().unwrap());
    shell.update_in(cx, |s, window, cx| s.tick(true, window, cx));
    ready(&shell, cx);
    settled(&shell, cx);
    assert!(shell.read_with(cx, |s, _| s.connected));
    let selected = shell.read_with(cx, |s, _| s.state.selected.clone());
    let tab = shell.read_with(cx, |s, _| s.active().unwrap());
    let entity = shell.read_with(cx, |s, _| match &s.content[&s.key(&tab)] {
        Content::Session(v) => v.entity_id(),
        _ => panic!("session"),
    });
    drop(_restarted);
    shell.update_in(cx, |s, window, cx| s.tick(true, window, cx));
    settled(&shell, cx);
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
    settled(&shell, cx);
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
        settled(&shell, &mut visual);
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
    settled(&shell, cx);
    shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
    let before = shell.read_with(cx, |s, _| serde_json::to_value(&s.state).unwrap());
    shell.update_in(cx, |s, window, cx| {
        for _ in 0..20 {
            s.tick(true, window, cx);
        }
        assert!(s.loading);
    });
    settled(&shell, cx);
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
        .env_remove("O8_NEXT_TOKEN_FILES")
        .env("O8_NEXT_TOKEN_ORIGIN", &fixture.origin)
        .env("O8_NEXT_CORRECTION_ORIGIN", &fixture.origin)
        .env("O8_NEXT_CORRECTION_STATE", fixture.root.join("late.json"))
        .env_remove("O8_NEXT_API_TOKEN")
        .env_remove("O8_API_TOKEN")
        .env_remove("O8_WORKER_TOKEN")
        .output()
        .unwrap();
    assert!(
        output.status.success()
            && String::from_utf8_lossy(&output.stdout)
                .contains("test result: ok. 1 passed; 0 failed"),
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
    settled(&shell, &mut visual);
    assert!(!shell.read_with(&visual, |s, _| s.connected));
    fs::write(
        std::env::var("O8_NEXT_TOKEN_FILE").unwrap(),
        "fixture-wrong-bearer",
    )
    .unwrap();
    visual.simulate_keystrokes("f5");
    settled(&shell, &mut visual);
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
    settled(&shell, &mut visual);
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
    settled(&shell, cx);
    cx.simulate_keystrokes("ctrl-k n e w enter");
    ready(&shell, cx);
    settled(&shell, cx);
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
    // Retained sidebar clients deliberately keep their selected origin. Pause
    // that actual host so recovery preserves its persisted queue and identity.
    struct ResumeHost(u32);
    impl Drop for ResumeHost {
        fn drop(&mut self) {
            let _ = Process::new("kill")
                .arg("-CONT")
                .arg(self.0.to_string())
                .status();
        }
    }
    let resume = ResumeHost(fixture.server.id());
    assert!(
        Process::new("kill")
            .arg("-STOP")
            .arg(fixture.server.id().to_string())
            .status()
            .unwrap()
            .success()
    );
    shell.update_in(cx, |s, _, cx| s.load(cx));
    settled(&shell, cx);
    assert!(!shell.read_with(cx, |s, _| s.connected));
    drop(resume);
    shell.update_in(cx, |s, _, cx| s.load(cx));
    ready(&shell, cx);
    settled(&shell, cx);
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
    settled(&shell, &mut visual);
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

#[test]
fn round2_rotation_reaches_retained_composer_and_request_clones() {
    let fixture = Fixture::new();
    let server_token = PathBuf::from(
        fixture.client.sessions().unwrap()[0]
            .repo_path
            .as_ref()
            .unwrap(),
    )
    .parent()
    .unwrap()
    .join("data/ws-token");
    assert!(server_token.is_file());
    let token_file = fixture.root.join("client-token");
    fs::copy(&server_token, &token_file).unwrap();
    let output = Process::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "shell::connection::tests::round2_rotation_child",
            "--nocapture",
        ])
        .env("O8_NEXT_TOKEN_FILE", &token_file)
        .env("O8_NEXT_CORRECTION_SERVER_TOKEN", &server_token)
        .env_remove("O8_NEXT_TOKEN_FILES")
        .env("O8_NEXT_TOKEN_ORIGIN", &fixture.origin)
        .env("O8_NEXT_CORRECTION_ORIGIN", &fixture.origin)
        .env(
            "O8_NEXT_CORRECTION_STATE",
            fixture.root.join("rotation.json"),
        )
        .env_remove("O8_NEXT_API_TOKEN")
        .env_remove("O8_API_TOKEN")
        .env_remove("O8_WORKER_TOKEN")
        .output()
        .unwrap();
    assert!(
        output.status.success()
            && String::from_utf8_lossy(&output.stdout)
                .contains("test result: ok. 1 passed; 0 failed"),
        "retained requests must rotate with the shell: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[gpui::test]
#[ignore = "owned subprocess supplies isolated launcher configuration"]
fn round2_rotation_child(cx: &mut TestAppContext) {
    let origin = std::env::var("O8_NEXT_CORRECTION_ORIGIN").unwrap();
    let token_file = PathBuf::from(std::env::var("O8_NEXT_TOKEN_FILE").unwrap());
    let (wake, wakeups) = async_channel::bounded(1);
    let (shell, mut visual) = open(
        Client::authenticated(&origin, None)
            .unwrap()
            .with_wakeup(wake),
        PathBuf::from(std::env::var("O8_NEXT_CORRECTION_STATE").unwrap()),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    settled(&shell, cx);
    cx.simulate_keystrokes("ctrl-k c o m p o s e r - f i r s t enter");
    ready(&shell, cx);
    settled(&shell, cx);
    cx.simulate_keystrokes("ctrl-k n e w enter");
    ready(&shell, cx);
    settled(&shell, cx);
    let (view, session, retained) = shell.read_with(cx, |s, _| {
        let Some(Tab::Session(id)) = s.active() else {
            panic!("session")
        };
        let Content::Session(view) = &s.content[&s.key(&Tab::Session(id.clone()))] else {
            panic!("session")
        };
        (
            view.clone(),
            s.sessions
                .iter()
                .find(|session| session.id == id)
                .unwrap()
                .clone(),
            s.client.in_workspace(s.state.selected.as_deref().unwrap()),
        )
    });
    cx.simulate_input("message after rotation");
    let rotated = "fixture-shell-rotated-operator";
    let server_token = PathBuf::from(std::env::var("O8_NEXT_CORRECTION_SERVER_TOKEN").unwrap());
    for file in [&token_file, &server_token] {
        let replacement = file.with_extension("replacement");
        fs::write(&replacement, rotated).unwrap();
        fs::rename(&replacement, file).unwrap();
    }
    shell.update_in(cx, |s, w, cx| s.tick(true, w, cx));
    settled(&shell, cx);
    assert!(
        shell.read_with(cx, |s, _| s.connected),
        "the shell must reconnect with the rotated credential"
    );
    cx.simulate_keystrokes("enter");
    settled(&shell, cx);
    let state = view.read_with(cx, |view, cx| view.shell_issue_state(cx));
    assert_eq!(
        state["draft"],
        json!(""),
        "the retained composer must send with the rotated credential; notice: {}",
        state["notice"]
    );
    assert!(
        retained.sessions().is_ok(),
        "a previously cloned request client must share the refreshed credential"
    );
    assert!(
        retained.websocket().is_ok(),
        "WebSocket-info reacquisition must use the refreshed authority"
    );
    while wakeups.try_recv().is_ok() {}
    retained.wake();
    assert!(
        wakeups.try_recv().is_ok(),
        "credential rotation must preserve retained client wakeups"
    );
    let queue = retained.queue(&session).unwrap();
    assert!(
        queue["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["payload"]["text"] == "message after rotation")
    );
    assert!(
        Client::authenticated(&origin, Some("fixture-shell-bearer".into()))
            .unwrap()
            .sessions()
            .is_err(),
        "independent clients must not acquire this shell's authority"
    );
    shell.read_with(cx, |s, _| match &s.content[&s.key(&s.active().unwrap())] {
        Content::Session(current) => assert_eq!(current.entity_id(), view.entity_id()),
        _ => panic!("retained session"),
    });
    fs::write(&token_file, "invalid\ncredential").unwrap();
    shell.update_in(cx, |s, _, cx| s.load(cx));
    settled(&shell, cx);
    assert!(!shell.read_with(cx, |s, _| s.connected));
    assert!(
        retained.sessions().is_err(),
        "invalid credentials must revoke retained request clients"
    );
    fs::remove_file(&token_file).unwrap();
    shell.update_in(cx, |s, _, cx| s.load(cx));
    settled(&shell, cx);
    assert!(!shell.read_with(cx, |s, _| s.connected));
    assert!(
        retained.sessions().is_err(),
        "a missing credential must revoke retained request clients"
    );
    fs::write(&token_file, rotated).unwrap();
    shell.update_in(cx, |s, _, cx| s.load(cx));
    settled(&shell, cx);
    assert!(shell.read_with(cx, |s, _| s.connected));
    assert!(retained.sessions().is_ok());
}

#[test]
fn round2_legacy_candidates_reach_the_real_shell() {
    let fixture = Fixture::new();
    let sessions = fixture.client.sessions().unwrap();
    let token_file = PathBuf::from(sessions[0].repo_path.as_ref().unwrap())
        .parent()
        .unwrap()
        .join("data/ws-token");
    let missing = fixture.root.join("current-token");
    let output = Process::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "shell::connection::tests::round2_legacy_child",
            "--nocapture",
        ])
        .env("O8_NEXT_TOKEN_FILE", &missing)
        .env(
            "O8_NEXT_TOKEN_FILES",
            serde_json::to_string(&vec![&missing, &token_file]).unwrap(),
        )
        .env("O8_NEXT_TOKEN_ORIGIN", &fixture.origin)
        .env("O8_NEXT_CORRECTION_ORIGIN", &fixture.origin)
        .env("O8_NEXT_CORRECTION_STATE", fixture.root.join("legacy.json"))
        .env_remove("O8_NEXT_API_TOKEN")
        .env_remove("O8_API_TOKEN")
        .env_remove("O8_WORKER_TOKEN")
        .output()
        .unwrap();
    assert!(
        output.status.success()
            && String::from_utf8_lossy(&output.stdout)
                .contains("test result: ok. 1 passed; 0 failed"),
        "legacy authority must survive reload: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[gpui::test]
#[ignore = "owned subprocess supplies isolated launcher configuration"]
fn round2_legacy_child(cx: &mut TestAppContext) {
    let origin = std::env::var("O8_NEXT_CORRECTION_ORIGIN").unwrap();
    let (shell, mut visual) = open(
        Client::authenticated(&origin, Some("fixture-shell-bearer".into())).unwrap(),
        PathBuf::from(std::env::var("O8_NEXT_CORRECTION_STATE").unwrap()),
        State::default(),
        cx,
    );
    settled(&shell, &mut visual);
    assert!(
        shell.read_with(&visual, |s, _| s.connected),
        "reload must resolve the valid legacy candidate instead of reporting Token missing"
    );
}

#[gpui::test]
fn reconnect_preserves_main_palette_recovery_and_shortcut_commands(cx: &mut TestAppContext) {
    let mut fixture = Fixture::new();
    fixture.server.kill().unwrap();
    fixture.server.wait().unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("offline-main-commands.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    settled(&shell, cx);
    cx.simulate_keystrokes("ctrl-shift-p");
    draw(cx);
    assert!(cx.debug_bounds("command-palette").is_some());
    assert!(shell.read_with(cx, |s, _| {
        s.commands()
            .iter()
            .any(|entry| matches!(entry, palette::Entry::Surface(Command::Refresh)))
    }));
    shell.update_in(cx, |s, window, cx| s.execute(Command::Refresh, window, cx));
    settled(&shell, cx);
    assert_eq!(shell.read_with(cx, |s, _| s.notice.clone()), "Server down");
    shell.update_in(cx, |s, window, cx| {
        s.execute(Command::Shortcuts, window, cx)
    });
    draw(cx);
    assert!(cx.debug_bounds("shortcut-reference").is_some());
}
