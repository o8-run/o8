//! Settings › Providers: real clicks -> shell -> GPUI -> production routes -> settings.toml.
use super::*;
use crate::shell::{Shell, test_support::*};
use crate::shell_state::State;
use gpui::{Entity, Modifiers};
use std::time::Duration;

#[test]
fn provider_version_status_and_home_are_display_only() {
    assert_eq!(version("codex-cli 0.162.1").as_deref(), Some("v0.162.1"));
    assert_eq!(
        version("2.1.300 (Claude Code)").as_deref(),
        Some("v2.1.300")
    );
    assert_eq!(version("v1.0.52").as_deref(), Some("v1.0.52"));
    assert_eq!(version("unknown"), None);
    let runtime = |available, installed, reason: Option<&str>, providers: &[&str]| Runtime {
        id: "codex".into(),
        label: "Codex".into(),
        installed,
        available,
        unavailable_reason: reason.map(Into::into),
        connection: Some(RuntimeConnection {
            providers: providers.iter().map(|p| (*p).into()).collect(),
        }),
    };
    assert_eq!(
        status(&runtime(true, true, None, &["chatgpt"]), false),
        "Authenticated · chatgpt"
    );
    assert_eq!(status(&runtime(true, true, None, &[]), false), "Available");
    assert_eq!(status(&runtime(true, true, None, &[]), true), "Disabled");
    assert_eq!(
        status(&runtime(false, false, Some("not_installed"), &[]), false),
        "Not installed"
    );
    assert_eq!(
        status(&runtime(false, true, Some("needs_auth"), &[]), false),
        "Installed · sign-in needed"
    );
    // Home paths are selectors with a tilde default, never a resolved home.
    for id in [
        "codex",
        "claude-code",
        "gemini",
        "opencode",
        "cursor",
        "grok",
        "acp",
    ] {
        assert!(!home(id).contains("/home/") && !home(id).contains("/Users/"));
    }
}

fn draw_all(cx: &mut VisualTestContext) {
    for _ in 0..8 {
        cx.run_until_parked();
        draw(cx);
    }
}
fn click(cx: &mut VisualTestContext, selector: &'static str) {
    draw_all(cx);
    let bounds = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("missing native control: {selector}"));
    cx.simulate_click(bounds.center(), Modifiers::default());
}
fn panel(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Entity<Providers> {
    shell.read_with(cx, |s, cx| {
        s.surfaces
            .settings
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .providers
            .clone()
            .unwrap()
            .downcast::<Providers>()
            .unwrap()
    })
}
fn wait(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    for _ in 0..200 {
        draw_all(cx);
        let providers = panel(shell, cx);
        if providers.read_with(cx, |p, _| {
            p.loaded && !p.busy && p.painted.get() == p.revision_count
        }) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("providers response must reach paint");
}
fn disabled(fixture: &Fixture) -> Value {
    fixture
        .client
        .get::<Value>("/api/panel/operator-defaults", &[("include", "native")])
        .unwrap()["values"]["disabledRuntimes"]
        .clone()
}

#[gpui::test]
fn settings_providers_list_switch_persists_detail_and_add_stub(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("settings.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("s e t t i n g s");
    cx.simulate_keystrokes("enter");
    draw_all(cx);
    click(cx, "settings-nav-providers");
    wait(&shell, cx);
    assert!(cx.debug_bounds("settings-providers").is_some());
    assert!(
        cx.debug_bounds("provider-add-button").is_some(),
        "the + stub is visible"
    );
    let ids: Vec<String> =
        panel(&shell, cx).read_with(cx, |p, _| p.runtimes.iter().map(|r| r.id.clone()).collect());
    for id in ["codex", "claude-code"] {
        assert!(
            ids.iter().any(|i| i == id),
            "{id} must be listed from dispatchableRuntimes: {ids:?}"
        );
    }
    assert!(cx.debug_bounds("provider-row-codex").is_some());
    assert!(cx.debug_bounds("provider-switch-codex").is_some());
    // The fixture has no installed CLIs, so detection never runs a tool.
    assert_eq!(disabled(&fixture), json!([]));

    let before = cx.debug_bounds("provider-switch-codex").unwrap();
    click(cx, "provider-switch-codex");
    wait(&shell, cx);
    assert_eq!(
        disabled(&fixture),
        json!(["codex"]),
        "switch persists through disabledRuntimes"
    );
    assert_eq!(
        panel(&shell, cx).read_with(cx, |p, _| p.disabled.clone()),
        vec!["codex".to_string()]
    );
    assert_eq!(
        cx.debug_bounds("provider-switch-codex").unwrap(),
        before,
        "a save never moves the switch"
    );
    assert!(
        cx.debug_bounds("provider-detail").is_none(),
        "the switch click does not open the row"
    );
    let toml = fs::read_to_string(fixture.root.join("settings-profile/.o8/settings.toml")).ok();
    if let Some(toml) = toml {
        assert!(toml.contains("disabled_runtimes"), "{toml}");
    }

    click(cx, "provider-row-codex");
    draw_all(cx);
    assert!(
        cx.debug_bounds("provider-detail").is_some(),
        "row opens the read-only detail panel"
    );
    click(cx, "provider-switch-codex");
    wait(&shell, cx);
    assert_eq!(disabled(&fixture), json!([]));

    click(cx, "provider-add-button");
    draw_all(cx);
    assert!(cx.debug_bounds("provider-add").is_some());
    assert!(cx.debug_bounds("provider-detail").is_none());
    click(cx, "provider-add-close");
    draw_all(cx);
    assert!(cx.debug_bounds("provider-add").is_none());
}
