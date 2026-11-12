//! The sidebar's bottom dock, which replaced the left navigation rail (Q 2026-11-09:
//! "cleaner and thinner for the left side"). Surfaces keep their own entries
//! through `Registration::nav`; the dock lays out the everyday ones in a row
//! and the Tools drawer (`rail_more`) holds every other destination.
use super::*;
use crate::icon::Tip;
use crate::theme::current as theme;
use gpui::{AnyElement, Div, Image, ImageFormat, ObjectFit, Rgba, SharedString, Stateful, img};
use serde_json::Value;
use std::sync::{Arc, Mutex, Once, OnceLock};

/// No column left of the sidebar any more; kept so the panels that measured
/// past the old rail still compute their offsets.
pub(super) const WIDTH: f32 = 0.;
/// The traffic lights' corner, which the old rail's column used to clear.
pub(crate) const LIGHTS: f32 = 52.;
/// One dock target.
pub(super) const TARGET: f32 = 34.;
/// The dock's height: one target and its padding.
pub(crate) const DOCK: f32 = TARGET + 10.;
/// Where the sidebar card starts when it grows open.
pub(super) const PAD: f32 = 0.;
const ICON: f32 = 17.;
/// Whether the dock shows Symon's orb.
const SHOW_SYMON: bool = false;

#[derive(Clone, Copy)]
pub(super) enum Icon {
    Play,
    Gauge,
    Terminal,
    Clock,
    PullRequest,
    Puzzle,
}

