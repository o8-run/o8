//! Existing desktop Activity contracts. No provider credentials or new routes.
use crate::client::Client;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct ReadError {
    pub message: String,
    pub status: Option<u16>,
    pub retry: u64,
}
impl ReadError {
    pub fn invalid() -> Self {
        Self {
            message: "Invalid Activity response".into(),
            status: None,
            retry: 0,
        }
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub name: String,
    pub local_path: String,
    pub remote_url: Option<String>,
}
impl Repo {
    /// Local-only repositories still need a stable identity. Use the registered
    /// canonical root, so clones/worktrees differ and aliases of one root agree.
    fn identity(&self) -> String {
        self.slug().unwrap_or_else(|| {
            let root = std::fs::canonicalize(&self.local_path)
                .unwrap_or_else(|_| self.local_path.clone().into());
            format!("local:{}", root.to_string_lossy())
        })
    }
    pub fn slug(&self) -> Option<String> {
        let raw = self
            .remote_url
            .as_ref()?
            .trim()
            .trim_end_matches('/')
            .trim_end_matches(".git");
        let slug = raw
            .strip_prefix("https://github.com/")
            .or_else(|| raw.strip_prefix("git@github.com:"))?;
        valid_slug(slug).then(|| slug.to_lowercase())
    }
}
pub fn valid_slug(slug: &str) -> bool {
    let parts: Vec<_> = slug.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|p| {
            !p.is_empty()
                && *p != "."
                && *p != ".."
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        })
}
#[derive(Clone, Debug)]
pub struct Row {
    pub kind: &'static str,
    pub id: String,
    pub repo: Option<String>,
    pub repo_identity: String,
    pub title: String,
    pub date: String,
    pub data: Value,
    pub ci: Option<Box<Row>>,
}
impl Row {
    pub fn key(&self) -> String {
        format!("{}-{}-{}", self.kind, self.repo_identity, self.id)
    }
    pub fn selector(&self) -> String {
        format!("activity-row-{}", self.key())
    }
    pub fn url(&self) -> Option<String> {
        let repo = self.repo.as_deref().filter(|s| valid_slug(s))?;
        let path = match self.kind {
            "pr" => "pull",
            "issue" => "issues",
            "ci" => "actions/runs",
            "commit" => "commit",
            _ => return None,
        };
        if !self.id.chars().all(|c| c.is_ascii_alphanumeric()) {
            return None;
        }
        Some(format!("https://github.com/{repo}/{path}/{}", self.id))
    }
}
pub fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or("").into()
}
fn id(value: &Value, key: &str) -> String {
    value[key]
        .as_u64()
        .map(|n| n.to_string())
        .unwrap_or_default()
}
fn rows(
    value: &Value,
    field: &str,
    kind: &'static str,
    repo: Option<String>,
    repo_identity: &str,
    limit: usize,
) -> Result<Vec<Row>, ReadError> {
    let array = value[field].as_array().ok_or_else(ReadError::invalid)?;
    array
        .iter()
        .take(limit)
        .map(|v| {
            let (identity, title, date) = match kind {
                "commit" => (
                    v["hash"]
                        .as_str()
                        .or(v["shortSha"].as_str())
                        .unwrap_or("")
                        .to_owned(),
                    v["message"]
                        .as_str()
                        .or(v["subject"].as_str())
                        .unwrap_or("")
                        .to_owned(),
                    text(v, "date"),
                ),
                "pr" => (
                    id(v, "number"),
                    format!("#{} {}", id(v, "number"), text(v, "title")),
                    text(v, "createdAt"),
                ),
                "issue" => (
                    id(v, "number"),
                    format!("#{} {}", id(v, "number"), text(v, "title")),
                    text(v, "createdAt"),
                ),
                _ => (
                    id(v, "databaseId"),
                    text(v, "displayTitle"),
                    text(v, "createdAt"),
                ),
            };
            if identity.is_empty() || title.is_empty() {
                return Err(ReadError::invalid());
            }
            Ok(Row {
                kind,
                id: identity,
                repo: repo.clone(),
                repo_identity: repo_identity.into(),
                title,
                date,
                data: v.clone(),
                ci: None,
            })
        })
        .collect()
}
#[derive(Clone, Default)]
pub struct Streams {
    pub remote: HashMap<&'static str, Vec<Row>>,
}
#[derive(Default)]
pub struct Snapshot {
    pub rows: Vec<Row>,
    pub errors: Vec<String>,
    pub cache: HashMap<String, Streams>,
    pub mission: Value,
}

