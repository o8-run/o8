//! Prompt actions through painted GPUI controls and the production history routes.
use super::*;
use gpui::{Entity, Modifiers, VisualTestContext};
use std::time::Duration;

fn paint(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}

fn settle(
    view: &Entity<Surface>,
    cx: &mut VisualTestContext,
    ready: impl Fn(&Surface, &App) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        cx.run_until_parked();
        paint(cx);
        if view.read_with(cx, |s, app| ready(s, app)) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "prompt action timed out: {}",
            view.read_with(cx, |s, _| s.notice.clone())
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn saved(client: &Client, id: &str) -> Value {
    client
        .get("/api/v2/chat-history", &[("tabId", id)])
        .unwrap()
}

fn seed(client: &Client, count: usize, cx: &mut TestAppContext) -> Session {
    let fixture: Value = client.get("/api/prompt-action-fixture", &[]).unwrap();
    let root = std::path::PathBuf::from(fixture["nativeDraftRoot"].as_str().unwrap());
    cx.update(|cx| cx.set_global(crate::composer::mode_store::TestRoot(root)));
    let session = client
        .sessions()
        .unwrap()
        .into_iter()
        .find(|s| s.id == "thoughts-composer-first")
        .unwrap();
    let messages: Vec<_> = (0..count).flat_map(|index| [
        json!({"id":format!("ask-{index}"),"role":"user","content":"same **exact** prompt\nnext line","timestamp":1793433300000_u64 + index as u64 * 2000,"deliveryConfirmed":index == 0}),
        json!({"id":format!("answer-{index}"),"role":"assistant","content":format!("Answer {index}"),"timestamp":1793433301000_u64 + index as u64 * 2000}),
    ]).collect();
    let url = client.url("/api/v2/chat-history").unwrap();
    client
        .request("POST", &url)
        .send_json(json!({
            "tabId":session.id,"repoPath":session.repo_path,"backend":"pi","model":"pi",
            "messages":messages,"replace":true,
        }))
        .unwrap();
    session
}

fn show(view: &Entity<Surface>, id: &str, cx: &mut VisualTestContext) {
    view.update(cx, |s, cx| {
        let index = s
            .rows
            .iter()
            .position(|r| r.borrow().row.id() == id)
            .unwrap();
        s.list.scroll_to(ListOffset {
            item_ix: index,
            offset_in_item: px(0.),
        });
        cx.notify();
    });
    paint(cx);
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let bounds = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("missing native prompt control: {selector}"));
    cx.simulate_mouse_move(bounds.center(), None, Modifiers::default());
    paint(cx);
    cx.simulate_click(bounds.center(), Modifiers::default());
    paint(cx);
}

