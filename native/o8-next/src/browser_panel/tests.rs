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
    assert_eq!(
        favicon::host("https://www.example.org/a"),
        Some("www.example.org".into())
    );
    assert_eq!(favicon::host("http://localhost:8123"), None);
    assert_eq!(favicon::host("http://192.168.1.9:8123"), None);
    assert_eq!(normalize("  LOCALHOST:8123  "), "https://LOCALHOST:8123");
    assert_eq!(normalize("12.3.4.5/path"), "http://12.3.4.5/path");
    assert_eq!(
        normalize("\u{feff}localhost:8123\u{feff}"),
        "http://localhost:8123"
    );
    assert_eq!(
        normalize("\u{0085}localhost:8123"),
        "https://\u{0085}localhost:8123"
    );

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
    panel.update(cx, |p, cx| {
        let tab = p.tabs.first_mut().unwrap();
        p.pages.get_mut(&tab.id).unwrap().observe_status(
            tab,
            web::Status {
                url: Some("https://example.org/redirected".into()),
                title: Some("Live title".into()),
                back: true,
                forward: false,
                ..Default::default()
            },
        );
        p.follow(cx);
    });
    draw(cx);
    assert_eq!(
        panel.read_with(cx, |p, cx| p.address.read(cx).text.clone()),
        "https://example.org/redirected"
    );
    assert!(panel.read_with(cx, |p, _| p.pages[&1].back && !p.pages[&1].forward));
    click(cx, "browser-address");
    cx.simulate_keystrokes("cmd-a");
    cx.simulate_input("localhost:8123/path");
    panel.update(cx, |p, cx| {
        let tab = p.tabs.first_mut().unwrap();
        p.pages.get_mut(&tab.id).unwrap().observe_status(
            tab,
            web::Status {
                url: Some("https://example.org/moved-while-typing".into()),
                title: Some("Moved".into()),
                back: true,
                forward: true,
                ..Default::default()
            },
        );
        p.follow(cx);
    });
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
    cx.simulate_keystrokes("shift-tab shift-tab");
    draw(cx);
    cx.simulate_keystrokes("space");
    assert!(
        panel.read_with(cx, |p, _| p.copied.is_none()),
        "key down must not also activate the toolbar"
    );
    cx.simulate_event(gpui::KeyUpEvent {
        keystroke: gpui::Keystroke::parse("space").unwrap(),
    });
    draw(cx);
    assert!(
        panel.read_with(cx, |p, _| p.copied.is_some()),
        "Copy URL must be reachable and operable from the keyboard"
    );

    click(cx, "browser-address");
    cx.simulate_keystrokes("cmd-a");
    let long = format!("https://example.org/{}", "segment/".repeat(80));
    cx.simulate_input(&long);
    for _ in 0..4 {
        draw(cx);
    }
    let field = panel.read_with(cx, |p, _| p.address.clone());
    let well = cx.debug_bounds("browser-address").unwrap();
    let (start, end) = cx.update(|window, cx| {
        field.update(cx, |field, cx| {
            let len = field.text.encode_utf16().count();
            (
                gpui::EntityInputHandler::bounds_for_range(field, 0..0, well, window, cx).unwrap(),
                gpui::EntityInputHandler::bounds_for_range(field, len..len, well, window, cx)
                    .unwrap(),
            )
        })
    });
    assert_eq!(start.top(), end.top(), "long URLs stay on one line");
    assert!(
        end.left() >= well.left() && end.left() <= well.right(),
        "horizontal scroll keeps the cursor visible"
    );
    cx.simulate_keystrokes("cmd-a");
    cx.update(|window, cx| {
        field.update(cx, |field, cx| {
            gpui::EntityInputHandler::replace_and_mark_text_in_range(
                field,
                None,
                "日本",
                Some(2..2),
                window,
                cx,
            );
        })
    });
    cx.simulate_keystrokes("enter");
    assert!(panel.read_with(cx, |p, cx| p.address.read(cx).composing()));
    assert_eq!(
        panel.read_with(cx, |p, _| p.current().unwrap().url.clone()),
        "http://localhost:8123/path",
        "IME confirmation must not navigate"
    );
    cx.update(|window, cx| {
        field.update(cx, |field, cx| {
            gpui::EntityInputHandler::unmark_text(field, window, cx)
        })
    });
    cx.simulate_keystrokes("cmd-a");
    cx.simulate_input("localhost:8123/path");
    cx.simulate_keystrokes("shift-enter");
    draw(cx);
    panel.update(cx, |p, cx| {
        let tab = p.tabs.first_mut().unwrap();
        p.pages.get_mut(&tab.id).unwrap().observe_status(
            tab,
            web::Status {
                url: Some("https://example.org/old-document".into()),
                title: Some("Old document".into()),
                error: Some("Could not connect to the server".into()),
                ..Default::default()
            },
        );
        p.follow(cx);
    });
    draw(cx);
    assert_eq!(
        panel.read_with(cx, |p, cx| p.address.read(cx).text.clone()),
        "http://localhost:8123/path"
    );
    assert!(cx.debug_bounds("browser-recover").is_some());
    click(cx, "browser-reload");
    assert_eq!(
        panel.read_with(cx, |p, _| p.pages[&1].pending.borrow().clone()),
        Some("http://localhost:8123/path".into())
    );
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

