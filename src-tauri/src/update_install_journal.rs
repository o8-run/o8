//! An interrupted or failed automatic install must require manual recovery for that version.
use std::path::PathBuf;

pub struct InstallJournal {
    directory: PathBuf,
}
impl InstallJournal {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }
    fn path(&self, version: &str) -> Result<PathBuf, String> {
        if version.is_empty()
            || !version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".+-".contains(&b))
        {
            return Err("Invalid update version".into());
        }
        Ok(self
            .directory
            .join("automatic-install-attempts")
            .join(format!("{version}.json")))
    }
    pub fn check(&self, version: &str) -> Result<(), String> {
        match std::fs::symlink_metadata(self.path(version)?) {
            Ok(_) => Err("This version already had an automatic install attempt. Use Install to retry manually.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
    /// Only a deliberate retry may release a completed failure. An interrupted
    /// or successful attempt remains protected until it is reconciled.
    pub fn retry_failed(&self, version: &str) -> Result<(), String> {
        let path = self.path(version)?;
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        let receipt: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if receipt["outcome"] != "failed" {
            return Err("The previous install needs recovery before retrying.".into());
        }
        std::fs::remove_file(path).map_err(|e| e.to_string())
    }

    pub fn install(
        &self,
        version: &str,
        install: impl FnOnce() -> Result<(), String>,
        after_install: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        self.install_if_admitted(version, || install().map(|_| true), after_install)
            .map(|_| ())
    }

    /// False is a proven admission refusal before any installer was launched.
    /// Only that result may remove the marker; errors and interruption keep it.
    pub fn install_if_admitted(
        &self,
        version: &str,
        install: impl FnOnce() -> Result<bool, String>,
        after_install: impl FnOnce() -> Result<(), String>,
    ) -> Result<bool, String> {
        self.check(version)?;
        let path = self.path(version)?;
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.write_all(b"{\"outcome\":\"attempting\"}")
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        let result = install().and_then(|installed| {
            if installed {
                after_install()?;
            }
            Ok(installed)
        });
        if result == Ok(false) {
            std::fs::remove_file(path).map_err(|error| error.to_string())?;
            return Ok(false);
        }
        // The pre-install marker already suppresses a retry if this write or the process fails.
        let _ = std::fs::write(
            path,
            serde_json::json!({"outcome": if result.is_ok() { "installed" } else { "failed" },
            "error": result.as_ref().err()})
            .to_string(),
        );
        result
    }
}
