use crate::theme::current as theme;
#[path = "brain_dock.rs"]
mod brain_dock;
#[path = "composer_bench.rs"]
mod composer_bench;
#[path = "conversation.rs"]
mod conversation;
#[path = "history.rs"]
mod history;
#[path = "session_sidebar.rs"]
mod session_sidebar;
#[path = "shell_session.rs"]
mod shell_session;
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

pub(crate) struct Surface {
    client: Client,
    embedded: bool,
    brains: HashMap<String, gpui::Entity<crate::brain::Brain>>,
    composer: gpui::Entity<Composer>,
    drafts: HashMap<String, gpui::Entity<Composer>>,
    pending: HashMap<String, Value>,
    linked_issues: HashMap<String, crate::issues::LinkedIssue>,
    routing: Option<Value>,
    queue: Value,
    queue_ready: bool,
    saving: bool,
    send_next: bool,
    subscriptions: Vec<gpui::Subscription>,
    sessions: Vec<Session>,
    selected: Option<String>,
    rows: Rc<Vec<Rc<RefCell<RowState>>>>,
    transcript: Option<Transcript>,
    subscription: Option<Subscription>,
    list: ListState,
    focus: FocusHandle,
    notice: String,
    generation: u64,
    reconcile_revision: u64,
    list_generation: u64,
    history_loading: bool,
    key_revision: u64,
    painted: Rc<Cell<u64>>,
    painted_rows: Rc<RefCell<BTreeSet<usize>>>,
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
            drafts: HashMap::new(),
            pending: HashMap::new(),
            linked_issues: HashMap::new(),
            routing: None,
            queue: Value::Null,
            queue_ready: false,
            saving: false,
            send_next: false,
            subscriptions: vec![],
            sessions: vec![],
            selected: None,
            rows: Rc::new(vec![]),
            transcript: None,
            subscription: None,
            list: ListState::new(0, ListAlignment::Top, px(400.)),
            focus,
            notice: String::new(),
            generation: 0,
            reconcile_revision: 0,
            list_generation: 0,
            history_loading: false,
            key_revision: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
            painted_rows: Rc::new(RefCell::new(BTreeSet::new())),
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
            let editor = cx.new(Composer::new);
            self.subscriptions
                .push(cx.subscribe(&editor, |this, _, event: &Submit, cx| {
                    if event.0 {
                        this.send_next = !this.send_next;
                        cx.notify();
                    } else {
                        this.send(None, cx);
                    }
                }));
            self.drafts.insert(id.clone(), editor);
        }
        self.composer = self.drafts[&id].clone();
        self.routing = None;
        self.queue_ready = false;
        self.queue = Value::Null;
        self.saving = false;

        self.generation += 1;
        let generation = self.generation;
        self.subscription = None;
        self.history_loading = false;
        self.transcript = None;
        self.selected = Some(id.clone());
        self.rows = Rc::new(vec![]);
        self.list = ListState::new(0, ListAlignment::Top, px(400.));
        self.notice = "Reading history…".into();
        cx.notify();
        let client = self.client.clone();
        let session = self.sessions.iter().find(|s| s.id == id).cloned();
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
                        this.install_rows(transcript.rows.clone());
                        this.transcript = Some(transcript);
                        this.subscription = Some(transport::subscribe(this.client.clone(), key));
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
    fn install_rows(&mut self, next: Vec<Row>) {
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
            states.push(retained.unwrap_or_else(|| Rc::new(RefCell::new(RowState::new(row)))));
        }
        self.list
            .splice(prefix..old.len() - suffix, states.len() - prefix - suffix);
        self.rows = Rc::new(states);
        if initial {
            self.list = self.list.clone().measure_all();
        }
    }
    fn poll_stream(&mut self, cx: &mut Context<Self>) -> bool {
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
            self.install_rows(self.transcript.as_ref().unwrap().rows.clone());
            if follow_tail && !self.rows.is_empty() {
                self.list.scroll_to(ListOffset {
                    item_ix: self.rows.len() - 1,
                    offset_in_item: px(0.),
                });
            }
            cx.notify();
        }
        changed
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
                            this.rows = Rc::new(vec![]);
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
        }
        self.key_revision += 1;
        cx.notify();
    }
}

impl Render for Surface {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let rows = self.rows.clone();
        let painted_rows = self.painted_rows.clone();
        let painted = self.painted.clone();
        let revision = self.key_revision;
        let geometry = &crate::theme::GEOMETRY;
        let typography = &crate::theme::TYPE;
        let viewport = f32::from(window.viewport_size().width);
        let sidebar_width = (viewport * 0.25).min(geometry.sidebar_width);
        let right_width = (viewport * 0.30).min(geometry.right_width);
        let empty = self.transcript.is_some() && self.rows.is_empty();
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
            .capture_key_down(cx.listener(Self::brain_key))
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
            .when(!self.embedded, |view| {
                view.child(
                    div()
                        .h(px(geometry.header))
                        .px(px(16.))
                        .flex()
                        .items_center()
                        .gap(px(16.))
                        .child("o8 next")
                        .child(self.brain_control(cx))
                        .child(
                            div()
                                .id("refresh")
                                .debug_selector(|| "session-refresh".into())
                                .px(px(8.))
                                .py(px(4.))
                                .rounded(px(5.))
                                .cursor_pointer()
                                .bg(theme().surface_raised)
                                .child("Refresh")
                                .on_click(cx.listener(|this, _, _, cx| this.load_sessions(cx))),
                        ),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .p(px(geometry.inset))
                    .gap(px(geometry.gap))
                    .child(self.session_sidebar(px(sidebar_width), cx))
                    .child(
                        div()
                            .debug_selector(|| "conversation-column".into())
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .when(!self.notice.is_empty(), |view| {
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
                            .when(!empty, |view| {
                                view.child(
                                    list(self.list.clone(), {
                                        let list_state = self.list.clone();
                                        move |index, _, _| {
                                            RetainedRow {
                                                state: rows[index].clone(),
                                                index,
                                                painted: painted_rows.clone(),
                                            }
                                            .interactive(&list_state)
                                        }
                                    })
                                    .flex_1()
                                    .min_h_0(),
                                )
                            })
                            .child(
                                div()
                                    .debug_selector(|| "composer-space".into())
                                    .flex()
                                    .flex_col()
                                    .when(empty, |view| view.flex_1().min_h_0().justify_center())
                                    .when(!empty, |view| view.flex_shrink_0())
                                    .px(px(geometry.content_inset))
                                    .pb(px(if empty { 0. } else { geometry.gap * 2. }))
                                    .child(self.composer_panel(cx)),
                            ),
                    )
                    .child(self.brain_panel(px(right_width), cx)),
            )
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
    (if offscreen { Application::headless() } else { Application::new() }).run(move |cx: &mut App| {
        let handle = cx.open_window(WindowOptions { focus: false, show: !offscreen,
            window_bounds: Some(WindowBounds::Windowed(Bounds::new(point(px(if offscreen { -10000. } else { 100. }), px(if offscreen { -10000. } else { 100. })), size(px(1200.), px(816.))))),
            titlebar: Some(gpui::TitlebarOptions { title: Some("o8 next".into()), ..Default::default() }),
            ..Default::default() }, |window, cx| cx.new(|cx| {
                let mut surface = Surface::new(client, window, cx);
                surface.notice = surface.snapshot_label();
                surface.load_sessions(cx);
                surface
            })).expect("GPUI window");
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