impl Icon {
    // Lucide paths used by the desktop rail, embedded for native use.
    pub(super) fn path(self) -> &'static str {
        match self {
            Self::Play => {
                "M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"
            }
            Self::Gauge => "m12 14 4-4 M3.34 19a10 10 0 1 1 17.32 0",
            Self::Terminal => "m4 17 6-6-6-6 M12 19h8",
            Self::Clock => "M12 6v6l4 2 M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20Z",
            Self::Puzzle => {
                "M8 3H5a2 2 0 0 0-2 2v3a3 3 0 1 1 0 6v3a2 2 0 0 0 2 2h3a3 3 0 1 1 6 0h3a2 2 0 0 0 2-2v-3a3 3 0 1 0 0-6V5a2 2 0 0 0-2-2h-3a3 3 0 1 0-6 0Z"
            }
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

/// A ring's arc on the 24-unit icon grid, from twelve o'clock clockwise.
/// The share snaps to twentieths so the icon cache holds a handful of arcs.
fn ring_path(radius: f32, share: f32) -> String {
    let share = (share.clamp(0., 1.) * 20.).round() / 20.;
    let top = 12. - radius;
    if share >= 1. {
        // A full turn has no distinct end point; draw it as two halves.
        return format!(
            "M12 {top} A{radius} {radius} 0 1 1 12 {bottom} A{radius} {radius} 0 1 1 12 {top}",
            bottom = 12. + radius
        );
    }
    let angle = share * std::f32::consts::TAU;
    format!(
        "M12 {top} A{radius} {radius} 0 {large} 1 {x:.2} {y:.2}",
        large = u8::from(share > 0.5),
        x = 12. + radius * angle.sin(),
        y = 12. - radius * angle.cos(),
    )
}

/// Codex's ring colour in every theme, as Claude's is o8 orange.
const CODEX_BLUE: gpui::Rgba = gpui::Rgba { r: 0.231, g: 0.510, b: 0.965, a: 1. };

/// The usage mark: two rings that fill with the week's use, Codex outside in
/// blue and Claude inside in orange.
fn usage_rings(usage: Usage) -> impl IntoElement {
    const SIZE: f32 = 19.;
    let layer = |path: String, color: Rgba, weight: f32| {
        crate::icon::stroke(&path, color, SIZE, weight)
            .absolute()
            .top_0()
            .left_0()
    };
    let track = Rgba {
        a: 0.28,
        ..theme().text_muted
    };
    div()
        .relative()
        .size(px(SIZE))
        .flex_shrink_0()
        .child(layer(ring_path(9., 1.), track, 2.4))
        .child(layer(ring_path(4.6, 1.), track, 2.4))
        .children(
            usage
                .codex
                .filter(|share| *share >= 0.025)
                .map(|share| layer(ring_path(9., share), CODEX_BLUE, 2.4)),
        )
        .children(
            usage
                .claude
                .filter(|share| *share >= 0.025)
                .map(|share| layer(ring_path(4.6, share), crate::theme::brand_orange(), 2.4)),
        )
}

fn gauge(s: &mut Shell, cx: &mut Context<Shell>) -> AnyElement {
    let usage = *USAGE.lock().unwrap();
    let open = s.features.get::<UsageCard>().open;
    div()
        .relative()
        .flex_shrink_0()
        .child(
            target("rail-usage")
                .relative()
                .when(open, |view| view.bg(theme().hover))
                .cursor_pointer()
                .on_click(cx.listener(|this, _, window, cx| {
                    this.features.get::<UsageCard>().open = false;
                    this.close_rail_overlays(window, cx);
                    this.execute(Command::Usage, window, cx);
                }))
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
                .child(usage_rings(usage)),
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

/// Each capacity's account heading, state line, window bars and resets
/// (RuntimeUsageSummary). Shared by the rail card and Settings › Limits.
pub(crate) fn usage_sections(snapshot: &Value) -> Vec<Div> {
    let muted = |text: SharedString, size: f32| {
        div()
            .text_size(px(size))
            .text_color(theme().text_muted)
            .child(text)
    };
    let snapshot = Some(snapshot);
    let mut sections = vec![];
    let capacities = snapshot
        .and_then(|snapshot| snapshot["capacities"].as_array().cloned())
        .unwrap_or_default();
    for capacity in &capacities {
        let identity = snapshot.and_then(|snapshot| {
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
    sections
}

/// The last capacity snapshot the rail poll read, for a stale fallback.
pub(crate) fn last_usage_snapshot() -> Option<Value> {
    SNAPSHOT.lock().unwrap().clone()
}

/// Seconds since the epoch, for the card's countdowns.
pub(crate) fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// "39m", "9h 34m", "6d 11h": the time left until a window resets.
fn countdown(seconds: u64) -> String {
    let (days, hours, minutes) = (seconds / 86_400, seconds % 86_400 / 3600, seconds % 3600 / 60);
    if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h {minutes:02}m")
    } else {
        format!("{}m", minutes.max(1))
    }
}

/// A window's length in seconds, read from its label; the server reports the
/// reset time but not the length.
fn window_seconds(label: &str) -> Option<u64> {
    if label.starts_with("Weekly") {
        Some(7 * 86_400)
    } else {
        let hours = label.strip_suffix("-hour")?.parse::<u64>().ok()?;
        Some(hours * 3600)
    }
}

/// How far through its window a bucket is, 0 to 1.
fn elapsed_share(bucket: &Value, now: u64) -> Option<f32> {
    let window = window_seconds(bucket["label"].as_str()?)?;
    let reset = epoch_seconds(bucket["resetsAt"].as_str()?)?;
    let left = reset.checked_sub(now)?.min(window);
    Some(1. - left as f32 / window as f32)
}

/// One runtime's standing in a word, and whether it needs attention.
fn standing(capacity: &Value, now: u64) -> (String, bool) {
    if capacity["confidence"] != "exact" || capacity["status"] == "stale" {
        return (state_label(capacity).into(), false);
    }
    let buckets = capacity["buckets"].as_array().cloned().unwrap_or_default();
    let used = |bucket: &Value| bucket["usedRatio"].as_f64().map(|ratio| ratio as f32);
    let Some(tightest) = buckets
        .iter()
        .filter(|bucket| used(bucket).is_some())
        .max_by(|a, b| used(a).partial_cmp(&used(b)).unwrap_or(std::cmp::Ordering::Equal))
    else {
        return (state_label(capacity).into(), false);
    };
    let ratio = used(tightest).unwrap_or(0.);
    if ratio >= 1. {
        return ("Limit reached".into(), true);
    }
    // Spending well ahead of an even pace runs out before the reset.
    if buckets.iter().any(|bucket| {
        used(bucket)
            .zip(elapsed_share(bucket, now))
            .is_some_and(|(used, elapsed)| used >= 0.5 && used > elapsed + 0.15)
    }) {
        return ("Ahead of pace".into(), true);
    }
    (format!("{}% left", ((1. - ratio) * 100.).round()), false)
}

/// One runtime in the usage card: its name and standing, then each window's
/// bar with the share used, an even-pace tick and the time to reset. Shared by
/// the rail's hover card and an empty thread's overview.
pub(crate) fn usage_runtime(capacity: &Value, now: u64) -> Div {
    let muted = |text: SharedString, size: f32| {
        div()
            .text_size(px(size))
            .text_color(theme().text_muted)
            .child(text)
    };
    let (word, attention) = standing(capacity, now);
    let exact = capacity["confidence"] == "exact";
    let mut section = div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .pt(px(10.))
        .border_t_1()
        .border_color(theme().border)
        .child(
            div()
                .flex()
                .justify_between()
                .items_baseline()
                .gap(px(8.))
                .child(
                    div()
                        .text_size(px(12.5))
                        .child(runtime_name(capacity["runtime"].as_str().unwrap_or(""))),
                )
                .child(
                    div()
                        .text_size(px(10.5))
                        .text_color(if attention {
                            crate::theme::brand_orange()
                        } else {
                            theme().text_muted
                        })
                        .child(word),
                ),
        );
    let buckets = capacity["buckets"].as_array().cloned().unwrap_or_default();
    for bucket in &buckets {
        let ratio = bucket["usedRatio"]
            .as_f64()
            .map(|ratio| ratio.clamp(0., 1.) as f32);
        let pace = exact.then(|| elapsed_share(bucket, now)).flatten();
        let left = exact
            .then(|| bucket["resetsAt"].as_str().and_then(epoch_seconds))
            .flatten()
            .and_then(|reset| reset.checked_sub(now));
        let label = div()
            .w(px(88.))
            .flex_shrink_0()
            .truncate()
            .text_color(theme().text_secondary)
            .child(bucket["label"].as_str().unwrap_or("").to_string());
        let row = div()
            .h(px(18.))
            .flex()
            .items_center()
            .gap(px(8.))
            .text_size(px(11.))
            .child(label);
        section = section.child(match ratio {
            Some(ratio) => row
                .child(
                    div()
                        .relative()
                        .flex_1()
                        .h(px(4.))
                        .rounded(px(2.))
                        .bg(theme().border)
                        .child(div().h_full().rounded(px(2.)).w(gpui::relative(ratio)).bg(
                            if ratio >= 0.8 {
                                crate::theme::brand_orange()
                            } else {
                                theme().accent
                            },
                        ))
                        // Where an even spend would be by now.
                        .children(pace.map(|pace| {
                            div()
                                .absolute()
                                .top(px(-2.))
                                .left(gpui::relative(pace))
                                .w(px(1.))
                                .h(px(8.))
                                .bg(theme().text_muted)
                        })),
                )
                .child(
                    div()
                        .w(px(32.))
                        .flex_shrink_0()
                        .flex()
                        .justify_end()
                        .child(format!("{}%", (ratio * 100.).round())),
                )
                .child(
                    div()
                        .w(px(46.))
                        .flex_shrink_0()
                        .flex()
                        .justify_end()
                        .text_size(px(10.))
                        .text_color(theme().text_muted)
                        .child(left.map(countdown).unwrap_or_default()),
                ),
            None => row
                .justify_between()
                .child(div().child(value_label(bucket))),
        });
    }
    if buckets.is_empty() {
        section = section.child(muted(
            if capacity["reason"] == "subscription_limits_unsupported" {
                "This login does not report plan allowances."
            } else {
                "No usage windows were reported."
            }
            .into(),
            10.5,
        ));
    }
    section
}

/// The hover card: every connected runtime's windows on one line each, with
/// the share used, an even-pace mark and the time to reset. It never scrolls.
fn usage_card(cx: &mut Context<Shell>) -> impl IntoElement {
    let snapshot = SNAPSHOT.lock().unwrap().clone();
    let now = now_seconds();
    let muted = |text: SharedString, size: f32| {
        div()
            .text_size(px(size))
            .text_color(theme().text_muted)
            .child(text)
    };
    let capacities = snapshot
        .as_ref()
        .and_then(|snapshot| snapshot["capacities"].as_array().cloned())
        .unwrap_or_default();
    let age = snapshot
        .as_ref()
        .and_then(|snapshot| snapshot["generatedAt"].as_u64())
        .map(|at| now.saturating_sub(at / 1000));
    let mut body = div()
        .p(px(14.))
        .flex()
        .flex_col()
        .gap(px(10.))
        .text_color(theme().text)
        .child(
            div()
                .flex()
                .justify_between()
                .items_baseline()
                .gap(px(8.))
                .child(div().text_size(px(13.)).child("Usage"))
                .child(muted(
                    match age {
                        None => "Loading…".into(),
                        Some(age) if age < 90 => "Live".into(),
                        Some(age) => format!("{} ago", countdown(age)).into(),
                    },
                    10.,
                )),
        );
    for capacity in &capacities {
        body = body.child(usage_runtime(capacity, now));
    }
    let body = body
        .when(snapshot.is_some() && capacities.is_empty(), |body| {
            body.child(muted("No connected runtime reports usage yet.".into(), 11.))
        })
        .when(snapshot.is_none(), |body| {
            body.child(muted("Reading connected runtimes…".into(), 10.5))
        })
        .when(!capacities.is_empty(), |body| {
            body.child(
                div()
                    .pt(px(8.))
                    .border_t_1()
                    .border_color(theme().border)
                    .flex()
                    .justify_between()
                    .child(muted("Tick marks an even pace".into(), 9.5))
                    .child(muted("Open usage ›".into(), 9.5)),
            )
        });
    // Above the gauge, left-aligned with it.
    div()
        .absolute()
        .left(px(0.))
        .top(px(-8.))
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
                            .w(px(320.))
                            .rounded(px(12.))
                            .bg(crate::theme::popover_background())
                            .border_1()
                            .border_color(theme().border)
                            .shadow_lg()
                            .cursor_pointer()
                            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                                if *hovered {
                                    this.features.get::<UsageCard>().leave += 1;
                                } else {
                                    leave_usage(this, cx);
                                }
                            }))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.features.get::<UsageCard>().open = false;
                                this.close_rail_overlays(window, cx);
                                this.execute(Command::Usage, window, cx);
                            }))
                            .child(body),
                    ),
            )
            .with_priority(2),
        )
}

