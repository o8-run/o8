//! Settings › Providers: real clicks -> shell -> GPUI -> production routes -> settings.toml.
use super::*;
use crate::shell::{test_support::*, Shell};
use crate::shell_state::State;
use gpui::{Entity, Modifiers};
use std::time::Duration;

#[test]
fn provider_instance_writes_use_the_settings_timeout_not_the_shared_5s() {
    use super::super::settings_timeout;
    let long = Some(Duration::from_secs(15));
    // The Add tile's first create outlasted 5s on a cold dev server.
    assert_eq!(settings_timeout("POST", instance::INSTANCES), long);
    assert_eq!(settings_timeout("DELETE", instance::INSTANCES), long);
    assert_eq!(settings_timeout("GET", "/api/settings/operator-defaults"), long);
    assert_eq!(settings_timeout("POST", "/api/settings/operator-defaults"), None);
}

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
    // The settings pane scrolls; bring the control into its viewport first.
    for _ in 0..20 {
        let (Some(target), Some(viewport)) = (
            cx.debug_bounds(selector),
            cx.debug_bounds("settings-scroll"),
        ) else {
            break;
        };
        if viewport.contains(&target.center()) {
            break;
        }
        let dy = if target.center().y > viewport.bottom() {
            -200.
        } else {
            200.
        };
        cx.simulate_event(gpui::ScrollWheelEvent {
            position: viewport.center(),
            delta: gpui::ScrollDelta::Pixels(gpui::point(gpui::px(0.), gpui::px(dy))),
            ..Default::default()
        });
        draw_all(cx);
    }
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