pub fn load(client: &Client, targets: &[Repo], previous: HashMap<String, Streams>) -> Snapshot {
    let mut out = Snapshot {
        cache: previous,
        ..Default::default()
    };
    for target in targets {
        let slug = target.slug();
        let identity = target.identity();
        let key = format!("{}|{}", target.local_path, slug.as_deref().unwrap_or(""));
        let cache = out.cache.entry(key).or_default();
        for (endpoint, field, kind, limit) in [
            ("commits", "commits", "commit", 12),
            ("prs", "prs", "pr", 8),
            ("issues", "issues", "issue", 8),
            ("ci", "runs", "ci", 6),
        ] {
            let read = slug.as_ref().map(|slug| {
                client
                    .activity_request(
                        "GET",
                        &format!("/api/panel/{endpoint}"),
                        &[("repo", slug)],
                        None,
                    )
                    .and_then(|v| rows(&v, field, kind, Some(slug.clone()), &identity, limit))
            });
            match read {
                Some(Ok(rows)) => {
                    cache.remote.insert(kind, rows);
                }
                Some(Err(_)) => {
                    if !out.errors.iter().any(|s| s.starts_with("GitHub")) {
                        out.errors.push("GitHub sync delayed. Showing last successful activity where available.".into());
                    }
                }
                None => {
                    cache.remote.remove(kind);
                }
            }
        }
        let mut commits = cache.remote.get("commit").cloned().unwrap_or_default();
        if !target.local_path.is_empty() {
            let local = client
                .activity_request(
                    "GET",
                    "/api/panel/commits",
                    &[("workspace", &target.local_path), ("limit", "50")],
                    None,
                )
                .and_then(|v| rows(&v, "commits", "commit", slug.clone(), &identity, 50));
            match local {
                Ok(local) if commits.is_empty() => commits = local,
                Err(_) => out.errors.push(
                    "Could not load local commit activity. Retry to check this folder again."
                        .into(),
                ),
                _ => {}
            }
        }
        out.rows.extend(commits);
        for kind in ["pr", "issue", "ci"] {
            out.rows
                .extend(cache.remote.get(kind).cloned().unwrap_or_default());
        }
    }
    match client.activity_request("GET", "/api/orchestrator/state", &[], None) {
        Ok(state) => {
            out.mission = state["mission"].clone();
            for packet in out.mission["packets"].as_array().into_iter().flatten() {
                if packet["archivedAt"].as_str().is_some_and(|s| !s.is_empty())
                    || packet["comparisonIndex"].as_u64().is_some_and(|n| n > 0)
                {
                    continue;
                }
                out.rows.push(Row {
                    kind: "packet",
                    id: text(packet, "id"),
                    repo: None,
                    repo_identity: "local".into(),
                    title: text(packet, "title"),
                    date: packet["lane"]["lastEventAt"]
                        .as_str()
                        .or(packet["lastEventAt"].as_str())
                        .unwrap_or("")
                        .into(),
                    data: packet.clone(),
                    ci: None,
                });
            }
        }
        Err(error) => out.errors.push(error.message),
    }
    // Group only matching stable repository/SHA pairs, including local roots.
    let mut grouped = vec![];
    for row in &out.rows {
        if row.kind == "ci" {
            let sha = text(&row.data, "headSha").to_lowercase();
            if !sha.is_empty()
                && let Some(commit) = grouped.iter_mut().find(|c: &&mut Row| {
                    c.kind == "commit"
                        && row.repo.is_some()
                        && c.repo_identity == row.repo_identity
                        && sha == c.id.to_lowercase()
                })
            {
                commit.ci = Some(Box::new(row.clone()));
                if row.date > commit.date {
                    commit.date = row.date.clone();
                }
                continue;
            }
        }
        if row.kind != "commit"
            || !grouped
                .iter()
                .any(|c: &Row| c.kind == "commit" && c.key() == row.key())
        {
            grouped.push(row.clone());
        }
    }
    grouped.sort_by(|a, b| b.date.cmp(&a.date));
    grouped.truncate(50);
    out.rows = grouped;
    out
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiDetail {
    pub run: CiRun,
    pub logs: String,
    pub repo: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiRun {
    pub database_id: u64,
    pub jobs: Vec<Job>,
    #[serde(default)]
    pub pull_requests: Vec<Pull>,
}
#[derive(Clone, Deserialize)]
pub struct Job {
    pub name: String,
    pub conclusion: Option<String>,
    #[serde(default)]
    pub steps: Vec<Step>,
}
#[derive(Clone, Deserialize)]
pub struct Step {
    pub name: String,
    pub conclusion: Option<String>,
}
#[derive(Clone, Deserialize)]
pub struct Pull {
    pub number: u64,
}
impl CiDetail {
    pub fn parse(value: Value, row: &Row) -> Result<Self, ReadError> {
        let detail: Self = serde_json::from_value(value).map_err(|_| ReadError::invalid())?;
        if detail.run.database_id.to_string() != row.id
            || detail
                .repo
                .as_ref()
                .is_some_and(|repo| Some(repo.trim().to_lowercase()) != row.repo)
        {
            return Err(ReadError::invalid());
        }
        Ok(detail)
    }
}
