//! Opt-in workspace grid. Independent of the single-session Surface so transcript
//! and terminal work can extend their own modules without a second app fork.
use crate::theme::current as theme;
use crate::{
    client::{Client, Session},
    grid_sessions,
    pane::Pane,
    pane_layout::{Layout, Options, SIZES, View},
};
use gpui::{
    App, Application, Bounds, Context, FocusHandle, KeyDownEvent, Render, Window, WindowBounds,
    WindowOptions, div, point, prelude::*, px, size,
};
use std::{collections::HashSet, time::Duration};

pub struct Grid {
    client: Client,
    options: Options,
    pub layout: Layout,
    pub panes: Vec<Pane>,
    sessions: Vec<Session>,
    focus: FocusHandle,
    pub zoom: bool,
    notice: String,
    loaded: bool,
    refreshing: bool,
    loading: HashSet<String>,
    focus_pending: bool,
}
impl Grid {
    pub(crate) fn shell_reading_focused(&self, window: &Window) -> bool {
        self.focus.is_focused(window)
    }
    pub(crate) fn shell_focus(&self, window: &mut Window, _: &mut Context<Self>) {
        self.focus.focus(window);
    }
    pub fn new(
        client: Client,
        options: Options,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let saved = options
            .load()
            .expect("layout validated before opening a window");
        let layout = saved
            .clone()
            .unwrap_or_else(|| Layout::new(options.size, std::iter::empty()));
        let panes = layout.sessions.iter().cloned().map(Pane::new).collect();
        let focus = cx.focus_handle();
        focus.focus(window);
        Self {
            client,
            options,
            layout,
            panes,
            sessions: vec![],
            focus,
            zoom: false,
            notice: "Reading workspace sessions…".into(),
            loaded: saved.is_some(),
            refreshing: false,
            loading: HashSet::new(),
            focus_pending: true,
        }
    }
    fn persist(&mut self) {
        if let Err(error) = self.options.save(&self.layout) {
            self.notice = format!("{error}. Layout remains in memory; retry with Refresh.");
        }
    }
    pub fn load(&mut self, cx: &mut Context<Self>) {
        if self.refreshing {
            return;
        }
        self.refreshing = true;
        let client = self.client.clone();
        let workspace = self.options.workspace.clone();
        let task = cx
            .background_executor()
            .spawn(async move { grid_sessions::load(&client, &workspace) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.refreshing = false;
                match result {
                    Ok(sessions) => {
                        this.sessions = sessions.into_iter().filter(|s| s.repo_path.as_deref() == Some(&this.options.workspace)).collect();
                        if !this.loaded {
                            this.layout = Layout::new(this.options.size, this.sessions.iter().map(grid_sessions::key));
                            this.panes = this.layout.sessions.iter().cloned().map(Pane::new).collect();
                            this.loaded = true;
                        }
                        this.notice = if this.sessions.is_empty() { "No sessions in the selected workspace." } else { "Ctrl+Alt+arrows: focus · +Shift: move · T: transcript/terminal · W: close · P: session · Enter: zoom" }.into();
                        this.persist();
                        this.reload(cx);
                    }
                    Err(error) => this.notice = format!("{error}. Refresh to retry."),
                }
                cx.notify();
            });
        }).detach();
    }
    fn reload(&mut self, cx: &mut Context<Self>) {
        for pane in &mut self.panes {
            let Some(key) = pane.key.clone() else {
                continue;
            };
            let Some(session) = this_session(&self.sessions, &key) else {
                *pane = Pane::new(Some(key.clone()));
                pane.title = "Session unavailable".into();
                pane.state = "unavailable".into();
                continue;
            };
            pane.metadata(session);
            if pane.transcript.is_some() {
                continue;
            }
            if !self.loading.insert(key.clone()) {
                continue;
            }
            pane.notice = "Reading history…".into();
            let history_key = key.clone();
            let client = self.client.clone();
            let task = cx
                .background_executor()
                .spawn(async move { grid_sessions::history(&client, &history_key) });
            cx.spawn(async move |this, cx| {
                let result = task.await;
                let _ = this.update(cx, |this, cx| {
                    this.loading.remove(&key);
                    if let Some(pane) = this.panes.iter_mut().find(|p| p.key.as_ref() == Some(&key))
                    {
                        match result {
                            Ok(history) => pane.install(history, this.client.clone()),
                            Err(error) => pane.notice = format!("{error}. Refresh to retry."),
                        }
                    }
                    this.load_images(cx);
                    cx.notify();
                });
            })
            .detach();
        }
    }
    pub fn poll(&mut self, cx: &mut Context<Self>) {
        let mut visible_changed = false;
        let mut rows_changed = false;
        for (index, pane) in self.panes.iter_mut().enumerate() {
            let visible = index < self.layout.size && (!self.zoom || index == self.layout.focus);
            let changed = pane.poll();
            rows_changed |= changed;
            if changed && visible && self.layout.views[index] == View::Transcript {
                visible_changed = true;
            }
            if let Some(terminal) = &pane.terminal {
                let painting = visible && self.layout.views[index] == View::Terminal;
                visible_changed |= terminal
                    .update(cx, |terminal, cx| terminal.poll_visible(painting, cx))
                    && painting;
            }
        }
        if rows_changed {
            self.load_images(cx);
        }
        if visible_changed {
            cx.notify();
        }
    }
    fn load_images(&mut self, cx: &mut Context<Self>) {
        for pane in &self.panes {
            crate::ui::images::load(
                self.client.clone(),
                &pane.rows,
                &pane.list,
                &pane.images,
                cx,
                |grid, cache, changed, cx| {
                    let mut updated = false;
                    for pane in &grid.panes {
                        if std::rc::Rc::ptr_eq(cache, &pane.images) {
                            updated |=
                                crate::ui::images::invalidate(&pane.rows, &pane.list, changed);
                        }
                    }
                    if updated {
                        cx.notify();
                    }
                },
                Self::load_images,
            );
        }
    }
    fn focus(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.layout.focus = index.min(self.layout.size - 1);
        self.focus_slot(window, cx);
        self.persist();
        cx.notify();
    }
    fn focus_slot(&self, window: &mut Window, cx: &mut Context<Self>) {
        let index = self.layout.focus;
        if self.layout.views[index] == View::Terminal {
            if let Some(terminal) = &self.panes[index].terminal {
                terminal.read(cx).focus_handle().focus(window);
                return;
            }
        }
        self.focus.focus(window);
    }
    fn attach_terminals(&mut self, cx: &mut Context<Self>) {
        for (index, pane) in self.panes.iter_mut().enumerate() {
            if self.layout.views[index] == View::Terminal && pane.terminal.is_none() {
                if let Some(session) = &pane.terminal_session {
                    let client = self.client.clone();
                    let session = session.clone();
                    pane.terminal =
                        Some(cx.new(|cx| crate::terminal::Pane::attached(client, session, cx)));
                    if index == self.layout.focus {
                        self.focus_pending = true;
                    }
                }
            }
        }
    }
    fn toggle_view(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = &mut self.layout.views[self.layout.focus];
        *view = if *view == View::Transcript {
            View::Terminal
        } else {
            View::Transcript
        };
        self.attach_terminals(cx);
        self.focus_slot(window, cx);
        self.persist();
        cx.notify();
    }
    fn resize(&mut self, size: usize, cx: &mut Context<Self>) {
        self.layout.size = size;
        self.layout.focus = self.layout.focus.min(size - 1);
        self.zoom = false;
        self.focus_pending = true;
        self.persist();
        cx.notify();
    }
    fn close(&mut self, cx: &mut Context<Self>) {
        let index = self.layout.focus;
        // Dropping Pane cancels only its viewer subscription, never the worker.
        self.panes[index] = Pane::new(None);
        self.layout.sessions[index] = None;
        self.focus_pending = true;
        self.persist();
        cx.notify();
    }
    fn choose(&mut self, cx: &mut Context<Self>) {
        let index = self.layout.focus;
        let current = self.panes[index]
            .key
            .as_ref()
            .and_then(|key| this_session(&self.sessions, key))
            .and_then(|session| self.sessions.iter().position(|s| s.id == session.id))
            .unwrap_or(self.sessions.len().saturating_sub(1));
        let key = (1..=self.sessions.len())
            .map(|offset| &self.sessions[(current + offset) % self.sessions.len()])
            .map(grid_sessions::key)
            .find(|key| !self.layout.sessions.iter().flatten().any(|k| k == key));
        if let Some(key) = key {
            self.panes[index] = Pane::new(Some(key.clone()));
            self.layout.sessions[index] = Some(key);
            self.focus_pending = true;
            self.persist();
            self.reload(cx);
        }
        cx.notify();
    }
    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        if modifiers.control && modifiers.alt {
            match key {
                "left" | "right" | "up" | "down" => {
                    let next = self.layout.neighbor(key);
                    if modifiers.shift {
                        self.layout.sessions.swap(self.layout.focus, next);
                        self.layout.views.swap(self.layout.focus, next);
                        self.panes.swap(self.layout.focus, next);
                    }
                    self.focus(next, window, cx);
                }
                "1" | "2" | "4" | "6" => self.resize(key.parse().unwrap(), cx),
                "w" => self.close(cx),
                "p" => self.choose(cx),
                "t" => self.toggle_view(window, cx),
                "enter" => {
                    self.zoom = !self.zoom;
                    cx.notify();
                }
                _ => return,
            }
        } else {
            // Tab, Home/End, arrows and control keys belong to the focused PTY.
            if self.layout.views[self.layout.focus] == View::Terminal {
                return;
            }
            match key {
                "tab" => {
                    let next = if modifiers.shift {
                        (self.layout.focus + self.layout.size - 1) % self.layout.size
                    } else {
                        (self.layout.focus + 1) % self.layout.size
                    };
                    self.focus(next, window, cx);
                }
                "home" | "end" => {
                    self.panes[self.layout.focus].navigate(key == "end");
                    cx.notify();
                }
                _ => return,
            }
        }
        cx.stop_propagation();
    }
    fn pane(&self, index: usize, cx: &mut Context<Self>) -> gpui::AnyElement {
        let pane = &self.panes[index];
        let terminal = self.layout.views[index] == View::Terminal;
        let content = if terminal {
            match &pane.terminal {
                Some(entity) => entity.clone().into_any_element(),
                None => div()
                    .p(px(8.))
                    .child("No terminal is available for this session. Ctrl+Alt+T: transcript.")
                    .into_any_element(),
            }
        } else {
            pane.content()
        };
        let child = div()
            .id(("pane", index))
            .debug_selector(move || format!("pane-{index}"))
            .size_full()
            .flex()
            .flex_col()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .border_1()
            .border_color(if index == self.layout.focus {
                theme().accent
            } else {
                theme().border
            })
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(move |this, _, window, cx| this.focus(index, window, cx)),
            )
            .child(
                div()
                    .h(px(28.))
                    .flex_shrink_0()
                    .px(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .text_size(px(11.))
                            .child(pane.title.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(9.5))
                            .text_color(theme().text_muted)
                            .child(pane.state.clone()),
                    )
                    .child(
                        div()
                            .id(("pane-view", index))
                            .cursor_pointer()
                            .text_size(px(9.5))
                            .child(if terminal { "Terminal" } else { "Transcript" })
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.layout.focus = index;
                                this.toggle_view(window, cx);
                            })),
                    )
                    .child(
                        div()
                            .id(("close-pane", index))
                            .cursor_pointer()
                            .text_size(px(9.5))
                            .child("Close")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.layout.focus = index;
                                this.close(cx);
                            })),
                    ),
            )
            .child(content)
            .into_any_element();
        crate::pane::clipped(child)
    }
}
fn this_session<'a>(sessions: &'a [Session], key: &str) -> Option<&'a Session> {
    sessions.iter().find(|s| grid_sessions::key(s) == key)
}
impl Render for Grid {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.attach_terminals(cx);
        self.load_images(cx);
        if self.focus_pending {
            self.focus_pending = false;
            self.focus_slot(window, cx);
        }
        let columns = self.layout.columns();
        let rows = if self.zoom {
            1
        } else {
            self.layout.size / columns
        };
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(theme().background)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .text_size(px(13.))
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(Self::key))
            .child(
                div()
                    .h(px(36.))
                    .flex_shrink_0()
                    .px(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child("o8 next")
                    .children(SIZES.map(|count| {
                        div()
                            .id(("pane-count", count))
                            .px(px(8.))
                            .py(px(4.))
                            .cursor_pointer()
                            .bg(if count == self.layout.size {
                                theme().selection
                            } else {
                                theme().surface_raised
                            })
                            .child(format!("{count}"))
                            .on_click(cx.listener(move |this, _, _, cx| this.resize(count, cx)))
                    }))
                    .child(
                        div()
                            .id("choose-pane-session")
                            .cursor_pointer()
                            .child("Choose session")
                            .on_click(cx.listener(|this, _, _, cx| this.choose(cx))),
                    )
                    .child(
                        div()
                            .id("zoom-pane")
                            .cursor_pointer()
                            .child(if self.zoom { "Show grid" } else { "Zoom" })
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.zoom = !this.zoom;
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .id("refresh-grid")
                            .cursor_pointer()
                            .child(if self.refreshing {
                                "Reading…"
                            } else {
                                "Refresh"
                            })
                            .on_click(cx.listener(|this, _, _, cx| this.load(cx))),
                    ),
            )
            .child(
                div().flex_1().min_h_0().flex().flex_col().children(
                    (0..rows)
                        .map(|row| {
                            div().flex_1().min_h_0().flex().children(
                                (0..if self.zoom { 1 } else { columns })
                                    .map(|column| {
                                        self.pane(
                                            if self.zoom {
                                                self.layout.focus
                                            } else {
                                                row * columns + column
                                            },
                                            cx,
                                        )
                                    })
                                    .collect::<Vec<_>>(),
                            )
                        })
                        .collect::<Vec<_>>(),
                ),
            )
            .child(
                div()
                    .h(px(20.))
                    .flex_shrink_0()
                    .px(px(8.))
                    .text_size(px(9.5))
                    .overflow_hidden()
                    .child(self.notice.clone()),
            )
    }
}

pub fn launch(client: Client, offscreen: bool, options: Options) -> Result<(), String> {
    options.load()?;
    (if offscreen {
        Application::headless()
    } else {
        Application::new()
    })
    .run(move |cx: &mut App| {
        let handle = cx
            .open_window(
                WindowOptions {
                    focus: false,
                    show: !offscreen,
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        point(px(100.), px(100.)),
                        size(px(1200.), px(816.)),
                    ))),
                    titlebar: Some(gpui::TitlebarOptions {
                        title: Some("o8 next".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                |window, cx| {
                    cx.new(|cx| {
                        let mut grid = Grid::new(client, options, window, cx);
                        grid.load(cx);
                        grid
                    })
                },
            )
            .expect("GPUI pane grid window");
        cx.spawn(async move |cx| {
            let mut ticks = 0;
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(10))
                    .await;
                if handle
                    .update(cx, |grid, _, cx| {
                        grid.poll(cx);
                        ticks += 1;
                        if ticks % 100 == 0 {
                            grid.load(cx);
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
    });
    Ok(())
}

#[cfg(test)]
#[path = "pane_grid_tests.rs"]
mod tests;
