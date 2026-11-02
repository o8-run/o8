//! Classic WorkspaceFileTree / QuickDocFilePicker search policy.
use super::{Entry, FILE};
use crate::{
    client::Client,
    composer::{Composer, Submit},
    theme::current as theme,
};
use gpui::{prelude::*, *};
use serde_json::Value;
use std::time::Duration;

pub(super) fn parse_entries(body: &Value) -> Vec<Entry> {
    body["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            Some(Entry {
                name: entry["name"].as_str()?.to_owned().into(),
                path: entry["path"].as_str()?.to_owned(),
                dir: entry["kind"] == "directory" || entry["type"] == "dir",
                ignored: entry["ignored"] == true,
            })
        })
        .collect()
}

/// Same validation as quick-doc-pins.ts, including absolute selection normalization.
pub(super) fn repo_relative<'a>(repo: &str, file: &'a str) -> Option<&'a str> {
    if repo.is_empty() || file.is_empty() {
        return None;
    }
    let prefix = format!("{}/", repo.strip_suffix('/').unwrap_or(repo));
    let relative = file.strip_prefix(&prefix).unwrap_or(file);
    let bytes = relative.as_bytes();
    if relative.starts_with('/')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        None
    } else {
        Some(relative)
    }
}

fn file_kind(path: &str) -> &'static str {
    let base = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    if matches!(
        base.as_str(),
        ".gitignore" | ".gitattributes" | ".gitmodules"
    ) {
        return "git";
    }
    if base.starts_with(".env") {
        return "config";
    }
    match base.rsplit('.').next().unwrap_or("") {
        "ts" => "ts",
        "js" => "js",
        "tsx" | "jsx" => "react",
        "json" | "jsonc" | "json5" => "json",
        "yaml" | "yml" | "toml" | "ini" | "env" => "config",
        "md" | "mdx" | "markdown" => "markdown",
        "png" | "jpg" | "jpeg" | "svg" | "webp" | "gif" | "avif" | "ico" => "image",
        "css" | "scss" | "sass" | "less" | "html" | "htm" | "xml" => "markup",
        "rs" | "py" | "go" | "sh" | "bash" | "zsh" | "c" | "cpp" | "swift" | "rb" => "code",
        _ => "file",
    }
}
pub(super) fn file_color(path: &str) -> Rgba {
    let index = match file_kind(path) {
        "ts" | "react" => 4,
        "js" | "json" | "git" => 3,
        "markdown" | "image" => 2,
        "code" | "markup" => 6,
        _ => return theme().text_muted,
    };
    rgb(theme().terminal_ansi[index])
}
pub(super) fn file_icon(path: &str) -> &'static str {
    match file_kind(path) {
        "ts" => "M3 3h18v18H3z M5 9h8m-4 0v9 M19 10c-1-2-5-2-5 1s5 1 5 4-4 4-5 2",
        "js" => "M3 3h18v18H3z M10 9v7c0 3-4 3-4 0 M19 10c-1-2-5-2-5 1s5 1 5 4-4 4-5 2",
        "react" => {
            "M2 12a10 4 0 1 0 20 0 10 4 0 1 0-20 0 M7 3.34a4 10-30 1 0 10 17.32A4 10-30 1 0 7 3.34 M17 3.34a4 10 30 1 0-10 17.32A4 10 30 1 0 17 3.34 M11 12h2"
        }
        "git" => "M12 2 22 12 12 22 2 12Z M9 5v10m0-6 6 6 M8 14h2v2H8z M14 14h2v2h-2z",
        "markdown" => "M2 18V6l4 6 4-6v12m5-7 3 4 3-4m-3 4V6",
        "json" | "config" => {
            "M9 3H7v6c0 2-1 3-3 3 2 0 3 1 3 3v6h2m6-18h2v6c0 2 1 3 3 3-2 0-3 1-3 3v6h-2"
        }
        "image" => "M3 3h18v18H3z M3 17l5-5 4 4 4-6 5 7 M7 7h2v2H7z",
        "code" | "markup" => "m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18",
        _ => FILE,
    }
}

