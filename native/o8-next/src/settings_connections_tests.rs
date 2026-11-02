use super::*;
use crate::settings::test_peer::*;
use gpui::TestAppContext;

#[gpui::test]
fn settings_parity_connections_read_only_capabilities_and_recovery(cx: &mut TestAppContext) {
    let peer = Peer::new();
    peer.reply("GET", "/api/panel/operator-defaults?include=native", 200, json!({
        "values":{"autoTitleInferenceEnabled":true,"defaultDispatchRuntime":"codex","workerRuntimes":["codex","claude-code"]},"sources":{},
        "settingsToml":{"text":"","revision":"fixture-revision","error":null,"additionalSettingsSet":false}
    }));
    peer.reply("GET", "/api/runtime/capabilities?id=codex", 200, json!({"id":"codex","capabilities":{"resume":true,"interrupt":true,"streaming":true,"reviewDiffs":false,"costTelemetry":true,"sessionTransforms":{"fork":true},"capacity":{"observe":true}}}));
    peer.reply(
        "GET",
        "/api/runtime/capabilities?id=claude-code",
        200,
        json!({"id":"claude-code","capabilities":null}),
    );
    let (view, cx) = open(&peer, cx);
    wait(&view, cx, |_| true);
    click(cx, "settings-nav-connections");
    wait(&view, cx, |s| {
        !s.connections.busy && s.connections.reply.is_some()
    });
    assert_eq!(
        view.read_with(cx, |s, _| s.connections.reply.as_ref().unwrap().id.clone()),
        "codex"
    );
    assert!(cx.debug_bounds("settings-capability-actions").is_some());
    click(cx, "setting-connection-claude-code");
    wait(&view, cx, |s| !s.connections.busy);
    assert!(view.read_with(cx, |s, _| {
        s.connections.reply.as_ref().unwrap().capabilities.is_none()
    }));
    peer.reply(
        "GET",
        "/api/runtime/capabilities?id=claude-code",
        503,
        json!({}),
    );
    click(cx, "setting-connections-refresh");
    wait(&view, cx, |s| !s.connections.busy);
    assert!(view.read_with(cx, |s, _| s.connections.error.is_some()));
    peer.reply("GET", "/api/runtime/capabilities?id=claude-code", 200, json!({"id":"claude-code","capabilities":{"resume":true,"interrupt":false,"streaming":true,"reviewDiffs":true,"costTelemetry":false}}));
    click(cx, "setting-connections-refresh");
    wait(&view, cx, |s| !s.connections.busy);
    assert!(view.read_with(cx, |s, _| s.connections.error.is_none()));
    click(cx, "settings-search");
    cx.simulate_input("Default worker");
    wait(&view, cx, |_| true);
    assert!(
        cx.debug_bounds("settings-row-defaultDispatchRuntime")
            .is_some()
    );
    assert!(cx.debug_bounds("edit-defaultDispatchRuntime").is_none());
    assert!(
        peer.calls().iter().all(|(method, path, _)| method == "GET"
            && (path == "/api/panel/operator-defaults?include=native"
                || path.starts_with("/api/runtime/capabilities?id="))),
        "capability inspection must not read account or key inventories: {:?}",
        peer.calls()
    );
    click(cx, "settings-search");
    cx.simulate_keystrokes("ctrl-a backspace");
    cx.simulate_input("version");
    wait(&view, cx, |_| true);
    assert!(
        !peer
            .calls()
            .iter()
            .any(|(_, path, _)| path == "/api/setup/identity"),
        "search is static until a result is opened"
    );
    click(cx, "settings-result-about");
    wait(&view, cx, |s| !s.about_busy && s.about_version.is_some());
    assert!(
        peer.calls()
            .iter()
            .any(|(_, path, _)| path == "/api/setup/identity")
    );
}
