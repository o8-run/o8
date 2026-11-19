//! The serialized owner of the repository registry and panel project ledger.
mod pair;
mod projects;
mod state;
mod paths;
mod repos;

// Public requests acquire this FIFO async mutex before entering blocking file
// work; internal Node callers use the same entry point and never write files.
pub(crate) static ORDER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
pub(crate) fn mutate(directory:&std::path::Path,database:&std::path::Path,command:&serde_json::Value)->Result<serde_json::Value,String>{
    let lease=super::session_rule_lease::Lease::acquire_storage_policy(directory,database).map_err(str::to_owned)?;
    let result=(||{
        let mut state=state::State::open(directory,database)?;
        if command["operation"].as_str().is_some_and(|s|s.starts_with("project-")){
            state.project_command(command)
        }else{
            repos::apply(&mut state,command)
        }
    })();
    let released=lease.release().map_err(|_|"Workspace registry committed; lease release needs inspection".to_owned());
    match result {Err(error)=>Err(error),Ok(value)=>{released?;Ok(value)}}
}
