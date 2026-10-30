//! Classic Activity's fixed tints (ACTIVITY_COLORS), feed icons, packet status
//! tones, and the day and age labels its timeline shows.
use super::feed::{Row, text};
use crate::clock::timestamp;
use gpui::{Rgba, rgb};

pub(super) const ACCENT: u32 = 0x8d9fbd;
pub(super) const SUCCESS: u32 = 0x70b57f;
pub(super) const DANGER: u32 = 0xc97878;
pub(super) const MERGE: u32 = 0xaaa0c7;
pub(super) const ATTENTION: u32 = 0xcf9d60;
pub(super) const ADD: u32 = 0x91c99d;
pub(super) const DELETE: u32 = 0xd99a9a;

/// A tint at `alpha`; classic washes are 0.08.
pub(super) fn tint(hex: u32, alpha: f32) -> Rgba {
    Rgba {
        a: alpha,
        ..rgb(hex)
    }
}

// Lucide paths from o8-activity-helpers.tsx on the 24-unit grid; circles are
// written as two arcs because the stroke asset carries a single path.
pub(super) const ZAP: &str = "M13 2L3 14h9l-1 8 10-12h-9l1-8z";
pub(super) const COMMIT: &str = "M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0M1.05 12H7M17.01 12h5.95";
pub(super) const PULL: &str = "M15 18a3 3 0 1 0 6 0a3 3 0 1 0-6 0M3 6a3 3 0 1 0 6 0a3 3 0 1 0-6 0M13 6h3a2 2 0 0 1 2 2v7M6 9v12";
pub(super) const ALERT: &str = "M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0M12 8v4M12 16h.01";
pub(super) const CHECK: &str = "M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3";
const CROSS: &str = "M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0M15 9l-6 6M9 9l6 6";
const CLOCK: &str = "M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0M12 6v6l4 2";
/// The 7px expand triangle, closed and open (classic rotates it 90°).
pub(super) const CHEVRON: &str = "M5.14 1.71L18.86 12L5.14 22.29Z";
pub(super) const CHEVRON_OPEN: &str = "M22.29 5.14L12 18.86L1.71 5.14Z";

/// A CI run's conclusion, or its status while it runs.
pub(super) fn conclusion(data: &serde_json::Value) -> String {
    let conclusion = text(data, "conclusion");
    if conclusion.is_empty() {
        text(data, "status")
    } else {
        conclusion
    }
    .to_lowercase()
}

/// A run outcome's tint: success, failure, or attention while pending.
pub(super) fn outcome(conclusion: &str) -> u32 {
    match conclusion {
        "success" => SUCCESS,
        "failure" => DANGER,
        _ => ATTENTION,
    }
}

/// FEED_ICON_MAP: the status dot's icon and tint for a GitHub or commit row.
pub(super) fn feed_icon(row: &Row) -> (&'static str, u32) {
    match row.kind {
        "issue" => (ALERT, MERGE),
        "pr" => (PULL, ACCENT),
        "ci" => match conclusion(&row.data).as_str() {
            "success" => (CHECK, SUCCESS),
            "failure" => (CROSS, DANGER),
            _ => (CLOCK, ATTENTION),
        },
        _ => (COMMIT, SUCCESS),
    }
}

/// orchestratorStatusTone: a packet status's label, color and dot wash.
pub(super) fn packet_tone(status: &str) -> (&'static str, Rgba, Rgba) {
    let (label, color, wash, alpha) = match status {
        "queued" => ("Queued", 0x1d4ed8, 0x2563eb, 0.1),
        "launching" => ("Launching", 0x2563eb, 0x2563eb, 0.12),
        "running" => ("Running", 0x16a34a, 0x16a34a, 0.12),
        "awaiting_review" => ("Reviewing", 0xb45309, 0xf59e0b, 0.12),
        "blocked" => ("Blocked", 0xdc2626, 0xef4444, 0.1),
        "recovering" => ("Recovering", 0x7c3aed, 0x7c3aed, 0.12),
        "failed" => ("Failed", 0x991b1b, 0x991b1b, 0.12),
        "released" => ("Completed", 0x0f766e, 0x14b8a6, 0.12),
        "archived" => ("Archived", 0x6b7280, 0x6b7280, 0.12),
        _ => ("Waiting", 0x64748b, 0x94a3b8, 0.12),
    };
    (label, rgb(color), tint(wash, alpha))
}

/// relativeAge: "just now", "14m ago", "3h ago", "2d ago".
pub(super) fn age(iso: &str, now: u64) -> String {
    let Some(time) = timestamp(iso) else {
        return String::new();
    };
    let minutes = now.saturating_sub(time) / 60;
    match minutes {
        0 => "just now".into(),
        1..60 => format!("{minutes}m ago"),
        60..1440 => format!("{}h ago", minutes / 60),
        _ => format!("{}d ago", minutes / 1440),
    }
}

/// The timeline's day heading: Today, Yesterday, or "Oct 24", in local time.
pub(super) fn day(iso: &str, now: u64) -> String {
    use crate::shell::sidebar::{calendar_date, calendar_midnight};
    let Some(time) = timestamp(iso) else {
        return String::new();
    };
    let today = calendar_midnight(now);
    if time >= today {
        return "Today".into();
    }
    if time >= calendar_midnight(today.saturating_sub(1)) {
        return "Yesterday".into();
    }
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    calendar_date(time)
        .and_then(|(month, day)| Some(format!("{} {day}", MONTHS.get(month as usize)?)))
        .unwrap_or_else(|| iso.get(..10).unwrap_or("").to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ages_and_days_read_like_classic() {
        let now = timestamp("2026-10-29T12:00:00Z").unwrap();
        assert_eq!(age("2026-10-29T11:59:40Z", now), "just now");
        assert_eq!(age("2026-10-29T11:46:00Z", now), "14m ago");
        assert_eq!(age("2026-10-29T09:00:00Z", now), "3h ago");
        assert_eq!(age("2026-10-27T12:00:00Z", now), "2d ago");
        assert_eq!(age("", now), "");
        assert_eq!(day("2026-10-29T12:00:00Z", now), "Today");
        assert_eq!(day("2026-10-20T12:00:00Z", now), "Oct 20");
    }

    #[test]
    fn feed_rows_take_classic_icons_and_tints() {
        let row = |kind: &'static str, data: serde_json::Value| Row {
            kind,
            id: "1".into(),
            repo: None,
            repo_identity: "local".into(),
            title: "t".into(),
            date: String::new(),
            data,
            ci: None,
        };
        let ci = |conclusion: &str| row("ci", serde_json::json!({"conclusion": conclusion}));
        assert_eq!(feed_icon(&ci("success")), (CHECK, SUCCESS));
        assert_eq!(feed_icon(&ci("failure")), (CROSS, DANGER));
        assert_eq!(feed_icon(&ci("")), (CLOCK, ATTENTION));
        assert_eq!(
            feed_icon(&row("pr", serde_json::Value::Null)),
            (PULL, ACCENT)
        );
        assert_eq!(
            feed_icon(&row("issue", serde_json::Value::Null)),
            (ALERT, MERGE)
        );
        assert_eq!(packet_tone("awaiting_review").0, "Reviewing");
        assert_eq!(packet_tone("draft").0, "Waiting");
    }
}
