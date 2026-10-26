use super::*;
use gpui::TestAppContext;
use std::{
    io::{BufRead, BufReader},
    process::{Child, Stdio},
};

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = Command::new("kill")
            .args(["-TERM", &self.0.id().to_string()])
            .status();
        let _ = self.0.wait();
    }
}
fn fixture() -> (Server, Client) {
    fixture_mode(false)
}
fn fixture_mode(worker: bool) -> (Server, Client) {
    fixture_options(worker, false)
}
fn fixture_options(worker: bool, empty: bool) -> (Server, Client) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut command = Command::new("node");
    command.current_dir(root).args([
        "--import",
        "./scripts/register-server-only-stub.mjs",
        "--import",
        "tsx",
        "scripts/next/dev-server.ts",
        "--composer",
    ]);
    if worker {
        command.arg("--worker");
    }
    if empty {
        command.arg("--composer-empty");
    }
    let mut child = command
        .env("O8_NEXT_API_TOKEN", "fixture-operator-bearer")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("fixture host");
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let origin = lines
        .find_map(|line| {
            serde_json::from_str::<Value>(&line.ok()?).ok()?["origin"]
                .as_str()
                .map(str::to_owned)
        })
        .expect("fixture origin");
    let anonymous = Client::authenticated(&origin, None).unwrap();
    assert_eq!(
        anonymous.sessions().unwrap_err(),
        "Server returned HTTP 401"
    );
    let client = Client::authenticated(&origin, Some("fixture-operator-bearer".into())).unwrap();
    let sessions = client.sessions().unwrap();
    let session = sessions
        .iter()
        .find(|s| s.id == "thoughts-composer-first")
        .unwrap();
    let body = json!({"repoPath":session.repo_path,"threadId":session.id,"id":"fixture-denied"});
    let invalid = Client::authenticated(&origin, Some("fixture-invalid-bearer".into())).unwrap();
    for method in ["POST", "PATCH", "DELETE"] {
        for denied in [&anonymous, &invalid] {
            assert_eq!(
                denied.mutate_queue(method, &body).unwrap_err().message,
                "Queue rejected the request (HTTP 401). Draft retained."
            );
        }
    }
    (Server(child), client)
}

#[path = "worker_tests.rs"]
mod worker_tests;

