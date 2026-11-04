//! Painted roster controls and their real HTTP/WebSocket requests.
use super::*;
use gpui::{TestAppContext, VisualTestContext};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

struct Http {
    client: Client,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    interrupts: Arc<Mutex<Vec<Value>>>,
    fail: Arc<AtomicBool>,
    /// What GET /api/orchestrator/state and GET /api/lanes answer.
    state: Arc<Mutex<Value>>,
    lanes: Arc<Mutex<Value>>,
    done: Arc<AtomicBool>,
    threads: Vec<std::thread::JoinHandle<()>>,
}
impl Http {
    fn new() -> Self {
        let http = TcpListener::bind("127.0.0.1:0").unwrap();
        let ws = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = http.local_addr().unwrap().port();
        let ws_port = ws.local_addr().unwrap().port();
        http.set_nonblocking(true).unwrap();
        ws.set_nonblocking(true).unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let interrupts = Arc::new(Mutex::new(Vec::new()));
        let fail = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let state = Arc::new(Mutex::new(json!({"mission":{"packets":[]}})));
        let lanes = Arc::new(Mutex::new(json!({"lanes":[{
            "id":"lane-done", "packetId":"done", "status":"completed", "ownership":"managed", "worktreePath":"/repo/wt-done"
        }]})));
        let (seen, failure, end) = (calls.clone(), fail.clone(), done.clone());
        let (served_state, served_lanes) = (state.clone(), lanes.clone());
        let http_thread = std::thread::spawn(move || {
            while !end.load(Ordering::Acquire) {
                let Ok((mut stream, _)) = http.accept() else {
                    std::thread::sleep(Duration::from_millis(1));
                    continue;
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse().unwrap();
                        }
                    }
                }
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let body = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
                let path = first
                    .split_whitespace()
                    .nth(1)
                    .unwrap()
                    .split('?')
                    .next()
                    .unwrap();
                let query = first
                    .split_whitespace()
                    .nth(1)
                    .unwrap()
                    .split_once('?')
                    .map(|q| q.1.to_owned());
                seen.lock().unwrap().push((
                    format!("{} {path}", first.split_whitespace().next().unwrap()),
                    if first.starts_with("GET") {
                        json!(query)
                    } else {
                        body
                    },
                ));
                let failed = first.starts_with("POST") && failure.load(Ordering::Acquire);
                let body = match path {
                    "/api/panel/ws-info" => json!({"wsPort":ws_port,"wsToken":"fixture"}),
                    "/api/orchestrator/state" => served_state.lock().unwrap().clone(),
                    "/api/orchestrator/shared-team/active" => json!({"threadId":"thoughts-lead","workers":[]}),
                    "/api/v2/chat-history" => json!({"backend":"pi"}),
                    "/api/lanes" if first.starts_with("GET") => {
                        served_lanes.lock().unwrap().clone()
                    }
                    "/api/lanes" => json!({"ok":true,"lane":{"worktreePath":null}}),
                    _ if failed => json!({"ok":false,"error":"Stop refused"}),
                    _ => json!({"ok":true}),
                }.to_string();
                write!(stream, "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", if failed {"409 Conflict"} else {"200 OK"}, body.len()).unwrap();
            }
        });
        let (seen, end) = (interrupts.clone(), done.clone());
        let ws_thread = std::thread::spawn(move || {
            while !end.load(Ordering::Acquire) {
                let Ok((stream, _)) = ws.accept() else {
                    std::thread::sleep(Duration::from_millis(1));
                    continue;
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut socket = tungstenite::accept(stream).unwrap();
                let frame = socket.read().unwrap();
                let frame: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
                seen.lock().unwrap().push(frame.clone());
                socket.send(tungstenite::Message::Text(json!({"channel":"orchestrator","event":"interrupt-ack","data":{"threadId":frame["threadId"],"state":"accepted"}}).to_string().into())).unwrap();
            }
        });
        Self {
            client: Client::authenticated(&format!("http://127.0.0.1:{port}"), None)
                .unwrap()
                .with_tunnel(None),
            calls,
            interrupts,
            fail,
            state,
            lanes,
            done,
            threads: vec![http_thread, ws_thread],
        }
    }
    fn posts(&self) -> Vec<(String, Value)> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(line, _)| line.starts_with("POST"))
            .cloned()
            .collect()
    }
}
impl Drop for Http {
    fn drop(&mut self) {
        self.done.store(true, Ordering::Release);
        for thread in self.threads.drain(..) {
            thread.join().unwrap();
        }
    }
}

