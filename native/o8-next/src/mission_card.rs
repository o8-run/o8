//! Mission cards (#5468) in the native transcript.
//!
//! The server sends a card as a history entry (`type: "card"`) carrying its
//! derived state. An open card draws inline in the current theme with its
//! typed actions; a `hold` action needs a press held for `HOLD`. The decision
//! posts `card.decision` to the task artifact decision route, which records
//! the receipt and delivers it to the lead (with this chat's routing, on the
//! composer queue) or to the packet's steer path. A decided or expired card
//! dissolves into its one-line receipt, which a reload rebuilds from the
//! server alone.
use crate::{client::Client, retained::RowState, theme::current as theme};
use gpui::{
    AnyElement, InteractiveElement, IntoElement, MouseButton, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px,
};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    rc::Rc,
    sync::mpsc,
    time::{Duration, Instant},
};

/// Matches the server's `MISSION_CARD_HOLD_MS`.
pub const HOLD: Duration = Duration::from_millis(600);

/// What one card row owns beyond the server's view: the decision in flight,
/// the newest view a decision returned, and a press being held.
pub struct CardState {
    client: Client,
    routing: Option<Value>,
    pending: Option<mpsc::Receiver<Result<Value, String>>>,
    /// The card view the last decision reply carried; newer than the row's.
    pub latest: Option<Value>,
    pub error: Option<String>,
    pub holding: Option<(String, Instant)>,
    /// The bodies this card posted, for tests.
    #[cfg(test)]
    pub sent: Vec<Value>,
}

impl CardState {
    pub fn new(client: Client, routing: Option<Value>) -> Self {
        Self {
            client,
            routing,
            pending: None,
            latest: None,
            error: None,
            holding: None,
            #[cfg(test)]
            sent: vec![],
        }
    }
    pub fn set_routing(&mut self, routing: Option<Value>) {
        self.routing = routing;
    }
    pub fn sending(&self) -> bool {
        self.pending.is_some()
    }
    /// Post `card.decision` once; the reply arrives through `poll`.
    pub fn decide(&mut self, card: &Value, action: &str) {
        if self.pending.is_some() || card["state"] != "open" {
            return;
        }
        let Some(id) = card["id"].as_str().map(str::to_owned) else {
            return;
        };
        let mut body = json!({
            "actionId": action,
            "entityIds": card["entityIds"].clone(),
            "nonce": format!("native-{}", uuid_like()),
        });
        if let Some(routing) = &self.routing {
            body["routing"] = routing.clone();
        }
        #[cfg(test)]
        self.sent.push(body.clone());
        self.error = None;
        let client = self.client.clone();
        let (send, receive) = mpsc::channel();
        self.pending = Some(receive);
        std::thread::spawn(move || {
            let _ = send.send(client.card_decision(&id, &body));
            client.wake();
        });
    }
    /// Take a finished decision reply. True when the card must redraw.
    pub fn poll(&mut self) -> bool {
        let Some(receive) = &self.pending else {
            return false;
        };
        let reply = match receive.try_recv() {
            Ok(reply) => reply,
            Err(mpsc::TryRecvError::Empty) => return false,
            Err(mpsc::TryRecvError::Disconnected) => Err("The decision was interrupted.".into()),
        };
        self.pending = None;
        match reply {
            Ok(body) => {
                if body["result"]["card"].is_object() {
                    self.latest = Some(body["result"]["card"].clone());
                }
                if body["ok"] != true {
                    self.error = Some(
                        body["error"]["message"]
                            .as_str()
                            .unwrap_or("The decision was refused.")
                            .to_owned(),
                    );
                } else if body["result"]["deliverVia"] == "thread" {
                    // Without a routing snapshot the lead hears it on the next turn sent here.
                    self.error = Some(
                        "Decision recorded. Send a message in this chat to deliver it to the lead."
                            .into(),
                    );
                }
            }
            Err(error) => self.error = Some(error),
        }
        true
    }
    /// The view to draw: a settled decision reply, else the server row, which
    /// a reload refreshes (an open reply never hides a later server state).
    pub fn view(&self, row: &Value) -> Value {
        self.latest
            .clone()
            .filter(|card| card["state"] != "open")
            .unwrap_or_else(|| row.clone())
    }
}

fn uuid_like() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("{nanos:x}-{:x}", std::process::id())
}

impl Client {
    /// The card decision route owns principal checks, liveness and delivery.
    /// A refusal (HTTP 422) still carries the card's current state.
    pub fn card_decision(&self, id: &str, body: &Value) -> Result<Value, String> {
        let url = self
            .url(&format!("/api/task-artifacts/{id}/decision"))
            .map_err(|_| "Invalid card id")?;
        match self.request("POST", &url).send_json(body.clone()) {
            Ok(response) => Self::read(response),
            Err(ureq::Error::Status(status, response)) => Self::read::<Value>(response)
                .map_err(|_| format!("Decision refused (HTTP {status})")),
            Err(_) => Err(
                "Decision unconfirmed. Reopen the chat to read the card's recorded state.".into(),
            ),
        }
    }
}

/// The one line a dissolved card leaves: what was decided, by whom, when.
pub fn receipt_line(card: &Value) -> String {
    card["summary"]
        .as_str()
        .or(card["title"].as_str())
        .unwrap_or("Card")
        .to_owned()
}

fn label(action: &Value, holding: bool) -> String {
    let text = action["label"].as_str().unwrap_or("Choose");
    if action["confirm"] == "hold" {
        if holding {
            format!("Keep holding to {}", text.to_lowercase())
        } else {
            format!("Hold to {}", text.to_lowercase())
        }
    } else {
        text.to_owned()
    }
}

