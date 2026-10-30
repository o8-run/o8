#[cfg(all(target_os = "macos", feature = "macos-diagnostics"))]
#[path = "composer/capture.rs"]
mod composer_capture;
use crate::theme::current as theme;
#[path = "brain_dock.rs"]
mod brain_dock;
#[path = "composer_bench.rs"]
mod composer_bench;
#[path = "composer/regions.rs"]
mod composer_regions;
#[path = "browser_panel/composer_geometry.rs"]
mod browser_preview_geometry;
#[path = "conversation.rs"]
mod conversation;
#[path = "history.rs"]
mod history;
#[path = "transcript_images.rs"]
pub(crate) mod images;
#[path = "session_sidebar.rs"]
mod session_sidebar;
#[path = "shell_session.rs"]
mod shell_session;
#[cfg(test)]
#[path = "speed_receipt.rs"]
mod speed_receipt;
#[path = "transcript_visualizations.rs"]
mod transcript_visualizations;
use crate::{
    client::{Client, Session},
    composer::{Composer, Submit},
    model::Row,
    retained::{RetainedRow, RowState},
    sidebar,
    stream::Transcript,
    transport::{self, Incoming, Subscription},
};
use gpui::{
    App, Application, Bounds, Context, FocusHandle, KeyDownEvent, Keystroke, ListAlignment,
    ListOffset, ListState, Render, Window, WindowBounds, WindowHandle, WindowOptions, canvas, div,
    list, point, prelude::*, px, size,
};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeSet, HashMap},
    fs,
    process::Command,
    rc::Rc,
    time::Instant,
};

gpui::actions!(
    o8_next,
    [
        /// The composer waveform: start or stop chat Live voice, which the shell owns.
        ToggleVoice,
        /// The composer mic: start dictation, or stop it and send what was said.
        ToggleDictation
    ]
);

/// Composer dictation as this chat's mic shows it; the shell sets it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) enum DictationState {
    #[default]
    Off,
    /// Asked for the microphone; the host has not confirmed it.
    Starting,
    Listening,
    /// Stopped to send; the polished transcript has not arrived yet.
    Finishing,
}

/// Chat Live voice as this chat's mic shows it; the shell sets it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) enum VoiceState {
    #[default]
    Off,
    Connecting,
    Live,
    /// Stop was asked; the mic is off but cannot start again until the host
    /// confirms closure.
    Closing,
}

/// The chat a Live session binds to: the broker's binding, thread and
/// repository, plus the runtime its stop path addresses.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct VoiceTarget {
    pub binding: String,
    pub thread: String,
    pub repo: String,
    pub backend: Option<String>,
}

