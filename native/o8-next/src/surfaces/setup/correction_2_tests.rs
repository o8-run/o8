use super::*;

fn fresh_opencode_first_send(cx: &mut TestAppContext, change_workers: bool) {
    let fixture = Fixture::start_mode(false, "--onboarding --transcript");
    let initial: Value = fixture
        .client
        .get("/api/panel/operator-defaults", &[("include", "values")])
        .unwrap();
    assert!(initial["values"]["opencodeOrchestratorModel"].is_null());
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("fresh-opencode.json"),
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
    let recommendation: Value = fixture
        .client
        .get("/api/panel/operator-defaults", &[("include", "setup")])
        .unwrap();
    // With no saved model or CLI model configuration, this comes from the
    // production runtime capability registry, rather than a copied model ID.
    assert_eq!(
        recommendation["setupRecommendation"]["workerRuntimes"][0],
        "opencode"
    );
    let default_model = recommendation["setupRecommendation"]["workerModel"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(default_model.contains('/'));
    if change_workers {
        click(cx, "setup-back");
        click(cx, "setup-change-tools");
        click(cx, "setup-worker-codex");
        click(cx, "setup-worker-opencode");
        click(cx, "setup-use");
    }
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
        history["model"], default_model,
        "fresh OpenCode setup must use its own runtime default, independently of the worker pool"
    );
    click(cx, "composer-input");
    cx.simulate_input("Fresh OpenCode first send");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    draw(cx);
    let queued = fixture.client.queue(&session).unwrap();
    let item = queued["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["payload"]["text"] == "Fresh OpenCode first send")
        .expect("first send must reach the production queue");
    assert_eq!(item["payload"]["routing"]["backend"], "opencode");
    assert_eq!(item["payload"]["routing"]["model"], default_model);
}

#[gpui::test]
fn onboarding_fresh_opencode_uses_its_own_default(cx: &mut TestAppContext) {
    fresh_opencode_first_send(cx, false);
}

#[gpui::test]
fn onboarding_opencode_default_is_independent_of_codex_workers(cx: &mut TestAppContext) {
    fresh_opencode_first_send(cx, true);
}

#[gpui::test]
fn onboarding_registry_hooks_are_optional_for_other_surfaces(cx: &mut TestAppContext) {
    // The unchanged main probe supplies only its own module and registration
    // line. Setup does not add lifecycle requirements to its constructor.
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("optional-hooks.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-alt-j");
    ready(&shell, &mut visual);
    assert_eq!(shell.read_with(&visual, |s, _| s.active()), Some(Tab::Fake));
    assert!(visual.debug_bounds("registration-probe-view").is_some());
    assert!(shell.read_with(&visual, |s, _| s.surfaces.setup.view.is_none()));
}

#[gpui::test]
fn onboarding_missing_model_refuses_conversation_creation(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--onboarding --onboarding-empty-model --transcript");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("missing-model.json"),
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
    assert!(
        shell.read_with(cx, |s, _| s.surfaces.setup.view.is_some()),
        "a missing model must ask for a runtime model instead of opening a conversation"
    );
    assert!(cx.debug_bounds("setup-model-input").is_some());
    assert!(
        fixture.client.sessions().unwrap().is_empty(),
        "no conversation may persist a fallback from another runtime"
    );
    let config: Value = fixture.client.get("/api/setup/config", &[]).unwrap();
    assert_ne!(config["setupComplete"], true);
}
