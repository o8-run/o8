//! Real mouse/key dispatch and production PATCH responses through the fixture host.
use super::*;
use crate::shell::{Content, Shell, test_support::*};
use crate::shell_state::State;
use gpui::{App, MouseButton, TestAppContext, VisualTestContext};
use serde_json::Value;

fn sidebar(shell: &Entity<Shell>, cx: &VisualTestContext) -> Entity<ThreadList> {
    shell.read_with(cx, |s, _| s.surfaces.sidebar.view.as_ref().unwrap().clone())
}
fn settle(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    cx.run_until_parked();
    shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
    draw(cx);
}
#[track_caller]
fn wait(
    shell: &Entity<Shell>,
    cx: &mut VisualTestContext,
    predicate: impl Fn(&ThreadList, &App) -> bool,
) {
    let start = Instant::now();
    loop {
        settle(shell, cx);
        if sidebar(shell, cx).read_with(cx, |s, cx| predicate(s, cx)) {
            return;
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "fixture state must become visible"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn row_bounds(
    shell: &Entity<Shell>,
    cx: &mut VisualTestContext,
    id: &str,
) -> gpui::Bounds<gpui::Pixels> {
    draw(cx);
    let index = sidebar(shell, cx).read_with(cx, |s, _| {
        s.rows
            .iter()
            .position(|r| r.id.as_deref() == Some(id))
            .unwrap()
    });
    cx.debug_bounds(Box::leak(format!("thread-row-{index}").into_boxed_str()))
        .unwrap()
}
fn active(shell: &Entity<Shell>, cx: &VisualTestContext) -> String {
    shell.read_with(cx, |s, cx| {
        match s.content.get(&s.key(&s.active().unwrap())).unwrap() {
            Content::Session(view) => view.read(cx).shell_selected(),
            _ => panic!("session"),
        }
    })
}
fn post(fixture: &Fixture, path: &str, body: Value) {
    ureq::AgentBuilder::new()
        .try_proxy_from_env(false)
        .build()
        .post(&format!("{}{path}", fixture.origin))
        .set("Authorization", "Bearer fixture-shell-bearer")
        .send_json(body)
        .unwrap();
}
fn promote(fixture: &Fixture, id: &str, timestamp: u64) {
    let record: Value = fixture
        .client
        .get("/api/v2/chat-history", &[("tabId", id)])
        .unwrap();
    post(
        fixture,
        "/api/v2/chat-history",
        json!({"tabId":id,"repoPath":record["repoPath"],"messages":[{
            "id":format!("reorder-{timestamp}"),"role":"user","content":"Live reorder","timestamp":timestamp
        }]}),
    );
}
fn press_reorder(cx: &mut TestAppContext, follow_pressed: bool) {
    let fixture = Fixture::start_mode(false, "--sidebar");
    let (shell, mut cx) = open(
        fixture.client.clone(),
        fixture.root.join("press.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut cx);
    let (a, b) = sidebar(&shell, &cx).read_with(&cx, |s, _| {
        assert_eq!(s.rows[2].workspace, s.rows[3].workspace);
        assert_eq!(s.rows[2].status, s.rows[3].status);
        (s.rows[2].id.clone().unwrap(), s.rows[3].id.clone().unwrap())
    });
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_input("thoughts-composer-first");
    cx.simulate_keystrokes("enter");
    ready(&shell, &mut cx);
    cx.simulate_keystrokes("f8 home");
    let original = active(&shell, &cx);
    assert_ne!(original, a);
    assert_ne!(original, b);
    let pressed = row_bounds(&shell, &mut cx, &a).center();
    cx.simulate_mouse_down(pressed, MouseButton::Left, Default::default());
    draw(&mut cx);
    promote(&fixture, &b, 1791000000000);
    wait(&shell, &mut cx, |s, _| s.rows[2].id.as_deref() == Some(&b));
    let release = if follow_pressed {
        row_bounds(&shell, &mut cx, &a).center()
    } else {
        pressed
    };
    cx.simulate_mouse_up(release, MouseButton::Left, Default::default());
    settle(&shell, &mut cx);
    assert_eq!(
        active(&shell, &cx),
        if follow_pressed { a.clone() } else { original },
        "release must retain the pressed thread identity, never the replacement row"
    );
    if follow_pressed {
        cx.simulate_keystrokes("f8");
        promote(&fixture, &a, 1791000000001);
        wait(&shell, &mut cx, |s, _| s.rows[2].id.as_deref() == Some(&a));
        cx.simulate_keystrokes("enter");
        settle(&shell, &mut cx);
        assert_eq!(
            active(&shell, &cx),
            a,
            "keyboard focus follows the thread across reorders"
        );
    }
}
#[gpui::test]
fn sidebar_release_over_replacement_does_not_open_it(cx: &mut TestAppContext) {
    press_reorder(cx, false);
}
#[gpui::test]
fn sidebar_release_over_moved_thread_keeps_its_identity(cx: &mut TestAppContext) {
    press_reorder(cx, true);
}

fn keys(cx: &mut VisualTestContext, keys: &str) {
    for key in keys.split_whitespace() {
        cx.update(|window, cx| window.dispatch_keystroke(gpui::Keystroke::parse(key).unwrap(), cx));
        draw(cx);
    }
}
fn pending_save(cx: &mut TestAppContext, mode: &str) {
    let fixture = Fixture::start_mode(false, "--sidebar");
    let (shell, mut cx) = open(
        fixture.client.clone(),
        fixture.root.join("save.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut cx);
    let (a, b) = sidebar(&shell, &cx).read_with(&cx, |s, _| {
        (s.rows[2].id.clone().unwrap(), s.rows[3].id.clone().unwrap())
    });
    let bounds = row_bounds(&shell, &mut cx, &a);
    cx.simulate_click(bounds.center(), Default::default());
    ready(&shell, &mut cx);
    cx.simulate_keystrokes("f8 f2");
    cx.simulate_input("Saved title A");
    // The convenience simulate_* helpers drain background work after each call.
    // Dispatch through the real window without draining so editing can interleave
    // with the already-started HTTP save, as it does in the app event loop.
    keys(&mut cx, "enter");
    assert!(sidebar(&shell, &cx).read_with(&cx, |s, _| s.saving));
    match mode {
        "rename-b" => keys(&mut cx, "f8 down enter f8 f2"),
        "search" => keys(&mut cx, "ctrl-f"),
        _ => keys(&mut cx, "ctrl-a"),
    }
    let draft = match mode {
        "search" => "Sidebar thread 1999",
        "rename-b" => "New draft B",
        _ => "New draft A",
    };
    for key in draft.split("").map(gpui::Keystroke::parse) {
        cx.update(|window, cx| window.dispatch_keystroke(key.unwrap(), cx));
    }
    draw(&mut cx);
    sidebar(&shell, &cx).read_with(&cx, |s, cx| {
        assert!(
            s.saving,
            "the first save is still outstanding while the next draft is entered"
        );
        assert_eq!(s.editor.read(cx).text, draft);
    });
    wait(&shell, &mut cx, |s, _| !s.saving && !s.loading);
    let persisted: Value = fixture
        .client
        .get("/api/v2/chat-history", &[("tabId", &a)])
        .unwrap();
    assert_eq!(
        persisted["title"], "Saved title A",
        "the outstanding save commits A's original draft"
    );
    sidebar(&shell, &cx).read_with(&cx, |s, cx| {
        assert_eq!(
            s.editor.read(cx).text,
            draft,
            "A's completed save must retain the newer editor draft"
        );
        assert!(s.editing, "the newer editor remains active");
        if mode == "search" {
            assert!(s.rename.is_none());
            assert_eq!(s.query, draft);
        } else {
            assert_eq!(
                s.rename.as_deref(),
                Some(if mode == "rename-b" {
                    b.as_str()
                } else {
                    a.as_str()
                })
            );
        }
    });
    if mode != "search" {
        cx.simulate_keystrokes("enter");
        wait(&shell, &mut cx, |s, _| !s.saving && !s.loading);
        let id = if mode == "rename-b" { &b } else { &a };
        let record: Value = fixture
            .client
            .get("/api/v2/chat-history", &[("tabId", id)])
            .unwrap();
        assert_eq!(
            record["title"], draft,
            "the retained draft saves through the same production record"
        );
    }
}
#[gpui::test]
fn sidebar_save_result_preserves_another_threads_rename(cx: &mut TestAppContext) {
    pending_save(cx, "rename-b");
}
#[gpui::test]
fn sidebar_save_result_preserves_new_search(cx: &mut TestAppContext) {
    pending_save(cx, "search");
}
#[gpui::test]
fn sidebar_save_result_preserves_same_threads_new_draft(cx: &mut TestAppContext) {
    pending_save(cx, "same");
}

#[path = "final_tests.rs"]
mod final_round;