// The shell portals page pills into its header. A slotless pane's + must not
// travel with them: the shell owns the launcher and More panel views controls.
struct HeaderPages(Entity<BrowserPanel>);
impl Render for HeaderPages {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .w(px(620.))
            .child(self.0.update(cx, |p, cx| p.page_strip(cx)))
    }
}
#[gpui::test]
fn browser_header_omits_slotless_add_and_keeps_classic_density(cx: &mut TestAppContext) {
    let (header, cx) = cx.add_window_view(|_, cx| {
        HeaderPages(cx.new(|cx| {
            let mut p = BrowserPanel::new(cx);
            p.in_header = true;
            for i in 1..=4 {
                p.add(format!("https://example.org/{i}"), cx);
            }
            p
        }))
    });
    draw(cx);
    assert!(
        cx.debug_bounds("browser-add-page").is_none(),
        "slotless + leaked into the shell header"
    );
    let labelled = f32::from(cx.debug_bounds("browser-page-1").unwrap().size.width);
    assert!(
        labelled > 30. && labelled <= 120.,
        "four pages retain host labels"
    );
    let browser = header.read_with(cx, |h, _| h.0.clone());
    browser.update(cx, |p, cx| p.add("https://example.org/five".into(), cx));
    draw(cx);
    assert!(f32::from(cx.debug_bounds("browser-page-1").unwrap().size.width) <= 30.);
    assert!(f32::from(cx.debug_bounds("browser-page-5").unwrap().size.width) > 30.);
    assert_eq!(browser.read_with(cx, |p, _| p.active), Some(5));
}

struct HeaderControls {
    browser: Entity<BrowserPanel>,
    launcher: FocusHandle,
    more: FocusHandle,
    launches: usize,
    menus: usize,
    closed: bool,
}
impl Render for HeaderControls {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .child(header::launcher(|h, _, _| h.launches += 1, cx).track_focus(&self.launcher))
            .child(
                header::more(
                    div()
                        .id("browser-more-test")
                        .debug_selector(|| "browser-more-test".into()),
                    cx,
                )
                .track_focus(&self.more)
                .on_click(cx.listener(|h, _, _, _| h.menus += 1)),
            )
            .child(header::new_page_item(
                self.browser.clone(),
                |h, _| h.closed = true,
                cx,
            ))
    }
}
#[gpui::test]
fn browser_header_controls_open_launcher_and_new_page(cx: &mut TestAppContext) {
    let (header, cx) = cx.add_window_view(|_, cx| HeaderControls {
        browser: cx.new(|cx| {
            let mut p = BrowserPanel::new(cx);
            p.navigate("https://example.com", cx);
            p
        }),
        launcher: cx.focus_handle(),
        more: cx.focus_handle(),
        launches: 0,
        menus: 0,
        closed: false,
    });
    draw(cx);
    assert_eq!(
        f32::from(cx.debug_bounds("browser-open-launcher").unwrap().size.width),
        28.
    );
    assert_eq!(
        f32::from(cx.debug_bounds("browser-more-test").unwrap().size.width),
        28.
    );
    cx.update(|window, cx| header.read(cx).launcher.focus(window));
    draw(cx);
    cx.simulate_keystrokes("enter");
    assert_eq!(header.read_with(cx, |h, _| h.launches), 0);
    cx.simulate_event(gpui::KeyUpEvent {
        keystroke: gpui::Keystroke::parse("enter").unwrap(),
    });
    draw(cx);
    assert_eq!(header.read_with(cx, |h, _| h.launches), 1);
    assert_eq!(
        header.read_with(cx, |h, cx| h.browser.read(cx).tabs.len()),
        1
    );
    cx.update(|window, cx| header.read(cx).more.focus(window));
    draw(cx);
    cx.simulate_keystrokes("space");
    assert_eq!(header.read_with(cx, |h, _| h.menus), 0);
    cx.simulate_event(gpui::KeyUpEvent {
        keystroke: gpui::Keystroke::parse("space").unwrap(),
    });
    draw(cx);
    assert_eq!(header.read_with(cx, |h, _| h.menus), 1);
    click(cx, "browser-menu-new-page");
    assert!(header.read_with(cx, |h, _| h.closed));
    header.read_with(cx, |h, cx| {
        let browser = h.browser.read(cx);
        assert_eq!(browser.tabs.len(), 2);
        assert_eq!(browser.active, Some(2));
        assert!(browser.tabs[1].url.is_empty());
        assert_eq!(browser.tabs[0].url, "https://example.com");
    });
}

#[cfg(target_os = "macos")]
#[gpui::test]
fn browser_first_document_commits_while_navigation_is_loading(_: &mut TestAppContext) {
    // Exercise the actual ObjC navigation delegate without needing a native test window.
    assert_eq!(
        web::commit_flags_for_test(),
        (true, true),
        "committed HTML must be visible before navigation/subresource loading finishes"
    );
}
