//! Cost and Tokens (UsageHistoryPanel.tsx): the total, each CLI's share, a
//! daily chart, totals, spend by type and the model or day breakdown.
use super::format::{PROVIDERS, Sum, count, day_label, money, sum};
use super::view::{Usage, card, choice, note};
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, Div};
use serde_json::Value;
use std::collections::BTreeMap;

const CHART_HEIGHT: f32 = 148.;

fn format(value: f64, cost: bool) -> String {
    if cost { money(value) } else { count(value) }
}

fn caption(text: String) -> Div {
    div()
        .text_size(px(10.5))
        .text_color(theme().text_muted)
        .child(text)
}

fn heading(text: &'static str) -> Div {
    div()
        .text_size(px(13.))
        .font_weight(gpui::FontWeight::NORMAL)
        .child(text)
}

fn share_bar(share: f32, color: gpui::Rgba) -> Div {
    div()
        .h(px(4.))
        .w_full()
        .rounded(px(2.))
        .overflow_hidden()
        .bg(theme().border)
        .child(div().h_full().w(gpui::relative(share)).bg(color))
}

fn provider_color(id: &str) -> gpui::Rgba {
    match id {
        "claude" => crate::theme::brand_orange(),
        "opencode" => theme().accent,
        "codex" => theme().text,
        _ => theme().text_secondary,
    }
}

fn chart(buckets: &[&Value], cost: bool) -> Div {
    let mut days: BTreeMap<&str, f64> = BTreeMap::new();
    for bucket in buckets {
        let value = sum(std::iter::once(*bucket)).value(cost);
        *days
            .entry(bucket["day"].as_str().unwrap_or(""))
            .or_default() += value;
    }
    let highest = days
        .values()
        .copied()
        .fold(0., f64::max)
        .max(f64::MIN_POSITIVE);
    let first = days.keys().next().map(|d| day_label(d)).unwrap_or_default();
    let last = days
        .keys()
        .next_back()
        .map(|d| day_label(d))
        .unwrap_or_default();
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .flex_1()
        .min_w(px(280.))
        .child(
            div()
                .debug_selector(|| "usage-chart".into())
                .h(px(CHART_HEIGHT))
                .flex()
                .items_end()
                .gap(px(2.))
                .children(days.values().map(|value| {
                    div()
                        .flex_1()
                        .min_w(px(1.))
                        .h(px((value / highest) as f32 * CHART_HEIGHT).max(px(2.)))
                        .rounded_t(px(2.))
                        .bg(theme().accent)
                })),
        )
        .child(
            div()
                .flex()
                .justify_between()
                .text_size(px(10.))
                .text_color(theme().text_muted)
                .child(first)
                .child(last),
        )
}

pub(super) fn panel(
    snapshot: &Value,
    cost: bool,
    by_day: bool,
    cx: &mut Context<Usage>,
) -> AnyElement {
    let buckets: Vec<&Value> = snapshot["buckets"]
        .as_array()
        .map(|all| all.iter().collect())
        .unwrap_or_default();
    if buckets.is_empty() {
        return note("No recorded CLI usage in this range.").into_any_element();
    }
    let total = sum(buckets.iter().copied());
    let sessions: f64 = snapshot["providerSessions"]
        .as_object()
        .map(|all| all.values().filter_map(Value::as_f64).sum())
        .unwrap_or(0.);
    let providers = PROVIDERS.iter().filter_map(|(id, name)| {
        let of: Vec<&Value> = buckets
            .iter()
            .copied()
            .filter(|bucket| bucket["provider"] == *id)
            .collect();
        if of.is_empty() {
            return None;
        }
        let part = sum(of.iter().copied());
        let share = (part.value(cost) / total.value(cost).max(f64::MIN_POSITIVE)) as f32;
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(5.))
                .child(
                    div()
                        .flex()
                        .justify_between()
                        .text_size(px(12.5))
                        .child(*name)
                        .child(format(part.value(cost), cost)),
                )
                .child(share_bar(share, provider_color(id))),
        )
    });
    let summary = div()
        .flex()
        .flex_wrap()
        .gap(px(28.))
        .child(
            div()
                .w(px(300.))
                .flex_shrink_0()
                .flex()
                .flex_col()
                .gap(px(14.))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(3.))
                        .child(
                            div()
                                .debug_selector(|| "usage-total".into())
                                .text_size(px(32.))
                                .font_weight(gpui::FontWeight::NORMAL)
                                .child(format(total.value(cost), cost)),
                        )
                        .child(caption(if cost {
                            format!("{} sessions · API estimate, not your bill", count(sessions))
                        } else {
                            format!("{} sessions", count(sessions))
                        })),
                )
                .children(providers),
        )
        .child(chart(&buckets, cost));
    let stat = |label: &'static str, value: String| {
        div()
            .flex_1()
            .min_w(px(120.))
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(caption(label.into()))
            .child(div().text_size(px(15.)).child(value))
    };
    let totals = card()
        .flex_row()
        .flex_wrap()
        .gap(px(14.))
        .child(stat("Processed tokens", count(total.tokens())))
        .child(stat("Cached input", count(total.cached)))
        .child(stat("Uncached input", count(total.uncached)))
        .child(stat("Output", count(total.output)))
        .child(stat("Cache savings", money(total.savings)));
    let breakdown = breakdown(&buckets, &total, cost, by_day, cx);
    div()
        .flex()
        .flex_col()
        .gap(px(22.))
        .child(summary)
        .child(totals)
        .child(types(&total, cost))
        .child(breakdown)
        .into_any_element()
}

