//! Presentation descriptors only; records remain owned by the desktop routes.
use super::*;

pub(super) use crate::clock::timestamp;
use crate::clock::age;
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
pub(crate) mod calendar;
