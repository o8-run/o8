//! Recent screenshots for the "+" drawer, the way a mobile Add context sheet
//! offers recent photos. Thumbnails come from `sips` in the background and are
//! cached, so the drawer never decodes a full-size capture.
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

/// Where macOS saves screenshots: the user's chosen folder, else the Desktop.
fn folder() -> Option<&'static Path> {
    static FOLDER: OnceLock<Option<PathBuf>> = OnceLock::new();
    FOLDER
        .get_or_init(|| {
            let home = PathBuf::from(std::env::var_os("HOME")?);
            let chosen = std::process::Command::new("defaults")
                .args(["read", "com.apple.screencapture", "location"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
                .filter(|s| !s.is_empty())
                .map(|s| match s.strip_prefix("~/") {
                    Some(rest) => home.join(rest),
                    None => PathBuf::from(s),
                });
            Some(
                chosen
                    .filter(|p| p.is_dir())
                    .unwrap_or(home.join("Desktop")),
            )
        })
        .as_deref()
}

/// The newest screenshots from the last week, newest first.
pub(super) fn recent(limit: usize) -> Vec<PathBuf> {
    if cfg!(test) || !cfg!(target_os = "macos") {
        return vec![];
    }
    let Some(dir) = folder() else {
        return vec![];
    };
    let week = SystemTime::now() - Duration::from_secs(7 * 24 * 3600);
    let mut shots: Vec<(SystemTime, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            let shot = ["Screenshot", "Screen Shot", "CleanShot"]
                .iter()
                .any(|prefix| name.starts_with(prefix));
            let image = matches!(
                path.extension()?.to_str()?.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg"
            );
            let modified = entry.metadata().ok()?.modified().ok()?;
            (shot && image && modified > week).then_some((modified, path))
        })
        .collect();
    shots.sort_by(|a, b| b.0.cmp(&a.0));
    shots.into_iter().take(limit).map(|(_, p)| p).collect()
}

/// The cached thumbnail path for a capture, keyed by path and modification time.
pub(super) fn thumbnail(path: &Path) -> Option<PathBuf> {
    let modified = std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()?
        .as_secs();
    let mut hash = 0xcbf29ce484222325u64;
    for byte in path.to_string_lossy().bytes() {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    Some(home.join(format!(".o8/next/thumbs/{hash:016x}-{modified}.png")))
}

/// Writes missing thumbnails; run on the background executor.
pub(super) fn make_thumbnails(paths: Vec<PathBuf>) {
    for path in paths {
        let Some(thumb) = thumbnail(&path) else {
            continue;
        };
        if thumb.exists() {
            continue;
        }
        if let Some(dir) = thumb.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::process::Command::new("sips")
            .args(["-Z", "192"])
            .arg(&path)
            .arg("--out")
            .arg(&thumb)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}
