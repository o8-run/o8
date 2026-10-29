//! Wire timestamps (epoch numbers or ISO 8601) and the compact ages the desktop
//! lists show ("now", "14m", "3h", "2d").
pub fn timestamp(value: &str) -> Option<u64> {
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

pub fn age(timestamp: Option<u64>, now: u64) -> String {
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

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
