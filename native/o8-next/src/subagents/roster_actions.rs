//! Roster actions use the same exact targets as classic; all I/O stays off paint.
use super::*;
use serde_json::{Value, json};
use std::collections::HashSet;

#[derive(Default)]
pub(crate) struct Controls {
    busy: bool,
    cleaning: bool,
    error: Option<String>,
    cleaned: HashSet<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum Stop {
    Packet(String),
    Shared(String),
    Native,
}

pub(super) fn button(
    state: &RowState,
    selector: String,
    label: &'static str,
    enabled: bool,
    action: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let action = Rc::new(action);
    let click = action.clone();
    div()
        .id(SharedString::from(selector.clone()))
        .when_some(state.subagent_focus.get(&selector).cloned(), |v, focus| {
            v.track_focus(&focus)
        })
        .debug_selector(move || selector.clone())
        .flex_none()
        .px(px(6.))
        .rounded(px(6.))
        .text_size(px(11.))
        .text_color(theme().text_muted)
        .opacity(if enabled { 1. } else { 0.5 })
        .when(enabled, |v| {
            v.focusable()
                .cursor_pointer()
                .hover(|v| v.bg(theme().hover).text_color(theme().text))
                .focus(|v| v.bg(theme().selection))
        })
        .on_click(move |_, w, cx| {
            if enabled {
                click(w, cx);
            }
            cx.stop_propagation();
        })
        .on_key_down(move |e: &KeyDownEvent, w, cx| {
            match e.keystroke.key.as_str() {
                "enter" | "space" if enabled => action(w, cx),
                "tab" => {
                    if e.keystroke.modifiers.shift {
                        w.focus_prev()
                    } else {
                        w.focus_next()
                    }
                }
                _ => return,
            }
            cx.stop_propagation();
        })
        .child(label)
        .into_any_element()
}

pub(super) fn footer(
    state: &RowState,
    items: &[Item],
    inspector: &Entity<Inspector>,
) -> AnyElement {
    let controls = state.subagent_roster.borrow();
    let mut footer = div().flex().items_center().gap(px(6.));
    for cleanup in [false, true] {
        let eligible = if cleanup {
            items.iter().any(|i| {
                i.cleanup
                    .as_ref()
                    .is_some_and(|w| !controls.cleaned.contains(&w.lane))
            })
        } else {
            items.iter().any(|i| i.group == Group::Working)
        };
        if !eligible {
            continue;
        }
        let items = items.to_vec();
        let inspector = inspector.clone();
        let controls = state.subagent_roster.clone();
        footer = footer.child(button(
            state,
            format!(
                "subagent-roster-{}",
                if cleanup { "clean-up" } else { "stop-all" }
            ),
            if controls.borrow().busy && controls.borrow().cleaning == cleanup {
                if cleanup {
                    "Cleaning up…"
                } else {
                    "Stopping…"
                }
            } else if cleanup {
                "Clean up"
            } else {
                "Stop all"
            },
            !controls.borrow().busy,
            {
                let controls = controls.clone();
                move |_, cx| {
                    inspector.update(cx, |i, cx| {
                        start(i, controls.clone(), items.clone(), cleanup, cx)
                    })
                }
            },
        ));
    }
    div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .child(footer)
        .children(controls.error.as_ref().map(|error| {
            div()
                .debug_selector(|| "subagent-roster-error".into())
                .text_size(px(11.))
                .text_color(theme().danger)
                .truncate()
                .child(error.clone())
        }))
        .into_any_element()
}

fn start(
    inspector: &mut Inspector,
    controls: Rc<RefCell<Controls>>,
    items: Vec<Item>,
    cleanup: bool,
    cx: &mut Context<Inspector>,
) {
    if controls.borrow().busy {
        return;
    }
    {
        let mut state = controls.borrow_mut();
        state.busy = true;
        state.cleaning = cleanup;
        state.error = None;
    }
    let (client, scope) = (inspector.client.clone(), inspector.scope.clone());
    let cleaned = controls.borrow().cleaned.clone();
    let task = cx.background_executor().spawn(async move {
        let mut errors = Vec::new();
        let mut retired = Vec::new();
        let mut seen = HashSet::new();
        let mut stopped = HashSet::new();
        for item in items {
            let result = if cleanup {
                let Some(worktree) = item.cleanup.filter(|w| !cleaned.contains(&w.lane)) else {
                    continue;
                };
                if !seen.insert(worktree.lane.clone()) {
                    continue;
                }
                clean(&client, &item.id, &worktree).map(|()| retired.push(worktree.lane))
            } else {
                if item.group != Group::Working {
                    continue;
                }
                let Some(stop) = item.stop else {
                    errors.push(format!(
                        "{}: Stop target unavailable. Refresh the roster.",
                        item.title
                    ));
                    continue;
                };
                if !stopped.insert(stop.clone()) {
                    continue;
                }
                stop_one(&client, &scope, &stop)
            };
            if let Err(error) = result {
                errors.push(format!("{}: {error}", item.title));
            }
        }
        (retired, errors)
    });
    cx.spawn(async move |this, cx| {
        let (retired, errors) = task.await;
        {
            let mut state = controls.borrow_mut();
            state.busy = false;
            state.cleaned.extend(retired);
            state.error = (!errors.is_empty()).then(|| {
                errors
                    .join(" · ")
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .to_owned()
            });
        }
        let _ = this.update(cx, |i, cx| {
            i.refresh(cx);
            cx.notify();
        });
    })
    .detach();
    cx.notify();
}

fn post(client: &Client, path: &str, body: Value) -> Result<Value, String> {
    let url = client.url(path).map_err(|e| e.to_string())?;
    let response = match client.request("POST", &url).send_json(body) {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(_) => return Err("Request unconfirmed. Inspect the agent before retrying.".into()),
    };
    let status = response.status();
    let value: Value = Client::read(response)?;
    if status >= 300
        || value["ok"] != true
        || value["inProgress"] == true
        || value["outcomeUnknown"] == true
    {
        return Err(value["error"]
            .as_str()
            .or(value["error"]["message"].as_str())
            .or(value["note"].as_str())
            .unwrap_or("Action unconfirmed. Inspect the agent before retrying.")
            .into());
    }
    Ok(value)
}

fn stop_one(client: &Client, scope: &Scope, stop: &Stop) -> Result<(), String> {
    match stop {
        Stop::Packet(id) => post(
            client,
            "/api/orchestrator/stop-packet",
            json!({"packetId":id}),
        )
        .map(|_| ()),
        Stop::Shared(id) => {
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce).map_err(|_| "Could not identify the stop request.")?;
            let mutation: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
            post(
                client,
                "/api/runtime/action",
                json!({"action":"interrupt","surfaceId":id,"clientMutationId":mutation}),
            )
            .map(|_| ())
        }
        Stop::Native => {
            let parent = scope
                .parent
                .as_deref()
                .ok_or("The lead turn is unavailable.")?;
            let parent = parent.strip_prefix("llm-chat:").unwrap_or(parent);
            let record: Value =
                client.get("/api/v2/chat-history", &[("tabId", parent), ("limit", "1")])?;
            let backend = record["backend"]
                .as_str()
                .filter(|backend| !backend.is_empty())
                .ok_or("The lead runtime is unavailable. Refresh before stopping.")?;
            crate::transport::interrupt(client, &scope.repo, parent, Some(backend)).map(|_| ())
        }
    }
}

fn clean(client: &Client, packet: &str, worktree: &model::Worktree) -> Result<(), String> {
    // State's packet projection lacks lane lifecycle and ownership. Re-read
    // the exact lane before invoking classic's guarded retirement action.
    let lanes: Value = client.get("/api/lanes", &[("active", "false")])?;
    let lane = lanes["lanes"]
        .as_array()
        .and_then(|lanes| lanes.iter().find(|lane| lane["id"] == worktree.lane))
        .ok_or("The finished lane is unavailable. Refresh before cleanup.")?;
    if lane["packetId"] != packet
        || lane["ownership"] != "managed"
        || lane["worktreePath"] != worktree.path
        || !matches!(
            lane["status"].as_str(),
            Some("completed" | "failed" | "archived")
        )
    {
        return Err(
            "The lane changed or is not a finished managed worktree. Inspect it before cleanup."
                .into(),
        );
    }
    let result = post(
        client,
        "/api/lanes",
        json!({"verb":"archive","laneId":worktree.lane}),
    )?;
    if !result["lane"].is_object() || !result["lane"]["worktreePath"].is_null() {
        return Err("Worktree cleanup was held. Inspect the agent before retrying.".into());
    }
    Ok(())
}
