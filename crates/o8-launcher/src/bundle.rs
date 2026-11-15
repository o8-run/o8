//! Launch configuration read from the app bundle the launcher runs in.
use std::path::{Path, PathBuf};

/// The launch configuration of an installed bundle: the packaged server under
/// `Contents/Resources/server`, the window beside this program, and the same
/// data directory rule as the classic shell (`O8_DATA_DIR`, then
/// `CORTEX_IDE_DATA_DIR`, then `~/.o8`). The runtime is left empty for the
/// startup checks to find. `None` outside a bundle or when a part is missing.
pub fn configuration(
    executable: &Path,
    primary: Option<PathBuf>,
    legacy: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Option<serde_json::Value> {
    let contents = executable.parent()?.parent()?;
    let app = contents.parent()?;
    if contents.file_name()? != "Contents" || app.extension()? != "app" {
        return None;
    }
    let server_dir = contents.join("Resources/server");
    let window = contents.join("MacOS/o8-next");
    if !server_dir.join("server.js").is_file() || !window.is_file() {
        return None;
    }
    let data_dir = [primary, legacy]
        .into_iter()
        .flatten()
        .find(|path| path.is_absolute())
        .or_else(|| {
            home.filter(|path| path.is_absolute())
                .map(|path| path.join(".o8"))
        })?;
    Some(serde_json::json!({
        "data_dir": data_dir,
        "server_dir": server_dir,
        "node": "",
        "window": window,
        "version": crate::update::bundle_version(app)?,
    }))
}

#[cfg(test)]
mod tests {
    /// A bundle supplies its own paths; anything else is refused.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_bundle_supplies_its_own_launch_paths() {
        use std::{fs, path::PathBuf};
        let root = std::env::temp_dir().join(format!("o8-bundle-config-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let contents = root.join("o8.app/Contents");
        // Other tests narrow the process umask for a moment, so set modes here.
        use std::os::unix::fs::PermissionsExt;
        let open = |path: &std::path::Path, mode: u32| {
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap()
        };
        let folder = |path: PathBuf| {
            let _ = fs::create_dir(&path);
            open(&path, 0o700);
        };
        for path in [
            "",
            "o8.app",
            "o8.app/Contents",
            "o8.app/Contents/MacOS",
            "o8.app/Contents/Resources",
            "o8.app/Contents/Resources/server",
        ] {
            folder(root.join(path));
        }
        let write = |path: PathBuf, text: &str| {
            fs::write(&path, text).unwrap();
            open(&path, 0o600);
        };
        write(contents.join("Info.plist"), "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict><key>CFBundleShortVersionString</key><string>9.8.7</string></dict></plist>\n");
        let executable = contents.join("MacOS/o8");
        let home = Some(PathBuf::from("/fixture/home"));
        // No packaged server and no window yet.
        assert!(super::configuration(&executable, None, None, home.clone()).is_none());
        write(contents.join("Resources/server/server.js"), "");
        write(contents.join("MacOS/o8-next"), "");
        let config = super::configuration(&executable, None, None, home.clone()).unwrap();
        assert_eq!(
            config,
            serde_json::json!({
                "data_dir": "/fixture/home/.o8",
                "server_dir": contents.join("Resources/server"),
                "node": "",
                "window": contents.join("MacOS/o8-next"),
                "version": "9.8.7",
            })
        );
        // The explicit override wins, then the legacy one; a relative value is skipped.
        let pick = |primary: Option<&str>, legacy: Option<&str>| {
            super::configuration(
                &executable,
                primary.map(PathBuf::from),
                legacy.map(PathBuf::from),
                home.clone(),
            )
            .unwrap()["data_dir"]
                .clone()
        };
        assert_eq!(
            pick(Some("/fixture/a"), Some("/fixture/b")),
            serde_json::json!("/fixture/a")
        );
        assert_eq!(
            pick(Some("relative"), Some("/fixture/b")),
            serde_json::json!("/fixture/b")
        );
        // Outside a bundle there is nothing to read.
        assert!(super::configuration(&root.join("bin/o8"), None, None, home).is_none());
        fs::remove_dir_all(&root).unwrap();
    }
}
