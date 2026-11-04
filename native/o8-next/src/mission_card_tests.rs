use super::*;
use crate::{
    model::{Entry, Row, render_tree},
    retained::{RetainedRow, RowState},
};
use gpui::{
    Context, ListAlignment, ListState, Modifiers, Render, TestAppContext, VisualTestContext,
};
use std::{
    io::{Read, Write},
    net::TcpListener,
    thread::{self, JoinHandle},
};

const CARD_ID: &str = "tart-00000000-0000-4000-8000-000000000001";

fn card(state: &str, summary: Option<&str>) -> Value {
    json!({
        "id": CARD_ID, "title": "Merge cards packet?", "createdAt": "2026-11-04T10:00:00.000Z",
        "kind": "approve", "body": "Tests are green.",
        "actions": [
            {"id":"approve","label":"Approve","style":"primary","confirm":"hold"},
            {"id":"deny","label":"Deny","style":"danger"}
        ],
        "entityIds": ["packet:pkt-1"], "expiresAt": "2026-11-05T10:00:00.000Z",
        "state": state, "reason": null, "receipt": null, "summary": summary,
    })
}

fn entries(card: Value) -> Vec<Entry> {
    serde_json::from_value(json!([
        {"id":"u1","role":"user","text":"ship it","timestamp":1},
        {"id":"a1","role":"assistant","text":"The packet is ready.","timestamp":2},
        {"id":format!("card-{CARD_ID}"),"role":"assistant","text":"Merge cards packet?","type":"card","card":card,"timestamp":3},
    ]))
    .unwrap()
}

fn card_row(card: Value) -> Row {
    render_tree(&entries(card)).pop().unwrap()
}

/// Answers one decision POST with a fixed body and reports the received request.
struct Server {
    client: Client,
    request: mpsc::Receiver<String>,
    join: Option<JoinHandle<()>>,
}
impl Server {
    fn reply(status: &str, body: Value) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client =
            Client::authenticated(&format!("http://{}", listener.local_addr().unwrap()), None)
                .unwrap();
        let (send, request) = mpsc::channel();
        let status = status.to_owned();
        let join = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_millis(500)))
                .unwrap();
            let mut received = Vec::new();
            let mut bytes = [0; 8192];
            // Read headers and body until the client pauses.
            while let Ok(count) = socket.read(&mut bytes) {
                if count == 0 {
                    break;
                }
                received.extend_from_slice(&bytes[..count]);
                let text = String::from_utf8_lossy(&received);
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if body.len() >= length {
                        break;
                    }
                }
            }
            let _ = send.send(String::from_utf8_lossy(&received).into_owned());
            let body = body.to_string();
            let _ = write!(
                socket,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        });
        Self {
            client,
            request,
            join: Some(join),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

struct CardRow {
    state: Rc<RefCell<RowState>>,
    list: ListState,
}
impl Render for CardRow {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(
            RetainedRow {
                state: self.state.clone(),
                index: 0,
                painted: Default::default(),
            }
            .interactive(&self.list),
        )
    }
}

fn mount(cx: &mut TestAppContext, state: Rc<RefCell<RowState>>) -> &mut VisualTestContext {
    let (_, cx) = cx.add_window_view(|_, _| CardRow {
        state,
        list: ListState::new(1, ListAlignment::Top, px(100.)),
    });
    redraw(cx);
    cx
}

fn redraw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}

