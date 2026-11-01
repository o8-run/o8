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