fn packet(id: &str, status: &str, worktree: bool) -> Agent {
    model::agents(&json!({"mission":{"packets":[{
        "id":id,"title":id,"status":status,"workspaceTargetPath":"/repo",
        "lane":{"laneId":format!("lane-{id}"),"worktreePath":worktree.then(|| format!("/repo/wt-{id}")),"sessionKey":format!("session-{id}")}
    }]}}), &Scope {repo:"/repo".into(),parent:None}).unwrap().remove(0)
}
fn mixed() -> Vec<Agent> {
    let mut shared = packet("shared", "running", false);
    shared.shared = true;
    shared.id = "opencode-owned:shared".into();
    let mut native = packet("native-a", "running", false);
    native.native = true;
    let mut other = native.clone();
    other.id = "native-b".into();
    vec![
        packet("packet", "running", true),
        shared,
        native,
        other,
        packet("done", "released", true),
    ]
}
struct Roster {
    state: Rc<RefCell<RowState>>,
    inspector: Entity<Inspector>,
    _observe: gpui::Subscription,
}
impl Render for Roster {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let row = self.state.borrow().row.clone();
        let Row::Activity { steps, trace, .. } = row else {
            unreachable!()
        };
        div()
            .w(px(800.))
            .children(element("roster-test", self.state.clone(), &steps, &trace, 1.).map(|e| e.0))
    }
}
fn show<'a>(
    http: &Http,
    agents: Vec<Agent>,
    cx: &'a mut TestAppContext,
) -> (Entity<Roster>, &'a mut VisualTestContext) {
    let steps = agents
        .iter()
        .map(|agent| {
            let mut step = crate::activity::activity(
                &agent.id,
                &json!({"name":"Agent","status":"running","args":{"description":agent.title}}),
                "",
            );
            step.delegations = vec![model::Reference {
                id: agent.id.clone(),
                title: agent.title.clone(),
            }];
            step
        })
        .collect();
    let state = Rc::new(RefCell::new(RowState::new(Row::Activity {
        id: "roster-test".into(),
        steps,
        trace: Trace::default(),
    })));
    state.borrow_mut().subagent_agents = Rc::new(agents);
    let client = http.client.clone();
    let (view, visual) = cx.add_window_view(|_, cx| {
        state.borrow_mut().bind_subagent_focus(cx);
        let inspector = cx.new(|cx| {
            Inspector::new(
                client,
                Scope {
                    repo: "/repo".into(),
                    parent: Some("llm-chat:thoughts-lead".into()),
                },
                cx,
            )
        });
        state.borrow_mut().subagents = Some(inspector.clone());
        let observe = cx.observe(&inspector, |_, _, cx| cx.notify());
        Roster {
            state,
            inspector,
            _observe: observe,
        }
    });
    visual.run_until_parked();
    paint(visual);
    (view, visual)
}
fn paint(cx: &mut VisualTestContext) {
    cx.update(|w, cx| {
        w.refresh();
        w.draw(cx).clear();
    });
}
fn click(cx: &mut VisualTestContext, selector: &'static str) {
    paint(cx);
    let bounds = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("Missing {selector}"));
    cx.simulate_event_without_wait(gpui::MouseDownEvent {
        position: bounds.center(),
        modifiers: gpui::Modifiers::default(),
        button: gpui::MouseButton::Left,
        click_count: 1,
        first_mouse: false,
    });
    cx.simulate_event_without_wait(gpui::MouseUpEvent {
        position: bounds.center(),
        modifiers: gpui::Modifiers::default(),
        button: gpui::MouseButton::Left,
        click_count: 1,
    });
}

#[gpui::test]
fn roster_footer_only_offers_applicable_actions(cx: &mut TestAppContext) {
    let http = Http::new();
    let (view, cx) = show(&http, mixed(), cx);
    assert!(cx.debug_bounds("subagent-roster-stop-all").is_some());
    assert!(cx.debug_bounds("subagent-roster-clean-up").is_some());
    view.update(cx, |v, cx| {
        for agent in Rc::make_mut(&mut v.state.borrow_mut().subagent_agents) {
            agent.group = Group::Done;
        }
        cx.notify();
    });
    paint(cx);
    assert!(cx.debug_bounds("subagent-roster-stop-all").is_none());
    view.update(cx, |v, cx| {
        Rc::make_mut(&mut v.state.borrow_mut().subagent_agents).retain(|a| a.id != "done");
        cx.notify();
    });
    paint(cx);
    assert!(cx.debug_bounds("subagent-roster-clean-up").is_none());
}

