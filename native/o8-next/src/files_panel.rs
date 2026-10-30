//! The right panel's Files and o8.md tools (WorkspaceFilesPane, O8SpecPane).
//! Files lists the workspace a directory at a time through /api/panel/files
//! and previews a file through /api/v2/files; o8.md reads /api/repo-spec.
mod changes;
mod edit;
mod editor;
mod file_diff;
mod icons;
mod io;
mod markdown;
mod markdown_view;
mod media;
mod modes;
mod quick_docs;
mod search;
mod selection;
mod source;
mod spec;
mod spec_document;
pub use spec::Preferences as NotesPreferences;
pub struct NotesPreferencesChanged(pub NotesPreferences);
impl gpui::EventEmitter<NotesPreferencesChanged> for FilesPanel {}
mod syntax;
mod tree;
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
use std::collections::{HashMap, HashSet, VecDeque};

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
        buffer: edit::Buffer,
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
    editor_subscription: Option<Subscription>,
    editing_path: Option<String>,
    viewer_focus: FocusHandle,
    directory_generation: u64,
    directory_queue: VecDeque<String>,
    directory_pending: usize,
    expanding_all: bool,
    tree_focus: FocusHandle,
    tree_cursor: Option<String>,
    tree_scroll: gpui::UniformListScrollHandle,
    reveal: Option<String>,
    tree_type: String,
    tree_type_at: std::time::Instant,
    measured_width: gpui::Pixels,
    refresh_sender: async_channel::Sender<()>,
    focused_once: std::cell::Cell<bool>,
    show_changes: bool,
    changes: Option<Entity<changes::Changes>>,
    spec: Option<Entity<spec::Spec>>,
}

