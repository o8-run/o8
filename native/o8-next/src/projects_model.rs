//! Desktop project/store and registry wire shapes. No alternate persistence layer.
use crate::client::Client;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub repo_id: String,
    pub role: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub description: Option<String>,
    pub main_repo_id: Option<String>,
    pub repos: Vec<Link>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub id: String,
    pub name: String,
    pub local_path: String,
    pub exists: bool,
    /// The listing's icon override or image; older hosts send none.
    #[serde(default, deserialize_with = "crate::project_icon::lenient")]
    pub icon: Option<crate::project_icon::Icon>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerProject {
    pub id: String,
    pub sqlite_project_id: Option<String>,
    pub repo_paths: Vec<String>,
}
#[derive(Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    pub projects: Vec<LedgerProject>,
    pub active_project_id: String,
}
#[derive(Default, Clone)]
pub struct Snapshot {
    pub projects: Vec<Project>,
    pub repos: Vec<Repo>,
    pub ledger: Ledger,
}
impl Snapshot {
    pub fn load(client: &Client) -> Result<Self, String> {
        #[derive(Deserialize)]
        struct Projects {
            projects: Vec<Project>,
        }
        #[derive(Deserialize)]
        struct Repos {
            repos: Vec<Repo>,
        }
        let projects: Projects = client.get("/api/projects", &[])?;
        let repos: Repos = client.get("/api/panel/repos", &[])?;
        let ledger = client.get("/api/panel/projects", &[])?;
        Ok(Self {
            projects: projects.projects,
            repos: repos.repos,
            ledger,
        })
    }
    pub fn workspace(&self, project: &Project) -> Option<&Repo> {
        let id = project
            .main_repo_id
            .as_deref()
            .or_else(|| project.repos.first().map(|r| r.repo_id.as_str()))?;
        self.repos.iter().find(|r| r.id == id)
    }
}
pub const ROLES: &[&str] = &[
    "",
    "frontend",
    "backend",
    "fullstack",
    "mobile",
    "library",
    "service",
    "infra",
    "docs",
    "site",
    "shared",
];
pub fn route(id: &str) -> String {
    let encoded: String = url::form_urlencoded::byte_serialize(id.as_bytes()).collect();
    format!("/api/projects/{encoded}")
}
pub fn member_route(project: &str, repo: &str) -> String {
    format!(
        "{}/repos/{}",
        route(project),
        route(repo).trim_start_matches("/api/projects/")
    )
}
#[derive(Clone)]
pub enum Action {
    Save {
        id: Option<String>,
        name: String,
        slug: String,
        description: String,
    },
    Delete(String),
    Link(String, String),
    Unlink(String, String),
    Main(String, String),
    Role(String, String, Option<String>),
    Validate(String),
    Register(String, Option<String>),
    Remove(String),
    /// Stable project and repository IDs; the folder is resolved at dispatch.
    Open(String, String),
    /// A repository's icon patch: `projectIcon` and/or `faviconPath`.
    Icon(String, Value),
    Activate(String),
}
pub struct Outcome {
    pub snapshot: Snapshot,
    pub validation: Option<Value>,
    pub workspace: Option<WorkspaceChange>,
}
pub enum WorkspaceChange {
    Select(Option<String>),
    Open(String),
}
impl Action {
    pub fn run(&self, client: &Client) -> Result<Outcome, String> {
        let request =
            |method: &str, path: &str, body: Value| client.project_request(method, path, &body);
        let mut validation = None;
        let mut workspace = None;
        let mut open_repo = None;
        match self {
            Self::Save {
                id,
                name,
                slug,
                description,
            } => {
                if name.trim().is_empty() {
                    return Err("Project name is required.".into());
                }
                let current = Snapshot::load(client)?;
                let requested_name = name.trim().to_lowercase();
                if current.projects.iter().any(|p| {
                    Some(&p.id) != id.as_ref() && p.name.trim().to_lowercase() == requested_name
                }) {
                    return Err(
                        "A project with this name already exists. Choose another name.".into(),
                    );
                }
                let body = json!({"name":name.trim(),"description":description.trim()});
                if let Some(id) = id {
                    // The panel rename updates both stores while preserving the
                    // caller's project ID. Names and slugs never select a mutation.
                    request(
                        "PATCH",
                        &route(id).replacen("/api/projects/", "/api/panel/projects/", 1),
                        json!({"name":name.trim()}),
                    )?;
                    request(
                        "PATCH",
                        &route(id),
                        json!({"description":description.trim()}),
                    )?;
                } else {
                    let mut body = body;
                    if !slug.trim().is_empty() {
                        body["slug"] = json!(slug.trim());
                    }
                    body["suggestionOrigin"] = json!("manual");
                    request("POST", "/api/projects", body)?;
                }
            }
            Self::Delete(id) => {
                request(
                    "DELETE",
                    &route(id).replacen("/api/projects/", "/api/panel/projects/", 1),
                    json!({}),
                )?;
            }
            Self::Link(id, repo) => {
                request(
                    "POST",
                    &format!("{}/repos", route(id)),
                    json!({"repoId":repo,"role":null}),
                )?;
            }
            Self::Unlink(id, repo) => {
                request("DELETE", &member_route(id, repo), json!({}))?;
            }
            Self::Main(id, repo) => {
                request("PATCH", &route(id), json!({"mainRepoId":repo}))?;
            }
            Self::Role(id, repo, role) => {
                request("PATCH", &member_route(id, repo), json!({"role":role}))?;
            }
            Self::Validate(path) => {
                validation = Some(
                    request(
                        "POST",
                        "/api/panel/repos",
                        json!({"action":"validate","localPath":path.trim()}),
                    )?["repo"]
                        .clone(),
                );
            }
            Self::Register(path, project) => {
                let validated = request(
                    "POST",
                    "/api/panel/repos",
                    json!({"action":"validate","localPath":path.trim()}),
                )?;
                let canonical = validated["repo"]["localPath"]
                    .as_str()
                    .ok_or("Invalid repository validation")?;
                let current: Value = request("GET", "/api/panel/repos", json!({}))?;
                let known = current["repos"]
                    .as_array()
                    .and_then(|repos| repos.iter().find(|r| r["localPath"] == canonical))
                    .cloned();
                let repo = if let Some(known) = known {
                    known
                } else {
                    match request(
                        "POST",
                        "/api/panel/repos",
                        json!({"action":"add","localPath":canonical}),
                    ) {
                        Ok(result) => result["repo"].clone(),
                        Err(error) => {
                            let check = request("GET", "/api/panel/repos", json!({}))?;
                            check["repos"]
                                .as_array()
                                .and_then(|repos| {
                                    repos.iter().find(|r| r["localPath"] == canonical)
                                })
                                .cloned()
                                .ok_or(error)?
                        }
                    }
                };
                if let Some(id) = project {
                    let repo_id = repo["id"].as_str().ok_or("Invalid registered repository")?;
                    let link = || -> Result<(), String> {
                        let projects = request("GET", "/api/projects", json!({}))?;
                        let linked = projects["projects"]
                            .as_array()
                            .and_then(|projects| projects.iter().find(|p| p["id"] == id.as_str()))
                            .and_then(|p| p["repos"].as_array())
                            .is_some_and(|links| {
                                links.iter().any(|link| link["repoId"] == repo_id)
                            });
                        if !linked {
                            request(
                                "POST",
                                &format!("{}/repos", route(id)),
                                json!({"repoId":repo_id,"role":null}),
                            )?;
                        }
                        Ok(())
                    };
                    link().map_err(|error| format!("Repository registered; project link failed. Retry adding to reuse the entry. {error}"))?;
                }
            }
            Self::Remove(id) => {
                request("DELETE", "/api/panel/repos", json!({"id":id}))?;
            }
            Self::Icon(id, patch) => {
                let mut body = patch.clone();
                body["action"] = json!("update-icon");
                body["id"] = json!(id);
                request("POST", "/api/panel/repos", body)?;
            }
            Self::Open(project, repo_id) => {
                request(
                    "POST",
                    "/api/panel/projects/active",
                    json!({"projectId":project}),
                )?;
                open_repo = Some(repo_id);
            }
            Self::Activate(id) => {
                let ledger = request(
                    "POST",
                    "/api/panel/projects/active",
                    json!({"projectId":id}),
                )?;
                let path = ledger["projects"]
                    .as_array()
                    .and_then(|projects| {
                        projects
                            .iter()
                            .find(|p| p["id"] == id.as_str() || p["sqliteProjectId"] == id.as_str())
                    })
                    .and_then(|p| p["repoPaths"].as_array())
                    .and_then(|paths| paths.first())
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                workspace = Some(WorkspaceChange::Select(path));
            }
        }
        let snapshot = Snapshot::load(client)?;
        if let Some(id) = open_repo {
            let repo = snapshot
                .repos
                .iter()
                .find(|repo| &repo.id == id)
                .ok_or("Repository is no longer registered. Refresh Projects.")?;
            if !repo.exists {
                return Err("Repository folder is missing. Locate it before opening.".into());
            }
            workspace = Some(WorkspaceChange::Open(repo.local_path.clone()));
        }
        Ok(Outcome {
            snapshot,
            validation,
            workspace,
        })
    }
}