#[gpui::test]
fn roster_stop_all_targets_each_working_kind_once(cx: &mut TestAppContext) {
    let http = Http::new();
    let (_view, cx) = show(&http, mixed(), cx);
    click(cx, "subagent-roster-stop-all");
    click(cx, "subagent-roster-stop-all"); // The second press must be disabled.
    cx.run_until_parked();
    let posts = http.posts();
    assert_eq!(posts.len(), 2, "{posts:?}");
    assert_eq!(
        posts[0],
        (
            "POST /api/orchestrator/stop-packet".into(),
            json!({"packetId":"packet"})
        )
    );
    assert_eq!(posts[1].0, "POST /api/runtime/action");
    assert_eq!(posts[1].1["action"], "interrupt");
    assert_eq!(posts[1].1["surfaceId"], "opencode-owned:shared");
    assert!(
        posts[1].1["clientMutationId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
    );
    assert_eq!(
        *http.interrupts.lock().unwrap(),
        vec![
            json!({"type":"orchestrator-interrupt","repoPath":"/repo","threadId":"thoughts-lead","backend":"pi"})
        ]
    );
}

#[gpui::test]
fn roster_needs_input_opens_that_agents_inspector(cx: &mut TestAppContext) {
    let http = Http::new();
    let (view, cx) = show(
        &http,
        vec![
            packet("review", "awaiting_review", false),
            packet("blocked", "blocked", false),
            packet("done", "released", false),
        ],
        cx,
    );
    assert!(cx.debug_bounds("subagent-roster-open-done").is_none());
    click(cx, "subagent-roster-open-blocked");
    assert_eq!(
        view.read_with(cx, |v, cx| v.inspector.read(cx).selected.clone())
            .as_deref(),
        Some("blocked")
    );
    click(cx, "subagent-roster-open-review");
    assert_eq!(
        view.read_with(cx, |v, cx| v.inspector.read(cx).selected.clone())
            .as_deref(),
        Some("review")
    );
    assert!(http.posts().is_empty());
}

#[gpui::test]
fn roster_cleanup_archives_only_the_finished_worktree(cx: &mut TestAppContext) {
    let http = Http::new();
    let (_view, cx) = show(&http, mixed(), cx);
    click(cx, "subagent-roster-clean-up");
    click(cx, "subagent-roster-clean-up");
    cx.run_until_parked();
    paint(cx);
    assert_eq!(
        http.posts(),
        vec![(
            "POST /api/lanes".into(),
            json!({"verb":"archive","laneId":"lane-done"})
        )]
    );
    assert!(http.interrupts.lock().unwrap().is_empty());
    assert!(cx.debug_bounds("subagent-roster-clean-up").is_none());
}

#[gpui::test]
fn roster_stop_failure_is_visible_and_other_stops_still_run(cx: &mut TestAppContext) {
    let http = Http::new();
    http.fail.store(true, Ordering::Release);
    let (_view, cx) = show(&http, mixed(), cx);
    click(cx, "subagent-roster-stop-all");
    cx.run_until_parked();
    paint(cx);
    assert!(cx.debug_bounds("subagent-roster-error").is_some());
    assert_eq!(http.posts().len(), 2);
    assert_eq!(http.interrupts.lock().unwrap().len(), 1);
}

/// Server state for a lead turn with three packet workers: one finished in its
/// worktree, two waiting on approvals, one still working.
fn seed(http: &Http) {
    let packet = |id: &str, status: &str, extra: Value| {
        let mut packet = json!({
            "id": id, "title": id, "status": status, "workspaceTargetPath": "/repo",
            "orchestratorThreadId": "thoughts-lead",
            "lane": {"laneId": format!("lane-{id}"), "worktreePath": format!("/repo/wt-{id}"),
                "sessionKey": format!("session-{id}"), "lastEventLabel": format!("{id} event"),
                "lastEventAt": "2026-11-04T10:01:00Z"},
        });
        for (key, value) in extra.as_object().unwrap() {
            packet[key] = value.clone();
        }
        packet
    };
    let approval = |id: &str, text: &str| {
        json!({"statusEvidence": {"summary": "Approval pending.", "evidence": [
            {"source": "lane.status", "value": "blocked"},
            {"source": format!("approval:{id}"), "value": format!("pending · {text}")},
        ]}})
    };
    *http.state.lock().unwrap() = json!({"mission": {"packets": [
        packet("done", "released", json!({"releaseStatePayload": {"releasedAt": "2026-11-04T10:01:05Z"}})),
        packet("waiting", "blocked", approval("approval-1", "Run npm install in the worktree")),
        packet("asking", "blocked", approval("approval-2", "Delete the build folder")),
        packet("working", "running", json!({})),
    ]}});
    let lane = |id: &str, created: &str, extra: Value| {
        let mut lane = json!({"id": format!("lane-{id}"), "packetId": id, "status": "running",
            "ownership": "managed", "branch": format!("o8/{id}-work"),
            "worktreePath": format!("/repo/wt-{id}"), "createdAt": created});
        for (key, value) in extra.as_object().unwrap() {
            lane[key] = value.clone();
        }
        lane
    };
    *http.lanes.lock().unwrap() = json!({"lanes": [
        lane("done", "2026-11-04T10:00:00Z", json!({"status": "completed",
            "diffStat": {"files": 3, "insertions": 40, "deletions": 2}})),
        lane("waiting", "2026-11-04T10:00:10Z", json!({})),
        lane("asking", "2026-11-04T10:00:20Z", json!({})),
        lane("working", "2026-11-04T10:00:30Z", json!({})),
    ]});
}

/// A reopened app: the lead's settled transcript names its workers, and a new
/// inspector reads them back from the server; no live event has arrived.
fn restore<'a>(
    http: &Http,
    cx: &'a mut TestAppContext,
) -> (Entity<Roster>, &'a mut VisualTestContext) {
    let steps = ["done", "waiting", "asking", "working"]
        .into_iter()
        .map(|id| {
            let mut step = crate::activity::activity(
                id,
                &json!({"name":"delegate_task","status":"done","args":{"title":id}}),
                "",
            );
            step.delegations = vec![model::Reference {
                id: id.into(),
                title: id.into(),
            }];
            step
        })
        .collect();
    let state = Rc::new(RefCell::new(RowState::new(Row::Activity {
        id: "roster-test".into(),
        steps,
        trace: Trace::default(),
    })));
    let client = http.client.clone();
    let (view, visual) = cx.add_window_view(|_, cx| {
        state.borrow_mut().bind_subagent_focus(cx);
        let inspector = cx.new(|cx| {
            Inspector::new(
                client,
                Scope {
                    repo: "/repo".into(),
                    parent: Some("llm-chat:thoughts-lead".into()),
                },
                cx,
            )
        });
        state.borrow_mut().subagents = Some(inspector.clone());
        // What the conversation's binding does on every inspector change.
        let row = state.clone();
        let observe = cx.observe(&inspector, move |_, inspector, cx| {
            row.borrow_mut().subagent_agents = Rc::new(inspector.read(cx).agents.clone());
            row.borrow_mut().bind_subagent_focus(cx);
            cx.notify();
        });
        Roster {
            state,
            inspector,
            _observe: observe,
        }
    });
    visual.run_until_parked();
    paint(visual);
    (view, visual)
}

