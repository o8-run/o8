//! Transcript pane uses the production native stream merger and retained rows.
use crate::theme::current as theme;
use crate::{
    client::{Client, Session},
    model::History,
    retained::RowState,
    stream::Transcript,
    transport::{self, Incoming, Subscription},
};
use gpui::{AnyElement, ListAlignment, ListOffset, ListState, canvas, div, prelude::*, px};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeSet,
    rc::Rc,
};

/// Pane chrome and content use the same gate, so even the header is laid out
/// only when the pane intersects the current clip.
pub fn clipped(mut child: AnyElement) -> AnyElement {
    canvas(
        move |bounds, window, cx| {
            let clip = bounds.intersect(&window.content_mask().bounds);
            if clip.size.width <= px(0.) || clip.size.height <= px(0.) {
                return None;
            }
            child.layout_as_root(bounds.size.map(gpui::AvailableSpace::Definite), window, cx);
            child.prepaint_at(bounds.origin, window, cx);
            Some(child)
        },
        |_, child, window, cx| {
            if let Some(mut child) = child {
                child.paint(window, cx);
            }
        },
    )
    .flex_1()
    .min_w_0()
    .min_h_0()
    .into_any_element()
}

pub fn title(value: &str) -> String {
    let clean: String = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = clean.chars();
    let short: String = chars.by_ref().take(40).collect();
    if chars.next().is_some() {
        format!("{}…", short.chars().take(39).collect::<String>())
    } else {
        short
    }
}
pub fn state(session: &Session) -> String {
    if session.rejected {
        return "changes requested".into();
    }
    if let Some(outcome) = &session.outcome {
        match outcome.as_str() {
            "pr_opened" => return "waiting for review".into(),
            "asked" => return "waiting for input".into(),
            "merged" => return "merged".into(),
            _ => {}
        }
    }
    match session.status.as_str() {
        "running" | "busy" | "active" | "working" => "working".into(),
        "awaiting_review" | "reviewing" | "review" | "approval" => "waiting for review".into(),
        "awaiting_input" | "awaiting_human" | "input" | "waiting" => "waiting for input".into(),
        "failed" | "error" => "failed".into(),
        "idle" => "idle".into(),
        value => value.replace('_', " "),
    }
}