impl FilesPanel {
    pub fn new(client: Client, workspace: String, mode: Mode, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| Search::new(client.clone(), workspace.clone(), false, cx));
        let picked = cx.subscribe(&search, |this, _, pick: &Pick, cx| {
            this.open_file(pick.0.clone(), cx);
        });
        let observed = cx.observe(&search, |_, _, cx| cx.notify());
        let tools = cx.subscribe(&search, |this, _, tool: &search::Tool, cx| match tool {
            search::Tool::Refresh => this.refresh_tree(cx),
            search::Tool::ToggleExpansion => this.toggle_all(cx),
        });
        let (refresh_sender, refresh_receiver) = async_channel::unbounded::<()>();
        cx.spawn(async move |this, cx| {
            while refresh_receiver.recv().await.is_ok() {
                if this.update(cx, |this, cx| this.refresh_tree(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
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
            _subscriptions: vec![picked, observed, tools]
                .into_iter()
                .chain(quick_pick)
                .chain(pins_changed)
                .collect(),
            file_generation: 0,
            view_modes: HashMap::new(),
            wrap_lines: true,
            editor_subscription: None,
            editing_path: None,
            viewer_focus: cx.focus_handle(),
            directory_generation: 0,
            directory_queue: VecDeque::new(),
            directory_pending: 0,
            expanding_all: false,
            tree_focus: cx.focus_handle(),
            tree_cursor: None,
            tree_scroll: gpui::UniformListScrollHandle::new(),
            reveal: None,
            tree_type: String::new(),
            tree_type_at: std::time::Instant::now(),
            measured_width: px(0.),
            refresh_sender,
            focused_once: std::cell::Cell::new(false),
            show_changes: false,
            changes: None,
            spec: None,
        };
        match mode {
            Mode::Files => panel.load_directory(String::new(), cx),
            Mode::Spec => {
                let view =
                    cx.new(|cx| spec::Spec::new(panel.client.clone(), panel.workspace.clone(), cx));
                panel._subscriptions.push(cx.subscribe(
                    &view,
                    |_, _, prefs: &spec::PreferencesChanged, cx| {
                        cx.emit(NotesPreferencesChanged(prefs.0.clone()))
                    },
                ));
                panel.focus = view.read(cx).focus.clone();
                panel.spec = Some(view);
            }
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
        if self.mode == Mode::Files && self.focused_once.replace(true) {
            let _ = self.refresh_sender.try_send(());
        }
    }

    fn open_file(&mut self, path: String, cx: &mut Context<Self>) {
        self.open_file_inner(path, false, cx);
    }
    fn open_file_inner(&mut self, path: String, reload: bool, cx: &mut Context<Self>) {
        self.reveal = search::repo_relative(&self.workspace, &path).map(str::to_owned);
        self.tree_cursor = self.reveal.clone();
        let same = self.selected.as_ref().is_some_and(|selected| {
            selected == &path || matches!(
                (search::repo_relative(&self.workspace, selected), search::repo_relative(&self.workspace, &path)),
                (Some(left), Some(right)) if left == right
            )
        });
        if !reload && same && matches!(&self.file, File::Loaded {buffer,..} if buffer.dirty()) {
            self.reveal_selection();
            cx.notify();
            return;
        }
        self.editor_subscription = None;
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
        self.reveal_selection();
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
        let task = cx
            .background_executor()
            .spawn(async move { io::read(&client, &workspace, &path) });
        self.finish_file(task, cx);
        cx.notify();
    }

    pub fn set_notes_preferences(&mut self, prefs: NotesPreferences, cx: &mut Context<Self>) {
        if let Some(spec) = &self.spec {
            spec.update(cx, |spec, cx| spec.receive_preferences(prefs, cx));
        }
    }
    pub fn set_spec_workspace(&mut self, workspace: &str, cx: &mut Context<Self>) {
        if let Some(spec) = &self.spec {
            spec.update(cx, |spec, cx| spec.follow_workspace(workspace, cx));
        }
    }
    pub fn set_spec_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if let Some(spec) = &self.spec {
            spec.update(cx, |spec, cx| spec.active(active, cx));
        }
    }
    fn load_spec(&mut self, cx: &mut Context<Self>) {
        if let Some(spec) = &self.spec {
            spec.update(cx, |spec, cx| spec.load(false, cx));
        }
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
                                buffer: {
                                    let mut buffer =
                                        edit::Buffer::new(content, body["mtimeMs"].as_f64(), cx);
                                    buffer.editing = body["truncated"] != true
                                        && this.editing_path == this.selected;
                                    buffer
                                },
                                source: source::Source::new(content.split('\n').count(), cx),
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
                this.watch_editor(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn viewer(&self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let title = self.selected.clone().unwrap_or_default();
        let previewable = viewer::is_markdown(&title) || media::is_svg(&title);
        let preview = self.view_mode() == viewer::ViewMode::Preview;
        let body = match &self.file {
            File::Loaded { buffer, .. } if buffer.editing => {
                buffer.editor.clone().into_any_element()
            }
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
            File::Loaded {
                lines,
                source,
                buffer,
                ..
            } => source.view(
                lines,
                &buffer.text,
                &title,
                self.wrap_lines,
                self.file_generation,
                window,
                cx,
            ),
            File::Failed(error) => self.file_error(error, cx),
            _ => status("Loading file...".into()).into_any_element(),
        };
        div()
            .track_focus(&self.viewer_focus)
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
                    .when(self.mode==Mode::Files && matches!(self.file, File::Loaded {truncated:false,..}),|bar|bar.child(self.edit_toggle(cx)))
                    .when(!preview && matches!(&self.file, File::Loaded {truncated:false,buffer,..} if !buffer.editing), |bar| bar.child(self.wrap_toggle(cx)))
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
                view.child(div().debug_selector(||"files-truncated".into()).px(px(12.)).py(px(8.)).text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child("Read-only preview · first 1 MB. Use an editor to change the full file."))
            })
            .when_some(match &self.file {File::Failed(error)=>Some(error.clone()),_=>None},|d,error|d.child(div().min_h(px(34.)).flex_shrink_0().px(px(12.)).py(px(8.)).text_size(px(11.)).text_color(theme().danger).border_b_1().border_color(theme().border).child(error)))
            .child(self.edit_status(cx))
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
        if let Some(spec) = &self.spec {
            return div().size_full().child(spec.clone());
        }

        if self.mode == Mode::Files && self.show_changes {
            let body = self
                .changes
                .as_ref()
                .map(|c| c.clone().into_any_element())
                .unwrap_or_else(|| status("Loading changes...".into()).into_any_element());
            return self.frame(body, cx);
        }
        let viewing = self.selected.is_some();
        // A selected file takes the column; the tree keeps a third beside it,
        // never narrower than min(210px, 48%) (the desktop's grid track).
        let panel = if self.measured_width > px(0.) {
            f32::from(self.measured_width)
        } else {
            crate::theme::right_panel_width(f32::from(window.viewport_size().width))
        };
        let measured = cx.entity().downgrade();
        let tree_width = (panel * 0.34).max((panel * 0.48).min(210.));
        let body = div()
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "s"
                    && (event.keystroke.modifiers.platform || event.keystroke.modifiers.control)
                {
                    this.save_file(cx);
                    cx.stop_propagation();
                }
            }))
            .size_full()
            .relative()
            .flex()
            .min_h_0()
            .child(
                gpui::canvas(
                    |_, _, _| (),
                    move |bounds, _, _, cx| {
                        let _ = measured.update(cx, |this, cx| {
                            let width = bounds.size.width.floor();
                            if this.measured_width != width {
                                this.measured_width = width;
                                cx.notify();
                            }
                        });
                    },
                )
                .absolute()
                .size_full(),
            )
            .when(viewing, |pane| pane.child(self.viewer(window, cx)))
            .when(
                self.mode == Mode::Files && (self.tree_visible || !viewing),
                |pane| {
                    pane.child(
                        div()
                            .debug_selector(|| "files-explorer".into())
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
            .into_any_element();
        self.frame(body, cx)
    }
}

const CHEVRON_RIGHT: &str = "m9 6 6 6-6 6";
const CHEVRON_DOWN: &str = "m6 9 6 6 6-6";
const FOLDER: &str = "M3 7V4h7l2 3h9v13H3V7h7";
const FILE: &str = "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z M14 3v6h6";
const TREE_SHOWN: &str = "M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z M15 4v16 M17 9l2 3-2 3";
const TREE_HIDDEN: &str = "M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z M15 4v16 M19 9l-2 3 2 3";
