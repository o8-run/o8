use super::*;
use gpui::{TestAppContext, VisualTestContext};

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}
fn click(cx: &mut VisualTestContext, selector: &'static str) {
    draw(cx);
    let bounds = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("missing Browser control {selector}"));
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    draw(cx);
}

#[gpui::test]
fn browser_tabs_open_switch_close_neighbor_and_empty(cx: &mut TestAppContext) {
    let (panel, cx) = cx.add_window_view(|_, cx| BrowserPanel::new(cx));
    click(cx, "browser-new-tab");
    click(cx, "browser-add-page");
    click(cx, "browser-page-1");
    click(cx, "browser-address");
    cx.simulate_input("https://example.org/one");
    cx.simulate_keystrokes("enter");
    draw(cx);
    click(cx, "browser-page-2");
    assert_eq!(
        panel.read_with(cx, |p, cx| p.address.read(cx).text.clone()),
        ""
    );
    let from = cx.debug_bounds("browser-page-2").unwrap().center();
    let to = cx.debug_bounds("browser-page-1").unwrap().origin + gpui::point(px(2.), px(10.));
    cx.simulate_mouse_down(from, gpui::MouseButton::Left, gpui::Modifiers::default());
    cx.simulate_mouse_move(
        from + gpui::point(px(12.), px(0.)),
        Some(gpui::MouseButton::Left),
        gpui::Modifiers::default(),
    );
    draw(cx);
    cx.simulate_mouse_move(
        to,
        Some(gpui::MouseButton::Left),
        gpui::Modifiers::default(),
    );
    cx.simulate_mouse_up(to, gpui::MouseButton::Left, gpui::Modifiers::default());
    draw(cx);
    assert_eq!(
        panel.read_with(cx, |p, _| p.tabs.iter().map(|t| t.id).collect::<Vec<_>>()),
        vec![2, 1]
    );
    assert_eq!(panel.read_with(cx, |p, _| p.active), Some(2));
    click(cx, "browser-close-2");
    assert_eq!(
        panel.read_with(cx, |p, cx| p.address.read(cx).text.clone()),
        "https://example.org/one"
    );
    click(cx, "browser-close-1");
    assert!(cx.debug_bounds("browser-new-tab").is_some());
}

#[gpui::test]
fn browser_navigation_toolbar_enter_blurs_and_preserves_address_draft(cx: &mut TestAppContext) {
    let (panel, cx) = cx.add_window_view(|_, cx| BrowserPanel::new(cx));
    panel.update(cx, |p, cx| p.navigate("https://example.org", cx));
    draw(cx);
    assert_eq!(
        f32::from(cx.debug_bounds("browser-reload").unwrap().size.height),
        22.
    );
    click(cx, "browser-address");
    cx.simulate_keystrokes("cmd-a");
    cx.simulate_input("localhost:8123/path");
    panel.update(cx, |p, cx| p.follow(cx));
    assert_eq!(
        panel.read_with(cx, |p, cx| p.address.read(cx).text.clone()),
        "localhost:8123/path"
    );
    cx.simulate_keystrokes("enter");
    draw(cx);
    assert_eq!(
        panel.read_with(cx, |p, cx| p.address.read(cx).text.clone()),
        "http://localhost:8123/path"
    );
    assert!(cx.update(|window, cx| !panel.read(cx).address_focus.is_focused(window)));
    let controls = [
        "browser-back",
        "browser-forward",
        "browser-reload",
        "browser-address",
        "browser-design",
        "browser-copy",
        "browser-external",
    ];
    let lefts: Vec<_> = controls
        .iter()
        .map(|id| cx.debug_bounds(id).expect(id).left())
        .collect();
    assert!(lefts.windows(2).all(|w| w[0] < w[1]));
}

#[gpui::test]
fn browser_restoration_shell_state_retains_order_active_and_empty(cx: &mut TestAppContext) {
    let mut state = serde_json::to_value(crate::shell_state::State::default()).unwrap();
    state["browser_pages"] = serde_json::json!({"workspace-a": {"tabs": [
        {"id":1,"url":"https://example.org/one","title":"One"},
        {"id":2,"url":"","title":"New Tab"}
    ], "active":2, "updated_at":1}, "workspace-empty":{"tabs":[],"active":null,"updated_at":1}});
    let restored: crate::shell_state::State = serde_json::from_value(state.clone()).unwrap();
    let saved = serde_json::to_value(&restored).unwrap();
    assert_eq!(saved["browser_pages"], state["browser_pages"]);
    let file = std::env::temp_dir().join(format!("o8-browser-restore-{}.json", std::process::id()));
    restored.save(&file).unwrap();
    let disk = crate::shell_state::State::load(&file).unwrap();
    assert_eq!(disk.browser_pages["workspace-a"].active, Some(2));
    let snapshot = disk.browser_pages["workspace-a"].clone();
    let (panel, cx) = cx.add_window_view(|_, cx| {
        let mut panel = BrowserPanel::new(cx);
        panel.restore(snapshot, cx);
        panel
    });
    draw(cx);
    assert_eq!(panel.read_with(cx, |p, _| p.active), Some(2));
    assert_eq!(
        panel.read_with(cx, |p, cx| p.address.read(cx).text.clone()),
        ""
    );
    click(cx, "browser-page-1");
    assert_eq!(
        panel.read_with(cx, |p, cx| p.address.read(cx).text.clone()),
        "https://example.org/one"
    );
    panel.update(cx, |p, cx| {
        p.cover(true);
        p.cover(false);
        assert_eq!(p.active, Some(1));
        p.restore(disk.browser_pages["workspace-empty"].clone(), cx);
        p.set_previews(vec![8123], cx);
        assert!(
            p.tabs.is_empty(),
            "explicitly closed pages must not reseed on restart"
        );
    });
    draw(cx);
    assert!(cx.debug_bounds("browser-new-tab").is_some());
    let sensitive: Snapshot = serde_json::from_value(serde_json::json!({
        "tabs":[{"id":7,"url":"https://example.org/?token=fixture-sensitive","title":"Signed page"}],
        "active":7,"updated_at":1
    })).unwrap();
    let encoded = serde_json::to_string(&sensitive).unwrap();
    assert!(!encoded.contains("fixture-sensitive"));
    assert!(sensitive.tabs[0].redacted);
    panel.update(cx, |p, cx| p.restore(sensitive, cx));
    draw(cx);
    assert_eq!(
        panel.read_with(cx, |p, _| p.current().unwrap().title.clone()),
        "Navigation required"
    );
    std::fs::remove_file(file).unwrap();
}
