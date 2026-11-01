//! Delivery is evidence from the correlated send, never merely a saved prompt.
use crate::model::Entry;
use serde_json::Value;

pub(super) fn timestamp(entry: &Entry) -> Option<u64> {
    match entry.extra.get("timestamp")? {
        Value::Number(n) => n.as_f64().filter(|n| n.is_finite() && *n >= 0.).map(|n| {
            if n > 10_000_000_000. {
                (n / 1000.) as u64
            } else {
                n as u64
            }
        }),
        Value::String(s) => crate::clock::timestamp(s),
        _ => None,
    }
}

pub(super) fn relative(time: u64, now: u64) -> String {
    let age = now.saturating_sub(time);
    if age < 60 {
        "just now".into()
    } else if age < 3600 {
        format!(
            "{} minute{} ago",
            age / 60,
            if age < 120 { "" } else { "s" }
        )
    } else if age < 86400 {
        format!(
            "{} hour{} ago",
            age / 3600,
            if age < 7200 { "" } else { "s" }
        )
    } else {
        format!(
            "{} day{} ago",
            age / 86400,
            if age < 172800 { "" } else { "s" }
        )
    }
}

pub(super) fn absolute(time: u64) -> String {
    #[cfg(unix)]
    if let Ok(time) = libc::time_t::try_from(time) {
        let mut date = std::mem::MaybeUninit::<libc::tm>::uninit();
        let mut buffer = [0_u8; 96];
        // localtime_r writes only the provided tm; strftime is bounded by buffer.len().
        unsafe {
            if !libc::localtime_r(&time, date.as_mut_ptr()).is_null() {
                let count = libc::strftime(
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    c"%b %d, %Y, %I:%M:%S %p %Z".as_ptr(),
                    date.as_ptr(),
                );
                if count > 0 {
                    return String::from_utf8_lossy(&buffer[..count]).into_owned();
                }
            }
        }
    }
    format!("{time} seconds since 1970-01-01 UTC")
}

pub(super) fn delivery(entry: &Entry) -> (bool, &'static str) {
    if entry.extra.get("deliveryConfirmed") == Some(&Value::Bool(true)) {
        (
            true,
            "Delivery confirmed by the agent connection. This is not a completion receipt.",
        )
    } else {
        (
            false,
            "Saved. Delivery to the agent has not been confirmed.",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompt_metadata_uses_recorded_time_and_explicit_delivery() {
        let entry = |extra| Entry {
            id: "ask".into(),
            role: "user".into(),
            text: "hello".into(),
            tools: None,
            extra,
        };
        let mut e = entry(Default::default());
        assert!(!delivery(&e).0, "persistence alone is not acknowledgement");
        e.extra
            .insert("deliveryConfirmed".into(), Value::Bool(true));
        assert!(delivery(&e).0);
        e.extra
            .insert("timestamp".into(), serde_json::json!(1793433300000_u64));
        let time = timestamp(&e).unwrap();
        assert_eq!(relative(time, time + 120), "2 minutes ago");
        assert_eq!(relative(time, time + 3600), "1 hour ago");
        assert!(absolute(time).contains("2026"));
        e.extra.insert("timestamp".into(), Value::Null);
        assert!(timestamp(&e).is_none());
    }
}
