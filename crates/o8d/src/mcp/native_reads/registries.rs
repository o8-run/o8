use super::*;
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

const COLORS: [&str; 8] = [
    "#5b8db8", "#7fa68f", "#a39565", "#a37b7b", "#9079a8", "#7a9a8c", "#a87f5b", "#7a87a3",
];
pub(super) fn slug(name: &str) -> String {
    let mut out = String::new();
    for ch in name
        .nfkd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
    {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_owned()
}
pub(super) fn registry(reader: &NativeReads) -> ReadResult<Vec<Value>> {
    let data = reader.json("repos.json")?;
    let mut repos = array(&data["repos"])?.clone();
    if repos.len() > 1 {
        // Let the original locale-aware sorter handle unsupported collation.
        for repo in &repos {
            if !string(repo, "name")?
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == ' ')
            {
                return Err(());
            }
            DateTime::parse_from_rfc3339(
                repo["lastOpenedAt"]
                    .as_str()
                    .or(repo["addedAt"].as_str())
                    .ok_or(())?,
            )
            .map_err(|_| ())?;
        }
        for (index, repo) in repos.iter().enumerate() {
            let time = |v: &Value| {
                DateTime::parse_from_rfc3339(
                    v["lastOpenedAt"]
                        .as_str()
                        .or(v["addedAt"].as_str())
                        .unwrap(),
                )
                .unwrap()
            };
            if repos[..index].iter().any(|other| time(other) == time(repo)) {
                return Err(());
            }
        }
        repos.sort_by(|a, b| {
            let time = |v: &Value| {
                DateTime::parse_from_rfc3339(
                    v["lastOpenedAt"]
                        .as_str()
                        .or(v["addedAt"].as_str())
                        .unwrap(),
                )
                .unwrap()
            };
            time(b).cmp(&time(a)).then_with(|| {
                a["name"]
                    .as_str()
                    .unwrap()
                    .to_lowercase()
                    .cmp(&b["name"].as_str().unwrap().to_lowercase())
            })
        });
    }
    for repo in &repos {
        for key in ["id", "name", "localPath"] {
            string(repo, key)?;
        }
        if !std::path::Path::new(string(repo, "localPath")?).is_absolute() {
            return Err(());
        }
        let path = string(repo, "localPath")?;
        if std::path::Path::new(path)
            .components()
            .collect::<PathBuf>()
            .to_str()
            != Some(path)
        {
            return Err(());
        }
    }
    Ok(repos)
}
pub(super) fn repos(reader: &NativeReads, db: &Connection, policy: &Value) -> ReadResult<Value> {
    let repos = registry(reader)?.into_iter().map(|repo| {
        let path = repo["localPath"].as_str().unwrap();
        let readiness = match state(db, &format!("o8d/mcp/v1/readiness/{path}")) {
            Ok(value) if value["generation"] == policy["generation"] => value["state"].clone(),
            Ok(_) => Value::Null,
            Err(_) => {
                let exists: i64 = db.query_row("SELECT count(*) FROM app_state WHERE key = ?", [format!("o8d/mcp/v1/readiness/{path}")], |row| row.get(0)).map_err(|_| ())?;
                if exists != 0 { return Err(()); }
                Value::Null
            }
        };
        Ok(json!({"id":repo["id"],"name":repo["name"],"repoPath":path,
            "remoteUrl":repo["remoteUrl"],"defaultBranch":repo["defaultBranch"].as_str().filter(|s| !s.is_empty()).unwrap_or("main"),
            "exists":std::path::Path::new(path).try_exists().map_err(|_| ())?,"readiness":readiness}))
    }).collect::<ReadResult<Vec<_>>>()?;
    Ok(json!({"count":repos.len(),"repos":repos}))
}