fn gets(http: &Http, path: &str) -> Vec<Value> {
    let line = format!("GET {path}");
    http.calls
        .lock()
        .unwrap()
        .iter()
        .filter(|(l, _)| *l == line)
        .map(|(_, q)| q.clone())
        .collect()
}

#[gpui::test]
fn roster_rebuilds_rows_states_and_clocks_from_server_state(cx: &mut TestAppContext) {
    let http = Http::new();
    seed(&http);
    let (view, cx) = restore(&http, cx);
    let rows = view.read_with(cx, |v, _| {
        let state = v.state.borrow();
        let Row::Activity { steps, trace, .. } = &state.row else {
            unreachable!()
        };
        items(steps, trace, &state.subagent_agents)
    });
    let shown: Vec<_> = rows.iter().map(|i| (i.id.as_str(), i.group)).collect();
    assert_eq!(
        shown,
        vec![
            ("done", Group::Done),
            ("waiting", Group::Attention),
            ("asking", Group::Attention),
            ("working", Group::Working),
        ]
    );
    for id in ["done", "waiting", "asking", "working"] {
        assert!(
            cx.debug_bounds(Box::leak(format!("subagent-roster-{id}").into_boxed_str()))
                .is_some(),
            "{id}"
        );
    }
    // The lane's creation is the start; the packet's release is the finish.
    let done = &rows[0];
    assert_eq!(elapsed(done, 0.).as_deref(), Some("1m 5s"));
    let started = crate::clock::timestamp("2026-11-04T10:00:30Z").unwrap() as f64 * 1000.;
    assert_eq!(
        rows[3].started,
        Some(started),
        "the working clock runs from the server's start"
    );
    assert!(elapsed(&rows[3], started + 26_000.).as_deref() == Some("26s"));
    // One lane read, naming only the finished lane for its diff stat; a
    // later refresh doesn't read the known lanes again.
    assert_eq!(
        gets(&http, "/api/lanes"),
        vec![json!("active=false&diffStat=lane-done")]
    );
    view.update(cx, |v, cx| v.inspector.update(cx, |i, cx| i.tick(true, cx)));
    cx.run_until_parked();
    assert_eq!(gets(&http, "/api/lanes").len(), 1);
    assert_eq!(gets(&http, "/api/orchestrator/state").len(), 2);
}

