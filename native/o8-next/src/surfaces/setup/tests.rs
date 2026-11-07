use crate::shell::test_support::*;
use crate::shell::*;

#[path = "correction_2_tests.rs"]
mod correction_2;

#[path = "final_tests.rs"]
mod final_round;

#[path = "frame_tests.rs"]
mod frame;

#[path = "import_tests.rs"]
mod import;

#[path = "new_project_tests.rs"]
mod new_project;

#[path = "tools_tests.rs"]
mod tools;

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    draw(cx);
    reveal(cx, selector);
    let bounds = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("missing control: {selector}"));
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    draw(cx);
}

#[gpui::test]
fn setup_deferred_first_run_does_not_cover_later_global_navigation(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--shell --bots --inbox-empty");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("global-first-run.json"),
        State::default(),
        cx,
    );
    for _ in 0..6 {
        visual.run_until_parked();
        draw(&mut visual);
    }
    assert!(
        shell.read_with(&visual, |s, _| s.surfaces.setup.view.is_some()),
        "first-run Setup still opens when there is no active global surface"
    );
    shell.update_in(&mut visual, |s, window, cx| {
        assert!(s.connected && !s.loading);
        assert!(s.active().is_none());
        s.surfaces.setup.view = None;
        s.surfaces.setup.first_run_checked.set(false);
        (setup::REGISTRATION.nav)(s, NavPosition::BeforeWorkspaces, cx);
        assert!(
            s.surfaces.setup.first_run_checked.get(),
            "queue the real first-run callback before navigating"
        );
        s.execute(Command::Bot("grok:agent-1".into()), window, cx);
    });
    visual.run_until_parked();
    draw(&mut visual);
    ready(&shell, &mut visual);
    assert_eq!(
        shell.read_with(&visual, |s, _| s.active()),
        Some(Tab::Bot("grok:agent-1".into()))
    );
    assert!(
        shell.read_with(&visual, |s, _| s.surfaces.setup.view.is_none()),
        "a queued first-run callback cannot cover a later global rail click"
    );
    assert!(visual.debug_bounds("bot-thread").is_some());
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
    // A tool that is not ready cannot be chosen, so nothing is saved.
    refresh_tools(cx);
    click(cx, "setup-customize");
    click(cx, "setup-worker-gemini");
    let unchanged: Value = fixture
        .client
        .get("/api/panel/operator-defaults", &[("include", "values")])
        .unwrap();
    assert_eq!(
        before["values"], unchanged["values"],
        "unavailable runtime cannot save"
    );
    click(cx, "setup-customize");
    choose_lead(cx, "codex");
    click(cx, "setup-customize");
    click(cx, "setup-worker-claude-code");
    click(cx, "setup-use");
    assert!(cx.debug_bounds("setup-privacy").is_some());
    // As on the desktop, saving waits for a crash-report choice, and the
    // usage analytics choice is saved as soon as it changes.
    click(cx, "setup-consent");
    assert!(
        cx.debug_bounds("setup-privacy").is_some(),
        "no crash choice yet"
    );
    click(cx, "setup-telemetry");
    let usage: Value = fixture
        .client
        .get("/api/panel/operator-defaults", &[("include", "values")])
        .unwrap();
    assert_eq!(usage["values"]["productTelemetryEnabled"], false);
    assert_ne!(usage["values"]["telemetryConsentAnswered"], true);
    scroll_privacy(cx);
    assert!(cx.debug_bounds("setup-crash-sample-payload").is_none());
    click(cx, "setup-crash-sample");
    assert!(cx.debug_bounds("setup-crash-sample-payload").is_some());
    scroll_privacy(cx);
    click(cx, "setup-crashes-share");
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
    assert_eq!(saved["values"]["productTelemetryEnabled"], false);
    assert_eq!(saved["values"]["crashReportsEnabled"], true);
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
    click(cx, "rail-more");
    click(cx, "rail-more-setup");
    let interaction = start.elapsed().as_secs_f64() * 1000.;
    assert!(cx.debug_bounds("setup-projects").is_some());
    // Reopened setup owns the whole window, as on the desktop, and ends
    // through its own pages; the workspace then comes back.
    assert!(cx.debug_bounds("setup-window").is_some());
    assert!(cx.debug_bounds("rail-more").is_none());
    click(cx, "setup-explore");
    assert!(shell.read_with(cx, |s, _| s.surfaces.setup.view.is_none()));
    assert!(cx.debug_bounds("rail-more").is_some());
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
    refresh_tools(cx);
    use_only_opencode(cx);
    click(cx, "setup-use");
    scroll_privacy(cx);
    click(cx, "setup-crashes-off");
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
    click(cx, "rail-more");
    click(cx, "rail-more-setup");
    assert!(cx.debug_bounds("setup-error").is_some());
    click(cx, "setup-refresh");
    assert!(cx.debug_bounds("setup-error").is_some());
    assert!(cx.debug_bounds("setup-project-0").is_none());
}

