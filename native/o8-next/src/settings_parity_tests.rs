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

#[gpui::test]
fn settings_parity_spoken_notifications_persist_and_gate_controls(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, _) = start(cx);
    let cx = &mut visual;
    search(cx, "broadcastVoiceAttention");
    let before = values(&fixture)["broadcastVoiceAttention"].clone();
    click(cx, "setting-broadcastVoiceAttention");
    frame(&shell, cx);
    assert_eq!(
        values(&fixture)["broadcastVoiceAttention"],
        before,
        "voice is off"
    );
    search(cx, "broadcastVoice");
    click(cx, "setting-broadcastVoice");
    frame(&shell, cx);
    assert_eq!(values(&fixture)["broadcastVoice"], "on");
    for field in [
        "broadcastVoiceAttention",
        "broadcastVoiceApprovals",
        "broadcastVoiceReviews",
        "broadcastVoiceFailures",
        "broadcastVoiceCompletions",
        "broadcastVoiceCalendar",
        "broadcastVoiceTimeCheckins",
    ] {
        search(cx, field);
        let before = values(&fixture)[field] == true;
        click(cx, &format!("setting-{field}"));
        frame(&shell, cx);
        assert_eq!(error(&shell, cx), None, "{field}");
        assert_eq!(values(&fixture)[field], !before);
    }
    search(cx, "broadcastVoiceCalendarLeadMinutes");
    click(cx, "edit-broadcastVoiceCalendarLeadMinutes");
    assert!(
        cx.debug_bounds("settings-editor").is_none(),
        "calendar alerts are off"
    );
    search(cx, "broadcastCommentary");
    click(cx, "setting-broadcastCommentary");
    frame(&shell, cx);
    assert_eq!(values(&fixture)["broadcastCommentary"], "interval");
    edit(cx, "broadcastCommentaryMaxPerHour", "7");
    click(cx, "settings-save");
    frame(&shell, cx);
    assert_eq!(values(&fixture)["broadcastCommentaryMaxPerHour"], 7);
    edit(cx, "broadcastVoiceQuietStart", "21:30");
    click(cx, "settings-save");
    frame(&shell, cx);
    assert_eq!(error(&shell, cx), None);
    assert_eq!(values(&fixture)["broadcastVoiceQuietStart"], "21:30");
    edit(cx, "broadcastVoiceQuietEnd", "28:90");
    click(cx, "settings-save");
    frame(&shell, cx);
    assert!(
        error(&shell, cx).is_some(),
        "invalid clock times are refused"
    );
    assert_eq!(values(&fixture)["broadcastVoiceQuietEnd"], "08:00");
}

#[gpui::test]
fn settings_parity_keyboard_opens_help_and_returns_to_settings(cx: &mut TestAppContext) {
    let (_fixture, shell, mut visual, _) = start(cx);
    click(&mut visual, "settings-nav-keyboard");
    frame(&shell, &mut visual);
    click(&mut visual, "setting-keyboard-open");
    settle(&mut visual);
    assert!(visual.debug_bounds("keyboard-shortcuts").is_some());
    click(&mut visual, "shortcuts-close");
    settle(&mut visual);
    assert!(visual.debug_bounds("settings-page").is_some());
    assert!(visual.debug_bounds("setting-keyboard-open").is_some());
    visual.simulate_keystrokes("enter");
    settle(&mut visual);
    assert!(
        visual.debug_bounds("keyboard-shortcuts").is_some(),
        "help restores focus to its Settings control"
    );
}

#[gpui::test]
fn settings_parity_actions_follow_shell_settings_lifecycle(cx: &mut TestAppContext) {
    let (_fixture, shell, mut visual, _) = start(cx);
    visual.simulate_keystrokes("ctrl-shift-p");
    visual.simulate_keystrokes("p r o j e c t s enter");
    settle(&mut visual);
    assert!(
        shell.read_with(&mut visual, |s, _| s.surfaces.settings.view.is_none()
            && s.surfaces.settings.subscription.is_none())
    );
    assert!(shell.read_with(&mut visual, |s, _| s.surfaces.projects.open));
}

#[gpui::test]
fn settings_parity_classic_fleet_presets_persist_and_recover(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, _) = start(cx);
    let input = &mut visual;
    search(input, "parallelCap");
    for cap in [2, 5, 8] {
        click(input, &format!("setting-parallelCap-preset-{cap}"));
        frame(&shell, input);
        assert_eq!(error(&shell, input), None);
        assert_eq!(values(&fixture)["parallelCap"], cap);
    }
    request(
        &fixture,
        "POST",
        "/__fixture/settings",
        json!({"nextStatus":503}),
    );
    click(input, "setting-parallelCap-preset-2");
    frame(&shell, input);
    assert!(error(&shell, input).is_some());
    assert_eq!(values(&fixture)["parallelCap"], 8);
    click(input, "settings-refresh");
    frame(&shell, input);
    click(input, "setting-parallelCap-preset-5");
    frame(&shell, input);
    assert_eq!(error(&shell, input), None);
    assert_eq!(values(&fixture)["parallelCap"], 5);
}

#[gpui::test]
fn settings_parity_classic_brain_model_presets_persist(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, _) = start(cx);
    let cx = &mut visual;
    search(cx, "brainCodexModel");
    for (index, model) in [
        "gpt-6-astra",
        "gpt-6.1-sol",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-terra",
        "gpt-5.6-sol",
        "gpt-5.6-luna",
        "gpt-5.5",
    ]
    .into_iter()
    .enumerate()
    {
        click(cx, &format!("setting-brainCodexModel-preset-{index}"));
        frame(&shell, cx);
        assert_eq!(error(&shell, cx), None);
        assert_eq!(values(&fixture)["brainCodexModel"], model);
    }
    assert!(
        cx.debug_bounds("edit-brainCodexModel").is_some(),
        "saved custom model values remain editable"
    );
}