#[cfg(test)]
mod usage_card_tests {
    use super::{countdown, elapsed_share, ring_path, standing, window_seconds};
    use serde_json::json;

    #[test]
    fn a_reset_reads_as_time_left() {
        assert_eq!(countdown(20), "1m");
        assert_eq!(countdown(39 * 60), "39m");
        assert_eq!(countdown(9 * 3600 + 34 * 60), "9h 34m");
        assert_eq!(countdown(6 * 86_400 + 11 * 3600 + 59), "6d 11h");
    }

    #[test]
    fn a_ring_arc_starts_at_the_top_and_closes_at_a_full_turn() {
        assert_eq!(ring_path(9., 0.25), "M12 3 A9 9 0 0 1 21.00 12.00");
        assert_eq!(ring_path(9., 0.75), "M12 3 A9 9 0 1 1 3.00 12.00");
        assert_eq!(ring_path(9., 1.4), "M12 3 A9 9 0 1 1 12 21 A9 9 0 1 1 12 3");
        // 0.12 snaps to a tenth, so nearby shares reuse one cached arc.
        assert_eq!(ring_path(9., 0.12), ring_path(9., 0.1));
    }

    #[test]
    fn a_window_length_comes_from_its_label() {
        assert_eq!(window_seconds("5-hour"), Some(5 * 3600));
        assert_eq!(window_seconds("Weekly"), Some(7 * 86_400));
        assert_eq!(window_seconds("Weekly · Fable"), Some(7 * 86_400));
        assert_eq!(window_seconds("Monthly"), None);
    }

