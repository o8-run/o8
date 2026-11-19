//! Recoverable two-file commits. Only the serialized workspace owner calls this.
use serde_json::{json, Value};
use std::{fs::{self, File, OpenOptions}, io::{self, Write}, path::{Path, PathBuf}};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const FILES: [&str; 2] = ["repos.json", "projects.json"];
const JOURNAL: &str = ".workspace-registry-transaction.json";
fn mode(path: &Path) -> io::Result<u32> {
    match fs::metadata(path) {
        #[cfg(unix)]
        Ok(meta) => Ok(meta.permissions().mode() & 0o777),
        #[cfg(not(unix))]
        Ok(_) => Ok(0o600),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(0o600),
        Err(e) => Err(e),
    }
}
fn sync_directory(root: &Path) -> io::Result<()> { File::open(root)?.sync_all() }
fn stage(root: &Path, contents: &[u8], final_mode: u32) -> io::Result<PathBuf> {
    let path = root.join(format!(".workspace-registry-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new(); options.write(true).create_new(true);
    #[cfg(unix)] options.mode(0o600);
    let result = (|| {
        let mut file = options.open(&path)?;
        file.write_all(contents)?;
        #[cfg(unix)] file.set_permissions(fs::Permissions::from_mode(final_mode))?;
        file.sync_all()?;
        Ok(path.clone())
    })();
    if result.is_err() { let _ = fs::remove_file(&path); }
    result
}
fn before(root: &Path) -> io::Result<Vec<Value>> {
    FILES.iter().map(|name| {
        let path = root.join(name);
        let bytes = match fs::read_to_string(&path) {
            Ok(text) => Some(text),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        Ok(json!({"name":name,"contents":bytes,"mode":mode(&path)?}))
    }).collect()
}
fn restore(root: &Path, rows: &[Value]) -> io::Result<()> {
    for (row, name) in rows.iter().zip(FILES) {
        if row["name"] != name { return Err(io::Error::other("Invalid workspace transaction")); }
        let target = root.join(name);
        if let Some(text) = row["contents"].as_str() {
            let temporary = stage(root, text.as_bytes(), row["mode"].as_u64().ok_or_else(|| io::Error::other("Invalid workspace mode"))? as u32)?;
            if let Err(error) = fs::rename(&temporary, target) { let _=fs::remove_file(temporary); return Err(error); }
        } else if target.exists() { fs::remove_file(target)?; }
    }
    sync_directory(root)
}
pub(super) fn recover(root: &Path) -> io::Result<()> {
    let path = root.join(JOURNAL);
    let journal: Value = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if journal["schema"] != "o8/workspace-registry-transaction/v1" { return Err(io::Error::other("Invalid workspace transaction")); }
    let rows=journal["before"].as_array().filter(|r|r.len()==2).ok_or_else(||io::Error::other("Invalid workspace transaction"))?;
    restore(root,rows)?;
    fs::remove_file(path)?;
    sync_directory(root)
}
pub(super) fn commit(root: &Path, repos: &Value, projects: &Value) -> io::Result<()> {
    recover(root)?;
    let original = before(root)?;
    let mut staged = Vec::new();
    let result = (|| {
        for (index, value) in [repos,projects].iter().enumerate() {
            staged.push(stage(root, &serde_json::to_vec_pretty(value)?, original[index]["mode"].as_u64().unwrap() as u32)?);
        }
        let journal = json!({"schema":"o8/workspace-registry-transaction/v1","before":original});
        let temporary = stage(root,&serde_json::to_vec(&journal)?,0o600)?;
        fs::rename(temporary,root.join(JOURNAL))?; sync_directory(root)?;
        for (temporary,name) in staged.iter().zip(FILES) { fs::rename(temporary,root.join(name))?; }
        sync_directory(root)?;
        fs::remove_file(root.join(JOURNAL))?; sync_directory(root)
    })();
    for path in staged { let _ = fs::remove_file(path); }
    if result.is_err() { recover(root)?; }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pair_commit_preserves_modes_and_recovers_an_interrupted_replacement() {
        let root=std::env::temp_dir().join(format!("o8-pair-{}",uuid::Uuid::new_v4())); fs::create_dir(&root).unwrap();
        for name in FILES { fs::write(root.join(name),b"{\"before\":true}").unwrap();
            #[cfg(unix)] fs::set_permissions(root.join(name),fs::Permissions::from_mode(0o660)).unwrap(); }
        let original=before(&root).unwrap();
        let journal=json!({"schema":"o8/workspace-registry-transaction/v1","before":original});
        fs::write(root.join(JOURNAL),serde_json::to_vec(&journal).unwrap()).unwrap();
        fs::write(root.join(FILES[0]),b"{\"partial\":true}").unwrap(); recover(&root).unwrap();
        for name in FILES { assert_eq!(fs::read_to_string(root.join(name)).unwrap(),"{\"before\":true}"); }
        commit(&root,&json!({"repos":[]}),&json!({"projects":[]})).unwrap();
        for name in FILES { assert_eq!(mode(&root.join(name)).unwrap(),0o660); }
        assert_eq!(fs::read_dir(&root).unwrap().count(),2); fs::remove_dir_all(root).unwrap();
    }
}
