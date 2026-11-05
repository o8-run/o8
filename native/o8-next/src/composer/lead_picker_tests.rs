#[gpui::test]
fn native_composer_lead_picker_carries_a_thread_with_history_to_the_new_runtime(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::start(true);
    let before = lead_history(&fixture);
    let (surface, cx) = open(cx, &fixture);
    click("composer-model", cx);
    // Houses sit on the rail as in the desktop picker: Claude above Codex.
    let claude = cx.debug_bounds("lead-house-claude").expect("Claude house");
    let codex = cx.debug_bounds("lead-house-codex").expect("Codex house");
    assert!(claude.top() < codex.top());
    click("lead-house-claude", cx);
    assert!(cx.debug_bounds("model-gpt-6-astra").is_none());
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
    assert_eq!(selected, "thoughts-composer-first");
    let history: Value = fixture
        .client
        .get("/api/v2/chat-history", &[("tabId", selected.as_str())])
        .unwrap();
    assert_eq!(history["backend"], "claude");
    assert_eq!(history["model"], "claude-opus-5-5");
    assert_eq!(history["messages"], before["messages"]);
    assert_eq!(history["title"], before["title"]);
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.composer_routing(cx).unwrap()["backend"], "claude");
    });
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
    surface.update(cx, |s, cx| {
        assert_eq!(
            s.sessions
                .iter()
                .find(|s| s.id == "thoughts-composer-first")
                .unwrap()
                .message_count,
            1
        );
        s.install_rows(vec![], cx);
    });
    click("composer-model", cx);
    assert!(surface.read_with(cx, |s, _| s.rows.is_empty()));
    click("lead-house-claude", cx);
    click("model-claude-opus-5-5", cx);
    surface.read_with(cx, |s, cx| {
        assert!(s.composer.read(cx).controls.error.is_empty());
        assert_eq!(
            s.selected.as_deref(),
            Some("thoughts-composer-first"),
            "saved messages must stay on their thread even without retained rows"
        );
    });
    let after = lead_history(&fixture);
    assert_eq!(after["messages"], original["messages"]);
    assert_eq!(after["backend"], "claude");
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
    click("lead-house-claude", cx);
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
    click("lead-house-claude", cx);
    click("model-claude-opus-5-5", cx);
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.selected.as_deref(), Some("thoughts-composer-first"));
        let routing = s.composer_routing(cx).unwrap();
        assert_eq!(routing["backend"], "claude");
        assert_eq!(routing["model"], "claude-opus-5-5");
    });
    // Classic saves the model on the chat so it survives a reload; nothing
    // else about the saved chat changes.
    let mut after = lead_history(&fixture);
    assert_eq!(after["model"], "claude-opus-5-5");
    let mut expected = before;
    for field in ["model", "savedAt"] {
        after.as_object_mut().unwrap().remove(field);
        expected.as_object_mut().unwrap().remove(field);
    }
    assert_eq!(
        after, expected,
        "a model-only choice changes only the chat's model"
    );
}

#[gpui::test]
fn native_composer_lead_picker_lists_and_binds_provider_instances(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let url = fixture
        .client
        .url("/api/runtime/provider-instances")
        .unwrap();
    let created: Value = fixture
        .client
        .request("POST", &url)
        .send_json(json!({"action": "create", "instance": {"runtime": "codex", "name": "work"}}))
        .unwrap()
        .into_json()
        .unwrap();
    assert_eq!(created["instance"]["id"], "codex-work");
    let (surface, cx) = open(cx, &fixture);
    click("composer-model", cx);
    assert!(
        cx.debug_bounds("lead-house-codex").is_some(),
        "the default instance stays"
    );
    click("lead-house-codex@codex-work", cx);
    click("model-gpt-6-astra", cx);
    let selected = surface.read_with(cx, |s, cx| {
        assert!(s.composer.read(cx).controls.error.is_empty());
        s.selected.clone().unwrap()
    });
    assert!(selected.starts_with("thoughts-next-"), "{selected}");
    let bound: Value = fixture
        .client
        .get(
            "/api/runtime/provider-instances",
            &[("thread", selected.as_str())],
        )
        .unwrap();
    assert_eq!(bound["thread"]["instance"], "codex-work");
    let history: Value = fixture
        .client
        .get("/api/v2/chat-history", &[("tabId", selected.as_str())])
        .unwrap();
    assert_eq!(history["backend"], "codex");
}

#[gpui::test]
fn native_composer_model_picker_keeps_its_size_and_rail_while_the_inventory_lands(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    let set = |surface: &gpui::Entity<Surface>, cx: &mut VisualTestContext, inventory: Value| {
        surface.update(cx, |s, cx| {
            s.composer.update(cx, |i, _| i.controls.inventory = inventory);
            cx.notify();
        });
        draw(cx);
    };
    // The first frame: the runtime inventory has not landed yet.
    set(&surface, cx, json!("loading"));
    click("composer-model", cx);
    set(&surface, cx, json!("loading"));
    let bounds = |cx: &mut VisualTestContext, id: &'static str| {
        cx.debug_bounds(id).unwrap_or_else(|| panic!("{id}"))
    };
    let first = [
        bounds(cx, "composer-picker"),
        bounds(cx, "lead-house-claude"),
        bounds(cx, "lead-house-codex"),
        bounds(cx, "lead-house-o8"),
    ];
    assert!(cx.debug_bounds("lead-house-opencode").is_none());
    // Five more houses are installed.
    let installed = |id: &str| json!({"id": id, "available": true, "installed": true});
    set(
        &surface,
        cx,
        json!([
            installed("claude-code"),
            installed("codex"),
            installed("opencode"),
            installed("pi"),
            installed("muse"),
            installed("hermes"),
            installed("acp"),
        ]),
    );
    assert!(cx.debug_bounds("lead-house-opencode").is_some());
    assert!(cx.debug_bounds("lead-house-pi").is_some());
    let after = [
        bounds(cx, "composer-picker"),
        bounds(cx, "lead-house-claude"),
        bounds(cx, "lead-house-codex"),
        bounds(cx, "lead-house-o8"),
    ];
    assert_eq!(after, first, "the picker and its first houses stay put");
    assert_eq!(
        after[0].size.height,
        gpui::px(super::composer_picker::MODEL_HEIGHT)
    );
    // The new houses join below the ones already drawn.
    assert!(bounds(cx, "lead-house-opencode").top() > after[3].top());
}