fn types(total: &Sum, cost: bool) -> Div {
    let parts: [(&str, f64, gpui::Rgba); 4] = if cost {
        [
            ("Input", total.category[0], theme().text_muted),
            ("Cache read", total.category[1], theme().text_secondary),
            ("Cache write", total.category[2], theme().accent),
            ("Output", total.category[3], theme().text),
        ]
    } else {
        [
            ("Input", total.uncached, theme().text_muted),
            ("Cache read", total.cached, theme().text_secondary),
            ("Cache write", total.cache_write, theme().accent),
            ("Output", total.output, theme().text),
        ]
    };
    let whole: f64 = parts
        .iter()
        .map(|part| part.1)
        .sum::<f64>()
        .max(f64::MIN_POSITIVE);
    div()
        .flex()
        .flex_col()
        .gap(px(10.))
        .child(heading(if cost {
            "Cost by type"
        } else {
            "Tokens by type"
        }))
        .child(
            div()
                .h(px(6.))
                .flex()
                .gap(px(2.))
                .rounded(px(3.))
                .overflow_hidden()
                .children(parts.iter().filter(|part| part.1 > 0.).map(|part| {
                    div()
                        .h_full()
                        .w(gpui::relative((part.1 / whole) as f32))
                        .bg(part.2)
                })),
        )
        .child(
            div()
                .flex()
                .flex_wrap()
                .gap(px(16.))
                .text_size(px(11.))
                .text_color(theme().text_secondary)
                .children(parts.iter().map(|(label, value, color)| {
                    div()
                        .flex()
                        .items_center()
                        .gap(px(5.))
                        .child(div().size(px(6.)).rounded(px(2.)).bg(*color))
                        .child(*label)
                        .child(div().text_color(theme().text).child(format(*value, cost)))
                })),
        )
}

fn breakdown(
    buckets: &[&Value],
    total: &Sum,
    cost: bool,
    by_day: bool,
    cx: &mut Context<Usage>,
) -> Div {
    let key = if by_day { "day" } else { "model" };
    let mut groups: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    for bucket in buckets {
        groups
            .entry(bucket[key].as_str().unwrap_or("Unknown").to_owned())
            .or_default()
            .push(*bucket);
    }
    let mut rows: Vec<(String, Sum)> = groups
        .into_iter()
        .map(|(name, of)| (name, sum(of.iter().copied())))
        .collect();
    if by_day {
        rows.reverse();
    } else {
        rows.sort_by(|a, b| b.1.value(cost).total_cmp(&a.1.value(cost)));
    }
    let column = |width: f32| div().w(px(width)).flex_shrink_0().flex().justify_end();
    let whole = total.value(cost).max(f64::MIN_POSITIVE);
    let count_rows = rows.len();
    div()
        .flex()
        .flex_col()
        .gap(px(10.))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(heading("Breakdown"))
                .child(
                    div()
                        .flex()
                        .gap(px(2.))
                        .child(choice("usage-by-model".into(), "Model", !by_day).on_click(
                            cx.listener(|this, _, _, cx| {
                                this.by_day = false;
                                cx.notify();
                            }),
                        ))
                        .child(
                            choice("usage-by-day".into(), "Day", by_day).on_click(cx.listener(
                                |this, _, _, cx| {
                                    this.by_day = true;
                                    cx.notify();
                                },
                            )),
                        ),
                ),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .rounded(px(12.))
                .border_1()
                .border_color(theme().border)
                .bg(theme().surface)
                .overflow_hidden()
                .children(rows.into_iter().enumerate().map(|(index, (name, part))| {
                    let name = if by_day { day_label(&name) } else { name };
                    div()
                        .h(px(38.))
                        .px(px(14.))
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .text_size(px(12.))
                        .when(index + 1 < count_rows, |row| {
                            row.border_b_1().border_color(theme().border)
                        })
                        .child(div().flex_1().min_w_0().truncate().child(name))
                        .child(
                            column(84.)
                                .text_color(theme().text_secondary)
                                .child(money(part.cost)),
                        )
                        .child(
                            column(56.)
                                .text_color(theme().text_muted)
                                .child(format!("{:.1}%", part.value(cost) / whole * 100.)),
                        )
                        .child(
                            column(84.)
                                .text_color(theme().text_secondary)
                                .child(count(part.tokens())),
                        )
                })),
        )
}
