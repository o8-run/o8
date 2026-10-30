//! WorkspaceFileTree: lazy directories, refresh, flattening, keyboard and reveal.
use super::*;
use gpui::{KeyDownEvent, ScrollStrategy};
#[derive(Clone)]
struct Notice {
    directory: String,
    message: String,
    retry: bool,
}
impl FilesPanel {
    pub(super) fn load_directory(&mut self, directory: String, cx: &mut Context<Self>) {
        if matches!(self.directories.get(&directory), Some(Directory::Loading)) {
            return;
        }
        self.directories
            .insert(directory.clone(), Directory::Loading);
        if directory.is_empty() {
            self.search.update(cx, |s, cx| {
                s.refreshing = true;
                cx.notify();
            });
        }
        self.directory_queue.push_back(directory);
        self.pump_directories(cx);
    }
    fn pump_directories(&mut self, cx: &mut Context<Self>) {
        while self.directory_pending < 4 {
            let Some(directory) = self.directory_queue.pop_front() else {
                break;
            };
            self.directory_pending += 1;
            let client = self.client.clone();
            let workspace = self.workspace.clone();
            let path = directory.clone();
            let generation = self.directory_generation;
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
                    if generation != this.directory_generation {
                        return;
                    }
                    this.directory_pending = this.directory_pending.saturating_sub(1);
                    let state = match result {
                        Ok(body) if body["error"].is_null() => {
                            Directory::Loaded(parse_entries(&body))
                        }
                        Ok(body) => Directory::Failed(
                            body["error"]
                                .as_str()
                                .unwrap_or("Directory listing failed")
                                .into(),
                        ),
                        Err(error) => Directory::Failed(error),
                    };
                    let mut load = Vec::new();
                    if let Directory::Loaded(entries) = &state {
                        let follow = this.expanding_all
                            || (this.expanded.contains(&directory)
                                && entries.len() == 1
                                && entries[0].dir);
                        if follow {
                            for entry in entries
                                .iter()
                                .filter(|e| e.dir && (!this.expanding_all || !e.ignored))
                            {
                                this.expanded.insert(entry.path.clone());
                                if !this.directories.contains_key(&entry.path) {
                                    load.push(entry.path.clone());
                                }
                            }
                        }
                    }
                    if directory.is_empty() {
                        this.search.update(cx, |s, cx| {
                            s.refreshing = false;
                            cx.notify();
                        });
                    }
                    this.directories.insert(directory, state);
                    for path in load {
                        this.load_directory(path, cx);
                    }
                    this.pump_directories(cx);
                    let expanded = !this.expanded.is_empty();
                    this.search.update(cx, |s, cx| {
                        s.expanded = expanded;
                        cx.notify();
                    });
                    this.reveal_selection();
                    cx.notify();
                });
            })
            .detach();
        }
    }
    pub(super) fn refresh_tree(&mut self, cx: &mut Context<Self>) {
        self.directory_generation += 1;
        self.directory_pending = 0;
        self.directory_queue.clear();
        self.directories.clear();
        self.load_directory(String::new(), cx);
        let expanded: Vec<_> = self.expanded.iter().cloned().collect();
        for path in expanded {
            self.load_directory(path, cx);
        }
        self.search.update(cx, |search, cx| search.refresh(cx));
        cx.notify();
    }
    pub(super) fn toggle_all(&mut self, cx: &mut Context<Self>) {
        if self.expanding_all || !self.expanded.is_empty() {
            self.expanding_all = false;
            self.expanded.clear();
        } else {
            self.expanding_all = true;
            let paths: Vec<_> = self
                .directories
                .values()
                .filter_map(|d| match d {
                    Directory::Loaded(e) => Some(e),
                    _ => None,
                })
                .flatten()
                .filter(|e| e.dir && !e.ignored)
                .map(|e| e.path.clone())
                .collect();
            for path in paths {
                self.expanded.insert(path.clone());
                if !self.directories.contains_key(&path) {
                    self.load_directory(path, cx);
                }
            }
        }
        let expanded = !self.expanded.is_empty();
        self.search.update(cx, |s, cx| {
            s.expanded = expanded;
            cx.notify();
        });
        cx.notify();
    }
    fn toggle(&mut self, entry: &Entry, cx: &mut Context<Self>) {
        self.tree_cursor = Some(entry.path.clone());
        if !entry.dir {
            self.open_file(entry.path.clone(), cx);
            return;
        }
        if !self.expanded.remove(&entry.path) {
            self.expanded.insert(entry.path.clone());
            if !matches!(
                self.directories.get(&entry.path),
                Some(Directory::Loaded(_) | Directory::Loading)
            ) {
                self.load_directory(entry.path.clone(), cx);
            }
        } else {
            self.expanding_all = false;
        }
        let expanded = !self.expanded.is_empty();
        self.search.update(cx, |s, cx| {
            s.expanded = expanded;
            cx.notify();
        });
        cx.notify();
    }
    fn flatten(&self, entry: &Entry) -> Entry {
        let mut entry = entry.clone();
        while entry.dir {
            let Some(Directory::Loaded(children)) = self.directories.get(&entry.path) else {
                break;
            };
            if children.len() != 1 || !children[0].dir {
                break;
            }
            let next = &children[0];
            entry.name = format!("{}/{}", entry.name, next.name).into();
            entry.path = next.path.clone();
            entry.ignored |= next.ignored;
        }
        entry
    }
    fn rows(&self) -> Vec<(usize, Result<Entry, Notice>)> {
        let mut rows = Vec::new();
        self.push_rows("", 0, &mut rows);
        rows
    }
    fn push_rows(
        &self,
        directory: &str,
        depth: usize,
        rows: &mut Vec<(usize, Result<Entry, Notice>)>,
    ) {
        match self.directories.get(directory) {
            Some(Directory::Loaded(entries)) => {
                if entries.is_empty() && depth == 0 {
                    rows.push((
                        depth,
                        Err(Notice {
                            directory: directory.into(),
                            message: "No files".into(),
                            retry: false,
                        }),
                    ));
                }
                for entry in entries {
                    let entry = self.flatten(entry);
                    let open = entry.dir && self.expanded.contains(&entry.path);
                    rows.push((depth, Ok(entry.clone())));
                    if open {
                        self.push_rows(&entry.path, depth + 1, rows);
                    }
                }
            }
            Some(Directory::Failed(error)) => rows.push((
                depth,
                Err(Notice {
                    directory: directory.into(),
                    message: if directory.is_empty() {
                        format!("Couldn't load files. {error}")
                    } else {
                        format!("Couldn't load this folder. {directory}: {error}")
                    },
                    retry: true,
                }),
            )),
            _ => rows.push((
                depth,
                Err(Notice {
                    directory: directory.into(),
                    message: "Loading files...".into(),
                    retry: false,
                }),
            )),
        }
    }
    fn reveal_row(&self, row: usize) {
        // Align the nearest edge, and leave already-visible rows in place.
        let strategy = {
            let state = self.tree_scroll.0.borrow();
            let height = state
                .last_item_size
                .map(|size| size.item.height)
                .unwrap_or(px(24.));
            if height * row < -state.base_handle.offset().y {
                ScrollStrategy::Top
            } else {
                ScrollStrategy::Bottom
            }
        };
        self.tree_scroll.scroll_to_item(row, strategy);
    }
    pub(super) fn reveal_selection(&mut self) {
        if let Some(target) = self.reveal.as_ref()
            && let Some(index) = self
                .rows()
                .iter()
                .position(|(_, e)| e.as_ref().is_ok_and(|e| &e.path == target))
        {
            self.reveal_row(index);
            self.reveal = None;
        }
    }
    fn tree_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        let key = &event.keystroke;
        if key.modifiers.platform || key.modifiers.control || key.modifiers.alt {
            return;
        }
        let rows = self.rows();
        let entries: Vec<_> = rows
            .iter()
            .filter_map(|(_, e)| e.as_ref().ok().cloned())
            .collect();
        if entries.is_empty() {
            return;
        }
        let index = self
            .tree_cursor
            .as_ref()
            .and_then(|path| entries.iter().position(|e| &e.path == path))
            .unwrap_or(0);
        let current = &entries[index];
        let target = match key.key.as_str() {
            "up" => index.saturating_sub(1),
            "down" => (index + 1).min(entries.len() - 1),
            "home" => 0,
            "end" => entries.len() - 1,
            "enter" | "space" => {
                self.toggle(current, cx);
                cx.stop_propagation();
                return;
            }
            "right" if current.dir => {
                if !self.expanded.contains(&current.path) {
                    self.toggle(current, cx);
                    index
                } else {
                    (index + 1).min(entries.len() - 1)
                }
            }
            "left" => {
                if current.dir && self.expanded.contains(&current.path) {
                    self.toggle(current, cx);
                    index
                } else {
                    let parent = current.path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
                    entries
                        .iter()
                        .position(|e| {
                            e.dir
                                && (e.path == parent || parent.starts_with(&format!("{}/", e.path)))
                        })
                        .unwrap_or(index)
                }
            }
            text if text.chars().count() == 1 => {
                if self.tree_type_at.elapsed() > std::time::Duration::from_secs(1) {
                    self.tree_type.clear();
                }
                self.tree_type.push_str(text);
                self.tree_type_at = std::time::Instant::now();
                (1..=entries.len())
                    .map(|step| (index + step) % entries.len())
                    .find(|i| {
                        entries[*i]
                            .name
                            .to_lowercase()
                            .starts_with(&self.tree_type.to_lowercase())
                    })
                    .unwrap_or(index)
            }
            _ => return,
        };
        self.tree_cursor = Some(entries[target].path.clone());
        if let Some(row) = rows
            .iter()
            .position(|(_, e)| e.as_ref().is_ok_and(|e| e.path == entries[target].path))
        {
            self.reveal_row(row);
        }
        cx.notify();
        cx.stop_propagation();
    }
    pub(super) fn tree(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let rows = self.rows();
        #[cfg(test)]
        cx.set_global(super::tests::tree_tests::Rows::default());
        let selected = self
            .selected
            .as_ref()
            .and_then(|s| search::repo_relative(&self.workspace, s))
            .map(str::to_owned);
        uniform_list(
            "files-tree",
            rows.len(),
            cx.processor(move |this, range: std::ops::Range<usize>, _, cx| {
                range
                    .map(|i| {
                        let (depth, row) = rows[i].clone();
                        let base = div()
                            .id(i)
                            .h(px(24.))
                            .w_full()
                            .pl(px(8. + 14. * depth as f32))
                            .pr(px(8.))
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .rounded(px(5.))
                            .text_size(px(12.))
                            .font_weight(gpui::FontWeight::LIGHT);
                        match row {
                            Err(notice) => {
                                let mouse = notice.directory.clone();
                                let key = mouse.clone();
                                base.text_color(theme().text_muted)
                                    .text_size(px(11.))
                                    .tooltip({
                                        let message = notice.message.clone();
                                        move |_, cx| {
                                            cx.new(|_| crate::icon::Tip(message.clone().into()))
                                                .into()
                                        }
                                    })
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .overflow_hidden()
                                            .whitespace_nowrap()
                                            .text_ellipsis()
                                            .child(notice.message),
                                    )
                                    .when(notice.retry, |d| {
                                        d.child(
                                            button("files-directory-retry", "Retry")
                                                .h(px(24.))
                                                .w_auto()
                                                .px(px(6.))
                                                .child("Retry")
                                                .debug_selector({
                                                    let path = notice.directory;
                                                    move || format!("files-directory-retry-{path}")
                                                })
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.load_directory(mouse.clone(), cx)
                                                }))
                                                .on_key_down(cx.listener(
                                                    move |this, event: &KeyDownEvent, _, cx| {
                                                        if matches!(
                                                            event.keystroke.key.as_str(),
                                                            "enter" | "space"
                                                        ) {
                                                            this.load_directory(key.clone(), cx);
                                                            cx.stop_propagation();
                                                        }
                                                    },
                                                )),
                                        )
                                    })
                            }
                            Ok(entry) => {
                                let open = entry.dir && this.expanded.contains(&entry.path);
                                let chosen = selected.as_ref() == Some(&entry.path);
                                let cursor = this.tree_cursor.as_ref() == Some(&entry.path);
                                #[cfg(test)]
                                cx.global_mut::<super::tests::tree_tests::Rows>().0.push((
                                    entry.path.clone(),
                                    entry.name.to_string(),
                                    depth,
                                    chosen,
                                ));
                                base.debug_selector({
                                    let path = entry.path.clone();
                                    move || format!("files-row-{path}")
                                })
                                .cursor_pointer()
                                .when(chosen, |d| d.bg(theme().selection))
                                .when(cursor, |d| d.border_1().border_color(theme().accent))
                                .hover(|d| d.bg(theme().hover))
                                .tooltip({
                                    let path = entry.path.clone();
                                    move |_, cx| {
                                        cx.new(|_| crate::icon::Tip(path.clone().into())).into()
                                    }
                                })
                                .text_color(if entry.ignored {
                                    theme().text_faint
                                } else if entry.dir {
                                    theme().text
                                } else {
                                    theme().text_secondary
                                })
                                .child(div().w(px(12.)).flex_shrink_0().when(entry.dir, |d| {
                                    d.child(crate::icon::stroke(
                                        if open { CHEVRON_DOWN } else { CHEVRON_RIGHT },
                                        theme().text_muted,
                                        12.,
                                        1.8,
                                    ))
                                }))
                                .child(if entry.dir {
                                    crate::icon::stroke(FOLDER, theme().text_muted, 14., 1.6)
                                        .into_any_element()
                                } else {
                                    super::icons::view(&entry.path, 14., cx)
                                })
                                .child(
                                    div()
                                        .min_w_0()
                                        .overflow_hidden()
                                        .text_ellipsis()
                                        .child(entry.name.clone()),
                                )
                                .on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        this.tree_focus.focus(window);
                                        this.toggle(&entry, cx)
                                    },
                                ))
                            }
                        }
                        .into_any_element()
                    })
                    .collect::<Vec<_>>()
            }),
        )
        .debug_selector(|| "files-tree".into())
        .track_focus(&self.tree_focus)
        .tab_stop(true)
        .track_scroll(self.tree_scroll.clone())
        .flex_1()
        .min_h_0()
        .py(px(4.))
        .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| this.tree_key(event, cx)))
    }
}

fn button(id: &'static str, label: &str) -> gpui::Stateful<gpui::Div> {
    let label = label.to_owned();
    div()
        .id(id)
        .debug_selector(move || id.into())
        .focusable()
        .size(px(26.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .cursor_pointer()
        .hover(|d| d.bg(theme().hover))
        .active(|d| d.bg(theme().selection))
        .focus(|d| d.border_1().border_color(theme().accent))
        .text_size(px(11.))
        .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(label.clone().into())).into())
}
