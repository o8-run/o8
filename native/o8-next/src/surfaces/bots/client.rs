use crate::client::Client;
use serde::Deserialize;

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub(crate) struct BotIcon {
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct BotThreadRef {
    pub kind: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

/// One entry of `GET /api/bots` (src/lib/bots/registry.ts `BotEntry`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BotEntry {
    pub id: String,
    pub house: String,
    pub name: String,
    #[serde(default)]
    pub icon: BotIcon,
    #[serde(default)]
    pub main_thread: Option<BotThreadRef>,
    #[serde(default)]
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct MailboxMessage {
    pub id: String,
    /// Record provenance is separate from the producer's public id. Older
    /// servers omit it, retaining the previous best-effort id matching.
    #[serde(default)]
    pub key: Option<String>,
    pub role: String,
    pub text: String,
    #[serde(default)]
    pub at: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BotThread {
    pub bot: BotEntry,
    #[serde(default)]
    pub messages: Vec<MailboxMessage>,
    #[serde(default)]
    pub external_url: Option<String>,
}

#[derive(Deserialize)]
struct BotList {
    bots: Vec<BotEntry>,
}

pub(crate) fn encode(id: &str) -> String {
    id.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

impl Client {
    pub fn bots(&self) -> Result<Vec<BotEntry>, String> {
        self.get::<BotList>("/api/bots", &[]).map(|l| l.bots)
    }
    pub(crate) fn bot_thread(&self, id: &str) -> Result<BotThread, String> {
        self.get::<BotThread>(&format!("/api/bots/{}/thread", encode(id)), &[])
    }
}
