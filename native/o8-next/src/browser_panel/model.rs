//! Page collection and URL rules ported from O8BrowserPane and lib/browser/url.ts.
use serde::{Deserialize, Serialize};

pub fn normalize(raw: &str) -> String {
    // ECMAScript String.trim includes BOM and excludes Unicode NEL.
    let value = raw.trim_matches(|ch: char| {
        matches!(ch,
            '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
            '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
            '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    });
    if value.is_empty() {
        return String::new();
    }
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return value.into();
    }
    let ipv4_prefix = regex::Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+")
        .unwrap()
        .is_match(value);
    format!(
        "{}://{value}",
        if value.starts_with("localhost") || ipv4_prefix {
            "http"
        } else {
            "https"
        }
    )
}

pub(super) fn title(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(parsed) => match parsed.host_str().unwrap_or("") {
            "localhost" | "127.0.0.1" => format!("localhost:{}", parsed.port().unwrap_or(80)),
            host => host.strip_prefix("www.").unwrap_or(host).into(),
        },
        Err(_) => {
            if url.is_empty() {
                "New Tab".into()
            } else {
                url.into()
            }
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tab {
    pub id: u64,
    pub url: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub redacted: bool,
}

/// Same neighbor rule as classic closeTab: prefer the page on the right.
pub(super) fn close(tabs: &mut Vec<Tab>, active: &mut Option<u64>, id: u64) {
    let Some(index) = tabs.iter().position(|tab| tab.id == id) else {
        return;
    };
    tabs.remove(index);
    if *active == Some(id) {
        *active = tabs
            .get(index.min(tabs.len().saturating_sub(1)))
            .map(|tab| tab.id);
    }
}

pub(super) fn reorder(tabs: &mut Vec<Tab>, from: u64, target: u64, after: bool) {
    if from == target || !tabs.iter().any(|tab| tab.id == target) {
        return;
    }
    let Some(index) = tabs.iter().position(|tab| tab.id == from) else {
        return;
    };
    let tab = tabs.remove(index);
    let index = tabs.iter().position(|tab| tab.id == target).unwrap();
    tabs.insert(index + usize::from(after), tab);
}
