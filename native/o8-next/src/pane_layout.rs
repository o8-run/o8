//! Explicit, workspace-scoped native view state. No application-data discovery.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Read, path::PathBuf};

pub const SIZES: [usize; 4] = [1, 2, 4, 6];

#[derive(Clone)]
pub struct Options {
    pub size: usize,
    pub workspace: String,
    pub file: PathBuf,
}
impl Options {
    pub fn extract(args: &mut Vec<String>) -> Result<Option<Self>, String> {
        let mut size = None;
        let mut workspace = None;
        let mut file = None;
        let mut rest = vec![];
        let mut index = 0;
        while index < args.len() {
            match args[index].as_str() {
                "--pane-grid" | "--workspace" | "--pane-layout" => {
                    let flag = args[index].as_str();
                    index += 1;
                    let value = args.get(index).ok_or("Missing pane grid flag value")?;
                    match flag {
                        "--pane-grid" => {
                            if size.is_some() {
                                return Err("Duplicate --pane-grid".into());
                            }
                            size = Some(
                                value
                                    .parse::<usize>()
                                    .map_err(|_| "Use --pane-grid 1|2|4|6")?,
                            );
                        }
                        "--workspace" => {
                            if workspace.is_some() {
                                return Err("Duplicate --workspace".into());
                            }
                            workspace = Some(value.clone());
                        }
                        _ => {
                            if file.is_some() {
                                return Err("Duplicate --pane-layout".into());
                            }
                            file = Some(PathBuf::from(value));
                        }
                    }
                }
                _ => rest.push(args[index].clone()),
            }
            index += 1;
        }
        *args = rest;
        let Some(size) = size else {
            if workspace.is_some() || file.is_some() {
                return Err("Workspace/layout require --pane-grid".into());
            }
            return Ok(None);
        };
        if !SIZES.contains(&size) {
            return Err("Use --pane-grid 1|2|4|6".into());
        }
        let workspace =
            workspace.ok_or("Pane grid requires --workspace with the selected repository path")?;
        let file = file.ok_or("Pane grid requires --pane-layout with an explicit absolute file")?;
        if !PathBuf::from(&workspace).is_absolute() || !file.is_absolute() {
            return Err("Pane workspace and layout file must be absolute".into());
        }
        Ok(Some(Self {
            size,
            workspace,
            file,
        }))
    }
    fn read(&self) -> Result<BTreeMap<String, Layout>, String> {
        let file = match fs::File::open(&self.file) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BTreeMap::new());
            }
            Err(_) => return Err("Cannot read pane layout".into()),
        };
        let mut bytes = vec![];
        file.take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read pane layout")?;
        if bytes.len() > 1024 * 1024 {
            return Err("Pane layout exceeds 1 MiB".into());
        }
        let layouts: BTreeMap<String, Layout> = serde_json::from_slice(&bytes)
            .map_err(|_| "Invalid pane layout; original file retained")?;
        for layout in layouts.values() {
            if !SIZES.contains(&layout.size)
                || layout.sessions.len() != 6
                || layout.views.len() != 6
                || layout.focus >= layout.size
            {
                return Err("Invalid pane layout; original file retained".into());
            }
        }
        Ok(layouts)
    }
    pub fn load(&self) -> Result<Option<Layout>, String> {
        Ok(self.read()?.remove(&self.workspace))
    }
    pub fn save(&self, layout: &Layout) -> Result<(), String> {
        let mut layouts = self.read()?;
        layouts.insert(self.workspace.clone(), layout.clone());
        let bytes = serde_json::to_vec_pretty(&layouts).map_err(|_| "Cannot encode pane layout")?;
        let temporary = self
            .file
            .with_extension(format!("pane-{}.tmp", std::process::id()));
        // The caller selects an existing writable directory. Never create app paths.
        fs::write(&temporary, bytes).map_err(|_| "Cannot save pane layout")?;
        fs::rename(&temporary, &self.file).map_err(|_| "Cannot commit pane layout".into())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Layout {
    pub size: usize,
    pub sessions: Vec<Option<String>>,
    pub focus: usize,
    #[serde(default = "transcript_views")]
    pub views: Vec<View>,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum View {
    #[default]
    Transcript,
    Terminal,
}
fn transcript_views() -> Vec<View> {
    vec![View::Transcript; 6]
}
impl Layout {
    pub fn new(size: usize, keys: impl Iterator<Item = String>) -> Self {
        let mut sessions: Vec<_> = keys.take(6).map(Some).collect();
        sessions.resize(6, None);
        Self {
            size,
            sessions,
            focus: 0,
            views: transcript_views(),
        }
    }
    pub fn columns(&self) -> usize {
        match self.size {
            1 => 1,
            6 => 3,
            _ => 2,
        }
    }
    pub fn neighbor(&self, key: &str) -> usize {
        let columns = self.columns();
        let index = self.focus;
        match key {
            "left" if index % columns > 0 => index - 1,
            "right" if index % columns + 1 < columns && index + 1 < self.size => index + 1,
            "up" if index >= columns => index - columns,
            "down" if index + columns < self.size => index + columns,
            _ => index,
        }
    }
}