#[gpui::test]
fn session_chrome_uses_layout_instead_of_role_labels(cx: &mut TestAppContext) {
    let (_server, client) = fixture();
    let saved = client.clone();
    let (surface, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    surface.update(cx, |s, cx| {
        s.sessions = saved.sessions().unwrap();
        s.select("thoughts-tools".into(), cx);
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
        window.refresh();
        window.draw(cx).clear();
    });
    surface.read_with(cx, |s, _| {
        let (_, lines) = s.rows[0].borrow().rendered();
        assert!(
            !lines
                .iter()
                .any(|line| ["Operator", "Agent", "Work details"].contains(&line.as_str())),
            "message identity must use layout, not a secondary label: {lines:?}"
        );
    });
}

#[gpui::test]
fn correction_empty_conversation_has_no_tagline(cx: &mut TestAppContext) {
    let (_server, client) = fixture_options(false, true);
    let saved = client.clone();
    let (surface, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    surface.update(cx, |s, cx| {
        s.sessions = saved.sessions().unwrap();
        s.select("thoughts-composer-first".into(), cx);
    });
    cx.run_until_parked();
    for (width, height) in [(900., 700.), (1680., 1050.)] {
        cx.simulate_resize(size(px(width), px(height)));
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        assert!(surface.read_with(cx, |s, _| s.transcript.is_some() && s.rows.is_empty()));
        assert!(cx.debug_bounds("composer-card").is_some());
        assert!(
            cx.debug_bounds("session-empty").is_none(),
            "empty conversations must not render a build tagline at {width}x{height}"
        );
    }
}

#[gpui::test]
fn correction_composer_has_no_shortcut_or_mode_helper(cx: &mut TestAppContext) {
    let (_server, client) = fixture_options(false, true);
    let saved = client.clone();
    let (surface, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    surface.update(cx, |s, cx| {
        s.sessions = saved.sessions().unwrap();
        s.select("thoughts-composer-first".into(), cx);
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    assert!(
        cx.debug_bounds("composer-shortcuts").is_none(),
        "composer must not render a permanent shortcut hint"
    );
    for helper in ["Queued for after this turn", "Steers the running turn"] {
        assert!(
            cx.debug_bounds(helper).is_none(),
            "composer must use action labels instead of mode helper text: {helper}"
        );
    }
    assert!(
        cx.debug_bounds("send-mode-steer").is_some()
            || cx.debug_bounds("send-mode-queue").is_some(),
        "mode selection remains available without helper text"
    );
}

#[gpui::test]
fn placement_empty_state_composer_and_right_panel(cx: &mut TestAppContext) {
    let (_server, client) = fixture_options(false, true);
    let saved = client.clone();
    let (surface, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    surface.update(cx, |s, cx| {
        s.sessions = saved.sessions().unwrap();
        s.select("thoughts-composer-first".into(), cx);
    });
    cx.run_until_parked();
    let mut layouts = vec![];
    for (width, height) in [(900., 700.), (1680., 1050.)] {
        cx.simulate_resize(size(px(width), px(height)));
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
            window.refresh();
            window.draw(cx).clear();
        });
        let column = cx.debug_bounds("conversation-column").unwrap();
        let card = cx.debug_bounds("composer-card").expect("composer card");
        let sidebar = cx.debug_bounds("session-sidebar").expect("left sidebar");
        let space = cx.debug_bounds("composer-space").unwrap();
        assert!((space.center().y - card.center().y).abs() < px(1.));
        assert!((column.center().x - card.center().x).abs() < px(1.));
        assert!(card.left() > sidebar.right());
        assert!(card.size.width <= px(720.));
        assert!(card.right() <= px(width));
        cx.simulate_keystrokes("ctrl-e");
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
            window.refresh();
            window.draw(cx).clear();
        });
        let right = cx
            .debug_bounds("right-panel-slot")
            .expect("existing Brain uses the right slot");
        let card = cx.debug_bounds("composer-card").unwrap();
        assert!(right.left() >= card.right());
        let send = cx.debug_bounds("send").unwrap();
        assert!(
            send.right() <= card.right(),
            "composer controls must fit beside the right panel"
        );
        assert!(right.right() <= px(width));
        assert!(right.size.height > card.size.height);
        layouts.push(json!({"viewport":[width,height], "composer":[f32::from(card.origin.x),f32::from(card.origin.y),f32::from(card.size.width),f32::from(card.size.height)],"rightPanel":[f32::from(right.origin.x),f32::from(right.origin.y),f32::from(right.size.width),f32::from(right.size.height)]}));
        cx.simulate_keystrokes("escape");
    }
    if let Ok(file) = std::env::var("O8_NEXT_PLACEMENT_EVIDENCE") {
        std::fs::write(file, serde_json::to_vec_pretty(&json!({"endpoint":"headless production GPUI layout; no raster or compositor capture","layouts":layouts})).unwrap()).unwrap();
    }
}

#[gpui::test]
fn placement_empty_send_racing_selection_retains_the_destination(cx: &mut TestAppContext) {
    let (_server, client) = fixture_options(false, true);
    let saved = client.clone();
    let (surface, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    surface.update(cx, |s, cx| {
        s.sessions = saved.sessions().unwrap();
        s.select("thoughts-composer-first".into(), cx);
    });
    cx.run_until_parked();
    surface.update(cx, |s, cx| {
        s.composer
            .update(cx, |input, cx| input.set_text("First prompt", cx));
        s.send(None, cx);
        s.select("thoughts-composer-second".into(), cx);
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.selected.as_deref(), Some("thoughts-composer-second"));
        assert!(s.rows.is_empty());
        assert!(s.composer.read(cx).text.is_empty());
    });
    let first = saved
        .sessions()
        .unwrap()
        .into_iter()
        .find(|s| s.id == "thoughts-composer-first")
        .unwrap();
    assert!(
        saved.queue(&first).unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["payload"]["text"] == "First prompt")
    );
}

#[gpui::test]
fn fixture_send_selected_queue_promote_and_echo(cx: &mut TestAppContext) {
    let (_server, client) = fixture();
    let saved = client.clone();
    let (surface, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    surface.update(cx, |s, cx| {
        s.sessions = saved.sessions().unwrap();
        s.select("thoughts-composer-first".into(), cx);
    });
    cx.run_until_parked();
    assert!(
        surface.read_with(cx, |s, _| s.queue_ready),
        "real HTTP session context must load"
    );
    surface.update_in(cx, |s, window, cx| s.composer.read(cx).focus.focus(window));
    // Same endpoint as the existing evidence harness: dispatched key through CPU
    // scene paint, with the editor revision acknowledged by its paint callback.
    let mut keys = vec![];
    for _ in 0..20 {
        let start = Instant::now();
        cx.simulate_input("a");
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
            window.refresh();
            window.draw(cx).clear();
        });
        keys.push(start.elapsed().as_secs_f64() * 1000.);
        surface.read_with(cx, |s, cx| {
            assert_eq!(s.composer.read(cx).revision, s.composer.read(cx).painted)
        });
    }
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("Steer selected session");
    let retained = surface.read_with(cx, |s, _| s.rows[0].clone());
    let layouts = retained.borrow().layouts;
    surface.update(cx, |s, _| s.transcript.as_mut().unwrap().seq = 42);
    let start = Instant::now();
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    let echo = start.elapsed().as_secs_f64() * 1000.;
    let first = surface.read_with(cx, |s, _| s.queue["items"][0].clone());
    assert!(
        !first.is_null(),
        "{}",
        surface.read_with(cx, |s, _| s.notice.clone())
    );
    assert_eq!(first["intent"], "steer-now");
    assert_eq!(first["threadId"], "thoughts-composer-first");
    assert_eq!(
        saved
            .history("thoughts-composer-first")
            .unwrap()
            .transcript
            .last()
            .unwrap()
            .text,
        "Steer selected session"
    );
    assert!(
        surface.read_with(cx, |s, _| s.rows.len() == 2),
        "first persisted echo must reach the view before timing ends"
    );
    surface.read_with(cx, |s, _| {
        assert!(Rc::ptr_eq(&retained, &s.rows[0]));
        assert_eq!(
            retained.borrow().layouts,
            layouts,
            "completed row layouts survive a send echo"
        );
        assert_eq!(
            s.transcript.as_ref().unwrap().seq,
            42,
            "HTTP echo must not advance the WebSocket sequence fence"
        );
    });
    assert_eq!(first["payload"]["routing"]["permissionMode"], "plan");
    assert!(surface.read_with(cx, |s, cx| s.composer.read(cx).text.is_empty()));
    // Switching sessions must not steer or enqueue in the previous destination.
    surface.update(cx, |s, cx| s.select("thoughts-composer-second".into(), cx));
    cx.run_until_parked();
    surface.update_in(cx, |s, window, cx| {
        s.send_next = true;
        s.composer.read(cx).focus.focus(window);
    });
    cx.simulate_input("Queue this\nsecond line");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    let queued = surface.read_with(cx, |s, _| s.queue["items"][0].clone());
    assert_eq!(queued["intent"], "send-next");
    assert_eq!(queued["payload"]["text"], "Queue this\nsecond line");
    let second = surface.read_with(cx, |s, _| {
        s.sessions
            .iter()
            .find(|s| s.id == "thoughts-composer-second")
            .unwrap()
            .clone()
    });
    assert_eq!(
        saved.queue(&second).unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        saved.history(&second.id).unwrap().transcript.len(),
        1,
        "queue is not a delivery claim"
    );
    let steer = cx
        .debug_bounds("steer-now")
        .expect("queued item renders its steer action");
    cx.simulate_click(steer.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    surface.update(cx, |s, cx| s.reconcile(cx));
    cx.run_until_parked();
    let promoted = saved.queue(&second).unwrap()["items"][0].clone();
    assert_eq!(promoted["id"], queued["id"]);
    assert_eq!(promoted["payload"], queued["payload"]);
    assert_eq!(promoted["status"], "applied");
    let history = saved.history(&second.id).unwrap();
    assert_eq!(
        history.transcript.last().unwrap().text,
        "Queue this\nsecond line"
    );
    assert!(surface.read_with(cx, |s, _| s.rows.len() > 1));
    // Persisted acceptance followed by a lost response must retain the draft and
    // retry the same id, never manufacture another operator message.
    surface.update_in(cx, |s, window, cx| {
        s.send_next = false;
        s.composer.read(cx).focus.focus(window);
    });
    cx.simulate_input("Fixture lose response");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert_eq!(
        surface.read_with(cx, |s, cx| s.composer.read(cx).text.clone()),
        "Fixture lose response"
    );
    let pending = surface.read_with(cx, |s, _| s.pending[&second.id].clone());
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert!(surface.read_with(cx, |s, cx| s.composer.read(cx).text.is_empty()));
    let items = saved.queue(&second).unwrap()["items"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(items.iter().filter(|i| i["id"] == pending["id"]).count(), 1);
    assert_eq!(
        saved
            .history(&second.id)
            .unwrap()
            .transcript
            .iter()
            .filter(|e| e.text == "Fixture lose response")
            .count(),
        1
    );
    // A first explicit validation rejection is definite nonacceptance. Keep the
    // draft, but allow a corrected send rather than freezing an invalid request.
    surface.update(cx, |s, _| s.routing.as_mut().unwrap()["model"] = json!(""));
    cx.simulate_input("Rejected draft");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert_eq!(
        surface.read_with(cx, |s, cx| s.composer.read(cx).text.clone()),
        "Rejected draft"
    );
    assert!(
        surface.read_with(cx, |s, _| !s.pending.contains_key(&second.id)),
        "first HTTP rejection retires only the unaccepted identity"
    );
    surface.update(cx, |s, _| {
        s.routing.as_mut().unwrap()["model"] = json!("pi")
    });
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("Corrected draft");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert!(surface.read_with(cx, |s, cx| s.composer.read(cx).text.is_empty()));
    surface.update(cx, |s, cx| s.select("thoughts-composer-legacy".into(), cx));
    cx.run_until_parked();
    assert_eq!(
        surface.read_with(cx, |s, _| s.rows.len()),
        1,
        "legacy history remains readable without composer routing"
    );
    assert!(!surface.read_with(cx, |s, _| s.queue_ready));
    // Server persistence, not an optimistic local label, supplies the first echo.
    println!(
        "O8_NEXT_COMPOSER_EVIDENCE {}",
        json!({"endpoint":"GPUI TestAppContext CPU scene paint; no GPU submission or presentation",
        "keyToFrameMs":keys,"sendToFirstEchoMs":echo,"queueBefore":0,"queueAfter":1,"transcriptBefore":1,"transcriptAfter":history.transcript.len()})
    );
}

#[path = "brain_dock_tests.rs"]
mod brain_dock_tests;
