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
