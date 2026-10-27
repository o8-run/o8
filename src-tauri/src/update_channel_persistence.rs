//! Acknowledged enrollment must survive interruption of a later transition.
use std::io::Write;
use std::path::Path;

// Keep this file outside the general preferences plugin: that plugin saves all
// registered stores with a truncating write on app exit, even with autosave off.
pub(super) fn load(path: &Path) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Map::new()),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn save(
    path: &Path,
    entries: serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("Update preferences have no parent directory.")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".update-channel-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&serde_json::to_vec(&entries).map_err(|error| error.to_string())?)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())?;
    drop(file);
    // Failed or interrupted staging remains separate; never truncate the last
    // acknowledged enrollment or delete an unexpected temporary replacement.
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())?;
    // Once rename commits, memory must retain that committed value even if the
    // filesystem cannot sync directory metadata. The file itself was synced.
    #[cfg(unix)]
    if let Err(error) = std::fs::File::open(parent).and_then(|directory| directory.sync_all()) {
        log::warn!("Update preferences committed; directory sync unavailable: {error}");
    }
    Ok(())
}
