//! Existing panel ledger semantics, using the native read projection and SQLite.
use super::super::{projects, read_context::ReadContext, Store};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;
use unicode_normalization::UnicodeNormalization;
pub(super) const COLORS: [&str;8] = ["#5b8db8","#7fa68f","#a39565","#a37b7b","#9079a8","#7a9a8c","#a87f5b","#7a87a3"];
pub(super) type Result<T> = std::result::Result<T,String>;
pub(super) fn slug(name: &str) -> String {
    let mut result=String::new();
    for c in name.nfkd().filter(|c|!('\u{0300}'..='\u{036f}').contains(c)).flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() { result.push(c); }
        else if !result.is_empty() && !result.ends_with('-') { result.push('-'); }
    }
    let result=result.trim_end_matches('-'); if result.is_empty() { "default".into() } else { result.into() }
}
pub(super) fn now() -> String { chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true) }
pub(super) fn project(root: &Path, database: &Path, raw: &Value, repos: &[Value]) -> Result<Value> {
    let home=std::env::var("HOME").map_err(|_|"Workspace home unavailable")?;
    let cwd=std::env::current_dir().map_err(|_|"Workspace cwd unavailable")?;
    let store=Store { directory: root.to_owned(), database:database.to_owned(), defaults_context:Some(json!({"projectsHome":home,"projectsCwd":cwd})),redaction:None };
    let context=ReadContext::new(&store);
    let sql=projects::sql_projects(&context).map_err(|_|"Project store unavailable")?;
    let fallback=json!({"projects":[{"id":"default","name":"Workspace","repoPaths":[],"createdAt":now(),"color":COLORS[0]}],"activeProjectId":"default"});
    let raw=if raw["projects"].as_array().is_some_and(|p|!p.is_empty()) {raw} else {&fallback};
    projects::ledger::project(&context,repos,&sql,raw).map_err(|_|"Project ledger unavailable".into())
}
pub(super) fn selected<'a>(view: &'a Value, id: &str) -> Result<&'a Value> {
    let projects=view["projects"].as_array().ok_or("Project ledger unavailable")?;
    if let Some(project)=projects.iter().find(|p|p["id"]==id) { return Ok(project); }
    let matching=projects.iter().filter(|p|p["sqliteProjectId"]==id).collect::<Vec<_>>();
    if matching.len()==1 { Ok(matching[0]) } else { Err("Project not found or identity is ambiguous. Refresh projects.".into()) }
}
fn unique(db: &Connection, wanted: &str, owner: Option<&str>) -> Result<String> {
    let mut slug=wanted.to_owned();
    for suffix in 2..1001 {
        let existing=db.query_row("SELECT id FROM projects WHERE slug=?",[&slug],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?;
        if existing.as_deref().is_none_or(|id|Some(id)==owner) { return Ok(slug); }
        slug=format!("{wanted}-{suffix}");
    }
    Err("Could not find a unique project slug.".into())
}
pub(super) fn mirror(db: &Connection, view: &Value) -> rusqlite::Result<()> {
    for (order,project) in view["projects"].as_array().into_iter().flatten().enumerate() {
        if project["id"].as_str().is_some_and(|s|s.starts_with("repo:")) {continue;}
        let id=project["sqliteProjectId"].as_str().or(project["id"].as_str());
        let color=project["color"].as_str();
        let count=db.execute("UPDATE projects SET color=?,sort_order=? WHERE id=?",params![color,order as i64,id])?;
        if count==0 && project["sqliteProjectId"].is_null() {
            db.execute("UPDATE projects SET color=?,sort_order=? WHERE slug=?",params![color,order as i64,slug(project["name"].as_str().unwrap_or(""))])?;
        }
    }
    if let Some(id)=view["activeProjectId"].as_str().filter(|s|!s.is_empty()) {
        db.execute("INSERT INTO app_state (key,value,updated_at) VALUES ('active_project_id',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",params![id,chrono::Utc::now().timestamp_millis()])?;
    }
    Ok(())
}
/// Mutates one projected ledger. The caller commits both files before mirroring.
pub(super) fn apply(db: &Connection, view: &mut Value, command: &Value) -> Result<()> {
    let operation=command["operation"].as_str().ok_or("Project operation required")?;
    match operation {
        "project-initialize" | "project-reconcile" => (),
        "project-create" => {
            let name=command["name"].as_str().ok_or("Project name is required.")?.trim();
            if name.is_empty() {return Err("Project name is required.".into());}
            if name.encode_utf16().count()>60 {return Err("Project name must be 60 characters or fewer.".into());}
            let id=format!("proj-{}",&uuid::Uuid::new_v4().to_string()[..12]);
            let base=slug(name); let mut wanted=base.clone(); let mut suffix=2;
            while view["projects"].as_array().unwrap().iter().any(|p|slug(p["name"].as_str().unwrap_or(""))==wanted) {wanted=format!("{base}-{suffix}");suffix+=1;}
            let chosen=unique(db,&wanted,None)?;
            let timestamp=chrono::Utc::now().timestamp_millis();
            db.execute("INSERT INTO projects (id,name,slug,description,main_repo_id,created_at,updated_at) VALUES (?,?,?,NULL,NULL,?,?)",params![id,name,chosen,timestamp,timestamp]).map_err(|e|e.to_string())?;
            let count=view["projects"].as_array().unwrap().len();
            view["projects"].as_array_mut().unwrap().push(json!({"id":id,"name":name,"repoPaths":[],"createdAt":now(),"color":COLORS[count%COLORS.len()]}));
            view["activeProjectId"]=json!(id);
        },
        "project-active" | "project-colour" | "project-rename" => {
            let id=command["id"].as_str().ok_or("Project id is required")?;
            let target=selected(view,id)?.clone();
            if operation=="project-active" {view["activeProjectId"]=target["id"].clone();return Ok(());}
            let (key,value)=if operation=="project-colour" {
                let color=command["color"].as_str().filter(|c|COLORS.contains(c)).ok_or("Unknown project color.")?;
                ("color",json!(color))
            } else {
                let name=command["name"].as_str().ok_or("Project name is required.")?.trim();
                if name.is_empty() {return Err("Project name is required.".into());}
                let owner=target["sqliteProjectId"].as_str().or(target["id"].as_str()).unwrap();
                let exists=db.query_row("SELECT id FROM projects WHERE id=?",[owner],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?;
                if exists.is_some() {
                    let chosen=unique(db,&slug(name),Some(owner))?;
                    db.execute("UPDATE projects SET name=?,slug=?,updated_at=? WHERE id=?",params![name,chosen,chrono::Utc::now().timestamp_millis(),owner]).map_err(|e|e.to_string())?;
                }
                ("name",json!(name))
            };
            for project in view["projects"].as_array_mut().unwrap() { if project["id"]==target["id"] {project[key]=value.clone();} }
        },
        "project-upsert" => {
            let input=&command["input"]; let id=input["id"].as_str().ok_or("Project id required")?;
            let paths=input["repoPaths"].as_array().ok_or("Project paths required")?.iter().map(|p|p.as_str().map(super::paths::normalize).map(Value::from).ok_or("Invalid project path")).collect::<std::result::Result<Vec<_>,_>>()?;
            let mut unique=Vec::new();for path in paths{if !unique.contains(&path){unique.push(path);}}
            let all=view["projects"].as_array_mut().unwrap();
            if let Some(index)=all.iter().position(|p|p["id"]==id||p["sqliteProjectId"]==id){
                let target_id=all[index]["id"].clone();
                all.retain(|p|p["id"]==target_id||p["id"]!=input["sqliteProjectId"]);
                let target=all.iter_mut().find(|p|p["id"]==target_id).unwrap();
                if let Some(sqlite_id)=input.get("sqliteProjectId"){target["sqliteProjectId"]=sqlite_id.clone();}
                target["name"]=json!(input["name"].as_str().ok_or("Project name required")?.trim());target["repoPaths"]=json!(unique);
            }else{
                let color=COLORS.iter().find(|c|!all.iter().any(|p|p["color"]==**c)).unwrap_or(&COLORS[0]);
                let mut record=json!({"id":id.trim(),"name":input["name"].as_str().ok_or("Project name required")?.trim(),"repoPaths":unique,"createdAt":now(),"color":color});
                if let Some(sqlite_id)=input.get("sqliteProjectId"){record["sqliteProjectId"]=sqlite_id.clone();}all.push(record);
            }
        },
        "project-repos" => {
            let id=command["id"].as_str().ok_or("Project id required")?;let target=selected(view,id)?.clone();
            let target_id=target["sqliteProjectId"].as_str().or(target["id"].as_str()).unwrap();
            let existing=db.query_row("SELECT id FROM projects WHERE id=?",[target_id],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?;
            let id=if let Some(id)=existing{id}else{
                let id=format!("proj-{}",&uuid::Uuid::new_v4().to_string()[..12]);let name=target["name"].as_str().unwrap();let chosen=unique(db,&slug(name),None)?;let time=chrono::Utc::now().timestamp_millis();
                db.execute("INSERT INTO projects (id,name,slug,description,main_repo_id,created_at,updated_at) VALUES (?,?,?,NULL,NULL,?,?)",params![id,name,chosen,time,time]).map_err(|e|e.to_string())?;
                db.execute("INSERT OR IGNORE INTO app_state (key,value,updated_at) SELECT ?,value,? FROM app_state WHERE key=?",params![format!("project-merge-mode:{id}"),time,format!("project-merge-mode:{target_id}")]).map_err(|e|e.to_string())?;id
            };
            let input=command["repoPaths"].as_array().ok_or("Project paths required")?;let repos=command["registry"].as_array().ok_or("Registry required")?;
            let mut wanted=Vec::new();for path in input{let path=super::paths::normalize(path.as_str().ok_or("Invalid project path")?);if let Some(repo)=repos.iter().rev().find(|r|r["localPath"].as_str().is_some_and(|p|super::paths::normalize(p)==path)){if !wanted.contains(&repo["id"]){wanted.push(repo["id"].clone());}}}
            let mut statement=db.prepare("SELECT repo_id FROM project_repos WHERE project_id=?").map_err(|e|e.to_string())?;
            let current=statement.query_map([&id],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?.collect::<std::result::Result<Vec<_>,_>>().map_err(|e|e.to_string())?;drop(statement);
            for repo in &wanted{if !current.iter().any(|r|repo==r){db.execute("INSERT INTO project_repos (project_id,repo_id,role,suggestion_origin,added_at) VALUES (?,?,NULL,'manual',?)",params![id,repo.as_str(),chrono::Utc::now().timestamp_millis()]).map_err(|e|e.to_string())?;}}
            for repo in current{if !wanted.iter().any(|r|r==&repo){db.execute("DELETE FROM project_repos WHERE project_id=? AND repo_id=?",params![id,repo]).map_err(|e|e.to_string())?;}}
        },
        _ => return Err("Unsupported project mutation".into()),
    }
    Ok(())
}
pub(super) fn persistable(view: &Value) -> Value {
    let mut value=view.clone();
    if let Some(projects)=value["projects"].as_array_mut() {projects.retain(|p|!p["id"].as_str().is_some_and(|s|s.starts_with("repo:")));}
    value
}