const RESULT_LIMIT: usize = 500;
#[derive(Clone)]
struct Listing {
    entries: std::sync::Arc<Vec<Entry>>,
    truncated: bool,
}
fn listing(body: Value, workspace: &str, limit: usize) -> Result<Listing, String> {
    if let Some(error) = body["error"].as_str() {
        return Err(error.to_owned());
    }
    let entries: Vec<_> = parse_entries(&body)
        .into_iter()
        .filter(|entry| {
            !entry.dir && repo_relative(workspace, &entry.path) == Some(entry.path.as_str())
        })
        .take(limit)
        .collect();
    Ok(Listing {
        entries: entries.into(),
        truncated: body["truncated"] == true,
    })
}
// The older server can silently fall back to a capped directory walk when its
// Git command times out or exceeds 4 MB. Read the complete local index once per
// search session, without either server limit. This runs on a background thread.
fn git_listing(workspace: &str) -> Result<Listing, String> {
    let output = std::process::Command::new("git")
        .args([
            "-C",
            workspace,
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|_| "Couldn't read repository index")?;
    if !output.status.success() {
        return Err("Couldn't read repository index".into());
    }
    let entries = output
        .stdout
        .split(|byte| *byte == 0)
        .filter_map(|path| std::str::from_utf8(path).ok())
        .filter(|path| repo_relative(workspace, path) == Some(*path))
        .map(|path| Entry {
            name: path.rsplit('/').next().unwrap_or(path).to_owned().into(),
            path: path.to_owned(),
            dir: false,
            ignored: false,
        })
        .collect::<Vec<_>>();
    Ok(Listing {
        entries: entries.into(),
        truncated: false,
    })
}
/// Same path matching as the server, extended to the complete Git and flat lists.
pub(super) fn merge_matches(
    query: &str,
    server: &[Entry],
    flat: &[Entry],
    git: &[Entry],
) -> (Vec<Entry>, bool) {
    let query = query.trim().to_lowercase();
    let terms: Vec<_> = query.split_whitespace().collect();
    let mut seen = std::collections::HashSet::new();
    let mut entries: Vec<_> = server
        .iter()
        .chain(flat)
        .chain(git)
        .filter(|entry| {
            let path = entry.path.to_lowercase();
            !entry.dir
                && terms.iter().all(|term| path.contains(term))
                && seen.insert(entry.path.clone())
        })
        .cloned()
        .collect();
    entries.sort_by_cached_key(|entry| {
        let path = entry.path.to_lowercase();
        (path.rsplit('/').next().unwrap_or(&path) != query, path)
    });
    let truncated = entries.len() > RESULT_LIMIT;
    entries.truncate(RESULT_LIMIT);
    (entries, truncated)
}

pub(super) struct Pick(pub String);
impl EventEmitter<Pick> for Search {}

#[derive(Clone, Copy)]
pub(super) enum Tool {
    Refresh,
    ToggleExpansion,
}
impl EventEmitter<Tool> for Search {}
#[path = "search_view.rs"]
mod view;
pub(super) struct Search {
    client: Client,
    workspace: String,
    pub(super) input: Entity<Composer>,
    pub(super) focus: FocusHandle,
    query: String,
    picker: bool,
    pub(super) refreshing: bool,
    pub(super) expanded: bool,
    pub(super) pinned: Vec<String>,
    pub(super) current: Option<String>,
    entries: Option<Result<Vec<Entry>, String>>,
    truncated: bool,
    server: Option<Result<Listing, String>>,
    flat: Option<Result<Listing, String>>,
    flat_pending: Option<Task<()>>,
    git: Option<Result<Listing, String>>,
    git_pending: Option<Task<()>>,
    pub(super) scroll: UniformListScrollHandle,
    merge_pending: Option<Task<()>>,
    session: u64,
    merge_generation: u64,
    generation: u64,
    pending: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
    row_focus: std::collections::HashMap<String, FocusHandle>,
    pub(super) close_focus: Option<FocusHandle>,
}
impl Search {
    pub(super) fn new(
        client: Client,
        workspace: String,
        picker: bool,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| {
            let mut input = Composer::new(cx);
            input.placeholder = if picker {
                "Search files in this repo"
            } else {
                "Search files"
            }
            .into();
            input.inline = true;
            input
        });
        let observe = cx.observe(&input, |this, _, cx| this.changed(false, cx));
        let submit = cx.subscribe(&input, |this, _, _: &Submit, cx| {
            if let Some(entry) = this
                .visible_entries()
                .into_iter()
                .find(|entry| !this.pinned.contains(&entry.path))
            {
                cx.emit(Pick(entry.path));
            }
        });
        let mut search = Self {
            client,
            workspace,
            focus: input.read(cx).focus.clone(),
            input,
            query: String::new(),
            picker,
            refreshing: false,
            expanded: false,
            pinned: vec![],
            current: None,
            entries: None,
            truncated: false,
            server: None,
            flat: None,
            flat_pending: None,
            git: None,
            git_pending: None,
            scroll: UniformListScrollHandle::new(),
            merge_pending: None,
            session: 0,
            merge_generation: 0,
            generation: 0,
            pending: None,
            _subscriptions: vec![observe, submit],
            row_focus: Default::default(),
            close_focus: None,
        };
        if picker {
            search.changed(true, cx);
        }
        search
    }
    pub(super) fn refresh(&mut self, cx: &mut Context<Self>) {
        self.session += 1;
        self.flat = None;
        self.git = None;
        self.flat_pending = None;
        self.git_pending = None;
        if self.searching() {
            self.load_flat(cx);
            self.load_git(cx);
        }
        self.changed(true, cx);
    }
    fn clear(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |input, cx| input.clear(cx));
        self.changed(false, cx);
        self.focus(window);
    }
    pub(super) fn picker_height(&self) -> f32 {
        let rows = if self
            .entries
            .as_ref()
            .is_some_and(|e| e.as_ref().is_ok_and(|e| !e.is_empty()))
        {
            (self.visible_entries().len() as f32 * 34.).min(236.)
        } else {
            36.
        };
        88. + rows
    }
    pub(super) fn focus(&self, window: &mut Window) {
        self.focus.focus(window);
    }
    pub(super) fn focus_from_close(&self, backwards: bool, window: &mut Window) {
        if backwards
            && let Some(focus) = self
                .visible_entries()
                .iter()
                .rev()
                .filter(|entry| !self.pinned.contains(&entry.path))
                .find_map(|entry| self.row_focus.get(&entry.path))
        {
            focus.focus(window);
        } else {
            self.focus(window);
        }
    }
    pub(super) fn searching(&self) -> bool {
        !self.query.is_empty()
    }
    fn changed(&mut self, force: bool, cx: &mut Context<Self>) {
        let query = self.input.read(cx).text.trim().to_owned();
        if !force && query == self.query {
            return;
        }
        let starting = self.query.is_empty() && !query.is_empty();
        self.query = query.clone();
        self.scroll = UniformListScrollHandle::new();
        self.generation += 1;
        self.merge_generation += 1;
        let generation = self.generation;
        self.pending = None;
        self.merge_pending = None;
        self.entries = None;
        self.server = None;
        self.truncated = false;
        if query.is_empty() {
            self.session += 1;
            self.flat_pending = None;
            self.flat = None;
            self.git_pending = None;
            self.git = None;
        }
        cx.notify();
        if starting {
            self.load_flat(cx);
            self.load_git(cx);
        }
        if !self.picker && query.is_empty() {
            return;
        }
        self.merge(cx);
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        self.pending = Some(cx.spawn(async move |this, cx| {
            if !query.is_empty() {
                cx.background_executor()
                    .timer(Duration::from_millis(150))
                    .await;
            }
            let result = cx
                .background_executor()
                .spawn(async move {
                    let key = if query.is_empty() {
                        "directory"
                    } else {
                        "search"
                    };
                    let value = if query.is_empty() {
                        "."
                    } else {
                        query.as_str()
                    };
                    client.get::<Value>(
                        "/api/panel/files",
                        &[("workspace", workspace.as_str()), (key, value)],
                    )
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                this.server =
                    Some(result.and_then(|body| listing(body, &this.workspace, RESULT_LIMIT)));
                this.merge(cx);
                cx.notify();
            });
        }));
    }
    fn load_flat(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let session = self.session;
        let task = cx.background_executor().spawn(async move {
            client
                .get::<Value>(
                    "/api/panel/files",
                    &[("workspace", workspace.as_str()), ("recursive", "files")],
                )
                .and_then(|body| listing(body, &workspace, 20_000))
        });
        self.flat_pending = Some(cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if session != this.session {
                    return;
                }
                this.flat = Some(result);
                this.merge(cx);
            });
        }));
    }
    fn load_git(&mut self, cx: &mut Context<Self>) {
        let workspace = self.workspace.clone();
        let session = self.session;
        let task = cx
            .background_executor()
            .spawn(async move { git_listing(&workspace) });
        self.git_pending = Some(cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if session != this.session {
                    return;
                }
                this.git = Some(result);
                this.merge(cx);
            });
        }));
    }
    fn merge(&mut self, cx: &mut Context<Self>) {
        if self.query.is_empty() {
            self.entries = self
                .server
                .clone()
                .map(|result| result.map(|listing| listing.entries.as_ref().clone()));
            cx.notify();
            return;
        }
        if self.server.is_none() && self.flat.is_none() && self.git.is_none() {
            return;
        }
        let server = self.server.clone();
        let flat = self.flat.clone();
        let git = self.git.clone();
        let query = self.query.clone();
        self.merge_generation += 1;
        let generation = self.merge_generation;
        // Matching, deduplication and ranking of all source paths never block paint.
        let task = cx.background_executor().spawn(async move {
            let available = server.as_ref().is_some_and(Result::is_ok)
                || flat.as_ref().is_some_and(Result::is_ok)
                || git.as_ref().is_some_and(Result::is_ok);
            if !available {
                return if server.is_some() && flat.is_some() && git.is_some() {
                    Some(Err("Couldn't load files".to_string()))
                } else {
                    None
                };
            }
            let server = server.and_then(Result::ok);
            let flat = flat.and_then(Result::ok);
            let git = git.and_then(Result::ok);
            let (entries, capped) = merge_matches(
                &query,
                server
                    .as_ref()
                    .map_or(&[], |listing| listing.entries.as_slice()),
                flat.as_ref()
                    .map_or(&[], |listing| listing.entries.as_slice()),
                git.as_ref()
                    .map_or(&[], |listing| listing.entries.as_slice()),
            );
            Some(Ok((
                entries,
                capped || server.is_some_and(|s| s.truncated) || flat.is_some_and(|s| s.truncated),
            )))
        });
        self.merge_pending = Some(cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.merge_generation {
                    return;
                }
                if let Some(result) = result {
                    this.entries = Some(result.map(|(entries, truncated)| {
                        this.truncated = truncated;
                        entries
                    }));
                    cx.notify();
                }
            });
        }));
    }
    pub(super) fn visible_entries(&self) -> Vec<Entry> {
        let mut entries = self
            .entries
            .as_ref()
            .and_then(|result| result.as_ref().ok())
            .cloned()
            .unwrap_or_default();
        if self.picker
            && self.query.is_empty()
            && let Some(current) = self
                .current
                .as_deref()
                .and_then(|file| repo_relative(&self.workspace, file))
        {
            entries.retain(|entry| entry.path != current);
            entries.insert(
                0,
                Entry {
                    name: current
                        .rsplit('/')
                        .next()
                        .unwrap_or(current)
                        .to_owned()
                        .into(),
                    path: current.into(),
                    dir: false,
                    ignored: false,
                },
            );
        }
        entries
    }
}
