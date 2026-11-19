use super::{pair, projects};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json,Value};
use std::{fs, path::{Path,PathBuf}};
pub(super) struct State {pub root:PathBuf,pub database:PathBuf,pub repos:Value,pub ledger:Value}
fn read(path:&Path, default:Value)->Result<Value,String>{
    match fs::read(path) {
        Ok(bytes) if bytes.len()<=16*1024*1024 => serde_json::from_slice(&bytes).map_err(|_|"Workspace registry is unreadable".into()),
        Ok(_)=>Err("Workspace registry exceeds its bound".into()),
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(default),
        Err(_)=>Err("Workspace registry is unavailable".into()),
    }
}
impl State {
    pub fn open(root:&Path,database:&Path)->Result<Self,String>{
        pair::recover(root).map_err(|e|e.to_string())?;
        let repos=read(&root.join("repos.json"),json!({"version":1,"repos":[]}))?;
        let ledger=read(&root.join("projects.json"),Value::Null)?;
        if !repos["repos"].is_array(){return Err("Repository registry is unreadable.".into());}
        Ok(Self{root:root.into(),database:database.into(),repos,ledger})
    }
    pub fn database(&self)->Result<Connection,String>{
        let path=self.database.canonicalize().map_err(|_|"Workspace database unavailable")?;
        if !path.starts_with(&self.root)||!path.is_file(){return Err("Workspace database is outside the profile".into());}
        let db=Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_WRITE|OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|e|e.to_string())?;
        db.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e|e.to_string())?;
        Ok(db)
    }
    pub fn view(&self)->Result<Value,String>{
        projects::project(&self.root,&self.database,&self.ledger,self.repos["repos"].as_array().unwrap())
    }
    pub fn commit(&self)->Result<(),String>{
        pair::commit(&self.root,&self.repos,&self.ledger).map_err(|e|e.to_string())
    }
    pub fn project_command(&mut self,command:&Value)->Result<Value,String>{
        let db=self.database()?;
        let mut view=self.view()?;
        projects::apply(&db,&mut view,command)?;
        self.ledger=projects::persistable(&view);
        self.commit()?;
        // Deliberately best-effort, just like the existing panel metadata mirror.
        if let Err(error)=projects::mirror(&db,&view){eprintln!("[projects] SQLite metadata write failed (JSON persisted normally): {error}");}
        Ok(view)
    }
}
