//! Left navigation rail, the native counterpart of CompactNavigationRail.tsx.
//! Surfaces keep their own entries through `Registration::nav`; the rail only
//! lays them out and adds the shell-level destinations.
use super::*;
use crate::icon::Tip;
use crate::theme::current as theme;
use gpui::{AnyElement, Div, Image, ImageFormat, ObjectFit, Rgba, SharedString, Stateful, img};
use serde_json::Value;
use std::sync::{Arc, Mutex, Once, OnceLock};

// NAVIGATION_RAIL_WIDTH and the 44px rail target in shell-geometry.ts.
pub(super) const WIDTH: f32 = 60.;
const TARGET: f32 = 44.;
const ICON: f32 = 19.;

#[derive(Clone, Copy)]
pub(super) enum Icon {
    Play,
    Gauge,
    Terminal,
    PullRequest,
}

impl Icon {
    // Lucide paths used by the desktop rail, embedded for native use.
    fn path(self) -> &'static str {
        match self {
            Self::Play => {
                "M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"
            }
            Self::Gauge => "m12 14 4-4 M3.34 19a10 10 0 1 1 17.32 0",
            Self::Terminal => "m4 17 6-6-6-6 M12 19h8",
            Self::PullRequest => {
                "M18 15a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M6 3a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M13 6h3a2 2 0 0 1 2 2v7 M6 9v12"
            }
        }
    }
}

fn glyph(icon: Icon, color: Rgba) -> impl IntoElement {
    crate::icon::stroke(icon.path(), color, ICON, 1.8)
}

/// One rail target. Callers attach the click handler; `active` marks the open destination.
pub(super) fn button(
    id: &'static str,
    icon: Icon,
    label: &'static str,
    active: bool,
) -> Stateful<Div> {
    target(id)
        .tooltip(move |_, cx| cx.new(|_| Tip(label.into())).into())
        .when(active, |view| view.bg(theme().hover))
        .child(glyph(
            icon,
            if active {
                theme().text
            } else {
                theme().text_secondary
            },
        ))
}

fn target(id: &'static str) -> Stateful<Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .size(px(TARGET))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(10.))
        .cursor_pointer()
        .hover(|view| view.bg(theme().hover))
}

// Weekly ratios behind the rail gauge, read like useRuntimeUsage and weeklyUsage
// in CompactNavigationRail.tsx.
#[derive(Clone, Copy, Default)]
struct Usage {
    codex: Option<f32>,
    claude: Option<f32>,
    highest: Option<f32>,
}
static USAGE: Mutex<Usage> = Mutex::new(Usage {
    codex: None,
    claude: None,
    highest: None,
});

/// The whole capacity snapshot, for the gauge's hover card.
static SNAPSHOT: Mutex<Option<Value>> = Mutex::new(None);

fn weekly(snapshot: &Value, runtime: &str) -> Option<f32> {
    let identity = snapshot["identities"].as_array().and_then(|all| {
        all.iter()
            .find(|i| i["runtime"] == runtime && i["selected"] == true)
    });
    snapshot["capacities"]
        .as_array()?
        .iter()
        .filter(|c| {
            c["runtime"] == runtime && c["status"] == "available" && c["confidence"] == "exact"
        })
        .filter(|c| identity.is_none_or(|i| c["identityId"] == i["id"]))
        .flat_map(|c| c["buckets"].as_array().cloned().unwrap_or_default())
        .filter(|b| b["label"] == "Weekly")
        .filter_map(|b| b["usedRatio"].as_f64())
        .map(|ratio| ratio.clamp(0., 1.) as f32)
        .reduce(f32::max)
}

fn read_usage(snapshot: &Value) -> Usage {
    let highest = snapshot["capacities"].as_array().and_then(|all| {
        all.iter()
            .filter(|c| c["status"] == "available")
            .flat_map(|c| c["buckets"].as_array().cloned().unwrap_or_default())
            .filter_map(|b| b["usedRatio"].as_f64())
            .map(|ratio| ratio as f32)
            .reduce(f32::max)
    });
    Usage {
        codex: weekly(snapshot, "codex"),
        claude: weekly(snapshot, "claude-code"),
        highest,
    }
}

fn watch_usage(client: &Client) {
    // Fixture servers record every request, so tests never start the poll.
    if cfg!(test) {
        return;
    }
    static STARTED: Once = Once::new();
    STARTED.call_once(|| {
        let client = client.clone();
        std::thread::spawn(move || {
            loop {
                if let Ok(snapshot) = client.get::<Value>("/api/runtime/capacity", &[]) {
                    *USAGE.lock().unwrap() = read_usage(&snapshot);
                    *SNAPSHOT.lock().unwrap() = Some(snapshot);
                }
                std::thread::sleep(Duration::from_secs(60));
            }
        });
    });
}