    #[test]
    fn a_runtime_standing_names_the_limit_then_the_pace_then_what_is_left() {
        // 1970-01-08T00:00:00Z is one week after the epoch.
        let week = |used: f64| json!({"label": "Weekly", "usedRatio": used, "resetsAt": "1970-01-08T00:00:00.000Z"});
        let exact = |bucket| json!({"confidence": "exact", "status": "available", "buckets": [bucket]});
        // Half way through the week.
        let now = 7 * 86_400 / 2;
        assert_eq!(elapsed_share(&week(0.1), now), Some(0.5));
        assert_eq!(standing(&exact(week(1.0)), now), ("Limit reached".into(), true));
        assert_eq!(standing(&exact(week(0.7)), now), ("Ahead of pace".into(), true));
        assert_eq!(standing(&exact(week(0.4)), now), ("60% left".into(), false));
        let unsupported = json!({"confidence": "none", "reason": "subscription_limits_unsupported", "buckets": []});
        assert_eq!(standing(&unsupported, now), ("No subscription limits".into(), false));
    }
}

fn divider() -> Div {
    div()
        .w(px(27.))
        .h(px(1.))
        .my(px(6.))
        .flex_shrink_0()
        .bg(theme().border)
}

/// SymonMark: classic's orb, rendered from SYMON_ORB_BACKGROUND because GPUI has
/// no conic gradient. Its highlight follows `--t-text`, so each ink has a file.
fn symon_mark(active: bool) -> impl IntoElement {
    symon_mark_sized(20., active)
}
/// The Symon mark at any size; setup's voice step shows it at 32 px.
pub(crate) fn symon_mark_sized(size: f32, active: bool) -> impl IntoElement {
    static DARK: OnceLock<Arc<Image>> = OnceLock::new();
    static LIGHT: OnceLock<Arc<Image>> = OnceLock::new();
    let load =
        |bytes: &'static [u8]| Arc::new(Image::from_bytes(ImageFormat::Png, bytes.to_vec()));
    let mark = if crate::theme::light() {
        LIGHT.get_or_init(|| load(include_bytes!("symon_mark_light.png")))
    } else {
        DARK.get_or_init(|| load(include_bytes!("symon_mark_dark.png")))
    };
    let glow = gpui::BoxShadow {
        color: crate::theme::symon_glow().into(),
        offset: gpui::point(px(0.), px(0.)),
        blur_radius: px(9.),
        spread_radius: px(0.),
    };
    let mut shadows = vec![glow];
    if active {
        shadows.insert(
            0,
            gpui::BoxShadow {
                color: theme().accent.into(),
                offset: gpui::point(px(0.), px(0.)),
                blur_radius: px(0.),
                spread_radius: px(2.),
            },
        );
    }
    div().size(px(size)).rounded_full().shadow(shadows).child(
        img(mark.clone())
            .size(px(size))
            .object_fit(ObjectFit::Contain),
    )
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
        if self
            .surfaces
            .setup
            .view
            .as_ref()
            .is_some_and(|v| !v.read(cx).busy())
        {
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
        // The dock grows with the sidebar; keep its frames coming in flight.
        if super::sidebar::travel(self).1 {
            window.request_animation_frame();
        }
        let voice = self.voice_live();
        // The dock spans the sidebar and folds away with it.
        let (open, moving) = super::sidebar::travel(self);
        if self.surfaces.sidebar.hidden && !moving {
            return div().into_any_element();
        }
        let width = super::sidebar::width(self) * open;
        // Items read the dock's width to fold into the Tools drawer when narrow.
        self.features.get::<features::rail_more_dock::Dock>().width = super::sidebar::width(self);
        div()
            .id("shell-rail")
            .debug_selector(|| "shell-dock".into())
            .absolute()
            .bottom_0()
            .left_0()
            .w(px(width))
            .h(px(DOCK))
            .overflow_hidden()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(2.))
            // The avatar's centre meets the cards' marks (23px) and Tools the
            // list's right axis (22px).
            .pl(px(6.))
            .pr(px(5.))
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|_, _, window, _| window.prevent_default()),
            )
            // Q 2026-11-09: profile, PRs and usage on the left; updates and
            // Tools on the right.
            .child(features::profile(self, window, cx))
            // Symon's toggle is off the dock for now (Q 2026-11-09). Caps Lock and
            // voice-toggle still drive it; flip SHOW_SYMON to bring the orb back.
            .when(SHOW_SYMON, |dock| {
                dock.child(
                    target("rail-symon")
                        .tooltip(|_, cx| cx.new(|_| Tip("Symon".into())).into())
                        .child(symon_mark(voice))
                        .on_click(cx.listener(|this, _, _, cx| this.toggle_voice(cx))),
                )
            })
            // Settings lives in the profile menu and Tools (Q 2026-11-09).
            .children(top)
            .child(gauge(self, cx))
            .child(div().flex_1().min_w_0())
            .children(features::rail(self, window, cx))
            .children(bottom)
            // Every other destination opens from the Tools drawer.
            .child(features::rail_more(self, cx))
            .into_any_element()
    }
}
