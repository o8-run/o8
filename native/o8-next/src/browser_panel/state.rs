//! Durable page metadata only, following lib/browser/pane-state.ts. No website data.
use super::model::Tab;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub tabs: Vec<Tab>,
    pub active: Option<u64>,
    pub updated_at: u64,
}
// Sanitize at the shell file boundary too, so loading and autosaving an older
// snapshot cannot put a sensitive address back on disk before Browser opens.
#[derive(Serialize, Deserialize)]
struct StoredSnapshot {
    tabs: Vec<Tab>,
    active: Option<u64>,
    updated_at: u64,
}
impl Serialize for Snapshot {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let clean = Self::durable(&self.tabs, self.active);
        StoredSnapshot {
            tabs: clean.tabs,
            active: clean.active,
            updated_at: self.updated_at,
        }
        .serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for Snapshot {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let stored = StoredSnapshot::deserialize(deserializer)?;
        let mut clean = Self::durable(&stored.tabs, stored.active).restored();
        clean.updated_at = stored.updated_at;
        Ok(clean)
    }
}
pub(super) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
impl Snapshot {
    pub(super) fn durable(tabs: &[Tab], active: Option<u64>) -> Self {
        let tabs: Vec<_> = tabs.iter().take(20).cloned().map(durable_tab).collect();
        let active = active
            .filter(|id| tabs.iter().any(|tab| tab.id == *id))
            .or_else(|| tabs.first().map(|tab| tab.id));
        Self {
            tabs,
            active,
            updated_at: now(),
        }
    }
    pub(super) fn restored(self) -> Self {
        let mut snapshot = Self::durable(&self.tabs, self.active);
        let mut seen = std::collections::HashSet::new();
        snapshot.tabs.retain(|tab| seen.insert(tab.id));
        snapshot.active = snapshot
            .active
            .filter(|id| snapshot.tabs.iter().any(|tab| tab.id == *id))
            .or_else(|| snapshot.tabs.first().map(|tab| tab.id));
        snapshot
    }
}
fn durable_tab(mut tab: Tab) -> Tab {
    tab.title = tab.title.chars().take(300).collect();
    if tab.url.is_empty() {
        return tab;
    }
    let sensitive = |url: &url::Url| {
        !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query_pairs().any(|(name, value)| {
                let name: String = name
                    .to_lowercase()
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric())
                    .collect();
                let lower = value.to_ascii_lowercase();
                ["auth", "code", "key", "sig", "state"].contains(&name.as_str())
                || name.starts_with("xamz")
                || name.starts_with("xgoog")
                || [
                    "accesskey",
                    "apikey",
                    "authorization",
                    "credential",
                    "jwt",
                    "keypair",
                    "password",
                    "passwd",
                    "secret",
                    "session",
                    "signature",
                    "ticket",
                    "token",
                ]
                .iter()
                .any(|part| name.contains(part))
                || lower.starts_with("bearer ")
                || lower.starts_with("sk-")
                || regex::Regex::new(
                    r"(?i)^(gh[pousr]_|eyJ[a-zA-Z0-9_-]+\.|[a-zA-Z0-9_-]{48,}\.[a-zA-Z0-9_-]{12,})",
                )
                .unwrap()
                .is_match(&value)
                || value.encode_utf16().count() > 96
            })
    };
    if let Ok(mut url) = url::Url::parse(&tab.url)
        && tab.url.len() <= 4096
        && !sensitive(&url)
    {
        url.set_fragment(None);
        tab.url = url.into();
        tab.redacted = false;
    } else {
        tab.url.clear();
        tab.title = "Navigation required".into();
        tab.redacted = true;
    }
    tab
}

/// Classic keeps the most recently touched 24 scopes for 45 days, including empty scopes.
pub fn save_pages(state: &mut crate::shell_state::State, workspace: &str, snapshot: Snapshot) {
    let now = snapshot.updated_at;
    state.browser_pages.insert(workspace.into(), snapshot);
    state.browser_pages.retain(|scope, pages| {
        scope == workspace || now.saturating_sub(pages.updated_at) <= 45 * 24 * 60 * 60 * 1000
    });
    while state.browser_pages.len() > 24 {
        let oldest = state
            .browser_pages
            .iter()
            .filter(|(scope, _)| *scope != workspace)
            .min_by_key(|(_, pages)| pages.updated_at)
            .map(|(scope, _)| scope.clone());
        if let Some(oldest) = oldest {
            state.browser_pages.remove(&oldest);
        } else {
            break;
        }
    }
}
