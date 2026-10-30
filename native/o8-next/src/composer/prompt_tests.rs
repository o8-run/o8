use super::prompt_acceptance_tests::*;
use super::*;

#[gpui::test]
fn native_composer_controls_orchestrate_routes_one_fleet_turn_without_changing_the_mode(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    click("send-mode-steer", cx);
    focus(&surface, cx);
    cx.simulate_input("/orchestrate Coordinate this task");
    cx.simulate_keystrokes("enter");
    wait(&surface, cx, |s, _| {
        !s.saving
            && s.queue["items"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
    });
    surface.read_with(cx, |s, cx| {
        let payload = &s.queue["items"][0]["payload"];
        assert_eq!(payload["text"], "/orchestrate Coordinate this task");
        assert_eq!(payload["routing"]["mode"], "fleet");
        assert_eq!(payload["routing"]["pickedMode"], "multitask");
        assert!(
            payload["wireMessage"]
                .as_str()
                .unwrap()
                .contains("Coordinate this task")
        );
        assert_eq!(
            s.composer_routing(cx).unwrap()["pickedMode"],
            "solo",
            "the explicit route must not overwrite the operator's mode preference"
        );
    });
}

#[gpui::test]
fn native_composer_controls_runtime_prefix_opens_a_confirmed_unsent_draft(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    focus(&surface, cx);
    cx.simulate_input("/codex Carry this task into a fresh draft");
    cx.simulate_keystrokes("enter");
    wait(&surface, cx, |s, _| {
        s.selected.as_deref() != Some("thoughts-composer-first") && s.queue_ready
    });
    surface.read_with(cx, |s, cx| {
        let id = s.selected.as_ref().unwrap();
        let session = s.sessions.iter().find(|session| &session.id == id).unwrap();
        assert_eq!(session.backend.as_deref(), Some("codex"));
        assert_eq!(
            s.composer.read(cx).text,
            "Carry this task into a fresh draft"
        );
        assert!(s.queue["items"].as_array().unwrap().is_empty());
        let history: Value = fixture
            .client
            .get("/api/v2/chat-history", &[("tabId", id)])
            .unwrap();
        assert_eq!(history["backend"], "codex");
        assert!(history["messages"].as_array().unwrap().is_empty());
    });
}

#[gpui::test]
fn native_composer_controls_unregistered_destinations_preserve_the_draft(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    for raw in ["/chat Retain this message", "/gemini Retain this task"] {
        focus(&surface, cx);
        cx.simulate_keystrokes("ctrl-a");
        cx.simulate_input(raw);
        cx.simulate_keystrokes("enter");
        wait(&surface, cx, |s, cx| {
            !s.composer.read(cx).controls.busy
                && s.composer.read(cx).controls.error.contains("retained")
        });
        surface.read_with(cx, |s, cx| {
            assert_eq!(s.composer.read(cx).text, raw);
            assert_eq!(s.selected.as_deref(), Some("thoughts-composer-first"));
            assert!(s.queue["items"].as_array().unwrap().is_empty());
        });
    }
}
#[gpui::test]
fn native_composer_controls_refused_command_retains_the_draft(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    focus(&surface, cx);
    cx.simulate_input("/rule Keep the operator's scope");
    draw(cx);
    assert!(cx.debug_bounds("composer-slash-menu").is_some());
    cx.simulate_keystrokes("enter");
    wait(&surface, cx, |s, cx| {
        !s.composer.read(cx).controls.busy && !s.composer.read(cx).controls.error.is_empty()
    });
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.composer.read(cx).text, "/rule Keep the operator's scope");
        assert!(s.queue["items"].as_array().unwrap().is_empty());
    });
}

#[gpui::test]
fn native_composer_controls_rule_send_button_and_manager_use_persisted_routes(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    focus(&surface, cx);
    cx.simulate_input("/rule Retain the selected thread");
    // Dismiss autocomplete and send through the actual button, not the menu.
    cx.simulate_keystrokes("escape");
    click("send", cx);
    wait(&surface, cx, |s, cx| {
        s.composer.read(cx).text.is_empty() && !s.composer.read(cx).controls.busy
    });
    let rules: Value = fixture
        .client
        .get(
            "/api/orchestrator/session-rules",
            &[("threadId", "thoughts-composer-first")],
        )
        .unwrap();
    let id = rules["result"]["rules"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        rules["result"]["rules"][0]["text"],
        "Retain the selected thread"
    );
    focus(&surface, cx);
    cx.simulate_input("/rules");
    cx.simulate_keystrokes("enter");
    wait_selector(
        cx,
        Box::leak(format!("composer-rule-remove-{id}").into_boxed_str()),
    );
    click(
        Box::leak(format!("composer-rule-remove-{id}").into_boxed_str()),
        cx,
    );
    click(
        Box::leak(format!("composer-rule-confirm-{id}").into_boxed_str()),
        cx,
    );
    wait(&surface, cx, |s, cx| {
        !s.composer.read(cx).controls.prompt.loading
            && s.composer
                .read(cx)
                .controls
                .prompt
                .rows
                .iter()
                .all(|r| r["id"] != id)
    });
    let rules: Value = fixture
        .client
        .get(
            "/api/orchestrator/session-rules",
            &[("threadId", "thoughts-composer-first")],
        )
        .unwrap();
    assert!(rules["result"]["rules"].as_array().unwrap().is_empty());
}

#[gpui::test]
fn native_composer_controls_save_prompt_and_create_branch_persist_without_send(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    focus(&surface, cx);
    cx.simulate_input("A saved composer prompt");
    draw(cx);
    click("composer-save-prompt", cx);
    click("composer-prompt-submit", cx);
    wait(&surface, cx, |s, cx| {
        !s.composer.read(cx).controls.prompt.result.is_empty()
    });
    let repo = surface.read_with(cx, |s, cx| s.intent_repo(cx).unwrap());
    let prompts: Value = fixture
        .client
        .get(
            "/api/prompt-library",
            &[("scope", "available"), ("repoPath", &repo)],
        )
        .unwrap();
    assert!(
        prompts["prompts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["body"] == "A saved composer prompt" && p["scope"] == "repo")
    );
    click("composer-prompt-close", cx);
    click("composer-intent-branch", cx);
    wait_selector(cx, "composer-branch-new");
    click("composer-branch-new", cx);
    click("composer-prompt-field-0", cx);
    cx.simulate_input("feature/native-created");
    click("composer-prompt-submit", cx);
    wait(&surface, cx, |s, cx| {
        s.composer.read(cx).controls.open.is_none()
    });
    let branches: Value = fixture
        .client
        .get("/api/panel/branches", &[("path", &repo)])
        .unwrap();
    // GET serves a prior snapshot while refreshing. Inspect the persisted Git ref.
    assert!(
        Command::new("git")
            .args([
                "-C",
                &repo,
                "rev-parse",
                "--verify",
                "refs/heads/feature/native-created"
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    );
    assert!(
        branches["branches"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["name"] == "main" && b["current"] == true),
        "creating the advisory branch must not switch checkout"
    );
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.composer.read(cx).text, "A saved composer prompt");
        assert!(s.queue["items"].as_array().unwrap().is_empty());
    });
}