pub(crate) struct Surface {
    client: Client,
    embedded: bool,
    brains: HashMap<String, gpui::Entity<crate::brain::Brain>>,
    composer: gpui::Entity<Composer>,
    regions: crate::render_region::Regions<Surface>,
    drafts: HashMap<String, gpui::Entity<Composer>>,
    pending: HashMap<String, Value>,
    linked_issues: HashMap<String, crate::issues::LinkedIssue>,
    routing: Option<Value>,
    queue: Value,
    queue_ready: bool,
    saving: bool,
    /// After a send from this view, the row count it started at; the view
    /// follows that turn to its reply.
    following: Option<usize>,
    send_next: bool,
    subscriptions: Vec<gpui::Subscription>,
    sessions: Vec<Session>,
    selected: Option<String>,
    rows: Rc<Vec<Rc<RefCell<RowState>>>>,
    images: images::Cache,
    transcript: Option<Transcript>,
    saved_visualizations: transcript_visualizations::Saved,
    subscription: Option<Subscription>,
    list: ListState,
    focus: FocusHandle,
    notice: String,
    generation: u64,
    reconcile_revision: u64,
    list_generation: u64,
    history_loading: bool,
    history_error: Option<String>,
    key_revision: u64,
    painted: Rc<Cell<u64>>,
    painted_rows: Rc<RefCell<BTreeSet<usize>>>,
    voice: VoiceState,
    dictation: DictationState,
}
impl Surface {
    pub(crate) fn new(client: Client, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        focus.focus(window);
        Self {
            client,
            embedded: false,
            brains: HashMap::new(),
            composer: cx.new(Composer::new),
            regions: crate::render_region::Regions::default(),
            drafts: HashMap::new(),
            pending: HashMap::new(),
            linked_issues: HashMap::new(),
            routing: None,
            queue: Value::Null,
            queue_ready: false,
            saving: false,
            following: None,
            send_next: false,
            subscriptions: vec![],
            sessions: vec![],
            selected: None,
            rows: Rc::new(vec![]),
            images: Default::default(),
            transcript: None,
            saved_visualizations: Default::default(),
            subscription: None,
            list: ListState::new(0, ListAlignment::Top, px(400.)),
            focus,
            notice: String::new(),
            generation: 0,
            reconcile_revision: 0,
            list_generation: 0,
            history_loading: false,
            history_error: None,
            key_revision: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
            painted_rows: Rc::new(RefCell::new(BTreeSet::new())),
            voice: VoiceState::Off,
            dictation: DictationState::Off,
        }
    }
    fn select(&mut self, id: String, cx: &mut Context<Self>) {
        if self.selected.as_ref() != Some(&id) {
            if let Some(brain) = self.selected.as_ref().and_then(|id| self.brains.get(id)) {
                brain.update(cx, |brain, cx| {
                    brain.expanded = false;
                    cx.notify();
                });
            }
        }
        if !self.drafts.contains_key(&id) {
            let store = crate::composer::mode_store::path(
                self.client
                    .url("/")
                    .map(|u| u.to_string())
                    .unwrap_or_default()
                    .as_str(),
                &id,
                cx,
            );
            let mode = crate::composer::mode_store::load(store.as_deref());
            let prelude = crate::composer::mode_store::load_prelude(store.as_deref());
            let editor = cx.new(|cx| {
                let mut editor = Composer::new(cx);
                editor.controls.slash.enabled = true;
                editor.controls.prompt.store = store;
                editor.controls.prompt.prelude = prelude;
                if let Some(mode) = mode {
                    editor.controls.overrides["mode"] =
                        json!(if mode == "solo" { "single" } else { "fleet" });
                    editor.controls.overrides["pickedMode"] = json!(mode);
                }
                editor
            });
            self.subscriptions.push(cx.subscribe(
                &editor,
                |s, editor, event: &crate::composer::commands::Changed, cx| {
                    if s.composer == editor {
                        if event.0 {
                            cx.notify();
                        } else {
                            let view = editor
                                .read(cx)
                                .controls
                                .prompt
                                .view
                                .as_ref()
                                .map(|view| view.entity_id());
                            if let Some(view) = view {
                                App::notify(cx, view);
                            }
                        }
                    }
                },
            ));
            self.subscriptions.push(cx.subscribe(
                &editor,
                |s, editor, event: &crate::composer::commands::Execute, cx| {
                    if s.composer == editor {
                        let entity = cx.entity().downgrade();
                        let handle = event.1;
                        let text = event.0.clone();
                        cx.defer(move |cx| {
                            let _ = handle.update(cx, |_, window, cx| {
                                let _ = entity.update(cx, |s, cx| {
                                    s.execute_composer_command(text, window, cx)
                                });
                            });
                        });
                    }
                },
            ));
            self.subscriptions
                .push(cx.subscribe(&editor, |this, _, event: &Submit, cx| {
                    if event.0 {
                        this.send_next = !this.send_next;
                        cx.notify();
                    } else {
                        this.send(None, cx);
                    }
                }));
            self.subscriptions.push(cx.subscribe(
                &editor,
                |this, editor, _: &crate::composer::images::ImagesChanged, cx| {
                    if this.composer == editor {
                        cx.notify();
                    }
                },
            ));
            self.drafts.insert(id.clone(), editor);
        }
        self.composer = self.drafts[&id].clone();
        self.following = None;
        self.routing = None;
        self.queue_ready = false;
        self.queue = Value::Null;
        self.saving = false;

        self.generation += 1;
        let generation = self.generation;
        self.subscription = None;
        self.history_loading = false;
        self.history_error = None;
        self.transcript = None;
        self.selected = Some(id.clone());
        self.rows = Rc::new(vec![]);
        self.images.borrow_mut().clear();
        self.list = ListState::new(0, ListAlignment::Top, px(400.));
        self.notice = "Reading history…".into();
        cx.notify();
        let client = self.client.clone();
        let session = self.sessions.iter().find(|s| s.id == id).cloned();
        self.saved_visualizations
            .select(session.as_ref().and_then(|session| {
                transcript_visualizations::Scope::new(
                    session.repo_path.as_deref(),
                    &session.id,
                    session
                        .packet_header
                        .as_ref()
                        .and_then(|h| h["packetId"].as_str()),
                )
            }));
        // Runtime workers are read-only history; conversations also stream their live turn.
        let repo = session
            .as_ref()
            .and_then(|s| s.repo_path.clone())
            .filter(|_| !id.contains(':'));
        let task = cx.background_executor().spawn(async move {
            let session = session.ok_or("Selected session disappeared")?;
            let mut history = client.history(&id)?;
            session.decorate(&mut history);
            if id.contains(':') {
                return Ok((
                    history,
                    Err("Runtime worker · read-only".into()),
                    Err("Runtime worker · read-only".into()),
                ));
            }
            let queue = client.queue(&session);
            let routing = client.context(&session);
            Ok::<_, String>((history, queue, routing))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                match result {
                    Ok((history, queue, routing)) => {
                        let key = history.session_key.clone();
                        let transcript = Transcript::new(history);
                        let rows = transcript.rows.clone();
                        this.transcript = Some(transcript);
                        this.install_rows(rows, cx);
                        let backend = routing
                            .as_ref()
                            .ok()
                            .and_then(|routing| routing["backend"].as_str())
                            .map(str::to_owned);
                        this.subscription = Some(match repo {
                            Some(repo) => {
                                transport::subscribe_live(this.client.clone(), key, repo, backend)
                            }
                            None => transport::subscribe(this.client.clone(), key),
                        });
                        this.notice = "Connecting live stream".into();
                        match (queue, routing) {
                            (Ok(queue), Ok(routing)) => {
                                this.queue = queue;
                                this.routing = Some(routing);
                                this.queue_ready = true;
                            }
                            (Err(error), _) | (_, Err(error)) => {
                                this.notice =
                                    format!("{error}. History is available; sending is disabled.")
                            }
                        }
                    }
                    Err(error) => this.notice = error,
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn install_rows(&mut self, mut next: Vec<Row>, cx: &mut Context<Self>) {
        if let Some(transcript) = &self.transcript {
            self.saved_visualizations
                .attach(&mut next, transcript.shown_entries());
        }
        let old = &self.rows;
        let initial = old.is_empty();
        let prefix = old
            .iter()
            .zip(&next)
            .take_while(|(a, b)| a.borrow().row == **b)
            .count();
        let suffix = old[prefix..]
            .iter()
            .rev()
            .zip(next[prefix..].iter().rev())
            .take_while(|(a, b)| a.borrow().row == **b)
            .count();
        let mut states = Vec::with_capacity(next.len());
        let mut indexed: HashMap<String, Vec<_>> = HashMap::new();
        for state in old.iter() {
            indexed
                .entry(state.borrow().row.id().to_owned())
                .or_default()
                .push(state.clone());
        }
        for row in next {
            let retained = indexed
                .get(row.id())
                .and_then(|candidates| candidates.iter().find(|state| state.borrow().row == row))
                .cloned();
            states.push(retained.unwrap_or_else(|| {
                let cards = indexed
                    .get(row.id())
                    .and_then(|candidates| candidates.first())
                    .map(|state| state.borrow().cards.clone())
                    .unwrap_or_default();
                let mut state = RowState::new(row);
                state.images = self.images.clone();
                state.cards = cards;
                state.attach_visualizations(&self.client);
                if let Some(previous) = indexed.get(state.row.id()).and_then(|c| c.first()) {
                    state.keep_disclosure(&previous.borrow());
                }
                Rc::new(RefCell::new(state))
            }));
        }
        self.list
            .splice(prefix..old.len() - suffix, states.len() - prefix - suffix);
        self.rows = Rc::new(states);
        self.load_images(cx);
        if initial {
            self.list = self.list.clone().measure_all();
        }
        // After a send, keep the turn in view until its reply lands and nothing runs.
        if let Some(start) = self.following
            && let Some(last) = self.rows.last()
        {
            self.list.scroll_to_reveal_item(self.rows.len() - 1);
            let turn = self
                .rows
                .get(start.min(self.rows.len())..)
                .unwrap_or_default();
            let asked = turn.iter().any(
                |row| matches!(&row.borrow().row, Row::Message { role, .. } if role == "user"),
            );
            let working = turn
                .iter()
                .any(|row| matches!(&row.borrow().row, Row::Activity { trace, .. } if trace.live));
            let answered =
                matches!(&last.borrow().row, Row::Message { role, .. } if role == "assistant");
            if asked && answered && !working {
                self.following = None;
            }
        }
    }
    /// Each frame of a followed turn keeps its last row in view, so a trace
    /// that opens its rows over a few frames scrolls with them. The reader
    /// scrolling the transcript ends the follow.
    pub(crate) fn follow_frame(&mut self) {
        if self.following.is_some() && !self.rows.is_empty() {
            self.list.scroll_to_reveal_item(self.rows.len() - 1);
        }
    }
    fn poll_stream(&mut self, cx: &mut Context<Self>) -> bool {
        self.poll_saved_visualizations(cx);
        let mut visualizations_changed = false;
        for (index, row) in self.rows.iter().enumerate() {
            if row.borrow_mut().poll_visualizations() {
                self.list.splice(index..index + 1, 1);
                visualizations_changed = true;
            }
        }
        if visualizations_changed {
            cx.notify();
        }
        let follow_tail = !self.rows.is_empty()
            && self
                .list
                .bounds_for_item(self.rows.len() - 1)
                .is_some_and(|bounds| {
                    let viewport = self.list.viewport_bounds();
                    bounds.bottom() <= viewport.bottom() + px(1.)
                        && bounds.bottom() >= viewport.top()
                });
        let messages: Vec<_> = self
            .subscription
            .as_ref()
            .map(|s| s.receiver.try_iter().take(64).collect())
            .unwrap_or_default();
        let mut changed = false;
        for message in messages {
            match message {
                Incoming::Frame(frame) => {
                    if let Some(transcript) = &mut self.transcript {
                        changed |= transcript.apply(&frame);
                    }
                }
                Incoming::Status(status) => {
                    self.notice = if status == "Live · read-only" {
                        String::new()
                    } else {
                        status.trim_end_matches(" · read-only").into()
                    };
                    cx.notify();
                }
            }
        }
        if changed {
            self.install_rows(self.transcript.as_ref().unwrap().rows.clone(), cx);
            if follow_tail && !self.rows.is_empty() {
                self.list.scroll_to(ListOffset {
                    item_ix: self.rows.len() - 1,
                    offset_in_item: px(0.),
                });
            }
            cx.notify();
        }
        changed || visualizations_changed
    }
    fn snapshot_label(&self) -> String {
        let count = self
            .selected
            .as_ref()
            .and_then(|id| self.sessions.iter().find(|s| &s.id == id))
            .map(|s| s.message_count)
            .unwrap_or(0);
        if self.rows.is_empty() {
            "No saved messages. Select Refresh to read again.".into()
        } else if count > 100 {
            format!("Saved history · {count} saved messages · Load older to read earlier turns")
        } else {
            "Saved history · Refresh to update".into()
        }
    }
    fn load_sessions(&mut self, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        self.list_generation += 1;
        self.generation += 1;
        let generation = self.list_generation;
        self.notice = "Reading sessions…".into();
        cx.notify();
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { client.sessions() });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.list_generation {
                    return;
                }
                match result {
                    Ok(sessions) => {
                        this.sessions = sessions;
                        if let Some(id) = this
                            .selected
                            .clone()
                            .filter(|id| this.sessions.iter().any(|s| &s.id == id))
                            .or_else(|| this.sessions.first().map(|s| s.id.clone()))
                        {
                            this.select(id, cx);
                        } else {
                            this.generation += 1;
                            this.subscription = None;
                            this.transcript = None;
                            this.selected = None;
                            this.saved_visualizations.select(None);
                            this.rows = Rc::new(vec![]);
                            this.images.borrow_mut().clear();
                            this.list = ListState::new(0, ListAlignment::Top, px(400.));
                            this.notice = "No saved sessions.".into();
                        }
                    }
                    Err(error) => this.notice = format!("{error}. Select Refresh to retry."),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn navigate(&mut self, end: bool, cx: &mut Context<Self>) {
        if !self.rows.is_empty() {
            self.list.scroll_to(ListOffset {
                item_ix: if end { self.rows.len() - 1 } else { 0 },
                offset_in_item: px(0.),
            });
            self.on_transcript_scroll(cx);
        }
        self.key_revision += 1;
        cx.notify();
    }
}

impl Render for Surface {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.load_images(cx);
        let painted = self.painted.clone();
        let revision = self.key_revision;
        let geometry = &crate::theme::GEOMETRY;
        let typography = &crate::theme::TYPE;
        let viewport = f32::from(window.viewport_size().width);
        let sidebar_width = (viewport * 0.25).min(geometry.sidebar_width);
        let right_width = (viewport * 0.30).min(geometry.right_width);
        let empty = self.transcript.is_some() && self.rows.is_empty();
        let header = self.regions.view(
            "header",
            composer_regions::header_style(),
            Self::session_header,
            cx,
        );
        let sidebar = self.regions.view(
            "sidebar",
            composer_regions::sidebar_style(px(sidebar_width)),
            Self::session_sidebar_region,
            cx,
        );
        let transcript = self.regions.view(
            "transcript",
            composer_regions::transcript_style(),
            Self::session_transcript,
            cx,
        );
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(theme().background)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .font_weight(typography.weight)
            .text_size(px(typography.body))
            .line_height(gpui::relative(typography.chrome_line))
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(|s, event: &KeyDownEvent, w, cx| {
                let key = &event.keystroke;
                if key.key == "k"
                    && key.modifiers.shift
                    && (key.modifiers.platform || key.modifiers.control)
                    && s.quick_action_shortcut(w, cx)
                {
                    cx.stop_propagation();
                    return;
                }
                Self::brain_key(s, event, w, cx);
            }))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                match event.keystroke.key.as_str() {
                    "tab" => {
                        if this.composer.read(cx).focus.is_focused(window) {
                            this.focus.focus(window);
                        } else {
                            this.composer.read(cx).focus.focus(window);
                        }
                    }
                    "up" | "down" => {
                        let ids: Vec<_> = sidebar::tree(&this.sessions, None)
                            .into_iter()
                            .flat_map(|g| g.rows.into_iter().map(|r| r.id))
                            .collect();
                        if !ids.is_empty() {
                            let current = ids
                                .iter()
                                .position(|id| Some(id) == this.selected.as_ref())
                                .unwrap_or(0);
                            let next = if event.keystroke.key == "up" {
                                current.saturating_sub(1)
                            } else {
                                (current + 1).min(ids.len() - 1)
                            };
                            this.select(ids[next].clone(), cx);
                        }
                    }
                    "f6" => {
                        let id = this.queue["items"]
                            .as_array()
                            .and_then(|items| {
                                items.iter().find(|item| {
                                    item["status"] == "queued"
                                        && item["intent"] == "send-next"
                                        && item["admittedAt"].is_null()
                                        && item["payload"]["afterTaskId"].is_null()
                                        && this.queue["steerableIds"]
                                            .as_array()
                                            .is_some_and(|ids| ids.contains(&item["id"]))
                                })
                            })
                            .and_then(|item| item["id"].as_str())
                            .map(str::to_owned);
                        if let Some(id) = id {
                            this.send(Some(id), cx);
                        }
                    }
                    "f7" => {
                        let id = this.queue["items"]
                            .as_array()
                            .and_then(|items| {
                                items.iter().find(|item| {
                                    item["status"] == "queued"
                                        || item["status"] == "held"
                                        || (item["status"] == "dispatching"
                                            && item["admittedAt"].is_null())
                                })
                            })
                            .and_then(|item| item["id"].as_str())
                            .map(str::to_owned);
                        if let Some(id) = id {
                            this.remove_queued(id, cx);
                        }
                    }
                    "home" => this.navigate(false, cx),
                    "end" => this.navigate(true, cx),
                    _ => return,
                }
                cx.stop_propagation();
            }))
            .when(!self.embedded, |view| view.child(header))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .p(px(geometry.inset))
                    .gap(px(geometry.gap))
                    .when(!self.embedded, |view| view.child(sidebar))
                    .child(
                        div()
                            .debug_selector(|| "conversation-column".into())
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .when(empty, |view| {
                                view.when(!self.notice.is_empty(), |view| {
                                    view.child(
                                        div()
                                            .px(px(24.))
                                            .py(px(8.))
                                            .text_size(px(11.))
                                            .text_color(theme().text_muted)
                                            .child(self.notice.clone()),
                                    )
                                })
                                .child(self.history_control(cx))
                            })
                            .when(!empty, |view| view.child(transcript))
                            .child(
                                div()
                                    .debug_selector(|| "composer-space".into())
                                    .flex()
                                    .flex_col()
                                    .when(empty, |view| view.flex_1().min_h_0().justify_center())
                                    .when(!empty, |view| view.flex_shrink_0())
                                    .px(px(geometry.content_inset))
                                    .pb(px(if empty { 0. } else { geometry.gap * 2. }))
                                    .child(self.composer_panel(window, cx)),
                            ),
                    )
                    .child(self.brain_panel(px(right_width), cx)),
            )
            .child(transcript_visualizations::Visible(
                self.saved_visualizations.visible.clone(),
            ))
            .child(
                canvas(
                    |_, _, _| (),
                    move |_, _, _, _| {
                        painted.set(revision);
                    },
                )
                .w(px(1.))
                .h(px(1.)),
            )
    }
}
fn frame(
    handle: WindowHandle<Surface>,
    cx: &mut App,
    key: Option<&str>,
    scroll: Option<usize>,
    require_tail: bool,
) -> (f64, f64) {
    let start = Instant::now();
    let cost = cx
        .update_window(handle.into(), |root, window, cx| {
            let view = root.downcast::<Surface>().unwrap();
            if let Some(key) = key {
                window.dispatch_keystroke(Keystroke::parse(key).unwrap(), cx);
            }
            if let Some(index) = scroll {
                view.update(cx, |v, cx| {
                    v.list.scroll_to(ListOffset {
                        item_ix: index,
                        offset_in_item: px(0.),
                    });
                    cx.notify();
                });
            }
            if require_tail {
                view.read(cx).painted_rows.borrow_mut().clear();
            }
            let draw = Instant::now();
            window.refresh();
            window.draw(cx).clear();
            let cost = draw.elapsed().as_secs_f64() * 1000.;
            if require_tail {
                let surface = view.read(cx);
                assert!(
                    surface
                        .painted_rows
                        .borrow()
                        .contains(&(surface.rows.len() - 1)),
                    "changed tail must paint in the timed first scene"
                );
            }
            window.refresh();
            window.draw(cx).clear();
            cost
        })
        .unwrap();
    (start.elapsed().as_secs_f64() * 1000., cost)
}
fn rss() -> f64 {
    let output = Command::new("ps")
        .args(["-p", &std::process::id().to_string(), "-o", "rss="])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .unwrap()
        / 1024.
}
pub fn launch(
    client: Client,
    offscreen: bool,
    unattended: bool,
    benchmark: Option<String>,
    composer_benchmark: Option<String>,
    stream_benchmark: Option<(String, u64)>,
    started: Instant,
) {
    (if offscreen { Application::headless() } else { Application::new() }).with_assets(crate::icon::Assets).run(move |cx: &mut App| {
        let handle = cx.open_window(WindowOptions { focus: false, show: !offscreen,
            window_bounds: Some(WindowBounds::Windowed(Bounds::new(point(px(if offscreen { -10000. } else { 100. }), px(if offscreen { -10000. } else { 100. })), size(px(1200.), px(816.))))),
            titlebar: Some(gpui::TitlebarOptions { title: Some("o8 next".into()), ..Default::default() }),
            ..Default::default() }, |window, cx| cx.new(|cx| {
                let mut surface = Surface::new(client, window, cx);
                surface.notice = surface.snapshot_label();
                surface.load_sessions(cx);
                surface
            })).expect("GPUI window");
        #[cfg(all(target_os = "macos", feature = "macos-diagnostics"))]
        if let Some(directory) = std::env::var_os("O8_NEXT_COMPOSER_CAPTURE_DIR") {
            composer_capture::start(handle, std::path::PathBuf::from(directory), cx);
        }
        if let Some(path) = composer_benchmark {
            composer_bench::start(handle, path, started, cx);
        }
        cx.spawn(async move |cx| {
            loop {
                cx.background_executor().timer(std::time::Duration::from_secs(1)).await;
                if handle.update(cx, |surface, _, cx| surface.reconcile(cx)).is_err() { break; }
            }
        }).detach();
        cx.on_window_closed(|cx| { if cx.windows().is_empty() { cx.quit(); } }).detach();
        cx.spawn(async move |cx| {
            let mut measurement=stream_benchmark.map(|(path,through)| LiveMeasurement::new(path,through));
            loop {
                cx.background_executor().timer(std::time::Duration::from_millis(10)).await;
                let result=cx.update(|cx| {
                    let before:Vec<_>=if measurement.is_some() { handle.read(cx).unwrap().rows.iter().map(|s| (s.clone(),s.borrow().layouts)).collect() } else { vec![] };
                    let changed=handle.update(cx,|surface,_,cx| surface.poll_stream(cx)).unwrap();
                    if let Some(m)=&mut measurement {
                        if changed { m.frame(handle,cx,&before); }
                        let seq=handle.read(cx).unwrap().transcript.as_ref().map(|t| t.seq).unwrap_or(0);
                        if seq>=m.through { m.finish(handle,cx);cx.quit();return true; }
                    }
                    false
                });
                if result.unwrap_or(true) { break; }
            }
        }).detach();
        if unattended {
            cx.spawn(async move |cx| {
                for i in 0..70 {
                    cx.background_executor().timer(std::time::Duration::from_millis(100)).await;
                    let _ = handle.update(cx, |surface, _, cx| surface.navigate(i%2 == 0, cx));
                }
                cx.update(|cx| cx.quit()).unwrap();
            }).detach();
        }
        if let Some(path) = benchmark {
            cx.spawn(async move |cx| {
                let mut ready = false;
                for _ in 0..600 {
                    cx.background_executor().timer(std::time::Duration::from_millis(10)).await;
                    ready = cx.update(|cx| !handle.read(cx).unwrap().rows.is_empty()).unwrap();
                    if ready { break; }
                }
                assert!(ready, "session list and selected history must load through the interactive path");
                cx.update(|cx| {
                    frame(handle, cx, None, None, false);
                    let row_count = handle.read(cx).unwrap().rows.len();
                    assert!(handle.read(cx).unwrap().painted_rows.borrow().contains(&0), "first content row must reach paint");
                    let cold = started.elapsed().as_secs_f64()*1000.;
                    let idle = rss(); let mut keys = Vec::<Value>::new(); let mut scrolls = Vec::<Value>::new();
                    for i in 0..20 {
                        let (latency, _) = frame(handle, cx, Some(if i%2 == 0 { "end" } else { "home" }), None, false);
                        let painted = handle.read(cx).unwrap().painted.get(); assert_eq!(painted, i+1, "input must reach paint callback");
                        keys.push(json!(latency));
                    }
                    for i in 0..50 { let (_, cost) = frame(handle, cx, None, Some(if i%2 == 0 { row_count.saturating_sub(1) } else { 0 }), false); scrolls.push(json!(cost)); }
                    assert!(handle.read(cx).unwrap().painted_rows.borrow().contains(&(row_count-1)), "last content row must reach paint after End/scroll");
                    let result = json!({"endpoint":"GPUI CPU scene paint callback; no GPU submission or presentation", "keyToFrameMs":keys, "scrollFrameMs":scrolls,
                        "streamFrameMs":null, "idleMemoryMiB":idle, "coldStartMs":cold, "rows":row_count, "paintedRows":handle.read(cx).unwrap().painted_rows.borrow().len(), "sessions":handle.read(cx).unwrap().sessions.len(), "offscreen":offscreen});
                    fs::write(path, serde_json::to_vec_pretty(&result).unwrap()).expect("result file"); cx.quit();
                }).unwrap();
            }).detach();
        }
    });
}

