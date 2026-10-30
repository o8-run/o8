//! Classic auto/observation/cross-repo proposals, directive writes and snoozes.
use super::*;
use std::collections::{BTreeSet, HashSet};
#[derive(Default)]
pub(super) struct Proposals {
    pub auto: Vec<Value>,
    pub cross: Vec<Value>,
    pub loading: bool,
    pub errors: Vec<String>,
    pub open: bool,
    pub expanded: HashSet<String>,
    pub snapshot: BTreeSet<String>,
    pub seen: Vec<String>,
    pub auto_opened: bool,
    pub hidden: HashSet<String>,
    pub pending: HashMap<String, &'static str>,
    pub write_ids: HashMap<String, String>,
}
impl Proposals {
    pub fn rows(&self) -> Vec<Value> {
        self.auto
            .iter()
            .chain(&self.cross)
            .filter(|p| !self.hidden.contains(&key(p)))
            .cloned()
            .collect()
    }
}
pub(super) fn key(p: &Value) -> String {
    format!("{}:{}", feed::text(p, "source"), feed::text(p, "id"))
}
pub(super) fn draft(p: &Value) -> String {
    format!(
        "{}\n\n{}",
        if p["source"] == "observation" {
            "Please review and promote the following worker observation if it is worth keeping:"
        } else {
            "Please save the following directive after I review it:"
        },
        feed::text(p, "draftDirective")
    )
}
impl ActivityPane {
    pub(crate) fn load_proposals(&mut self, cx: &mut Context<Self>) {
        if self.proposals.loading {
            return;
        }
        self.proposals.loading = true;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            std::thread::scope(|scope| {
                let auto = scope.spawn(|| read(&client, "/api/cortex/proposals", false));
                let cross = read(&client, "/api/cortex/cross-repo-proposals", true);
                (
                    auto.join().unwrap_or_else(|_| Err(ReadError::invalid())),
                    cross,
                )
            })
        });
        cx.spawn(async move |this, cx| {
            let (auto, cross) = task.await;
            let _ = this.update(cx, |s, cx| {
                s.proposals.loading = false;
                s.proposals.errors.clear();
                for (result, is_cross) in [(auto, false), (cross, true)] {
                    match result {
                        Ok(rows) => {
                            if is_cross {
                                s.proposals.cross = rows;
                            } else {
                                s.proposals.auto = rows;
                            }
                        }
                        Err(e) => s.proposals.errors.push(format!(
                            "{} proposals: {}",
                            if is_cross {
                                "Cross-repository"
                            } else {
                                "Directive"
                            },
                            e.message
                        )),
                    }
                }
                let rows = s.proposals.rows();
                if !s.proposals.auto_opened
                    && rows
                        .iter()
                        .any(|p| !s.proposals.snapshot.contains(&feed::text(p, "id")))
                {
                    s.proposals.open = true;
                    s.proposals.auto_opened = true;
                }
                s.mark_proposals_seen(cx);
                s.restore_scroll();
                s.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
    pub(super) fn proposal_action(&mut self, id: String, accept: bool, cx: &mut Context<Self>) {
        if self.proposals.pending.contains_key(&id) {
            return;
        }
        let Some(p) = self.proposals.rows().into_iter().find(|p| key(p) == id) else {
            return;
        };
        let write_id = self
            .proposals
            .write_ids
            .entry(id.clone())
            .or_insert_with(|| {
                format!(
                    "next-proposal-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                )
            })
            .clone();
        self.proposals.pending.insert(
            id.clone(),
            if accept {
                "Saving directive…"
            } else {
                "Snoozing proposal…"
            },
        );
        self.proposals.errors.clear();
        let client = self.client.clone();
        let repo = if self.scope == "*" {
            self.workspace.clone()
        } else {
            self.scope.clone()
        };
        let candidate = p.clone();
        let task = cx
            .background_executor()
            .spawn(async move { mutate(&client, &candidate, accept, &write_id) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |s, cx| {
                s.proposals.pending.remove(&id);
                match result {
                    Ok(()) => {
                        s.proposals.hidden.insert(id.clone());
                        if accept {
                            cx.emit(ActivityEvent::Draft(repo.clone(), draft(&p)));
                        }
                    }
                    Err(error) => s.proposals.errors.push(error),
                }
                s.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
}
fn read(client: &Client, path: &str, cross: bool) -> Result<Vec<Value>, ReadError> {
    let body = client.activity_request("GET", path, &[], None)?;
    if body["ok"] != true {
        return Err(ReadError::invalid());
    }
    let mut rows = body["proposals"]
        .as_array()
        .cloned()
        .ok_or_else(ReadError::invalid)?;
    rows.retain(|p| p["id"].as_str().is_some_and(|s| !s.is_empty()));
    for p in &mut rows {
        if cross {
            p["source"] = json!("cross-repo");
        } else if p["source"] != "observation" {
            p["source"] = json!("auto");
        }
    }
    Ok(rows)
}
fn post(client: &Client, path: &str, body: Value) -> Result<(), String> {
    let value = client
        .activity_request("POST", path, &[], Some(&body))
        .map_err(|e| e.message)?;
    if value["ok"] == true {
        Ok(())
    } else {
        Err("The server did not confirm this proposal action. Retry to inspect it.".into())
    }
}
fn mutate(client: &Client, p: &Value, accept: bool, write_id: &str) -> Result<(), String> {
    let source = p["source"].as_str().unwrap_or("auto");
    if accept {
        let draft = feed::text(p, "draftDirective");
        let title = draft
            .lines()
            .map(str::trim)
            .find(|s| !s.is_empty())
            .unwrap_or("")
            .trim_start_matches(['-', '*', '#', '>', ' ', '\t'])
            .chars()
            .take(120)
            .collect::<String>();
        let title = if title.is_empty() {
            "Untitled directive".into()
        } else {
            title
        };
        let scope = if source == "observation" {
            match p["scope"].as_str() {
                Some("global") => "global",
                Some("repo") => "repo",
                _ => "project",
            }
        } else {
            "project"
        };
        let body = if draft.is_empty() {
            if source == "observation" {
                feed::text(p, "text")
            } else {
                title.clone()
            }
        } else {
            draft
        };
        post(
            client,
            "/api/cortex/directives",
            json!({"id":write_id,"title":title,"scope":scope,"priority":if source=="cross-repo"{p["directivePriority"].as_i64().unwrap_or(5)}else{5},"body":body}),
        )?;
        if source == "cross-repo" {
            post(client,"/api/cortex/cross-repo-proposals",json!({"action":"accept","directiveId":p["directiveId"],"originRepoId":p["sourceRepoId"]})).map_err(|e|format!("Directive saved; origin recording failed. Retry acceptance to finish: {e}"))?;
        } else if source == "observation" {
            post(client,"/api/cortex/proposals",json!({"action":"dismiss_observation","id":p["id"]})).map_err(|e|format!("Directive saved; observation acknowledgment failed. Retry acceptance to finish: {e}"))?;
        }
        return Ok(());
    }
    if source == "cross-repo" {
        post(
            client,
            "/api/cortex/cross-repo-proposals",
            json!({"action":"dismiss","targetRepoId":p["targetRepoId"],"directiveId":p["directiveId"]}),
        )
    } else if source == "observation" {
        post(
            client,
            "/api/cortex/proposals",
            json!({"action":"dismiss_observation","id":p["id"]}),
        )
    } else {
        post(
            client,
            "/api/cortex/proposals",
            json!({"action":"dismiss","id":p["id"],"filePattern":p["filePattern"],"fixPattern":p["fixPattern"]}),
        )
    }
}
