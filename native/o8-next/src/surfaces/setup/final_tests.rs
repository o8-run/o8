use super::*;
static MATRIX: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn runtime_model_matrix(cx: &mut TestAppContext, backend: &str, saved: bool, api_key: bool) {
    let _matrix = MATRIX.lock().unwrap_or_else(|e| e.into_inner());
    let flags = if api_key && saved {
        "--onboarding --transcript --onboarding-model-matrix --onboarding-api-key-saved-model"
    } else if backend == "codex" && saved {
        "--onboarding --transcript --onboarding-model-matrix --onboarding-codex-saved-model"
    } else if backend == "pi" && saved {
        "--onboarding --transcript --onboarding-model-matrix --onboarding-pi-saved-model"
    } else {
        "--onboarding --transcript --onboarding-model-matrix"
    };
    let fixture = Fixture::start_mode(false, flags);
    for _ in 0..2 {
        let _: Value = fixture.client.get("/api/panel/operator-defaults", &[("include", "setup"), ("refresh", "runtime")]).unwrap();
    }
    let initial: Value = fixture.client.get("/api/panel/operator-defaults", &[("include", "values")]).unwrap();
    let mut update = json!({"orchestratorBackend":backend,"workerRuntimes":["codex"],"defaultDispatchRuntime":"codex","telemetryConsentAnswered":true,"productTelemetryEnabled":false,"crashReportsEnabled":false});
    if saved && backend == "claude" {
        fixture.client.setup_request("POST", "/api/panel/operator-defaults", &json!({"orchestratorBackend":"claude", "workerRuntimes":["claude-code"], "defaultDispatchRuntime":"claude-code"})).unwrap();
        let own: Value = fixture.client.get("/api/panel/operator-defaults", &[("include", "setup")]).unwrap();
        update["orchestratorModel"] = own["setupRecommendation"]["workerModel"].clone();
    }
    if saved && backend == "o8" {
        update["orchestratorModel"] = initial["values"]["orchestratorModel"].clone();
    }
    if saved && backend == "opencode" {
        update["opencodeOrchestratorModel"] = json!("fixture/selected-model");
    }
    fixture.client.setup_request("POST", "/api/panel/operator-defaults", &update).unwrap();
    let recommendation: Value = fixture.client.get("/api/panel/operator-defaults", &[("include", "setup")]).unwrap();
    let expected = match backend {
        "pi" if api_key => if saved { "openrouter/fixture/api-saved-model" } else { "openrouter/fixture/api-chosen-model" }.to_owned(),
        "pi" => if saved { "fixture/pi-saved-model" } else { "fixture/pi-chosen-model" }.to_owned(),
        "o8" => "o8-free".to_owned(),
        _ => recommendation["setupRecommendation"]["leadModel"].as_str().filter(|m| !m.trim().is_empty()).expect("existing runtime default").to_owned(),
    };
    let (shell, mut visual) = open(fixture.client.clone(), fixture.root.join("model-matrix.json"), State::default(), cx);
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    click(cx, "setup-project-0");
    if !saved && backend == "pi" {
        assert!(cx.debug_bounds("setup-model-input").is_some(), "{backend} without a default must ask for its model before conversation creation");
        assert!(fixture.client.sessions().unwrap().is_empty());
        click(cx, "setup-model-input");
        cx.simulate_input(&expected);
        click(cx, "setup-use");
    }
    assert!(shell.read_with(cx, |s, _| s.surfaces.setup.view.is_none()), "{backend}, saved={saved}: Continue must open a conversation with a resolved model");
    let session = shell.read_with(cx, |s, _| {
        let Some(Tab::Session(id)) = s.active() else { panic!("conversation") };
        s.sessions.iter().find(|v| v.id == id).unwrap().clone()
    });
    let history: Value = fixture.client.get("/api/v2/chat-history", &[("tabId", &session.id)]).unwrap();
    assert_eq!(history["backend"], backend);
    assert_eq!(history["model"], expected, "{backend}, saved={saved}: persisted runtime model");
    click(cx, "composer-input");
    cx.simulate_input("Model matrix first send");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    draw(cx);
    let queued = fixture.client.queue(&session).unwrap();
    let item = queued["items"].as_array().unwrap().iter().find(|i| i["payload"]["text"] == "Model matrix first send").expect("production first-send queue");
    assert_eq!(item["payload"]["routing"]["backend"], backend);
    assert_eq!(item["payload"]["routing"]["model"], expected);
    println!("MODEL_MATRIX backend={backend} saved={saved}: conversation and first queue retain the resolved model");
}

macro_rules! model_case {
    ($name:ident, $backend:literal, $saved:literal, $api_key:literal) => {
        #[gpui::test]
        fn $name(cx: &mut TestAppContext) { runtime_model_matrix(cx, $backend, $saved, $api_key); }
    };
}
model_case!(onboarding_matrix_claude_without_saved, "claude", false, false);
model_case!(onboarding_matrix_claude_with_saved, "claude", true, false);
model_case!(onboarding_matrix_codex_without_saved, "codex", false, false);
model_case!(onboarding_matrix_codex_with_saved, "codex", true, false);
model_case!(onboarding_matrix_opencode_without_saved, "opencode", false, false);
model_case!(onboarding_matrix_opencode_with_saved, "opencode", true, false);
model_case!(onboarding_matrix_pi_without_saved, "pi", false, false);
model_case!(onboarding_matrix_pi_with_saved, "pi", true, false);
model_case!(onboarding_matrix_api_key_without_saved, "pi", false, true);
model_case!(onboarding_matrix_api_key_with_saved, "pi", true, true);
model_case!(onboarding_matrix_managed_o8_without_saved, "o8", false, false);
model_case!(onboarding_matrix_managed_o8_with_saved, "o8", true, false);
