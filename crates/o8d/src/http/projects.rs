//! Saved project reads after the original principal/handler gates. No writers.
#[path = "projects_ledger.rs"]
mod ledger;
use super::{json, unavailable, value, Params, ReadContext, Value, RESPONSE_LIMIT};
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Instant;
use unicode_normalization::UnicodeNormalization;
type Result<T> = std::result::Result<T, ()>;
const NO_STORE: &str = "no-store, max-age=0";
pub(super) fn matches(path: &str) -> bool {
    matches!(
        path,
        "/api/panel/repos" | "/api/panel/projects" | "/api/projects" | "/api/panel/repo-icon"
    ) || path
        .strip_prefix("/api/projects/")
        .is_some_and(|id| !id.is_empty() && !id.contains('/'))
}
fn context<'a>(store: &'a ReadContext<'_>, key: &str) -> Result<&'a Value> {
    store
        .defaults_context
        .as_ref()
        .and_then(|v| v.get(key))
        .ok_or(())
}
fn nullish<'a>(value: Option<&'a Value>, fallback: &'a Value) -> &'a Value {
    value.filter(|v| !v.is_null()).unwrap_or(fallback)
}
fn optional_json(store: &ReadContext<'_>, name: &str) -> Result<Option<Value>> {
    let path = store.directory.join(name);
    match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
        Ok(_) => store.json(&path).map(Some),
    }
}
fn registry(store: &ReadContext<'_>) -> Result<Vec<Value>> {
    let digest = context(store, "projectRepoDigest")?.as_str().ok_or(())?;
    let path = store.directory.join("repos.json");
    let bytes = match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && digest == "missing" => {
            return Ok(vec![])
        }
        _ => store.file(&path, 8 * 1024 * 1024)?,
    };
    if format!("{:x}", Sha256::digest(&bytes)) != digest {
        return Err(());
    }
    let raw: Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
    let mut repos = Vec::new();
    for item in raw["repos"].as_array().ok_or(())? {
        let mut repo = item.as_object().ok_or(())?.clone();
        // The TS path registry prefers stored `path` over `localPath` during
        // reconciliation. Leave conflicting legacy entries with that owner.
        if repo.get("path").and_then(Value::as_str).is_some_and(|path| {
            Some(path) != repo.get("localPath").and_then(Value::as_str)
        }) {
            return Err(());
        }

        for key in ["id", "name", "localPath"] {
            repo.get(key).and_then(Value::as_str).ok_or(())?;
        }
        if repo
            .get("defaultBranch")
            .is_none_or(|v| v.is_null() || v == "" || v == false || v == 0)
        {
            repo.insert("defaultBranch".into(), json!("main"));
        }
        for (key, default) in [
            ("isGitRepo", true),
            ("storagePressureParkingDisabled", false),
        ] {
            if repo.get(key).is_none_or(Value::is_null) {
                repo.insert(key.into(), json!(default));
            }
        }
        let setup = repo.get("setup").and_then(Value::as_object);
        let get = |key: &str| setup.and_then(|s| s.get(key));
        let command = |key: &str| -> Result<Value> {
            match get(key) {
                None | Some(Value::Null) => Ok(Value::Null),
                Some(Value::String(s)) => {
                    let s = js_trim(s);
                    Ok(if s.is_empty() { Value::Null } else { json!(s) })
                }
                _ => Err(()),
            }
        };
        let install = command("installCommand")?;
        let pref = get("workspaceIsolationPreference")
            .and_then(Value::as_str)
            .filter(|s| matches!(*s, "auto" | "git-worktree" | "apfs-cow-clone"))
            .unwrap_or("auto");
        let normalized = json!({"envMode":nullish(get("envMode"), &json!("copy")),"envFiles":get("envFiles").filter(|v|v.is_array()).cloned().unwrap_or(json!([".env",".env.local"])),"installCommand":install,"installOnCreateWorkspace":nullish(get("installOnCreateWorkspace"), &json!(!install.is_null())),"buildCommand":command("buildCommand")?,"runBuildOnCreateWorkspace":nullish(get("runBuildOnCreateWorkspace"), &json!(false)),"devCommand":command("devCommand")?,"defaultPort":nullish(get("defaultPort"), &Value::Null),"workspaceIsolationPreference":pref});
        repo.insert("setup".into(), normalized);
        repos.push(Value::Object(repo));
    }
    let time = |repo: &Value| -> Result<i64> {
        chrono::DateTime::parse_from_rfc3339(
            nullish(repo.get("lastOpenedAt"), &repo["addedAt"])
                .as_str()
                .ok_or(())?,
        )
        .map(|d| d.timestamp_millis())
        .map_err(|_| ())
    };
    let mut timed = repos
        .into_iter()
        .map(|r| Ok((time(&r)?, r)))
        .collect::<Result<Vec<_>>>()?;
    // ICU name collation on equal/invalid timestamps stays with TypeScript.
    let mut seen = std::collections::HashSet::new();
    if timed.iter().any(|(t, _)| !seen.insert(*t)) {
        return Err(());
    }
    timed.sort_by_key(|(t, _)| std::cmp::Reverse(*t));
    Ok(timed.into_iter().map(|(_, r)| r).collect())
}
fn state(store: &ReadContext<'_>, key: &str) -> Result<Option<String>> {
    use rusqlite::OptionalExtension;
    store
        .database()?
        .query_row("SELECT value FROM app_state WHERE key = ?", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|_| ())
}
fn policy(store: &ReadContext<'_>, id: &str) -> Result<Value> {
    if store.directory.join(".dogfood-pr-only").exists() {
        return Ok(
            json!({"mode":"pr_only","note":"PR-only dogfood mode is active — merge to main is blocked. Open a PR; a human merges."}),
        );
    }
    let row = state(store, &format!("project-merge-mode:{id}"))?;
    let carried = state(store, "migration:project-merge-mode:carry-over-v1")?.is_some();
    Ok(
        if row.as_deref() == Some("direct") || (row.is_none() && !carried) {
            json!({"mode":"direct","note":if carried {Value::Null} else {json!("Merge-policy carry-over is pending; preserving the existing mode until restart.")}})
        } else {
            json!({"mode":"pr_only","note":"PR-first project policy. Direct integration requires an explicit operator opt-in in project settings."})
        },
    )
}
fn sql_projects(store: &ReadContext<'_>) -> Result<Vec<Value>> {
    let db = store.database()?;
    let mut stmt=db.prepare("SELECT id,name,slug,description,main_repo_id,created_at,updated_at FROM projects ORDER BY created_at DESC").map_err(|_|())?;
    let rows=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"slug":r.get::<_,String>(2)?,"description":r.get::<_,Option<String>>(3)?,"mainRepoId":r.get::<_,Option<String>>(4)?,"createdAt":r.get::<_,i64>(5)?,"updatedAt":r.get::<_,i64>(6)?,"repos":[]}))).map_err(|_|())?;
    let mut projects = rows
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| ())?;
    let mut stmt=db.prepare("SELECT project_id,repo_id,role,suggestion_origin,added_at FROM project_repos ORDER BY added_at ASC, repo_id ASC").map_err(|_|())?;
    let rows=stmt.query_map([],|r|Ok(json!({"projectId":r.get::<_,String>(0)?,"repoId":r.get::<_,String>(1)?,"role":r.get::<_,Option<String>>(2)?,"suggestionOrigin":r.get::<_,String>(3)?,"addedAt":r.get::<_,i64>(4)?}))).map_err(|_|())?;
    for row in rows {
        let row = row.map_err(|_| ())?;
        if let Some(p) = projects.iter_mut().find(|p| p["id"] == row["projectId"]) {
            p["repos"].as_array_mut().ok_or(())?.push(row);
        }
    }
    for p in &projects {
        for k in ["createdAt", "updatedAt"] {
            if p[k].as_i64().ok_or(())?.unsigned_abs() > 9_007_199_254_740_991 {
                return Err(());
            }
        }
    }
    Ok(projects)
}
fn no_icon(root: &Path) -> bool {
    const PROBES: &[&str] = &[
        "t3.json",
        "favicon.svg",
        "favicon.ico",
        "favicon.png",
        "public/favicon.svg",
        "public/favicon.ico",
        "public/favicon.png",
        "app/favicon.ico",
        "app/favicon.png",
        "app/icon.svg",
        "app/icon.png",
        "app/icon.ico",
        "src/favicon.ico",
        "src/favicon.svg",
        "src/app/favicon.ico",
        "src/app/icon.svg",
        "src/app/icon.png",
        "assets/icon.svg",
        "assets/icon.png",
        "assets/logo.svg",
        "assets/logo.png",
        ".idea/icon.svg",
        "Resources/AppIcon.icns",
        "AppIcon.icns",
        "index.html",
        "public/index.html",
        "app/routes/__root.tsx",
        "src/routes/__root.tsx",
        "app/root.tsx",
        "src/root.tsx",
        "src/index.html",
    ];
    PROBES.iter().all(|p|matches!(std::fs::symlink_metadata(root.join(p)),Err(e)if e.kind()==std::io::ErrorKind::NotFound))
}
fn icon(store: &ReadContext<'_>, repo: &Value) -> Result<Value> {
    if let Some(raw) = state(
        store,
        &format!("repository-icon:{}", repo["id"].as_str().ok_or(())?),
    )? {
        if let Ok(saved) = serde_json::from_str::<Value>(&raw) {
            if let Some(i) = saved.get("projectIcon").filter(|v| !v.is_null()) {
                let trim = js_trim;
                if i["kind"] == "emoji" {
                    if let Some(s) = i["emoji"]
                        .as_str()
                        .map(trim)
                        .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 32)
                    {
                        return Ok(json!({"kind":"emoji","emoji":s}));
                    }
                }
                // Other identity validators use ICU graphemes/normalization. Defer.
                return Err(());
            }
            if saved["faviconPath"].as_str().is_some() {
                return Err(());
            }
        }
    }
    if context(store, "projectIconCachePresent")? != false {
        return Err(());
    }
    let path = Path::new(repo["localPath"].as_str().ok_or(())?);
    if !path.is_absolute() {
        return Err(());
    }
    if std::fs::metadata(path).is_err() || no_icon(path) {
        Ok(Value::Null)
    } else {
        Err(())
    }
}
fn response(status: u16, body: Value, cache: bool, timing: Option<&str>) -> Result<Response> {
    let bytes = serde_json::to_vec(&body).map_err(|_| ())?;
    if bytes.len() > RESPONSE_LIMIT {
        return Err(());
    }
    let mut r = (StatusCode::from_u16(status).map_err(|_| ())?, bytes).into_response();
    r.headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    if cache {
        r.headers_mut()
            .insert("cache-control", NO_STORE.parse().unwrap());
    }
    if let Some(t) = timing {
        r.headers_mut()
            .insert("server-timing", t.parse().map_err(|_| ())?);
    }
    Ok(r)
}
pub(super) fn read(store: &ReadContext<'_>, path: &str, params: &Params) -> Response {
    let run = || -> Result<Response> {
        match path {
            "/api/projects" => {
                let repos = registry(store)?;
                let projects = sql_projects(store)?;
                let view = ledger::read(store, &repos, &projects)?;
                ledger::require_settled_sync(&view, &projects, &repos)?;
                let concrete = projects.iter().any(|p| p["slug"] != "workspace");
                let projects = projects
                    .into_iter()
                    .filter(|p| {
                        !concrete
                            || p["slug"] != "workspace"
                            || p["name"]
                                .as_str()
                                .is_none_or(|s| s.to_lowercase() != "workspace")
                    })
                    .collect::<Vec<_>>();
                response(200, json!({"projects":projects}), true, None)
            }
            "/api/panel/projects" => {
                let repos = registry(store)?;
                let projects = sql_projects(store)?;
                let mut view = ledger::read(store, &repos, &projects)?;
                ledger::require_settled_reconcile(&view, &repos)?;
                for p in view["projects"].as_array_mut().ok_or(())? {
                    p["mergePolicy"] = policy(store, p["id"].as_str().ok_or(())?)?;
                }
                response(200, view, true, None)
            }
            "/api/panel/repo-icon" => {
                let repos = registry(store)?;
                let Some(repo) = repos.iter().find(|r| r["id"] == value(params, "id")) else {
                    return response(
                        404,
                        json!({"error":"Registered repository not found."}),
                        false,
                        None,
                    );
                };
                let root = Path::new(repo["localPath"].as_str().ok_or(())?);
                if context(store, "projectIconCachePresent")? != false {
                    return Err(());
                }
                if std::fs::metadata(root).is_err() {
                    return response(
                        503,
                        json!({"error":"Project icon is temporarily unavailable."}),
                        false,
                        None,
                    );
                }
                if state(
                    store,
                    &format!("repository-icon:{}", repo["id"].as_str().ok_or(())?),
                )?
                .is_some()
                    || !no_icon(root)
                {
                    return Err(());
                }
                response(404, json!({"error":"Project icon not found."}), false, None)
            }
            "/api/panel/repos" => {
                if value(params, "source") == "github" || params.contains_key("restorePath") {
                    return Err(());
                }
                let start = Instant::now();
                let mut repos = registry(store)?;
                let registry_ms = start.elapsed().as_secs_f64() * 1000.0;
                let readiness = value(params, "readiness");
                if value(params, "restoreValidationOnly") == "1" {
                    return response(
                        200,
                        json!({"validatedRestorePaths":[]}),
                        false,
                        Some(&format!(
                            "registry;dur={registry_ms:.1}, validation;dur=0.0, total;dur={:.1}",
                            start.elapsed().as_secs_f64() * 1000.0
                        )),
                    );
                }
                if !readiness.is_empty() {
                    if !repos.iter().any(|r| r["id"] == readiness) {
                        return response(
                            404,
                            json!({"error":"Registered repository not found."}),
                            false,
                            Some(&format!(
                                "total;dur={:.1}",
                                start.elapsed().as_secs_f64() * 1000.0
                            )),
                        );
                    }
                    return Err(());
                }
                if context(store, "projectReadinessCached")? != false
                    || repos.iter().any(|r| r["isGitRepo"] != false)
                {
                    return Err(());
                }
                for repo in &mut repos {
                    repo.as_object_mut().ok_or(())?.remove("readiness");
                    let path = Path::new(repo["localPath"].as_str().ok_or(())?);
                    if !path.is_absolute() {
                        return Err(());
                    }
                    repo["exists"] = json!(std::fs::metadata(path).is_ok());
                    repo["icon"] = icon(store, repo)?;
                }
                response(200,json!({"repos":repos,"validatedRestorePaths":[]}),false,Some(&format!("registry;dur={registry_ms:.1}, readiness;dur=0.0, existence;dur={:.1}, total;dur={:.1}",start.elapsed().as_secs_f64()*1000.0-registry_ms,start.elapsed().as_secs_f64()*1000.0)))
            }
            _ => {
                let id = path.strip_prefix("/api/projects/").ok_or(())?;
                let id = percent_decode(id)?;
                let projects = sql_projects(store)?;
                let Some(project) = projects.into_iter().find(|p| p["id"] == id) else {
                    return response(404, json!({"error":"Project not found."}), false, None);
                };
                let policy = policy(store, &id)?;
                let saved = state(store, &format!("project-merge-mode:{id}"))?;
                response(
                    200,
                    json!({"project":project,"mergePolicy":policy,"savedMergeMode":saved}),
                    true,
                    None,
                )
            }
        }
    };
    run().unwrap_or_else(|_| unavailable())
}
fn percent_decode(text: &str) -> Result<String> {
    // URL path decoding does not apply form '+' conversion.
    let mut out = Vec::new();
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if i + 2 >= b.len() {
                return Err(());
            }
            let h = (b[i + 1] as char).to_digit(16).ok_or(())?;
            let l = (b[i + 2] as char).to_digit(16).ok_or(())?;
            out.push((h * 16 + l) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}