#[gpui::test]
fn roster_finished_rows_show_the_worktree_chip_and_diff_stat(cx: &mut TestAppContext) {
    let http = Http::new();
    seed(&http);
    let (view, cx) = restore(&http, cx);
    assert!(cx.debug_bounds("subagent-roster-worktree-done").is_some());
    assert!(cx.debug_bounds("subagent-roster-diff-done").is_some());
    assert!(
        cx.debug_bounds("subagent-roster-worktree-working")
            .is_none(),
        "only finished rows"
    );
    assert!(cx.debug_bounds("subagent-roster-diff-working").is_none());
    let done = view.read_with(cx, |v, _| {
        v.state
            .borrow()
            .subagent_agents
            .iter()
            .find(|a| a.id == "done")
            .cloned()
            .unwrap()
    });
    assert_eq!(chip(&done.facts).as_deref(), Some("o8/done-work"));
    assert_eq!(
        done.facts.diff.map(diff_stat).as_deref(),
        Some("3 files +40 -2")
    );
    let unbranched = model::Facts {
        worktree: Some("/repo/.o8/wt-folder/".into()),
        ..Default::default()
    };
    assert_eq!(chip(&unbranched).as_deref(), Some("wt-folder"));
    assert_eq!(
        diff_stat(model::DiffStat {
            files: 1,
            insertions: 0,
            deletions: 7
        }),
        "1 file +0 -7"
    );
}

#[gpui::test]
fn roster_approval_controls_answer_through_the_approval_decision(cx: &mut TestAppContext) {
    let http = Http::new();
    seed(&http);
    let (_view, cx) = restore(&http, cx);
    assert!(
        cx.debug_bounds("subagent-roster-approval-waiting")
            .is_some()
    );
    assert!(cx.debug_bounds("subagent-roster-approval-done").is_none());
    assert!(cx.debug_bounds("subagent-roster-approve-working").is_none());
    click(cx, "subagent-roster-approve-waiting");
    click(cx, "subagent-roster-approve-waiting"); // Disabled while it is answered.
    cx.run_until_parked();
    click(cx, "subagent-roster-deny-asking");
    cx.run_until_parked();
    paint(cx);
    assert_eq!(
        http.posts(),
        vec![
            (
                "POST /api/panel/approvals".into(),
                json!({"id":"approval-1","action":"approve"})
            ),
            (
                "POST /api/panel/approvals".into(),
                json!({"id":"approval-2","action":"reject"})
            ),
        ]
    );
    assert!(
        cx.debug_bounds("subagent-roster-approve-waiting").is_none(),
        "an answered approval leaves the row"
    );
    assert!(cx.debug_bounds("subagent-roster-deny-asking").is_none());
    assert!(cx.debug_bounds("subagent-roster-error").is_none());
}

