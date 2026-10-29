#[gpui::test]
fn native_composer_lead_picker_moves_a_thread_with_history_to_a_fresh_conversation(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    click("composer-model", cx);
    // Runtimes are grouped as in the desktop picker: Claude above Codex.
    let opus = cx
        .debug_bounds("model-claude-opus-5-5")
        .expect("Opus 5.5 row");
    let astra = cx
        .debug_bounds("model-gpt-6-astra")
        .expect("GPT-6 Astra row");
    assert!(opus.top() < astra.top());
    // The fixture thread runs on another runtime and already has a reply, so
    // the lead moves to a fresh conversation instead of rewriting this one.
    click("model-claude-opus-5-5", cx);
    let defaults: Value = fixture
        .client
        .get("/api/panel/operator-defaults", &[("include", "values")])
        .unwrap();
    assert_eq!(defaults["values"]["orchestratorBackend"], "claude");
    assert_eq!(defaults["values"]["orchestratorModel"], "claude-opus-5-5");
    let selected = surface.read_with(cx, |s, cx| {
        assert!(s.composer.read(cx).controls.open.is_none());
        s.selected.clone().unwrap()
    });
    assert!(selected.starts_with("thoughts-next-"), "{selected}");
    let history: Value = fixture
        .client
        .get("/api/v2/chat-history", &[("tabId", selected.as_str())])
        .unwrap();
    assert_eq!(history["backend"], "claude");
    assert_eq!(history["model"], "claude-opus-5-5");
    let original: Value = fixture
        .client
        .get(
            "/api/v2/chat-history",
            &[("tabId", "thoughts-composer-first")],
        )
        .unwrap();
    assert_ne!(original["backend"], "claude");
}

fn lead_history(fixture: &Fixture) -> Value {
    fixture
        .client
        .get(
            "/api/v2/chat-history",
            &[("tabId", "thoughts-composer-first")],
        )
        .unwrap()
}

fn save_lead_history(fixture: &Fixture, history: Value) {
    let url = fixture.client.url("/api/v2/chat-history").unwrap();
    fixture
        .client
        .request("POST", &url)
        .send_json(history)
        .unwrap();
}

#[gpui::test]
fn native_composer_lead_picker_uses_saved_history_without_retained_rows(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let original = lead_history(&fixture);
    assert_eq!(original["messages"].as_array().unwrap().len(), 1);
    let (surface, cx) = open(cx, &fixture);
    // Retained presentation is not the source of truth for saved history.
    // Exercise the choice with no retained rows, without waiting for more paint.
    surface.update(cx, |s, _| {
        assert_eq!(
            s.sessions
                .iter()
                .find(|s| s.id == "thoughts-composer-first")
                .unwrap()
                .message_count,
            1
        );
        s.install_rows(vec![]);
    });
    click("composer-model", cx);
    assert!(surface.read_with(cx, |s, _| s.rows.is_empty()));
    click("model-claude-opus-5-5", cx);
    surface.read_with(cx, |s, cx| {
        assert!(s.composer.read(cx).controls.error.is_empty());
        assert!(
            s.selected.as_ref().unwrap().starts_with("thoughts-next-"),
            "saved messages must start a fresh conversation even without retained rows"
        );
    });
    let after = lead_history(&fixture);
    assert_eq!(after["messages"], original["messages"]);
    assert_eq!(after["backend"], original["backend"]);
}

#[gpui::test]
fn native_composer_lead_picker_switches_an_empty_thread_in_place(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let mut empty = lead_history(&fixture);
    empty["tabId"] = json!("thoughts-composer-first");
    empty["messages"] = json!([]);
    empty["replace"] = json!(true);
    save_lead_history(&fixture, empty);
    let before = fixture.client.sessions().unwrap();
    let (surface, cx) = open(cx, &fixture);
    surface.read_with(cx, |s, _| {
        assert!(s.rows.is_empty());
        assert_eq!(
            s.sessions
                .iter()
                .find(|s| s.id == "thoughts-composer-first")
                .unwrap()
                .message_count,
            0
        );
    });
    click("composer-model", cx);
    click("model-claude-opus-5-5", cx);
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.selected.as_deref(), Some("thoughts-composer-first"));
        assert!(s.composer.read(cx).controls.error.is_empty());
        assert_eq!(s.composer_routing(cx).unwrap()["backend"], "claude");
    });
    let after = lead_history(&fixture);
    assert_eq!(after["backend"], "claude");
    assert_eq!(after["model"], "claude-opus-5-5");
    assert!(after["messages"].as_array().unwrap().is_empty());
    let mut ids_before: Vec<_> = before.into_iter().map(|s| s.id).collect();
    let mut ids_after: Vec<_> = fixture
        .client
        .sessions()
        .unwrap()
        .into_iter()
        .map(|s| s.id)
        .collect();
    ids_before.sort();
    ids_after.sort();
    assert_eq!(
        ids_after, ids_before,
        "an empty thread must keep its identity"
    );
}

#[gpui::test]
fn native_composer_lead_picker_same_runtime_only_changes_the_model(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let mut history = lead_history(&fixture);
    history["tabId"] = json!("thoughts-composer-first");
    history["backend"] = json!("claude");
    history["model"] = json!("claude-opus-5");
    save_lead_history(&fixture, history);
    let before = lead_history(&fixture);
    let (surface, cx) = open(cx, &fixture);
    click("composer-model", cx);
    click("model-claude-opus-5-5", cx);
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.selected.as_deref(), Some("thoughts-composer-first"));
        let routing = s.composer_routing(cx).unwrap();
        assert_eq!(routing["backend"], "claude");
        assert_eq!(routing["model"], "claude-opus-5-5");
    });
    assert_eq!(
        lead_history(&fixture),
        before,
        "a model-only choice must not rewrite saved history"
    );
}