/// The gauge's hover card (CompactNavigationRail's rail-usage-preview).
#[derive(Default)]
struct UsageCard {
    open: bool,
    /// Bumped on every hover in and out, so a stale close timer does nothing.
    leave: u64,
}

/// Leaving the gauge or its card closes the card after 160 ms.
fn leave_usage(s: &mut Shell, cx: &mut Context<Shell>) {
    let card = s.features.get::<UsageCard>();
    card.leave += 1;
    let generation = card.leave;
    cx.spawn(async move |this, cx| {
        cx.background_executor()
            .timer(Duration::from_millis(160))
            .await;
        let _ = this.update(cx, |this, cx| {
            let card = this.features.get::<UsageCard>();
            if card.leave == generation {
                card.open = false;
                cx.notify();
            }
        });
    })
    .detach();
}

fn gauge(s: &mut Shell, cx: &mut Context<Shell>) -> AnyElement {
    let usage = *USAGE.lock().unwrap();
    let open = s.features.get::<UsageCard>().open;
    let meter = |ratio: Option<f32>, color: Rgba, bottom: f32| {
        div()
            .absolute()
            .left(px(16.))
            .bottom(px(bottom))
            .w(px(12.))
            .h(px(2.))
            .rounded(px(2.))
            .overflow_hidden()
            .bg(theme().border)
            .children(ratio.map(|r| div().h_full().w(px(12. * r)).bg(color)))
    };
    div()
        .relative()
        .flex_shrink_0()
        .child(
            target("rail-usage")
                .relative()
                .when(open, |view| view.bg(theme().hover))
                .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                    if *hovered {
                        let card = this.features.get::<UsageCard>();
                        card.open = true;
                        card.leave += 1;
                        cx.notify();
                    } else {
                        leave_usage(this, cx);
                    }
                }))
                .child(glyph(
                    Icon::Gauge,
                    if usage.highest.is_some_and(|r| r >= 0.8) {
                        crate::theme::brand_orange()
                    } else {
                        theme().text_muted
                    },
                ))
                .child(meter(usage.codex, theme().accent, 6.))
                .child(meter(usage.claude, crate::theme::brand_orange(), 2.)),
        )
        .when(open, |anchor| anchor.child(usage_card(cx)))
        .into_any_element()
}

fn runtime_name(runtime: &str) -> String {
    match runtime {
        "codex" => "Codex".into(),
        "claude-code" => "Claude".into(),
        other => other.into(),
    }
}

/// RuntimeUsageSummary's line under each runtime's name.
fn state_label(capacity: &Value) -> &'static str {
    if capacity["status"] == "stale" {
        "Last observation · stale"
    } else if capacity["confidence"] == "exact" {
        "Subscription limits"
    } else if capacity["buckets"]
        .as_array()
        .is_some_and(|buckets| buckets.iter().any(|bucket| bucket["unit"] == "tokens"))
    {
        "Local activity · quota not reported"
    } else if capacity["reason"] == "subscription_limits_unsupported" {
        "No subscription limits"
    } else {
        "Not available"
    }
}

/// A bucket's used share, tokens or remaining count, as RuntimeUsageSummary reads it.
fn value_label(bucket: &Value) -> String {
    if let Some(ratio) = bucket["usedRatio"].as_f64() {
        format!("{}% used", (ratio * 100.).round())
    } else if let (Some(used), "tokens") = (
        bucket["used"].as_f64(),
        bucket["unit"].as_str().unwrap_or(""),
    ) {
        format!("{} tokens", tokens(used))
    } else if let Some(remaining) = bucket["remaining"].as_f64() {
        format!("{remaining} remaining")
    } else {
        "Not reported".into()
    }
}

/// formatTokens: 950, 12.3K, 4.5M.
fn tokens(count: f64) -> String {
    if count >= 1_000_000. {
        format!("{:.1}M", count / 1_000_000.)
    } else if count >= 1_000. {
        format!("{:.1}K", count / 1_000.)
    } else {
        format!("{count}")
    }
}

/// Epoch seconds for a UTC ISO timestamp ("2026-11-02T15:00:00.000Z"), by the
/// same civil-date conversion as the activity dock's epoch_ms.
fn epoch_seconds(iso: &str) -> Option<u64> {
    let number = |range: std::ops::Range<usize>| iso.get(range)?.parse::<i64>().ok();
    if !iso.ends_with('Z') {
        return None;
    }
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + hour * 3600 + minute * 60 + second).ok()
}

