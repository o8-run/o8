use super::*;
use crate::settings::test_peer::*;
use gpui::TestAppContext;

#[gpui::test]
fn settings_parity_diagnostics_feature_audit_refresh_and_error(cx: &mut TestAppContext) {
    let peer = Peer::new();
    peer.reply("GET", "/api/panel/status", 200, json!({"shippedDarkAudit":{"status":"unverified","checkedAt":"1970-01-01T00:00:00Z","currentRelease":null,"thresholdReleases":3,"checkedFlagCount":0,"attentionFlagCount":0,"flags":[]}}));
    let (view, cx) = open(&peer, cx);
    wait(&view, cx, |_| true);
    click(cx, "settings-nav-diagnostics");
    wait(&view, cx, |s| {
        !s.diagnostics.busy && s.diagnostics.audit.is_some()
    });
    assert_eq!(
        view.read_with(cx, |s, _| s
            .diagnostics
            .audit
            .as_ref()
            .unwrap()
            .status
            .clone()),
        "unverified"
    );
    peer.reply("GET", "/api/panel/status", 200, json!({"shippedDarkAudit":{"status":"attention","checkedAt":"2026-10-31T12:00:00Z","currentRelease":"1.2.3","thresholdReleases":3,"checkedFlagCount":1,"attentionFlagCount":1,"flags":[{"tomlKey":"experimental_next","operatorValueSource":"file","landedRelease":"1.2.0","darkForReleases":5,"lifecycle":"promotion-candidate","lifecycleRationale":null,"needsAttention":true}]}}));
    click(cx, "setting-diagnostics-refresh");
    wait(&view, cx, |s| !s.diagnostics.busy);
    assert_eq!(
        view.read_with(cx, |s, _| s
            .diagnostics
            .audit
            .as_ref()
            .unwrap()
            .status
            .clone()),
        "attention"
    );
    assert!(
        cx.debug_bounds("settings-audit-flag-experimental_next")
            .is_some()
    );
    peer.reply("GET", "/api/panel/status", 503, json!({}));
    click(cx, "setting-diagnostics-refresh");
    wait(&view, cx, |s| !s.diagnostics.busy);
    assert!(view.read_with(cx, |s, _| s.diagnostics.error.is_some()
        && s.diagnostics.audit.is_none()));
    assert!(peer.calls().iter().all(|(method, _, _)| method == "GET"));
}