pub(super) fn sqlite_projects(db: &Connection) -> ReadResult<Vec<Value>> {
    rows(db, "SELECT id, name, slug, description, main_repo_id AS mainRepoId, created_at AS createdAt, color, sort_order AS sortOrder FROM projects ORDER BY created_at DESC")
}
pub(super) fn projects(reader: &NativeReads, db: &Connection) -> ReadResult<Value> {
    let data = reader.json("projects.json")?;
    let repos = registry(reader)?;
    let stored = sqlite_projects(db)?;
    let links = rows(db, "SELECT project_id AS projectId, repo_id AS repoId, role FROM project_repos ORDER BY added_at ASC")?;
    let mut decorated = Vec::new();
    for entry in array(&data["projects"])? {
        let name = string(entry, "name")?;
        if slug(name).is_empty() {
            return Err(());
        }
        let id = string(entry, "id")?;
        array(&entry["repoPaths"])?;
        let mut project = json!({"id":id,"name":name,"repoPaths":[],"createdAt":entry["createdAt"].as_str().ok_or(())?});
        let meta = stored
            .iter()
            .find(|p| p["id"] == id)
            .or_else(|| stored.iter().find(|p| p["slug"] == slug(name)));
        if let Some(color) = meta
            .and_then(|p| p["color"].as_str())
            .filter(|c| COLORS.contains(c))
            .or(entry["color"].as_str().filter(|c| COLORS.contains(c)))
        {
            project["color"] = json!(color);
        }
        decorated.push((meta.and_then(|p| p["sortOrder"].as_i64()), project));
    }
    if decorated.is_empty() {
        return Err(());
    }
    decorated.sort_by_key(|(order, _)| (order.is_none(), order.unwrap_or(0)));
    let mut represented = Vec::new();
    let paths = |project: &Value| -> Value {
        json!(links
            .iter()
            .filter(|link| link["projectId"] == project["id"])
            .filter_map(|link| repos.iter().find(|repo| repo["id"] == link["repoId"]))
            .map(|repo| repo["localPath"].clone())
            .collect::<Vec<_>>())
    };
    let mut projects = Vec::new();
    for (_, mut project) in decorated {
        let name = string(&project, "name")?;
        let matched = stored
            .iter()
            .find(|p| p["id"] == project["id"])
            .or_else(|| {
                stored.iter().find(|p| {
                    p["slug"] == slug(name)
                        && p["name"]
                            .as_str()
                            .is_some_and(|n| n.to_lowercase() == name.to_lowercase())
                })
            });
        if let Some(matched) = matched {
            project["repoPaths"] = paths(matched);
            represented.push(matched["id"].clone());
        }
        projects.push(project);
    }
    for project in &stored {
        if represented.contains(&project["id"]) {
            continue;
        }
        projects.push(json!({"id":project["id"],"name":project["name"],"repoPaths":paths(project),
            "createdAt":iso(project["createdAt"].as_i64().ok_or(())?)?,"color":COLORS[projects.len()%COLORS.len()]}));
    }
    for repo in &repos {
        if projects.iter().any(|p| {
            p["repoPaths"]
                .as_array()
                .is_some_and(|paths| paths.contains(&repo["localPath"]))
        }) {
            continue;
        }
        projects.push(json!({"id":format!("repo:{}", string(repo,"id")?),"name":repo["name"],"repoPaths":[repo["localPath"]],
            "createdAt":repo["addedAt"].as_str().map(str::to_owned).unwrap_or(iso(Utc::now().timestamp_millis())?),"color":COLORS[projects.len()%COLORS.len()]}));
    }
    let active: Option<String> = db
        .query_row(
            "SELECT value FROM app_state WHERE key = 'active_project_id'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| ())?;
    let mut active = active
        .or_else(|| data["activeProjectId"].as_str().map(str::to_owned))
        .unwrap_or(string(&projects[0], "id")?.to_owned());
    if active == "default" || !projects.iter().any(|p| p["id"] == active) {
        active = string(
            projects
                .iter()
                .find(|p| {
                    p["id"] != "default" && !p["id"].as_str().unwrap_or("").starts_with("repo:")
                })
                .or_else(|| projects.iter().find(|p| p["id"] != "default"))
                .unwrap_or(&projects[0]),
            "id",
        )?
        .to_owned();
    }
    let dogfood = reader.directory.join(".dogfood-pr-only").exists();
    for project in &mut projects {
        let id = project["id"].as_str().unwrap_or("default").to_owned();
        project["mergePolicy"] = merge_policy(db, &id, dogfood);
    }
    Ok(json!({"activeProjectId":active,"projects":projects}))
}

/// `currentLaneMergePolicy` in src/lib/lane/dogfood-guard.ts, read from the same rows.
fn merge_policy(db: &Connection, project: &str, dogfood: bool) -> Value {
    if dogfood {
        return json!({"mode":"pr_only","note":"PR-only dogfood mode is active — merge to main is blocked. Open a PR; a human merges."});
    }
    let value = |key: &str| -> Result<Option<String>, ()> {
        db.query_row("SELECT value FROM app_state WHERE key = ?1", [key], |row| row.get(0))
            .optional()
            .map_err(|_| ())
    };
    let (Ok(row), Ok(carried)) = (
        value(&format!("project-merge-mode:{project}")),
        value("migration:project-merge-mode:carry-over-v1"),
    ) else {
        return json!({"mode":"pr_only","note":"Merge policy is unavailable. Branch retained; direct integration is blocked until project settings can be read."});
    };
    if row.as_deref() == Some("direct") || (row.is_none() && carried.is_none()) {
        let note = if carried.is_some() { Value::Null } else { json!("Merge-policy carry-over is pending; preserving the existing mode until restart.") };
        return json!({"mode":"direct","note":note});
    }
    json!({"mode":"pr_only","note":"PR-first project policy. Direct integration requires an explicit operator opt-in in project settings."})
}