/// "Thu 3:00 PM" in local time, as toLocaleString's weekday/hour/minute.
fn reset_label(iso: &str) -> Option<String> {
    let (weekday, hour, minute) = crate::shell::sidebar::calendar_clock(epoch_seconds(iso)?)?;
    let day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].get(weekday as usize)?;
    let (twelve, half) = match hour {
        0 => (12, "AM"),
        1..=11 => (hour, "AM"),
        12 => (12, "PM"),
        _ => (hour - 12, "PM"),
    };
    Some(format!("{day} {twelve}:{minute:02} {half}"))
}

/// The hover card: each connected runtime's windows, bars and resets
/// (RuntimeUsageSummary, compact).
fn usage_card(cx: &mut Context<Shell>) -> impl IntoElement {
    let snapshot = SNAPSHOT.lock().unwrap().clone();
    let muted = |text: SharedString, size: f32| {
        div()
            .text_size(px(size))
            .text_color(theme().text_muted)
            .child(text)
    };
    let mut sections = vec![];
    let capacities = snapshot
        .as_ref()
        .and_then(|snapshot| snapshot["capacities"].as_array().cloned())
        .unwrap_or_default();
    for capacity in &capacities {
        let identity = snapshot.as_ref().and_then(|snapshot| {
            snapshot["identities"].as_array().and_then(|all| {
                all.iter()
                    .find(|identity| identity["id"] == capacity["identityId"])
                    .and_then(|identity| identity["label"].as_str().map(String::from))
            })
        });
        let exact = capacity["confidence"] == "exact";
        let buckets = capacity["buckets"].as_array().cloned().unwrap_or_default();
        let mut section = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .pt(px(14.))
            .border_t_1()
            .border_color(theme().border)
            .child(div().text_size(px(13.5)).child(match identity {
                Some(label) => format!(
                    "{} · {label}",
                    runtime_name(capacity["runtime"].as_str().unwrap_or(""))
                ),
                None => runtime_name(capacity["runtime"].as_str().unwrap_or("")),
            }))
            .child(muted(state_label(capacity).into(), 10.));
        for bucket in &buckets {
            let percent = bucket["usedRatio"]
                .as_f64()
                .map(|ratio| (ratio * 100.).clamp(0., 100.) as f32);
            let reset = exact
                .then(|| bucket["resetsAt"].as_str().and_then(reset_label))
                .flatten();
            section = section.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .flex()
                            .justify_between()
                            .gap(px(12.))
                            .text_size(px(11.))
                            .child(
                                div()
                                    .text_color(theme().text_secondary)
                                    .child(bucket["label"].as_str().unwrap_or("").to_string()),
                            )
                            .child(value_label(bucket)),
                    )
                    .children(percent.map(|percent| {
                        div()
                            .h(px(3.))
                            .rounded(px(2.))
                            .overflow_hidden()
                            .bg(theme().border)
                            .child(div().h_full().w(gpui::relative(percent / 100.)).bg(
                                if percent >= 80. {
                                    crate::theme::brand_orange()
                                } else {
                                    theme().accent
                                },
                            ))
                    }))
                    .children(reset.map(|reset| muted(format!("Resets {reset}").into(), 9.5))),
            );
        }
        if buckets.is_empty() {
            section = section.child(muted(
                if capacity["reason"] == "subscription_limits_unsupported" {
                    "This login does not report plan allowances."
                } else {
                    "No usage windows were reported. Refresh to try again."
                }
                .into(),
                11.,
            ));
        }
        sections.push(section);
    }
    let body = div()
        .p(px(16.))
        .flex()
        .flex_col()
        .gap(px(12.))
        .text_color(theme().text)
        .font_weight(gpui::FontWeight::LIGHT)
        .child(
            div()
                .flex()
                .justify_between()
                .items_baseline()
                .gap(px(8.))
                .child(div().text_size(px(13.5)).child("Runtime usage"))
                .child(muted(
                    if snapshot.is_some() {
                        "Connected accounts"
                    } else {
                        "Loading…"
                    }
                    .into(),
                    10.,
                )),
        )
        .child(div().flex().flex_col().gap(px(14.)).children(sections))
        .when(snapshot.is_some() && capacities.is_empty(), |body| {
            body.child(muted("No connected runtime reports usage yet.".into(), 12.))
        })
        .when(snapshot.is_none(), |body| {
            body.child(muted("Reading connected runtimes…".into(), 10.5))
        });
    // Fixed beside the gauge, bottom-aligned with it, as the desktop places it.
    div()
        .absolute()
        .left(px(TARGET + 16.))
        .bottom(px(0.))
        .child(
            gpui::deferred(
                gpui::anchored()
                    .anchor(gpui::Corner::BottomLeft)
                    .snap_to_window_with_margin(px(12.))
                    .child(
                        div()
                            .id("rail-usage-card")
                            .debug_selector(|| "rail-usage-card".into())
                            .occlude()
                            .w(px(284.))
                            .max_h(px(360.))
                            .overflow_y_scroll()
                            .rounded(px(12.))
                            .bg(crate::theme::popover_background())
                            .border_1()
                            .border_color(theme().border)
                            .shadow_lg()
                            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                                if *hovered {
                                    this.features.get::<UsageCard>().leave += 1;
                                } else {
                                    leave_usage(this, cx);
                                }
                            }))
                            .child(body),
                    ),
            )
            .with_priority(2),
        )
}

