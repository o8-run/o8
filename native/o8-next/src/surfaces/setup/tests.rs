use crate::shell::test_support::*;
use crate::shell::*;

#[path = "correction_2_tests.rs"]
mod correction_2;

#[path = "final_tests.rs"]
mod final_round;

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    draw(cx);
    let bounds = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("missing control: {selector}"));
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    draw(cx);
}

#[gpui::test]
fn onboarding_registered_workspace_without_sessions_still_starts_setup(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--onboarding --transcript");
    let projects: Value = fixture.client.get("/api/panel/projects", &[]).unwrap();
    assert!(projects["projects"].as_array().unwrap().iter().any(|p| {
        p["repoPaths"]
            .as_array()
            .is_some_and(|paths| !paths.is_empty())
    }));
    assert!(fixture.client.sessions().unwrap().is_empty());
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("registered-first-run.json"),
        State::default(),
        cx,
    );
    visual.run_until_parked();
    draw(&mut visual);
    assert!(shell.read_with(&visual, |s, _| !s.workspaces.is_empty()));
    assert!(
        visual.debug_bounds("setup-projects").is_some(),
        "registered paths without saved conversations must still enter first-run setup"
    );
}

#[gpui::test]
fn onboarding_project_tools_privacy_and_workspace(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--onboarding --transcript");
    let start = Instant::now();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("first-run.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    let opened = start.elapsed().as_secs_f64() * 1000.;
    assert!(
        cx.debug_bounds("setup-projects").is_some(),
        "first run must paint project setup"
    );
    let before: Value = fixture
        .client
        .get("/api/panel/operator-defaults", &[("include", "values")])
        .unwrap();
    assert_ne!(
        before["sources"]["orchestratorBackend"], "file",
        "discovery must not save defaults"
    );
    click(cx, "setup-project-0");
    assert!(
        cx.debug_bounds("setup-tools").is_some(),
        "an unavailable CLI must lead to tool setup"
    );
    click(cx, "setup-lead-gemini");
    click(cx, "setup-use");
    let unchanged: Value = fixture
        .client
        .get("/api/panel/operator-defaults", &[("include", "values")])
        .unwrap();
    assert_eq!(
        before["values"], unchanged["values"],
        "unavailable runtime cannot save"
    );
    click(cx, "setup-refresh");
    click(cx, "setup-lead-codex");
    click(cx, "setup-worker-claude-code");
    click(cx, "setup-use");
    assert!(cx.debug_bounds("setup-privacy").is_some());
    click(cx, "setup-telemetry");
    click(cx, "setup-consent");
    cx.run_until_parked();
    draw(cx);
    let saved: Value = fixture
        .client
        .get("/api/panel/operator-defaults", &[("include", "values")])
        .unwrap();
    assert_eq!(saved["values"]["orchestratorBackend"], "codex");
    assert_eq!(
        saved["values"]["workerRuntimes"],
        json!(["codex", "claude-code"])
    );
    assert_eq!(saved["values"]["productTelemetryEnabled"], true);
    assert_eq!(saved["values"]["crashReportsEnabled"], false);
    assert_eq!(saved["values"]["telemetryConsentAnswered"], true);
    let config: Value = fixture.client.get("/api/setup/config", &[]).unwrap();
    assert_eq!(config["setupComplete"], true);
    assert!(
        config["completedAt"]
            .as_str()
            .is_some_and(|s| s.ends_with('Z'))
    );
    let repos: Value = fixture.client.get("/api/panel/repos", &[]).unwrap();
    let selected = shell.read_with(cx, |s, _| {
        s.state.selected.clone().expect("opened workspace")
    });
    assert_eq!(
        fs::canonicalize(selected).unwrap(),
        fs::canonicalize(repos["repos"][0]["localPath"].as_str().unwrap()).unwrap()
    );
    assert!(shell.read_with(cx, |s, _| s.surfaces.setup.view.is_none()));
    assert!(
        matches!(
            shell.read_with(cx, |s, _| s.active()),
            Some(Tab::Session(_))
        ),
        "onboarding must open a conversation"
    );
    assert!(
        cx.debug_bounds("composer-input").is_some(),
        "a new workspace must have a message input"
    );
    click(cx, "composer-input");
    cx.simulate_input("First workspace fixture message");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    draw(cx);
    let session = shell.read_with(cx, |s, _| {
        let Some(Tab::Session(id)) = s.active() else {
            panic!("conversation");
        };
        s.sessions
            .iter()
            .find(|session| session.id == id)
            .unwrap()
            .clone()
    });
    let queued = fixture.client.queue(&session).unwrap();
    assert!(
        queued["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["payload"]["text"] == "First workspace fixture message"),
        "the opened workspace must persist a send through the production queue"
    );
    let start = Instant::now();
    click(cx, "setup-open");
    let interaction = start.elapsed().as_secs_f64() * 1000.;
    assert!(cx.debug_bounds("setup-projects").is_some());
    click(cx, "setup-close");
    assert!(shell.read_with(cx, |s, _| s.surfaces.setup.view.is_none()));
    println!(
        "O8_NEXT_ONBOARDING_EVIDENCE {}",
        json!({"endpoint":"headless GPUI CPU scene; no GPU/compositor", "openToFirstFrameMs":opened,"interactionToFrameMs":interaction})
    );
}

#[gpui::test]
fn onboarding_opencode_keeps_selected_model_for_first_send(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--onboarding --transcript");
    fixture.client.project_request("POST", "/api/panel/operator-defaults", &json!({
        "orchestratorBackend":"opencode", "opencodeOrchestratorModel":"fixture/selected-model",
        "workerRuntimes":["opencode"], "defaultDispatchRuntime":"opencode",
    })).unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("opencode.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    click(cx, "setup-project-0");
    click(cx, "setup-refresh");
    click(cx, "setup-lead-opencode");
    click(cx, "setup-use");
    click(cx, "setup-consent");
    assert!(shell.read_with(cx, |s, _| s.surfaces.setup.view.is_none()));
    let session = shell.read_with(cx, |s, _| {
        let Some(Tab::Session(id)) = s.active() else {
            panic!("conversation");
        };
        s.sessions
            .iter()
            .find(|session| session.id == id)
            .unwrap()
            .clone()
    });
    let history: Value = fixture
        .client
        .get("/api/v2/chat-history", &[("tabId", &session.id)])
        .unwrap();
    assert_eq!(history["backend"], "opencode");
    assert_eq!(
        history["model"], "fixture/selected-model",
        "setup must persist the selected runtime's model"
    );
    click(cx, "composer-input");
    cx.simulate_input("OpenCode first message");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    draw(cx);
    let queued = fixture.client.queue(&session).unwrap();
    let item = queued["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["payload"]["text"] == "OpenCode first message")
        .expect("first send must persist through the production queue");
    assert_eq!(item["payload"]["routing"]["backend"], "opencode");
    assert_eq!(
        item["payload"]["routing"]["model"],
        "fixture/selected-model"
    );
}

#[gpui::test]
fn onboarding_folder_registration_error_and_cancel(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--onboarding --transcript");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("folder.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    click(cx, "setup-folder");
    click(cx, "setup-folder-input");
    cx.simulate_input(fixture.root.join("missing").to_str().unwrap());
    click(cx, "setup-add");
    assert!(cx.debug_bounds("setup-error").is_some());
    click(cx, "setup-cancel-folder");
    assert_eq!(
        shell.read_with(cx, |s, cx| s
            .surfaces
            .setup
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .painted_page()),
        Some("projects")
    );
    let repo = fixture.root.join("added-repo");
    fs::create_dir(&repo).unwrap();
    assert!(
        Process::new("git")
            .args(["init", "-q"])
            .arg(&repo)
            .status()
            .unwrap()
            .success()
    );
    click(cx, "setup-folder");
    click(cx, "setup-folder-input");
    cx.simulate_input(repo.to_str().unwrap());
    click(cx, "setup-add");
    let registered: Value = fixture.client.get("/api/panel/repos", &[]).unwrap();
    assert!(registered["repos"].as_array().unwrap().iter().any(|r| {
        fs::canonicalize(r["localPath"].as_str().unwrap()).unwrap()
            == fs::canonicalize(&repo).unwrap()
    }));
    assert!(cx.debug_bounds("setup-tools").is_some());
    click(cx, "setup-back");
    assert!(cx.debug_bounds("setup-projects").is_some());
}

#[gpui::test]
fn onboarding_operator_auth_error_retry(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--onboarding --transcript");
    // The same origin with no bearer must never reveal or change setup.
    let client = Client::authenticated(&fixture.origin, None).unwrap();
    let (_shell, mut visual) = open(
        client,
        fixture.root.join("refused.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    click(cx, "setup-open");
    assert!(cx.debug_bounds("setup-error").is_some());
    click(cx, "setup-refresh");
    assert!(cx.debug_bounds("setup-error").is_some());
    assert!(cx.debug_bounds("setup-project-0").is_none());
}
