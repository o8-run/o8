//! Transcript pane uses the production native stream merger and retained rows.
use crate::theme::current as theme;
use crate::{
    client::{Client, Session},
    model::History,
    retained::{RetainedRow, RowState},
    stream::Transcript,
    transport::{self, Incoming, Subscription},
};
use gpui::{AnyElement, ListAlignment, ListOffset, ListState, canvas, div, list, prelude::*, px};
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
            list: ListState::new(0, ListAlignment::Top, px(0.)),
            subscription: None,
            client: None,
            revision: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
            paints: Rc::new(Cell::new(0)),
            painted_rows: Rc::new(RefCell::new(BTreeSet::new())),
            terminal_session: None,
            terminal: None,
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
    }
    pub fn install(&mut self, history: History, client: Client) {
        self.client = Some(client.clone());
        let key = history.session_key.clone();
        self.transcript = Some(Transcript::new(history));
        self.sync_rows();
        self.subscription = Some(transport::subscribe(client, key));
        self.notice.clear();
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
                        state.cards = old
                            .iter()
                            .find(|state| state.borrow().row.id() == row.id())
                            .map(|state| state.borrow().cards.clone())
                            .unwrap_or_default();
                        if let Some(client) = &self.client {
                            state.attach_visualizations(client);
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
        let follow = self.rows.is_empty()
            || self
                .list
                .bounds_for_item(self.rows.len() - 1)
                .is_some_and(|b| {
                    let viewport = self.list.viewport_bounds();
                    b.bottom() <= viewport.bottom() + px(1.) && b.bottom() >= viewport.top()
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
                    self.notice = status.trim_end_matches(" · read-only").into()
                }
            }
        }
        if changed {
            self.sync_rows();
            if follow {
                self.navigate(true);
            }
        }
        changed || visualizations_changed
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
        let rows = self.rows.clone();
        let list_state = self.list.clone();
        let painted_rows = self.painted_rows.clone();
        let revision = self.revision;
        let painted = self.painted.clone();
        let paints = self.paints.clone();
        let notice = self.notice.clone();
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
                    .child(
                        div()
                            .h(px(18.))
                            .px(px(8.))
                            .text_size(px(9.5))
                            .text_color(theme().text_muted)
                            .child(notice),
                    )
                    .child(
                        list(list_state.clone(), move |index, _, _| {
                            RetainedRow {
                                state: rows[index].clone(),
                                index,
                                painted: painted_rows.clone(),
                            }
                            .interactive(&list_state)
                        })
                        .flex_1()
                        .min_h_0(),
                    )
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
