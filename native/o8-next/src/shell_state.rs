//! Versioned shell view state only; credentials and message drafts never enter this file.
pub use crate::shell::Tab;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::Path,
};

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Workspace {
    pub tabs: Vec<Tab>,
    pub active: usize,
    #[serde(flatten)]
    pub surfaces: crate::shell::WorkspaceState,
}
// Retain existing session field access while its state lives in the session module.
impl std::ops::Deref for Workspace {
    type Target = crate::shell::session::Slice;
    fn deref(&self) -> &Self::Target {
        &self.surfaces.session
    }
}
impl std::ops::DerefMut for Workspace {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.surfaces.session
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct State {
    pub version: u32,
    pub bounds: [f32; 4],
    pub selected: Option<String>,
    pub workspaces: BTreeMap<String, Workspace>,
    #[serde(skip)]
    pub(crate) retain_file: bool,
}
impl Default for State {
    fn default() -> Self {
        Self {
            version: 1,
            bounds: [100., 100., 1200., 816.],
            selected: None,
            workspaces: BTreeMap::new(),
            retain_file: false,
        }
    }
}
impl State {
    fn validate(&self) -> Result<(), String> {
        let [x, y, w, h] = self.bounds;
        if self.version != 1
            || self.bounds.iter().any(|n| !n.is_finite())
            || x.abs() > 100_000.
            || y.abs() > 100_000.
            || !(600. ..=16_384.).contains(&w)
            || !(400. ..=16_384.).contains(&h)
            || self.workspaces.len() > 500
            || self
                .workspaces
                .values()
                .any(|s| s.tabs.len() > 32 || (!s.tabs.is_empty() && s.active >= s.tabs.len()))
        {
            return Err("Invalid shell state; original file retained".into());
        }
        Ok(())
    }
    pub fn load(file: &Path) -> Result<Self, String> {
        let input = match fs::File::open(file) {
            Ok(input) => input,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self {
                    retain_file: fs::symlink_metadata(file).is_ok(),
                    ..Self::default()
                });
            }
            Err(_) => {
                return Ok(Self {
                    retain_file: true,
                    ..Self::default()
                });
            }
        };
        let mut bytes = vec![];
        if input.take(1024 * 1024 + 1).read_to_end(&mut bytes).is_err() {
            return Ok(Self {
                retain_file: true,
                ..Self::default()
            });
        }
        if bytes.len() > 1024 * 1024 {
            return Ok(Self::default());
        }
        let state: Self = serde_json::from_slice(&bytes).unwrap_or_default();
        if state.validate().is_err() {
            return Ok(Self::default());
        }
        Ok(state)
    }
    pub fn save(&self, file: &Path) -> Result<(), String> {
        // An unreadable source may contain valid state. Keep this session in
        // memory rather than replacing bytes we could not inspect.
        if self.retain_file {
            return Ok(());
        }
        self.validate()?;
        let bytes = serde_json::to_vec_pretty(self).map_err(|_| "Cannot encode shell state")?;
        if bytes.len() > 1024 * 1024 {
            return Err("Shell state exceeds 1 MiB".into());
        }
        let temporary = file.with_extension(format!("shell-{}.tmp", std::process::id()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options
            .open(&temporary)
            .map_err(|_| "Cannot save shell state")?;
        output
            .write_all(&bytes)
            .and_then(|_| output.sync_all())
            .map_err(|_| "Cannot save shell state")?;
        fs::rename(&temporary, file).map_err(|_| "Cannot commit shell state".into())
    }
}
