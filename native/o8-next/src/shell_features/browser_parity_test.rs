use super::*;
use crate::shell::test_support::*;
use gpui::Modifiers;
struct BrowserParityTests;
register_shell_feature!(BrowserParityTests);
impl ShellFeature for BrowserParityTests {}
fn click(v: &mut VisualTestContext, id: &'static str) {
    draw(v);
    let bounds = v
        .debug_bounds(id)
        .unwrap_or_else(|| panic!("missing Browser parity control {id}"));
    v.simulate_click(bounds.center(), Modifiers::default());
    settle(v);
}
fn settle(v: &mut VisualTestContext) {
    let until = Instant::now() + Duration::from_millis(300);
    while Instant::now() < until {
        v.run_until_parked();
        draw(v);
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[gpui::test]
fn ticket9_browser_pip_follows_closed_panel_and_restores_browser(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (s, mut v) = open(
        f.client.clone(),
        f.root.join("browser-pip.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&s, &mut v);
    v.simulate_resize(size(px(1600.), px(1000.)));
    v.update(|window, cx| {
        s.update(cx, |s, cx| {
            if let Some(id) = s
                .workspace_sessions()
                .first()
                .map(|session| session.id.clone())
            {
                s.execute(Command::Session(id), window, cx);
            }
        })
    });
    settle(&mut v);
    s.update(&mut v, |s, _| {
        let workspace = s.state.selected.clone().expect("fixture workspace");
        s.state.browser_pages.insert(workspace, serde_json::from_value(json!({"tabs":[
            {"id":1,"url":"http://localhost:8123/first","title":"First"},
            {"id":2,"url":"http://localhost:8124/second","title":"Second"}],"active":1,"updated_at":1})).unwrap());
    });
    click(&mut v, "header-right-panel");
    click(&mut v, "panel-tool-browser");
    click(&mut v, "header-right-panel");
    let card = v
        .debug_bounds("browser-pip-card")
        .expect("closing Browser must offer its PiP card");
    assert!(card.size.width <= px(440.));
    click(&mut v, "browser-pip-next");
    let before = s.read_with(&v, |s, _| serde_json::to_value(&s.state).unwrap());
    click(&mut v, "browser-pip-orientation");
    let after = s.read_with(&v, |s, _| serde_json::to_value(&s.state).unwrap());
    assert_ne!(before["browser_pip_wide"], after["browser_pip_wide"]);
    assert_eq!(
        before["browser_pages"], after["browser_pages"],
        "PiP cycling must leave the main active page unchanged"
    );
    click(&mut v, "browser-pip-open");
    assert!(v.debug_bounds("panel-browser-pages").is_some());
    assert!(v.debug_bounds("browser-pip-card").is_none());
}