/// Poll the row like the transcript tick does, until the decision reply lands.
fn settle(state: &Rc<RefCell<RowState>>) {
    let until = Instant::now() + Duration::from_secs(10);
    while !state.borrow_mut().poll_visualizations() {
        assert!(Instant::now() < until, "decision reply never arrived");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_card_history_entry_becomes_a_card_row_where_it_landed() {
    let rows = render_tree(&entries(card("open", None)));
    assert_eq!(rows.len(), 3);
    assert!(
        matches!(&rows[2], Row::Card { id, card } if id == &format!("card-{CARD_ID}") && card["kind"] == "approve")
    );
    // A card entry without its state stays the generic notice, never a blank card.
    let bare: Vec<Entry> = serde_json::from_value(json!([
        {"id":"c","role":"assistant","text":"Merge?","type":"card"}
    ]))
    .unwrap();
    assert!(matches!(&render_tree(&bare)[0], Row::Message { .. }));
}

#[gpui::test]
fn an_open_card_holds_to_approve_posts_the_decision_and_dissolves_into_a_receipt(
    cx: &mut TestAppContext,
) {
    let summary = "Approve · Merge cards packet? · by operator at 10:01 UTC";
    let server = Server::reply(
        "200 OK",
        json!({"ok":true,"result":{"accepted":true,"deliverVia":"queue",
            "action":{"id":"tact-1","delivery":"delivered"},"card":card("decided", Some(summary))}}),
    );
    let routing = json!({"backend":"codex","model":"gpt-5.5","effort":"medium","permissionMode":"full","mode":"fleet","pickedMode":"fast","collide":false});
    let mut row = RowState::new(card_row(card("open", None)));
    row.attach_mission_card(&server.client, Some(routing.clone()));
    let state = Rc::new(RefCell::new(row));
    let cx = mount(cx, state.clone());

    assert!(
        cx.debug_bounds("mission-card-0").is_some(),
        "the open card draws inline"
    );
    assert!(cx.debug_bounds("mission-card-receipt-0").is_none());
    let deny = cx
        .debug_bounds("mission-card-action-deny")
        .expect("deny button");
    let approve = cx
        .debug_bounds("mission-card-action-approve")
        .expect("approve button");
    assert!(
        deny.left() > approve.left(),
        "actions keep their declared order"
    );

    // A tap on a hold action decides nothing.
    cx.simulate_mouse_down(approve.center(), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(approve.center(), MouseButton::Left, Modifiers::default());
    let sent = |state: &Rc<RefCell<RowState>>| {
        state
            .borrow()
            .mission_card
            .as_ref()
            .unwrap()
            .borrow()
            .sent
            .clone()
    };
    assert!(sent(&state).is_empty(), "a short press must not approve");

    cx.simulate_mouse_down(approve.center(), MouseButton::Left, Modifiers::default());
    redraw(cx);
    thread::sleep(HOLD + Duration::from_millis(50));
    cx.simulate_mouse_up(approve.center(), MouseButton::Left, Modifiers::default());
    let bodies = sent(&state);
    assert_eq!(bodies.len(), 1);
    assert_eq!(bodies[0]["actionId"], "approve");
    assert_eq!(bodies[0]["entityIds"], json!(["packet:pkt-1"]));
    assert_eq!(bodies[0]["routing"], routing);

    let request = server
        .request
        .recv_timeout(Duration::from_secs(10))
        .unwrap();
    assert!(
        request.starts_with(&format!("POST /api/task-artifacts/{CARD_ID}/decision ")),
        "{request}"
    );
    assert!(request.contains("\"actionId\":\"approve\""));

    settle(&state);
    redraw(cx);
    assert!(
        cx.debug_bounds("mission-card-0").is_none(),
        "the card dissolves"
    );
    assert!(cx.debug_bounds("mission-card-receipt-0").is_some());
    let shown = state
        .borrow()
        .mission_card
        .as_ref()
        .unwrap()
        .borrow()
        .view(&json!({}));
    assert_eq!(receipt_line(&shown), summary);
}

#[gpui::test]
fn a_refused_decision_keeps_the_server_state_and_says_why(cx: &mut TestAppContext) {
    let summary = "Expired · Merge cards packet? · no decision by 10:00 UTC";
    let server = Server::reply(
        "422 Unprocessable Entity",
        json!({"ok":false,"error":{"code":"read_only","message":"The card expired without a decision."},
            "result":{"accepted":false,"card":card("expired", Some(summary))}}),
    );
    let mut row = RowState::new(card_row(card("open", None)));
    row.attach_mission_card(&server.client, None);
    let state = Rc::new(RefCell::new(row));
    let cx = mount(cx, state.clone());
    let deny = cx.debug_bounds("mission-card-action-deny").unwrap();
    cx.simulate_click(deny.center(), Modifiers::default());
    settle(&state);
    redraw(cx);
    let card_state = state.borrow().mission_card.clone().unwrap();
    assert_eq!(
        card_state.borrow().error.as_deref(),
        Some("The card expired without a decision.")
    );
    assert!(cx.debug_bounds("mission-card-receipt-0").is_some());
}

#[gpui::test]
fn a_reloaded_decided_card_rebuilds_its_receipt_from_the_server_row(cx: &mut TestAppContext) {
    let summary = "Deny · Merge cards packet? · by device at 10:02 UTC";
    // No client is attached: a reload draws from the history entry alone.
    let state = Rc::new(RefCell::new(RowState::new(card_row(card(
        "decided",
        Some(summary),
    )))));
    let cx = mount(cx, state.clone());
    assert!(cx.debug_bounds("mission-card-0").is_none());
    assert!(cx.debug_bounds("mission-card-receipt-0").is_some());
    let Row::Card { card, .. } = &state.borrow().row else {
        panic!("card row");
    };
    assert_eq!(receipt_line(card), summary);
}
