//! Native equivalent of the classic facts-only localStorage observation store.
use super::Observation;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

fn path(server: &str) -> Option<PathBuf> {
    // Unit/UI fixtures never read or change the operator's observation history.
    if cfg!(test) {
        return None;
    }
    let name: String = server.bytes().map(|b| format!("{b:02x}")).collect();
    Some(
        PathBuf::from(std::env::var_os("HOME")?)
            .join(".o8/next/prompt-cache-observations")
            .join(format!("{name}.json")),
    )
}
pub(super) fn read(server: &str) -> Vec<Observation> {
    path(server).map_or_else(Vec::new, |path| read_file(&path))
}
fn read_file(path: &Path) -> Vec<Observation> {
    let mut bytes = vec![];
    let Ok(file) = fs::File::open(path) else {
        return vec![];
    };
    if file.take(2_000_001).read_to_end(&mut bytes).is_err() || bytes.len() > 2_000_000 {
        return vec![];
    }
    let Ok(mut rows) = serde_json::from_slice::<Vec<Observation>>(&bytes) else {
        return vec![];
    };
    rows.retain(|r| {
        super::supported(&r.runtime)
            && r.start.is_finite()
            && r.start >= 0.
            && r.end.is_finite()
            && r.end >= r.start
            && [r.input, r.read, r.write, r.idle]
                .into_iter()
                .flatten()
                .all(|v| v.is_finite() && v >= 0.)
            && r.ttl
                .is_none_or(|v| v.is_finite() && v > 0. && v <= 86_400_000.)
    });
    if rows.len() > 5000 {
        rows.drain(..rows.len() - 5000);
    }
    rows
}
pub(super) fn save(server: &str, rows: &[Observation]) {
    if let Some(path) = path(server) {
        let _ = save_file(&path, rows);
    }
}
fn save_file(path: &Path, rows: &[Observation]) -> Option<()> {
    if path
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return None;
    }
    let bytes = serde_json::to_vec(rows).ok()?;
    if bytes.len() > 2_000_000 {
        return None;
    }
    fs::create_dir_all(path.parent()?).ok()?;
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).ok()?;
    let saved = file
        .write_all(&bytes)
        .and_then(|_| file.sync_all())
        .and_then(|_| fs::rename(&temp, path));
    if saved.is_err() {
        let _ = fs::remove_file(&temp);
    }
    saved.ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_observations_survive_reopen_without_transcript_content() {
        let root = std::env::temp_dir().join(format!(
            "o8-context-store-{}-{}",
            std::process::id(),
            crate::clock::now()
        ));
        let path = root.join("observations.json");
        let rows = vec![Observation {
            id: "u".into(),
            session: "s".into(),
            runtime: "codex".into(),
            model: "m".into(),
            start: 1000.,
            end: 2000.,
            input: Some(100.),
            read: Some(900.),
            write: Some(0.),
            ttl: Some(300000.),
            idle: None,
        }];
        assert_eq!(save_file(&path, &rows), Some(()));
        assert_eq!(read_file(&path), rows);
        fs::write(&path, b"invalid").unwrap();
        assert!(read_file(&path).is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
