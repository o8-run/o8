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

#[gpui::test]
fn ticket9_browser_keys_and_dev_server_tiles(cx: &mut TestAppContext) {
    let (panel, cx) = cx.add_window_view(|_, cx| BrowserPanel::new(cx));
    panel.update(cx, |p, cx| p.set_previews(vec![8123, 8124], cx));
    assert_eq!(panel.read_with(cx, |p, _| p.tabs.len()), 2);
    assert_eq!(
        panel.read_with(cx, |p, _| p.current().unwrap().url.clone()),
        "http://localhost:8123"
    );
    click(cx, "browser-add-page");
    draw(cx);
    click(cx, "browser-port-8124");
    cx.update(|window, cx| panel.read(cx).focus.focus(window));
    cx.simulate_keystrokes("cmd-l");
    draw(cx);
    assert!(
        cx.update(|window, cx| panel.read(cx).address_focus.is_focused(window)),
        "Browser Cmd+L must focus the address"
    );
    cx.simulate_input("localhost:8123/draft");
    panel.update(cx, |p, cx| p.follow(cx));
    assert_eq!(
        panel.read_with(cx, |p, cx| p.address.read(cx).text.clone()),
        "localhost:8123/draft"
    );
    cx.simulate_keystrokes("enter");
    draw(cx);
    assert_eq!(
        panel.read_with(cx, |p, _| p.current().unwrap().url.clone()),
        "http://localhost:8123/draft"
    );
    cx.simulate_keystrokes("shift-f10");
    draw(cx);
    assert!(
        cx.debug_bounds("browser-menu-reload").is_some(),
        "Browser menu must expose Reload"
    );
    click(cx, "browser-menu-focus");
    assert!(cx.update(|window, cx| panel.read(cx).address_focus.is_focused(window)));
}

#[gpui::test]
fn ticket9_browser_error_banner_keeps_recovery_and_no_pages(cx: &mut TestAppContext) {
    let (panel, cx) = cx.add_window_view(|_, cx| BrowserPanel::new(cx));
    panel.update(cx, |p, cx| {
        p.navigate("http://127.0.0.1:8123/unavailable", cx);
        let page = p.pages.get_mut(&p.active.unwrap()).unwrap();
        page.loading = false;
        page.error = Some("Could not connect to the server".into());
    });
    draw(cx);
    let banner = cx
        .debug_bounds("browser-error-banner")
        .expect("load errors need the Open in browser banner");
    let open = cx
        .debug_bounds("browser-recover")
        .expect("external recovery action");
    assert!(banner.contains(&open.center()));
    click(cx, "browser-reload");
    assert!(panel.read_with(cx, |p, _| p.pages[&1].error.is_none()));
    click(cx, "browser-close-1");
    draw(cx);
    assert!(cx.debug_bounds("browser-new-tab").is_some());
    panel.update(cx, |p, cx| p.set_previews(vec![8124], cx));
    assert!(
        panel.read_with(cx, |p, _| p.tabs.is_empty()),
        "closing all pages must not reseed"
    );
}

