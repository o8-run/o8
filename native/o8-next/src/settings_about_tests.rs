use super::*;
use crate::settings::test_peer::*;
use gpui::TestAppContext;

#[gpui::test]
fn settings_parity_about_links_version_and_verified_update_check(cx: &mut TestAppContext) {
    let peer = Peer::new();
    peer.reply(
        "POST",
        "/api/panel/update/apply",
        200,
        json!({"ok":true,"state":{"check":{"outcome":"current"},"updatePending":false}}),
    );
    let (view, cx) = open(&peer, cx);
    wait(&view, cx, |_| true);
    click(cx, "settings-nav-about");
    wait(&view, cx, |s| !s.about_busy && s.about_version.is_some());
    assert_eq!(
        view.read_with(cx, |s, _| s.about_version.clone()),
        Some("1.2.3".into())
    );
    for (selector, url) in [
        ("setting-about-github", "https://github.com/o8-run/o8"),
        (
            "setting-about-docs",
            "https://github.com/o8-run/o8/tree/main/docs",
        ),
        (
            "setting-about-releases",
            "https://github.com/o8-run/o8/releases/latest",
        ),
    ] {
        click(cx, selector);
        assert_eq!(cx.cx.opened_url(), Some(url.into()));
    }
    click(cx, "setting-about-check-updates");
    wait(&view, cx, |s| !s.about_busy);
    assert_eq!(
        view.read_with(cx, |s, _| s.about_status.clone()),
        "o8 is up to date."
    );
    let checks: Vec<_> = peer
        .calls()
        .into_iter()
        .filter(|(method, path, _)| method == "POST" && path == "/api/panel/update/apply")
        .collect();
    assert_eq!(checks.len(), 1);
    assert_eq!(
        checks[0].2,
        json!({"checkOnly":true}),
        "checking must never install"
    );
    peer.reply("POST", "/api/panel/update/apply", 200, json!({"ok":true,"state":{"check":{"outcome":"available"},"updatePending":true,"version":"1.2.4"}}));
    click(cx, "setting-about-check-updates");
    wait(&view, cx, |s| !s.about_busy);
    assert_eq!(
        view.read_with(cx, |s, _| s.about_status.clone()),
        "Update 1.2.4 is ready.",
        "error={:?}; calls={:?}",
        view.read_with(cx, |s, _| s.about_error.clone()),
        peer.calls()
    );
    peer.reply(
        "POST",
        "/api/panel/update/apply",
        200,
        json!({"ok":true,"state":{"check":{"outcome":"never"},"updatePending":false}}),
    );
    click(cx, "setting-about-check-updates");
    wait(&view, cx, |s| !s.about_busy);
    assert!(view.read_with(cx, |s, _| {
        s.about_error
            .as_ref()
            .is_some_and(|e| e.contains("verified"))
    }));
    peer.reply("POST", "/api/panel/update/apply", 503, json!({}));
    click(cx, "setting-about-check-updates");
    wait(&view, cx, |s| !s.about_busy);
    assert!(view.read_with(cx, |s, _| s.about_error.is_some()));
    peer.reply(
        "POST",
        "/api/panel/update/apply",
        200,
        json!({"ok":true,"state":{"check":{"outcome":"current"},"updatePending":false}}),
    );
    click(cx, "setting-about-check-updates");
    wait(&view, cx, |s| !s.about_busy);
    assert!(
        view.read_with(cx, |s, _| s.about_error.is_none()),
        "status={:?}, error={:?}, calls={:?}",
        view.read_with(cx, |s, _| s.about_status.clone()),
        view.read_with(cx, |s, _| s.about_error.clone()),
        peer.calls()
    );
}