#[gpui::test]
fn prompt_toolbar_copies_original_and_exposes_metadata(cx: &mut TestAppContext) {
    let (_host, client) = fixture();
    let session = seed(&client, 2, cx);
    let saved_client = client.clone();
    let (view, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    view.update(cx, |s, cx| {
        s.sessions = saved_client.sessions().unwrap();
        s.select(session.id, cx);
    });
    settle(&view, cx, |s, _| s.queue_ready);
    show(&view, "ask-0", cx);
    assert!(
        cx.debug_bounds("prompt-time-ask-0").is_some(),
        "recorded prompt time must be reachable"
    );
    assert!(
        cx.debug_bounds("prompt-delivery-ask-0").is_some(),
        "delivery details must be reachable"
    );
    click(cx, "prompt-copy-ask-0");
    assert_eq!(
        cx.read_from_clipboard().unwrap().text().unwrap(),
        "same **exact** prompt\nnext line"
    );
    cx.write_to_clipboard(gpui::ClipboardItem::new_string("replace this".into()));
    cx.simulate_keystrokes("enter");
    assert_eq!(
        cx.read_from_clipboard().unwrap().text().unwrap(),
        "same **exact** prompt\nnext line",
        "keyboard activation must reach the focused action"
    );
}

#[gpui::test]
fn prompt_toolbar_keeps_scroll_position_when_confirmation_changes(cx: &mut TestAppContext) {
    let (_host, client) = fixture();
    let session = seed(&client, 20, cx);
    let saved_client = client.clone();
    let (view, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    view.update(cx, |s, cx| {
        s.sessions = saved_client.sessions().unwrap();
        s.select(session.id, cx);
    });
    settle(&view, cx, |s, _| s.queue_ready);
    show(&view, "ask-8", cx);
    let index = view.read_with(cx, |s, _| {
        s.rows
            .iter()
            .position(|r| r.borrow().row.id() == "ask-8")
            .unwrap()
    });
    view.update(cx, |s, cx| {
        s.list.scroll_to(ListOffset {
            item_ix: index,
            offset_in_item: px(7.),
        });
        cx.notify();
    });
    paint(cx);
    let anchor = view.read_with(cx, |s, _| s.list.logical_scroll_top());
    assert_eq!(anchor.item_ix, index);
    assert_eq!(anchor.offset_in_item, px(7.));
    click(cx, "prompt-rewind-ask-8");
    view.read_with(cx, |s, _| {
        let after = s.list.logical_scroll_top();
        assert_eq!(after.item_ix, anchor.item_ix);
        assert_eq!(
            after.offset_in_item, anchor.offset_in_item,
            "showing confirmation must keep the reader's position"
        );
    });
    click(cx, "prompt-rewind-cancel-ask-8");
    view.read_with(cx, |s, _| {
        let after = s.list.logical_scroll_top();
        assert_eq!(after.item_ix, anchor.item_ix);
        assert_eq!(
            after.offset_in_item, anchor.offset_in_item,
            "cancelling confirmation must keep the reader's position"
        );
    });
}

#[gpui::test]
fn prompt_toolbar_forks_full_prefix_without_future_context(cx: &mut TestAppContext) {
    let (_host, client) = fixture();
    let session = seed(&client, 62, cx);
    let original = saved(&client, &session.id);
    let saved_client = client.clone();
    let (view, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    view.update(cx, |s, cx| {
        s.sessions = saved_client.sessions().unwrap();
        s.select(session.id.clone(), cx);
    });
    settle(&view, cx, |s, _| s.queue_ready);
    show(&view, "ask-55", cx);
    click(cx, "prompt-fork-ask-55");
    settle(&view, cx, |s, _| {
        s.selected.as_ref().is_some_and(|id| id != &session.id) && s.queue_ready
    });
    let id = view.read_with(cx, |s, _| s.selected.clone().unwrap());
    let destination = saved(&saved_client, &id);
    let messages = destination["messages"].as_array().unwrap();
    assert_eq!(
        messages.len(),
        111,
        "fork must fetch the complete prefix, not the paged viewport"
    );
    assert_eq!(messages.first().unwrap()["id"], "ask-0");
    assert_eq!(messages.last().unwrap()["id"], "ask-55");
    assert_eq!(
        saved(&saved_client, &session.id)["messages"],
        original["messages"]
    );
    view.read_with(cx, |s, cx| {
        let editor = s.composer.read(cx);
        assert!(editor.text.is_empty());
        assert!(
            !editor.controls.prompt.prelude.contains("Answer 55"),
            "cold-start context must stop at the selected prompt"
        );
        assert!(
            s.queue["items"].as_array().unwrap().is_empty(),
            "fork must not send a provider turn"
        );
    });
}

#[gpui::test]
fn prompt_toolbar_rewind_confirms_and_preserves_source_draft(cx: &mut TestAppContext) {
    let (_host, client) = fixture();
    let session = seed(&client, 3, cx);
    let original = saved(&client, &session.id);
    let saved_client = client.clone();
    let (view, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    view.update(cx, |s, cx| {
        s.sessions = saved_client.sessions().unwrap();
        s.select(session.id.clone(), cx);
    });
    settle(&view, cx, |s, _| s.queue_ready);
    let editor = view.read_with(cx, |s, _| s.composer.clone());
    editor.update(cx, |i, cx| i.set_text("keep my current draft", cx));
    show(&view, "ask-1", cx);
    view.update(cx, |s, cx| {
        s.transcript.as_mut().unwrap().apply(&json!({"channel":"orchestrator","event":"status","data":{"snapshot":true,"status":"busy","threadId":session.id}}));
        cx.notify();
    });
    paint(cx);
    click(cx, "prompt-rewind-ask-1");
    assert!(
        cx.debug_bounds("prompt-rewind-confirm-ask-1").is_none(),
        "rewind must refuse while the agent works"
    );
    view.update(cx, |s, cx| {
        s.transcript.as_mut().unwrap().apply(&json!({"channel":"orchestrator","event":"status","data":{"snapshot":true,"status":"ready","threadId":session.id}}));
        cx.notify();
    });
    paint(cx);
    click(cx, "prompt-rewind-ask-1");
    assert_eq!(
        view.read_with(cx, |s, _| s.selected.clone()),
        Some(session.id.clone())
    );
    assert_eq!(
        saved_client
            .sessions()
            .unwrap()
            .iter()
            .filter(|s| s.id.starts_with("thoughts-next-"))
            .count(),
        0
    );
    click(cx, "prompt-rewind-cancel-ask-1");
    assert_eq!(
        editor.read_with(cx, |i, _| i.text.clone()),
        "keep my current draft"
    );
    click(cx, "prompt-rewind-ask-1");
    click(cx, "prompt-rewind-confirm-ask-1");
    settle(&view, cx, |s, _| {
        s.selected.as_ref().is_some_and(|id| id != &session.id) && s.queue_ready
    });
    let id = view.read_with(cx, |s, _| s.selected.clone().unwrap());
    let destination = saved(&saved_client, &id);
    assert_eq!(destination["messages"].as_array().unwrap().len(), 2);
    assert_eq!(destination["messages"][1]["id"], "answer-0");
    assert_eq!(
        saved(&saved_client, &session.id)["messages"],
        original["messages"]
    );
    assert_eq!(
        editor.read_with(cx, |i, _| i.text.clone()),
        "keep my current draft"
    );
    view.read_with(cx, |s, cx| {
        assert_eq!(s.composer.read(cx).text, "same **exact** prompt\nnext line");
        assert!(
            !s.composer
                .read(cx)
                .controls
                .prompt
                .prelude
                .contains("Answer 1")
        );
        assert!(s.queue["items"].as_array().unwrap().is_empty());
    });
}

fn configure(client: &Client, body: Value) {
    let url = client.url("/api/prompt-action-fixture").unwrap();
    client.request("POST", &url).send_json(body).unwrap();
}

#[gpui::test]
fn prompt_toolbar_first_prompt_fork_retries_the_same_saved_identity(cx: &mut TestAppContext) {
    let (_host, client) = fixture();
    let session = seed(&client, 2, cx);
    configure(&client, json!({"loseNextSave":true}));
    let saved_client = client.clone();
    let (view, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    view.update(cx, |s, cx| {
        s.sessions = saved_client.sessions().unwrap();
        s.select(session.id.clone(), cx);
    });
    settle(&view, cx, |s, _| s.queue_ready);
    let editor = view.read_with(cx, |s, _| s.composer.clone());
    show(&view, "ask-0", cx);
    click(cx, "prompt-fork-ask-0");
    settle(&view, cx, |s, app| !s.composer.read(app).controls.busy);
    assert_eq!(
        view.read_with(cx, |s, _| s.selected.clone()),
        Some(session.id.clone())
    );
    let created: Vec<_> = saved_client
        .sessions()
        .unwrap()
        .into_iter()
        .filter(|s| s.id.starts_with("thoughts-next-"))
        .collect();
    assert_eq!(
        created.len(),
        1,
        "lost response still saved exactly one continuation"
    );
    let id = created[0].id.clone();
    click(cx, "prompt-fork-ask-0");
    settle(&view, cx, |s, _| {
        s.selected.as_ref() == Some(&id) && s.queue_ready
    });
    assert_eq!(
        saved_client
            .sessions()
            .unwrap()
            .into_iter()
            .filter(|s| s.id.starts_with("thoughts-next-"))
            .count(),
        1
    );
    assert_eq!(
        saved(&saved_client, &id)["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(editor.read_with(cx, |i, _| i.text.is_empty()));
    view.read_with(cx, |s, cx| {
        let prelude = &s.composer.read(cx).controls.prompt.prelude;
        assert!(prelude.contains("same **exact** prompt"));
        assert!(!prelude.contains("Answer 0"));
    });
}

#[gpui::test]
fn prompt_toolbar_rewind_restores_media_after_navigation(cx: &mut TestAppContext) {
    let (_host, client) = fixture();
    let session = seed(&client, 3, cx);
    let image: Value = client.get("/api/prompt-action-fixture", &[]).unwrap();
    let mut record = saved(&client, &session.id);
    record["tabId"] = json!(session.id);
    record["replace"] = json!(true);
    record["messages"][2]["media"] = image["media"].clone();
    let url = client.url("/api/v2/chat-history").unwrap();
    client.request("POST", &url).send_json(record).unwrap();
    configure(&client, json!({"delayMs":350}));
    let saved_client = client.clone();
    let (view, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    view.update(cx, |s, cx| {
        s.sessions = saved_client.sessions().unwrap();
        s.select(session.id.clone(), cx);
    });
    settle(&view, cx, |s, _| s.queue_ready);
    let origin = view.read_with(cx, |s, _| s.composer.clone());
    origin.update(cx, |i, cx| i.set_text("source draft stays", cx));
    show(&view, "ask-1", cx);
    click(cx, "prompt-rewind-ask-1");
    click(cx, "prompt-rewind-confirm-ask-1");
    view.update(cx, |s, cx| s.select("thoughts-composer-second".into(), cx));
    settle(&view, cx, |s, app| {
        s.queue_ready && !origin.read(app).controls.busy
    });
    assert_eq!(
        view.read_with(cx, |s, _| s.selected.as_deref().map(String::from)),
        Some("thoughts-composer-second".into()),
        "late completion must not switch the current chat"
    );
    let id = saved_client
        .sessions()
        .unwrap()
        .into_iter()
        .find(|s| s.id.starts_with("thoughts-next-"))
        .unwrap()
        .id;
    view.update(cx, |s, cx| s.select(id.clone(), cx));
    settle(&view, cx, |s, _| s.queue_ready);
    view.read_with(cx, |s, cx| {
        let editor = s.composer.read(cx);
        assert_eq!(editor.text, "same **exact** prompt\nnext line");
        assert_eq!(
            editor.controls.images.len(),
            1,
            "rewind must restore durable media, not a discarded images field"
        );
        assert_eq!(editor.controls.images[0]["dataUri"], image["dataUri"]);
        assert!(s.queue["items"].as_array().unwrap().is_empty());
    });
    assert_eq!(
        origin.read_with(cx, |i, _| i.text.clone()),
        "source draft stays"
    );
    assert_eq!(
        saved(&saved_client, &session.id)["messages"]
            .as_array()
            .unwrap()
            .len(),
        6
    );
}

#[gpui::test]
fn prompt_continuation_is_ready_when_first_listed(cx: &mut TestAppContext) {
    let (_host, client) = fixture();
    let session = seed(&client, 3, cx);
    configure(&client, json!({"holdNextSave":true}));
    let saved_client = client.clone();
    let (view, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    view.update(cx, |s, cx| {
        s.sessions = saved_client.sessions().unwrap();
        s.select(session.id.clone(), cx);
    });
    settle(&view, cx, |s, _| s.queue_ready);
    let destination = format!("thoughts-next-{}", crate::clock::now());
    let (routing, store) = view.read_with(cx, |s, cx| {
        (
            s.composer_routing(cx).unwrap(),
            crate::composer::mode_store::path(
                &saved_client.url("/").unwrap().to_string(),
                &destination,
                cx,
            ),
        )
    });
    let (progress, _stages) = async_channel::unbounded();
    let worker_client = saved_client.clone();
    let source = session.clone();
    let worker_id = destination.clone();
    // GPUI's deterministic test dispatcher polls blocking tasks on this thread.
    // Real I/O keeps the save pending while the native view opens its listed chat.
    let worker = std::thread::spawn(move || {
        crate::ui::prompt_actions::continuation::create(
            &worker_client,
            &source,
            "ask-1",
            "same **exact** prompt\nnext line",
            &worker_id,
            true,
            &routing,
            store,
            progress,
        )
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let id = loop {
        if let Some(created) = saved_client
            .sessions()
            .unwrap()
            .into_iter()
            .find(|s| s.id.starts_with("thoughts-next-"))
        {
            break created.id;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    };
    view.update(cx, |s, cx| {
        s.sessions = saved_client.sessions().unwrap();
        s.select(id.clone(), cx);
    });
    assert!(
        !worker.is_finished(),
        "open destination while its create response is still delayed"
    );
    view.read_with(cx, |s, cx| {
        assert_eq!(s.composer.read(cx).text, "same **exact** prompt\nnext line");
        let prelude = &s.composer.read(cx).controls.prompt.prelude;
        assert!(prelude.contains("Answer 0"));
        assert!(!prelude.contains("Answer 1"));
    });
    view.update(cx, |s, cx| {
        s.composer
            .update(cx, |i, cx| i.set_text("my new draft", cx))
    });
    configure(&saved_client, json!({"releaseSave":true}));
    assert!(worker.join().unwrap().is_ok());
    view.update(cx, |s, cx| {
        s.select(session.id.clone(), cx);
        s.select(id.clone(), cx);
    });
    settle(&view, cx, |s, _| s.queue_ready);
    view.read_with(cx, |s, cx| {
        assert_eq!(
            s.composer.read(cx).text,
            "my new draft",
            "late success and revisiting must not overwrite an edited draft"
        )
    });
}

#[gpui::test]
fn prompt_toolbar_archived_retry_preserves_consumed_draft_and_history(cx: &mut TestAppContext) {
    let (_host, client) = fixture();
    let session = seed(&client, 2, cx);
    configure(&client, json!({"loseNextSave":true}));
    let saved_client = client.clone();
    let (view, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    view.update(cx, |s, cx| {
        s.sessions = saved_client.sessions().unwrap();
        s.select(session.id.clone(), cx);
    });
    settle(&view, cx, |s, _| s.queue_ready);
    let origin = view.read_with(cx, |s, _| s.composer.clone());
    show(&view, "ask-1", cx);
    click(cx, "prompt-rewind-ask-1");
    click(cx, "prompt-rewind-confirm-ask-1");
    settle(&view, cx, |_, app| !origin.read(app).controls.busy);
    let id = saved_client
        .sessions()
        .unwrap()
        .into_iter()
        .find(|s| s.id.starts_with("thoughts-next-"))
        .unwrap()
        .id;
    view.update(cx, |s, cx| {
        s.sessions = saved_client.sessions().unwrap();
        s.select(id.clone(), cx);
    });
    settle(&view, cx, |s, _| s.queue_ready);
    let store = view.read_with(cx, |_, cx| {
        crate::composer::mode_store::path(&saved_client.url("/").unwrap().to_string(), &id, cx)
            .unwrap()
    });
    let draft_file = store.with_extension("prompt-draft.json");
    let consumed_draft = std::fs::read(&draft_file).unwrap();
    let prelude_file = store.with_extension("prelude.json");
    crate::composer::mode_store::save_prelude(Some(&store), "edited context stays").unwrap();
    let edited_context = std::fs::read(&prelude_file).unwrap();
    let url = saved_client.url("/api/v2/chat-history").unwrap();
    saved_client
        .request("PATCH", &url)
        .send_json(json!({
            "tabId":id,"archivedAt":"2026-11-01T00:00:00Z","title":"Keep archive title",
        }))
        .unwrap();
    let archived = saved(&saved_client, &id);
    assert!(!saved_client.sessions().unwrap().iter().any(|s| s.id == id));
    view.update(cx, |s, cx| s.select(session.id.clone(), cx));
    settle(&view, cx, |s, _| s.queue_ready);
    show(&view, "ask-1", cx);
    click(cx, "prompt-rewind-ask-1");
    click(cx, "prompt-rewind-confirm-ask-1");
    settle(&view, cx, |_, app| !origin.read(app).controls.busy);
    assert_eq!(
        std::fs::read(draft_file).unwrap(),
        consumed_draft,
        "retry must not restore a consumed draft in an archived continuation"
    );
    assert_eq!(
        std::fs::read(prelude_file).unwrap(),
        edited_context,
        "retry must not replace context in an archived continuation"
    );
    assert_eq!(
        saved(&saved_client, &id),
        archived,
        "retry must not POST or rename the archived canonical record"
    );
}