pub struct Pane {
    pub key: Option<String>,
    pub title: String,
    pub state: String,
    pub notice: String,
    pub transcript: Option<Transcript>,
    pub rows: Rc<Vec<Rc<RefCell<RowState>>>>,
    pub list: ListState,
    pub(crate) images: crate::ui::images::Cache,
    subscription: Option<Subscription>,
    client: Option<Client>,
    pub revision: u64,
    pub painted: Rc<Cell<u64>>,
    pub paints: Rc<Cell<usize>>,
    pub painted_rows: Rc<RefCell<BTreeSet<usize>>>,
    pub terminal_session: Option<String>,
    pub terminal: Option<gpui::Entity<crate::terminal::Pane>>,
    /// The session's repository, so a file reference's hover names the file
    /// it opens, as in the main chat.
    file_root: Option<gpui::SharedString>,
    peeks: crate::transcript_peek::Peeks,
    action_feedback: Rc<RefCell<crate::transcript_actions::Feedback>>,
}
impl Pane {
    pub fn new(key: Option<String>) -> Self {
        Self {
            key,
            title: "Choose a session".into(),
            state: "empty".into(),
            notice: String::new(),
            transcript: None,
            rows: Rc::new(vec![]),
            images: Default::default(),
            // With no overdraw a row taller than the pane walls off the next one:
            // the list can't scroll past what it has measured.
            list: ListState::new(0, ListAlignment::Top, px(400.)),
            subscription: None,
            client: None,
            revision: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
            paints: Rc::new(Cell::new(0)),
            painted_rows: Rc::new(RefCell::new(BTreeSet::new())),
            terminal_session: None,
            terminal: None,
            file_root: None,
            peeks: Default::default(),
            action_feedback: Default::default(),
        }
    }
    pub fn metadata(&mut self, session: &Session) {
        self.title = title(&session.title);
        self.state = state(session);
        let binding = session.tmux_session.clone().filter(|value| {
            !value.trim().is_empty() && value.len() <= 200 && !value.chars().any(char::is_control)
        });
        if self.terminal_session != binding {
            self.terminal = None;
            self.terminal_session = binding;
        }
        let root = session.repo_path.clone().map(gpui::SharedString::from);
        if self.file_root != root {
            self.file_root = root;
            for row in self.rows.iter() {
                row.borrow_mut().file_root = self.file_root.clone();
            }
        }
    }
    pub fn install(&mut self, history: History, client: Client) {
        self.client = Some(client.clone());
        self.peeks.connect(client.clone());
        self.subscription = Some(transport::subscribe_history(client, &history));
        self.transcript = Some(Transcript::new(history));
        self.sync_rows();
        self.notice.clear();
    }
    /// A transcript with no live session behind it: a delegate call's own words.
    pub(crate) fn install_saved(&mut self, history: History) {
        self.transcript = Some(Transcript::new(history));
        self.sync_rows();
        self.notice.clear();
    }
    pub(crate) fn prepend(&mut self, history: History) {
        let anchor = self.list.logical_scroll_top();
        let id = self
            .rows
            .get(anchor.item_ix)
            .map(|r| r.borrow().row.id().to_owned());
        if let Some(transcript) = &mut self.transcript {
            transcript.prepend(history);
        }
        self.sync_rows();
        self.list = self.list.clone().measure_all();
        if let Some(index) =
            id.and_then(|id| self.rows.iter().position(|r| r.borrow().row.id() == id))
        {
            self.list.scroll_to(ListOffset {
                item_ix: index,
                offset_in_item: anchor.offset_in_item,
            });
        }
    }
    pub(crate) fn native_subagents(&self) -> Vec<crate::subagents::model::Agent> {
        crate::subagents::trace::native_agents(&self.rows)
    }
    pub(crate) fn attach_subagents(
        &mut self,
        view: gpui::Entity<crate::subagents::Inspector>,
        agents: Rc<Vec<crate::subagents::model::Agent>>,
        cx: &gpui::App,
    ) {
        let anchor = self.list.logical_scroll_top();
        for (index, row) in self.rows.iter().enumerate() {
            let mut row = row.borrow_mut();
            if !crate::subagents::trace::delegates(&row.row)
            {
                continue;
            }
            row.bind_subagent_focus(cx);
            if row.subagents.as_ref() != Some(&view) || *row.subagent_agents != *agents {
                row.subagents = Some(view.clone());
                row.subagent_agents = agents.clone();
                self.list.splice(index..index + 1, 1);
            }
        }
        let after = self.list.logical_scroll_top();
        if after.item_ix != anchor.item_ix || after.offset_in_item != anchor.offset_in_item {
            self.list.scroll_to(anchor);
        }
    }
    fn sync_rows(&mut self) {
        let rows = &self.transcript.as_ref().unwrap().rows;
        let old = &self.rows;
        let prefix = old
            .iter()
            .zip(rows)
            .take_while(|(a, b)| a.borrow().row == **b)
            .count();
        let suffix = old[prefix..]
            .iter()
            .rev()
            .zip(rows[prefix..].iter().rev())
            .take_while(|(a, b)| a.borrow().row == **b)
            .count();
        let states: Vec<_> = rows
            .iter()
            .map(|row| {
                old.iter()
                    .find(|s| s.borrow().row == *row)
                    .cloned()
                    .unwrap_or_else(|| {
                        let mut state = RowState::new(row.clone());
                        state.images = self.images.clone();
                        state.file_root = self.file_root.clone();
                        state.peeks = Some(self.peeks.clone());
                        if let Some(previous) = old
                            .iter()
                            .find(|previous| previous.borrow().row.id() == row.id())
                        {
                            let previous = previous.borrow();
                            state.cards = previous.cards.clone();
                            state.mission_card = previous.mission_card.clone();
                            state.keep_disclosure(&previous);
                        }
                        if let Some(client) = &self.client {
                            state.attach_visualizations(client);
                            state.attach_mission_card(client, None);
                        }
                        Rc::new(RefCell::new(state))
                    })
            })
            .collect();
        self.list
            .splice(prefix..old.len() - suffix, states.len() - prefix - suffix);
        self.rows = Rc::new(states);
    }
    pub fn poll(&mut self) -> bool {
        let mut visualizations_changed = false;
        for (index, row) in self.rows.iter().enumerate() {
            if row.borrow_mut().poll_visualizations() {
                self.list.splice(index..index + 1, 1);
                visualizations_changed = true;
            }
        }
        let follow = self.rows.is_empty() || crate::retained::at_end(&self.list);
        let messages: Vec<_> = self
            .subscription
            .as_ref()
            .map(|s| s.receiver.try_iter().take(64).collect())
            .unwrap_or_default();
        let mut changed = false;
        let mut notice_changed = false;
        for message in messages {
            match message {
                Incoming::Frame(frame) => {
                    if let Some(transcript) = &mut self.transcript {
                        changed |= transcript.apply(&frame);
                    }
                }
                Incoming::Status(status) => {
                    let notice = status.trim_end_matches(" · read-only");
                    notice_changed |= self.notice != notice;
                    self.notice = notice.into();
                }
            }
        }
        if let Some(transcript) = &mut self.transcript {
            changed |= transcript.pace();
        }
        if changed {
            self.sync_rows();
            if let Some(transcript) = &self.transcript {
                crate::retained::mark_fading(&self.rows, transcript.fading());
            }
            if follow {
                self.navigate(true);
            }
        }
        changed || visualizations_changed || notice_changed
    }
    pub fn navigate(&mut self, end: bool) {
        if !self.rows.is_empty() {
            self.list.scroll_to(ListOffset {
                item_ix: if end { self.rows.len() - 1 } else { 0 },
                offset_in_item: px(0.),
            });
        }
        self.revision += 1;
    }
    /// Delay all child layout until bounds intersect the clip. A clipped pane
    /// never constructs a list or calls the retained row's shaping/paint path.
    pub fn content(&self) -> AnyElement {
        self.content_with(
            crate::transcript_actions::turn_ends(&self.rows)
                .into_keys()
                .collect(),
            |_, row, _, _| row,
        )
    }
    /// Finished answers use the chat's Play/Copy footer in the reading pane too.
    pub(crate) fn content_for<V: 'static>(&self, view: gpui::Entity<V>) -> AnyElement {
        let ends = crate::transcript_actions::turn_ends(&self.rows);
        let client = self.client.clone();
        let feedback = self.action_feedback.clone();
        self.content_with(
            ends.keys().copied().collect(),
            move |index, row, _, _| match (ends.get(&index), &client) {
                (Some(text), Some(client)) => div()
                    .w_full()
                    .flex()
                    .flex_col()
                    .child(row)
                    .child(crate::transcript_actions::row(
                        view.clone(),
                        client.clone(),
                        feedback.clone(),
                        index,
                        text.clone(),
                    ))
                    .into_any_element(),
                _ => row,
            },
        )
    }
    fn content_with(
        &self,
        ends: BTreeSet<usize>,
        decorate: impl FnMut(usize, AnyElement, &mut gpui::Window, &mut gpui::App) -> AnyElement
        + 'static,
    ) -> AnyElement {
        let rows = self.rows.clone();
        let list_state = self.list.clone();
        let painted_rows = self.painted_rows.clone();
        let revision = self.revision;
        let painted = self.painted.clone();
        let paints = self.paints.clone();
        let notice = self.notice.clone();
        let file_root = self.file_root.clone();
        canvas(
            move |bounds, window, cx| {
                let clip = bounds.intersect(&window.content_mask().bounds);
                if clip.size.width <= px(0.) || clip.size.height <= px(0.) {
                    return None;
                }
                let mut content = div()
                    .size_full()
                    .flex()
                    .flex_col()
                    .overflow_hidden()
                    .when(!notice.is_empty(), |view| {
                        view.child(
                            div()
                                .h(px(18.))
                                .px(px(8.))
                                .truncate()
                                .text_size(px(9.5))
                                .text_color(theme().text_muted)
                                .child(notice),
                        )
                    })
                    .child(crate::transcript_view::list_view(
                        list_state.clone(),
                        rows,
                        painted_rows,
                        file_root,
                        ends,
                        decorate,
                    ))
                    .into_any_element();
                content.layout_as_root(bounds.size.map(gpui::AvailableSpace::Definite), window, cx);
                content.prepaint_at(bounds.origin, window, cx);
                Some(content)
            },
            move |_, content, window, cx| {
                if let Some(mut content) = content {
                    content.paint(window, cx);
                    painted.set(revision);
                    paints.set(paints.get() + 1);
                }
            },
        )
        .flex_1()
        .min_h_0()
        .w_full()
        .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{Context, IntoElement, Render, TestAppContext, Window};

    struct Short(Pane);
    impl Render for Short {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
                .w(px(400.))
                .h(px(90.))
                .flex()
                .flex_col()
                .child(self.0.content())
        }
    }

    fn scrolled_to(mut pane: Pane, cx: &mut TestAppContext) -> usize {
        let prompt = "A prompt taller than this pane.\n\n".repeat(30);
        let answer = "An answer taller than this pane.\n\n".repeat(30);
        pane.install_saved(
            serde_json::from_value(serde_json::json!({
                "sessionKey": "agent",
                "transcript": [
                    {"id": "prompt", "role": "user", "text": prompt},
                    {"id": "answer", "role": "assistant", "text": answer},
                ],
            }))
            .unwrap(),
        );
        let list = pane.list.clone();
        let (_view, cx) = cx.add_window_view(|_, _| Short(pane));
        for _ in 0..12 {
            cx.update(|window, _| window.refresh());
            cx.run_until_parked();
            cx.simulate_event(gpui::ScrollWheelEvent {
                position: gpui::point(px(200.), px(60.)),
                delta: gpui::ScrollDelta::Pixels(gpui::point(px(0.), px(-400.))),
                ..Default::default()
            });
        }
        cx.run_until_parked();
        list.logical_scroll_top().item_ix
    }

    #[gpui::test]
    fn a_pane_shorter_than_its_first_row_scrolls_to_the_next(cx: &mut TestAppContext) {
        assert_eq!(scrolled_to(Pane::new(None), cx), 1);
    }
    #[test]
    fn normalized_worker_recovery_notifies_without_new_transcript_rows() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            sync::{
                Arc,
                atomic::{AtomicBool, Ordering},
            },
            time::{Duration, Instant},
        };
        struct Host {
            stopped: Arc<AtomicBool>,
            server: Option<std::thread::JoinHandle<()>>,
        }
        impl Drop for Host {
            fn drop(&mut self) {
                self.stopped.store(true, Ordering::Release);
                self.server.take().unwrap().join().unwrap();
            }
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let stopped = Arc::new(AtomicBool::new(false));
        let failed = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let failing = failed.clone();
        let server = std::thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                let mut stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::park_timeout(Duration::from_millis(1));
                        continue;
                    }
                    Err(e) => panic!("worker fixture accept: {e}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut buf = [0; 8192];
                let n = stream.read(&mut buf).unwrap();
                let request = String::from_utf8_lossy(&buf[..n]);
                let (status, body) = if request.contains("/api/panel/ws-info") {
                    (
                        "404 Not Found",
                        serde_json::json!({"error":"fixture has no socket"}),
                    )
                } else if request.contains("/api/mobile/history") {
                    (
                        "200 OK",
                        serde_json::json!({"sessionKey":"codex-owned:notice","transcript":[{"id":"prompt","role":"user","text":"Review this patch."}]}),
                    )
                } else if failing.load(Ordering::Acquire) {
                    (
                        "500 Internal Server Error",
                        serde_json::json!({"error":"temporarily unavailable"}),
                    )
                } else {
                    assert!(request.contains("/api/orchestrator/packet-transcript"));
                    let events = if request.contains("cursor=0") {
                        serde_json::json!([{"seq":1,"ts":"2026-11-02T21:49:25.000Z","type":"assistant","text":"Reviewing."}])
                    } else {
                        serde_json::json!([])
                    };
                    (
                        "200 OK",
                        serde_json::json!({"sessionKey":"codex-owned:notice","events":events,"nextCursor":1}),
                    )
                };
                let body = body.to_string();
                write!(stream,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        let _host = Host {
            stopped,
            server: Some(server),
        };
        let client = Client::authenticated(&origin, None).unwrap();
        let history = client.history("codex-owned:notice").unwrap();
        failed.store(true, Ordering::Release);
        let mut pane = Pane::new(Some("codex-owned:notice".into()));
        pane.install(history, client);
        let before: Vec<_> = pane.rows.iter().map(|r| r.borrow().row.clone()).collect();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let notified = pane.poll();
            if !pane.notice.is_empty() {
                assert!(
                    notified,
                    "a connection-only error invalidates the reading pane"
                );
                assert!(pane.notice.starts_with("Reconnecting"));
                break;
            }
            assert!(
                Instant::now() < deadline,
                "the worker error reaches the pane"
            );
            std::thread::park_timeout(Duration::from_millis(5));
        }
        failed.store(false, Ordering::Release);
        loop {
            let notified = pane.poll();
            if pane.notice.is_empty() {
                assert!(notified, "a recovered connection invalidates the notice");
                break;
            }
            assert!(
                Instant::now() < deadline,
                "a successful normalized poll clears the notice"
            );
            std::thread::park_timeout(Duration::from_millis(5));
        }
        assert_eq!(
            before,
            pane.rows
                .iter()
                .map(|r| r.borrow().row.clone())
                .collect::<Vec<_>>(),
            "notice recovery needs no new answer or tool row"
        );
    }
}

#[cfg(test)]
mod file_root_tests {
    use super::*;

    #[test]
    fn a_pane_names_files_from_its_sessions_repository() {
        let mut pane = Pane::new(Some("agent".into()));
        pane.install_saved(
            serde_json::from_value(serde_json::json!({
                "sessionKey": "agent",
                "transcript": [{"id": "answer", "role": "assistant", "text": "see `src/a.rs:3`"}],
            }))
            .unwrap(),
        );
        let session: Session = serde_json::from_value(serde_json::json!({
            "id": "agent", "title": "t", "status": "idle", "repoPath": "/repo"
        }))
        .unwrap();
        pane.metadata(&session);
        let root = |pane: &Pane| {
            pane.rows[0]
                .borrow()
                .file_root
                .as_ref()
                .map(ToString::to_string)
        };
        assert_eq!(root(&pane).as_deref(), Some("/repo"));
        pane.install_saved(
            serde_json::from_value(serde_json::json!({
                "sessionKey": "agent",
                "transcript": [{"id": "later", "role": "assistant", "text": "more"}],
            }))
            .unwrap(),
        );
        assert_eq!(root(&pane).as_deref(), Some("/repo"), "a new row keeps it");
    }
}
