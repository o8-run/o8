//! Versioned shell view state only; credentials and message drafts never enter this file.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::Path,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "surface", content = "session")]
pub enum Tab {
    Session(String),
    Grid,
    Brain,
}
impl Tab {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Session(_) => "Session",
            Self::Grid => "Grid",
            Self::Brain => "Brain",
        }
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Workspace {
    pub tabs: Vec<Tab>,
    pub active: usize,
    pub composer: bool,
    #[serde(default)]
    pub selections: BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct State {
    pub version: u32,
    pub bounds: [f32; 4],
    pub selected: Option<String>,
    pub workspaces: BTreeMap<String, Workspace>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            version: 1,
            bounds: [100., 100., 1200., 816.],
            selected: None,
            workspaces: BTreeMap::new(),
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
                return Ok(Self::default());
            }
            Err(_) => return Err("Cannot read shell state".into()),
        };
        let mut bytes = vec![];
        input
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read shell state")?;
        if bytes.len() > 1024 * 1024 {
            return Err("Shell state exceeds 1 MiB".into());
        }
        let state: Self = serde_json::from_slice(&bytes)
            .map_err(|_| "Invalid shell state; original file retained")?;
        state.validate()?;
        Ok(state)
    }
    pub fn save(&self, file: &Path) -> Result<(), String> {
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