fn dialog(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Entity<add::AddProvider> {
    panel(shell, cx).read_with(cx, |p, _| p.add.clone().expect("add dialog open"))
}
fn wait_dialog(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    for _ in 0..200 {
        draw_all(cx);
        if dialog(shell, cx).read_with(cx, |d, _| !d.loading && d.busy.is_none()) {
            draw_all(cx);
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("add dialog must settle");
}
fn saved_connection(fixture: &Fixture) -> Value {
    fixture
        .client
        .get::<Value>("/api/runtime/acp-connection", &[])
        .unwrap()["connection"]
        .clone()
}

#[test]
fn provider_paths_picker_and_registry_helpers() {
    assert_eq!(
        tilde("/home/box/.local/bin/codex", Some("/home/box")),
        "~/.local/bin/codex"
    );
    assert_eq!(tilde("/home/box", Some("/home/box/")), "~");
    assert_eq!(
        tilde("/home/boxer/codex", Some("/home/box")),
        "/home/boxer/codex"
    );
    assert_eq!(tilde("/usr/bin/codex", None), "/usr/bin/codex");
    let defaults = json!({
        "values": {"disabledRuntimes": ["codex"]},
        "dispatchableRuntimes": [{"id": "codex"}, {"id": "claude-code"}]
    });
    let items = picker_inventory(&defaults).unwrap();
    assert_eq!(items[0]["disabled"], true);
    assert!(items[1].get("disabled").is_none());
    assert!(picker_inventory(&json!({})).is_none());
    let agent: add::Agent = serde_json::from_value(json!({
        "id": "amp", "name": "Amp", "description": "ACP wrapper for Amp", "fingerprint": "f"
    }))
    .unwrap();
    assert!(add::matches(&agent, " wrapper "));
    assert!(add::matches(&agent, ""));
    assert!(!add::matches(&agent, "claude"));
    assert_eq!(
        add::connection_body(" Local ", " amp ", "acp\n\n--x"),
        json!({"connection": {"name": "Local", "command": "amp", "args": ["acp", "--x"], "useOpenRouter": false}})
    );
    assert_eq!(
        add::acp_instance_body("Amp", "amp", "acp"),
        json!({"action": "create", "instance": {"runtime": "acp", "name": "Amp",
            "acp": {"name": "Amp", "command": "amp", "args": ["acp"], "useOpenRouter": false}}})
    );
}

#[test]
fn provider_instance_bodies_never_resend_saved_secrets() {
    let rows = vec![
        ("WORK_TOKEN".to_string(), String::new(), true, true),
        ("NEW_TOKEN".to_string(), "v".to_string(), true, false),
        ("REGION".to_string(), "eu".to_string(), false, false),
        ("  ".to_string(), "dropped".to_string(), false, false),
    ];
    assert_eq!(
        instance::env_body(&rows),
        json!([{"name": "WORK_TOKEN", "secret": true},
            {"name": "NEW_TOKEN", "secret": true, "value": "v"},
            {"name": "REGION", "secret": false, "value": "eu"}])
    );
    let codex: instance::Instance = serde_json::from_value(json!({
        "id": "codex-work", "runtime": "codex", "name": "work", "enabled": true,
        "environment": {"connectionId": "instance:codex-work", "revision": 2,
            "variables": [{"name": "WORK_TOKEN", "secret": true, "configured": true}]}
    }))
    .unwrap();
    assert_eq!(instance::label("Codex", &codex), "Codex · work");
    assert_eq!(
        instance::update_body(&codex, " Work ", "/opt/codex", "/tmp/h"),
        json!({"action": "update", "id": "codex-work",
            "instance": {"name": "Work", "binaryPath": "/opt/codex", "homeDir": "/tmp/h", "enabled": true}})
    );
    let acp: instance::Instance = serde_json::from_value(json!({
        "id": "acp-amp", "runtime": "acp", "name": "Amp",
        "acp": {"name": "Amp", "command": "amp", "args": ["acp"], "useOpenRouter": false}
    }))
    .unwrap();
    assert_eq!(instance::binary(&acp), "amp");
    assert_eq!(
        instance::update_body(&acp, "Amp", "/bin/amp2", "")["instance"]["acp"],
        json!({"name": "Amp", "command": "/bin/amp2", "args": ["acp"], "useOpenRouter": false})
    );
}

#[gpui::test]
fn settings_providers_add_dialog_registry_and_manual_acp(cx: &mut TestAppContext) {
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
    click(cx, "provider-add-button");
    wait_dialog(&shell, cx);
    assert!(
        cx.debug_bounds("provider-add-builtin-codex").is_some(),
        "built-in grid"
    );
    assert!(
        cx.debug_bounds("provider-acp-fixture-agent").is_some(),
        "registry entry"
    );
    assert!(cx.debug_bounds("provider-acp-guide-only").is_some());
    assert!(
        cx.debug_bounds("provider-acp-add-guide-only").is_none(),
        "no package, no Add"
    );
    assert!(
        cx.debug_bounds("provider-acp-slot").is_none(),
        "no one-slot notice: adds create instances"
    );
    assert_eq!(saved_connection(&fixture), Value::Null);

    // Search filters by name and description.
    click(cx, "provider-acp-search");
    draw_all(cx);
    cx.simulate_input("guide");
    draw_all(cx);
    assert!(cx.debug_bounds("provider-acp-fixture-agent").is_none());
    assert!(cx.debug_bounds("provider-acp-guide-only").is_some());
    for _ in 0..5 {
        cx.simulate_keystrokes("backspace");
    }
    draw_all(cx);
    assert!(cx.debug_bounds("provider-acp-fixture-agent").is_some());

    click(cx, "provider-acp-add-fixture-agent");
    wait(&shell, cx);
    assert_eq!(
        saved_connection(&fixture),
        Value::Null,
        "a registry add never replaces classic's Local ACP slot"
    );
    let listed = instances(&fixture);
    assert_eq!(listed[0]["runtime"], "acp");
    assert_eq!(
        listed[0]["acp"],
        json!({"name": "Fixture Agent", "command": "fixture-agent", "args": ["--acp"], "useOpenRouter": false})
    );
    assert!(cx
        .debug_bounds("provider-instance-row-acp-fixture-agent")
        .is_some());
    assert!(
        cx.debug_bounds("provider-instance-detail").is_some(),
        "the new instance opens"
    );

    // Configure manually adds a second ACP instance through the same route.
    click(cx, "provider-add-button");
    wait_dialog(&shell, cx);
    click(cx, "provider-acp-manual");
    draw_all(cx);
    assert!(cx.debug_bounds("provider-acp-form").is_some());
    click(cx, "provider-acp-command");
    cx.simulate_input("/bin/my-agent");
    draw_all(cx);
    click(cx, "provider-acp-save");
    wait(&shell, cx);
    let listed = instances(&fixture);
    assert_eq!(listed.as_array().unwrap().len(), 2, "{listed}");
    assert_eq!(listed[1]["acp"]["command"], "/bin/my-agent");
    assert_eq!(listed[1]["acp"]["args"], json!(["acp"]));
    assert_eq!(saved_connection(&fixture), Value::Null);
}

fn instances(fixture: &Fixture) -> Value {
    fixture
        .client
        .get::<Value>("/api/runtime/provider-instances", &[])
        .unwrap()["instances"]
        .clone()
}

#[gpui::test]
fn settings_providers_second_codex_instance_edit_env_and_delete(cx: &mut TestAppContext) {
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
    click(cx, "provider-add-button");
    wait_dialog(&shell, cx);
    click(cx, "provider-add-builtin-codex");
    wait(&shell, cx);
    assert!(cx.debug_bounds("provider-add").is_none());
    assert!(cx.debug_bounds("provider-instance-row-codex-new").is_some());
    assert!(cx.debug_bounds("provider-instance-detail").is_some());
    assert_eq!(instances(&fixture)[0]["runtime"], "codex");
    // The instance sits right under its base runtime, and the detail starts level with it.
    let base = cx.debug_bounds("provider-row-codex").expect("codex row");
    let row = cx.debug_bounds("provider-instance-row-codex-new").unwrap();
    let detail = cx.debug_bounds("provider-instance-detail").unwrap();
    assert!(row.top() > base.top() && row.top() - base.bottom() < gpui::px(20.), "{base:?} {row:?}");
    assert!((detail.top() - row.top()).abs() < gpui::px(4.), "{row:?} {detail:?}");

    click(cx, "provider-instance-name");
    for _ in 0..3 {
        cx.simulate_keystrokes("backspace");
    }
    cx.simulate_input("work");
    click(cx, "provider-instance-home");
    cx.simulate_input("/tmp/codex-work");
    click(cx, "provider-instance-binary");
    cx.simulate_input("/opt/codex-work/codex");
    click(cx, "provider-env-add");
    draw_all(cx);
    click(cx, "provider-env-name-0");
    cx.simulate_input("WORK_TOKEN");
    click(cx, "provider-env-value-0");
    cx.simulate_input("fixture-value");
    click(cx, "provider-env-secret-0");
    let masked = panel(&shell, cx).read_with(cx, |p, cx| {
        p.instance.as_ref().unwrap().read(cx).env[0].value.read(cx).masked
    });
    assert!(masked, "a secret value is masked while typing");
    click(cx, "provider-instance-save");
    for _ in 0..100 {
        draw_all(cx);
        if instances(&fixture)[0]["environment"]["revision"] == 1 {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    wait(&shell, cx);
    let saved = &instances(&fixture)[0];
    assert_eq!(saved["name"], "work", "{saved}");
    assert_eq!(saved["homeDir"], "/tmp/codex-work");
    assert_eq!(saved["binaryPath"], "/opt/codex-work/codex");
    assert_eq!(
        saved["environment"]["variables"],
        json!([{"name": "WORK_TOKEN", "secret": true, "configured": true}])
    );
    assert!(
        !saved.to_string().contains("fixture-value"),
        "secrets never come back"
    );
    let file = fs::read_to_string(
        fixture
            .root
            .join("settings-profile/.o8/provider-instances.json"),
    )
    .or_else(|_| fs::read_to_string(fixture.root.join(".o8/provider-instances.json")))
    .unwrap_or_default();
    assert!(!file.contains("fixture-value"));
    let detail =
        panel(&shell, cx).read_with(cx, |p, _| p.instance.clone().expect("detail stays open"));
    assert!(detail.read_with(cx, |d, _| d.env.len() == 1 && d.env[0].configured));

    click(cx, "provider-instance-delete");
    draw_all(cx);
    assert!(
        cx.debug_bounds("provider-instance-delete-prompt").is_some(),
        "delete asks first"
    );
    assert_eq!(instances(&fixture).as_array().unwrap().len(), 1);
    click(cx, "provider-instance-delete-confirm");
    for _ in 0..100 {
        draw_all(cx);
        if instances(&fixture) == json!([])
            && panel(&shell, cx).read_with(cx, |p, _| p.instance.is_none())
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    wait(&shell, cx);
    let state = panel(&shell, cx).read_with(cx, |p, cx| {
        p.instance.as_ref().map(|d| {
            let d = d.read(cx);
            (d.confirm_delete, d.busy, d.error.clone())
        })
    });
    assert_eq!(instances(&fixture), json!([]), "{state:?}");
    assert!(cx.debug_bounds("provider-instance-row-codex-new").is_none());
    assert!(cx.debug_bounds("provider-instance-detail").is_none());
}

#[test]
fn sign_in_command_reads_detect_hint() {
    use super::sign_in_command;
    assert_eq!(sign_in_command("run: codex login (or set OPENAI_API_KEY)").as_deref(), Some("codex login"));
    assert_eq!(sign_in_command("run: opencode2 auth login").as_deref(), Some("opencode2 auth login"));
    assert_eq!(sign_in_command("Set ANTHROPIC_API_KEY"), None);
}
