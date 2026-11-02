//! history-view.ts: money, counts and the sums each panel reads.
use serde_json::Value;

pub(super) const PROVIDERS: [(&str, &str); 5] = [
    ("codex", "Codex"),
    ("claude", "Claude Code"),
    ("grok", "Grok Build"),
    ("opencode", "OpenCode"),
    ("antigravity", "Antigravity"),
];

pub(super) fn money(value: f64) -> String {
    let cents = (value * 100.).round() as i64;
    let whole = (cents / 100).to_string();
    let mut grouped = String::new();
    for (index, digit) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    format!("${grouped}.{:02}", cents % 100)
}

pub(super) fn count(value: f64) -> String {
    match value {
        v if v >= 1e9 => format!("{:.1}B", v / 1e9),
        v if v >= 1e6 => format!("{:.1}M", v / 1e6),
        v if v >= 1e5 => format!("{:.0}K", v / 1e3),
        v => {
            let whole = (v.round() as i64).to_string();
            let mut grouped = String::new();
            for (index, digit) in whole.chars().enumerate() {
                if index > 0 && (whole.len() - index) % 3 == 0 {
                    grouped.push(',');
                }
                grouped.push(digit);
            }
            grouped
        }
    }
}

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub(super) struct Sum {
    pub cost: f64,
    pub savings: f64,
    pub uncached: f64,
    pub cached: f64,
    pub cache_write: f64,
    pub output: f64,
    pub reasoning: f64,
    pub unpriced: f64,
    pub records: f64,
    pub category: [f64; 4],
}
impl Sum {
    pub fn tokens(&self) -> f64 {
        self.uncached + self.cached + self.cache_write + self.output
    }
    pub fn value(&self, cost: bool) -> f64 {
        if cost { self.cost } else { self.tokens() }
    }
}

pub(super) fn sum<'a>(buckets: impl Iterator<Item = &'a Value>) -> Sum {
    let mut total = Sum::default();
    for bucket in buckets {
        let totals = &bucket["totals"];
        let number = |value: &Value| value.as_f64().unwrap_or(0.);
        total.cost += number(&bucket["costUsd"]);
        total.savings += number(&bucket["cacheSavingsUsd"]);
        total.uncached += number(&totals["uncachedInputTokens"]);
        total.cached += number(&totals["cachedInputTokens"]);
        total.cache_write += number(&totals["cacheCreationTokens"]);
        total.output += number(&totals["outputTokens"]);
        total.reasoning += number(&totals["reasoningTokens"]);
        total.unpriced += number(&bucket["unpricedRecords"]);
        total.records += number(&bucket["records"]);
        for (index, key) in ["input", "cacheRead", "cacheWrite", "output"]
            .iter()
            .enumerate()
        {
            total.category[index] += number(&bucket["categoryCostUsd"][key]);
        }
    }
    total
}

/// A bucket's day as "Nov 1"; an hourly range keeps its hour.
pub(super) fn day_label(day: &str) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let mut parts = day.get(..10).unwrap_or(day).split('-');
    let (_, month, date) = (parts.next(), parts.next(), parts.next());
    let month = month
        .and_then(|m| m.parse::<usize>().ok())
        .and_then(|m| MONTHS.get(m.wrapping_sub(1)));
    let date = date.and_then(|d| d.parse::<u32>().ok());
    match (month, date) {
        (Some(month), Some(date)) => format!("{month} {date}"),
        _ => day.to_owned(),
    }
}
