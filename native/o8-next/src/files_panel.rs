//! The right panel's Files and o8.md tools (WorkspaceFilesPane, O8SpecPane).
//! Files lists the workspace a directory at a time through /api/panel/files
//! and previews a file through /api/v2/files; o8.md reads /api/repo-spec.
mod markdown;
mod markdown_view;
mod media;
mod quick_docs;
mod search;
mod source;
mod viewer;
use quick_docs::QuickDocs;
#[cfg(test)]
mod tests;

use crate::client::Client;
use crate::theme::current as theme;
use gpui::{
    Context, Entity, FocusHandle, IntoElement, ParentElement, Render, SharedString, Styled,
    Subscription, Window, div, prelude::*, px, uniform_list,
};
use search::{Pick, Search, file_color, file_icon, parse_entries};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Clone)]
struct Entry {
    name: SharedString,
    path: String,
    dir: bool,
    ignored: bool,
}

enum Directory {
    Loading,
    Loaded(Vec<Entry>),
    Failed(String),
}

enum File {
    None,
    Loading,
    Loaded {
        lines: Vec<SharedString>,
        truncated: bool,
        markdown: std::rc::Rc<std::cell::RefCell<crate::retained::RowState>>,
        source: source::Source,
        image: Option<media::Preview>,
    },
    Image(std::sync::Arc<gpui::RenderImage>),
    Failed(String),
}

#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Files,
    Spec,
}

pub(crate) struct PinsChanged {
    pub workspace: String,
    pub paths: Vec<String>,
}
impl gpui::EventEmitter<PinsChanged> for FilesPanel {}

pub struct FilesPanel {
    client: Client,
    workspace: String,
    mode: Mode,
    directories: HashMap<String, Directory>,
    expanded: HashSet<String>,
    selected: Option<String>,
    file: File,
    tree_visible: bool,
    focus: FocusHandle,
    search: Entity<Search>,
    quick_docs: Option<Entity<QuickDocs>>,
    _subscriptions: Vec<Subscription>,
    file_generation: u64,
    view_modes: HashMap<String, viewer::ViewMode>,
    wrap_lines: bool,
}

