use super::*;
use serde_json::json;

fn session(id: &str, status: &str, parent: Option<&str>) -> Session {
    serde_json::from_value(json!({
        "id": id, "title": format!("{id} review"), "status": status, "runtime": "codex",
        "runStartedAt": "2026-11-01T14:00:00Z",
        "parentInboxSubject": parent.map(|p| json!({"kind": "conversation", "id": p})),
    }))
    .unwrap()
}

fn step(id: &str, status: &str, delegate: bool, thread: Option<&str>) -> Step {
    let mut step = crate::activity::activity(
        id,
        &json!({"name": "Task", "args": {"description": format!("{id} task")}, "status": status}),
        "",
    );
    step.delegate = delegate;
    step.thread = thread.map(str::to_owned);
    step.started = Some(1_000.);
    step.finished = Some(40_000.);
    step
}

#[test]
fn links_round_trip_and_reject_junk() {
    assert_eq!(link("abc-1"), "o8://thread/abc-1");
    assert_eq!(parse_link("o8://thread/abc-1"), Some("abc-1"));
    assert_eq!(parse_link("o8://thread/"), None);
    assert_eq!(parse_link("o8://thread/a b"), None);
    assert_eq!(parse_link("https://x/abc"), None);
}

#[test]
fn created_thread_reads_links_and_json_ids() {
    assert_eq!(
        created_thread("Created [Lakebed](o8://thread/t-42) in lakebed").as_deref(),
        Some("t-42")
    );
    assert_eq!(
        created_thread(r#"{"ok":true,"execution":{"sessionId":"s-9"}}"#).as_deref(),
        Some("s-9")
    );
    assert_eq!(created_thread("no thread here"), None);
    assert_eq!(created_thread(r#"{"ok":true}"#), None);
}

#[test]
fn server_children_follow_parent_inbox_subject() {
    let sessions = vec![
        session("parent", "running", None),
        session("a", "running", Some("parent")),
        session("b", "idle", Some("parent")),
        session("c", "running", Some("other")),
    ];
    let kids = server_children(&sessions, "parent");
    assert_eq!(kids.len(), 2);
    assert!(kids[0].working && !kids[1].working);
    assert_eq!(kids[0].thread.as_deref(), Some("a"));
    assert_eq!(kids[0].started, Some(1_793_541_600_000.));
    assert_eq!(parent(&sessions[1]), Some("parent"));
    assert_eq!(parent(&sessions[0]), None);
}

#[test]
fn trace_and_server_children_merge_by_thread() {
    let steps = vec![
        step("one", "running", true, Some("a")),
        step("two", "ok", true, None),
        step("ls", "ok", false, None),
    ];
    let trace = trace_children(&steps);
    assert_eq!(trace.len(), 2);
    let sessions = vec![
        session("a", "idle", Some("p")),
        session("z", "running", Some("p")),
    ];
    let merged = merge(trace, server_children(&sessions, "p"));
    assert_eq!(merged.len(), 3);
    // The server says the linked child finished.
    assert!(!merged[0].working);
    assert_eq!(merged[0].title, "one task");
    assert!(merged[2].working);
}

#[test]
fn labels_count_and_wait_only_while_working() {
    let mut kids = trace_children(&[
        step("a", "running", true, None),
        step("b", "running", true, None),
        step("c", "ok", true, None),
    ]);
    assert_eq!(
        card_label(&kids),
        Some(("3 subagents".into(), Some("2 working".into())))
    );
    assert_eq!(
        waiting(&kids),
        Some(("Waiting on 2 subagents".into(), "a task, b task".into()))
    );
    kids.iter_mut().for_each(|k| k.working = false);
    assert_eq!(card_label(&kids), Some(("3 subagents".into(), None)));
    assert_eq!(waiting(&kids), None);
    assert_eq!(card_label(&[]), None);
}

#[test]
fn elapsed_is_compact() {
    let mut child = trace_children(&[step("a", "ok", true, None)]).remove(0);
    assert_eq!(elapsed(&child, 999_999.).as_deref(), Some("39s"));
    child.working = true;
    assert_eq!(elapsed(&child, 1_000. + 125_000.).as_deref(), Some("2m"));
    assert_eq!(elapsed(&child, 1_000. + 7_200_000.).as_deref(), Some("2h"));
    child.started = None;
    assert_eq!(elapsed(&child, 0.), None);
}

#[test]
fn copy_items_offer_the_id_and_its_link() {
    let items = copy_items("t-7");
    assert_eq!(items[0].2, "t-7");
    assert_eq!(items[0].3, "Thread ID copied");
    assert_eq!(items[1].2, "o8://thread/t-7");
    assert_eq!(parse_link(&items[1].2), Some("t-7"));
}

#[test]
fn launch_and_task_calls_become_delegates_with_their_thread() {
    let launch = crate::activity::activity(
        "l1",
        &json!({"name": "mcp__o8__o8_launch_task", "status": "done",
                "args": {"taskId": "task-1"},
                "result": "{\"ok\":true,\"execution\":{\"sessionId\":\"child-1\"}}"}),
        "",
    );
    assert!(launch.delegate);
    assert_eq!(launch.thread.as_deref(), Some("child-1"));
    assert_eq!(launch.subject.as_deref(), Some("task-1"));
    let read = crate::activity::activity(
        "r1",
        &json!({"name": "Read", "status": "done", "args": {"file_path": "a.rs"},
                "result": "o8://thread/nope"}),
        "",
    );
    assert!(!read.delegate && read.thread.is_none());
    let task = crate::activity::activity(
        "t1",
        &json!({"name": "Task", "status": "running", "args": {"description": "Review"}}),
        "",
    );
    assert!(task.delegate && task.status == "running");
}

#[test]
fn the_card_skips_helpers_the_trace_already_links() {
    let mut linked = step("a", "ok", true, None);
    linked.delegations = vec![crate::subagents::model::Reference {
        id: "packet".into(),
        title: "Linked".into(),
    }];
    let steps = [linked, step("b", "ok", true, None)];
    assert_eq!(trace_children(&steps).len(), 2);
    assert_eq!(unlinked_children(&steps).len(), 1);
}
