//! Presentation descriptors only; records remain owned by the desktop routes.
use super::*;

pub(super) fn timestamp(value: &str) -> Option<u64> {
    if let Ok(n) = value.parse::<u64>() {
        return Some(if n > 10_000_000_000 { n / 1000 } else { n });
    }
    let number = |a, b| value.get(a..b)?.parse::<i64>().ok();
    let mut year = number(0, 4)?;
    let month = number(5, 7)?;
    let day = number(8, 10)?;
    year -= i64::from(month <= 2);
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    let days =
        era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + (153 * mp + 2) / 5 + day - 1 - 719468;
    let seconds = days * 86400 + number(11, 13)? * 3600 + number(14, 16)? * 60 + number(17, 19)?;
    let suffix = value.get(19..)?;
    let offset = suffix
        .find(['+', '-'])
        .and_then(|i| {
            let zone = &suffix[i..];
            let hours = zone.get(1..3)?.parse::<i64>().ok()?;
            let minutes = zone.get(4..6)?.parse::<i64>().ok()?;
            Some((hours * 3600 + minutes * 60) * if zone.starts_with('-') { -1 } else { 1 })
        })
        .unwrap_or(0);
    u64::try_from(seconds - offset).ok()
}
fn timestamp_millis(value: &str) -> Option<u64> {
    if let Ok(number) = value.parse::<u64>() {
        return Some(if number > 10_000_000_000 {
            number
        } else {
            number * 1000
        });
    }
    let fraction = value
        .get(19..)?
        .strip_prefix('.')
        .map(|suffix| {
            let digits: String = suffix
                .chars()
                .take_while(char::is_ascii_digit)
                .take(3)
                .collect();
            let padded = format!("{digits:0<3}");
            padded.parse::<u64>().unwrap_or(0)
        })
        .unwrap_or(0);
    Some(timestamp(value)? * 1000 + fraction)
}
pub(super) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn age(timestamp: Option<u64>, now: u64) -> String {
    let Some(time) = timestamp else {
        return String::new();
    };
    let age = now.saturating_sub(time);
    if age < 60 {
        "now".into()
    } else if age < 3600 {
        format!("{}m", age / 60)
    } else if age < 86400 {
        format!("{}h", age / 3600)
    } else {
        format!("{}d", age / 86400)
    }
}
pub(super) fn group(s: &Session, now: u64) -> &'static str {
    if s.status == "archived" {
        return "Archived";
    }
    let Some(time) = timestamp(&s.last_message_at) else {
        return "Older";
    };
    let midnight = calendar::midnight(now);
    if time >= midnight {
        "Today"
    } else if midnight.saturating_sub(time) < 7 * 86400 {
        "Previous 7 days"
    } else if midnight.saturating_sub(time) < 30 * 86400 {
        "Previous 30 days"
    } else {
        "Older"
    }
}
pub(super) fn rows(
    sessions: &[Session],
    query: &str,
    matches: &HashSet<String>,
    expanded: &HashSet<String>,
    branches: &HashSet<String>,
) -> Vec<Row> {
    let query = query.trim().to_lowercase();
    let now = now();
    let mut visible: Vec<_> = sessions
        .iter()
        .filter(|s| {
            query.is_empty()
                || format!(
                    "{} {} {}",
                    s.title,
                    s.status,
                    s.repo_path.as_deref().unwrap_or("Unassigned")
                )
                .to_lowercase()
                .contains(&query)
                || matches.contains(&s.id)
        })
        .collect();
    visible.sort_by(|a, b| {
        timestamp_millis(&b.last_message_at)
            .cmp(&timestamp_millis(&a.last_message_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    let header = |kind: &str, title: &str, status: &str| Row {
        kind: kind.into(),
        workspace: String::new(),
        id: None,
        title: title.into(),
        status: status.into(),
        unread: false,
        running: false,
        age: String::new(),
        branch: false,
        attention: false,
    };
    let mut rows = vec![header("section", "Recents", "")];
    for name in [
        "Today",
        "Previous 7 days",
        "Previous 30 days",
        "Older",
        "Archived",
    ] {
        let group: Vec<_> = visible
            .iter()
            .copied()
            .filter(|s| group(s, now) == name)
            .collect();
        if group.is_empty() {
            continue;
        }
        rows.push(header("section", name, ""));
        let count = if !query.is_empty() || expanded.contains(name) {
            group.len()
        } else {
            group.len().min(12)
        };
        for s in group.iter().take(count) {
            rows.push(Row {
                kind: "thread".into(),
                workspace: s.repo_path.clone().unwrap_or_else(|| "Unassigned".into()),
                id: Some(s.id.clone()),
                title: s.title.clone(),
                status: s.status.clone(),
                unread: s.unread,
                running: sidebar::working(s),
                age: age(timestamp(&s.last_message_at), now),
                branch: branches.contains(&s.id)
                    || s.packet_header
                        .as_ref()
                        .and_then(|h| h["branch"].as_str())
                        .is_some_and(|b| !b.is_empty()),
                attention: sidebar::rank(s) > 0 || s.unread,
            });
        }
        if count < group.len() {
            rows.push(header(
                "more",
                &format!("Show {} more", group.len() - count),
                name,
            ));
        }
    }
    rows
}

#[path = "calendar.rs"]
mod calendar;