#[gpui::test]
fn roster_hover_shows_details_after_its_delay(cx: &mut TestAppContext) {
    let http = Http::new();
    seed(&http);
    let (view, cx) = restore(&http, cx);
    let row = cx.debug_bounds("subagent-roster-done").unwrap();
    cx.simulate_mouse_move(row.center(), None, gpui::Modifiers::default());
    paint(cx);
    assert!(
        cx.debug_bounds("subagent-roster-details-done").is_none(),
        "not before 300 ms"
    );
    let since = view.read_with(cx, |v, _| {
        v.state.borrow().subagent_roster.borrow().hover.clone()
    });
    let (id, since) = since.expect("the row records the hover");
    assert_eq!(id, "done");
    view.update(cx, |v, _| {
        v.state.borrow().subagent_roster.borrow_mut().hover =
            Some((id, since - actions::HOVER_DELAY_MS));
    });
    paint(cx);
    assert!(cx.debug_bounds("subagent-roster-details-done").is_some());
    let away = cx.debug_bounds("subagent-trace-summary").unwrap();
    cx.simulate_mouse_move(away.center(), None, gpui::Modifiers::default());
    paint(cx);
    assert!(cx.debug_bounds("subagent-roster-details-done").is_none());
}

#[test]
fn hover_model_waits_300ms_and_follows_the_pointer() {
    let mut controls = Controls::default();
    controls.hover("a", true, 1_000.);
    assert!(!controls.shown("a", 1_299.) && controls.waiting(1_299.));
    assert!(controls.shown("a", 1_300.) && !controls.waiting(1_300.));
    controls.hover("a", true, 1_250.); // Still on the same row: the clock holds.
    assert!(controls.shown("a", 1_300.));
    controls.hover("b", true, 2_000.);
    assert!(!controls.shown("a", 9_000.) && !controls.shown("b", 2_100.));
    controls.hover("a", false, 2_200.); // Leaving another row changes nothing.
    assert!(controls.shown("b", 2_300.));
    controls.hover("b", false, 2_400.);
    assert!(!controls.shown("b", 9_000.) && !controls.waiting(9_000.));
}

#[test]
fn the_details_card_names_provider_model_times_worktree_and_recent_activity() {
    let now = 1_000_000_000.;
    let item = Item {
        id: "a".into(),
        title: "a".into(),
        group: Group::Working,
        failed: false,
        activity: None,
        started: Some(now - 125_000.),
        finished: None,
        runtime: "codex".into(),
        model: Some("gpt-5.5".into()),
        facts: model::Facts {
            worktree: Some("/repo/wt-a".into()),
            last_event: Some("Edited a.rs".into()),
            last_event_at: Some(now - 10_000.),
            recent: vec!["Reading".into(), "Editing".into(), "Testing".into()],
            ..Default::default()
        },
        stop: None,
        cleanup: None,
    };
    assert_eq!(
        details(&item, now),
        [
            "Provider: codex",
            "Model: gpt-5.5",
            "Started: 2m ago",
            "Last event: Edited a.rs · just now",
            "Worktree: /repo/wt-a",
            "· Reading",
            "· Editing",
            "· Testing",
        ]
    );
}

#[test]
fn a_refresh_keeps_the_last_three_reports_and_the_lane_facts() {
    let mut old = packet("a", "running", true);
    old.facts.recent = vec!["one".into(), "two".into(), "three".into()];
    let mut fresh = vec![packet("a", "running", true)];
    fresh[0].progress = Some("four\nmore".into());
    let lanes = std::collections::HashMap::from([(
        "lane-a".to_owned(),
        model::Lane {
            branch: Some("o8/a".into()),
            created: Some(5.),
            ..Default::default()
        },
    )]);
    model::carry(std::slice::from_ref(&old), &mut fresh, &lanes);
    assert_eq!(fresh[0].facts.recent, ["two", "three", "four"]);
    assert_eq!(fresh[0].facts.branch.as_deref(), Some("o8/a"));
    assert_eq!(fresh[0].facts.worktree.as_deref(), Some("/repo/wt-a"));
    assert_eq!(fresh[0].started, Some(5.));
    let again = fresh.clone();
    model::carry(&again, &mut fresh, &lanes);
    assert_eq!(
        fresh[0].facts.recent,
        ["two", "three", "four"],
        "a repeated report isn't added twice"
    );
}