impl FilesPanel {
    pub fn new(client: Client, workspace: String, mode: Mode, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| Search::new(client.clone(), workspace.clone(), false, cx));
        let picked = cx.subscribe(&search, |this, _, pick: &Pick, cx| {
            this.open_file(pick.0.clone(), cx);
        });
        let observed = cx.observe(&search, |_, _, cx| cx.notify());
        let quick_docs = (mode == Mode::Files)
            .then(|| cx.new(|cx| QuickDocs::new(client.clone(), workspace.clone(), cx)));
        let quick_pick = quick_docs.as_ref().map(|docs| {
            cx.subscribe(docs, |this, _, pick: &Pick, cx| {
                this.open_file(pick.0.clone(), cx)
            })
        });
        let pins_changed = quick_docs.as_ref().map(|docs| {
            cx.subscribe(docs, |this, _, pins: &quick_docs::PinsChanged, cx| {
                cx.emit(PinsChanged {
                    workspace: this.workspace.clone(),
                    paths: pins.0.clone(),
                });
            })
        });
        let mut panel = Self {
            client,
            workspace,
            mode,
            directories: HashMap::new(),
            expanded: HashSet::new(),
            selected: None,
            file: File::None,
            tree_visible: mode == Mode::Files,
            focus: if mode == Mode::Files {
                search.read(cx).focus.clone()
            } else {
                cx.focus_handle()
            },
            search,
            quick_docs,
            _subscriptions: vec![picked, observed]
                .into_iter()
                .chain(quick_pick)
                .chain(pins_changed)
                .collect(),
            file_generation: 0,
            view_modes: HashMap::new(),
            wrap_lines: true,
        };
        match mode {
            Mode::Files => panel.load_directory(String::new(), cx),
            Mode::Spec => panel.load_spec(cx),
        }
        panel
    }

    pub(crate) fn set_pins(&mut self, workspace: &str, paths: Vec<String>, cx: &mut Context<Self>) {
        if self.workspace == workspace
            && let Some(docs) = &self.quick_docs
        {
            docs.update(cx, |docs, cx| docs.set_pins(paths, cx));
        }
    }
    pub fn focus(&self, window: &mut Window) {
        self.focus.focus(window);
    }

    fn load_directory(&mut self, directory: String, cx: &mut Context<Self>) {
        self.directories
            .insert(directory.clone(), Directory::Loading);
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let path = directory.clone();
        let task = cx.background_executor().spawn(async move {
            client.get::<Value>(
                "/api/panel/files",
                &[
                    ("workspace", workspace.as_str()),
                    ("directory", path.as_str()),
                ],
            )
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                let state = match result {
                    Ok(body) if body["error"].is_null() => Directory::Loaded(parse_entries(&body)),
                    Ok(body) => Directory::Failed(
                        body["error"]
                            .as_str()
                            .unwrap_or("Directory listing failed")
                            .into(),
                    ),
                    Err(error) => Directory::Failed(error),
                };
                this.directories.insert(directory, state);
                cx.notify();
            });
        })
        .detach();
    }

    fn open_file(&mut self, path: String, cx: &mut Context<Self>) {
        // Search and pinned selections reveal only their ancestors. Clearing
        // search or hiding the explorer keeps that expansion and the preview.
        if let Some(relative) = search::repo_relative(&self.workspace, &path) {
            let parts: Vec<_> = relative.split('/').collect();
            for length in 1..parts.len() {
                let directory = parts[..length].join("/");
                self.expanded.insert(directory.clone());
                if !matches!(
                    self.directories.get(&directory),
                    Some(Directory::Loaded(_) | Directory::Loading)
                ) {
                    self.load_directory(directory, cx);
                }
            }
        }
        if let Some(docs) = &self.quick_docs {
            docs.update(cx, |docs, cx| {
                docs.selected = Some(path.clone());
                cx.notify();
            });
        }
        self.selected = Some(path.clone());
        self.file = File::Loading;
        if media::is_image(&path) {
            self.open_image(path, cx);
            return;
        }
        if let Some(kind) = media::unsupported(&path) {
            self.file_generation += 1;
            self.file = File::Failed(format!("{kind} preview is not available yet."));
            cx.notify();
            return;
        }
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let task = cx.background_executor().spawn(async move {
            client.get::<Value>(
                "/api/v2/files",
                &[
                    ("path", path.as_str()),
                    ("preview", "1"),
                    ("workspace", workspace.as_str()),
                ],
            )
        });
        self.finish_file(task, cx);
        cx.notify();
    }

    fn load_spec(&mut self, cx: &mut Context<Self>) {
        self.selected = Some("o8.md".into());
        self.file = File::Loading;
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let task = cx.background_executor().spawn(async move {
            client.get::<Value>("/api/repo-spec", &[("repoPath", workspace.as_str())])
        });
        self.finish_file(task, cx);
    }

    fn finish_file(&mut self, task: gpui::Task<Result<Value, String>>, cx: &mut Context<Self>) {
        self.file_generation += 1;
        let generation = self.file_generation;
        let svg = self
            .selected
            .as_deref()
            .is_some_and(media::is_svg)
            .then(|| {
                let path = media::svg_path();
                let decoder = <gpui::ImageAssetLoader as gpui::Asset>::load(
                    gpui::Resource::Path(path.clone().into()),
                    cx,
                );
                (path, decoder)
            });
        let task = cx.background_executor().spawn(async move {
            let body = task.await?;
            let image = match svg {
                Some((path, decoder)) if body["error"].is_null() => Some(
                    media::decode_svg(path, body["content"].as_str().unwrap_or_default(), decoder)
                        .await,
                ),
                _ => None,
            };
            Ok::<_, String>((body, image))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.file_generation {
                    return;
                }
                this.file = match result {
                    Ok((body, image)) if body["error"].is_null() => {
                        let content = body["content"].as_str().unwrap_or_default();
                        if content.contains('\0') {
                            File::Failed("This binary file has no text preview.".into())
                        } else {
                            File::Loaded {
                                image,
                                source: source::Source::new(content.split('\n').count()),
                                lines: content
                                    .split('\n')
                                    .map(|line| SharedString::from(line.replace('\t', "  ")))
                                    .collect(),
                                truncated: body["truncated"] == true,
                                markdown: viewer::markdown(
                                    if this.selected.as_deref().is_some_and(viewer::is_markdown) {
                                        content
                                    } else {
                                        ""
                                    },
                                ),
                            }
                        }
                    }
                    Ok((body, _)) => {
                        File::Failed(body["error"].as_str().unwrap_or("File unavailable").into())
                    }
                    Err(error) => File::Failed(error),
                };
                cx.notify();
            });
        })
        .detach();
    }

    fn toggle(&mut self, entry: &Entry, cx: &mut Context<Self>) {
        if !entry.dir {
            self.open_file(entry.path.clone(), cx);
            return;
        }
        if !self.expanded.remove(&entry.path) {
            self.expanded.insert(entry.path.clone());
            if !matches!(
                self.directories.get(&entry.path),
                Some(Directory::Loaded(_))
            ) {
                self.load_directory(entry.path.clone(), cx);
            }
        }
        cx.notify();
    }

    /// The tree flattened to the rows on screen: (depth, entry), or a status row.
    fn rows(&self) -> Vec<(usize, Result<Entry, SharedString>)> {
        let mut rows = Vec::new();
        self.push_rows("", 0, &mut rows);
        rows
    }

    fn push_rows(
        &self,
        directory: &str,
        depth: usize,
        rows: &mut Vec<(usize, Result<Entry, SharedString>)>,
    ) {
        match self.directories.get(directory) {
            Some(Directory::Loaded(entries)) => {
                if entries.is_empty() && depth == 0 {
                    rows.push((depth, Err("No files".into())));
                }
                for entry in entries {
                    rows.push((depth, Ok(entry.clone())));
                    if entry.dir && self.expanded.contains(&entry.path) {
                        self.push_rows(&entry.path, depth + 1, rows);
                    }
                }
            }
            Some(Directory::Failed(error)) => rows.push((depth, Err(error.clone().into()))),
            _ => rows.push((depth, Err("Loading…".into()))),
        }
    }

    fn tree(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let rows = self.rows();
        let selected = self.selected.clone();
        uniform_list(
            "files-tree",
            rows.len(),
            cx.processor(move |this, range: std::ops::Range<usize>, _, cx| {
                range
                    .map(|i| {
                        let (depth, row) = rows[i].clone();
                        let base = div()
                            .id(i)
                            .h(px(26.))
                            .w_full()
                            .pl(px(8. + 14. * depth as f32))
                            .pr(px(8.))
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .rounded(px(6.))
                            .text_size(px(12.))
                            .whitespace_nowrap()
                            .overflow_hidden();
                        match row {
                            Err(status) => base.text_color(theme().text_muted).child(status),
                            Ok(entry) => {
                                let open = this.expanded.contains(&entry.path);
                                let chosen = selected.as_deref() == Some(entry.path.as_str());
                                let path = entry.path.clone();
                                base.debug_selector(move || format!("files-row-{path}"))
                                    .cursor_pointer()
                                    .when(chosen, |row| row.bg(theme().selection))
                                    .when(!chosen, |row| row.hover(|row| row.bg(theme().hover)))
                                    .text_color(if entry.ignored {
                                        theme().text_faint
                                    } else if entry.dir {
                                        theme().text
                                    } else {
                                        theme().text_secondary
                                    })
                                    .child(div().w(px(12.)).flex_shrink_0().when(
                                        entry.dir,
                                        |slot| {
                                            slot.child(crate::icon::stroke(
                                                if open { CHEVRON_DOWN } else { CHEVRON_RIGHT },
                                                theme().text_muted,
                                                12.,
                                                1.8,
                                            ))
                                        },
                                    ))
                                    .child(crate::icon::stroke(
                                        if entry.dir {
                                            FOLDER
                                        } else {
                                            file_icon(&entry.path)
                                        },
                                        if entry.dir {
                                            theme().text_muted
                                        } else {
                                            file_color(&entry.path)
                                        },
                                        14.,
                                        1.6,
                                    ))
                                    .child(
                                        div()
                                            .min_w_0()
                                            .overflow_hidden()
                                            .text_ellipsis()
                                            .child(entry.name.clone()),
                                    )
                                    .on_click(
                                        cx.listener(move |this, _, _, cx| this.toggle(&entry, cx)),
                                    )
                            }
                        }
                    })
                    .collect::<Vec<_>>()
            }),
        )
        .flex_1()
        .min_h_0()
        .py(px(4.))
    }

    fn viewer(&self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let title = self.selected.clone().unwrap_or_default();
        let previewable = viewer::is_markdown(&title) || media::is_svg(&title);
        let preview = self.view_mode() == viewer::ViewMode::Preview;
        let body = match &self.file {
            File::Image(image) => media::view(image.clone(), self.file_generation, false),
            File::Loaded {
                image: Some(image), ..
            } if media::is_svg(&title) && preview => match image {
                Ok(image) => {
                    #[cfg(test)]
                    cx.set_global(tests::RenderedMedia(image.clone()));
                    media::view(image.clone(), self.file_generation, true)
                }
                Err(error) => self.file_error(error, cx),
            },
            File::Loaded { markdown, .. } if previewable && preview => {
                #[cfg(test)]
                cx.set_global(tests::RenderedMarkdown(markdown.clone()));
                markdown_view::view(markdown.clone(), self.file_generation, window, cx)
            }
            File::Loaded { lines, source, .. } => {
                source.view(lines, self.wrap_lines, self.file_generation, window)
            }
            File::Failed(error) => self.file_error(error, cx),
            _ => status("Loading…".into()).into_any_element(),
        };
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .child(
                div()
                    .min_h(px(34.))
                    .py(px(5.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .pl(px(12.))
                    .pr(px(8.))
                    .border_b_1()
                    .border_color(theme().border)
                    .child(crate::icon::stroke(file_icon(&title), file_color(&title), 14., 1.6))
                    .child(viewer::file_heading(&title, cx))
                    .when(previewable, |bar| bar.child(self.preview_toggle(cx)))
                    .when(!preview && matches!(self.file, File::Loaded { .. }), |bar| bar.child(self.wrap_toggle(cx)))
                    .when(self.mode == Mode::Files, |bar| {
                        let label = if self.tree_visible {
                            "Hide file tree"
                        } else {
                            "Show file tree"
                        };
                        bar.child(
                            div()
                                .id("files-tree-toggle")
                                .debug_selector(|| "files-tree-toggle".into())
                                .size(px(28.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(7.))
                                .cursor_pointer()
                                .hover(|button| button.bg(theme().hover))
                                .tooltip(move |_, cx| {
                                    cx.new(|_| crate::icon::Tip(label.into())).into()
                                })
                                .child(crate::icon::stroke(
                                    if self.tree_visible {
                                        TREE_SHOWN
                                    } else {
                                        TREE_HIDDEN
                                    },
                                    if self.tree_visible {
                                        theme().text_secondary
                                    } else {
                                        theme().accent
                                    },
                                    16.,
                                    1.6,
                                ))
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.tree_visible = !this.tree_visible;
                                    cx.notify();
                                })),
                        )
                    }),
            )
            .when(matches!(self.file, File::Loaded { truncated: true, .. }), |view| {
                view.child(div().px(px(12.)).py(px(6.)).text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child("Read-only preview · first 1 MB. Use an editor to change the full file."))
            })
            .child(body)
    }
}

