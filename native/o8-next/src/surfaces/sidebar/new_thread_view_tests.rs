//! Sidebar input -> persisted chat history -> the main pane's actual Surface.
use super::*;

const FIRST: &str = "thoughts-composer-first";

fn row(shell: &Entity<Shell>, cx: &mut VisualTestContext, id: &str) -> &'static str {
    let sidebar = shell.read_with(cx, |s, _| s.surfaces.sidebar.view.clone().unwrap());
    let index = sidebar.read_with(cx, |list, _| {
        list.rows
            .iter()
            .position(|r| r.id.as_deref() == Some(id))
            .unwrap()
    });
    sidebar.update(cx, |list, cx| {
        list.scroll
            .scroll_to_item_strict(index, ScrollStrategy::Center);
        cx.notify();
    });
    draw(cx);
    Box::leak(format!("thread-row-{index}").into_boxed_str())
}

fn main_view(shell: &Shell) -> Entity<crate::ui::Surface> {
    match &shell.content[&shell.key(&shell.active().unwrap())] {
        Content::Session(view) => view.clone(),
        _ => panic!("the main pane must show a session"),
    }
}

fn stream_before_catalog(shell: &Entity<Shell>, cx: &mut VisualTestContext, shift: bool) -> String {
    let sidebar = shell.read_with(cx, |s, _| s.surfaces.sidebar.view.clone().unwrap());
    let at = cx.debug_bounds("sidebar-new-thread").unwrap().center();
    let modifiers = gpui::Modifiers {
        shift,
        ..Default::default()
    };
    // Ordinary simulate_click drains the POST and its catalog read together.
    // Dispatch the real click, then stop after the POST's callback queues that
    // read. This lets the real socket deliver the new row first.
    cx.simulate_event_without_wait(gpui::MouseDownEvent {
        position: at,
        button: gpui::MouseButton::Left,
        modifiers,
        click_count: 1,
        first_mouse: false,
    });
    cx.simulate_event_without_wait(gpui::MouseUpEvent {
        position: at,
        button: gpui::MouseButton::Left,
        modifiers,
        click_count: 1,
    });
    let started = Instant::now();
    while sidebar.read_with(cx, |list, _| list.diagnostic()["loading"] != true) {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "POST must queue its catalog read"
        );
        cx.background_executor.tick();
    }
    let created = loop {
        // The production shell pump consumes the live frame without running
        // the queued HTTP task on the deterministic executor.
        shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
        if let Some(id) = sidebar.read_with(cx, |list, _| {
            list.rows
                .iter()
                .filter_map(|row| row.id.clone())
                .find(|id| id.starts_with("thoughts-next-"))
        }) {
            break id;
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the live stream must deliver the new row"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    let shown = active_id(shell, cx);
    let selected = sidebar.read_with(cx, |list, _| list.selected.clone());
    // Drain the outstanding HTTP work before asserting the earlier scene.
    cx.run_until_parked();
    assert_eq!(
        shown, created,
        "the main pane must open the live new row before a catalog retry"
    );
    assert_eq!(selected.as_ref(), Some(&created));
    created
}

fn new_thread_view(cx: &mut TestAppContext, archive: bool, shift: bool) {
    let fixture = Fixture::start_mode(true, "--shell --composer --sidebar --settings");
    let original: Value = fixture
        .client
        .get("/api/v2/chat-history", &[("tabId", FIRST)])
        .unwrap();
    let repo = original["repoPath"].as_str().unwrap().to_owned();
    let mut paths = vec![repo.clone()];
    // Multiple repositories make Shift exercise the current-repository shortcut.
    if shift {
        paths.push(fixture.folders[0].clone());
    }
    scope_tests::project(&fixture, &paths);
    let file = fixture.root.join("new-thread-view.json");
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    wait_for(&shell, &mut visual, |s, cx| {
        s.connected
            && s.surfaces
                .sidebar
                .view
                .as_ref()
                .unwrap()
                .read(cx)
                .rows
                .iter()
                .any(|r| r.id.as_deref() == Some(FIRST))
    });
    let target = row(&shell, &mut visual, FIRST);
    click(&mut visual, target);
    ready(&shell, &mut visual);
    assert_eq!(active_id(&shell, &mut visual), FIRST);
    let view = shell.read_with(&visual, |s, _| main_view(s));
    assert!(
        view.update(&mut visual, |v, cx| v.shell_loaded_probe(false, cx))["rows"]
            .as_u64()
            .unwrap()
            > 0
    );

    if archive {
        let target = row(&shell, &mut visual, FIRST);
        let at = visual.debug_bounds(target).unwrap().center();
        visual.simulate_mouse_down(at, gpui::MouseButton::Right, gpui::Modifiers::default());
        visual.simulate_mouse_up(at, gpui::MouseButton::Right, gpui::Modifiers::default());
        click(&mut visual, "sidebar-row-archive");
        wait_for(&shell, &mut visual, |s, cx| {
            s.surfaces
                .sidebar
                .view
                .as_ref()
                .unwrap()
                .read(cx)
                .sessions
                .iter()
                .any(|session| session.id == FIRST && session.status == "archived")
        });
        assert!(
            shell
                .read_with(&visual, |_, cx| crate::shell::toasts::texts(cx))
                .iter()
                .any(|text| text == "Thread archived.")
        );
        let saved: Value = fixture
            .client
            .get("/api/v2/chat-history", &[("tabId", FIRST)])
            .unwrap();
        assert!(saved["archivedAt"].is_string());
        assert_eq!(saved["messages"], original["messages"]);
    }

    wait_for(&shell, &mut visual, |s, cx| {
        let state = s
            .surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .diagnostic();
        state["loading"] == false && state["dirty"] == false
    });
    let sidebar = shell.read_with(&visual, |s, _| s.surfaces.sidebar.view.clone().unwrap());
    sidebar.update(&mut visual, |list, cx| {
        list.scroll.scroll_to_item_strict(0, ScrollStrategy::Top);
        cx.notify();
    });
    draw(&mut visual);
    let created = if archive || shift {
        stream_before_catalog(&shell, &mut visual, shift)
    } else {
        scope_tests::press(
            &mut visual,
            "sidebar-new-thread",
            gpui::Modifiers {
                shift,
                ..Default::default()
            },
        );
        wait_for(&shell, &mut visual, |s, cx| {
            let list = s.surfaces.sidebar.view.as_ref().unwrap().read(cx);
            list.selected.as_ref().is_some_and(|id| {
                id.starts_with("thoughts-next-")
                    && list.rows.iter().any(|r| r.id.as_ref() == Some(id))
            })
        });
        shell.read_with(&visual, |s, cx| {
            s.surfaces
                .sidebar
                .view
                .as_ref()
                .unwrap()
                .read(cx)
                .selected
                .clone()
                .unwrap()
        })
    };
    assert_eq!(
        active_id(&shell, &mut visual),
        created,
        "New thread must open the thread its sidebar row marks current"
    );
    wait_for(&shell, &mut visual, |s, cx| {
        main_view(s).read(cx).shell_issue_state(cx)["ready"] == true
    });
    let view = shell.read_with(&visual, |s, _| main_view(s));
    let probe = view.update(&mut visual, |v, cx| v.shell_loaded_probe(false, cx));
    assert_eq!(probe["rows"], 0, "the previous transcript must be gone");
    assert_eq!(probe["text"], "", "the new thread has an empty composer");
    draw(&mut visual);
    assert!(visual.debug_bounds("composer-space").is_some());
    let saved: Value = fixture
        .client
        .get("/api/v2/chat-history", &[("tabId", &created)])
        .unwrap();
    assert_eq!(saved["repoPath"], repo);
    assert_eq!(saved["messages"], json!([]));
    assert!(saved["archivedAt"].is_null());
    let state = State::load(&file).unwrap();
    let workspace = &state.workspaces[&repo];
    let Tab::Session(original) = &workspace.tabs[workspace.active] else {
        panic!("session tab")
    };
    assert_eq!(workspace.selections.get(original), Some(&created));
}

#[gpui::test]
fn sidebar_new_thread_view_after_archive(cx: &mut TestAppContext) {
    new_thread_view(cx, true, false);
}

#[gpui::test]
fn sidebar_new_thread_view_shift_current_repository(cx: &mut TestAppContext) {
    new_thread_view(cx, false, true);
}

#[gpui::test]
fn sidebar_new_thread_view_plain(cx: &mut TestAppContext) {
    new_thread_view(cx, false, false);
}
