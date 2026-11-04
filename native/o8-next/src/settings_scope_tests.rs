//! Scope selector rows and project switches through the production HTTP path.
use crate::settings::{Settings, test_peer::*};
use gpui::TestAppContext;
use serde_json::{Value, json};

const BASE: &str = "/api/panel/operator-defaults?include=native";
fn snapshot(cap: u64, project: &str, layers: Value) -> Value {
    json!({
        "values":{"parallelCap":cap},"sources":{},
        "settingsToml":{"text":"","revision":"fixture-revision","error":null,"additionalSettingsSet":false},
        "scope":{"projectId":project,"keys":["parallelCap"],"layers":layers}
    })
}
fn cap(view: &gpui::Entity<Settings>, cx: &mut gpui::VisualTestContext) -> Value {
    view.read_with(cx, |s, _| {
        s.snapshot.as_ref().unwrap().values["parallelCap"].clone()
    })
}

#[gpui::test]
fn settings_scope_row_edits_the_selected_layer_and_shows_the_override(cx: &mut TestAppContext) {
    let peer = Peer::new();
    let layers = json!({"global":{"parallelCap":3},"project":{"parallelCap":4},"machine":{"parallelCap":5}});
    peer.reply("GET", &format!("{BASE}&project=p1"), 200, snapshot(5, "p1", layers));
    peer.reply("POST", BASE, 200, json!({"ok":true}));
    let project_path = format!("{BASE}&scope=project&project=p1");
    peer.reply("POST", &project_path, 200, json!({"ok":true}));
    let (view, cx) = cx.add_window_view(|window, cx| {
        Settings::with_project(peer.client.clone(), Some("p1".into()), window, cx)
    });
    wait(&view, cx, |s| s.snapshot.is_some());
    click(cx, "settings-nav-dispatch");
    wait(&view, cx, |s| s.snapshot.is_some());
    for scope in ["global", "project", "machine"] {
        let selector: &'static str =
            Box::leak(format!("setting-parallelCap-scope-{scope}").into_boxed_str());
        assert!(cx.debug_bounds(selector).is_some(), "missing {selector}");
    }
    // The machine layer wins, so editing it shows no override.
    assert!(cx.debug_bounds("settings-scope-indicator-parallelCap").is_none());

    click(cx, "setting-parallelCap-scope-global");
    wait(&view, cx, |_| true);
    assert!(
        cx.debug_bounds("settings-scope-indicator-parallelCap").is_some(),
        "editing Global must say a higher layer overrides it"
    );
    click(cx, "setting-parallelCap-preset-8");
    wait(&view, cx, |_| true);
    assert!(peer.calls().iter().any(|(method, path, body)| method == "POST"
        && path == BASE
        && body["parallelCap"] == 8
        && body["settingsTomlRevision"] == "fixture-revision"));

    click(cx, "setting-parallelCap-scope-project");
    wait(&view, cx, |_| true);
    click(cx, "setting-parallelCap-scope-clear");
    wait(&view, cx, |_| true);
    assert!(peer.calls().iter().any(|(method, path, body)| method == "POST"
        && path == &project_path
        && body["parallelCap"].is_null()
        && body.as_object().unwrap().contains_key("parallelCap")));
}

#[gpui::test]
fn settings_scope_project_switch_re_resolves(cx: &mut TestAppContext) {
    let peer = Peer::new();
    peer.reply(
        "GET",
        &format!("{BASE}&project=p1"),
        200,
        snapshot(4, "p1", json!({"global":{"parallelCap":3},"project":{"parallelCap":4}})),
    );
    peer.reply(
        "GET",
        &format!("{BASE}&project=p2"),
        200,
        snapshot(3, "p2", json!({"global":{"parallelCap":3}})),
    );
    let (view, cx) = cx.add_window_view(|window, cx| {
        Settings::with_project(peer.client.clone(), Some("p1".into()), window, cx)
    });
    wait(&view, cx, |s| s.snapshot.is_some());
    assert_eq!(cap(&view, cx), json!(4));
    view.update(cx, |s, cx| s.set_project(Some("p2".into()), cx));
    wait(&view, cx, |s| {
        s.snapshot.as_ref().unwrap().scope.as_ref().unwrap().project_id.as_deref() == Some("p2")
    });
    assert_eq!(cap(&view, cx), json!(3));

    // A switch while a read is in flight reads again for the new project.
    view.update(cx, |s, cx| {
        s.set_project(Some("p1".into()), cx);
        s.set_project(Some("p2".into()), cx);
        s.set_project(Some("p1".into()), cx);
    });
    wait(&view, cx, |s| {
        s.snapshot.as_ref().unwrap().scope.as_ref().unwrap().project_id.as_deref() == Some("p1")
    });
    assert_eq!(cap(&view, cx), json!(4));
    assert!(peer.calls().iter().any(|(_, path, _)| path == &format!("{BASE}&project=p2")));
}
