//! One read-only inspector for delegated work, shared by traces and shell tools.
use crate::{client::Client, theme::current as theme};
use gpui::{App, Context, Entity, FocusHandle, KeyDownEvent, Render, Window, div, prelude::*, px};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
#[path = "subagents/model.rs"]
pub(crate) mod model;
#[path = "subagents/view.rs"]
mod view;
#[path = "subagents/history.rs"]
mod history;
#[path = "subagents/trace.rs"]
pub(crate) mod trace;
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
    pending: bool,
    loaded: bool,
    error: Option<String>,
    next: Option<Instant>,
    clock_second: u64,
    detail_pending: bool,
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
            pending: false,
            loaded: false,
            error: None,
            next: None,
            clock_second: 0,
            detail_pending: false,
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
        if self.selected != id {
            self.selected = id;
            self.detail = None;
            self.detail_key = None;
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
                            this.agents.retain(|a| a.shared != shared);
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
        let Some(key) = agent.and_then(|agent| agent.session.clone()) else {
            return;
        };
        if self.detail_key.as_ref() == Some(&key) || self.detail_pending {
            return;
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
    fn back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let return_focus = self
            .selected
            .as_ref()
            .and_then(|id| self.controls.get(&format!("subagent-row-{id}")).cloned());
        self.selected = None;
        self.detail = None;
        self.detail_key = None;
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