fn status(text: String) -> impl IntoElement {
    div()
        .p(px(16.))
        .text_size(px(12.))
        .text_color(theme().text_muted)
        .child(text)
}

impl Render for FilesPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let viewing = self.selected.is_some();
        // A selected file takes the column; the tree keeps a third beside it,
        // never narrower than min(210px, 48%) (the desktop's grid track).
        let panel = crate::theme::right_panel_width(f32::from(window.viewport_size().width));
        let tree_width = (panel * 0.34).max((panel * 0.48).min(210.));
        div()
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .min_h_0()
            .when(viewing, |pane| pane.child(self.viewer(window, cx)))
            .when(
                self.mode == Mode::Files && (self.tree_visible || !viewing),
                |pane| {
                    pane.child(
                        div()
                            .when(viewing, |tree| {
                                tree.w(px(tree_width))
                                    .flex_shrink_0()
                                    .border_l_1()
                                    .border_color(theme().border)
                            })
                            .when(!viewing, |tree| tree.flex_1())
                            .h_full()
                            .min_h_0()
                            .flex()
                            .flex_col()
                            .when_some(self.quick_docs.clone(), |tree, docs| tree.child(docs))
                            .child(self.search.clone())
                            .when(!self.search.read(cx).searching(), |tree| {
                                tree.child(self.tree(cx))
                            }),
                    )
                },
            )
    }
}

const CHEVRON_RIGHT: &str = "m9 6 6 6-6 6";
const CHEVRON_DOWN: &str = "m6 9 6 6 6-6";
const FOLDER: &str = "M3 7V4h7l2 3h9v13H3V7h7";
const FILE: &str = "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z M14 3v6h6";
const TREE_SHOWN: &str = "M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z M15 4v16 M17 9l2 3-2 3";
const TREE_HIDDEN: &str = "M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z M15 4v16 M19 9l-2 3 2 3";