pub fn element(state: Rc<RefCell<RowState>>, index: usize, list: &gpui::ListState) -> AnyElement {
    let (row_card, card_state) = {
        let state = state.borrow();
        let crate::model::Row::Card { card, .. } = &state.row else {
            return div().into_any_element();
        };
        (card.clone(), state.mission_card.clone())
    };
    let card = card_state
        .as_ref()
        .map_or(row_card.clone(), |s| s.borrow().view(&row_card));
    let id: SharedString = card["id"].as_str().unwrap_or("card").to_owned().into();
    if card["state"] != "open" {
        return div()
            .id(("mission-card-receipt", index))
            .debug_selector(move || format!("mission-card-receipt-{index}"))
            .px(px(16.))
            .py(px(4.))
            .text_size(px(12.))
            .text_color(theme().text_muted)
            .child(receipt_line(&card))
            .into_any_element();
    }
    let (sending, error, holding) = card_state.as_ref().map_or((false, None, None), |s| {
        let s = s.borrow();
        (
            s.sending(),
            s.error.clone(),
            s.holding.as_ref().map(|(a, _)| a.clone()),
        )
    });
    let refresh = {
        let list = list.clone();
        move |window: &mut Window| {
            list.splice(index..index + 1, 1);
            window.refresh();
        }
    };
    let mut actions = div().flex().flex_wrap().gap(px(6.)).mt(px(10.));
    for action in card["actions"].as_array().cloned().unwrap_or_default() {
        let action_id = action["id"].as_str().unwrap_or_default().to_owned();
        let hold = action["confirm"] == "hold";
        let style = action["style"].as_str().unwrap_or("default").to_owned();
        let held = holding.as_deref() == Some(action_id.as_str());
        let (border, background, color) = match style.as_str() {
            "primary" => (theme().accent, theme().accent, theme().background),
            "danger" => (theme().danger, theme().surface, theme().danger),
            _ => (theme().border, theme().surface, theme().text),
        };
        let selector = format!("mission-card-action-{action_id}");
        let mut button = div()
            .id(SharedString::from(format!("{id}:{action_id}")))
            .debug_selector(move || selector.clone())
            .h(px(26.))
            .px(px(10.))
            .flex()
            .items_center()
            .rounded(px(6.))
            .border_1()
            .border_color(border)
            .bg(if held { theme().hover } else { background })
            .text_size(px(12.))
            .text_color(if held { theme().text } else { color })
            .when(!sending, |b| b.cursor_pointer())
            .child(label(&action, held));
        if let Some(card_state) = card_state.clone() {
            let card = card.clone();
            if hold {
                let down = card_state.clone();
                let down_id = action_id.clone();
                let down_refresh = refresh.clone();
                let up_id = action_id.clone();
                let up_refresh = refresh.clone();
                let out = card_state.clone();
                let out_refresh = refresh.clone();
                button = button
                    .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                        down.borrow_mut().holding = Some((down_id.clone(), Instant::now()));
                        down_refresh(window);
                        cx.stop_propagation();
                    })
                    .on_mouse_up(MouseButton::Left, move |_, window, cx| {
                        let mut state = card_state.borrow_mut();
                        let held = state.holding.take();
                        if held.is_some_and(|(a, at)| a == up_id && at.elapsed() >= HOLD) {
                            state.decide(&card, &up_id);
                        }
                        drop(state);
                        up_refresh(window);
                        cx.stop_propagation();
                    })
                    .on_mouse_up_out(MouseButton::Left, move |_, window, _| {
                        if out.borrow_mut().holding.take().is_some() {
                            out_refresh(window);
                        }
                    });
            } else {
                let click_refresh = refresh.clone();
                let click_id = action_id.clone();
                button = button.on_click(move |_, window, cx| {
                    card_state.borrow_mut().decide(&card, &click_id);
                    click_refresh(window);
                    cx.stop_propagation();
                });
            }
        }
        actions = actions.child(button);
    }
    let entities = card["entityIds"]
        .as_array()
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" · ")
        })
        .unwrap_or_default();
    div()
        .id(("mission-card", index))
        .debug_selector(move || format!("mission-card-{index}"))
        .px(px(16.))
        .py(px(6.))
        .child(
            div()
                .p(px(12.))
                .rounded(px(10.))
                .border_1()
                .border_color(theme().border)
                .bg(theme().surface_raised)
                .child(
                    div()
                        .text_size(px(13.))
                        .text_color(theme().text)
                        .child(card["title"].as_str().unwrap_or("Card").to_owned()),
                )
                .when_some(card["body"].as_str().map(str::to_owned), |d, body| {
                    d.child(
                        div()
                            .mt(px(4.))
                            .text_size(px(12.5))
                            .text_color(theme().text_secondary)
                            .child(body),
                    )
                })
                .when(!entities.is_empty(), |d| {
                    d.child(
                        div()
                            .mt(px(6.))
                            .text_size(px(11.5))
                            .text_color(theme().text_muted)
                            .child(entities),
                    )
                })
                .child(actions)
                .when_some(error, |d, error| {
                    d.child(
                        div()
                            .mt(px(6.))
                            .text_size(px(11.5))
                            .text_color(theme().warning)
                            .child(error),
                    )
                }),
        )
        .into_any_element()
}

#[cfg(test)]
#[path = "mission_card_tests.rs"]
mod tests;
