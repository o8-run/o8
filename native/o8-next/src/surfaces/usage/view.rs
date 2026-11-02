//! The Usage page (UsageWorkspace.tsx, RuntimeUsageSummary.tsx).
use super::format::day_label;
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, Div, FocusHandle, ScrollHandle, SharedString, Stateful};
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, Instant};

const PAGE_WIDTH: f32 = 1040.;
const REFRESH: Duration = Duration::from_secs(30);
const SCAN_POLL: Duration = Duration::from_secs(2);
const REFRESH_ICON: &str =
    "M20 7v5h-5M4 17v-5h5M6.1 6.1a8 8 0 0 1 13.5 4.4M17.9 17.9A8 8 0 0 1 4.4 13.5";

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Mode {
    Limits,
    Cost,
    Tokens,
}

pub(crate) struct Usage {
    client: Client,
    pub(super) focus: FocusHandle,
    scroll: ScrollHandle,
    pub(super) mode: Mode,
    pub(super) days: u32,
    pub(super) by_day: bool,
    pub(super) capacity: Option<Value>,
    pub(super) history: HashMap<u32, Value>,
    pub(super) loading: bool,
    error: Option<String>,
    fetched: Option<Instant>,
    generation: u64,
}

impl Usage {
    pub(crate) fn new(client: Client, _: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut usage = Self {
            client,
            focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
            mode: Mode::Limits,
            days: 30,
            by_day: false,
            capacity: None,
            history: HashMap::new(),
            loading: false,
            error: None,
            fetched: None,
            generation: 0,
        };
        usage.load(false, cx);
        usage
    }
    pub(crate) fn tick(&mut self, cx: &mut Context<Self>) {
        if !self.loading && self.fetched.is_none_or(|at| at.elapsed() >= REFRESH) {
            self.load(false, cx);
        }
    }
    pub(crate) fn load(&mut self, fresh: bool, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        self.loading = true;
        self.fetched = Some(Instant::now());
        cx.notify();
        let (client, mode, days) = (self.client.clone(), self.mode, self.days);
        let task = cx.background_executor().spawn(async move {
            let flag = if fresh { "1" } else { "0" };
            if mode == Mode::Limits {
                let query: &[(&str, &str)] = if fresh { &[("fresh", "1")] } else { &[] };
                client.get::<Value>("/api/runtime/capacity", query)
            } else {
                let zone = time_zone();
                let days = days.to_string();
                client.get::<Value>(
                    "/api/runtime/usage",
                    &[("days", &days), ("timeZone", &zone), ("fresh", flag)],
                )
            }
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let scanning = this
                .update(cx, |this, cx| {
                    if this.generation != generation {
                        return false;
                    }
                    let scanning = match result {
                        Ok(data) if data["status"] == "scanning" || data["refreshing"] == true => {
                            let done = data["status"] != "scanning";
                            if done {
                                this.history.insert(days, data);
                            }
                            true
                        }
                        Ok(data) => {
                            if mode == Mode::Limits {
                                this.capacity = Some(data);
                            } else {
                                this.history.insert(days, data);
                            }
                            this.error = None;
                            false
                        }
                        Err(_) => {
                            // Previous observations stay on screen, as classic's do.
                            this.error =
                                Some("Could not refresh usage. Showing the last reading.".into());
                            false
                        }
                    };
                    this.loading = scanning;
                    cx.notify();
                    scanning
                })
                .unwrap_or(false);
            if scanning {
                cx.background_executor().timer(SCAN_POLL).await;
                let _ = this.update(cx, |this, cx| {
                    if this.generation == generation {
                        this.load(false, cx);
                    }
                });
            }
        })
        .detach();
    }
    fn show(&mut self, mode: Mode, cx: &mut Context<Self>) {
        self.mode = mode;
        self.load(false, cx);
    }
    fn range(&mut self, days: u32, cx: &mut Context<Self>) {
        self.days = days;
        self.load(false, cx);
    }
    fn header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let mode = self.mode;
        let mut controls = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .flex_shrink_0()
            .child(
                segmented().children(
                    [
                        (Mode::Limits, "Limits", "usage-limits"),
                        (Mode::Cost, "Cost", "usage-cost"),
                        (Mode::Tokens, "Tokens", "usage-tokens"),
                    ]
                    .map(|(item, label, id)| {
                        choice(id.into(), label, mode == item)
                            .on_click(cx.listener(move |this, _, _, cx| this.show(item, cx)))
                    }),
                ),
            );
        if mode != Mode::Limits {
            controls = controls.child(segmented().children(
                [(1, "24h"), (7, "7d"), (30, "30d"), (90, "90d")].map(|(days, label)| {
                    choice(format!("usage-range-{days}"), label, self.days == days)
                        .on_click(cx.listener(move |this, _, _, cx| this.range(days, cx)))
                }),
            ));
        }
        div()
            .flex()
            .items_start()
            .justify_between()
            .gap(px(16.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(div().text_size(px(24.)).child("Usage"))
                    .child(
                        div()
                            .text_size(px(13.))
                            .text_color(theme().text_muted)
                            .child(match mode {
                                Mode::Limits => "Your connected accounts' allowances and resets.",
                                _ => "From each CLI's own history on this machine.",
                            }),
                    ),
            )
            .child(
                controls.child(
                    div()
                        .id("usage-refresh")
                        .debug_selector(|| "usage-refresh".into())
                        .size(px(28.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(7.))
                        .cursor_pointer()
                        .opacity(if self.loading { 0.5 } else { 1. })
                        .hover(|v| v.bg(theme().hover))
                        .child(crate::icon::stroke(
                            REFRESH_ICON,
                            theme().text_secondary,
                            14.,
                            1.6,
                        ))
                        .on_click(cx.listener(|this, _, _, cx| {
                            if !this.loading {
                                this.load(true, cx);
                            }
                        })),
                ),
            )
    }
    fn limits(&self) -> AnyElement {
        let Some(snapshot) = &self.capacity else {
            return note("Reading connected accounts…").into_any_element();
        };
        let capacities = snapshot["capacities"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if capacities.is_empty() {
            return note("No connected accounts report limits yet.").into_any_element();
        }
        div()
            .debug_selector(|| "usage-limit-cards".into())
            .flex()
            .flex_wrap()
            .gap(px(12.))
            .children(capacities.iter().map(|capacity| {
                let identity = snapshot["identities"]
                    .as_array()
                    .and_then(|all| all.iter().find(|i| i["id"] == capacity["identityId"]));
                limit_card(capacity, identity)
            }))
            .into_any_element()
    }
}

impl Render for Usage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let body = match self.mode {
            Mode::Limits => self.limits(),
            _ => match self.history.get(&self.days) {
                Some(snapshot) => {
                    history::panel(snapshot, self.mode == Mode::Cost, self.by_day, cx)
                }
                None => note("Reading this machine's history…").into_any_element(),
            },
        };
        div()
            .id("usage-page")
            .debug_selector(|| "usage-page".into())
            .track_focus(&self.focus)
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .bg(theme().background)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .font_weight(gpui::FontWeight::LIGHT)
            .child(
                div()
                    .w_full()
                    .max_w(px(PAGE_WIDTH))
                    .mx_auto()
                    .flex()
                    .flex_col()
                    .gap(px(22.))
                    .pt(px(44.))
                    .px(px(28.))
                    .pb(px(64.))
                    .child(self.header(cx))
                    .children(self.error.clone().map(|error| note(&error)))
                    .child(body),
            )
    }
}

