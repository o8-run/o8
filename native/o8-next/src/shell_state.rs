//! Versioned shell view state only; credentials and message drafts never enter this file.
pub use crate::shell::Tab;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Workspace {
    pub tabs: Vec<Tab>,
    pub active: usize,
    /// Split panes beside the main one; none until a drop splits it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panes: Option<crate::pane_tree::Node>,
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
/// Classic right-panel preferences; pane contents and credentials stay elsewhere.
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PanelState {
    pub visible: bool,
    pub primary: String,
    pub utility_tabs: BTreeMap<String, Vec<String>>,
    pub split: bool,
    pub secondary: String,
    pub ratio: f32,
    pub tool_widths: BTreeMap<String, f32>,
    /// The split's bottom-half tabs, per workspace, like utility_tabs.
    pub secondary_tabs: BTreeMap<String, Vec<String>>,
    /// Each workspace's side chat conversation.
    pub side_chats: BTreeMap<String, String>,
    /// Each workspace's open pull request tabs ("owner/repo#7"), and the one shown.
    pub pr_tabs: BTreeMap<String, Vec<String>>,
    pub pr_selected: BTreeMap<String, String>,
}
impl Default for PanelState {
    fn default() -> Self {
        Self {
            visible: false,
            primary: "launcher".into(),
            utility_tabs: BTreeMap::new(),
            split: false,
            secondary: "o8-md".into(),
            ratio: 50.,
            tool_widths: BTreeMap::new(),
            secondary_tabs: BTreeMap::new(),
            side_chats: BTreeMap::new(),
            pr_tabs: BTreeMap::new(),
            pr_selected: BTreeMap::new(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct State {
    pub version: u32,
    pub bounds: [f32; 4],
    pub selected: Option<String>,
    pub workspaces: BTreeMap<String, Workspace>,
    /// The chat list width the person dragged; absent keeps the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_width: Option<f32>,
    /// The right panel width the person dragged; absent keeps the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right_panel_width: Option<f32>,
    #[serde(default)]
    pub right_panel: PanelState,
    /// Names the person gave tabs, by tab key.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tab_labels: BTreeMap<String, String>,
    /// Native Quick docs pins, isolated by the workspace's repository path.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub quick_doc_pins: BTreeMap<String, Vec<String>>,
    /// Browser page metadata, scoped by the selected workspace. Website data is never stored here.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub browser_pages: BTreeMap<String, crate::browser_panel::Snapshot>,
    #[serde(default)]
    pub browser_pip_wide: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_pip_position: Option<[f32; 2]>,
    /// The chat list's repository scope, by project id; absent shows every repository.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sidebar_scope: BTreeMap<String, Vec<String>>,
    /// The chat list's view by project id (chronological, date or repo); absent is By date.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sidebar_view: BTreeMap<String, String>,
    /// Closed By repo folders, by repository path.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub sidebar_closed_folders: BTreeSet<String>,
    /// Snoozed inbox threads: thread id to the Unix second they come back.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sidebar_snoozes: BTreeMap<String, u64>,
    /// Workspace Notes target history and user-selected annotation ink.
    #[serde(default)]
    pub notes: crate::files_panel::NotesPreferences,
    #[serde(skip)]
    pub(crate) retain_file: bool,
    #[serde(skip)]
    pub(crate) backup_file: Arc<Mutex<bool>>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            version: 1,
            bounds: [100., 100., 1200., 816.],
            selected: None,
            workspaces: BTreeMap::new(),
            sidebar_width: None,
            right_panel_width: None,
            right_panel: Default::default(),
            tab_labels: BTreeMap::new(),
            quick_doc_pins: BTreeMap::new(),
            browser_pages: BTreeMap::new(),
            browser_pip_wide: false,
            browser_pip_position: None,
            sidebar_scope: BTreeMap::new(),
            sidebar_view: BTreeMap::new(),
            sidebar_closed_folders: BTreeSet::new(),
            sidebar_snoozes: BTreeMap::new(),
            notes: Default::default(),
            retain_file: false,
            backup_file: Arc::default(),
        }
    }
}
pub(crate) fn clean_pins(paths: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut pins = Vec::new();
    for path in paths {
        let bytes = path.as_bytes();
        if !path.starts_with('/')
            && !(bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
            && !path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            && !pins.contains(&path)
            && pins.len() < 50
        {
            pins.push(path);
        }
    }
    pins
}
impl State {
    pub fn pins(&self, repo: &str) -> Vec<String> {
        self.quick_doc_pins.get(repo).cloned().unwrap_or_default()
    }
    pub fn set_pins(&mut self, repo: String, paths: Vec<String>) {
        let paths = clean_pins(paths);
        if paths.is_empty() {
            self.quick_doc_pins.remove(&repo);
        } else {
            self.quick_doc_pins.insert(repo, paths);
        }
    }
    fn recovered() -> Self {
        Self {
            backup_file: Arc::new(Mutex::new(true)),
            ..Self::default()
        }
    }
    fn validate(&self) -> Result<(), String> {
        let [x, y, w, h] = self.bounds;
        if self.version != 1
            || self.bounds.iter().any(|n| !n.is_finite())
            || x.abs() > 100_000.
            || y.abs() > 100_000.
            || !(600. ..=16_384.).contains(&w)
            || !(400. ..=16_384.).contains(&h)
            || !self.right_panel.ratio.is_finite()
            || !(25. ..=75.).contains(&self.right_panel.ratio)
            || self.right_panel.utility_tabs.len() > 500
            || self
                .right_panel
                .utility_tabs
                .values()
                .any(|tabs| tabs.len() > 16)
            || self
                .right_panel
                .tool_widths
                .values()
                .any(|w| !w.is_finite() || !(0. ..=1200.).contains(w))
            || self.workspaces.len() > 500
            || self.quick_doc_pins.len() > 500
            || self
                .quick_doc_pins
                .values()
                .any(|paths| clean_pins(paths.clone()) != *paths)
            || self.sidebar_scope.len() > 500
            || self.sidebar_scope.values().any(|keys| keys.len() > 500)
            || self.sidebar_view.len() > 500
            || self.sidebar_closed_folders.len() > 2_000
            || self.sidebar_snoozes.len() > 2_000
            || self.tab_labels.len() > 16_000
            || self
                .tab_labels
                .values()
                .any(|label| label.chars().count() > 80)
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
            return Ok(Self::recovered());
        }
        let state: Self = match serde_json::from_slice(&bytes) {
            Ok(state) => state,
            Err(_) => return Ok(Self::recovered()),
        };
        if state.validate().is_err() {
            return Ok(Self::recovered());
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
        // State clones share this marker, so only the first successful recovery
        // moves the input aside. Keep failed saves from bypassing preservation.
        let mut backup = self
            .backup_file
            .lock()
            .map_err(|_| "Shell state recovery unavailable")?;
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
        if *backup {
            preserve(file)?;
            *backup = false;
        }
        fs::rename(&temporary, file).map_err(|_| "Cannot commit shell state".into())
    }
}

fn preserve(file: &Path) -> Result<(), String> {
    if let Err(error) = fs::symlink_metadata(file) {
        return if error.kind() == std::io::ErrorKind::NotFound {
            Ok(())
        } else {
            Err("Cannot preserve shell state; original file retained".into())
        };
    }
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for suffix in 0..100 {
        let mut name = file
            .file_name()
            .ok_or("Invalid shell state path")?
            .to_os_string();
        name.push(format!(".bad-{time}-{}-{suffix}", std::process::id()));
        let destination = file.with_file_name(name);
        // Reserve a new name: an earlier recovery copy is never overwritten,
        // even if the clock repeats or another process saves concurrently.
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
        {
            Ok(reservation) => {
                drop(reservation);
                if fs::rename(file, &destination).is_ok() {
                    return Ok(());
                }
                let _ = fs::remove_file(destination);
                return Err("Cannot preserve shell state; original file retained".into());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("Cannot preserve shell state; original file retained".into()),
        }
    }
    Err("Cannot reserve a shell state recovery copy; original file retained".into())
}
