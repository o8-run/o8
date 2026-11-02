//! One read-only inspector for delegated work, shared by traces and shell tools.
use crate::{client::Client, theme::current as theme};
use gpui::{App, Context, Entity, FocusHandle, KeyDownEvent, Render, Window, div, prelude::*, px};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
#[path = "subagents/history.rs"]
mod history;
#[path = "subagents/model.rs"]
pub(crate) mod model;
#[path = "subagents/trace.rs"]
pub(crate) mod trace;
#[path = "subagents/view.rs"]
mod view;
use model::{Agent, Scope};

pub(crate) struct Open(pub gpui::AnyWindowHandle);
pub(crate) struct Close(pub gpui::AnyWindowHandle, pub Option<FocusHandle>);
impl gpui::EventEmitter<Open> for Inspector {}
impl gpui::EventEmitter<Close> for Inspector {}

pub(crate) struct Inspector {
    client: Client,
    pub(crate) scope: Scope,
    pub(crate) agents: Vec<Agent>,
    pub(crate) selected: Option<String>,
    /// Subagents opened in their own tab, in the order they opened.
    pub(crate) tabs: Vec<String>,
    /// Transcripts of the tabs behind the shown one.
    parked: HashMap<String, (String, crate::pane::Pane)>,
    pending: bool,
    loaded: bool,
    error: Option<String>,
    next: Option<Instant>,
    clock_second: u64,
    detail_pending: bool,
    /// What a subagent's own chat last read as, and when; it has no session.
    native_read: Option<(String, std::time::Instant)>,
    native_entries: Vec<crate::model::Entry>,
    native_status: String,
    native_sent: u64,
    native_applied: u64,
    detail_error: Option<String>,
    detail: Option<crate::pane::Pane>,
    detail_key: Option<String>,
    generation: u64,
    focus: FocusHandle,
    return_focus: Option<FocusHandle>,
    controls: HashMap<String, FocusHandle>,
    scroll: gpui::ScrollHandle,
    query: Entity<crate::composer::Composer>,
    search: bool,
    copied: bool,
    pub(crate) open: bool,
    _subscriptions: Vec<gpui::Subscription>,
}
impl Inspector {
    pub(crate) fn new(client: Client, scope: Scope, cx: &mut Context<Self>) -> Self {
        let query = cx.new(|cx| {
            let mut q = crate::composer::Composer::new(cx);
            q.inline = true;
            q.placeholder = "Search subagents".into();
            q
        });
        let subscription = cx.observe(&query, |_, _, cx| cx.notify());
        let mut this = Self {
            client,
            scope,
            agents: vec![],
            selected: None,
            tabs: vec![],
            parked: HashMap::new(),
            pending: false,
            loaded: false,
            error: None,
            next: None,
            clock_second: 0,
            detail_pending: false,
            native_read: None,
            native_entries: Vec::new(),
            native_status: String::new(),
            native_sent: 0,
            native_applied: 0,
            detail_error: None,
            detail: None,
            detail_key: None,
            generation: 0,
            focus: cx.focus_handle(),
            return_focus: None,
            controls: HashMap::new(),
            scroll: Default::default(),
            query,
            search: false,
            copied: false,
            open: false,
            _subscriptions: vec![subscription],
        };
        this.refresh(cx);
        this
    }
    pub(crate) fn inspect(
        &mut self,
        id: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let id = id.map(|id| {
            self.agents
                .iter()
                .find(|a| a.id == id || a.session.as_ref() == Some(&id))
                .map_or(id, |a| a.id.clone())
        });
        if !self.open || !self.focus.contains_focused(window, cx) {
            self.return_focus = window.focused(cx);
        }
        self.open = true;
        if let Some(id) = id.as_ref().filter(|id| !self.tabs.contains(id)) {
            self.tabs.push(id.clone());
        }
        if self.selected != id {
            self.park();
            self.selected = id;
            self.detail_error = None;
            self.detail_pending = false;
            self.generation += 1;
            self.copied = false;
        }
        self.ensure_detail(cx);
        self.focus.focus(window);
        cx.emit(Open(window.window_handle()));
        cx.notify();
    }
    pub(crate) fn focus(&self, window: &mut Window) {
        self.focus.focus(window);
    }
    /// Keeps the shown tab's transcript so coming back to it is instant.
    fn park(&mut self) {
        if let (Some(id), Some(key), Some(detail)) = (
            self.selected.clone(),
            self.detail_key.take(),
            self.detail.take(),
        ) {
            self.parked.insert(id, (key, detail));
        }
        self.detail = None;
        self.detail_key = None;
    }
    /// Closes one subagent's tab; true when it was the last and was showing.
    pub(crate) fn close_tab(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let at = self.tabs.iter().position(|tab| tab == id);
        self.tabs.retain(|tab| tab != id);
        self.parked.remove(id);
        let showing = self.selected.as_deref() == Some(id);
        if showing {
            self.detail = None;
            self.detail_key = None;
            let next = at.and_then(|at| self.tabs.get(at.min(self.tabs.len().saturating_sub(1))));
            match next.cloned() {
                Some(next) => self.inspect(Some(next), window, cx),
                None => self.back(window, cx),
            }
        }
        cx.notify();
        showing && self.tabs.is_empty()
    }
    pub(crate) fn close_all_tabs(&mut self) {
        self.tabs.clear();
        self.parked.clear();
    }
    pub(crate) fn title_of(&self, id: &str) -> Option<&Agent> {
        self.agents.iter().find(|a| a.id == id)
    }
    /// Delegate calls read from the transcript, for houses with no packet.
    pub(crate) fn set_native(&mut self, agents: Vec<Agent>, cx: &mut Context<Self>) {
        let known: std::collections::HashSet<_> = self
            .agents
            .iter()
            .filter(|a| !a.native)
            .flat_map(|a| [Some(a.id.clone()), a.session.clone()])
            .flatten()
            .collect();
        let mut agents: Vec<Agent> = agents
            .into_iter()
            .filter(|a| !a.session.as_ref().is_some_and(|s| known.contains(s)))
            .collect();
        // The kept list is sorted, so an unsorted one never matches and would
        // notify the observer that called this, forever.
        agents.sort_by(|a, b| a.title.cmp(&b.title).then_with(|| a.id.cmp(&b.id)));
        let current: Vec<&Agent> = self.agents.iter().filter(|a| a.native).collect();
        if current.len() == agents.len() && current.iter().zip(&agents).all(|(a, b)| *a == b) {
            return;
        }
        self.agents.retain(|a| !a.native);
        self.agents.extend(agents);
        self.agents
            .sort_by(|a, b| a.title.cmp(&b.title).then_with(|| a.id.cmp(&b.id)));
        self.ensure_detail(cx);
        cx.notify();
    }
    pub(crate) fn tick(&mut self, refresh: bool, cx: &mut Context<Self>) {
        let now = crate::clock::now();
        if self.open
            && self.clock_second != now
            && self
                .agents
                .iter()
                .any(|a| a.group == model::Group::Working && a.started.is_some())
        {
            self.clock_second = now;
            self.ensure_detail(cx);
            cx.notify();
        }
        if !self.pending && (refresh || self.next.is_none_or(|at| Instant::now() >= at)) {
            self.refresh(cx);
        }
        if self.open && self.detail.as_mut().is_some_and(|detail| detail.poll()) {
            self.detail_images(cx);
            cx.notify();
        }
    }
    pub(crate) fn summary(&self) -> String {
        model::summary(&self.agents)
    }
    fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        self.pending = true;
        let (client, scope) = (self.client.clone(), self.scope.clone());
        let task = cx
            .background_executor()
            .spawn(async move { model::load(&client, &scope) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                this.next = Some(Instant::now() + Duration::from_secs(3));
                let old = this
                    .selected
                    .as_ref()
                    .and_then(|id| this.agents.iter().find(|a| &a.id == id))
                    .map(|a| (a.session.clone(), a.run.clone()));
                let mut errors = Vec::new();
                for (shared, result) in [(false, result.packets), (true, result.shared)] {
                    match result {
                        Ok(agents) => {
                            this.agents.retain(|a| a.native || a.shared != shared);
                            this.agents.extend(agents);
                            this.loaded = true;
                        }
                        Err(error) => errors.push(error),
                    }
                }
                this.agents.sort_by(|a, b| {
                    a.shared
                        .cmp(&b.shared)
                        .then_with(|| a.title.cmp(&b.title))
                        .then_with(|| a.id.cmp(&b.id))
                });
                let mut sessions = std::collections::HashSet::new();
                this.agents.retain(|a| {
                    a.session
                        .as_ref()
                        .is_none_or(|s| sessions.insert(s.clone()))
                });
                this.agents
                    .sort_by(|a, b| a.title.cmp(&b.title).then_with(|| a.id.cmp(&b.id)));
                // A tab opened by session id moves to the agent's own id.
                let mut open = std::collections::HashSet::new();
                let tabs = std::mem::take(&mut this.tabs);
                this.tabs = tabs
                    .into_iter()
                    .map(|tab| {
                        let agent = this.agents.iter().find(|a| a.session.as_ref() == Some(&tab));
                        agent.map_or(tab, |agent| agent.id.clone())
                    })
                    .filter(|tab| open.insert(tab.clone()))
                    .collect();
                if let Some(id) = this.selected.clone() {
                    if let Some(agent) = this
                        .agents
                        .iter()
                        .find(|a| a.id == id || a.session.as_ref() == Some(&id))
                    {
                        this.selected = Some(agent.id.clone());
                    }
                }
                let new = this
                    .selected
                    .as_ref()
                    .and_then(|id| this.agents.iter().find(|a| &a.id == id))
                    .map(|a| (a.session.clone(), a.run.clone()));
                if old != new {
                    this.generation += 1;
                    this.detail = None;
                    this.detail_key = None;
                    this.detail_pending = false;
                    this.detail_error = None;
                    this.copied = false;
                }
                this.error = (!errors.is_empty()).then(|| errors.join(" · "));
                this.ensure_detail(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn ensure_detail(&mut self, cx: &mut Context<Self>) {
        let agent = self
            .selected
            .as_ref()
            .and_then(|id| self.agents.iter().find(|agent| &agent.id == id));
        let Some(agent) = agent else {
            return;
        };
        let session = agent.session.clone();
        let id = agent.id.clone();
        let Some(key) = session else {
            if agent.native {
                let agent = agent.clone();
                self.show_native(&agent);
                self.read_native(&agent, cx);
            }
            return;
        };
        if self.detail_key.as_ref() == Some(&key) || self.detail_pending {
            return;
        }
        if let Some((parked, detail)) = self.parked.remove(&id) {
            if parked == key {
                self.detail = Some(detail);
                self.detail_key = Some(key);
                return;
            }
        }
        self.detail_pending = true;
        self.detail_error = None;
        let (client, generation) = (self.client.clone(), self.generation);
        let target = key.clone();
        let task = cx
            .background_executor()
            .spawn(async move { client.history(&target) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.detail_pending = false;
                match result {
                    Ok(history) => {
                        let mut detail = crate::pane::Pane::new(Some(key.clone()));
                        detail.install(history, this.client.clone());
                        this.detail = Some(detail);
                        this.detail_key = Some(key);
                        this.detail_images(cx);
                    }
                    Err(error) => this.detail_error = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
    }
    /// A house's own subagent: what it was asked and what it gave back, read
    /// like any transcript. It redraws when the answer lands.
    fn show_native(&mut self, agent: &Agent) {
        let key = format!("native:{}", agent.id);
        let same = self.detail_key.as_ref() == Some(&key);
        // Its own chat survives a status change; only the placeholder rebuilds.
        if same && (!self.native_entries.is_empty() || self.native_status == agent.status) {
            return;
        }
        let entry = |id: &str, role: &str, text: &str| crate::model::Entry {
            id: format!("{}:{id}", agent.id),
            role: role.into(),
            text: text.to_owned(),
            tools: None,
            extra: Default::default(),
        };
        let mut transcript = Vec::new();
        if let Some(prompt) = &agent.prompt {
            transcript.push(entry("prompt", "user", prompt));
        }
        if let Some(result) = &agent.result {
            transcript.push(entry("result", "assistant", result));
        }
        let mut detail = crate::pane::Pane::new(Some(key.clone()));
        detail.install_saved(crate::model::History {
            session_key: key.clone(),
            transcript,
            page: None,
        });
        self.detail = Some(detail);
        self.detail_key = Some(key);
        self.native_status.clone_from(&agent.status);
        if !same {
            self.native_read = None;
            self.native_entries.clear();
        }
    }
    /// Replaces the prompt and answer with the agent's whole chat when the
    /// server has one, and keeps it current while the agent works.
    fn read_native(&mut self, agent: &Agent, cx: &mut Context<Self>) {
        let working = agent.group == model::Group::Working;
        let key = format!("native:{}", agent.id);
        let read = format!("{key}:{}", agent.status);
        let due = self.native_read.as_ref().is_none_or(|(last, at)| {
            *last != read || (working && at.elapsed() >= std::time::Duration::from_secs(2))
        });
        if !due {
            return;
        }
        self.native_read = Some((read, std::time::Instant::now()));
        self.native_sent += 1;
        let sent = self.native_sent;
        let client = self.client.clone();
        let target = format!("subagent:{}", agent.id);
        let prompt = agent.prompt.clone();
        let id = agent.id.clone();
        let task = cx
            .background_executor()
            .spawn(async move { client.history(&target) });
        cx.spawn(async move |this, cx| {
            let Ok(mut history) = task.await else {
                return;
            };
            let _ = this.update(cx, |this, cx| {
                if this.detail_key.as_ref() != Some(&key)
                    || history.transcript.is_empty()
                    || sent < this.native_applied
                {
                    return;
                }
                this.native_applied = sent;
                // A finished agent's saved rows are settled, not a turn in progress.
                if let Some(last) = history.transcript.last_mut().filter(|_| !working) {
                    last.extra
                        .insert("receipt".into(), serde_json::json!({ "terminal": {} }));
                }
                if let Some(prompt) = prompt.filter(|_| history.transcript[0].role != "user") {
                    history.transcript.insert(
                        0,
                        crate::model::Entry {
                            id: format!("{id}:prompt"),
                            role: "user".into(),
                            text: prompt,
                            tools: None,
                            extra: Default::default(),
                        },
                    );
                }
                if this.native_entries == history.transcript {
                    return;
                }
                this.native_entries.clone_from(&history.transcript);
                if let Some(detail) = &mut this.detail {
                    let following = crate::retained::at_end(&detail.list);
                    detail.install_saved(history);
                    if following {
                        crate::retained::pin_end(&detail.list);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let return_focus = self
            .selected
            .as_ref()
            .and_then(|id| self.controls.get(&format!("subagent-row-{id}")).cloned());
        self.park();
        self.selected = None;
        self.detail_pending = false;
        self.detail_error = None;
        self.generation += 1;
        return_focus
            .unwrap_or_else(|| self.focus.clone())
            .focus(window);
        cx.notify();
    }
    fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open = false;
        cx.emit(Close(window.window_handle(), self.return_focus.clone()));
        if let Some(focus) = &self.return_focus {
            focus.focus(window);
        }
        cx.notify();
    }
    fn output(&self) -> String {
        self.selected
            .as_ref()
            .and_then(|id| self.agents.iter().find(|a| &a.id == id))
            .and_then(|a| a.result.clone())
            .or_else(|| {
                self.detail
                    .as_ref()?
                    .transcript
                    .as_ref()?
                    .shown_entries()
                    .iter()
                    .rev()
                    .find(|e| e.role == "assistant" && !e.text.trim().is_empty())
                    .map(|e| e.text.clone())
            })
            .unwrap_or_default()
    }
    #[cfg(test)]
    pub(crate) fn probe(&self) -> serde_json::Value {
        serde_json::json!({"parent":self.scope.parent,"selected":self.selected,"rows":self.detail.as_ref().map(|d|d.rows.len()),
            "readyImages":self.detail.as_ref().map(|d|d.images.borrow().values().filter(|i|matches!(i,crate::ui::images::ImageState::Ready(_))).count()),
            "output":self.output(),"pending":self.pending,"detailPending":self.detail_pending,"error":self.error})
    }
}

pub(crate) fn open_packet<T: 'static>(
    client: Client,
    repo: String,
    id: String,
    window: &mut Window,
    cx: &mut Context<T>,
) {
    let view = cx.new(|cx| Inspector::new(client, Scope { repo, parent: None }, cx));
    let handle = window.window_handle();
    let return_focus = window.focused(cx);
    cx.defer(move |cx| {
        // EntityCreated observers install their subscriptions in a deferred
        // effect. Wait through that effect before emitting the initial Open.
        cx.defer(move |cx| {
            let _ = handle.update(cx, |_, window, cx| {
                if let Some(focus) = &return_focus {
                    focus.focus(window);
                }
                view.update(cx, |v, cx| v.inspect(Some(id), window, cx));
                // Open is queued. Retain a new inspector until the panel's
                // subscriber receives it and takes ownership.
                cx.defer(move |_| drop(view));
            });
        });
    });
}