fn segmented() -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(2.))
        .p(px(2.))
        .rounded(px(9.))
        .border_1()
        .border_color(theme().border)
        .bg(theme().surface)
}

pub(super) fn choice(id: String, label: &'static str, selected: bool) -> Stateful<Div> {
    let selector = id.clone();
    div()
        .id(SharedString::from(id))
        .debug_selector(move || selector.clone())
        .h(px(24.))
        .px(px(10.))
        .flex()
        .items_center()
        .rounded(px(7.))
        .text_size(px(11.5))
        .cursor_pointer()
        .text_color(if selected {
            theme().accent
        } else {
            theme().text_muted
        })
        .when(selected, |v| v.bg(theme().selection))
        .hover(|v| v.bg(theme().hover))
        .child(label)
}

pub(super) fn note(text: &str) -> Div {
    div()
        .text_size(px(12.))
        .text_color(theme().text_muted)
        .child(text.to_owned())
}

pub(super) fn card() -> Div {
    div()
        .flex()
        .flex_col()
        .rounded(px(12.))
        .border_1()
        .border_color(theme().border)
        .bg(theme().surface)
        .p(px(16.))
}

fn runtime_name(runtime: &str) -> String {
    match runtime {
        "codex" => "Codex".into(),
        "claude-code" => "Claude".into(),
        other => other.into(),
    }
}

