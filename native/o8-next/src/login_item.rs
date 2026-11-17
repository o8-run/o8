//! Launch at login: the per-user launch agent the classic shell registered.
//!
//! The classic shell wrote `~/Library/LaunchAgents/o8.plist` pointing at the
//! bundle executable and enabled it once on first run. The bundle keeps that
//! executable name, so an existing registration keeps launching o8. Only an
//! explicit choice here writes or removes the file; nothing enables it by
//! default.
use std::path::{Path, PathBuf};

/// The settings row this module answers instead of the server.
pub(crate) const FIELD: &str = "launchAtLogin";
const LABEL: &str = "o8";
/// The classic first-run marker. Writing it keeps an older build from
/// re-enabling launch at login over a choice made here.
const CHOSEN_MARKER: &str = "autostart_initialized";

pub(crate) struct Paths {
    pub agent: PathBuf,
    pub marker: PathBuf,
}

impl Paths {
    pub(crate) fn current() -> Option<Self> {
        let home = std::env::var("HOME").ok().filter(|home| !home.is_empty())?;
        let data = std::env::var("O8_DATA_DIR")
            .or_else(|_| std::env::var("CORTEX_IDE_DATA_DIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|_| Path::new(&home).join(".o8"));
        Some(Self {
            agent: Path::new(&home).join(format!("Library/LaunchAgents/{LABEL}.plist")),
            marker: data.join(CHOSEN_MARKER),
        })
    }

    /// Registered means the agent file exists, as the classic shell read it.
    pub(crate) fn enabled(&self) -> bool {
        self.agent.is_file()
    }

    pub(crate) fn set(&self, enabled: bool, executable: Option<&Path>) -> Result<(), String> {
        if enabled {
            let executable = executable.ok_or("Launch at login needs o8 installed as an app.")?;
            let parent = self.agent.parent().ok_or("No LaunchAgents folder.")?;
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            std::fs::write(&self.agent, agent_plist(executable))
                .map_err(|error| error.to_string())?;
        } else {
            match std::fs::remove_file(&self.agent) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        if let Some(parent) = self.marker.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&self.marker, "true");
        Ok(())
    }
}

/// The app bundle's own executable, which the launch agent starts.
pub(crate) fn bundle_executable(current: &Path) -> Option<PathBuf> {
    // The outermost bundle: helpers may live in nested bundles.
    let bundle = current
        .ancestors()
        .filter(|path| path.extension().is_some_and(|ext| ext == "app"))
        .last()?;
    let executable = bundle.join("Contents/MacOS/o8");
    executable.is_file().then_some(executable)
}

pub(crate) fn current_executable() -> Option<PathBuf> {
    bundle_executable(&std::env::current_exe().ok()?)
}

fn agent_plist(executable: &Path) -> String {
    let path = executable
        .to_string_lossy()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{path}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("o8-login-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn paths(root: &Path) -> Paths {
        Paths {
            agent: root.join("Library/LaunchAgents/o8.plist"),
            marker: root.join(".o8/autostart_initialized"),
        }
    }

    #[test]
    fn enabling_writes_the_classic_agent_and_disabling_removes_it() {
        let root = root("enable");
        let paths = paths(&root);
        assert!(!paths.enabled(), "nothing is registered by default");
        let executable = Path::new("/Applications/o8 & co.app/Contents/MacOS/o8");
        paths.set(true, Some(executable)).unwrap();
        assert!(paths.enabled());
        let written = std::fs::read_to_string(&paths.agent).unwrap();
        assert!(written.contains("<string>o8</string>"));
        assert!(
            written.contains("<string>/Applications/o8 &amp; co.app/Contents/MacOS/o8</string>")
        );
        assert!(written.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert_eq!(std::fs::read_to_string(&paths.marker).unwrap(), "true");
        paths.set(false, None).unwrap();
        assert!(!paths.enabled());
        paths.set(false, None).unwrap();
    }

    #[test]
    fn enabling_outside_an_app_bundle_is_refused() {
        let root = root("refuse");
        let paths = paths(&root);
        assert!(paths.set(true, None).is_err());
        assert!(!paths.enabled());
        assert!(!paths.marker.exists(), "a refused choice is not a choice");
    }

    #[test]
    fn the_agent_starts_the_outermost_bundle_executable() {
        let root = root("bundle");
        let app = &root.join("o8.app");
        let helper = app.join("Contents/Helpers/o8 next.app/Contents/MacOS/o8-next");
        std::fs::create_dir_all(helper.parent().unwrap()).unwrap();
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/MacOS/o8"), "").unwrap();
        assert_eq!(
            bundle_executable(&helper),
            Some(app.join("Contents/MacOS/o8"))
        );
        assert_eq!(bundle_executable(Path::new("/usr/local/bin/o8-next")), None);
    }
}
