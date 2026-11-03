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
        let (seen, failure, end) = (calls.clone(), fail.clone(), done.clone());
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
                seen.lock().unwrap().push((
                    format!("{} {path}", first.split_whitespace().next().unwrap()),
                    body,
                ));
                let failed = first.starts_with("POST") && failure.load(Ordering::Acquire);
                let body = match path {
                    "/api/panel/ws-info" => json!({"wsPort":ws_port,"wsToken":"fixture"}),
                    "/api/orchestrator/state" => json!({"mission":{"packets":[]}}),
                    "/api/orchestrator/shared-team/active" => json!({"threadId":"thoughts-lead","workers":[]}),
                    "/api/v2/chat-history" => json!({"backend":"pi"}),
                    "/api/lanes" if first.starts_with("GET") => json!({"lanes":[{
                        "id":"lane-done", "packetId":"done", "status":"completed", "ownership":"managed", "worktreePath":"/repo/wt-done"
                    }]}),
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