struct LiveMeasurement {
    path: String,
    through: u64,
    frames: Vec<f64>,
    keys: Vec<f64>,
    unchanged_relayouts: usize,
}
impl LiveMeasurement {
    fn new(path: String, through: u64) -> Self {
        Self {
            path,
            through,
            frames: vec![],
            keys: vec![],
            unchanged_relayouts: 0,
        }
    }
    fn frame(
        &mut self,
        handle: WindowHandle<Surface>,
        cx: &mut App,
        before: &[(Rc<RefCell<RowState>>, usize)],
    ) {
        let last = handle.read(cx).unwrap().rows.len().saturating_sub(1);
        // Dispatch before the first paint of this pending stream revision.
        // End keeps the changed tail in the measured viewport.
        let key = (self.keys.len() < 20).then_some("end");
        let (latency, cost) = frame(handle, cx, key, Some(last), true);
        self.frames.push(cost);
        if key.is_some() {
            let surface = handle.read(cx).unwrap();
            assert_eq!(
                surface.painted.get(),
                surface.key_revision,
                "stream-load input must reach paint"
            );
            self.keys.push(latency);
        }
        for state in handle.read(cx).unwrap().rows.iter() {
            let current = state.borrow();
            if let Some((old, count)) = before
                .iter()
                .find(|(old, count)| *count > 0 && old.borrow().row == current.row)
            {
                assert!(
                    Rc::ptr_eq(old, state),
                    "unchanged row state must retain identity"
                );
                assert!(
                    current.layouts >= *count,
                    "layout counters must never reset"
                );
                self.unchanged_relayouts += current.layouts - *count;
            }
        }
    }
    fn finish(&self, handle: WindowHandle<Surface>, cx: &mut App) {
        assert_eq!(self.keys.len(), 20);
        assert!(
            self.frames.len() >= 40,
            "replay must paint distinct streaming updates"
        );
        assert_eq!(
            self.unchanged_relayouts, 0,
            "unchanged completed rows must reuse their text layouts"
        );
        let surface = handle.read(cx).unwrap();
        let transcript = surface.transcript.as_ref().unwrap();
        let result = json!({"endpoint":"GPUI CPU scene paint callback; no GPU submission or presentation","streamFrameMs":self.frames,
            "keyToFrameWhileStreamingMs":self.keys,"unchangedRowRelayouts":self.unchanged_relayouts,"streamTailPaintAcknowledged":true,"lastSeq":transcript.seq,
            "rows":surface.rows.len(),"paintedRows":surface.painted_rows.borrow().len(),"offscreen":true,"finalTree":transcript.rows,
            "rowLayoutCounts":surface.rows.iter().map(|s| {let s=s.borrow();json!({"id":s.row.id(),"layouts":s.layouts})}).collect::<Vec<_>>()});
        fs::write(&self.path, serde_json::to_vec_pretty(&result).unwrap())
            .expect("stream metrics file");
    }
}
#[cfg(test)]
#[path = "o8d_read_tests.rs"]
mod o8d_read_tests;
#[cfg(test)]
#[path = "surface_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "transcript_tests.rs"]
mod transcript_tests;

#[cfg(test)]
#[path = "image_history_tests.rs"]
mod image_history_tests;

#[cfg(test)]
#[path = "image_cache_tests.rs"]
mod image_cache_tests;

#[cfg(test)]
#[path = "visualization_tests.rs"]
mod visualization_tests;