fn divider() -> Div {
    div()
        .w(px(27.))
        .h(px(1.))
        .my(px(6.))
        .flex_shrink_0()
        .bg(theme().border)
}

fn brand() -> impl IntoElement {
    static LOGO: OnceLock<Arc<Image>> = OnceLock::new();
    let logo = LOGO.get_or_init(|| {
        Arc::new(Image::from_bytes(
            ImageFormat::Png,
            include_bytes!("surfaces/sidebar/project_identity.png").to_vec(),
        ))
    });
    img(logo.clone())
        .size(px(24.))
        .object_fit(ObjectFit::Contain)
}

impl Shell {
    /// Closes Projects, Settings, Customize and an idle Setup, the overlays the rail
    /// and its More menu open over the workspace.
    pub(crate) fn close_rail_overlays(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.surfaces.projects.open = false;
        if self.surfaces.settings.view.take().is_some() {
            self.surfaces.settings.subscription = None;
            self.revision += 1;
        }
        if self.surfaces.customize.open {
            self.close_customize(window, cx);
        }
        if self.surfaces.setup.view.as_ref().is_some_and(|v| !v.read(cx).busy()) {
            self.surfaces.setup.view = None;
            self.revision += 1;
        }
    }
    pub(super) fn render_rail(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let top = registrations()
            .iter()
            .flat_map(|r| (r.nav)(self, NavPosition::BeforeWorkspaces, cx))
            .collect::<Vec<_>>();
        let bottom = registrations()
            .iter()
            .flat_map(|r| (r.nav)(self, NavPosition::AfterWorkspaces, cx))
            .collect::<Vec<_>>();
        watch_usage(&self.client);
        let active = self.active();
        let tab = |id: &'static str,
                   icon: Icon,
                   label: &'static str,
                   tab: Tab,
                   command: fn() -> Command| {
            button(id, icon, label, active.as_ref() == Some(&tab)).on_click(cx.listener(
                move |this, _, window, cx| {
                    this.capture(window, cx);
                    this.execute(command(), window, cx);
                },
            ))
        };
        let projects_open = self.surfaces.projects.open;
        div()
            .id("shell-rail")
            .absolute()
            .top(px(crate::theme::GEOMETRY.header))
            .bottom_0()
            .left_0()
            .w(px(WIDTH))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .items_center()
            .py(px(8.))
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|_, _, window, _| window.prevent_default()),
            )
            .child(
                // Home returns to the workspace from Projects, Customize or Setup.
                target(if projects_open {
                    "shell-workspace"
                } else {
                    "shell-home"
                })
                .tooltip(|_, cx| cx.new(|_| Tip("o8 — Home".into())).into())
                .child(brand())
                .on_click(cx.listener(|this, _, window, cx| {
                    this.close_rail_overlays(window, cx);
                    this.restore_focus(window, cx);
                    cx.notify();
                })),
            )
            // A click starts a chat on the lead; a drag drops one onto the workspace.
            .child(
                button("rail-orchestrator", Icon::Play, "Run orchestrator", false)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.capture(window, cx);
                        features::start_chat(this, window, cx);
                    }))
                    .on_drag(features::RailPane::Chat, |drag, _, _, cx| {
                        cx.new(|_| drag.clone())
                    }),
            )
            // A click opens a terminal; a drag drops one onto the workspace.
            .child(
                tab(
                    "rail-terminal",
                    Icon::Terminal,
                    "Run terminal",
                    Tab::Terminal,
                    || Command::Terminal,
                )
                .on_drag(features::RailPane::Terminal, |drag, _, _, cx| {
                    cx.new(|_| drag.clone())
                }),
            )
            // Grid stays in code but off the rail until it earns a place (Q, 10-30).
            .child(divider())
            // RailMoreMenu, then PRs last, as CompactNavigationRail orders them.
            .child(features::rail_more(self, cx))
            .children(top)
            .child(divider())
            .child(div().flex_1().min_h_0())
            .child(gauge(self, cx))
            .children(features::rail(self, window, cx))
            .children(bottom)
            .into_any_element()
    }
}
