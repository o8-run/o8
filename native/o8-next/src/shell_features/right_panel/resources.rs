//! Classic O8ResourcesPane behavior, using its existing process attribution route.
use super::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Instant;
const POLL: Duration = Duration::from_millis(2500);
const ROUTE: &str = "/api/panel/resource-usage";
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Row {
    key: String,
    label: String,
    repo: Option<String>,
    runtime: Option<String>,
    pid: Option<u32>,
    cpu_percent: Option<f64>,
    mem_bytes: Option<f64>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Total {
    cpu_percent: Option<f64>,
    mem_bytes: Option<f64>,
    ram_total_bytes: Option<f64>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
struct Snapshot {
    sessions: Vec<Row>,
    processes: Vec<Row>,
    total: Total,
    error: Option<String>,
}
#[derive(Default)]
struct State {
    data: Option<Snapshot>,
    pending: bool,
    active: bool,
    next: Option<Instant>,
    error: Option<String>,
    confirming: Option<(String, u32)>,
    stopping: bool,
    scroll: gpui::ScrollHandle,
}
pub(super) fn tick(s: &mut Shell, cx: &mut Context<Shell>) {
    let active = s.features.read::<Panel>().is_some_and(|p| {
        p.motion.is_open() && (p.selected == Tool::Resources || p.lower == Some(Tool::Resources))
    });
    let state = s.features.get::<State>();
    let reopened = active && !state.active;
    state.active = active;
    if !active {
        state.confirming = None;
        return;
    }
    if !state.pending
        && !state.stopping
        && (reopened || state.next.is_none_or(|at| at <= Instant::now()))
    {
        load(s, cx);
    }
}
fn load(s: &mut Shell, cx: &mut Context<Shell>) {
    if s.features.get::<State>().pending {
        return;
    }
    s.features.get::<State>().pending = true;
    let client = s.client.clone();
    let task = cx.background_executor().spawn(async move {
        let mut data: Snapshot = client.get(ROUTE, &[])?;
        if let Some(error) = &data.error {
            return Err(error.clone());
        }
        for rows in [&mut data.sessions, &mut data.processes] {
            rows.sort_by(|a, b| {
                b.mem_bytes
                    .unwrap_or(0.)
                    .total_cmp(&a.mem_bytes.unwrap_or(0.))
            });
        }
        Ok::<_, String>(data)
    });
    cx.spawn(async move |this, cx| {
        let result = task.await;
        let _ = this.update(cx, |s, cx| {
            let state = s.features.get::<State>();
            state.pending = false;
            state.next = Some(Instant::now() + POLL);
            let changed = match result {
                Ok(data) => {
                    let changed = state.data.as_ref() != Some(&data) || state.error.is_some();
                    state.data = Some(data);
                    state.error = None;
                    changed
                }
                Err(error) => {
                    let changed = state.error.as_ref() != Some(&error);
                    state.error = Some(error);
                    changed
                }
            };
            if changed {
                cx.notify();
            }
        });
    })
    .detach();
}
fn stop(s: &mut Shell, key: String, pid: u32, cx: &mut Context<Shell>) {
    let state = s.features.get::<State>();
    if state.stopping || state.confirming.as_ref() != Some(&(key.clone(), pid)) {
        return;
    }
    state.stopping = true;
    let client = s.client.clone();
    let task = cx.background_executor().spawn(async move {
        let url = client.url(ROUTE).map_err(|error| error.to_string())?;
        let result: Value = client
            .request("POST", &url)
            .send_json(json!({"key":key,"pid":pid}))
            .map_err(|error| error.to_string())?
            .into_json()
            .map_err(|error| error.to_string())?;
        if result["ok"] == true {
            Ok(())
        } else {
            Err(result["error"]
                .as_str()
                .unwrap_or("Could not stop this process")
                .to_string())
        }
    });
    cx.spawn(async move |this, cx| {
        let result = task.await;
        let _ = this.update(cx, |s, cx| {
            let state = s.features.get::<State>();
            state.stopping = false;
            state.confirming = None;
            if let Err(error) = result {
                state.error = Some(error);
                cx.notify();
            } else {
                load(s, cx);
                cx.notify();
            }
        });
    })
    .detach();
    cx.notify();
}
fn bytes(value: Option<f64>) -> String {
    let Some(value) = value.filter(|n| n.is_finite() && *n > 0.) else {
        return "—".into();
    };
    let gb = value / 1073741824.;
    if gb >= 10. {
        format!("{gb:.0} GB")
    } else if gb >= 1. {
        format!("{gb:.1} GB")
    } else {
        format!("{:.0} MB", value / 1048576.)
    }
}
fn cpu(value: Option<f64>) -> String {
    value
        .filter(|n| n.is_finite())
        .map(|n| format!("{}%", n.round()))
        .unwrap_or_else(|| "—".into())
}
fn row(s: &Shell, row: &Row, max: f64, cx: &mut Context<Shell>) -> AnyElement {
    let state = s.features.read::<State>().unwrap();
    let confirming = row.pid.is_some()
        && state.confirming.as_ref() == row.pid.map(|pid| (row.key.clone(), pid)).as_ref();
    let key = row.key.clone();
    let pid = row.pid;
    let group = SharedString::from(format!("resource-row-{}", row.key));
    let right = div()
        .relative()
        .w(px(112.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_end()
        .gap(px(4.));
    let right = if confirming {
        right
            .child(div().text_size(px(10.)).child(if state.stopping {
                "Stopping…"
            } else {
                "Kill?"
            }))
            .child(
                chrome::button(
                    s,
                    format!("resource-confirm-{}", row.key),
                    "Confirm stop",
                    cx,
                    move |s, _, cx| {
                        if let Some(pid) = pid {
                            stop(s, key.clone(), pid, cx)
                        }
                    },
                )
                .px(px(6.))
                .py(px(3.))
                .text_color(theme().danger)
                .child("Kill"),
            )
            .child(
                chrome::button(
                    s,
                    format!("resource-cancel-{}", row.key),
                    "Cancel stop",
                    cx,
                    |s, _, cx| {
                        if !s.features.get::<State>().stopping {
                            s.features.get::<State>().confirming = None;
                            cx.notify();
                        }
                    },
                )
                .px(px(5.))
                .py(px(3.))
                .child("Cancel"),
            )
    } else {
        let key = row.key.clone();
        right
            .child(
                div()
                    .flex_1()
                    .font_family(theme().font_mono)
                    .when(pid.is_some(), |v| {
                        v.group_hover(group.clone(), |v| v.opacity(0.))
                    })
                    .text_align(gpui::TextAlign::Right)
                    .child(div().text_size(px(12.)).child(bytes(row.mem_bytes)))
                    .child(
                        div()
                            .text_size(px(10.))
                            .text_color(theme().text_muted)
                            .child(format!("{} CPU", cpu(row.cpu_percent))),
                    ),
            )
            .when_some(pid, |right, pid| {
                right.child(
                    chrome::button(
                        s,
                        format!("resource-stop-{}", row.key),
                        "Stop this process",
                        cx,
                        move |s, _, cx| {
                            if !s.features.get::<State>().stopping {
                                s.features.get::<State>().confirming = Some((key.clone(), pid));
                                cx.notify();
                            }
                        },
                    )
                    .absolute()
                    .right_0()
                    .opacity(0.)
                    .group_hover(group.clone(), |style| style.opacity(1.))
                    .focus(|style| style.opacity(1.).bg(theme().selection))
                    .px(px(5.))
                    .py(px(3.))
                    .text_size(px(10.))
                    .child("Stop"),
                )
            })
    };
    let subtitle = [row.repo.clone(), row.pid.map(|pid| format!("pid {pid}"))]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" • ");
    let proportion = row
        .mem_bytes
        .filter(|_| max > 0.)
        .map_or(0., |n| (n / max).clamp(0.02, 1.)) as f32;
    let leave_key = row.key.clone();
    div()
        .id(SharedString::from(format!("resource-row-{}", row.key)))
        .debug_selector({
            let key = row.key.clone();
            move || format!("resource-row-{key}")
        })
        .group(group)
        .on_hover(cx.listener(move |s, hovered: &bool, _, cx| {
            let state = s.features.get::<State>();
            if !*hovered
                && !state.stopping
                && state
                    .confirming
                    .as_ref()
                    .is_some_and(|(key, _)| key == &leave_key)
            {
                state.confirming = None;
                cx.notify();
            }
        }))
        .px(px(14.))
        .py(px(8.))
        .border_b_1()
        .border_color(theme().border)
        .hover(|style| style.bg(theme().hover))
        .flex()
        .items_start()
        .gap(px(10.))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .when_some(row.runtime.clone(), |line, runtime| {
                            line.child(
                                div()
                                    .px(px(5.))
                                    .rounded(px(5.))
                                    .bg(theme().surface_raised)
                                    .text_size(px(9.))
                                    .text_color(theme().text_muted)
                                    .child(runtime),
                            )
                        })
                        .child(
                            div()
                                .min_w_0()
                                .overflow_hidden()
                                .text_size(px(13.))
                                .child(row.label.clone()),
                        ),
                )
                .when(!subtitle.is_empty(), |v| {
                    v.child(
                        div()
                            .mt(px(2.))
                            .text_size(px(9.5))
                            .text_color(theme().text_muted)
                            .child(subtitle),
                    )
                })
                .child(
                    div()
                        .mt(px(6.))
                        .h(px(3.))
                        .rounded(px(3.))
                        .bg(theme().surface_raised)
                        .child(
                            div()
                                .w(gpui::relative(proportion))
                                .h_full()
                                .rounded(px(3.))
                                .bg(theme().text_secondary),
                        ),
                ),
        )
        .child(right)
        .into_any_element()
}
pub(super) fn element(s: &Shell, cx: &mut Context<Shell>) -> AnyElement {
    let state = s.features.read::<State>();
    let data = state.and_then(|state| state.data.as_ref());
    let mut body = div()
        .id("resources-list")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll();
    if let Some(state) = state {
        body = body.track_scroll(&state.scroll);
    }
    if let Some(error) = state.and_then(|s| s.error.clone()) {
        body = body.child(
            div()
                .debug_selector(|| "resources-error".into())
                .px(px(14.))
                .py(px(10.))
                .text_size(px(11.))
                .text_color(theme().danger)
                .child(error)
                .child(
                    chrome::button(
                        s,
                        "resources-retry",
                        "Retry resource reading",
                        cx,
                        |s, _, cx| load(s, cx),
                    )
                    .px(px(6.))
                    .py(px(3.))
                    .child("Retry"),
                ),
        );
    }
    if let Some(data) = data {
        let max = data
            .sessions
            .iter()
            .chain(&data.processes)
            .filter_map(|row| row.mem_bytes)
            .fold(0., f64::max);
        if data.sessions.is_empty() && data.processes.is_empty() {
            body = body.child(
                div()
                    .debug_selector(|| "resources-empty".into())
                    .p(px(32.))
                    .text_size(px(13.))
                    .text_color(theme().text_muted)
                    .child("No active sessions."),
            );
        }
        for (label, rows) in [("Sessions", &data.sessions), ("Processes", &data.processes)] {
            if !rows.is_empty() {
                body = body
                    .child(
                        div()
                            .px(px(14.))
                            .pt(px(10.))
                            .pb(px(4.))
                            .text_size(px(9.))
                            .text_color(theme().text_muted)
                            .child(format!("{} · {}", label.to_uppercase(), rows.len())),
                    )
                    .children(rows.iter().map(|r| row(s, r, max, cx)));
            }
        }
    } else if state.is_none_or(|state| state.error.is_none()) {
        body = body.child(
            div()
                .p(px(32.))
                .text_size(px(13.))
                .text_color(theme().text_muted)
                .child("Reading process table…"),
        );
    }
    let total = data
        .map(|d| {
            format!(
                "{} / {} RAM · {} CPU",
                bytes(d.total.mem_bytes),
                bytes(d.total.ram_total_bytes),
                cpu(d.total.cpu_percent)
            )
        })
        .unwrap_or_else(|| "—".into());
    div()
        .debug_selector(|| "resources-surface".into())
        .size_full()
        .flex()
        .flex_col()
        .bg(theme().background)
        .child(
            div()
                .px(px(14.))
                .py(px(10.))
                .flex_shrink_0()
                .border_b_1()
                .border_color(theme().border)
                .child(div().text_size(px(13.5)).child("Resources"))
                .child(
                    div()
                        .debug_selector(|| "resources-total".into())
                        .mt(px(3.))
                        .text_size(px(10.5))
                        .text_color(theme().text_muted)
                        .child(total),
                ),
        )
        .child(body)
        .into_any_element()
}
#[cfg(test)]
pub(super) fn probe(s: &Shell) -> Value {
    let state = s.features.read::<State>().unwrap();
    json!({"data":state.data,"pending":state.pending,"active":state.active,"error":state.error})
}
#[cfg(test)]
pub(super) fn due(s: &mut Shell) {
    s.features.get::<State>().next = None;
}
