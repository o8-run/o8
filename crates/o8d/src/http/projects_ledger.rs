//! JSON metadata sidecar plus canonical SQLite membership. Read-only projection.
use super::{
    context, json, optional_json, state, PathBuf, ReadContext, Result, UnicodeNormalization, Value,
};
use std::collections::HashSet;
const COLORS: [&str; 8] = [
    "#5b8db8", "#7fa68f", "#a39565", "#a37b7b", "#9079a8", "#7a9a8c", "#a87f5b", "#7a87a3",
];
fn slug(name: &str) -> String {
    let text = name
        .nfkd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .flat_map(char::to_lowercase)
        .collect::<String>();
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_owned()
}
fn normalize(store: &ReadContext<'_>, path: &str) -> Result<String> {
    let path = super::js_trim(path);
    let home = context(store, "projectsHome")?.as_str().ok_or(())?;
    let path = if path == "~" {
        home.to_owned()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        path.to_owned()
    };
    let path = PathBuf::from(path);
    let path = if path.is_absolute() {
        path
    } else {
        PathBuf::from(context(store, "projectsCwd")?.as_str().ok_or(())?).join(path)
    };
    let mut normalized = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            p => normalized.push(p.as_os_str()),
        }
    }
    normalized.to_str().map(str::to_owned).ok_or(())
}
fn partner<'a>(project: &Value, sql: &'a [Value], all: &[Value]) -> Option<&'a Value> {
    let stable = project
        .get("sqliteProjectId")
        .filter(|v| !v.is_null())
        .unwrap_or(&project["id"]);
    let direct = sql.iter().find(|p| p["id"] == *stable);
    if direct.is_some()
        || project["sqliteProjectId"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    {
        return direct;
    }
    let name = project["name"].as_str()?;
    let s = slug(name);
    let s = if s.is_empty() { "default" } else { &s };
    let candidates = sql
        .iter()
        .filter(|p| {
            p["slug"] == s
                && p["name"]
                    .as_str()
                    .is_some_and(|n| n.to_lowercase() == name.to_lowercase())
                && !all
                    .iter()
                    .any(|entry| entry["id"] == p["id"] || entry["sqliteProjectId"] == p["id"])
        })
        .collect::<Vec<_>>();
    if candidates.len() == 1 {
        Some(candidates[0])
    } else {
        None
    }
}
fn paths(store: &ReadContext<'_>, sql: &Value, repos: &[Value]) -> Result<Value> {
    let mut paths = Vec::new();
    for link in sql["repos"].as_array().ok_or(())? {
        if let Some(path) = repos
            .iter()
            .rev()
            .find(|r| r["id"] == link["repoId"])
            .and_then(|r| r["localPath"].as_str())
            .filter(|p| !super::js_trim(p).is_empty())
        {
            paths.push(json!(normalize(store, path)?));
        }
    }
    Ok(json!(paths))
}
pub(super) fn read(store: &ReadContext<'_>, repos: &[Value], sql: &[Value]) -> Result<Value> {
    // Missing/invalid sidecars derive fresh timestamps and can trigger SQL sync.
    // Preserve that original owner instead of inventing a cached default ledger.
    let raw = optional_json(store, "projects.json")?.ok_or(())?;
    let entries = raw["projects"].as_array().ok_or(())?;
    let mut projects = Vec::new();
    for entry in entries {
        let Some(id) = entry["id"].as_str() else {
            continue;
        };
        let Some(name) = entry["name"].as_str() else {
            continue;
        };
        let Some(raw_paths) = entry["repoPaths"].as_array() else {
            continue;
        };
        let normalized = raw_paths
            .iter()
            .map(|p| normalize(store, p.as_str().ok_or(())?).map(Value::String))
            .collect::<Result<Vec<_>>>()?;
        let mut p = json!({"id":id,"name":name,"repoPaths":normalized,"createdAt":entry.get("createdAt").filter(|v|!v.is_null()).ok_or(())?});
        if let Some(id) = entry.get("sqliteProjectId") {
            if !id.is_string() {
                return Err(());
            }
            p["sqliteProjectId"] = id.clone();
        }
        if entry["color"].as_str().is_some_and(|c| COLORS.contains(&c)) {
            p["color"] = entry["color"].clone();
        }
        projects.push(p);
    }
    if projects.is_empty() {
        return Err(());
    }
    let mut active = raw["activeProjectId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or(projects[0]["id"].as_str().ok_or(())?.to_owned());
    let db = store.database()?;
    let mut stmt = db
        .prepare("SELECT id,slug,color,sort_order FROM projects")
        .map_err(|_| ())?;
    let meta = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<f64>>(3)?,
            ))
        })
        .map_err(|_| ())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| ())?;
    let mut decorated = Vec::new();
    for p in projects {
        let id = p.get("sqliteProjectId").unwrap_or(&p["id"]);
        let name = p["name"].as_str().ok_or(())?;
        let slug = slug(name);
        let slug = if slug.is_empty() { "default" } else { &slug };
        let m = meta
            .iter()
            .rev()
            .find(|m| Some(m.0.as_str()) == id.as_str())
            .or_else(|| meta.iter().rev().find(|m| m.1 == slug));
        let mut p = p;
        let mut order = None;
        if let Some(m) = m {
            if let Some(c) = m.2.as_deref().filter(|c| COLORS.contains(c)) {
                p["color"] = json!(c);
            }
            order = m.3;
        }
        decorated.push((p, order));
    }
    decorated.sort_by(|a, b| match (a.1, b.1) {
        (Some(a), Some(b)) => a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        _ => std::cmp::Ordering::Equal,
    });
    let mut projects = decorated.into_iter().map(|(p, _)| p).collect::<Vec<_>>();
    if let Some(id) = state(store, "active_project_id")? {
        active = id;
    }
    let original = projects.clone();
    let mut represented = HashSet::new();
    for p in &mut projects {
        if let Some(sp) = partner(p, sql, &original) {
            represented.insert(sp["id"].as_str().ok_or(())?.to_owned());
            p["sqliteProjectId"] = sp["id"].clone();
            p["repoPaths"] = paths(store, sp, repos)?;
        } else {
            p["repoPaths"] = json!([]);
        }
    }
    let mut color = projects.len();
    for sp in sql {
        if represented.contains(sp["id"].as_str().ok_or(())?) {
            continue;
        }
        let date = chrono::DateTime::from_timestamp_millis(sp["createdAt"].as_i64().ok_or(())?)
            .ok_or(())?
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        projects.push(json!({"id":sp["id"],"name":sp["name"],"repoPaths":paths(store,sp,repos)?,"createdAt":date,"color":COLORS[color%COLORS.len()]}));
        color += 1;
    }
    let assigned = projects
        .iter()
        .flat_map(|p| p["repoPaths"].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<HashSet<_>>();
    for repo in repos {
        let path = normalize(store, repo["localPath"].as_str().ok_or(())?)?;
        if assigned.contains(&path) {
            continue;
        }
        projects.push(json!({"id":format!("repo:{}",repo["id"].as_str().ok_or(())?),"name":repo["name"],"repoPaths":[path],"createdAt":repo.get("addedAt").filter(|v|!v.is_null()).ok_or(())?,"color":COLORS[color%COLORS.len()]}));
        color += 1;
    }
    if active == "default" || !projects.iter().any(|p| p["id"] == active) {
        if let Some(p) = projects
            .iter()
            .find(|p| {
                p["id"] != "default" && !p["id"].as_str().is_some_and(|s| s.starts_with("repo:"))
            })
            .or_else(|| projects.iter().find(|p| p["id"] != "default"))
            .or_else(|| projects.first())
        {
            active = p["id"].as_str().ok_or(())?.to_owned();
        }
    }
    Ok(json!({"projects":projects,"activeProjectId":active}))
}
pub(super) fn require_settled_sync(view: &Value, sql: &[Value], repos: &[Value]) -> Result<()> {
    let all = view["projects"].as_array().ok_or(())?;
    let concrete = all.iter().any(|p| p["id"] != "default");
    for p in all {
        if concrete && p["id"] == "default" {
            continue;
        }
        let sp = partner(p, sql, all).ok_or(())?;
        if sp["description"]
            .as_str()
            .is_some_and(|d| d.starts_with("Imported from the desktop project rail."))
        {
            return Err(());
        }
        for path in p["repoPaths"].as_array().ok_or(())? {
            if let Some(repo) = repos.iter().rev().find(|r| r["localPath"] == *path) {
                if !sp["repos"]
                    .as_array()
                    .ok_or(())?
                    .iter()
                    .any(|l| l["repoId"] == repo["id"])
                {
                    return Err(());
                }
            }
        }
    }
    Ok(())
}
pub(super) fn require_settled_reconcile(view: &Value, repos: &[Value]) -> Result<()> {
    // Every membership came from this same, attested registry. A stripped path
    // would make reconcileProjectsWithRegistry a writer; leave that case to TS.
    for p in view["projects"].as_array().ok_or(())? {
        for path in p["repoPaths"].as_array().ok_or(())? {
            if !repos.iter().any(|r| r["localPath"] == *path) {
                return Err(());
            }
        }
    }
    Ok(())
}