fn state_label(capacity: &Value) -> &'static str {
    let tokens = capacity["buckets"]
        .as_array()
        .is_some_and(|buckets| buckets.iter().any(|bucket| bucket["unit"] == "tokens"));
    match () {
        _ if capacity["status"] == "stale" => "Last observation · stale",
        _ if capacity["confidence"] == "exact" => "Subscription limits",
        _ if tokens => "Local activity · quota not reported",
        _ if capacity["reason"] == "subscription_limits_unsupported" => "No subscription limits",
        _ => "Not available",
    }
}

fn value_label(bucket: &Value) -> String {
    if let Some(ratio) = bucket["usedRatio"].as_f64() {
        format!("{}% used", (ratio * 100.).round())
    } else if let (Some(used), "tokens") = (
        bucket["used"].as_f64(),
        bucket["unit"].as_str().unwrap_or(""),
    ) {
        format!("{} tokens", super::format::count(used))
    } else if let Some(remaining) = bucket["remaining"].as_f64() {
        format!("{remaining} remaining")
    } else {
        "Not reported".into()
    }
}

fn limit_card(capacity: &Value, identity: Option<&Value>) -> AnyElement {
    let name = runtime_name(capacity["runtime"].as_str().unwrap_or(""));
    let name = match identity.and_then(|i| i["label"].as_str()) {
        Some(label) => format!("{name} · {label}"),
        None => name,
    };
    let exact = capacity["confidence"] == "exact";
    card()
        .w(px(320.))
        .flex_grow()
        .gap(px(12.))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(3.))
                .child(div().text_size(px(13.5)).truncate().child(name))
                .child(
                    div()
                        .text_size(px(10.5))
                        .text_color(theme().text_muted)
                        .child(state_label(capacity)),
                ),
        )
        .children(
            capacity["buckets"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|bucket| {
                    let ratio = bucket["usedRatio"].as_f64().map(|r| r.clamp(0., 1.) as f32);
                    let reset = bucket["resetsAt"]
                        .as_str()
                        .filter(|_| exact)
                        .and_then(day_reset);
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .child(
                            div()
                                .flex()
                                .justify_between()
                                .gap(px(12.))
                                .text_size(px(12.))
                                .child(
                                    div()
                                        .text_color(theme().text_secondary)
                                        .child(bucket["label"].as_str().unwrap_or("").to_owned()),
                                )
                                .child(value_label(bucket)),
                        )
                        .children(ratio.map(|ratio| {
                            div()
                                .h(px(4.))
                                .rounded(px(2.))
                                .overflow_hidden()
                                .bg(theme().border)
                                .child(div().h_full().w(gpui::relative(ratio)).bg(
                                    if ratio >= 0.8 {
                                        crate::theme::brand_orange()
                                    } else {
                                        theme().accent
                                    },
                                ))
                        }))
                        .children(reset.map(|reset| {
                            div()
                                .text_size(px(10.))
                                .text_color(theme().text_muted)
                                .child(reset)
                        }))
                }),
        )
        .into_any_element()
}

fn day_reset(at: &str) -> Option<String> {
    let label = day_label(at);
    (label != at).then(|| format!("Resets {label}"))
}

/// The IANA name usage days are cut by, from the system's zone link.
fn time_zone() -> String {
    std::fs::read_link("/etc/localtime")
        .ok()
        .and_then(|path| {
            let path = path.to_string_lossy().into_owned();
            path.split_once("zoneinfo/")
                .map(|(_, zone)| zone.to_owned())
        })
        .unwrap_or_else(|| "UTC".into())
}
