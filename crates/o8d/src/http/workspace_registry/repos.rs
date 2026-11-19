use super::{paths,projects::now,state::State};
use serde_json::{json,Value};
type Result<T> = std::result::Result<T,String>;
fn setup(input:&Value)->Value{
    let command=|key:&str|input[key].as_str().map(str::trim).filter(|s|!s.is_empty()).map(Value::from).unwrap_or(Value::Null);
    let install=command("installCommand");
    json!({"envMode":input.get("envMode").filter(|v|!v.is_null()).cloned().unwrap_or(json!("copy")),
        "envFiles":input.get("envFiles").filter(|v|v.is_array()).cloned().unwrap_or(json!([".env",".env.local"])),
        "installCommand":install,"installOnCreateWorkspace":input.get("installOnCreateWorkspace").filter(|v|!v.is_null()).cloned().unwrap_or(json!(!install.is_null())),
        "buildCommand":command("buildCommand"),"runBuildOnCreateWorkspace":input.get("runBuildOnCreateWorkspace").filter(|v|!v.is_null()).cloned().unwrap_or(json!(false)),
        "devCommand":command("devCommand"),"defaultPort":input.get("defaultPort").cloned().unwrap_or(Value::Null),
        "workspaceIsolationPreference":input["workspaceIsolationPreference"].as_str().filter(|s|matches!(*s,"auto"|"git-worktree"|"apfs-cow-clone")).unwrap_or("auto")})
}
fn detected(stored:&Value,detected:&Value)->Value{
    let mut normalized=setup(if stored.is_null(){detected}else{stored});
    const AUTO:[&str;7]=["npm ci --prefer-offline","npm install","pnpm install --frozen-lockfile","yarn install --frozen-lockfile","yarn install --immutable","bun install --frozen-lockfile","bun install"];
    if detected["installCommand"].is_null() && normalized["installCommand"].as_str().is_some_and(|s|AUTO.contains(&s)){
        normalized["installCommand"]=Value::Null;normalized["installOnCreateWorkspace"]=json!(false);
        if normalized["buildCommand"].is_null(){normalized["buildCommand"]=detected["buildCommand"].clone();}
    }
    normalized
}
fn sort(repos:&mut [Value]){
    let time=|p:&Value|p["lastOpenedAt"].as_str().or(p["addedAt"].as_str()).and_then(|v|chrono::DateTime::parse_from_rfc3339(v).ok()).map(|v|v.timestamp_millis()).unwrap_or(0);
    repos.sort_by(|a,b|time(b).cmp(&time(a)).then_with(||a["name"].as_str().cmp(&b["name"].as_str())));
}
pub(super) fn apply(state:&mut State,command:&Value)->Result<Value>{
    let operation=command["operation"].as_str().ok_or("Registry operation required")?;
    if operation=="paths-repoint" || operation=="paths-remove"{
        let old=command["previousPath"].as_str().ok_or("Repository path required")?;
        paths::mutate(&mut state.ledger,old,command["nextPath"].as_str());state.commit()?;return Ok(Value::Null);
    }
    let repos=state.repos["repos"].as_array_mut().ok_or("Repository registry is unreadable.")?;
    let result=match operation{
        "repo-add"=>{
            let candidate=&command["candidate"];
            let path=candidate["localPath"].as_str().ok_or("Validated repository required")?;
            if let Some(index)=repos.iter().position(|r|r["localPath"]==path){
                let previous=&repos[index];let mut entry=previous.clone();
                for key in ["name","remoteUrl","defaultBranch","isGitRepo"]{entry[key]=candidate[key].clone();}
                entry["setup"]=detected(&previous["setup"],&candidate["setup"]);
                if let Some(manifest)=command.get("manifest"){entry["manifest"]=manifest.clone();}
                entry["lastOpenedAt"]=json!(now());repos[index]=entry.clone();entry
            }else{
                let timestamp=now();let mut entry=candidate.clone();
                entry["id"]=json!(uuid::Uuid::new_v4().to_string());entry["addedAt"]=json!(timestamp);entry["lastOpenedAt"]=json!(timestamp);
                entry["storagePressureParkingDisabled"]=json!(false);
                if let Some(manifest)=command.get("manifest"){entry["manifest"]=manifest.clone();}
                repos.push(entry.clone());entry
            }
        },
        "repo-update" | "repo-touch"=>{
            let id=command["id"].as_str().ok_or("Repository id required")?;
            let index=repos.iter().position(|r|r["id"]==id).ok_or("Repository not found.")?;
            let old=repos[index].clone();let mut updated=old.clone();let updates=&command["updates"];
            if let Some(candidate)=command.get("candidate").filter(|c|!c.is_null()){
                let path=candidate["localPath"].as_str().ok_or("Validated repository required")?;
                if repos.iter().any(|r|r["id"]!=id&&r["localPath"]==path){return Err("Another registered repository already uses that folder.".into());}
                for key in ["name","localPath","remoteUrl","defaultBranch","isGitRepo"]{updated[key]=candidate[key].clone();}
                if let Some(manifest)=command.get("manifest"){updated["manifest"]=manifest.clone();}
            }
            updated["setup"]=setup(updates.get("setup").filter(|v|!v.is_null()).unwrap_or(&old["setup"]));
            if operation=="repo-touch"{updated["lastOpenedAt"]=command.get("timestamp").cloned().unwrap_or(json!(now()));}
            else if let Some(timestamp)=updates.get("lastOpenedAt"){updated["lastOpenedAt"]=timestamp.clone();}
            if let Some(value)=updates.get("storagePressureParkingDisabled").filter(|v|!v.is_null()){updated["storagePressureParkingDisabled"]=value.clone();}
            if updated["localPath"]!=old["localPath"]{
                paths::mutate(&mut state.ledger,old["localPath"].as_str().ok_or("Repository path unavailable")?,updated["localPath"].as_str());
            }
            repos[index]=updated.clone();updated
        },
        "repo-remove"=>{
            let id=command["id"].as_str().ok_or("Repository id required")?;
            let index=repos.iter().position(|r|r["id"]==id).ok_or("Repository not found.")?;
            let removed=repos.remove(index);
            paths::mutate(&mut state.ledger,removed["localPath"].as_str().ok_or("Repository path unavailable")?,None);
            removed
        },
        "repo-repair-remotes"=>{
            for repo in repos.iter_mut(){
                if let Some(remote)=command["remotes"].as_array().into_iter().flatten().find(|v|v["id"]==repo["id"]&&v["localPath"]==repo["localPath"]&&v["previousRemote"]==repo["remoteUrl"]){
                    if let Some(value)=remote.get("remote"){repo["remoteUrl"]=value.clone();}
                }
            }
            json!(&*repos)
        },
        _=>return Err("Unsupported registry mutation".into()),
    };
    sort(repos);state.commit()?;Ok(result)
}
