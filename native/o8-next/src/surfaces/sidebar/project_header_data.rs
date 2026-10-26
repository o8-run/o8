//! Presentation metadata comes from the desktop's canonical project read model.
use crate::{
    client::Client,
    projects_model::{Ledger, Repo},
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Deserialize)]
pub(crate) struct Identity {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
}
#[derive(Default, Clone)]
pub(crate) struct HeaderSnapshot {
    pub ledger: Ledger,
    pub repos: Vec<Repo>,
    pub identities: HashMap<String, Identity>,
}
impl HeaderSnapshot {
    pub(crate) fn load(client: &Client) -> Result<Self, String> {
        #[derive(Deserialize)]
        struct Repos {
            repos: Vec<Repo>,
        }
        let repos: Repos = client.get("/api/panel/repos", &[])?;
        Self::with_repos(client, repos.repos)
    }
    pub(super) fn with_repos(client: &Client, repos: Vec<Repo>) -> Result<Self, String> {
        #[derive(Deserialize)]
        struct Names {
            projects: Vec<Identity>,
        }
        let wire: Value = client.get("/api/panel/projects", &[])?;
        let ledger = serde_json::from_value(wire.clone())
            .map_err(|e| format!("Invalid project ledger: {e}"))?;
        let names: Names =
            serde_json::from_value(wire).map_err(|e| format!("Invalid project identities: {e}"))?;
        Ok(Self {
            ledger,
            repos,
            identities: names
                .projects
                .into_iter()
                .map(|p| (p.id.clone(), p))
                .collect(),
        })
    }
}