/// Scroll the privacy choices to their end, where the crash-report choice
/// sits, as a person would before choosing.
/// Check the tools again from Add coding tools, then return to the choices.
/// With no ready tool the step already shows tool setup, as on the desktop.
pub(super) fn refresh_tools(cx: &mut VisualTestContext) {
    draw(cx);
    if cx.debug_bounds("setup-add-tools").is_some() {
        click(cx, "setup-add-tools");
    }
    click(cx, "setup-refresh-tools");
    // Once a tool is ready the choices come back on their own.
    if cx.debug_bounds("setup-back-choices").is_some() {
        click(cx, "setup-back-choices");
    }
}
/// Choose a lead as a person does: a readiness card for Codex and Claude
/// Code, otherwise Customize's lead picker.
pub(super) fn choose_lead(cx: &mut VisualTestContext, backend: &str) {
    let card = match backend {
        "codex" => Some("setup-agent-codex"),
        "claude" => Some("setup-agent-claude-code"),
        _ => None,
    };
    draw(cx);
    if let Some(card) = card.filter(|card| cx.debug_bounds(card).is_some()) {
        click(cx, card);
        return;
    }
    click(cx, "setup-customize");
    click(cx, "setup-lead-picker");
    click(
        cx,
        Box::leak(format!("setup-lead-option-{backend}").into_boxed_str()),
    );
    click(cx, "setup-customize");
}
/// OpenCode as the lead and the only worker, from Customize.
pub(super) fn use_only_opencode(cx: &mut VisualTestContext) {
    choose_lead(cx, "opencode");
    click(cx, "setup-customize");
    click(cx, "setup-worker-opencode");
    click(cx, "setup-worker-codex");
    click(cx, "setup-customize");
}

pub(super) fn scroll_privacy(cx: &mut VisualTestContext) {
    draw(cx);
    let bounds = cx
        .debug_bounds("setup-privacy-scroll")
        .expect("privacy choices");
    cx.simulate_event(gpui::ScrollWheelEvent {
        position: bounds.center(),
        delta: gpui::ScrollDelta::Pixels(gpui::point(gpui::px(0.), gpui::px(-5000.))),
        ..Default::default()
    });
    cx.run_until_parked();
    draw(cx);
}

/// Tools step controls outside its scrolling area, always in view.
const FIXED: [&str; 6] = [
    "setup-use",
    "setup-later",
    "setup-refresh-tools",
    "setup-back-choices",
    "setup-back",
    "setup-next-action",
];
/// Scroll setup's page until a control is inside the window, as a person
/// would before clicking it. Setup pages taller than the window scroll.
fn reveal(cx: &mut VisualTestContext, selector: &'static str) {
    for _ in 0..6 {
        // A page with a docked action row scrolls inside its own area.
        let inner = cx.debug_bounds("setup-tools-scroll");
        let (Some(window), Some(target), Some(page)) = (
            inner.or_else(|| cx.debug_bounds("setup-window")),
            cx.debug_bounds(selector),
            inner.or_else(|| cx.debug_bounds("setup-content")),
        ) else {
            return;
        };
        let (pad_bottom, pad_top) = if inner.is_some() {
            (gpui::px(4.), gpui::px(4.))
        } else {
            (gpui::px(48.), gpui::px(52.))
        };
        // The header and the docked action row sit outside that area.
        if inner.is_some() && FIXED.contains(&selector) {
            return;
        }
        let below = target.bottom() - window.bottom() + pad_bottom;
        let above = window.top() + pad_top - target.top();
        let delta = if below > gpui::px(0.) {
            -below
        } else if above > gpui::px(0.) {
            above
        } else {
            return;
        };
        cx.simulate_event(gpui::ScrollWheelEvent {
            position: page.center(),
            delta: gpui::ScrollDelta::Pixels(gpui::point(gpui::px(0.), delta)),
            ..Default::default()
        });
        cx.run_until_parked();
        draw(cx);
    }
}
