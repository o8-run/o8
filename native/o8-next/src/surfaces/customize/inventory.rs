//! The inventories Customize lists: instructions, skills and connections.
use crate::client::Client;
use serde_json::Value;

#[derive(Clone)]
pub(super) struct Row {
    pub id: String,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub scope: String,
}
#[derive(Clone, Default)]
pub(super) struct Inventory {
    pub rows: Vec<(String, Row)>,
}
impl Inventory {
    pub fn load(client: &Client, repo: Option<&str>) -> Result<Self, String> {
        let query = repo.map(|r| vec![("repo", r)]).unwrap_or_default();
        let inventory: Value = client.get("/api/customize/inventory", &query)?;
        if inventory["ok"] != true {
            return Err("Could not load local customizations. Try again.".into());
        }
        let query = repo.map(|r| vec![("repoPath", r)]).unwrap_or_default();
        let rules: Value = client.get("/api/cortex/directives", &query)?;
        let connections: Value = client.get("/api/setup/mcp-servers", &[])?;
        if ["agents", "skills", "hooks"]
            .iter()
            .any(|kind| !inventory[*kind].is_array())
            || !rules["directives"].is_array()
            || !connections["servers"].is_array()
        {
            return Err(
                "The server returned an invalid customization inventory. Try again.".into(),
            );
        }
        let mut result = Self::default();
        for kind in ["agents", "skills", "hooks"] {
            for item in inventory[kind].as_array().into_iter().flatten() {
                if repo.is_none() && item["scope"] == "project" {
                    continue;
                }
                let title = item[if kind == "hooks" { "event" } else { "name" }]
                    .as_str()
                    .unwrap_or("")
                    .to_owned();
                let body = if kind == "hooks" {
                    "command".to_owned()
                } else {
                    item["description"].as_str().unwrap_or("").to_owned()
                };
                result.rows.push((
                    kind.into(),
                    Row {
                        id: item["file"].as_str().unwrap_or("").into(),
                        title,
                        body,
                        tags: vec![],
                        scope: item["scope"].as_str().unwrap_or("").into(),
                    },
                ));
            }
        }
        for item in rules["directives"].as_array().into_iter().flatten() {
            if repo.is_none() && item["scope"] != "global" && item["scope"] != "" {
                continue;
            }
            // Indexed documentation is reference material, not authored guidance.
            if item["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("spec-ingest:"))
            {
                continue;
            }
            result.rows.push((
                "rules".into(),
                Row {
                    id: item["id"].as_str().unwrap_or("").into(),
                    title: item["title"].as_str().unwrap_or("").into(),
                    body: item["body"].as_str().unwrap_or("").into(),
                    tags: vec![],
                    scope: item["scope"].as_str().unwrap_or("").into(),
                },
            ));
        }
        for (id, title) in [("o8-operator", "o8 operator"), ("cortex", "cortex")] {
            result.rows.push((
                "connections".into(),
                Row {
                    id: id.into(),
                    title: title.into(),
                    body: String::new(),
                    tags: vec![],
                    scope: "global".into(),
                },
            ));
        }
        for item in connections["servers"].as_array().into_iter().flatten() {
            result.rows.push((
                "connections".into(),
                Row {
                    id: item["id"].as_str().unwrap_or("").into(),
                    title: item["name"].as_str().unwrap_or("").into(),
                    body: if item["transport"] == "http" {
                        let host = item["url"]
                            .as_str()
                            .or(item["command"].as_str())
                            .and_then(|s| url::Url::parse(s).ok())
                            .and_then(|u| u.host_str().map(str::to_owned));
                        host.map(|host| format!("http · {host}"))
                            .unwrap_or_else(|| "http".into())
                    } else {
                        "stdio".into()
                    },
                    tags: vec![],
                    scope: "global".into(),
                },
            ));
        }
        result.rows.sort_by(|(_, a), (_, b)| {
            (a.scope != "project")
                .cmp(&(b.scope != "project"))
                .then_with(|| a.title.cmp(&b.title))
        });
        Ok(result)
    }
}
