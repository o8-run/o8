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
    /// Appends the operator's reply to the bot's mailbox.
    pub(crate) fn bot_reply(&self, id: &str, text: &str) -> Result<(), String> {
        let url = self
            .url(&format!("/api/bots/{}/thread", encode(id)))
            .map_err(|e| e.to_string())?;
        let response = self
            .request("POST", &url)
            .send_json(serde_json::json!({ "text": text }))
            .map_err(|e| match e {
                ureq::Error::Status(code, _) => format!("Reply rejected (HTTP {code})."),
                _ => "Reply is unconfirmed. Refresh before retrying.".into(),
            })?;
        Self::read::<serde_json::Value>(response).map(|_| ())
    }
    /// The operator MCP bridge endpoint (docs/user/operator-mcp-bridge.md).
    /// Token-gated; the token is not part of the copied URL.
    pub(crate) fn mcp_url(&self) -> Option<String> {
        self.url("/api/mcp").ok().map(|u| mcp_url(u.as_str()))
    }
    pub(crate) fn bot_thread(&self, id: &str) -> Result<BotThread, String> {
        self.get::<BotThread>(&format!("/api/bots/{}/thread", encode(id)), &[])
    }
}

/// Drops any query (a token) so a copied URL never carries a secret.
pub(crate) fn mcp_url(raw: &str) -> String {
    raw.split(['?', '#']).next().unwrap_or(raw).to_owned()
}
