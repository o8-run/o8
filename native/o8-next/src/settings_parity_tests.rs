//! Settings parity receipts use the real shell, controls and persisted defaults.
use super::*;

#[gpui::test]
fn settings_parity_general_groups_and_global_search(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, _) = start(cx);
    let cx = &mut visual;
    for selector in [
        "settings-group-Conversations",
        "settings-group-Presentation",
        "settings-group-Privacy",
    ] {
        assert!(cx.debug_bounds(selector).is_some(), "missing {selector}");
    }
    search(cx, "privacy usage");
    let previous = values(&fixture)["productTelemetryEnabled"] == true;
    click(cx, "setting-productTelemetryEnabled");
    frame(&shell, cx);
    assert_eq!(values(&fixture)["productTelemetryEnabled"], !previous);
    assert!(
        cx.debug_bounds("setting-autoTitleInferenceEnabled")
            .is_none()
    );
    click(cx, "settings-search-clear");
    frame(&shell, cx);
    assert!(
        cx.debug_bounds("setting-autoTitleInferenceEnabled")
            .is_some()
    );
    search(cx, "branch prefix");
    assert!(
        cx.debug_bounds("edit-branchPrefix").is_some(),
        "search spans tabs"
    );
    cx.simulate_keystrokes("escape");
    frame(&shell, cx);
    assert!(
        cx.debug_bounds("settings-page").is_some(),
        "Escape clears search first"
    );
    assert!(
        cx.debug_bounds("setting-autoTitleInferenceEnabled")
            .is_some()
    );
}

#[gpui::test]
fn settings_parity_appearance_drives_the_running_shell(cx: &mut TestAppContext) {
    let (_fixture, shell, mut visual, _) = start(cx);
    let previous = crate::theme::appearance_name();
    click(&mut visual, "settings-nav-appearance");
    frame(&shell, &mut visual);
    for mode in ["light", "dark", "glass", previous] {
        click(&mut visual, &format!("setting-appearance-{mode}"));
        frame(&shell, &mut visual);
        assert_eq!(crate::theme::appearance_name(), mode);
        assert!(visual.debug_bounds("settings-page").is_some());
    }
}

#[gpui::test]
fn settings_parity_model_defaults_persist(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, _) = start(cx);
    let cx = &mut visual;
    for (field, index, expected) in [
        ("codexWorkerEffort", 3, json!("high")),
        ("claudeWorkerEffort", 3, json!("high")),
        ("reviewerBackend", 2, json!("codex")),
        ("collideAggregator", 1, json!("claude")),
    ] {
        search(cx, field);
        click(cx, &format!("setting-{field}-{index}"));
        frame(&shell, cx);
        assert_eq!(error(&shell, cx), None, "{field}");
        assert_eq!(values(&fixture)[field], expected, "{field}");
    }
    for field in [
        "crossHouseWorkerFallback",
        "experimentalOpencode",
        "inAppOrchestratorEnabled",
    ] {
        search(cx, field);
        let before = values(&fixture)[field] == true;
        click(cx, &format!("setting-{field}"));
        frame(&shell, cx);
        assert_eq!(error(&shell, cx), None, "{field}");
        assert_eq!(values(&fixture)[field], !before);
    }
    search(cx, "orchestratorModel");
    click(cx, "setting-orchestratorModel-7");
    frame(&shell, cx);
    assert_eq!(error(&shell, cx), None);
    assert_eq!(values(&fixture)["orchestratorModel"], "claude-sonnet-5");
    for (field, text) in [
        ("localChatModel", "qwen2.5-coder:7b"),
        ("localEmbedModel", "nomic-embed-text"),
    ] {
        edit(cx, field, text);
        click(cx, "settings-save");
        frame(&shell, cx);
        assert_eq!(error(&shell, cx), None);
        assert_eq!(values(&fixture)[field], text);
    }
    for field in ["targetingTriage", "targetingAction"] {
        let before = values(&fixture)[field].clone();
        search(cx, field);
        click(cx, &format!("setting-{field}-effort-3"));
        frame(&shell, cx);
        assert_eq!(error(&shell, cx), None);
        let saved = values(&fixture)[field].clone();
        assert_eq!(saved["effort"], "high");
        assert_eq!(saved["runtime"], before["runtime"]);
        assert_eq!(saved["model"], before["model"]);
    }
    search(cx, "subscriptionProfile");
    click(cx, "setting-subscriptionProfile-2");
    frame(&shell, cx);
    assert_eq!(values(&fixture)["subscriptionProfile"], "codex-only");
    search(cx, "reviewerBackend");
    let pinned = values(&fixture)["reviewerBackend"].clone();
    click(cx, "setting-reviewerBackend-1");
    frame(&shell, cx);
    assert_eq!(
        values(&fixture)["reviewerBackend"],
        pinned,
        "single-provider profiles pin the reviewer"
    );
}