struct RemoteFixture {
    port: u16,
    log: std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl RemoteFixture {
    fn new() -> Self {
        Self::with_late_reply(false)
    }
    fn with_late_reply(late: bool) -> Self {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let recorded = log.clone();
        let stopping = stop.clone();
        let thread = std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stopping.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut data = vec![];
                let end = loop {
                    let mut chunk = [0; 2048];
                    let n = stream.read(&mut chunk).unwrap();
                    if n == 0 {
                        break 0;
                    }
                    data.extend_from_slice(&chunk[..n]);
                    if let Some(end) = data.windows(4).position(|s| s == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                if end == 0 {
                    continue;
                }
                let headers = String::from_utf8_lossy(&data[..end]).to_string();
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|s| s.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                while data.len() < end + length {
                    let mut chunk = [0; 2048];
                    let n = stream.read(&mut chunk).unwrap();
                    if n == 0 {
                        break;
                    }
                    data.extend_from_slice(&chunk[..n]);
                }
                let mut first = headers.lines().next().unwrap().split_whitespace();
                let method = first.next().unwrap();
                let path = first.next().unwrap();
                let body: serde_json::Value =
                    serde_json::from_slice(&data[end..]).unwrap_or(serde_json::Value::Null);
                recorded
                    .lock()
                    .unwrap()
                    .push(serde_json::json!({"method":method,"path":path,"body":body}));
                if late && method == "POST" {
                    std::thread::sleep(Duration::from_millis(350));
                }
                let response = if path.starts_with("/api/tasks?") {
                    serde_json::json!({"tasks":[{"id":"task-fixture","title":"Remote fixture","execution":{"jobId":"parent-job","attempt":1,"previewAccess":"requestable"}}]})
                } else if path == "/api/tasks/task-fixture/preview" && method == "POST" {
                    serde_json::json!({"schema":"o8/task.remote-preview/v1","jobId":"different-service-binding","attempt":2,"id":"a".repeat(48),"url":format!("http://[::1]:{port}/__o8_connect?ticket={}","b".repeat(64)),"service":"Review fixture","serviceJobId":"service-2"})
                } else {
                    serde_json::json!({"ports":[],"ok":true})
                };
                let body = serde_json::to_vec(&response).unwrap();
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        Self {
            port,
            log,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for RemoteFixture {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = std::net::TcpStream::connect(("127.0.0.1", self.port));
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}
fn wait_control(cx: &mut VisualTestContext, id: &'static str) {
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        draw(cx);
        if cx.debug_bounds(id).is_some() {
            return;
        }
        assert!(Instant::now() < until, "missing {id}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[gpui::test]
fn ticket9_remote_preview_uses_existing_task_routes_and_cleans_owner(cx: &mut TestAppContext) {
    let fixture = RemoteFixture::new();
    let client = crate::client::Client::authenticated(
        &format!("http://127.0.0.1:{}/", fixture.port),
        Some("remote-fixture-token".into()),
    )
    .unwrap()
    .in_workspace("/fixture");
    let (panel, cx) = cx.add_window_view(|_, cx| {
        let mut panel = BrowserPanel::new(cx);
        panel.configure(None, client, cx);
        panel
    });
    click(cx, "browser-new-tab");
    cx.update(|window, cx| panel.read(cx).focus.focus(window));
    cx.simulate_keystrokes("shift-f10");
    draw(cx);
    click(cx, "browser-menu-remote");
    wait_control(cx, "browser-remote-task-0");
    click(cx, "browser-remote-task-0");
    wait_control(cx, "browser-remote-connected");
    let saved = panel.read_with(cx, |p, _| {
        serde_json::to_string(&Snapshot::durable(&p.tabs, p.active)).unwrap()
    });
    assert!(
        !saved.contains("__o8_connect") && !saved.contains("ticket="),
        "remote access must never enter Browser persistence"
    );
    click(cx, "browser-remote-reconnect");
    wait_control(cx, "browser-remote-connected");
    click(cx, "browser-remote-back");
    wait_control(cx, "browser-address");
    let until = Instant::now() + Duration::from_secs(3);
    loop {
        if fixture
            .log
            .lock()
            .unwrap()
            .iter()
            .any(|r| r["method"] == "DELETE" && r["body"]["keepService"] == false)
        {
            break;
        }
        assert!(Instant::now() < until, "Back must close the remote service");
        draw(cx);
        std::thread::sleep(Duration::from_millis(10));
    }
    let log = fixture.log.lock().unwrap();
    let posts: Vec<_> = log.iter().filter(|r| r["method"] == "POST").collect();
    assert_eq!(posts.len(), 2);
    assert!(
        posts
            .iter()
            .all(|r| r["body"]["jobId"] == "parent-job" && r["body"]["attempt"] == 1)
    );
    assert_eq!(posts[1]["body"]["serviceJobId"], "service-2");
    assert!(
        log.iter()
            .any(|r| r["method"] == "DELETE" && r["body"]["keepService"] == true)
    );
    assert!(log.iter().any(|r| {
        r["path"]
            .as_str()
            .is_some_and(|s| s.starts_with("/api/tasks?") && s.contains("includeDone=true"))
    }));
}

#[gpui::test]
fn ticket9_remote_preview_releases_late_allocation_after_back(cx: &mut TestAppContext) {
    let fixture = RemoteFixture::with_late_reply(true);
    let client = crate::client::Client::authenticated(
        &format!("http://127.0.0.1:{}/", fixture.port),
        Some("remote-fixture-token".into()),
    )
    .unwrap()
    .in_workspace("/fixture");
    let (panel, cx) = cx.add_window_view(|_, cx| {
        let mut panel = BrowserPanel::new(cx);
        panel.configure(None, client, cx);
        panel
    });
    click(cx, "browser-new-tab");
    cx.update(|window, cx| panel.read(cx).focus.focus(window));
    cx.simulate_keystrokes("shift-f10");
    draw(cx);
    click(cx, "browser-menu-remote");
    wait_control(cx, "browser-remote-task-0");
    click(cx, "browser-remote-task-0");
    let until = Instant::now() + Duration::from_secs(4);
    while !fixture
        .log
        .lock()
        .unwrap()
        .iter()
        .any(|r| r["method"] == "POST")
    {
        assert!(Instant::now() < until);
        draw(cx);
        std::thread::sleep(Duration::from_millis(10));
    }
    click(cx, "browser-remote-back");
    wait_control(cx, "browser-address");
    loop {
        if fixture.log.lock().unwrap().iter().any(|r| {
            r["method"] == "DELETE"
                && r["body"]["id"] == "a".repeat(48)
                && r["body"]["keepService"] == false
        }) {
            break;
        }
        assert!(
            Instant::now() < until,
            "late allocation must be released after leaving the panel"
        );
        draw(cx);
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(target_os = "macos")]
#[gpui::test]
fn ticket9_browser_popup_opens_another_tab_for_the_same_url(cx: &mut TestAppContext) {
    let (panel, cx) = cx.add_window_view(|_, cx| BrowserPanel::new(cx));
    panel.update(cx, |p, cx| {
        let url = "http://localhost:8123/same";
        p.navigate(url, cx);
        *p.pages[&p.active.unwrap()].web.borrow_mut() = Some(web::Web::popup_for_test(url));
        p.follow(cx);
    });
    draw(cx);
    panel.read_with(cx, |p, _| {
        assert_eq!(
            p.tabs.len(),
            2,
            "a target-blank request must create another tab even for the same URL"
        );
        assert_eq!(p.tabs[0].url, p.tabs[1].url);
        assert_eq!(p.active, Some(p.tabs[1].id));
    });
}
