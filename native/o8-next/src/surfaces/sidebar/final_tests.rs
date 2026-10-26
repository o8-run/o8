//! Selection transitions and untrusted titles through the real sidebar surface.
use super::*;

fn create(fixture: &Fixture, id: &str, title: &str, archived: bool, timestamp: u64) {
    let record: Value = fixture
        .client
        .get("/api/v2/chat-history", &[("tabId", id)])
        .unwrap();
    post(
        fixture,
        "/api/v2/chat-history",
        json!({"tabId":id,"repoPath":record["repoPath"],
        "messages":[{"id":format!("{id}-message"),"role":"user","content":"Sidebar matrix message","timestamp":timestamp}]}),
    );
    fixture
        .client
        .patch_thread(
            id,
            json!({"title":title,"archivedAt":if archived {
        Some("2026-10-01T00:00:00.000Z")
    } else { None }}),
        )
        .unwrap();
}
fn search(shell: &Entity<Shell>, cx: &mut VisualTestContext, query: &str) {
    cx.simulate_keystrokes("ctrl-f ctrl-a");
    cx.simulate_input(query);
    cx.simulate_keystrokes("f8");
    settle(shell, cx);
}
fn select(shell: &Entity<Shell>, cx: &mut VisualTestContext, id: &str) {
    let index = sidebar(shell, cx).read_with(cx, |s, _| {
        s.rows
            .iter()
            .position(|row| row.id.as_deref() == Some(id))
            .unwrap()
    });
    sidebar(shell, cx).update(cx, |s, _| {
        s.scroll.scroll_to_item(index, ScrollStrategy::Top)
    });
    let bounds = row_bounds(shell, cx, id);
    cx.simulate_click(bounds.center(), Default::default());
    settle(shell, cx);
}
fn title(fixture: &Fixture, id: &str) -> Value {
    fixture
        .client
        .get::<Value>("/api/v2/chat-history", &[("tabId", id)])
        .unwrap()["title"]
        .clone()
}
fn selection_matrix(
    cx: &mut TestAppContext,
    a_archived: bool,
    b_archived: bool,
    sync: bool,
    pointer: bool,
) {
    let fixture = Fixture::start_mode(false, "--sidebar");
    let a = "thoughts-sidebar-0001";
    let b = "thoughts-sidebar-0002";
    for (id, suffix, archived, timestamp) in [
        (a, "A", a_archived, 1792000000040),
        (b, "B", b_archived, 1792000000030),
        ("thoughts-sidebar-0003", "Live tail", false, 1792000000010),
        (
            "thoughts-sidebar-0004",
            "Archived tail",
            true,
            1792000000010,
        ),
    ] {
        create(
            &fixture,
            id,
            &format!("Ownership matrix {suffix}"),
            archived,
            timestamp,
        );
    }
    let (shell, mut cx) = open(
        fixture.client.clone(),
        fixture.root.join("selection.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut cx);
    search(&shell, &mut cx, "Ownership matrix");
    select(&shell, &mut cx, a);
    cx.simulate_keystrokes("f8 f2");
    cx.simulate_input("Ownership matrix A saved");
    keys(&mut cx, "enter ctrl-a");
    let draft = "Ownership matrix A newer draft C";
    for key in draft.split("").map(gpui::Keystroke::parse) {
        cx.update(|window, cx| window.dispatch_keystroke(key.unwrap(), cx));
    }
    if sync {
        sidebar(&shell, &cx).update(&mut cx, |s, cx| s.sync_selection(b.into(), cx));
    } else {
        let bounds = row_bounds(&shell, &mut cx, b);
        cx.simulate_click(bounds.center(), Default::default());
    }
    sidebar(&shell, &cx).read_with(&cx, |s, _| {
        assert!(
            s.rename.is_none(),
            "selection must relinquish A's rename ownership"
        );
        assert!(!s.editing, "selection must leave rename mode");
    });
    wait(&shell, &mut cx, |s, _| !s.saving && !s.loading);
    assert_eq!(title(&fixture, a), "Ownership matrix A saved");
    // Down must choose another row; Enter opens it rather than saving hidden C.
    cx.simulate_keystrokes("down");
    let next = sidebar(&shell, &cx).read_with(&cx, |s, _| s.choice.clone().unwrap());
    if pointer {
        select(&shell, &mut cx, &next);
    } else {
        cx.simulate_keystrokes("enter");
    }
    settle(&shell, &mut cx);
    assert_eq!(
        active(&shell, &cx),
        next,
        "activation must open the keyboard choice"
    );
    assert_eq!(
        title(&fixture, a),
        "Ownership matrix A saved",
        "hidden C must not overwrite A"
    );
    assert_eq!(
        title(&fixture, b),
        "Ownership matrix B",
        "A's draft must never reach B"
    );
    search(&shell, &mut cx, "Ownership matrix");
    select(&shell, &mut cx, a);
    cx.simulate_keystrokes("f8 f2");
    assert!(
        sidebar(&shell, &cx).read_with(&cx, |s, cx| s.editor.read(cx).text == draft),
        "C must remain available only when A is renamed again"
    );
    cx.simulate_keystrokes("enter");
    wait(&shell, &mut cx, |s, _| !s.saving && !s.loading);
    assert_eq!(title(&fixture, a), draft);
    assert_eq!(title(&fixture, b), "Ownership matrix B");
}
macro_rules! selection_case {
    ($name:ident, $a:expr, $b:expr, $sync:expr, $pointer:expr) => {
        #[gpui::test]
        fn $name(cx: &mut TestAppContext) {
            selection_matrix(cx, $a, $b, $sync, $pointer);
        }
    };
}
selection_case!(live_live_click_keyboard, false, false, false, false);
selection_case!(live_live_click_pointer, false, false, false, true);
selection_case!(live_live_sync_keyboard, false, false, true, false);
selection_case!(live_live_sync_pointer, false, false, true, true);
selection_case!(live_archived_click_keyboard, false, true, false, false);
selection_case!(live_archived_click_pointer, false, true, false, true);
selection_case!(live_archived_sync_keyboard, false, true, true, false);
selection_case!(live_archived_sync_pointer, false, true, true, true);
selection_case!(archived_live_click_keyboard, true, false, false, false);
selection_case!(archived_live_click_pointer, true, false, false, true);
selection_case!(archived_live_sync_keyboard, true, false, true, false);
selection_case!(archived_live_sync_pointer, true, false, true, true);
selection_case!(archived_archived_click_keyboard, true, true, false, false);
selection_case!(archived_archived_click_pointer, true, true, false, true);
selection_case!(archived_archived_sync_keyboard, true, true, true, false);
selection_case!(archived_archived_sync_pointer, true, true, true, true);

fn title_matrix(cx: &mut TestAppContext, archived: bool) {
    let fixture = Fixture::start_mode(false, "--sidebar");
    let samples = [
        "Bearer syntheticSidebarCanaryToken12345",
        "sk-syntheticSidebarCanaryKey12345",
        "https://fixture.invalid/?token=syntheticSidebarCanaryQuery12345",
        "api_key=syntheticSidebarCanaryField12345",
    ];
    for (index, token) in samples.iter().enumerate() {
        create(
            &fixture,
            &format!("thoughts-sidebar-{index:04}"),
            &format!("Title matrix {index} {token}"),
            archived,
            1792000000100 + index as u64,
        );
    }
    let (shell, mut cx) = open(
        fixture.client.clone(),
        fixture.root.join("titles.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut cx);
    for query in ["Title matrix", "Sidebar matrix message"] {
        search(&shell, &mut cx, query);
        wait(&shell, &mut cx, |s, _| {
            !s.search_running && s.search_pending.is_none()
        });
        for index in 0..samples.len() {
            let id = format!("thoughts-sidebar-{index:04}");
            let bounds = row_bounds(&shell, &mut cx, &id);
            cx.simulate_mouse_move(bounds.center(), None, Default::default());
            draw(&mut cx);
            sidebar(&shell, &cx).read_with(&cx, |s, _| {
                let row = s
                    .rows
                    .iter()
                    .find(|row| row.id.as_deref() == Some(&id))
                    .unwrap();
                assert!(
                    !row.title.contains("syntheticSidebarCanary"),
                    "every displayed/hover title must be sanitized"
                );
                assert!(
                    row.title.contains("[redacted]"),
                    "sanitizer must run on each title path"
                );
                let session = s.sessions.iter().find(|session| session.id == id).unwrap();
                assert!(
                    !session.title.contains("syntheticSidebarCanary"),
                    "retained title consumers must receive sanitized titles"
                );
            });
        }
    }
}
#[gpui::test]
fn live_title_search_and_hover_matrix(cx: &mut TestAppContext) {
    title_matrix(cx, false);
}
#[gpui::test]
fn archived_title_search_and_hover_matrix(cx: &mut TestAppContext) {
    title_matrix(cx, true);
}

#[gpui::test]
fn streamed_title_is_sanitized_before_retained_events(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--sidebar");
    let (shell, mut cx) = open(
        fixture.client.clone(),
        fixture.root.join("stream-title.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut cx);
    let id = sidebar(&shell, &cx).read_with(&cx, |s, _| {
        s.rows.iter().find_map(|r| r.id.clone()).unwrap()
    });
    let thread = sidebar(&shell, &cx).read_with(&cx, |s, _| {
        let session = s.sessions.iter().find(|s| s.id == id).unwrap();
        json!({"id":session.id,"title":"Stream title Bearer syntheticSidebarCanaryStream12345",
            "status":session.status,"runtime":session.runtime,"lastMessageAt":session.last_message_at,
            "repoPath":session.repo_path,"messageCount":session.message_count})
    });
    let (sender, receiver) = std::sync::mpsc::channel();
    sender
        .send(Incoming::Frame(
            json!({"channel":"orchestrator-threads","event":"upsert","data":{"thread":thread}}),
        ))
        .unwrap();
    sidebar(&shell, &cx).update(&mut cx, |s, cx| {
        s.subscription.receiver = receiver;
        s.tick(cx);
    });
    settle(&shell, &mut cx);
    sidebar(&shell, &cx).read_with(&cx, |s, _| {
        let session = s.sessions.iter().find(|s| s.id == id).unwrap();
        assert!(session.title.starts_with("Stream title"));
        assert!(
            !session.title.contains("syntheticSidebarCanary"),
            "streamed retained title must be sanitized"
        );
    });
    shell.read_with(&cx, |s, _| {
        let session = s.sessions.iter().find(|s| s.id == id).unwrap();
        assert!(
            !session.title.contains("syntheticSidebarCanary"),
            "Loaded must not carry raw titles into other surfaces"
        );
    });
}
